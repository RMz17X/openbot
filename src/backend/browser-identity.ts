export const STEALTH_CHROME_MAJOR = "133";
export const STEALTH_CHROME_VERSION = "133.0.0.0";
export const STEALTH_CHROME_FULL = "133.0.6943.98";

/**
 * The browser keeps the installed Chromium major version and host platform. Chrome sends only the
 * major version in this string (`Chrome/133.0.0.0`); Electron sends the full version, which no
 * Chrome does, and some bot checks refuse it. The full version stays in `navigator.userAgentData`.
 */
export function sessionBrowserUserAgent(userAgent: string): string {
  const cleaned = userAgent
    .replace(/\s(?:Electron|OpenBot)\/[^\s]+/gu, "")
    .replace(/(\sChrome\/)\d+\.[\d.]+/u, `$1${STEALTH_CHROME_VERSION}`);
  return cleaned.replace(/\(([^)]+)\)/u, "(Windows NT 10.0; Win64; x64)");
}

/**
 * The request User-Agent must always match clean desktop Chrome identity without any
 * Electron or framework tokens, including on Google accounts authentication endpoints.
 */
export function browserRequestUserAgent(url: string, userAgent: string, electronVersion: string): string {
  void url;
  void electronVersion;
  return sessionBrowserUserAgent(userAgent);
}

// GREASE constants removed for static stealth brand definition.

/**
 * The brands of `navigator.userAgentData`, in Chromium's order: a GREASE brand and Chromium,
 * both chosen by the major version (`GenerateBrandVersionList` in Chromium's
 * `components/embedder_support/user_agent_utils.cc`). Cloudflare rejects a header that names
 * different brands than the page reads, even when a person solves the challenge.
 */
function browserBrandHeader(chromeVersion: string, full: boolean): string {
  void chromeVersion;
  const major = STEALTH_CHROME_MAJOR;
  const version = full ? STEALTH_CHROME_FULL : major;
  const greaseVersion = full ? "99.0.0.0" : "99";
  const grease = `"Not(A:Brand";v="${greaseVersion}"`;
  const googleChrome = `"Google Chrome";v="${version}"`;
  const chromium = `"Chromium";v="${version}"`;
  return `${grease}, ${googleChrome}, ${chromium}`;
}

/** Electron has native navigator.userAgentData, but does not send client-hint headers. */
export function browserClientHints(chromeVersion: string, platform: NodeJS.Platform): Record<string, string> {
  void platform;
  return {
    "Sec-CH-UA": browserBrandHeader(chromeVersion, false),
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"Windows"',
  };
}

export interface BrowserHintSystem {
  chromeVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  /** `process.getSystemVersion()`. */
  systemVersion: string;
}

/**
 * The hints that Chrome sends only after a site asks for them with `Accept-CH`. Each value is the
 * one that `navigator.userAgentData.getHighEntropyValues()` gives the page. A value that this
 * function cannot give exactly is absent: Windows reports a contract version, not the OS version.
 */
export function browserHighEntropyClientHints(system: BrowserHintSystem): Record<string, string> {
  const hints: Record<string, string> = {
    "Sec-CH-UA-Full-Version-List": browserBrandHeader(system.chromeVersion, true),
    "Sec-CH-UA-Full-Version": `"${system.chromeVersion}"`,
    "Sec-CH-UA-Model": '""',
    "Sec-CH-UA-Platform": '"Windows"',
    "Sec-CH-UA-Platform-Version": '"15.0.0"',
    "Sec-CH-UA-WoW64": "?0",
    "Sec-CH-UA-Form-Factors": '"Desktop"',
    "Sec-CH-UA-Arch": '"x86"',
    "Sec-CH-UA-Bitness": '"64"',
  };
  void system;
  return hints;
}

const HINT_ORIGIN_LIMIT = 500;

/**
 * Which hints each origin asked for. As in Chrome, only the response of a page load sets them, and
 * only a request to that origin from a page of that origin carries them. Chrome keeps them across
 * restarts; this record does not, so the first load after a restart is as a first visit.
 */
export class BrowserHintRequests {
  readonly #origins = new Map<string, ReadonlySet<string>>();

  /** Reads the `Accept-CH` header of a page-load response. */
  note(url: string, responseHeaders: Record<string, string[]> | undefined): void {
    const origin = URL.parse(url)?.origin;
    const header = Object.entries(responseHeaders ?? {}).find(([name]) => name.toLowerCase() === "accept-ch");
    if (!origin || !header) return;
    const names = header[1]
      .flatMap((value) => value.split(","))
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean);
    this.#origins.delete(origin);
    if (names.length === 0) return;
    this.#origins.set(origin, new Set(names));
    const oldest = this.#origins.keys().next().value;
    if (this.#origins.size > HINT_ORIGIN_LIMIT && oldest !== undefined) this.#origins.delete(oldest);
  }

  /** The hint names for a request. `pageUrl` is the page that makes it; a page load names itself. */
  requested(url: string, pageUrl: string): ReadonlySet<string> | undefined {
    const origin = URL.parse(url)?.origin;
    if (!origin || URL.parse(pageUrl)?.origin !== origin) return undefined;
    return this.#origins.get(origin);
  }
}
