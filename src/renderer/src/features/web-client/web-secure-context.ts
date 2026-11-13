/**
 * The secure context the WebUI needs.
 *
 * The web client protects its server connection with the Web Locks API, and it names its requests
 * with `crypto.randomUUID`. Both exist only in a secure context: a browser exposes them on an
 * HTTPS page and on a trustworthy origin such as `localhost`, and it withholds them from a plain
 * HTTP page on any other host.
 *
 * The public WebUI is served over HTTPS, so the ordinary case is a secure context. The operator
 * can still open the LAN address, which is plain HTTP, and there the page has to say what is
 * missing instead of stalling on "Connecting to ...". A polyfill would hide exactly that, so
 * there is none.
 */

/** The host of the public WebUI, as the operator opens it. */
const PUBLIC_URL = "https://openbot.jetstream.web.id/";

/**
 * True when the page may use the secure-context APIs.
 *
 * `isSecureContext` is the browser's own answer and covers `localhost` and the loopback address,
 * which are secure contexts even over plain HTTP. The two API checks are the fallback for a
 * browser that does not expose `isSecureContext` at all.
 */
export function hasSecureContext(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.isSecureContext === "boolean") return window.isSecureContext;
  return typeof navigator.locks !== "undefined" && typeof crypto.randomUUID === "function";
}

/**
 * The missing API, as the operator needs to hear it, or null when the page may use them.
 *
 * The Web Locks API is the one the connection needs; `crypto.randomUUID` is the one that names a
 * request. A page that has neither is told about the lock, because that is what stops the
 * connection.
 */
export function missingSecureApi(): "locks" | "randomUUID" | null {
  if (typeof window === "undefined") return "locks";
  if (typeof navigator.locks === "undefined") return "locks";
  if (typeof crypto.randomUUID !== "function") return "randomUUID";
  return null;
}

/** The public address the operator opens when the page cannot run where it is. */
export function publicWebUiUrl(): string {
  return PUBLIC_URL;
}
