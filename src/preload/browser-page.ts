import { contextBridge } from "electron";

// The preload of the agent browser tabs. It has no IPC and exposes no world: the page gets no
// `window.openbot` and no path to main. It only runs `matchChromePageValues` in the page world of
// each frame, before the page's own scripts.

/**
 * Makes the values that bot checks read from an Electron tab agree with Chrome:
 * - A hidden tab, or a tab of a minimized window, reports an outer size of 0x0 (Windows: 160x28),
 *   smaller than its viewport. Chrome's outer size always holds the viewport.
 * - Minimized Windows windows report a screen position of -32000.
 * - Electron's `window.chrome` is an empty object, and a `srcdoc` frame read before it loads has
 *   none. Chrome has `loadTimes`, `csi` and `app`.
 * - On macOS, Electron shows no passkey dialog, so a passkey sign-in waited with nothing on screen
 *   until the site's time limit (#6507). Such a request now fails at once, as when a person cancels
 *   Chrome's dialog, and the site offers its other sign-in methods.
 *
 * Electron serializes this function into the page, so it must use nothing from outside its body.
 * Each replaced function reads as native code through `Function.prototype.toString`.
 */
function matchChromePageValues(): void {
  // A masked `toString` called on an object with this key puts its map of replaced functions in
  // the object, so that the frames of one page share one map. A native `toString` throws instead.
  const nativesRequest = "matchChromePageValues:natives";
  const onWindows = true;
  const onMac = false;
  // The window frame and toolbar of a Chrome window with no bookmarks bar.
  const frameWidth = 16;
  const toolbarHeight = 87;

  const isGlobal = (value: Window | null): value is Window & typeof globalThis => {
    try {
      // A frame of another origin throws here, and its values are not ours to change.
      return value !== null && "Function" in value && typeof value.Function === "function";
    } catch {
      return false;
    }
  };

  // A page can give the `toString` of one frame a function of another frame. Each frame runs its
  // own copy of this function, so each frame uses the map of its highest same-origin ancestor.
  const sharedNatives = (): WeakMap<object, string> => {
    let shared: WeakMap<object, string> | undefined;
    let frame: Window = window;
    try {
      while (frame.parent !== frame) {
        frame = frame.parent;
        if (!isGlobal(frame)) continue;
        const request: { [nativesRequest]: WeakMap<object, string> | undefined } = { [nativesRequest]: undefined };
        try {
          frame.Function.prototype.toString.call(request);
        } catch {
          // The native `toString` of a frame with no map throws for an object.
        }
        shared = request[nativesRequest] ?? shared;
      }
    } catch {
      // The frame left the page while this ran.
    }
    return shared ?? new WeakMap<object, string>();
  };
  const natives = sharedNatives();

  // A native function that throws from a trap below has one more stack frame than in Chrome: the
  // trap. It is removed before the error goes to the page.
  const removeTrapFrame = (error: unknown): void => {
    try {
      if (typeof error === "object" && error !== null && "stack" in error && typeof error.stack === "string") {
        const lines = error.stack.split("\n");
        const trap = lines.findIndex(
          (line, index) => index > 0 && /^\s+at Object\.apply \(<anonymous>:\d+:\d+\)$/.test(line),
        );
        if (trap > 0) {
          lines.splice(trap, 1);
          error.stack = lines.join("\n");
        }
      }
    } catch {
      // An error with a fixed stack keeps it.
    }
  };

  const wrapGetter = <Owner extends typeof globalThis | HTMLIFrameElement, Key extends keyof Owner & string>(
    owner: Owner,
    key: Key,
    fix: (value: Owner[Key]) => Owner[Key],
  ): void => {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    const get = descriptor?.get;
    if (!descriptor || !get) return;
    const wrapped = new Proxy(get, {
      apply: (method, self: unknown) => {
        let value: Owner[Key];
        try {
          value = method.call(self);
        } catch (error) {
          removeTrapFrame(error);
          throw error;
        }
        return fix(value);
      },
    });
    natives.set(wrapped, `get ${key}`);
    Object.defineProperty(owner, key, { ...descriptor, get: wrapped });
  };

  // Chromium reaches a security key with no dialog, so a request that can use one keeps the native
  // path: a site that asks for a security key, or a credential that a security key can hold. A
  // credential with no transports can be an older security key.
  const securityKeyTransports = new Set(["usb", "nfc", "ble", "smart-card"]);
  const opensPasskeyDialog = (options: CredentialRequestOptions | undefined): boolean => {
    try {
      const publicKey = options?.publicKey;
      // Autofill (conditional) requests open no dialog, and an aborted request gets its native error.
      if (!publicKey || options.mediation === "conditional" || options.signal?.aborted) return false;
      // TypeScript's DOM types do not have the WebAuthn Level 3 `hints` yet.
      if ("hints" in publicKey && Array.isArray(publicKey.hints) && publicKey.hints.includes("security-key")) {
        return false;
      }
      return !Array.from(publicKey.allowCredentials ?? []).some((credential) => {
        const transports = Array.from(credential.transports ?? []);
        return transports.length === 0 || transports.some((transport) => securityKeyTransports.has(transport));
      });
    } catch {
      // Options that cannot be read get the native error.
      return false;
    }
  };

  const refusePasskeyDialogs = (target: typeof globalThis): void => {
    // `navigator.credentials` exists only in a secure context.
    if (!("CredentialsContainer" in target)) return;
    const prototype = target.CredentialsContainer.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "get");
    if (!descriptor || typeof descriptor.value !== "function") return;
    const get = new Proxy(prototype.get, {
      apply: (method, self: unknown, args: [CredentialRequestOptions?]) => {
        if (self instanceof target.CredentialsContainer && opensPasskeyDialog(args[0])) {
          return target.Promise.reject(
            new target.DOMException(
              "The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.",
              "NotAllowedError",
            ),
          );
        }
        try {
          return method.apply(self, args);
        } catch (error) {
          removeTrapFrame(error);
          throw error;
        }
      },
    });
    natives.set(get, "get");
    Object.defineProperty(prototype, "get", { ...descriptor, value: get });
  };

  const chromeValues = (target: typeof globalThis) => {
    const performance = target.performance;
    const navigation = (): PerformanceNavigationTiming | undefined => {
      const entry = performance.getEntriesByType("navigation")[0];
      return entry instanceof target.PerformanceNavigationTiming ? entry : undefined;
    };
    // Seconds since the epoch, as Chrome reports them. A step that has not happened yet is 0.
    const seconds = (offset: number | undefined) => (offset ? (performance.timeOrigin + offset) / 1000 : 0);
    const methods = {
      loadTimes() {
        const entry = navigation();
        const protocol = entry?.nextHopProtocol ?? "";
        const multiplexed = protocol === "h2" || protocol === "h3";
        const paint = performance.getEntriesByName("first-paint")[0];
        const navigationType =
          entry?.type === "reload" ? "Reload" : entry?.type === "back_forward" ? "BackForward" : "Other";
        return {
          requestTime: performance.timeOrigin / 1000,
          startLoadTime: performance.timeOrigin / 1000,
          commitLoadTime: seconds(entry?.responseStart),
          finishDocumentLoadTime: seconds(entry?.domContentLoadedEventEnd),
          finishLoadTime: seconds(entry?.loadEventEnd),
          firstPaintTime: seconds(paint?.startTime),
          firstPaintAfterLoadTime: 0,
          navigationType,
          wasFetchedViaSpdy: multiplexed,
          wasNpnNegotiated: multiplexed,
          npnNegotiatedProtocol: multiplexed ? protocol : "unknown",
          wasAlternateProtocolAvailable: false,
          connectionInfo: protocol || "http/1.1",
        };
      },
      csi() {
        const entry = navigation();
        return {
          startE: Math.round(performance.timeOrigin),
          onloadT: Math.round(performance.timeOrigin + (entry?.domContentLoadedEventEnd ?? 0)),
          pageT: performance.now(),
          tran: 15,
        };
      },
    };
    const app = {
      isInstalled: false,
      InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" },
      RunningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" },
      getDetails() {
        return null;
      },
      getIsInstalled() {
        return false;
      },
      installState(callback?: unknown) {
        if (typeof callback === "function") callback("not_installed");
      },
      runningState() {
        return "cannot_run";
      },
    };
    const runtime = {
      connect() {},
      sendMessage() {},
      id: undefined,
      OnInstalledReason: {
        CHROME_UPDATE: "chrome_update",
        INSTALL: "install",
        SHARED_MODULE_UPDATE: "shared_module_update",
        UPDATE: "update",
      },
      OnRestartRequiredReason: { APP_UPDATE: "app_update", OS_UPDATE: "os_update", PERIODIC: "periodic" },
      PlatformArch: { ARM: "arm", ARM64: "arm64", MIPS: "mips", MIPS64: "mips64", X86_32: "x86-32", X86_64: "x86-64" },
      PlatformNaclArch: { ARM: "arm", MIPS: "mips", MIPS64: "mips64", X86_32: "x86-32", X86_64: "x86-64" },
      PlatformOs: { ANDROID: "android", CROS: "cros", LINUX: "linux", MAC: "mac", OPENBSD: "openbsd", WIN: "win" },
      RequestUpdateCheckStatus: {
        NO_UPDATE: "no_update",
        THROTTLED: "throttled",
        UPDATE_AVAILABLE: "update_available",
      },
    };
    for (const name of ["getDetails", "getIsInstalled", "installState", "runningState"] as const) {
      natives.set(app[name], name);
    }
    natives.set(runtime.connect, "connect");
    natives.set(runtime.sendMessage, "sendMessage");
    natives.set(methods.loadTimes, "loadTimes");
    natives.set(methods.csi, "csi");
    return { loadTimes: methods.loadTimes, csi: methods.csi, app, runtime };
  };

  const install = (target: typeof globalThis): void => {
    const existing = "chrome" in target && typeof target.chrome === "object" ? target.chrome : null;
    if (existing && "loadTimes" in existing && typeof existing.loadTimes === "function") return;

    const functionPrototype = target.Function.prototype;
    const maskedToString = new Proxy(functionPrototype.toString, {
      apply: (method, self: unknown) => {
        if (typeof self === "object" && self !== null && nativesRequest in self) {
          Object.defineProperty(self, nativesRequest, { value: natives });
          return "";
        }
        const name = typeof self === "function" ? natives.get(self) : undefined;
        if (name !== undefined) return `function ${name}() { [native code] }`;
        try {
          return method.call(self);
        } catch (error) {
          removeTrapFrame(error);
          throw error;
        }
      },
    });
    natives.set(maskedToString, "toString");
    Object.defineProperty(functionPrototype, "toString", { value: maskedToString });
    if (onMac) refusePasskeyDialogs(target);

    const chrome = existing ?? {};
    for (const [key, value] of Object.entries(chromeValues(target))) {
      Object.defineProperty(chrome, key, { value, writable: true, enumerable: true, configurable: true });
    }
    if (chrome !== existing) {
      Object.defineProperty(target, "chrome", { value: chrome, writable: true, enumerable: true, configurable: true });
    }

    const installStealth = (env: typeof globalThis): void => {
      try {
        const nav = env.navigator;
        const navProto = env.Navigator?.prototype;
        if (!nav || !navProto) return;

        try {
          const getWebdriver = () => false;
          natives.set(getWebdriver, "get webdriver");
          Object.defineProperty(navProto, "webdriver", {
            get: getWebdriver,
            set: undefined,
            enumerable: true,
            configurable: true,
          });
        } catch {}

        try {
          const getPlatform = () => "Win32";
          natives.set(getPlatform, "get platform");
          Object.defineProperty(navProto, "platform", {
            get: getPlatform,
            enumerable: true,
            configurable: true,
          });
        } catch {}

        try {
          const getLang = () => "en-US";
          const getLangs = () => Object.freeze(["en-US", "en"]);
          natives.set(getLang, "get language");
          natives.set(getLangs, "get languages");
          Object.defineProperty(navProto, "language", {
            get: getLang,
            enumerable: true,
            configurable: true,
          });
          Object.defineProperty(navProto, "languages", {
            get: getLangs,
            enumerable: true,
            configurable: true,
          });
        } catch {}

        try {
          const cleanUA = (nav.userAgent || "")
            .replace(/\s(?:Electron|OpenBot)\/[^\s]+/gu, "")
            .replace(/(\sChrome\/)\d+\.[\d.]+/u, "$1133.0.0.0")
            .replace(/\(([^)]+)\)/u, "(Windows NT 10.0; Win64; x64)");
          const getUA = () => cleanUA;
          natives.set(getUA, "get userAgent");
          Object.defineProperty(navProto, "userAgent", {
            get: getUA,
            enumerable: true,
            configurable: true,
          });
          const getAppVersion = () => cleanUA.replace(/^Mozilla\//u, "");
          natives.set(getAppVersion, "get appVersion");
          Object.defineProperty(navProto, "appVersion", {
            get: getAppVersion,
            enumerable: true,
            configurable: true,
          });
        } catch {}

        try {
          const major = "133";
          const brands = [
            { brand: "Not(A:Brand", version: "99" },
            { brand: "Google Chrome", version: major },
            { brand: "Chromium", version: major },
          ];
          const highEntropyValues: Record<string, unknown> = {
            architecture: "x86",
            bitness: "64",
            brands,
            formFactors: ["Desktop"],
            fullVersionList: [
              { brand: "Not(A:Brand", version: "99.0.0.0" },
              { brand: "Google Chrome", version: "133.0.6943.98" },
              { brand: "Chromium", version: "133.0.6943.98" },
            ],
            model: "",
            mobile: false,
            platform: "Windows",
            platformVersion: "15.0.0",
            wow64: false,
          };
          const getHighEntropyValues = (hints: string[]) => {
            const result: Record<string, unknown> = {
              brands,
              mobile: false,
              platform: "Windows",
            };
            if (Array.isArray(hints)) {
              for (const hint of hints) {
                if (hint in highEntropyValues) {
                  result[hint] = highEntropyValues[hint];
                }
              }
            }
            return env.Promise.resolve(result);
          };
          const toJSON = () => ({ brands, mobile: false, platform: "Windows" });
          natives.set(getHighEntropyValues, "getHighEntropyValues");
          natives.set(toJSON, "toJSON");
          const uad = {
            brands,
            mobile: false,
            platform: "Windows",
            getHighEntropyValues,
            toJSON,
          };
          const getUAD = () => uad;
          natives.set(getUAD, "get userAgentData");
          Object.defineProperty(navProto, "userAgentData", {
            get: getUAD,
            enumerable: true,
            configurable: true,
          });
        } catch {}

        try {
          const pluginData = [
            { name: "PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
            { name: "Chrome PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
            { name: "Chromium PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
            {
              name: "Microsoft Edge PDF Viewer",
              filename: "internal-pdf-viewer",
              description: "Portable Document Format",
            },
            { name: "WebKit built-in PDF", filename: "internal-pdf-viewer", description: "Portable Document Format" },
          ];
          const mimeData = [
            { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format" },
            { type: "text/pdf", suffixes: "pdf", description: "Portable Document Format" },
          ];

          const pProto = env.PluginArray ? env.PluginArray.prototype : Object.prototype;
          const mProto = env.MimeTypeArray ? env.MimeTypeArray.prototype : Object.prototype;
          const pluginsObj: Record<string | number, unknown> = Object.create(pProto);
          const mimeTypesObj: Record<string | number, unknown> = Object.create(mProto);

          pluginData.forEach((p, idx) => {
            const plugin: Record<string, unknown> = env.Plugin ? Object.create(env.Plugin.prototype) : {};
            Object.defineProperties(plugin, {
              name: { value: p.name, enumerable: true },
              filename: { value: p.filename, enumerable: true },
              description: { value: p.description, enumerable: true },
              length: { value: mimeData.length, enumerable: true },
            });
            pluginsObj[idx] = plugin;
            pluginsObj[p.name] = plugin;
          });
          pluginsObj.length = pluginData.length;
          const itemFn = (idx: number) => pluginsObj[idx] ?? null;
          const namedItemFn = (name: string) => pluginsObj[name] ?? null;
          const refreshFn = () => {};
          natives.set(itemFn, "item");
          natives.set(namedItemFn, "namedItem");
          natives.set(refreshFn, "refresh");
          pluginsObj.item = itemFn;
          pluginsObj.namedItem = namedItemFn;
          pluginsObj.refresh = refreshFn;

          mimeData.forEach((m, idx) => {
            const mime: Record<string, unknown> = env.MimeType ? Object.create(env.MimeType.prototype) : {};
            Object.defineProperties(mime, {
              type: { value: m.type, enumerable: true },
              suffixes: { value: m.suffixes, enumerable: true },
              description: { value: m.description, enumerable: true },
              enabledPlugin: { value: pluginsObj[0], enumerable: true },
            });
            mimeTypesObj[idx] = mime;
            mimeTypesObj[m.type] = mime;
          });
          mimeTypesObj.length = mimeData.length;
          const mimeItemFn = (idx: number) => mimeTypesObj[idx] ?? null;
          const mimeNamedItemFn = (name: string) => mimeTypesObj[name] ?? null;
          natives.set(mimeItemFn, "item");
          natives.set(mimeNamedItemFn, "namedItem");
          mimeTypesObj.item = mimeItemFn;
          mimeTypesObj.namedItem = mimeNamedItemFn;

          const getPlugins = () => pluginsObj;
          const getMimes = () => mimeTypesObj;
          natives.set(getPlugins, "get plugins");
          natives.set(getMimes, "get mimeTypes");
          Object.defineProperty(navProto, "plugins", { get: getPlugins, enumerable: true, configurable: true });
          Object.defineProperty(navProto, "mimeTypes", { get: getMimes, enumerable: true, configurable: true });
        } catch {}

        try {
          const patchWebGL = (glProto: unknown): void => {
            if (!glProto || typeof (glProto as { getParameter?: unknown }).getParameter !== "function") return;
            const originalGetParam = (glProto as { getParameter: (...args: unknown[]) => unknown }).getParameter;
            const getParameterProxy = new Proxy(originalGetParam, {
              apply: (method, self: unknown, args: unknown[]) => {
                const param = args[0];
                if (param === 37445) return "Google Inc. (NVIDIA)";
                if (param === 37446) return "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)";
                if (param === 7936) return "WebKit";
                if (param === 7937) return "WebKit WebGL";
                if (param === 35724) return "WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)";
                try {
                  return method.apply(self, args);
                } catch (error) {
                  removeTrapFrame(error);
                  throw error;
                }
              },
            });
            natives.set(getParameterProxy, "getParameter");
            Object.defineProperty(glProto, "getParameter", {
              value: getParameterProxy,
              writable: true,
              enumerable: false,
              configurable: true,
            });
          };

          if (
            "WebGLRenderingContext" in env &&
            (env as { WebGLRenderingContext?: { prototype?: unknown } }).WebGLRenderingContext?.prototype
          ) {
            patchWebGL((env as { WebGLRenderingContext: { prototype: unknown } }).WebGLRenderingContext.prototype);
          }
          if (
            "WebGL2RenderingContext" in env &&
            (env as { WebGL2RenderingContext?: { prototype?: unknown } }).WebGL2RenderingContext?.prototype
          ) {
            patchWebGL((env as { WebGL2RenderingContext: { prototype: unknown } }).WebGL2RenderingContext.prototype);
          }
        } catch {}

        try {
          const getConcurrency = () => 16;
          const getMem = () => 8;
          natives.set(getConcurrency, "get hardwareConcurrency");
          natives.set(getMem, "get deviceMemory");
          Object.defineProperty(navProto, "hardwareConcurrency", {
            get: getConcurrency,
            enumerable: true,
            configurable: true,
          });
          Object.defineProperty(navProto, "deviceMemory", { get: getMem, enumerable: true, configurable: true });

          const screenProto = (env as any).Screen?.prototype;
          if (screenProto) {
            wrapGetter(screenProto, "colorDepth", () => 24);
            wrapGetter(screenProto, "pixelDepth", () => 24);
            wrapGetter(screenProto, "width", () => 1920);
            wrapGetter(screenProto, "height", () => 1080);
            wrapGetter(screenProto, "availWidth", () => 1920);
            wrapGetter(screenProto, "availHeight", () => 1040);
          }
        } catch {}

        try {
          if ("Notification" in env) {
            wrapGetter(env.Notification as any, "permission", () => "default");
          }
          if ("permissions" in nav && (nav as { permissions?: { query?: unknown } }).permissions) {
            const permProto = Object.getPrototypeOf((nav as { permissions: object }).permissions);
            if (permProto && typeof (permProto as { query?: unknown }).query === "function") {
              const originalQuery = (permProto as { query: (...args: unknown[]) => unknown }).query;
              const queryProxy = new Proxy(originalQuery, {
                apply: (method, self: unknown, args: unknown[]) => {
                  const name = (args[0] as { name?: string } | undefined)?.name;
                  if (name === "notifications") {
                    return env.Promise.resolve({
                      name: "notifications",
                      state: "prompt",
                      onchange: null,
                    });
                  }
                  try {
                    return method.apply(self, args);
                  } catch (error) {
                    removeTrapFrame(error);
                    throw error;
                  }
                },
              });
              natives.set(queryProxy, "query");
              Object.defineProperty(permProto, "query", {
                value: queryProxy,
                writable: true,
                enumerable: true,
                configurable: true,
              });
            }
          }
        } catch {}
      } catch {}
    };

    installStealth(target);

    const innerSize = (key: "innerWidth" | "innerHeight"): number => {
      try {
        // A frame's outer size is the size of the top window, as in Chrome.
        return target.top?.[key] ?? target[key];
      } catch {
        return target[key];
      }
    };
    wrapGetter(target, "outerWidth", (value) =>
      value < innerSize("innerWidth") ? innerSize("innerWidth") + frameWidth : value,
    );
    wrapGetter(target, "outerHeight", (value) =>
      value <= innerSize("innerHeight") ? innerSize("innerHeight") + toolbarHeight : value,
    );
    for (const key of ["screenX", "screenY", "screenLeft", "screenTop"] as const) {
      wrapGetter(target, key, (value) => (value <= -10_000 ? 0 : value));
    }
    // A page can read a new frame's window before the frame's own document, and this preload,
    // load. That window gets the same values here.
    wrapGetter(target.HTMLIFrameElement.prototype, "contentWindow", (value) => {
      if (isGlobal(value)) {
        try {
          install(value);
        } catch {
          // A frame that refuses a change keeps its own values.
        }
      }
      return value;
    });
  };

  install(globalThis);
}

contextBridge.executeInMainWorld({ func: matchChromePageValues });
