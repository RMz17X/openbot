import { createEffect, createSignal, onCleanup, Show, untrack } from "solid-js";
import { LoaderCircle } from "../../icons";
import { useText } from "../../text";

const EXIT_ANIMATION = "app-loading-exit";

export interface AppLoadingScreenProps {
  /** The app is ready: the screen fades out. Remove the screen in `onExited`. */
  ready?: boolean | undefined;
  onExited?: (() => void) | undefined;
  /** Heavy views can mount now. */
  onMountViews?: (() => void) | undefined;
  /** Kept for interface compatibility. */
  scene?: "pile" | "thinking";
  /** Kept for interface compatibility. */
  seed?: number;
  /** What the screen waits for, for a screen reader. */
  label?: string;
  /** The subtitle or status line. */
  title?: string;
  /** Kept for interface compatibility. */
  quickExit?: boolean;
  /** The stage shows at once. */
  immediate?: boolean;
}

export function AppLoadingScreen(props: AppLoadingScreenProps) {
  const { t } = useText();
  const [phase, setPhase] = createSignal<"loading" | "fade" | "exit">("loading");
  const [exited, setExited] = createSignal(false);
  let viewsMounted = false;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;

  function mountViews(): void {
    if (viewsMounted) return;
    viewsMounted = true;
    props.onMountViews?.();
  }

  function finishExit(): void {
    if (exited()) return;
    setExited(true);
    clearTimeout(exitTimer);
    mountViews();
    props.onExited?.();
  }

  onCleanup(() => {
    clearTimeout(exitTimer);
  });

  createEffect(
    () => props.ready,
    (ready) => {
      if (!ready || untrack(phase) !== "loading") return;
      mountViews();
      setPhase("fade");
      exitTimer = setTimeout(finishExit, 250);
    },
  );

  function handleAnimationEnd(event: AnimationEvent): void {
    if (event.animationName === EXIT_ANIMATION && event.target === event.currentTarget) {
      finishExit();
    }
  }

  function handleAnimationStart(event: AnimationEvent): void {
    if (event.animationName === EXIT_ANIMATION && event.target === event.currentTarget) {
      mountViews();
    }
  }

  return (
    <Show when={!exited()}>
      <main
        class="app-loading"
        data-phase={phase()}
        role="status"
        aria-live="polite"
        aria-busy={props.ready ? "false" : "true"}
        onAnimationStart={handleAnimationStart}
        onAnimationEnd={handleAnimationEnd}
      >
        <span class="sr-only">{props.label ?? t("webClient.loading")}</span>
        <div class="app-loading-stage">
          <div class="app-loading-spinner-wrap">
            <LoaderCircle class="app-loading-spinner" aria-hidden="true" />
          </div>
          <div class="app-loading-text">
            <span class="app-loading-title">{props.title ?? "OpenBot"}</span>
            <span class="app-loading-subtitle">{props.label ?? t("webClient.loading")}</span>
          </div>
        </div>
      </main>
    </Show>
  );
}
