// The dentist's hand (level "dentistry"). See design/level-hazards.md.
// A faithful port of PROCESS Mano: it wanders between the teeth and drills them.
// It never kills; it erases the pixel under the drill and hides what is beneath it.

import type { Rng } from './rng';

export interface HandDefinition {
  /** Places the hand may drill (the original map's control points 1-30). */
  targets: readonly { x: number; y: number }[];
}

/** What the view needs: the drill tip, in pixels (may be off-screen). */
export interface HandView {
  x: number;
  y: number;
}

export interface HandState extends HandView {
  target: number;   // 0 = resting, else 1-based index into `targets`
  rest: number;     // Ticks left before reconsidering
  aimX: number;
  aimY: number;
}

export const HAND_HOME = { x: 800, y: 600 };   // Off-screen, bottom right
export const HAND_SPEED = 6;                   // Pixels per tick
export const HAND_REST_TICKS = 100;
export const HAND_REACH = 4;                   // Drills when this close to its aim
/** Sprite size and where the drill tip is inside it. */
export const HAND_SPRITE = { width: 200, height: 250, tipX: 1, tipY: 17 };

export function createHand(): HandState {
  return { x: HAND_HOME.x, y: HAND_HOME.y, target: 0, rest: HAND_REST_TICKS, aimX: 0, aimY: 0 };
}

function randInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function advance(hand: HandState, toX: number, toY: number): void {
  const dx = toX - hand.x;
  const dy = toY - hand.y;
  const dist = Math.hypot(dx, dy);
  if (dist <= HAND_SPEED) {
    hand.x = toX;
    hand.y = toY;
    return;
  }
  hand.x = Math.round(hand.x + dx / dist * HAND_SPEED);
  hand.y = Math.round(hand.y + dy / dist * HAND_SPEED);
}

/**
 * Advance the hand one tick. Returns whether it is drilling; when it is, the pixel
 * under the tip (hand.x, hand.y) is to be erased.
 */
export function stepHand(hand: HandState, def: HandDefinition, rng: Rng): boolean {
  if (hand.rest <= 0) {
    // Half of the time it keeps its target (but aims afresh)
    if (rng() < 0.5) {
      hand.target = rng() < 0.5 ? 0 : randInt(rng, 1, def.targets.length);
    }
    hand.rest = HAND_REST_TICKS;
    const target = def.targets[hand.target - 1];
    if (target) {
      hand.aimX = target.x + randInt(rng, -20, 20);
      hand.aimY = target.y;
    }
  }

  if (hand.target === 0) {
    advance(hand, HAND_HOME.x, HAND_HOME.y);
    hand.rest--;
    return false;
  }
  if (Math.hypot(hand.aimX - hand.x, hand.aimY - hand.y) < HAND_REACH) {
    hand.rest--;
    hand.x += randInt(rng, -3, 3);
    hand.y += randInt(rng, -3, 3);
    return true;
  }
  advance(hand, hand.aimX, hand.aimY);
  return false;
}

/** Is pixel (x, y) under the hand's sprite? (The view makes the hand see-through then.) */
export function underHand(hand: HandView, x: number, y: number): boolean {
  const left = hand.x - HAND_SPRITE.tipX;
  const top = hand.y - HAND_SPRITE.tipY;
  return x >= left && x < left + HAND_SPRITE.width && y >= top && y < top + HAND_SPRITE.height;
}
