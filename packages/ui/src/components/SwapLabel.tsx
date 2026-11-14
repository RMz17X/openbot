import { EASE_IN, EASE_OUT } from "@openbot/ui/spring-motion";
import { prefersReducedMotion } from "@openbot/ui/utils";
import { createEffect, untrack } from "solid-js";

const COUNT_LABEL = /^(\d+)(\D.*)$/;

/** No motion when the user asks for less, or where the page cannot animate an element (jsdom). */
function motionAllowed(element: HTMLElement): boolean {
  return "animate" in element && !prefersReducedMotion();
}

function fillLabel(target: HTMLElement, text: string): HTMLElement | undefined {
  const count = COUNT_LABEL.exec(text);
  if (!count) {
    target.replaceChildren(text);
    return undefined;
  }
  const digits = document.createElement("span");
  digits.className = "ui-swap-digits";
  digits.textContent = count[1] ?? "";
  target.replaceChildren(digits, count[2] ?? "");
  return digits;
}

/** How far the text slides, how much it shrinks, and for how long, in px and ms. */
export interface SwapMotion {
  distance: number;
  /** How much the text shrinks as it leaves. A blur would be redrawn on every frame. */
  shrink: number;
  enter: { duration: number; easing: string };
  leave: { duration: number; easing: string };
}

const DEFAULT_SWAP: SwapMotion = {
  distance: 20,
  shrink: 0.96,
  enter: { duration: 200, easing: EASE_OUT },
  leave: { duration: 140, easing: EASE_IN },
};

/**
 * A label that animates a change of its text. The box eases to the new width. A count rolls its
 * digits up or down; any other change slides the old text out and the new text in.
 * `from` is the text that a new label animates from, when it replaces an old one.
 */
export function SwapLabel(props: {
  text: string;
  from?: string | undefined;
  class?: string;
  motion?: SwapMotion;
  /** `auto` for a name the user wrote, so it keeps its own direction in a mirrored layout. */
  dir?: "auto";
}) {
  let box: HTMLSpanElement | undefined;
  let shown: HTMLSpanElement | undefined;
  let previous = untrack(() => props.from ?? props.text);
  createEffect(
    () => props.text,
    (text) => {
      if (!box || !shown || text === previous) return;
      const from = previous;
      previous = text;
      const startWidth = box.getBoundingClientRect().width;
      const fromCount = COUNT_LABEL.exec(from);
      const toCount = COUNT_LABEL.exec(text);
      const digits = fillLabel(shown, text);
      if (!motionAllowed(box)) return;
      box.animate([{ width: `${startWidth}px` }, { width: `${box.getBoundingClientRect().width}px` }], {
        duration: 240,
        easing: EASE_OUT,
      });
      const leaving = document.createElement("span");
      leaving.className = "ui-swap-leaving";
      // The old text is only a picture of the change; assistive technology reads the new text once.
      leaving.setAttribute("aria-hidden", "true");
      box.append(leaving);
      if (fromCount && toCount && digits && fromCount[2] === toCount[2]) {
        const direction = Number(toCount[1]) > Number(fromCount[1]) ? 1 : -1;
        leaving.textContent = fromCount[1] ?? "";
        const roll = { duration: 240, easing: EASE_OUT };
        digits.animate(
          [
            { opacity: 0, transform: `translateY(${direction * 0.7}em) scale(0.94)` },
            { opacity: 1, transform: "none" },
          ],
          roll,
        );
        leaving.animate(
          [
            { opacity: 1, transform: "none" },
            { opacity: 0, transform: `translateY(${-direction * 0.7}em) scale(0.94)` },
          ],
          { ...roll, fill: "forwards" },
        ).onfinish = () => leaving.remove();
        return;
      }
      leaving.textContent = from;
      const { distance, shrink, enter, leave } = props.motion ?? DEFAULT_SWAP;
      const away = { opacity: 0, transform: `translateX(${-distance}px) scale(${shrink})` };
      shown.animate([away, { opacity: 1, transform: "none" }], enter);
      leaving.animate([{ opacity: 1, transform: "none" }, away], {
        ...leave,
        fill: "forwards",
      }).onfinish = () => leaving.remove();
    },
  );
  return (
    <span ref={box} class={props.class ? `ui-swap ${props.class}` : "ui-swap"} dir={props.dir}>
      <span
        ref={(element) => {
          shown = element;
          fillLabel(element, previous);
        }}
      />
    </span>
  );
}
