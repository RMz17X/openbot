/**
 * Lightweight SVG-only stub for @norbert_bodziony/bloub/plush in standalone WebUI.
 * Renders pure SVG BloubBot instead of downloading 30+ WebP sprite frame files
 * and running GPU canvas frame animation loops.
 */
import { BloubBot, type ExpressionId, type ShapeId } from "@norbert_bodziony/bloub";
import type { Component } from "solid-js";

export type PlushCharacterId = "nexo" | "vita" | "cloe" | "malu" | "yoshi" | "fred";
export type PlushShapeId =
  | "cercle"
  | "galet"
  | "squircle"
  | "capsule"
  | "triangle"
  | "hexagone"
  | "nuage"
  | "goutte"
  | "carre"
  | "losange"
  | "pentagone";
export type PlushState = "idle" | "wink" | "wide" | "thinking" | "notify" | "asleep" | "failed";
export interface PlushTransition {
  duration?: number;
  easing?: string;
}

export interface PlushBotProps {
  size?: number;
  shape?: ShapeId;
  color?: string;
  expression?: ExpressionId;
  state?: PlushState;
  frozenAt?: number;
  eyeScale?: number;
  ariaLabel?: string;
  class?: string;
  style?: string;
}

export const PlushBot: Component<PlushBotProps> = (props) => {
  const poseState = props.state === "thinking" || props.state === "notify" ? "idle" : (props.state ?? "idle");
  const shape = props.shape ?? "cercle";
  const frozen = props.frozenAt ?? 0;
  return (
    <BloubBot
      size={props.size ?? 100}
      shape={shape}
      color={props.color ?? "#ff5500"}
      expression={props.expression}
      state={poseState === "failed" || poseState === "asleep" ? "idle" : poseState}
      frozenAt={frozen}
      ariaLabel={props.ariaLabel ?? ""}
      class={props.class}
      style={props.style}
    />
  );
};

export const PLUSH_SHAPES: readonly PlushShapeId[] = [
  "cercle",
  "galet",
  "squircle",
  "capsule",
  "triangle",
  "hexagone",
  "nuage",
  "goutte",
  "carre",
  "losange",
  "pentagone",
];

export const PLUSH_STATES: readonly PlushState[] = ["idle", "wink", "wide", "thinking", "notify", "asleep", "failed"];

export const PLUSH_CHARACTERS: readonly unknown[] = [];
export const PLUSH_CHARACTER_BY_ID = new Map<PlushCharacterId, unknown>();
export const DEFAULT_TRANSITION = {};
export const PLUSH_TRANSITIONS = {};
export const tintRamp = () => ({});

export default PlushBot;
