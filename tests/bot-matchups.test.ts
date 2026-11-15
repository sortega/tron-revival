import { describe, expect, it } from 'vitest';
import { BotController } from '../src/game/ai/BotController';
import { lineOfFire, stance, worthFiringAt } from '../src/game/ai/matchups';
import type { Fighter } from '../src/game/ai/matchups';
import { PixelGrid } from '../src/game/PixelGrid';
import { createRng } from '../src/game/rng';
import type { BotDifficulty } from '../src/types/game';
import { makeGame, place, skipCountdown } from './helpers';

const with_ = (weapon: string | null, satellites = 0): Fighter => ({ weapon, satellites });

describe('match-up table', () => {
  it('ranks the guns: Uzi and shotgun stop the Glock, range decides the rest', () => {
    expect(stance(with_('uzi'), with_('glock'))).toBe('seek');
    expect(stance(with_('glock'), with_('uzi'))).toBe('avoid');
    expect(stance(with_('shotgun'), with_('glock'))).toBe('seek');
    expect(stance(with_('glock'), with_('shotgun'))).toBe('avoid');
    expect(stance(with_('shotgun'), with_('uzi'))).toBe('seek');
    expect(stance(with_('uzi'), with_('shotgun'))).toBe('avoid');
    expect(stance(with_('rifle'), with_('shotgun'))).toBe('seek');
    expect(stance(with_('shotgun'), with_('rifle'))).toBe('avoid');
    expect(stance(with_('rifle'), with_('uzi'))).toBe('seek');
    expect(stance(with_('uzi'), with_('rifle'))).toBe('avoid');
    expect(stance(with_('glock'), with_('rifle'))).toBe('neutral');
    expect(stance(with_('rifle'), with_('rifle'))).toBe('neutral');
  });

  it('armed beats unarmed', () => {
    expect(stance(with_('glock'), with_(null))).toBe('seek');
    expect(stance(with_(null), with_('glock'))).toBe('avoid');
    expect(stance(with_(null), with_(null))).toBe('neutral');
    expect(stance(with_('turbo'), with_('lock_borders'))).toBe('neutral');
    expect(stance(with_('turbo'), with_('rifle'))).toBe('avoid');
  });

  it('only the H-bomb takes on satellites', () => {
    for (const weapon of [null, 'glock', 'rifle', 'uzi', 'turbo']) {
      expect(stance(with_(weapon), with_(null, 1)), String(weapon)).toBe('avoid');
    }
    expect(stance(with_('bomb'), with_('rifle', 3))).toBe('seek');
    expect(stance(with_('shotgun'), with_(null, 1))).toBe('neutral');
    expect(stance(with_('shotgun'), with_(null, 2))).toBe('avoid');
    // Having satellites oneself
    expect(stance(with_(null, 1), with_('rifle'))).toBe('seek');
    expect(stance(with_(null, 1), with_('bomb'))).toBe('avoid');
    expect(stance(with_('glock', 1), with_(null, 1))).toBe('avoid');
  });

  it('the H-bomb is to be avoided unless it can be shot down', () => {
    expect(stance(with_(null), with_('bomb'))).toBe('avoid');
    expect(stance(with_('glock'), with_('bomb'))).toBe('avoid');
    expect(stance(with_('rifle'), with_('bomb'))).toBe('neutral');
    expect(stance(with_('bomb'), with_('glock'))).toBe('seek');
  });

  it('knows which shots are wasted on satellites', () => {
    expect(worthFiringAt('glock', with_(null, 1))).toBe(false);
    expect(worthFiringAt('rifle', with_(null, 1))).toBe(false);
    expect(worthFiringAt('uzi', with_(null, 2))).toBe(false);
    expect(worthFiringAt('shotgun', with_(null, 1))).toBe(true);
    expect(worthFiringAt('shotgun', with_(null, 2))).toBe(false);
    expect(worthFiringAt('bomb', with_(null, 3))).toBe(true);
    expect(worthFiringAt('glock', with_('uzi'))).toBe(true);
  });

  it('gives every gun a line of fire', () => {
    for (const weapon of ['glock', 'rifle', 'shotgun', 'uzi', 'bomb']) expect(lineOfFire(weapon)).not.toBeNull();
    expect(lineOfFire('turbo')).toBeNull();
    expect(lineOfFire(null)).toBeNull();
    expect(lineOfFire('uzi')!.range).toBeLessThan(lineOfFire('shotgun')!.range);
    expect(lineOfFire('shotgun')!.range).toBeLessThan(lineOfFire('rifle')!.range);
  });
});

type Game = ReturnType<typeof makeGame>;

/** Bot in slot 0 at the centre heading right; enemy in slot 1, `dist` px ahead, heading away. */
function faceOff(dist = 150): Game {
  const g = makeGame(2, 1);
  g.setLevelObstacles(new PixelGrid());
  skipCountdown(g);
  g.items.length = 0;
  g.portals.length = 0;
  place(g, 0, 250, 300, 0);
  place(g, 1, 250 + dist, 300, 0);
  return g;
}

function giveSatellites(g: Game, slot: number, count: number): void {
  const bodyguards = g.getBodyguards() as unknown as Record<string, unknown>[];
  const p = g.players[slot]!;
  for (let i = 0; i < count; i++) {
    bodyguards.push({ id: 500 + slot * 10 + i, ownerSlot: slot, x: p.x + 30_000, y: p.y, phaseOffset: (360 / count) * i });
  }
}

/** Does the bot pull the trigger at any point in the next few decisions? */
function fires(g: Game, difficulty: BotDifficulty): boolean {
  const bot = new BotController(0, difficulty, createRng(1));
  for (let i = 0; i < 12; i++) if (bot.decide(g).action) return true;
  return false;
}

function goalOf(g: Game, difficulty: BotDifficulty): string | null {
  const bot = new BotController(0, difficulty, createRng(1));
  bot.decide(g);
  return bot.goalKind;
}

describe('bots and match-ups: firing', () => {
  it('shoot the Glock at an unguarded enemy but never at a guarded one', () => {
    for (const difficulty of ['normal', 'hard'] as const) {
      const open = faceOff();
      open.players[0]!.equipWeapon('glock', 20);
      expect(fires(open, difficulty)).toBe(true);

      const guarded = faceOff();
      guarded.players[0]!.equipWeapon('glock', 20);
      giveSatellites(guarded, 1, 1);
      expect(fires(guarded, difficulty)).toBe(false);
    }
  });

  it('hold the rifle against satellites, use the shotgun on a lone one', () => {
    const rifle = faceOff();
    rifle.players[0]!.equipWeapon('rifle', 200);
    giveSatellites(rifle, 1, 1);
    expect(fires(rifle, 'hard')).toBe(false);

    const shotgunOne = faceOff();
    shotgunOne.players[0]!.equipWeapon('shotgun', 20);
    giveSatellites(shotgunOne, 1, 1);
    expect(fires(shotgunOne, 'hard')).toBe(true);

    const shotgunTwo = faceOff();
    shotgunTwo.players[0]!.equipWeapon('shotgun', 20);
    giveSatellites(shotgunTwo, 1, 2);
    expect(fires(shotgunTwo, 'hard')).toBe(false);
  });

  it('launch the H-bomb at a guarded enemy', () => {
    const g = faceOff(180);
    g.players[0]!.equipWeapon('bomb', 1);
    giveSatellites(g, 1, 2);
    expect(fires(g, 'normal')).toBe(true);
  });

  it('shoot down a bullet coming their way with the Uzi', () => {
    const g = faceOff(400);            // The enemy itself is far out of Uzi range
    g.players[0]!.equipWeapon('uzi', undefined, 700);
    expect(fires(g, 'hard')).toBe(false);
    const projectiles = g.getProjectiles() as unknown as Record<string, unknown>[];
    projectiles.push({ id: 9000, x: 290_000, y: 300_000, direction: 180, ownerSlot: 1, speed: 5000, type: 'bullet', ownerCooldown: 0 });
    expect(fires(g, 'hard')).toBe(true);
    expect(fires(g, 'normal')).toBe(true);
  });

  it('easy bots know none of this', () => {
    const g = faceOff(400);
    g.players[0]!.equipWeapon('uzi', undefined, 700);
    const projectiles = g.getProjectiles() as unknown as Record<string, unknown>[];
    projectiles.push({ id: 9000, x: 290_000, y: 300_000, direction: 180, ownerSlot: 1, speed: 5000, type: 'bullet', ownerCooldown: 0 });
    expect(fires(g, 'easy')).toBe(false);
  });
});

describe('bots and match-ups: seeking and avoiding', () => {
  it('normal bots go after an enemy only with the upper hand', () => {
    const even = faceOff();
    expect(goalOf(even, 'normal')).toBeNull();

    const armed = faceOff();
    armed.players[0]!.equipWeapon('shotgun', 20);
    armed.players[1]!.equipWeapon('glock', 20);
    expect(goalOf(armed, 'normal')).toBe('seek');

    const escorted = faceOff();
    giveSatellites(escorted, 0, 1);
    expect(goalOf(escorted, 'normal')).toBe('seek');
  });

  it('hard bots hunt, except when at a disadvantage', () => {
    // (unarmed, only an enemy it can get ahead of - here one crossing in front - and not
    // one driving away from it: design/bots-territory.md)
    const crossing = faceOff();
    place(crossing, 1, 330, 150, 90);
    expect(goalOf(crossing, 'hard')).toBe('seek');
    expect(goalOf(faceOff(), 'hard')).toBeNull();

    const outgunned = faceOff();
    outgunned.players[1]!.equipWeapon('rifle', 200);
    expect(goalOf(outgunned, 'hard')).toBe('flee');

    const guarded = faceOff();
    guarded.players[0]!.equipWeapon('glock', 20);
    giveSatellites(guarded, 1, 1);
    expect(goalOf(guarded, 'hard')).toBe('flee');
  });

  it('a disadvantage far away is no reason to run', () => {
    const g = faceOff(300);
    g.players[1]!.equipWeapon('rifle', 200);
    expect(goalOf(g, 'hard')).toBeNull();
    expect(goalOf(g, 'normal')).toBeNull();
  });

  it('easy bots neither seek nor flee', () => {
    const g = faceOff();
    g.players[1]!.equipWeapon('rifle', 200);
    expect(goalOf(g, 'easy')).toBeNull();
  });

  it('a bot facing an armed enemy turns out of its line of fire', () => {
    // The enemy drives straight at the bot with a rifle; with nothing else around the
    // bot would go straight on
    const leavesLine = (difficulty: BotDifficulty): boolean => {
      const g = faceOff(200);
      place(g, 1, 450, 300, 180);
      g.players[1]!.equipWeapon('rifle', 200);
      const bot = new BotController(0, difficulty, createRng(1));
      for (let i = 0; i < 40 && g.phase === 'playing'; i++) {
        g.tick(new Map([[0, bot.decide(g)], [1, { steer: 0, action: false }]]));
        g.items.length = 0;
        g.serialize();
      }
      return Math.abs(g.players[0]!.y / 1000 - 300) > 15;
    };
    expect(leavesLine('hard')).toBe(true);
    expect(leavesLine('normal')).toBe(true);
    expect(leavesLine('easy')).toBe(false);
  });
});
