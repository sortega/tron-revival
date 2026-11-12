// Player movement rules shared by the authoritative simulation and by guest-side
// prediction, so that both produce exactly the same positions for the same inputs.

import type { TeleportPortal, TrailSegment, TronInput } from '../types/game';
import { PORTAL_OUTER_RADIUS, PORTAL_RADIUS } from '../types/game';
import type { TronPlayer } from './TronPlayer';

export const TELEPORT_COOLDOWN_FRAMES = 35;   // 0.5 seconds at 70fps

/**
 * How many pixel-steps a player takes this tick for a given speed factor.
 * factor >= 1: that many steps. factor < 1: one step every (2 - factor) ticks
 * (0 -> every 2nd tick, -1 -> every 3rd...), tracked in `player.moveFrameCounter`.
 */
export function movesForTick(player: TronPlayer, factor: number): number {
  if (factor >= 1) return factor;
  player.moveFrameCounter++;
  if (player.moveFrameCounter >= 2 - factor) {
    player.moveFrameCounter = 0;
    return 1;
  }
  return 0;
}

/** One pixel-step with an input, honouring Control Reversal. Returns the new trail pixels. */
export function movePlayer(player: TronPlayer, input: TronInput): TrailSegment[] {
  const steer = player.hasEffect('reverse') ? -input.steer : input.steer;
  return player.update(steer === input.steer ? input : { ...input, steer });
}

/** Centre of the portal end a player at (px, py) would come out of, or null. */
export function findPortalExit(
  portals: readonly TeleportPortal[], px: number, py: number
): { x: number; y: number } | null {
  for (const portal of portals) {
    if (Math.hypot(px - portal.x1, py - portal.y1) < PORTAL_RADIUS) return { x: portal.x2, y: portal.y2 };
    if (Math.hypot(px - portal.x2, py - portal.y2) < PORTAL_RADIUS) return { x: portal.x1, y: portal.y1 };
  }
  return null;
}

/** Move a player to the outer ring of the exit portal, keeping its heading. */
export function teleportTo(player: TronPlayer, exit: { x: number; y: number }): void {
  const dirRad = (player.direction * Math.PI) / 180;
  player.x = Math.floor((exit.x + Math.cos(dirRad) * PORTAL_OUTER_RADIUS) * 1000);
  player.y = Math.floor((exit.y + Math.sin(dirRad) * PORTAL_OUTER_RADIUS) * 1000);
}

/** Speed contribution of a player's own Turbo weapon while the action button is held. */
export function ownTurboBoost(player: TronPlayer, input: TronInput): number {
  return player.alive && input.action && player.equippedWeapon?.sprite === 'turbo' ? 1 : 0;
}
