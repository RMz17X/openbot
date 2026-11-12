import { AppLogo } from "@openbot/brand";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { ArrowRight, Button, CircleAlert, Eye, EyeOff, Input, Lock } from "@openbot/ui";
import { createSignal, Show } from "solid-js";
import { useText } from "../../text";

/**
 * The longest password the Team API accepts.
 *
 * `src/main/team-store.ts` `validatePassword` bounds a password between 12 and 256 characters, so
 * the field cannot carry more than that.
 */
const PASSWORD_LIMIT = 256;

export interface DirectLoginProps {
  /** The username the form starts with. */
  initialUsername?: string;
  /** Signs in against the Team API and keeps the session token in the browser tab. */
  onLogin: (username: string, password: string) => Promise<void>;
  /** True while a sign-in is in flight, so the form shows its busy state. */
  busy?: boolean;
}

/**
 * The sign-in screen of the direct mode.
 *
 * The direct mode talks to a local Team API instead of the cloud account service, so the sign-in
 * is a username and a password rather than an email code. The password never leaves the browser:
 * it is posted to the Team API and only the returned session token is kept, in the tab's
 * `sessionStorage`. No credential is part of the built bundle.
 */
export function DirectLogin(props: DirectLoginProps) {
  const { t } = useText();
  const [username, setUsername] = createSignal(props.initialUsername ?? "rickicode");
  const [password, setPassword] = createSignal("");
  const [passwordVisible, setPasswordVisible] = createSignal(false);
  const [submitting, setSubmitting] = createSignal(false);
  const [issue, setIssue] = createSignal<string | null>(null);

  const busy = () => submitting() || props.busy === true;

  async function submit(event: Event): Promise<void> {
    event.preventDefault();
    const user = username().trim();
    const secret = password();
    if (!user) {
      setIssue(t("webClient.directLogin.usernameRequired"));
      return;
    }
    if (!secret) {
      setIssue(t("webClient.directLogin.passwordRequired"));
      return;
    }
    setIssue(null);
    setSubmitting(true);
    try {
      await props.onLogin(user, secret);
    } catch (error: unknown) {
      setIssue(error instanceof Error && error.message ? error.message : t("webClient.directLogin.failed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div class="direct-login">
      <div class="direct-login-shell">
        <div class="direct-login-brand-lockup">
          <div class="direct-login-logo">
            <AppLogo variant="production" animation="blink" interactive />
          </div>
          <div class="direct-login-brand-text">
            <h1 class="direct-login-title">{t("webClient.directLogin.title")}</h1>
            <p class="direct-login-description">{t("webClient.directLogin.description")}</p>
          </div>
        </div>

        <Show when={issue()}>
          {(message) => (
            <p class="direct-login-error" role="alert">
              <CircleAlert class="direct-login-error-icon" />
              {message()}
            </p>
          )}
        </Show>

        <form
          class="direct-login-form"
          novalidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit(event);
          }}
        >
          <div class="direct-login-field">
            <label class="sr-only" for="direct-login-username">
              {t("webClient.directLogin.username")}
            </label>
            <Input
              id="direct-login-username"
              class="t-input"
              type="text"
              name="username"
              autocomplete="username"
              autocapitalize="none"
              spellcheck={false}
              maxlength={INPUT_LIMITS.identifier}
              value={username()}
              disabled={busy()}
              onValueChange={setUsername}
            />
          </div>

          <div class="direct-login-field direct-login-password">
            <label class="sr-only" for="direct-login-password">
              {t("webClient.directLogin.password")}
            </label>
            <Input
              id="direct-login-password"
              class="t-input"
              type={passwordVisible() ? "text" : "password"}
              name="password"
              autocomplete="current-password"
              maxlength={PASSWORD_LIMIT}
              value={password()}
              disabled={busy()}
              onValueChange={setPassword}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              class="direct-login-reveal"
              aria-label={
                passwordVisible() ? t("webClient.directLogin.hidePassword") : t("webClient.directLogin.showPassword")
              }
              onClick={() => setPasswordVisible(!passwordVisible())}
            >
              <Show when={passwordVisible()} fallback={<Eye />}>
                <EyeOff />
              </Show>
            </Button>
          </div>

          <Button type="submit" class="direct-login-submit" fullWidth disabled={busy()}>
            <Show when={busy()} fallback={t("webClient.directLogin.submit")}>
              {t("webClient.directLogin.connecting")}
            </Show>
            <ArrowRight class="direct-login-submit-icon" />
          </Button>
        </form>

        <p class="direct-login-note">
          <Lock class="direct-login-note-icon" />
          {t("webClient.directLogin.note")}
        </p>
      </div>
    </div>
  );
}
