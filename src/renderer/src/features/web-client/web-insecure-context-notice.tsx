/**
 * The sign-in screen of a page that cannot run where it is.
 *
 * The web client needs the Web Locks API and `crypto.randomUUID`, and a browser only has them in
 * a secure context. The public WebUI is served over HTTPS, so this screen appears only when the
 * operator opened the plain-HTTP LAN address. It names the address to use instead, so the page
 * does not stall on a connection that can never start.
 */
import { CircleAlert } from "@openbot/ui";
import { currentText } from "@openbot/ui/text";
import { Show } from "solid-js";
import { publicWebUiUrl } from "./web-secure-context";

export function InsecureContextNotice(props: { missing: "locks" | "randomUUID" }) {
  const text = currentText();
  const publicUrl = publicWebUiUrl();
  return (
    <div class="direct-login">
      <div class="direct-login-shell">
        <div class="direct-login-brand-text">
          <h1 class="direct-login-title">{text.t("webClient.error.insecureContext.title")}</h1>
          <p class="direct-login-description">{text.t("webClient.error.insecureContext.description")}</p>
        </div>

        <p class="direct-login-error" role="alert">
          <CircleAlert class="direct-login-error-icon" />
          {props.missing === "locks"
            ? text.t("webClient.error.insecureContext.missingLocks")
            : text.t("webClient.error.insecureContext.missingRandomUUID")}
        </p>

        <p class="direct-login-note">
          <a class="direct-login-public-link" href={publicUrl} target="_blank" rel="noreferrer noopener">
            {publicUrl}
          </a>
        </p>
      </div>
    </div>
  );
}

/** The notice, when the page may not run. Null when it may. */
export function InsecureContextNoticeWhen(props: { missing: "locks" | "randomUUID" | null }) {
  return (
    <Show when={props.missing} keyed>
      {(missing) => <InsecureContextNotice missing={missing} />}
    </Show>
  );
}
