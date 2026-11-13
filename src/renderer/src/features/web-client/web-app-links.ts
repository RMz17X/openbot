/**
 * The deep links and search parameters the web client consumes from its URL.
 *
 * Each helper inspects `window.location.search`, removes the consumed parameters from the address
 * bar via `window.history.replaceState` so reloads do not trigger them again, and returns the
 * parsed value.
 */

import { agentTemplateIdFromWebAppSearch, WEB_APP_AGENT_TEMPLATE_PARAM } from "@openbot/contracts/agent-template-links";
import { companySignInErrorKey, WEB_APP_COMPANY_SIGN_IN_ERROR_PARAM } from "@openbot/contracts/company-sign-in";
import { inviteUrlFromWebAppSearch, WEB_APP_INVITE_FIELDS } from "@openbot/contracts/invite-links";
import {
  type MarketplaceListingLink,
  marketplaceListingFromWebAppSearch,
  WEB_APP_MARKETPLACE_AGENT_PARAM,
  WEB_APP_MARKETPLACE_SKILL_PARAM,
} from "@openbot/contracts/marketplace-links";
import { pluginSlugFromWebAppSearch, WEB_APP_PLUGIN_PARAM } from "@openbot/contracts/plugin-links";
import { sourceText } from "@openbot/i18n/source";
import type { DesktopAnalyticsProperties } from "../../analytics";
import { takeWebAppStart, WEB_APP_BILLING_PARAM, type WebAppStart } from "./web-billing";

/**
 * The error code of a company sign-in that came back without a session, from
 * `/app?companySignInError=<code>`. The query is removed after it is read.
 */
export function takeCompanySignInError(): string | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  const code = url.searchParams.get(WEB_APP_COMPANY_SIGN_IN_ERROR_PARAM);
  if (code === null) return null;
  url.searchParams.delete(WEB_APP_COMPANY_SIGN_IN_ERROR_PARAM);
  window.history.replaceState(window.history.state, "", url);
  return code;
}

export function companySignInIssue(code: string): { code: string; message: string } {
  return { code, message: sourceText(companySignInErrorKey(code)) };
}

/**
 * The shared agent a `/app?agent=<id>` link names. The query is removed after it is read, so a reload
 * does not open the preview again.
 */
export function takeAgentTemplateLink(): string | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  if (!url.searchParams.has(WEB_APP_AGENT_TEMPLATE_PARAM)) return null;
  const id = agentTemplateIdFromWebAppSearch(url.search);
  url.searchParams.delete(WEB_APP_AGENT_TEMPLATE_PARAM);
  window.history.replaceState(window.history.state, "", url);
  return id;
}

/**
 * The invitation a `/app?api=…&server=…&fingerprint=…&invite=…` link names, as the `/join` page
 * passes it on. The fields are removed after they are read, so the secret does not stay in the
 * address bar or the history, and a reload does not open the dialog again.
 */
export function takeInviteLink(): string | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  if (!WEB_APP_INVITE_FIELDS.some((field) => url.searchParams.has(field))) return null;
  const inviteUrl = inviteUrlFromWebAppSearch(url.search, {
    allowLocalDevelopmentApiUrl: import.meta.env.DEV,
  });
  for (const field of WEB_APP_INVITE_FIELDS) url.searchParams.delete(field);
  window.history.replaceState(window.history.state, "", url);
  return inviteUrl;
}

/** The plugin listing a `/app?plugin=<slug>` link names. The query is removed after it is read. */
export function takePluginLink(): string | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  if (!url.searchParams.has(WEB_APP_PLUGIN_PARAM)) return null;
  const slug = pluginSlugFromWebAppSearch(url.search);
  url.searchParams.delete(WEB_APP_PLUGIN_PARAM);
  window.history.replaceState(window.history.state, "", url);
  return slug;
}

/**
 * The agent or skill a `/app?marketplaceAgent=<id>` or `/app?marketplaceSkill=<slug>` link names.
 * The query is removed after it is read.
 */
export function takeMarketplaceLink(): MarketplaceListingLink | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  const params = [WEB_APP_MARKETPLACE_AGENT_PARAM, WEB_APP_MARKETPLACE_SKILL_PARAM];
  if (!params.some((param) => url.searchParams.has(param))) return null;
  const link = marketplaceListingFromWebAppSearch(url.search);
  for (const param of params) url.searchParams.delete(param);
  window.history.replaceState(window.history.state, "", url);
  return link;
}

export type BillingReturn = DesktopAnalyticsProperties<"billing_return_viewed">;

/**
 * A return from Stripe to Billing: `/app?billing=portal` from the Customer Portal, or
 * `/app?billing=license` from license Checkout, with `&cancelled=1` when the user went back. The
 * query is removed after it is read.
 */
export function takeBillingReturn(): BillingReturn | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  const kind = url.searchParams.get(WEB_APP_BILLING_PARAM);
  if (kind === null) return null;
  const outcome = url.searchParams.get("cancelled") === "1" ? "cancelled" : "completed";
  for (const name of [WEB_APP_BILLING_PARAM, "cancelled"]) url.searchParams.delete(name);
  window.history.replaceState(window.history.state, "", url);
  return kind === "license" || kind === "portal" ? { outcome, kind } : { outcome };
}

/** What a `/app?start=<server|license>` link from the pricing page opens. The query is removed after it is read. */
export function takeStartLink(): WebAppStart | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  const start = takeWebAppStart(url);
  if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
  return start;
}
