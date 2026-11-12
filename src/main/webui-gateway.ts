/**
 * The web UI of a headless server.
 *
 * A daemon that serves the web client needs three things on one port: the static bundle, the Team
 * API's JSON routes, and the Team API's event socket. A reverse proxy in front of the daemon does
 * that today, but it needs the daemon's port, and the daemon picks a free one on every start, so
 * the proxy has to discover it. This server answers all three itself, so the daemon is the only
 * process a user has to reach.
 *
 * The Team API itself keeps its own listener on a loopback port. This server does not replace it:
 * the Android app and the desktop app talk to that one, and the members of the cloud account
 * service reach it through Signal. This server forwards to it.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { Duplex } from "node:stream";
import { resolveEntryPoint, resolveStaticFile, sendStaticFile } from "./webui-static";
import { forwardToTeamApi, forwardUpgrade, isTeamApiPath } from "./webui-team-api-proxy";

export interface WebUiGatewayOptions {
  /** The directory the built web client is in. */
  root: string;
  /**
   * The port the Team API listens on, or null before it started.
   *
   * The Team API takes a free loopback port and starts when the host publishes, which is after
   * this server. The port is therefore read per request, not once at the start.
   */
  teamApiPort: () => number | null;
  /** The port this server listens on. Zero picks a free one. */
  port: number;
  /** The host this server binds to. */
  host?: string;
  /** Reports a failure that a start could not recover from. */
  onError?: (message: string, error: unknown) => void;
}

export interface WebUiGateway {
  /** The port this server listens on, or null before it started. */
  readonly port: number | null;
  /** Starts the server and resolves with its port. */
  start(): Promise<number>;
  /** Stops the server. */
  stop(): Promise<void>;
}

/**
 * Creates the web UI server of a headless daemon.
 *
 * The Team API's port is passed in, because the daemon starts its Team API before this server and
 * keeps the port in one place.
 */
export function createWebUiGateway(options: WebUiGatewayOptions): WebUiGateway {
  const root = resolve(options.root);
  let server: Server | null = null;
  let port: number | null = null;
  const sockets = new Set<Duplex>();

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (isTeamApiPath(url.pathname)) {
      const teamApiPort = options.teamApiPort();
      if (teamApiPort === null) {
        response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("The team API is not ready");
        return;
      }
      forwardToTeamApi(request, response, teamApiPort, (error: unknown) =>
        options.onError?.("Unable to reach the team API:", error),
      );
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    const file = (await resolveStaticFile(root, url.pathname)) ?? (await resolveEntryPoint(root));
    if (!file) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
      return;
    }
    sendStaticFile(response, file);
  };

  return {
    get port() {
      return port;
    },
    async start(): Promise<number> {
      if (server && port !== null) return port;
      const created = createServer((request, response) => {
        void handle(request, response).catch((error: unknown) => {
          options.onError?.("Unable to answer a web UI request:", error);
          if (!response.headersSent) response.writeHead(500).end();
          else response.destroy();
        });
      });
      // The event socket of the Team API arrives as an upgrade. It is forwarded as it is, so the
      // session token in the handshake's sub-protocol reaches the Team API.
      created.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        const teamApiPort = options.teamApiPort();
        if (teamApiPort === null) {
          socket.destroy();
          return;
        }
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        forwardUpgrade(request, socket, head, teamApiPort);
      });
      created.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
      await new Promise<void>((resolveListen, rejectListen) => {
        created.once("error", rejectListen);
        created.listen(options.port, options.host ?? "127.0.0.1", () => {
          created.removeListener("error", rejectListen);
          resolveListen();
        });
      });
      server = created;
      const address = created.address();
      port = typeof address === "object" && address !== null ? address.port : options.port;
      return port;
    },
    async stop(): Promise<void> {
      const current = server;
      server = null;
      port = null;
      if (!current) return;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolveClose) => current.close(() => resolveClose()));
    },
  };
}
