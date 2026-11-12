/**
 * The static files of the web client.
 *
 * The standalone web client is a static bundle. A daemon that serves it needs to answer the
 * bundle's own requests: the hashed assets, the entry point, and the fallback to the entry point
 * for a route the client resolves in the browser.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

/** The content types the bundle uses. Anything else is served as a download. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".vtt": "text/vtt; charset=utf-8",
};

/** The file the client asks for when a route has no file of its own. */
const ENTRY_POINT = "index.html";

/** A resolved request: the file to send, and how to cache it. */
export interface StaticFile {
  /** The absolute path of the file. */
  path: string;
  /** The content type of the file. */
  contentType: string;
  /** The cache control of the response. */
  cacheControl: string;
}

/**
 * The file a request names, inside the bundle's root.
 *
 * A path that leaves the root is refused: the request comes from a browser and a `..` in it must
 * not reach a file outside the bundle. The check is on the resolved path, so a symlink inside the
 * bundle is judged by where it points.
 */
export async function resolveStaticFile(root: string, pathname: string): Promise<StaticFile | null> {
  const rootPath = resolve(root);
  const relative = normalize(decodePath(pathname)).replace(/^([/\\])+/u, "");
  const candidate = resolve(join(rootPath, relative));
  if (candidate !== rootPath && !candidate.startsWith(rootPath + sep)) return null;
  const file = await statFile(candidate);
  if (file?.isFile()) return describe(candidate, relative);
  return null;
}

/**
 * The entry point of the bundle, for a route the client resolves in the browser.
 *
 * The web client is a single page: a route it does not know has no file, and the answer is the
 * entry point, which reads the route itself.
 */
export async function resolveEntryPoint(root: string): Promise<StaticFile | null> {
  const rootPath = resolve(root);
  const candidate = join(rootPath, ENTRY_POINT);
  const file = await statFile(candidate);
  if (!file?.isFile()) return null;
  return describe(candidate, ENTRY_POINT);
}

/** The content type of a file name. An unknown type is a download. */
export function contentTypeOf(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** Sends a file to the browser. */
export function sendStaticFile(response: ServerResponse, file: StaticFile): void {
  response.setHeader("Content-Type", file.contentType);
  response.setHeader("Cache-Control", file.cacheControl);
  response.setHeader("X-Content-Type-Options", "nosniff");
  const stream = createReadStream(file.path);
  stream.on("error", () => {
    response.destroy();
  });
  stream.pipe(response);
}

/** Decodes a request path. A path with a broken escape is refused. */
function decodePath(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return "";
  }
}

/** The file's own metadata, or null when it cannot be read. */
async function statFile(path: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

/**
 * The headers of a file.
 *
 * The assets carry a hash of their content in their name, so a browser may keep them for a year.
 * The entry point names the assets, so it may not be kept: a new build has to reach the browser.
 */
function describe(path: string, relative: string): StaticFile {
  const hashed = relative.startsWith("assets/");
  return {
    path,
    contentType: contentTypeOf(path),
    cacheControl: hashed ? "public, max-age=31536000, immutable" : "no-cache, must-revalidate",
  };
}
