import { type FirstTouch, readFirstTouch } from "@openbot/contracts/first-touch";
import { type AppVariant, type CentralAuthState, type CentralAuthUser, isAvatarColor } from "@openbot/contracts/ipc";
import { isBoolean, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { formatLocale, resolveLocale } from "@openbot/i18n";
import { sourceText } from "@openbot/i18n/source";
import { markRemoteSync } from "@openbot/team-client/sync-profile";
import { classifyFailure } from "@openbot/telemetry";
import { NotificationObserver, Toaster, toast } from "@openbot/ui";
import { AccountLogin } from "@openbot/ui/features/account/AccountLogin";
import { AppLoadingScreen } from "@openbot/ui/features/account/AppLoadingScreen";
import { DirectLogin } from "@openbot/ui/features/account/DirectLogin";
import { currentText } from "@openbot/ui/text";
import { createEffect, createSignal, createStore, onSettled, Show } from "solid-js";
import {
  configureWebReports,
  reportNotification,
  setWebAccountPending,
  setWebReportsEnabled,
  webAccountPending,
  webKeepsOff,
  webReportsAgreed,
  webReportsEnabled,
} from "../../error-reports";
import { StaticI18nProvider } from "../../i18n-context";
import { AnalyticsConsentRow, ConsentNotice } from "../onboarding/AnalyticsConsent";
import { createOnboardingTeam, onboardingSessionSeed } from "../onboarding/onboarding-avatars";
import { deleteRemoteWorkspaceFrames } from "../servers/remote-workspace-frame";
import { WebLanguageStep } from "./WebLanguageStep";
import type { WebWorkspace } from "./WebWorkspace";
import { createWebAccountCalls } from "./web-account";
import { deleteSavedAgentPictures } from "./web-agent-pictures";
import {
  type BillingReturn,
  companySignInIssue,
  takeAgentTemplateLink,
  takeBillingReturn,
  takeCompanySignInError,
  takeInviteLink,
  takeMarketplaceLink,
  takePluginLink,
  takeStartLink,
} from "./web-app-links";
import { WebAppWorkspace } from "./web-app-workspace";
import { createWebAppearancePreference } from "./web-appearance-preference";
import type { WebRuntimeFactory } from "./web-client-context";
import { DIRECT_HOST_USERNAME, readDirectSession, signInDirect, signOutDirect } from "./web-direct-session";
import { takeHostingReturn } from "./web-hosted-servers";
import { InsecureContextNoticeWhen } from "./web-insecure-context-notice";
import { createWebLanguagePreference } from "./web-language-preference";
import { missingSecureApi } from "./web-secure-context";

// The site loads this before it mounts `WebApp` (`apps/auth-api/src/routes/app.lazy.tsx`).
export { loadSavedLanguage } from "./web-language-preference";

/**
 * The direct mode: the web client talks to a local Team API instead of the cloud account service.
 *
 * The build decides it, the same way `web-runtime.ts` decides which peer to use. With it on, the
 * sign-in is a username and a password against the Team API, and the session is the token that
 * the Team API issued, kept in the tab's `sessionStorage`. No credential is part of the bundle.
 */
const useDirect = import.meta.env.VITE_OPENBOT_DIRECT_HOST === "1";

/**
 * The workspace is its own chunk, so the sign-in screen does not wait for it. Each session check
 * starts it beside the session request; a signed-in account waits for both. A failed import is
 * tried again on the next check.
 */
let workspaceImport: Promise<typeof WebWorkspace> | null = null;
function loadWorkspace(): Promise<typeof WebWorkspace> {
  if (!workspaceImport) {
    workspaceImport = import("./WebWorkspace").then((module) => module.WebWorkspace);
    workspaceImport.catch(() => {
      workspaceImport = null;
    });
  }
  return workspaceImport;
}

/** A sign-in refusal that the login form already shows. */
class SignInIssueShown extends Error {}

/** The email signs in with the company's provider, not with an email code. */
class CompanySignInRequired extends Error {}

/** The email start answered that the company's provider signs this email in. */
const COMPANY_SIGN_IN = Symbol("company sign-in");

export function WebApp(props: { createRuntime?: WebRuntimeFactory } = {}) {
  // This component renders the text provider, so it reads the text of the last provider that rendered.
  const text = currentText();
  const [state, setState] = createStore<{
    account: CentralAuthUser | null;
    loaded: boolean;
    login: CentralAuthState;
    resendAt: number;
  }>({
    account: null,
    loaded: false,
    login: { status: "signed_out" },
    resendAt: 0,
  });
  createEffect(
    () => ({ account: state.account, loaded: state.loaded }),
    ({ account, loaded }) => {
      if (!loaded) return;
      configureWebReports(account);
      // Analytics is optional. A failed import changes nothing in the app.
      import("./web-analytics")
        .then((module) => {
          module.configureWebAnalytics(account);
          if (!account || !billingReturnEvent) return;
          module.trackBillingReturn(billingReturnEvent);
          billingReturnEvent = null;
        })
        .catch(() => undefined);
    },
  );
  // Kept here, not in the workspace, so each link waits through sign-in.
  // Before a session check, so a signed-out browser gets the saved answer or its regional default.
  // A browser that agreed once keeps its answer: the sign-in screen does not show the box again.
  const [analyticsAgreed, setAnalyticsAgreed] = createSignal(webReportsAgreed());
  const [analyticsChoice, setAnalyticsChoice] = createSignal(webReportsEnabled());
  // Only a box that the user changed is a choice for the account; a regional default is not.
  let analyticsTouched = false;
  // After a sign-out, the sign-in screen starts again from the saved answer of this browser.
  function resetAnalyticsBox() {
    setAnalyticsAgreed(webReportsAgreed());
    setAnalyticsChoice(webReportsEnabled());
    analyticsTouched = false;
  }
  const [agentTemplateId, setAgentTemplateId] = createSignal(takeAgentTemplateLink());
  const [inviteUrl, setInviteUrl] = createSignal(takeInviteLink());
  const [pluginSlug, setPluginSlug] = createSignal(takePluginLink());
  const [marketplaceListing, setMarketplaceListing] = createSignal(takeMarketplaceLink());
  const [startLink, setStartLink] = createSignal(takeStartLink());
  const initialBillingReturn = takeBillingReturn();
  const initialHostingReturn = takeHostingReturn();
  const [billingReturn, setBillingReturn] = createSignal(initialBillingReturn !== null);
  const [hostingReturn, setHostingReturn] = createSignal(initialHostingReturn);
  /** Sent once, when analytics has the account. */
  let billingReturnEvent: BillingReturn | null =
    initialBillingReturn ??
    (initialHostingReturn ? { outcome: initialHostingReturn.paid ? "completed" : "cancelled", kind: "plan" } : null);
  /** Shown after the first session check, because its 401 resets the login state. */
  let companySignInReturnError = takeCompanySignInError();
  const [workspace, setWorkspace] = createSignal<typeof WebWorkspace>();
  /** Sets the account when the workspace code is ready to show it. */
  async function showAccount(account: CentralAuthUser) {
    const view = await loadWorkspace();
    setWorkspace(() => view);
    return account;
  }
  // The loading screen stays over the app until its exit ends.
  const [loadingShown, setLoadingShown] = createSignal(true);
  let channel: BroadcastChannel | null = null;
  let disposed = false;
  let sessionGeneration = 0;
  /**
   * The cookie's account session has ended. The server ended its remote sessions in the same write
   * (`endAccountSession`), so the closing workspace does not end them again.
   */
  let sessionEnded = false;
  function clearSession(ended = true) {
    sessionEnded = ended;
    // The saved workspace frames name the agents of the account's servers.
    if (ended) {
      deleteRemoteWorkspaceFrames(null);
      void deleteSavedAgentPictures(null);
    }
    sessionGeneration += 1;
    setState((draft) => {
      draft.account = null;
      draft.login = { status: "signed_out" };
    });
    resetAnalyticsBox();
  }
  const accountFetch: typeof fetch = async (input, init) => {
    const generation = sessionGeneration;
    const response = await fetch(input, init);
    if (
      !disposed &&
      generation === sessionGeneration &&
      response.status === 401 &&
      input !== "/api/browser/email/start" &&
      input !== "/api/browser/email/verify" &&
      input !== "/api/browser/company/start"
    ) {
      if (state.account) channel?.postMessage("session-changed");
      clearSession();
    }
    return response;
  };
  const accountCalls = createWebAccountCalls(accountFetch, checkSession);
  async function request(
    path: string,
    body?:
      | { email: string }
      | { challengeId: string | null; code: string; firstTouch?: FirstTouch }
      | Record<string, never>,
  ) {
    const response = await accountFetch(`/api/browser/${path}`, {
      method: body ? "POST" : "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: body ? { "Content-Type": "application/json", "X-OpenBot-Browser": "1" } : {},
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const value = await response.json();
    if (!response.ok) {
      if (
        path === "email/start" &&
        isDynamicRecord(value) &&
        isDynamicRecord(value.error) &&
        value.error.code === "company_sign_in_required"
      )
        throw new CompanySignInRequired();
      if (path === "email/start" || path === "email/verify") {
        const retryAfterSeconds = Number.parseInt(response.headers.get("Retry-After") ?? "", 10);
        const issue = {
          code:
            isDynamicRecord(value) && isDynamicRecord(value.error) && isString(value.error.code)
              ? value.error.code
              : "sign_in_failed",
          message:
            isDynamicRecord(value) && isDynamicRecord(value.error) && isString(value.error.message)
              ? value.error.message
              : text.t("webClient.login.failed"),
          ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
        };
        setState((draft) => {
          draft.login = draft.login.status === "code_sent" ? { ...draft.login, issue } : { status: "error", issue };
        });
        throw new SignInIssueShown();
      }
      throw new Error(
        isDynamicRecord(value) && isDynamicRecord(value.error) && isString(value.error.message)
          ? value.error.message
          : text.t("webClient.login.requestFailed"),
      );
    }
    return value;
  }
  /** Like the desktop login, a server refusal is shown as the login issue, not also as a thrown error. */
  async function signInRequest(path: "email/start" | "email/verify", body: Parameters<typeof request>[1]) {
    try {
      return await request(path, body);
    } catch (error) {
      if (error instanceof SignInIssueShown) return null;
      throw error;
    }
  }
  function accountFrom(value: unknown): CentralAuthUser {
    if (
      !isDynamicRecord(value) ||
      !isDynamicRecord(value.user) ||
      !isString(value.user.id) ||
      !isString(value.user.email)
    )
      throw new Error(text.t("webClient.login.accountInvalid"));
    return {
      id: value.user.id,
      email: value.user.email,
      name: isString(value.user.name) ? value.user.name : null,
      avatarUrl: isString(value.user.avatarUrl) ? value.user.avatarUrl : null,
      analyticsEnabled: isBoolean(value.user.analyticsEnabled) ? value.user.analyticsEnabled : null,
      chatColor: isAvatarColor(value.user.chatColor) ? value.user.chatColor : null,
    };
  }
  /**
   * Keeps this browser and the account on the user's latest analytics answer. A choice that the
   * account does not have yet goes to it; otherwise this browser follows the account's answer. An
   * "off" from before the account kept answers does not follow an "on".
   */
  async function followAccountAnalytics(answer: boolean | null | undefined) {
    const module = await import("./web-analytics");
    if (webAccountPending()) return module.sendWebAnalyticsChoice(accountCalls);
    if (answer === null || answer === undefined || answer === webReportsEnabled()) return;
    if (answer && webKeepsOff()) return;
    setWebReportsEnabled(answer);
    module.followWebReportsPreference();
  }
  async function checkSession() {
    const generation = sessionGeneration;
    // The workspace code loads beside the session check, not after it.
    void loadWorkspace().catch(() => undefined);
    // The direct mode has no account service. The session is the token the Team API issued, kept
    // in this tab, so the check reads the Team API instead of `/api/browser/session`.
    if (useDirect) {
      const account = await readDirectSession().catch(() => null);
      if (!disposed && generation === sessionGeneration) {
        sessionEnded = false;
        // The workspace code comes first, so the workspace is ready when the account shows it.
        if (account) await showAccount(account).catch(() => undefined);
        if (!disposed && generation === sessionGeneration)
          setState((draft) => {
            draft.account = account;
            draft.login = { status: "signed_out" };
            draft.loaded = true;
          });
      }
      return;
    }
    try {
      const session = await request("session");
      markRemoteSync("session");
      const account = await showAccount(accountFrom(session));
      markRemoteSync("workspace-code");
      if (!disposed && generation === sessionGeneration) {
        sessionEnded = false;
        setState((draft) => {
          draft.account = account;
        });
        void followAccountAnalytics(account.analyticsEnabled).catch(() => undefined);
      }
    } catch (error) {
      if (!disposed && generation === sessionGeneration) {
        // Signed in, the workspace stays usable. Signed out, the login screen offers a retry, as on desktop.
        if (state.account)
          toast.error(
            text.sourceText(error instanceof Error ? error.message : text.t("webClient.login.sessionFailed")),
            { report: { operation: "other", source: "system", cause_code: classifyFailure(error) } },
          );
        else
          setState((draft) => {
            draft.login = {
              status: "error",
              issue: { code: "auth_api_unavailable", message: sourceText("error.auth.serviceUnavailable") },
            };
          });
      }
    } finally {
      const returnError = companySignInReturnError;
      companySignInReturnError = null;
      if (!disposed)
        setState((draft) => {
          draft.loaded = true;
          if (returnError !== null && !draft.account && draft.login.status === "signed_out")
            draft.login = { status: "error", issue: companySignInIssue(returnError) };
        });
    }
  }
  async function start(email: string) {
    if (Date.now() < state.resendAt) throw new Error(text.t("webClient.login.wait"));
    // A request for a code answers the analytics box and accepts the Terms of Service.
    if (!analyticsAgreed()) {
      setWebReportsEnabled(analyticsChoice());
      if (analyticsTouched) setWebAccountPending(analyticsChoice());
      import("./web-analytics").then((module) => module.followWebReportsPreference()).catch(() => undefined);
    }
    const value = await signInRequest("email/start", { email }).catch((error: unknown) => {
      if (error instanceof CompanySignInRequired) return COMPANY_SIGN_IN;
      throw error;
    });
    if (value === COMPANY_SIGN_IN) return openCompanySignIn(email);
    if (value === null) return;
    if (!isDynamicRecord(value) || !isString(value.challengeId) || typeof value.resendAt !== "number")
      throw new Error(text.t("webClient.login.responseInvalid"));
    const challengeId = value.challengeId;
    const resendAt = value.resendAt;
    setState((draft) => {
      draft.resendAt = resendAt;
      draft.login = {
        status: "code_sent",
        challengeId,
        email,
        expiresAt: typeof value.expiresAt === "number" ? value.expiresAt : Date.now() + 600000,
        resendAvailableAt: resendAt,
        ...(isString(value.developmentCode) ? { developmentCode: value.developmentCode } : {}),
      };
    });
  }
  /**
   * Goes to the company's sign-in page in this tab. The account service sends the browser back to
   * `/app` with the session cookie, or with `companySignInError`.
   */
  async function openCompanySignIn(email: string) {
    setState((draft) => {
      draft.login = { status: "company_sign_in", email };
    });
    const response = await accountFetch("/api/browser/company/start", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json", "X-OpenBot-Browser": "1" },
      body: JSON.stringify({ email }),
    });
    const value = await response.json().catch(() => null);
    if (response.ok && isDynamicRecord(value) && isString(value.authorizationUrl)) {
      window.location.assign(value.authorizationUrl);
      return;
    }
    const code =
      isDynamicRecord(value) && isDynamicRecord(value.error) && isString(value.error.code)
        ? value.error.code
        : "company_sign_in_failed";
    setState((draft) => {
      draft.login = { status: "company_sign_in", email, issue: companySignInIssue(code) };
    });
  }
  async function verify(challengeId: string, code: string) {
    // The first website visit of this browser, so that reports can name the source of a new account.
    const firstTouch = readFirstTouch(() => window.localStorage, Date.now());
    const value = await signInRequest("email/verify", { challengeId, code, ...(firstTouch ? { firstTouch } : {}) });
    if (value === null) return;
    const account = accountFrom(value);
    sessionGeneration += 1;
    sessionEnded = false;
    channel?.postMessage("session-changed");
    try {
      await showAccount(account);
    } catch {
      // The server has used the code and set the session, so the retry checks the session again.
      setState((draft) => {
        draft.login = {
          status: "error",
          issue: { code: "auth_api_unavailable", message: sourceText("error.auth.serviceUnavailable") },
        };
      });
      return;
    }
    setState((draft) => {
      draft.account = account;
    });
    void followAccountAnalytics(account.analyticsEnabled).catch(() => undefined);
  }
  /**
   * Signs in against the Team API in the direct mode.
   *
   * The password is posted to the Team API and forgotten; the session token the Team API issued
   * stays in this tab. The account then opens the workspace, exactly as a cloud sign-in does.
   */
  async function directSignIn(username: string, password: string): Promise<void> {
    const generation = sessionGeneration;
    const account = await signInDirect(username, password);
    if (disposed || generation !== sessionGeneration) return;
    sessionGeneration += 1;
    sessionEnded = false;
    await showAccount(account).catch(() => undefined);
    if (disposed) return;
    setState((draft) => {
      draft.account = account;
      draft.login = { status: "signed_out" };
    });
  }
  async function logout() {
    // The direct mode has no account service to sign out of; the tab's token is the session.
    if (useDirect) {
      signOutDirect();
      clearSession();
      return;
    }
    await request("logout", {});
    clearSession();
    channel?.postMessage("session-changed");
  }
  onSettled(() => {
    channel = new BroadcastChannel("openbot.web.session");
    channel.onmessage = () => {
      clearSession();
      void checkSession();
    };
    void checkSession();
    // A page restored from the back-forward cache still has its session; its connection ends normally.
    // A browser also sends `pageshow` after a normal load, which can come after the session check.
    const restore = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      clearSession(false);
      void checkSession();
    };
    window.addEventListener("pageshow", restore);
    return () => {
      disposed = true;
      channel?.close();
      window.removeEventListener("pageshow", restore);
    };
  });
  const variant: AppVariant = import.meta.env.DEV ? "dev" : "production";
  const consentAgents = createOnboardingTeam(onboardingSessionSeed(), 3);
  const languagePreference = createWebLanguagePreference();
  const appearancePreference = createWebAppearancePreference();
  // The sign-in starts in the browser language; its language button opens the wheel to change it.
  const [languageWheelOpen, setLanguageWheelOpen] = createSignal(false);
  return (
    <StaticI18nProvider
      locale={resolveLocale(languagePreference.language(), navigator.language)}
      formatLocale={formatLocale(languagePreference.language(), navigator.language)}
    >
      <NotificationObserver onShown={reportNotification}>
        <div class="web-app">
          <Toaster onToastShown={reportNotification} />
          <Show
            when={missingSecureApi()}
            keyed
            fallback={
              <Show when={state.loaded}>
                <Show
                  keyed
                  when={state.account?.id}
                  fallback={
                    <Show
                      when={!useDirect}
                      fallback={<DirectLogin onLogin={directSignIn} initialUsername={DIRECT_HOST_USERNAME} />}
                    >
                      <Show
                        when={!languageWheelOpen()}
                        fallback={
                          <WebLanguageStep
                            variant={variant}
                            language={languagePreference.language()}
                            onChangeLanguage={languagePreference.setLanguage}
                            onDone={() => setLanguageWheelOpen(false)}
                          />
                        }
                      >
                        <AccountLogin
                          variant={variant}
                          language={resolveLocale(languagePreference.language(), navigator.language)}
                          onChangeLanguage={() => setLanguageWheelOpen(true)}
                          state={state.login}
                          onRetry={checkSession}
                          onRequestEmailCode={start}
                          onVerifyEmailCode={verify}
                          onOpenCompanySignIn={() =>
                            state.login.status === "company_sign_in"
                              ? openCompanySignIn(state.login.email)
                              : Promise.resolve()
                          }
                          onReset={async () => {
                            clearSession();
                            setState((draft) => {
                              draft.resendAt = 0;
                            });
                          }}
                          consent={
                            <Show when={!analyticsAgreed()}>
                              <AnalyticsConsentRow
                                class="web-consent-row"
                                checked={analyticsChoice()}
                                agents={consentAgents}
                                onChange={(checked) => {
                                  analyticsTouched = true;
                                  setAnalyticsChoice(checked);
                                }}
                              />
                            </Show>
                          }
                          notice={
                            <ConsentNotice
                              onOpenTerms={() => window.open("/terms", "_blank", "noopener")}
                              onOpenPrivacy={() => window.open("/privacy", "_blank", "noopener")}
                            />
                          }
                        />
                      </Show>
                    </Show>
                  }
                >
                  {(accountId) => (
                    <WebAppWorkspace
                      accountId={accountId}
                      account={state.account}
                      workspace={workspace()}
                      accountFetch={accountFetch}
                      onSessionCheck={checkSession}
                      accountSessionEnded={() => sessionEnded}
                      onLogout={logout}
                      createRuntime={props.createRuntime}
                      agentTemplateId={agentTemplateId()}
                      onAgentTemplateClose={() => setAgentTemplateId(null)}
                      inviteUrl={inviteUrl()}
                      onInviteClose={() => setInviteUrl(null)}
                      pluginSlug={pluginSlug()}
                      onPluginSlugConsumed={() => setPluginSlug(null)}
                      marketplaceListing={marketplaceListing()}
                      onMarketplaceListingConsumed={() => setMarketplaceListing(null)}
                      start={startLink()}
                      onStartConsumed={() => setStartLink(null)}
                      billingReturn={billingReturn()}
                      onBillingReturnConsumed={() => setBillingReturn(false)}
                      hostingReturn={hostingReturn()}
                      onHostingReturnConsumed={() => setHostingReturn(null)}
                      language={languagePreference.language()}
                      onChangeLanguage={languagePreference.setLanguage}
                      appearance={appearancePreference.appearance()}
                      onChangeAppearance={appearancePreference.setAppearance}
                    />
                  )}
                </Show>
              </Show>
            }
          >
            {(missing) => <InsecureContextNoticeWhen missing={missing} />}
          </Show>
          <Show when={loadingShown()}>
            <AppLoadingScreen
              ready={state.loaded}
              onExited={() => {
                setLoadingShown(false);
                void loadWorkspace().catch(() => undefined);
              }}
            />
          </Show>
        </div>
      </NotificationObserver>
    </StaticI18nProvider>
  );
}
