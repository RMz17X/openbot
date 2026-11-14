/** A SwiftUI-style spring: `response` is the period in seconds, `dampingFraction` is from 0 to 1. */
export interface Spring {
  response: number;
  dampingFraction: number;
}

/**
 * The island springs, as the product island, the voice morph and the Library pill use them: the island
 * opens with a small overshoot and closes with none. The content comes and goes on its own, shorter spring.
 */
export const ISLAND_OPEN: Spring = { response: 0.5, dampingFraction: 0.8 };
export const ISLAND_CLOSE: Spring = { response: 0.45, dampingFraction: 1 };
export const ISLAND_CONTENT: Spring = { response: 0.34, dampingFraction: 0.88 };

/**
 * The ease-out curve for content that leaves the island, and the one every surface in the app
 * arrives with. It is the mirror of `--openbot-ease-spring` in the brand tokens.
 */
export const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";

/** The curve of content that leaves fast, so the exit reads before the surface is gone. */
export const EASE_IN = "cubic-bezier(0.4, 0, 1, 1)";

/**
 * The durations of the app in milliseconds, mirrored from `--openbot-duration-*` in the brand
 * tokens. A surface that appears or leaves runs at 150 to 200 milliseconds: long enough to be
 * read as motion, short enough that the reader never waits for it.
 */
export const DURATION_FAST = 120;
export const DURATION_MICRO = 150;
export const DURATION_DIALOG = 160;
export const DURATION_NORMAL = 160;
export const DURATION_PANEL = 180;
export const DURATION_SLOW = 180;
export const DURATION_OVERLAY = 180;
/** Content that swaps in place, such as a label or a menu that changes what it shows. */
export const DURATION_SWAP = 200;

/** The progress of a spring from 0 to 1 at `time` seconds. A damping fraction of 1 does not overshoot. */
export function springProgress(time: number, spring: Spring): number {
  const angularFrequency = (2 * Math.PI) / spring.response;
  const damping = spring.dampingFraction;
  if (damping === 1) {
    const phase = angularFrequency * time;
    return 1 - Math.exp(-phase) * (1 + phase);
  }

  const dampedFrequency = angularFrequency * Math.sqrt(1 - damping * damping);
  const envelope = Math.exp(-damping * angularFrequency * time);
  const phase = dampedFrequency * time;
  return 1 - envelope * (Math.cos(phase) + (damping * Math.sin(phase)) / Math.sqrt(1 - damping * damping));
}

/**
 * Samples one `response` of the spring into keyframes for a linear animation of that duration.
 * The progress is scaled so that the last sample is exactly 1.
 */
export function springKeyframes(spring: Spring, frame: (progress: number) => Keyframe, sampleCount = 32): Keyframe[] {
  const finalProgress = springProgress(spring.response, spring);
  return Array.from({ length: sampleCount + 1 }, (_, index) => {
    const offset = index / sampleCount;
    const rawProgress = springProgress(offset * spring.response, spring);
    const progress = index === sampleCount ? 1 : rawProgress / finalProgress;
    return { ...frame(progress), offset };
  });
}

/** The x scale of a computed `transform`: `none` or `matrix(...)`. Other values give 1. */
export function computedScale(transform: string): number {
  if (!transform || transform === "none") return 1;
  const match = transform.match(/^matrix\(([^,]+)/);
  const scale = Number.parseFloat(match?.[1] ?? "");
  return Number.isFinite(scale) ? scale : 1;
}
