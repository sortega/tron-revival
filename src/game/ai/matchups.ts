// What beats what: the knowledge of weapons and satellites that normal and hard bots act
// on. Pure data and functions. See design/local-and-ai.md ("Match-ups").

export type Stance = 'seek' | 'avoid' | 'neutral';

/** What matters about a player in a fight: all of it visible on screen. */
export interface Fighter {
  weapon: string | null;
  satellites: number;
}

const GUNS = new Set(['glock', 'rifle', 'shotgun', 'uzi']);
const TRACER_WEAPONS = new Set(['rifle', 'shotgun', 'uzi']);

/** `winner` → the guns it beats. */
const BEATS: Record<string, readonly string[]> = {
  uzi: ['glock'],             // Its tracers stop bullets
  shotgun: ['glock', 'uzi'],  // Stops bullets; outranges the Uzi
  rifle: ['shotgun', 'uzi'],  // Outranges both
};

const isGun = (weapon: string | null): weapon is string => weapon !== null && GUNS.has(weapon);
export const firesTracers = (weapon: string | null): boolean => weapon !== null && TRACER_WEAPONS.has(weapon);

/** Should `me` go after `enemy`, keep away from it, or neither? */
export function stance(me: Fighter, enemy: Fighter): Stance {
  if (enemy.satellites > 0) {
    if (me.weapon === 'bomb') return 'seek';
    if (me.weapon === 'shotgun' && enemy.satellites === 1) return 'neutral';
    return 'avoid';
  }
  if (me.satellites > 0 && enemy.weapon !== 'bomb') return 'seek';
  if (enemy.weapon === 'bomb') return firesTracers(me.weapon) ? 'neutral' : 'avoid';
  if (me.weapon === 'bomb') return 'seek';
  if (isGun(me.weapon) && isGun(enemy.weapon)) {
    if (BEATS[me.weapon]?.includes(enemy.weapon)) return 'seek';
    if (BEATS[enemy.weapon]?.includes(me.weapon)) return 'avoid';
    return 'neutral';
  }
  if (isGun(me.weapon)) return 'seek';
  if (isGun(enemy.weapon)) return 'avoid';
  return 'neutral';
}

/** Can shooting `weapon` at this enemy achieve anything? */
export function worthFiringAt(weapon: string, enemy: Fighter): boolean {
  switch (weapon) {
    case 'glock':   // Bounces back off a satellite
    case 'rifle':   // Stopped every time
    case 'uzi':
      return enemy.satellites === 0;
    case 'shotgun': // Sustained fire gets past a lone satellite
      return enemy.satellites <= 1;
    default:
      return true;
  }
}

/** The cone in front of a player holding `weapon` that is best kept out of. */
export function lineOfFire(weapon: string | null): { range: number; halfAngle: number } | null {
  switch (weapon) {
    case 'glock': return { range: 300, halfAngle: 7 };
    case 'rifle': return { range: 400, halfAngle: 6 };
    case 'shotgun': return { range: 260, halfAngle: 9 };
    case 'uzi': return { range: 60, halfAngle: 32 };
    case 'bomb': return { range: 220, halfAngle: 12 };
    default: return null;
  }
}
