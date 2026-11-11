declare module "@openbot/renderer-web" {
  import type { JSX } from "@solidjs/web";
  export function WebApp(): JSX.Element;
  export function loadSavedLanguage(): Promise<void>;
}
