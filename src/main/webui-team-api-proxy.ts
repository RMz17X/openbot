/**
 * The forwarding of the Team API's requests.
 *
 * The web UI gateway answers the static bundle itself and hands everything under `/v1/` and
 * `/v2/` to the Team API. The Team API keeps its own listener on a loopback port, and the gateway
 * is a client of that listener: it forwards the request, the answer, and the event socket.
 */

import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";

/** The paths the Team API owns. Everything else is the bundle. */
const TEAM_API_PREFIXES = ["/v1/", "/v2/"];

/**
 * The headers the client's protocol travels in.
 *
 * The Team API answers `426 client_update_required` when either is missing, so the gateway passes
 * them through unchanged: the browser names the protocol it speaks and the Team API stays the
 * single source of truth.
 */
const PROTOCOL_HEADER = "openbot-protocol-version";
const APP_VERSION_HEADER = "openbot-app-version";

/** True when the path belongs to the Team API. */
export function isTeamApiPath(pathname: string): boolean {
  return TEAM_API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Forwards a request to the Team API.
 *
 * The Team API answers on loopback, so the host header is the Team API's own. The client's own
 * headers travel with the request, including the protocol headers and the session token.
 */
export function forwardToTeamApi(
  request: IncomingMessage,
  response: ServerResponse,
  teamApiPort: number,
  onError: (error: unknown) => void,
): void {
  const proxy = httpRequest(
    {
      host: "127.0.0.1",
      port: teamApiPort,
      method: request.method,
      path: request.url,
      headers: {
        ...request.headers,
        host: `127.0.0.1:${teamApiPort}`,
        [PROTOCOL_HEADER]: request.headers[PROTOCOL_HEADER] ?? "",
        [APP_VERSION_HEADER]: request.headers[APP_VERSION_HEADER] ?? "",
      },
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  proxy.on("error", (error: unknown) => {
    onError(error);
    if (!response.headersSent) response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("The team API is not answering");
  });
  request.on("error", () => proxy.destroy());
  request.pipe(proxy);
}

/**
 * Forwards a socket upgrade to the Team API.
 *
 * The browser's WebSocket handshake carries the session token in the `Sec-WebSocket-Protocol`
 * header, so the handshake is forwarded as it is: the Team API reads the token from there. The
 * raw bytes of both directions are copied, because the Team API's answer is a WebSocket stream
 * and not an HTTP answer.
 */
export function forwardUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, teamApiPort: number): void {
  const upstream = connect(teamApiPort, "127.0.0.1", () => {
    const headers = Object.entries(request.headers)
      .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(", ") : (value ?? "")}`)
      .join("\r\n");
    const target = `GET ${request.url ?? "/"} HTTP/1.1\r\n${headers}\r\n\r\n`;
    upstream.write(target);
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const stop = (): void => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.on("error", stop);
  socket.on("error", stop);
  upstream.on("close", () => socket.destroy());
  socket.on("close", () => upstream.destroy());
}

/** A socket that is being closed, so a half-open pair does not linger. */
export function destroySocket(socket: Socket): void {
  socket.destroy();
}
