// Pure steering maths for the touch controls. See design/touch-controls.md.

import { TURN_SPEED } from '../TronPlayer';

export type TouchMode = 'buttons' | 'heading' | 'swipe' | 'classic';

export const TOUCH_MODES: readonly TouchMode[] = ['buttons', 'heading', 'swipe', 'classic'];
export const TOUCH_MODE_LABELS: Record<TouchMode, string> = {
  buttons: 'BUTTONS',
  heading: 'POINT',
  swipe: 'SWIPE',
  classic: 'STICK',
};
export const DEFAULT_TOUCH_MODE: TouchMode = 'buttons';

/** Turn-steps over which the approach to a target heading is spread (avoids overshoot). */
export const HEADING_GAIN = 3;
/** `heading` mode: drags shorter than this do not change the target (px). */
export const HEADING_DEADZONE = 14;
/** `heading` mode: the stick centre follows the thumb beyond this distance (px). */
export const HEADING_RADIUS = 50;
/** `swipe` mode: degrees turned per pixel dragged. */
export const SWIPE_DEGREES_PER_PX = 1.2;
/** `swipe` mode: the target never gets further than this from the current heading. */
export const SWIPE_MAX_LEAD = 170;
/** `classic` mode: stick travel (px) and response curve. */
export const CLASSIC_TRAVEL = 45;
const CLASSIC_EXPONENT = 2.5;

/** Shortest signed angle from `from` to `to`, in (-180, 180]. */
export function angleDiff(from: number, to: number): number {
  const d = (((to - from) % 360) + 540) % 360 - 180;
  return d === -180 ? 180 : d;
}

/** Steer that turns `current` towards `target` at full rate, easing in at the end. */
export function steerTowards(current: number, target: number): number {
  const steer = angleDiff(current, target) / (TURN_SPEED * HEADING_GAIN);
  return Math.max(-1, Math.min(1, steer));
}

/** The original proportional stick: horizontal travel through a power curve. */
export function classicSteer(dx: number): number {
  const linear = Math.max(-1, Math.min(1, dx / CLASSIC_TRAVEL));
  return Math.sign(linear) * Math.pow(Math.abs(linear), CLASSIC_EXPONENT);
}
