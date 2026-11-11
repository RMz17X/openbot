import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import { teamCapabilitiesForProtocol } from "@openbot/contracts/team-protocol/current";
import { teamHttpCodec } from "@openbot/contracts/team-protocol/http-codecs";
import { optionalTeamEvent, optionalTeamEventToCurrent } from "@openbot/contracts/team-protocol/optional-events";
import {
  decodeRemoteDesktopSignalBinary,
  decodeRemoteDesktopSignalControl,
  encodeRemoteDesktopSignalBinary,
  encodeRemoteDesktopSignalControl,
  type RemoteDesktopSignalControl,
} from "@openbot/contracts/team-protocol/remote-stream-v1";
import { teamSideRouteCodec } from "@openbot/contracts/team-protocol/side-routes";
import { addSkillSuggestionNames } from "@openbot/contracts/team-protocol/skill-learning-v1";
import {
  highestCommonTeamProtocol,
  TEAM_APP_VERSION_HEADER,
  TEAM_CAPABILITIES_HEADER,
  TEAM_PROTOCOL_V1_WEBSOCKET,
  TEAM_PROTOCOL_VERSION_HEADER,
} from "@openbot/contracts/team-protocol/v1";
import { encodeTeamProtocolV1CurrentClientEvent } from "@openbot/contracts/team-protocol/v1-adapter";
import { decodeTeamProtocolV2Json, type TeamProtocolV2Json } from "@openbot/contracts/team-protocol/v2";
import { decodeTeamProtocolV8BaseCurrentEvent } from "@openbot/contracts/team-protocol/v8-base-adapter";
import { decodeTeamProtocolSupportV9 } from "@openbot/contracts/team-protocol/v9";
import { sourceText } from "@openbot/i18n/source";
import { errorReference, referenceFrom } from "@openbot/user-errors";
import type {
  RemoteHostProtocols,
  RemoteTeamCommand,
  RemoteTeamCommandResult,
  RemoteTeamPeerActions,
} from "./remote-peer";

const LOCAL_SERVER_OWNER_USERNAME = "owner";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export class HttpPeerError extends Error {
  readonly code?: string;
  readonly reference?: string;
  constructor(message: string, options?: { code?: string; reference?: string }) {
    super(message);
    this.name = "HttpPeerError";
    this.code = options?.code;
    this.reference = options?.reference;
  }
}

export interface ActionsRef {
  current: RemoteTeamPeerActions;
}

export interface HttpPeerOptions {
  waitForHost?: boolean;
  hostProtocols?: RemoteHostProtocols;
  apiUrl?: string;
  token?: string;
  username?: string;
  password?: string;
}

let storedSessionToken: string | null = null;

export function setHttpPeerSessionToken(token: string | null): void {
  storedSessionToken = token;
  try {
    if (typeof sessionStorage !== "undefined") {
      if (token) sessionStorage.setItem("openbot.direct.session", token);
      else sessionStorage.removeItem("openbot.direct.session");
    }
  } catch {
    // Storage unavailable
  }
}

export function getHttpPeerSessionToken(): string | null {
  if (storedSessionToken) return storedSessionToken;
  try {
    if (typeof sessionStorage !== "undefined") {
      const saved = sessionStorage.getItem("openbot.direct.session");
      if (saved) {
        storedSessionToken = saved;
        return saved;
      }
    }
  } catch {
    // Storage unavailable
  }
  const envToken = envProperty("VITE_OPENBOT_DIRECT_HOST_TOKEN");
  if (envToken) {
    storedSessionToken = envToken;
    return envToken;
  }
  return null;
}

function envProperty(name: string): string {
  try {
    const meta: unknown = import.meta;
    if (isDynamicRecord(meta) && isDynamicRecord(meta.env)) {
      const value = meta.env[name];
      if (isString(value)) return value;
    }
    const globalObj: Record<string, unknown> = globalThis;
    if (isDynamicRecord(globalObj.process) && isDynamicRecord(globalObj.process.env)) {
      const value = globalObj.process.env[name];
      if (isString(value)) return value;
    }
  } catch {
    // Ignore
  }
  return "";
}

function resolveBaseUrl(apiUrl?: string): string {
  const custom = apiUrl || envProperty("VITE_OPENBOT_DIRECT_HOST_URL");
  if (custom) return custom.replace(/\/+$/u, "");
  if (typeof window !== "undefined" && window.location?.origin) return window.location.origin;
  return "http://127.0.0.1:28417";
}

function toWebSocketUrl(httpBaseUrl: string, pathname: string): string {
  const url = new URL(pathname, httpBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

async function requestLoginToken(baseUrl: string, username: string, password: string): Promise<string> {
  const response = await fetch(`${baseUrl}${TEAM_API_ROUTES.auth.login}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) throw new HttpPeerError("Login failed", { reference: `http/${response.status}` });
  const data = await response.json().catch(() => null);
  if (!isDynamicRecord(data) || !isString(data.sessionToken)) {
    throw new HttpPeerError("Invalid login response", { reference: "http/500" });
  }
  setHttpPeerSessionToken(data.sessionToken);
  return data.sessionToken;
}

function isBinaryDownload(response: Response, path: string): boolean {
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const disposition = response.headers.get("content-disposition");
  if (disposition?.includes("attachment")) return true;
  if (contentType.includes("application/octet-stream") || contentType.includes("application/zip")) return true;
  if (path.startsWith("/v1/attachments/") && !contentType.includes("application/json")) return true;
  if (path.startsWith("/v1/shared-files") && !contentType.includes("application/json")) return true;
  if (path.startsWith("/v1/workspace-files") && !contentType.includes("application/json")) return true;
  return false;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    const byte = bytes[i];
    if (byte !== undefined) binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function createHttpTeamPeer(actions: ActionsRef, options: HttpPeerOptions = {}) {
  const baseUrl = resolveBaseUrl(options.apiUrl);
  let waitForHost = options.waitForHost ?? false;
  let active = true;
  let disposed = false;
  let activeHostId: string | null = null;
  let negotiatedProtocol = 9;
  let hostAppVersion: string | null = null;
  let eventsSocket: WebSocket | null = null;
  let sseAbortController: AbortController | null = null;
  let activeUploadController: AbortController | null = null;
  const browserViewSockets = new Map<string, WebSocket>();
  const hostProtocols = options.hostProtocols;

  function stopEventStream(): void {
    if (eventsSocket) {
      eventsSocket.onopen = null;
      eventsSocket.onclose = null;
      eventsSocket.onerror = null;
      eventsSocket.onmessage = null;
      eventsSocket.close(1000, "Event stream stopped");
      eventsSocket = null;
    }
    if (sseAbortController) {
      sseAbortController.abort();
      sseAbortController = null;
    }
  }

  function closeBrowserStreams(): void {
    for (const socket of browserViewSockets.values()) socket.close(1000, "Browser stream closed");
    browserViewSockets.clear();
  }

  function handleIncomingEvent(dataText: string): void {
    try {
      const value = JSON.parse(dataText);
      const optional = optionalTeamEvent(value, { agentTaskUiBlocks: true });
      const decoded = optional
        ? { kind: "known" as const, event: optionalTeamEventToCurrent(optional) }
        : decodeTeamProtocolV8BaseCurrentEvent(value);
      if (decoded.kind === "known" && activeHostId) {
        addSkillSuggestionNames(decoded.event, value);
        void actions.current.onTeamEvent(activeHostId, decoded.event);
      }
    } catch {
      // Ignore malformed event payload
    }
  }

  async function startEventsWebSocket(hostId: string, token: string): Promise<boolean> {
    stopEventStream();
    const wsUrl = toWebSocketUrl(baseUrl, TEAM_API_ROUTES.events);
    const protocols = [TEAM_PROTOCOL_V1_WEBSOCKET, `openbot-token.${token}`];
    return new Promise((resolve) => {
      let settled = false;
      let socket: WebSocket;
      try {
        socket = new WebSocket(wsUrl, protocols);
      } catch {
        resolve(false);
        return;
      }
      eventsSocket = socket;
      socket.onopen = () => {
        if (disposed || eventsSocket !== socket) {
          socket.close();
          return;
        }
        try {
          socket.send(
            encodeTeamProtocolV1CurrentClientEvent({
              type: "agent-event-scope",
              includeConversations: true,
              capabilities: teamCapabilitiesForProtocol(negotiatedProtocol),
            }),
          );
        } catch {
          // Scope send error
        }
        if (!settled) {
          settled = true;
          resolve(true);
        }
      };
      socket.onmessage = (msgEvent) => {
        if (typeof msgEvent.data === "string") handleIncomingEvent(msgEvent.data);
      };
      socket.onerror = () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      };
      socket.onclose = (closeEvent) => {
        if (eventsSocket === socket) eventsSocket = null;
        if (!settled) {
          settled = true;
          resolve(false);
          return;
        }
        if (disposed || !active) return;
        const authFailed = closeEvent.code === 4001 || closeEvent.code === 1008;
        void actions.current.onConnectionUpdate({
          hostId,
          state: "offline",
          message: closeEvent.reason || sourceText("error.remote.connectionDropped"),
          ...(authFailed ? { code: "session_revoked", reference: "http/401" } : {}),
        });
      };
    });
  }

  async function startEventsSse(hostId: string, token: string): Promise<boolean> {
    stopEventStream();
    const controller = new AbortController();
    sseAbortController = controller;
    const url = new URL(TEAM_API_ROUTES.events, baseUrl);

    try {
      const response = await fetch(url.href, {
        headers: {
          Accept: "text/event-stream",
          Authorization: `Bearer ${token}`,
          [TEAM_PROTOCOL_VERSION_HEADER]: String(negotiatedProtocol),
        },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) return false;
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/event-stream")) return false;

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf8");
      let buffer = "";

      void (async () => {
        try {
          while (!controller.signal.aborted) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split("\n\n");
            buffer = parts.pop() ?? "";
            for (const part of parts) {
              for (const line of part.split("\n")) {
                if (line.startsWith("data:")) handleIncomingEvent(line.slice(5).trim());
              }
            }
          }
        } catch {
          // SSE read finished or aborted
        } finally {
          if (!controller.signal.aborted && active && !disposed) {
            void actions.current.onConnectionUpdate({
              hostId,
              state: "offline",
              message: sourceText("error.remote.connectionDropped"),
            });
          }
        }
      })();
      return true;
    } catch {
      return false;
    }
  }

  async function ensureSessionToken(hostId: string): Promise<string | null> {
    let token = options.token || getHttpPeerSessionToken();
    if (token) return token;

    const password = options.password || envProperty("VITE_OPENBOT_DIRECT_HOST_PASSWORD");
    const username =
      options.username || envProperty("VITE_OPENBOT_DIRECT_HOST_USERNAME") || LOCAL_SERVER_OWNER_USERNAME;

    if (password) {
      try {
        token = await requestLoginToken(baseUrl, username, password);
        return token;
      } catch (err: unknown) {
        const ref = err instanceof HttpPeerError && err.reference ? err.reference : "http/401";
        void actions.current.onConnectionUpdate({
          hostId,
          state: "offline",
          message: sourceText("error.team.signInRequired"),
          code: "session_revoked",
          reference: ref,
        });
        return null;
      }
    }

    void actions.current.onConnectionUpdate({
      hostId,
      state: "offline",
      message: sourceText("error.team.signInRequired"),
      code: "session_revoked",
      reference: "http/401",
    });
    return null;
  }

  return {
    async sendHostStreamData(data: string | ArrayBuffer): Promise<void> {
      if (typeof data === "string") {
        let control: RemoteDesktopSignalControl;
        try {
          control = decodeRemoteDesktopSignalControl(data);
        } catch {
          return;
        }

        if (control.type === "open") {
          const wsUrl = toWebSocketUrl(baseUrl, control.path);
          const currentToken = options.token || getHttpPeerSessionToken();
          const protocols = currentToken ? [`openbot-token.${currentToken}`] : [];
          const socket = new WebSocket(wsUrl, protocols);
          socket.binaryType = "arraybuffer";
          browserViewSockets.set(control.streamId, socket);

          socket.onopen = () => {
            actions.current.onHostStreamData?.(
              encodeRemoteDesktopSignalControl({ type: "opened", streamId: control.streamId }),
            );
          };
          socket.onmessage = (event) => {
            if (typeof event.data === "string") {
              actions.current.onHostStreamData?.(
                encodeRemoteDesktopSignalControl({ type: "text", streamId: control.streamId, data: event.data }),
              );
            } else if (event.data instanceof ArrayBuffer) {
              actions.current.onHostStreamData?.(
                encodeRemoteDesktopSignalBinary(control.streamId, new Uint8Array(event.data)),
              );
            }
          };
          socket.onclose = (event) => {
            browserViewSockets.delete(control.streamId);
            actions.current.onHostStreamData?.(
              encodeRemoteDesktopSignalControl({
                type: "close",
                streamId: control.streamId,
                code: event.code,
                reason: event.reason,
              }),
            );
          };
          socket.onerror = () => {
            browserViewSockets.delete(control.streamId);
            actions.current.onHostStreamData?.(
              encodeRemoteDesktopSignalControl({
                type: "error",
                streamId: control.streamId,
                message: sourceText("error.backend.browserViewFailed"),
              }),
            );
          };
          return;
        }

        const socket = browserViewSockets.get(control.streamId);
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        if (control.type === "text") socket.send(control.data);
        else if (control.type === "close") {
          socket.close(control.code, control.reason);
          browserViewSockets.delete(control.streamId);
        }
        return;
      }

      try {
        const binary = decodeRemoteDesktopSignalBinary(data);
        const socket = browserViewSockets.get(binary.streamId);
        if (socket && socket.readyState === WebSocket.OPEN) {
          const buffer = new ArrayBuffer(binary.bytes.byteLength);
          new Uint8Array(buffer).set(binary.bytes);
          socket.send(buffer);
        }
      } catch {
        // Drop unparsed binary stream data
      }
    },

    async cancelUpload(): Promise<void> {
      if (activeUploadController) {
        activeUploadController.abort();
        activeUploadController = null;
      }
    },

    setTyping(agentId: string | null, typing: boolean): void {
      if (eventsSocket && eventsSocket.readyState === WebSocket.OPEN) {
        eventsSocket.send(JSON.stringify({ type: "team-typing", botId: agentId, typing }));
      }
    },

    setWaitForHost(value: boolean): void {
      waitForHost = value;
    },

    setActive(value: boolean): void {
      active = value;
      if (!value) stopEventStream();
    },

    networkRestored(): void {
      // Direct HTTP peer does not maintain an ICE mesh
    },

    networkMoved(): void {
      // Direct HTTP peer does not maintain an ICE mesh
    },

    async dispose(): Promise<void> {
      disposed = true;
      active = false;
      stopEventStream();
      closeBrowserStreams();
      if (activeUploadController) {
        activeUploadController.abort();
        activeUploadController = null;
      }
    },

    async execute(command: RemoteTeamCommand): Promise<RemoteTeamCommandResult> {
      if (command.type === "disconnect") {
        stopEventStream();
        closeBrowserStreams();
        activeHostId = null;
        return { commandId: command.id, ok: true };
      }

      if (command.type === "connect") {
        const { hostId } = command;
        activeHostId = hostId;
        await actions.current.onConnectionUpdate({ hostId, state: "connecting", message: null });

        try {
          const compResponse = await fetch(`${baseUrl}${TEAM_API_ROUTES.compatibility}`, {
            headers: { Accept: "application/json" },
          });
          if (compResponse.ok) {
            const compJson = await compResponse.json().catch(() => null);
            if (compJson) {
              const support = decodeTeamProtocolSupportV9(compJson);
              hostAppVersion = support.appVersion;
              negotiatedProtocol =
                highestCommonTeamProtocol({ minimum: 1, maximum: 9 }, support.protocol) ?? 9;
              hostProtocols?.set(hostId, negotiatedProtocol);
            }
          }
        } catch (err: unknown) {
          const ref = errorReference(err) ?? "errno/ECONNREFUSED";
          const message = sourceText("error.remote.selectedServerOffline");
          await actions.current.onConnectionUpdate({ hostId, state: "offline", message, reference: ref });
          return { commandId: command.id, ok: false, error: message, reference: ref };
        }

        const token = await ensureSessionToken(hostId);
        if (!token) {
          return {
            commandId: command.id,
            ok: false,
            error: sourceText("error.team.signInRequired"),
            reference: "http/401",
          };
        }

        const wsConnected = await startEventsWebSocket(hostId, token);
        if (!wsConnected) {
          const sseConnected = await startEventsSse(hostId, token);
          if (!sseConnected && !waitForHost) {
            const message = sourceText("error.remote.eventsUnavailable");
            await actions.current.onConnectionUpdate({ hostId, state: "offline", message });
            return { commandId: command.id, ok: false, error: message, reference: "http/426" };
          }
        }

        await actions.current.onConnectionUpdate({ hostId, state: "online", message: null });
        return { commandId: command.id, ok: true };
      }

      const url = new URL(command.path, baseUrl);
      const headers: Record<string, string> = { Accept: "application/json" };
      const currentToken = options.token || getHttpPeerSessionToken();
      if (currentToken) headers.Authorization = `Bearer ${currentToken}`;
      headers[TEAM_PROTOCOL_VERSION_HEADER] = String(negotiatedProtocol);
      if (hostAppVersion) headers[TEAM_APP_VERSION_HEADER] = hostAppVersion;
      headers[TEAM_CAPABILITIES_HEADER] = teamCapabilitiesForProtocol(negotiatedProtocol).join(",");

      let requestBody: BodyInit | undefined;
      if (command.upload) {
        const buffer = base64ToBuffer(command.upload.base64);
        headers["Content-Type"] = command.upload.mimeType || "application/octet-stream";
        requestBody = buffer;
        if (actions.current.onUploadProgress) {
          void actions.current.onUploadProgress({
            commandId: command.id,
            sent: buffer.byteLength,
            total: buffer.byteLength,
          });
        }
      } else if (command.body !== undefined && command.method !== "GET" && command.method !== "HEAD") {
        const sideRoute = teamSideRouteCodec(command.path);
        if (sideRoute) {
          requestBody = JSON.stringify(
            sideRoute.request(command.path, command.body, {
              channelIsolation: true,
              channelPicture: true,
              channelBrowser: true,
            }),
          );
        } else {
          try {
            const codec = teamHttpCodec(negotiatedProtocol);
            requestBody = codec.encodeRequest(command.method, command.path, command.body, {
              preserveSemanticTags: true,
              agentCreateModel: true,
            });
          } catch {
            requestBody = JSON.stringify(command.body ?? {});
          }
        }
        headers["Content-Type"] = "application/json";
      }

      const controller = new AbortController();
      if (command.upload) activeUploadController = controller;
      const timeoutTimer = setTimeout(() => controller.abort(), command.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch(url.href, {
          method: command.method,
          headers,
          body: requestBody,
          signal: controller.signal,
        });
        clearTimeout(timeoutTimer);
        if (command.upload && activeUploadController === controller) activeUploadController = null;
        const status = response.status;

        if (command.largeDownload || isBinaryDownload(response, command.path)) {
          if (status === 200) {
            const buffer = await response.arrayBuffer();
            const base64 = arrayBufferToBase64(buffer);
            const disposition = response.headers.get("content-disposition");
            const filenameMatch = disposition
              ? /filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/u.exec(disposition)
              : null;
            const name = filenameMatch
              ? decodeURIComponent(filenameMatch[1] || filenameMatch[2] || "")
              : command.path.split("/").pop() || "download";
            const mimeType = response.headers.get("content-type") || "application/octet-stream";
            return {
              commandId: command.id,
              ok: true,
              status,
              body: decodeTeamProtocolV2Json({ name, mimeType, base64 }),
            };
          }
        }

        if (status === 204) return { commandId: command.id, ok: true, status, body: {} as TeamProtocolV2Json };

        const rawJson = await response.json().catch(() => null);
        let body: TeamProtocolV2Json;
        if (status < 400) {
          const sideRoute = teamSideRouteCodec(command.path);
          if (sideRoute) {
            body = decodeTeamProtocolV2Json(
              sideRoute.response(command.path, status, rawJson, {
                historyExtent: true,
                channelAttention: true,
                agentTaskUiBlocks: true,
                channelIsolation: true,
                channelPicture: true,
                channelBrowser: true,
                mcpManyServers: true,
              }),
            );
          } else {
            try {
              const codec = teamHttpCodec(negotiatedProtocol);
              body = decodeTeamProtocolV2Json(codec.decodeResponse(command.method, command.path, status, rawJson));
            } catch {
              body = decodeTeamProtocolV2Json(rawJson);
            }
          }
          addSkillSuggestionNames(body, rawJson);
        } else {
          body = decodeTeamProtocolV2Json(rawJson);
        }

        if (response.ok) return { commandId: command.id, ok: true, status, body };

        const ref =
          isDynamicRecord(body) && isString(body.code)
            ? (referenceFrom("host", status, body.code) ?? referenceFrom("http", status) ?? undefined)
            : (referenceFrom("http", status) ?? undefined);
        const errorMsg =
          isDynamicRecord(body) && isString(body.error)
            ? body.error
            : sourceText("error.remote.requestFailedStatus", { status });
        return {
          commandId: command.id,
          ok: false,
          status,
          error: errorMsg,
          reference: ref,
          body,
        };
      } catch (fetchError: unknown) {
        clearTimeout(timeoutTimer);
        if (command.upload && activeUploadController === controller) activeUploadController = null;
        const isAbort = fetchError instanceof Error && fetchError.name === "AbortError";
        const ref = isAbort ? "errno/ETIMEDOUT" : (errorReference(fetchError) ?? "errno/ECONNREFUSED");
        const msg = isAbort
          ? sourceText("error.remote.desktopRequestTimeout")
          : fetchError instanceof Error
            ? fetchError.message
            : sourceText("error.remote.operationFailed");
        return { commandId: command.id, ok: false, error: msg, reference: ref };
      }
    },
  };
}
