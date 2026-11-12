// Guns painted on a level that fire shell bursts at random (level "warzone").
// See design/level-hazards.md.

export interface GunDefinition {
  /** Muzzle position. */
  x: number;
  y: number;
  /** Firing direction in screen degrees (0 = right, 90 = down). */
  direction: number;
}

/** Chance of a burst per playing tick (the original's `rand(0,200)==1`). */
export const GUN_BURST_CHANCE = 1 / 201;

const ZONE_RANGE = 220;
const ZONE_HALF_ANGLE = 7;

export function gunFromPoints(x: number, y: number, aimX: number, aimY: number): GunDefinition {
  return { x, y, direction: (Math.atan2(aimY - y, aimX - x) * 180 / Math.PI + 360) % 360 };
}

/** Is (x, y) where this gun's pellets usually fly? (Used by bots.) */
export function inFireZone(gun: GunDefinition, x: number, y: number): boolean {
  const dx = x - gun.x;
  const dy = y - gun.y;
  if (dx * dx + dy * dy > ZONE_RANGE * ZONE_RANGE) return false;
  const angle = Math.atan2(dy, dx) * 180 / Math.PI;
  const diff = Math.abs(((angle - gun.direction + 540) % 360) - 180);
  return diff <= ZONE_HALF_ANGLE;
}
