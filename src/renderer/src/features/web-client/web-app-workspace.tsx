/**
 * The signed-in part of the web app.
 *
 * The workspace is its own chunk, so the sign-in screen does not wait for it. This module is the
 * boundary between the two: it takes the values the app holds and hands them to the workspace.
 * It lives apart from `WebApp.tsx` because that file is at its size limit, and the values it
 * carries are many.
 */
import type { AppAppearance } from "@openbot/contracts/app-appearance";
import type { AppLanguage } from "@openbot/contracts/app-language";
import type { CentralAuthUser } from "@openbot/contracts/ipc";
import type { MarketplaceListingLink } from "@openbot/contracts/marketplace-links";
import { Dynamic } from "@solidjs/web";
import type { AddServerResume } from "../servers/AddServerOverlay";
import type { WebWorkspace } from "./WebWorkspace";
import type { WebAppStart } from "./web-billing";
import type { WebRuntimeFactory } from "./web-client-context";

export interface WebAppWorkspaceProps {
  /** The id of the signed-in account. */
  accountId: string;
  /** The account the session belongs to. */
  account: CentralAuthUser | null;
  /** The workspace chunk, once it has loaded. */
  workspace: typeof WebWorkspace | undefined;
  /** The fetch the account service is reached with. */
  accountFetch: typeof fetch;
  /** Runs the session check again, after the workspace asks for it. */
  onSessionCheck: () => Promise<void>;
  /** True while the session has ended and the app must go back to the sign-in screen. */
  accountSessionEnded: () => boolean;
  /** Ends the session and returns to the sign-in screen. */
  onLogout: () => Promise<void>;
  /** Builds the runtime the workspace uses. */
  createRuntime?: WebRuntimeFactory | undefined;
  /** The agent template a link named. */
  agentTemplateId: string | null;
  onAgentTemplateClose: () => void;
  /** The invitation a link named. */
  inviteUrl: string | null;
  onInviteClose: () => void;
  /** The plugin a link named. */
  pluginSlug: string | null;
  onPluginSlugConsumed: () => void;
  /** The marketplace listing a link named. */
  marketplaceListing: MarketplaceListingLink | null;
  onMarketplaceListingConsumed: () => void;
  /** The server or license a link named. */
  start: WebAppStart | null;
  onStartConsumed: () => void;
  /** True when the app came back from the billing portal. */
  billingReturn: boolean;
  onBillingReturnConsumed: () => void;
  /** The server of a return from the checkout. */
  hostingReturn: AddServerResume | null;
  onHostingReturnConsumed: () => void;
  /** The interface language of this browser. */
  language: AppLanguage;
  onChangeLanguage: (language: AppLanguage) => void;
  /** The appearance of this browser. */
  appearance: AppAppearance;
  onChangeAppearance: (appearance: AppAppearance) => void;
}

export function WebAppWorkspace(props: WebAppWorkspaceProps) {
  return (
    <Dynamic
      component={props.workspace}
      accountId={props.accountId}
      accountEmail={props.account?.email ?? ""}
      accountName={props.account?.name ?? null}
      accountAvatarUrl={props.account?.avatarUrl ?? null}
      accountChatColor={props.account?.chatColor ?? null}
      accountFetch={props.accountFetch}
      onSessionCheck={props.onSessionCheck}
      accountSessionEnded={props.accountSessionEnded}
      onLogout={props.onLogout}
      createRuntime={props.createRuntime}
      agentTemplateId={props.agentTemplateId}
      onAgentTemplateClose={props.onAgentTemplateClose}
      inviteUrl={props.inviteUrl}
      onInviteClose={props.onInviteClose}
      pluginSlug={props.pluginSlug}
      onPluginSlugConsumed={props.onPluginSlugConsumed}
      marketplaceListing={props.marketplaceListing}
      onMarketplaceListingConsumed={props.onMarketplaceListingConsumed}
      start={props.start}
      onStartConsumed={props.onStartConsumed}
      billingReturn={props.billingReturn}
      onBillingReturnConsumed={props.onBillingReturnConsumed}
      hostingReturn={props.hostingReturn}
      onHostingReturnConsumed={props.onHostingReturnConsumed}
      language={props.language}
      onChangeLanguage={props.onChangeLanguage}
      appearance={props.appearance}
      onChangeAppearance={props.onChangeAppearance}
    />
  );
}
