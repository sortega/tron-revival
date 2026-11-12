// Guest-side movement prediction: replays inputs on top of an authoritative player
// state using the same movement rules as the host. See design/networking.md.

import type { TeleportPortal, TrailSegment, TronInput, TronPlayerState } from '../../types/game';
import { TronPlayer } from '../TronPlayer';
import { TELEPORT_COOLDOWN_FRAMES, findPortalExit, movePlayer, movesForTick, ownTurboBoost, teleportTo } from '../movement';

export interface PredictionResult {
  state: TronPlayerState;   // Predicted player state after the inputs
  trail: TrailSegment[];    // Pixels travelled while replaying (provisional trail)
}

// Reused scratch player (prediction runs every frame)
const scratch = new TronPlayer(0, 0, 0, 0, '', '');

/**
 * Advance `auth` by one tick per input. Collisions are not predicted: the host
 * decides who dies.
 */
export function predictPlayer(
  auth: TronPlayerState,
  inputs: readonly TronInput[],
  portals: readonly TeleportPortal[]
): PredictionResult {
  const trail: TrailSegment[] = [];
  if (!auth.alive || inputs.length === 0) return { state: auth, trail };

  const p = scratch;
  p.slotIndex = auth.slotIndex;
  p.color = auth.color;
  p.nickname = auth.nickname;
  p.updateFromState(auth);
  p.prevScreenX = -1;
  p.prevScreenY = -1;

  for (const input of inputs) {
    // Same order as TronGameState.tickPlaying
    if (p.teleportCooldown > 0) p.teleportCooldown--;

    const moves = movesForTick(p, auth.speed + ownTurboBoost(p, input));
    for (let i = 0; i < moves; i++) {
      for (const seg of movePlayer(p, input)) trail.push(seg);
    }

    if (p.teleportCooldown === 0) {
      const exit = findPortalExit(portals, p.getScreenX(), p.getScreenY());
      if (exit) {
        teleportTo(p, exit);
        p.teleportCooldown = TELEPORT_COOLDOWN_FRAMES;
      }
    }

    p.tickEffects();
    if (input.action && p.equippedWeapon?.remainingFrames !== undefined) p.tickWeapon();
    p.lastSteer = input.steer;
    p.lastAction = input.action;
  }

  return { state: { ...p.serialize(), speed: auth.speed }, trail };
}
