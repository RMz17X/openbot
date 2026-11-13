import { fileURLToPath } from "node:url";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

/**
 * The web client component. The same mapping the account Worker uses, so both builds run the same
 * code: `apps/auth-api/renderer-preview-alias.ts` names `rendererWebAlias` for this file.
 */
const rendererWebAlias = fileURLToPath(
  new URL("../../src/renderer/src/features/web-client/WebApp.tsx", import.meta.url),
);

/** The stylesheet of the web client. It pulls in the renderer styles and the shared UI styles. */
const rendererWebCssAlias = fileURLToPath(
  new URL("../../src/renderer/src/features/web-client/web-client.css", import.meta.url),
);

const openpanelStub = fileURLToPath(new URL("./src/stubs/openpanel.ts", import.meta.url));
const mermaidStub = fileURLToPath(new URL("./src/stubs/mermaid.ts", import.meta.url));
const i18nEnOnlyStub = fileURLToPath(new URL("./src/stubs/i18n-en-only.ts", import.meta.url));

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

/**
 * Refuses a build that would bake a credential into the bundle.
 *
 * The direct mode signs in from the browser: the WebUI posts the password to the Team API and
 * keeps only the returned session token, in the tab's sessionStorage. A password in the bundle is
 * a permanent credential in a static file every browser downloads, so the build stops when one is
 * set. The token is a short-lived session token, so it is allowed through.
 */
function refuseBundledCredentials(): Plugin {
  const forbidden = ["VITE_OPENBOT_DIRECT_HOST_PASSWORD", "VITE_OPENBOT_DIRECT_HOST_USERNAME"];
  return {
    name: "openbot-refuse-bundled-credentials",
    enforce: "pre",
    buildStart() {
      const set = forbidden.filter((name) => (process.env[name] ?? "").trim().length > 0);
      if (set.length === 0) return;
      this.error(
        `Refusing to build the WebUI: ${set.join(", ")} would be inlined into the bundle as a ` +
          `plaintext credential. The direct mode signs in from the browser and keeps only the ` +
          `session token, so unset these variables and let the sign-in form ask for the password.`,
      );
    },
  };
}
function enOnlyLanguageCatalogs(): Plugin {
  const i18nSource = normalizePath(fileURLToPath(new URL("../../packages/i18n/src/", import.meta.url)));
  const eagerModules = new Set(["./app-catalogs", "./source-catalogs", "./format-catalogs", "./locale-loading"]);
  return {
    name: "openbot-en-only-language-catalogs",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer || !eagerModules.has(source)) return null;
      if (!normalizePath(importer).startsWith(i18nSource)) return null;
      return i18nEnOnlyStub;
    },
  };
}

/**
 * The headers the account Worker sends with the web client page. A static bundle has no response
 * object, so the reverse proxy in front of the host sends them.
 */
const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["Cache-Control", "no-store"],
  ["X-Robots-Tag", "noindex, nofollow"],
  ["Referrer-Policy", "no-referrer"],
  // Codex live voice of a joined server records in this page. The site's other pages keep `microphone=()`.
  ["Permissions-Policy", "camera=(), geolocation=(), microphone=(self), payment=(), usb=()"],
  // A visual reply page runs in a sandboxed `srcdoc` frame, which inherits this policy. A
  // `script-src` or `default-src` here would stop the page and its bootstrap script.
  ["Content-Security-Policy", "frame-ancestors 'none'"],
  ["X-Frame-Options", "DENY"],
];

/**
 * Emits the `_headers` file into the static output, using the exact security headers list.
 */
function headersFile(): Plugin {
  return {
    name: "openbot-webui-headers-file",
    apply: "build",
    generateBundle() {
      const body = `${SECURITY_HEADERS.map(([name, value]) => `  ${name}: ${value}`).join("\n")}\n`;
      this.emitFile({ type: "asset", fileName: "_headers", source: `/*\n${body}` });
    },
  };
}

/**
 * The web client runs in a plain browser without the Electron preload bridge.
 * Replace desktop-port fallbacks to `window.openbot` with `undefined` at build time so the static
 * bundle contains no reference to the Electron preload global.
 */
function noElectronPreload(): Plugin {
  return {
    name: "openbot-no-electron-preload",
    enforce: "post",
    transform(code) {
      if (!code.includes("window.openbot")) return null;
      return {
        code: code.replace(/\bwindow\.openbot\b(?!Page)/g, "undefined"),
        map: null,
      };
    },
  };
}

export default defineConfig({
  // The bundle is served from any path by the reverse proxy in front of the host.
  base: "./",
  resolve: {
    dedupe: ["solid-js", "@solidjs/web", "@solidjs/signals"],
    alias: {
      "@openbot/renderer-web": rendererWebAlias,
      "@openbot/renderer-web-css": rendererWebCssAlias,
      "@openpanel/web": openpanelStub,
      mermaid: mermaidStub,
    },
  },
  define: {
    "import.meta.env.VITE_OPENBOT_DIRECT_HOST": JSON.stringify("1"),
  },
  // The direct mode signs in from the browser: the WebUI posts the password to the Team API and
  // keeps only the returned session token, in the tab's sessionStorage. A password baked into the
  // bundle would be a permanent credential in a static file every browser downloads, so the build
  // refuses to start with one set.
  envPrefix: ["VITE_OPENBOT_DIRECT_HOST_URL"],
  optimizeDeps: {
    // bloub finds its plush images with `new URL(..., import.meta.url)`. A pre-bundle moves the
    // code away from the images, so Vite serves the package as it is.
    exclude: ["@norbert_bodziony/bloub", "@norbert_bodziony/bloub/plush"],
  },
  // Vite removes license comments by default. The home page beam's license requires its notice
  // in each copy, so the minifier moves `/*!` and `@license` comments to the end of each file.
  esbuild: { legalComments: "eof" },
  plugins: [
    noElectronPreload(),
    refuseBundledCredentials(),
    solidPlugin({ performanceTracks: false }),
    tailwindcss({ optimize: false }),
    enOnlyLanguageCatalogs(),
    headersFile(),
  ],
  server: {
    // The development server sends the same headers as the production reverse proxy.
    headers: Object.fromEntries(SECURITY_HEADERS),
  },
  build: {
    outDir: "dist",
    // A caption file has to stay a file. It is small enough for Vite to fold
    // into the bundle as a `data:` URL, and a text track fetched from one is
    // cross-origin to the page that asks for it, so the player drops it and the
    // video plays with no captions at all. Everything else keeps the default.
    assetsInlineLimit: (file) => (file.endsWith(".vtt") ? false : undefined),
    rollupOptions: {
      input: { index: fileURLToPath(new URL("./index.html", import.meta.url)) },
    },
  },
});
