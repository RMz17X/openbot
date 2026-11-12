import type { CentralAuthUser } from "@openbot/contracts/ipc";
import { isBoolean, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import {
  getHttpPeerSessionToken,
  HttpPeerError,
  loginHttpTeamPeer,
  setHttpPeerSessionToken,
  teamProtocolHeaders,
} from "@openbot/team-client";
import { currentText } from "@openbot/ui/text";
import { directHostBaseUrl } from "./web-direct-host";

/**
 * The session of the direct mode.
 *
 * The direct mode signs in against a local Team API instead of the cloud account service, so the
 * session is a bearer token that the Team API issued. The token lives in the tab's
 * `sessionStorage` under `openbot.direct.session` and ends with the tab. The password that
 * obtains it never leaves the browser and is never part of the built bundle.
 */

/** The protocol the direct mode speaks. The Team API answers 426 for anything below 9. */
const DIRECT_PROTOCOL = 9;

/** The local owner account the operator created for the WebUI. */
export const DIRECT_HOST_USERNAME = "rickicode";

/**
 * The account the workspace runs as.
 *
 * The direct mode has no cloud account, so the account is the local member the Team API names.
 * The address is a local one, because the Team API gives the member no email.
 */
function directAccount(member: unknown): CentralAuthUser {
  if (!isDynamicRecord(member) || !isString(member.id)) {
    throw new Error("The Team API returned an invalid member.");
  }
  const username = isString(member.username) ? member.username : DIRECT_HOST_USERNAME;
  return {
    id: member.id,
    email: isString(member.email) && member.email ? member.email : `${username}@local`,
    name: isString(member.name) && member.name ? member.name : username,
    avatarUrl: isString(member.avatarUrl) ? member.avatarUrl : null,
    analyticsEnabled: isBoolean(member.analyticsEnabled) ? member.analyticsEnabled : false,
    chatColor: null,
  };
}

/**
 * Checks the session token of the tab.
 *
 * A token that the Team API refuses is dropped, so the sign-in screen asks for the password
 * again instead of the workspace failing on every read.
 */
export async function readDirectSession(): Promise<CentralAuthUser | null> {
  const token = getHttpPeerSessionToken();
  if (!token) return null;
  const response = await fetch(`${directHostBaseUrl()}${TEAM_API_ROUTES.me}`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...teamProtocolHeaders(DIRECT_PROTOCOL),
    },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!response?.ok) {
    setHttpPeerSessionToken(null);
    return null;
  }
  const member = await response.json().catch(() => null);
  return directAccount(member);
}

/**
 * Signs in against the Team API and keeps the session token in the tab.
 *
 * The password is posted and forgotten; only the token is kept, and the token is what the
 * workspace's reads carry.
 */
export async function signInDirect(username: string, password: string): Promise<CentralAuthUser> {
  const baseUrl = directHostBaseUrl();
  let token: string;
  try {
    token = await loginHttpTeamPeer(baseUrl, username, password, DIRECT_PROTOCOL);
  } catch (error: unknown) {
    throw new Error(directLoginMessage(error));
  }
  setHttpPeerSessionToken(token);
  const account = await readDirectSession();
  if (!account) {
    setHttpPeerSessionToken(null);
    throw new Error("The Team API refused the session it just issued.");
  }
  return account;
}

/**
 * The message the sign-in screen shows for a failed login.
 *
 * The Team API answers 429 when the same account failed too often from one address, and the
 * plain "login failed" would ask the user to type the password again and make the lock-out
 * worse. The reference of the peer error carries the status, so the rate limit gets its own
 * message.
 */
function directLoginMessage(error: unknown): string {
  const reference = error instanceof HttpPeerError ? error.reference : undefined;
  if (reference === "http/429") return currentText().t("webClient.directLogin.rateLimited");
  if (reference === "http/401" || reference === "http/403")
    return currentText().t("webClient.directLogin.wrongPassword");
  return error instanceof Error && error.message ? error.message : currentText().t("webClient.directLogin.failed");
}

/** Ends the session of the tab. The Team API keeps its own session record until it expires. */
export function signOutDirect(): void {
  setHttpPeerSessionToken(null);
}
