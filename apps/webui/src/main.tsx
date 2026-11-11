import { loadSavedLanguage, WebApp } from "@openbot/renderer-web";
import { render } from "@solidjs/web";
import "../../../src/renderer/src/features/web-client/web-client.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("The web client root element was not found.");
}

// The saved language loads with the code, so the first screen is not English for a moment. If it
// fails, the web client starts in English and tries again when it shows the language.
void loadSavedLanguage()
  .catch(() => undefined)
  .finally(() => {
    render(() => <WebApp />, root);
  });
