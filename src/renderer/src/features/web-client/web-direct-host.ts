import type { TeamMemberSummary } from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import { getHttpPeerSessionToken, teamProtocolHeaders } from "@openbot/team-client";
import type { RemoteTeamHost } from "@openbot/team-client/remote-directory";

/**
 * The direct mode's host directory.
 *
 * The cloud account service owns the directory of hosts in the normal mode: it answers
 * `/v2/remote/hosts/` with the hosts an account has joined. The direct mode has no account
 * service. It talks to one local Team API, which knows its own identity and its own members, so
 * the directory is that single host, read from the Team API itself.
 */

/** The protocol the direct mode speaks. The Team API answers 426 for anything below 9. */
const DIRECT_PROTOCOL = 9;

/**
 * The base URL of the Team API.
 *
 * The WebUI is served by the same reverse proxy that serves `/v1/`, so the page's own origin is
 * the Team API's base URL. A build may name another one with `VITE_OPENBOT_DIRECT_HOST_URL`.
 */
export function directHostBaseUrl(): string {
  const configured = readEnv("VITE_OPENBOT_DIRECT_HOST_URL");
  if (configured) return configured.replace(/\/+$/u, "");
  if (typeof window !== "undefined" && window.location?.origin) return window.location.origin;
  return "http://127.0.0.1:28420";
}

function readEnv(name: string): string {
  try {
    const meta = import.meta;
    if (isDynamicRecord(meta) && isDynamicRecord(meta.env)) {
      const value = meta.env[name];
      if (isString(value)) return value;
    }
  } catch {
    // Storage unavailable
  }
  return "";
}

/**
 * The public key of a PEM block, as the host list carries it.
 *
 * The host list names the key by its base64 body only. The identity route answers with the PEM
 * block, so the body is what the list needs, and the two forms are the same key.
 */
function publicKeyBody(pem: string): string {
  return pem
    .replaceAll("-----BEGIN PUBLIC KEY-----", "")
    .replaceAll("-----END PUBLIC KEY-----", "")
    .replaceAll(/\s+/gu, "");
}

/**
 * Reads the local host from the Team API.
 *
 * The identity route needs no member, so it answers before the sign-in too. The membership needs
 * the session token, so a host that is not signed in yet keeps the owner's role; the sign-in
 * refreshes the entry once the token is there.
 */
export async function listDirectHosts(): Promise<RemoteTeamHost[]> {
  const baseUrl = directHostBaseUrl();
  const headers: Record<string, string> = { Accept: "application/json", ...teamProtocolHeaders(DIRECT_PROTOCOL) };
  const token = getHttpPeerSessionToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const identityResponse = await fetch(`${baseUrl}${TEAM_API_ROUTES.identity}`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!identityResponse?.ok) {
    throw new Error(`The Team API at ${baseUrl} did not answer ${TEAM_API_ROUTES.identity}.`);
  }
  const identity = await identityResponse.json().catch(() => null);
  if (!isDynamicRecord(identity) || !isString(identity.serverId) || !isString(identity.serverName)) {
    throw new Error("The Team API returned an invalid identity.");
  }
  const devicePublicKey = isString(identity.publicKey) ? publicKeyBody(identity.publicKey) : "";

  let membershipId = "direct-local";
  let role: RemoteTeamHost["role"] = "owner";
  if (token) {
    const memberResponse = await fetch(`${baseUrl}${TEAM_API_ROUTES.me}`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (memberResponse?.ok) {
      const member = await memberResponse.json().catch(() => null);
      if (isDynamicRecord(member) && isString(member.id)) {
        membershipId = member.id;
        if (member.role === "owner" || member.role === "admin" || member.role === "member") {
          role = member.role;
        }
      }
    }
  }

  return [
    {
      hostId: identity.serverId,
      name: identity.serverName,
      logoKey: null,
      devicePublicKey,
      membershipId,
      role,
    },
  ];
}

/**
 * One member of the local team, in the shape the workspace reads.
 *
 * The Team API answers `/v1/team/members` in this shape already, so the decoder only guards
 * against a value that is not a member at all.
 */
export function decodeDirectMember(value: unknown): TeamMemberSummary {
  if (
    !isDynamicRecord(value) ||
    !isString(value.id) ||
    !isString(value.username) ||
    (value.email !== null && !isString(value.email)) ||
    (value.name !== null && !isString(value.name)) ||
    (value.role !== "owner" && value.role !== "admin" && value.role !== "member") ||
    !isString(value.createdAt) ||
    typeof value.disabled !== "boolean"
  ) {
    throw new Error("The Team API returned an invalid member.");
  }
  return {
    id: value.id,
    username: value.username,
    email: value.email,
    name: value.name,
    avatarUrl: isString(value.avatarUrl) ? value.avatarUrl : null,
    role: value.role,
    createdAt: value.createdAt,
    disabled: value.disabled,
  };
}
