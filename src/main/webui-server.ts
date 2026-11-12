/**
 * The web UI of a headless server.
 *
 * A daemon in server mode has no window, so the web client is the only interface a person has.
 * The daemon therefore serves the built bundle itself and forwards the Team API's routes to the
 * Team API, which keeps its own listener on a loopback port.
 *
 * The gateway does not replace the Team API: the Android app and the desktop app talk to that
 * one, and the members of the cloud account service reach it through Signal.
 */

import { join } from "node:path";
import { createWebUiGateway, type WebUiGateway } from "./webui-gateway";

/** The port the web UI listens on when the environment names none. */
export const DEFAULT_WEB_UI_PORT = 28421;

/** The host the web UI binds to. The daemon is reached through a proxy, so it binds to all. */
const WEB_UI_HOST = "0.0.0.0";

export interface WebUiServerOptions {
  /** The port the Team API listens on, or null before it started. */
  teamApiPort: () => number | null;
  /** The directory the built web client is in. */
  root: string;
  /** The port the web UI listens on. */
  port: number;
  /** Reports a failure that a start could not recover from. */
  onError?: (message: string, error: unknown) => void;
}

/**
 * The directory the built web client is in.
 *
 * A packaged app carries the bundle in its resources, next to the icons and the agent runtime.
 * The bundle is a build artifact of `apps/webui`, so it is not in the app's `out`.
 */
export function webUiRoot(resourcesPath: string): string {
  return join(resourcesPath, "webui");
}

/**
 * Starts the web UI server of a headless daemon.
 *
 * The server is stopped with the daemon, so the caller keeps it and stops it in its teardown.
 */
export async function startWebUiServer(options: WebUiServerOptions): Promise<WebUiGateway> {
  const gateway = createWebUiGateway({
    root: options.root,
    teamApiPort: options.teamApiPort,
    port: options.port,
    host: WEB_UI_HOST,
    onError: options.onError,
  });
  const port = await gateway.start();
  options.onError?.(`The web UI server listens on port ${port}.`, undefined);
  return gateway;
}

/**
 * The port the web UI listens on, from the environment.
 *
 * The environment names the port so a proxy in front of the daemon can reach it. Zero is not a
 * choice: the port has to be known before the daemon answers the first request.
 */
export function webUiPortFromEnvironment(environment: NodeJS.ProcessEnv): number {
  const raw = environment.OPENBOT_WEBUI_PORT?.trim();
  if (!raw) return DEFAULT_WEB_UI_PORT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) return DEFAULT_WEB_UI_PORT;
  return parsed;
}
