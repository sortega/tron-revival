import { describe, expect, it } from 'vitest';
import { BotController, BOT_PROFILES, holdDistance, safeDistance } from '../src/game/ai/BotController';
import type { BotProfile } from '../src/game/ai/BotController';
import { HumanBot } from '../src/game/ai/HumanBot';
import { lineOfFire, stance, worthFiringAt } from '../src/game/ai/matchups';
import type { Fighter } from '../src/game/ai/matchups';
import { PixelGrid } from '../src/game/PixelGrid';
import { createRng } from '../src/game/rng';
import type { BotDifficulty, GameItem } from '../src/types/game';
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

// --- Shooting items and H-bombs (design/bots-territory.md "Denying items",
// design/local-and-ai.md "Bombs in flight")

const RAD = Math.PI / 180;
const hardWith = (over: Partial<BotProfile>): BotProfile => ({ ...BOT_PROFILES.hard, ...over });

function shield(id: number, x: number, y: number, sprite = 'shield'): GameItem {
  return { id, sprite, category: 'automatic', x, y, active: true, hp: 40 };
}

/**
 * The bot (slot 0) at (250, 300) heading right; an item 180 px from it, `angle` degrees off
 * its heading; the enemy 90 px from the item, driving towards it: the enemy gets there
 * first. (The enemy is 250 px from the bot and out of every gun's cone: no fight at hand.)
 */
function itemRace(weapon: string | null = 'glock', ammo = 20, angle = 0): Game {
  const g = faceOff();
  const x = 250 + 180 * Math.cos(angle * RAD);
  const y = 300 + 180 * Math.sin(angle * RAD);
  place(g, 1, x + 90 * Math.cos((angle - 45) * RAD), y + 90 * Math.sin((angle - 45) * RAD), angle + 135);
  if (weapon) g.players[0]!.equipWeapon(weapon, ammo);
  g.items.push(shield(700, x, y));
  return g;
}

/** Does this profile pull the trigger in the next few decisions, and what is it after? */
function acts(g: Game, profile: BotProfile | BotDifficulty, decisions = 12): { fires: boolean; goal: string | null; bot: BotController } {
  const bot = new BotController(0, profile, createRng(1));
  let fired = false;
  for (let i = 0; i < decisions; i++) fired = bot.decide(g).action || fired;
  return { fires: fired, goal: bot.goalKind, bot };
}

/** Play `ticks` ticks: the bot decides (if there is one), the enemy drives straight on. Nothing new spawns. */
function play(g: Game, bot: BotController | HumanBot | null, ticks: number, each?: () => void): void {
  for (let t = 0; t < ticks && g.phase === 'playing'; t++) {
    const known = new Set(g.items);
    g.tick(new Map([[0, bot ? bot.decide(g) : { steer: 0, action: false }], [1, { steer: 0, action: false }]]));
    g.serialize();
    for (let i = g.items.length - 1; i >= 0; i--) if (!known.has(g.items[i]!)) g.items.splice(i, 1);
    each?.();
  }
}

// Of 10 seeded tries each, at least this many human-like hard bots destroy the item
// (measured: 10, 9, 10, 4, 10, 10; the rifle needs four of its tracers to hit)
const HUMAN_DENIES: Record<string, number> = {
  'glock 0': 9, 'glock 30': 7, 'rifle 0': 9, 'rifle 30': 2, 'shotgun 0': 9, 'shotgun 30': 8,
};

describe('hard bots shoot the items an enemy gets to first', () => {
  it('with the Glock, the rifle or the shotgun, when the item is in their sights', () => {
    for (const [weapon, ammo] of [['glock', 20], ['rifle', 200], ['shotgun', 20]] as const) {
      const shot = acts(itemRace(weapon, ammo), 'hard');
      expect(shot.fires, weapon).toBe(true);
      expect(shot.bot.counts.denyShots, weapon).toBe(1);
    }
    // Normal bots do not, nor a hard bot told not to
    expect(acts(itemRace(), 'normal').fires).toBe(false);
    expect(acts(itemRace(), hardWith({ deniesItems: 0 })).fires).toBe(false);
  });

  it('and the item is gone before the enemy is there', () => {
    // Nobody shoots: the enemy has the shield after 90 ticks
    const left = itemRace();
    play(left, null, 100);
    expect(left.players[1]!.activeEffects.map(e => e.sprite)).toEqual(['shield']);

    for (const [weapon, ammo] of [['glock', 20], ['rifle', 200], ['shotgun', 20]] as const) {
      const g = itemRace(weapon, ammo);
      const item = g.items[0]!;
      play(g, new BotController(0, 'hard', createRng(1)), 80);
      expect(item.active, weapon).toBe(false);
      expect(item.hp, weapon).toBeLessThanOrEqual(0);
      expect(g.players[1]!.activeEffects, weapon).toEqual([]);
      expect(g.players[0]!.alive, weapon).toBe(true);
    }
  });

  it('with human eyes and hands too, most of the time', () => {
    // (the item straight ahead, and 30 degrees to the side; the hands sweep across the
    // target rather than hold it, and the first shot comes after a hesitation)
    for (const [weapon, ammo] of [['glock', 20], ['rifle', 200], ['shotgun', 20]] as const) {
      for (const angle of [0, 30]) {
        let destroyed = 0;
        for (let seed = 1; seed <= 10; seed++) {
          const g = itemRace(weapon, ammo, angle);
          const item = g.items[0]!;
          play(g, new HumanBot(0, 'hard', createRng(seed)), 85);
          if (item.hp <= 0) destroyed++;
        }
        expect(destroyed, `${weapon} ${angle}`).toBeGreaterThanOrEqual(HUMAN_DENIES[`${weapon} ${angle}`]!);
      }
    }
  });

  it('not what they can get themselves, nor what no enemy can get to', () => {
    // The enemy is much further from the item than the bot: a race to win, not a shot
    const mine = itemRace();
    place(mine, 1, 430, 20, 90);
    mine.items[0]!.x = 380;
    const racing = acts(mine, 'hard');
    expect(racing.bot.counts.denyShots).toBe(0);
    expect(racing.goal).toBe('item');
    // The enemy is behind walls that close it off from the item
    const nobody = itemRace();
    place(nobody, 1, 430, 100, 0);
    for (let x = 0; x < 750; x++) {
      for (let y = 240; y < 243; y++) nobody.pixels.set(x, y, '#ffffff');
      for (let y = 360; y < 363; y++) nobody.pixels.set(x, y, '#ffffff');
    }
    expect(acts(nobody, 'hard').bot.counts.denyShots).toBe(0);
  });

  it('not without a clear shot, shots to spare, or a reason', () => {
    const wall = itemRace();
    for (let y = 280; y < 320; y++) wall.pixels.set(350, y, '#ffffff');
    const shots = (g: Game): number => acts(g, 'hard').bot.counts.denyShots;
    expect(shots(wall)).toBe(0);
    expect(shots(itemRace())).toBe(1);

    expect(shots(itemRace('glock', 6))).toBe(0);     // The last shots are for fights
    expect(shots(itemRace('rifle', 40))).toBe(0);
    expect(shots(itemRace('bomb', 1))).toBe(0);      // Too good for an item
    expect(shots(itemRace('uzi'))).toBe(0);          // Does not reach
    expect(shots(itemRace(null))).toBe(0);

    const bad = itemRace();                                            // They are welcome to it
    bad.items[0] = shield(700, 430, 300, 'reverse');
    expect(shots(bad)).toBe(0);

    const taken = itemRace();                                          // As good as picked up already
    place(taken, 1, 430, 275, 90);
    expect(shots(taken)).toBe(0);
  });

  it('turn to aim when there is nothing better to do, and only then', () => {
    // The item is 30 degrees off the bot's heading
    const turning = acts(itemRace('glock', 20, 30), 'hard', 1);
    expect(turning.goal).toBe('deny');
    expect(turning.fires).toBe(false);
    expect(turning.bot.counts.denyGoals).toBe(1);
    // ...and in play: it turns, shoots, and the item is gone
    for (const [weapon, ammo] of [['glock', 20], ['rifle', 200], ['shotgun', 20]] as const) {
      const g = itemRace(weapon, ammo, 30);
      const item = g.items[0]!;
      play(g, new BotController(0, 'hard', createRng(1)), 80);
      expect(item.hp, weapon).toBeLessThanOrEqual(0);
      expect(g.players[1]!.activeEffects, weapon).toEqual([]);
    }

    // Level 1 shoots only what comes into its sights
    expect(acts(itemRace('glock', 20, 30), hardWith({ deniesItems: 1 }), 1).goal).not.toBe('deny');
    // An enemy to fight close by comes first
    const fight = itemRace();
    place(fight, 1, 390, 180, 90);
    fight.items[0]!.x = 390;
    fight.items[0]!.y = 270;
    expect(acts(fight, 'hard', 1).goal).toBe('seek');
  });
});

function launchBomb(g: Game, x: number, y: number, direction: number, owner = 1): void {
  const projectiles = g.getProjectiles() as unknown as Record<string, unknown>[];
  projectiles.push({ id: 9100 + projectiles.length, x: x * 1000, y: y * 1000, direction, ownerSlot: owner, speed: 2000, type: 'bomb', ownerCooldown: 0 });
}

/** The bot at (250, 300) heading right, holding `weapon`; the enemy out of the way. */
function armed(weapon: string, ammo?: number): Game {
  const g = faceOff();
  place(g, 1, 100, 550, 180);
  g.players[0]!.equipWeapon(weapon, ammo, ammo === undefined ? 700 : undefined);
  return g;
}

/** ...and a bomb `dist` px ahead, coming straight at it. */
function bombAhead(dist: number, weapon: string, ammo?: number): Game {
  const g = armed(weapon, ammo);
  launchBomb(g, 250 + dist, 300, 180);
  return g;
}

/**
 * An enemy `dist` px away, `angle` degrees off the bot's heading, launches a bomb at where
 * the bot will be, then turns away. Does the bot (a hard planner with `over`) live?
 */
function survivesBomber(dist: number, angle: number, weapon: string, ammo: number, over: Partial<BotProfile>): boolean {
  const g = faceOff();
  const bx = 250 + dist * Math.cos(angle * RAD);
  const by = 300 + dist * Math.sin(angle * RAD);
  let t = dist / 2;
  for (let i = 0; i < 6; i++) t = Math.hypot(250 + t - bx, 300 - by) / 2;
  place(g, 1, bx, by, Math.round(Math.atan2(300 - by, 250 + t - bx) / RAD));
  g.players[1]!.equipWeapon('bomb', 1);
  g.players[0]!.equipWeapon(weapon, ammo);
  const bot = new BotController(0, hardWith(over), createRng(1));
  let seen = false;
  for (let k = 0; k < 260 && g.phase === 'playing'; k++) {
    g.tick(new Map([[0, bot.decide(g)], [1, { steer: k > 0 && k < 30 ? 1 : 0, action: k === 0 }]]));
    g.serialize();
    g.items.length = 0;
    const flying = g.getProjectiles().some(p => p.type === 'bomb');
    if (seen && !flying) break;
    seen ||= flying;
  }
  return g.players[0]!.alive;
}

describe('hard bots and H-bombs in flight', () => {
  it('know from how far a shot sets a bomb off out of reach', () => {
    // Rifle and Glock (5 px/tick): the bomb and the bot close 3 px per tick meanwhile
    expect(holdDistance(5)).toBeGreaterThan(90);
    expect(holdDistance(5)).toBeLessThan(100);
    expect(safeDistance(5)).toBeGreaterThan(130);
    expect(safeDistance(5)).toBeLessThan(150);
    expect(safeDistance(15)).toBeLessThan(safeDistance(5));
    expect(safeDistance(15)).toBeGreaterThan(95);
  });

  it('shoot at one coming straight at them, with the Glock too', () => {
    for (const [weapon, ammo] of [['glock', 20], ['rifle', 200], ['shotgun', 20]] as const) {
      const shot = acts(bombAhead(220, weapon, ammo), 'hard');
      expect(shot.fires, weapon).toBe(true);
      expect(shot.bot.counts.defuseShots, weapon).toBe(1);
      expect(shot.bot.counts.bombThreats, weapon).toBe(1);
    }
    // (normal bots do not use the Glock for it)
    expect(acts(bombAhead(220, 'glock', 20), 'normal').fires).toBe(false);
    expect(acts(bombAhead(220, 'rifle', 200), 'normal').fires).toBe(true);
  });

  it('hold their fire at a bomb that is too close, even with an enemy behind it', () => {
    for (const [weapon, ammo] of [['glock', 20], ['rifle', 200], ['shotgun', 20], ['uzi', undefined]] as const) {
      const dist = weapon === 'uzi' ? 45 : weapon === 'shotgun' ? 60 : 90;
      const g = bombAhead(dist, weapon, ammo);
      place(g, 1, 250 + dist + 15, 300, 0);    // An enemy right behind the bomb, in every gun's cone
      const held = acts(g, 'hard');
      expect(held.fires, weapon).toBe(false);
      expect(held.bot.counts.heldFire, weapon).toBe(1);
      // The same bot without the rule shoots, at the enemy
      const g0 = bombAhead(dist, weapon, ammo);
      place(g0, 1, 250 + dist + 15, 300, 0);
      expect(acts(g0, hardWith({ defusesBombs: 0 })).fires, weapon).toBe(true);
    }
  });

  it('leave alone a bomb that is not coming for them', () => {
    // Passing 120 px to the side
    const beside = armed('rifle', 200);
    launchBomb(beside, 470, 180, 180);
    const passing = acts(beside, 'hard');
    expect(passing.goal).not.toBe('defuse');
    expect(passing.bot.counts.bombThreats).toBe(0);

    // Aimed at where the bot is now, from 200 px to the side: by the time it gets there
    // the bot is 100 px on, and the bomb goes off on the trail far behind it
    const behind = armed('turbo');
    launchBomb(behind, 250, 100, 90);
    const bot = new BotController(0, 'hard', createRng(1));
    bot.decide(behind);
    expect(bot.counts.bombThreats).toBe(0);
    play(behind, bot, 120);
    expect(behind.players[0]!.alive).toBe(true);

    // Crossing well ahead of the bot, and gone before the bot gets there
    const crossing = armed('rifle', 200);
    launchBomb(crossing, 350, 200, 90);
    expect(acts(crossing, 'hard', 1).bot.counts.bombThreats).toBe(0);
  });

  it('turn to face one that is, when there is time, lead it, and set it off', () => {
    // From 30 degrees to the left, 260 px away, aimed at where the bot will be
    const oblique = (weapon: string, ammo: number): Game => {
      const g = armed(weapon, ammo);
      const bx = 250 + 260 * Math.cos(-30 * RAD);
      const by = 300 + 260 * Math.sin(-30 * RAD);
      launchBomb(g, bx, by, Math.atan2(300 - by, 330 - bx) / RAD);
      return g;
    };
    const facing = acts(oblique('rifle', 200), 'hard', 1);
    expect(facing.goal).toBe('defuse');
    expect(facing.bot.counts.bombThreats).toBe(1);
    expect(acts(oblique('rifle', 200), hardWith({ defusesBombs: 1 }), 1).goal).not.toBe('defuse');
    // With nothing that sets it off there is no point in facing it
    const unarmed = oblique('rifle', 200);
    unarmed.players[0]!.equipWeapon('turbo', undefined, 700);
    expect(acts(unarmed, 'hard', 1).goal).not.toBe('defuse');

    for (const [weapon, ammo] of [['rifle', 200], ['shotgun', 20], ['glock', 20]] as const) {
      const g = oblique(weapon, ammo);
      let blastAt = Infinity;
      play(g, new BotController(0, 'hard', createRng(1)), 130, () => {
        const bomb = g.getProjectiles().find(p => p.type === 'bomb');
        const me = g.players[0]!;
        if (bomb) blastAt = Math.hypot(bomb.x / 1000 - me.x / 1000, bomb.y / 1000 - me.y / 1000);
      });
      expect(g.getProjectiles().some(p => p.type === 'bomb'), weapon).toBe(false);
      expect(g.players[0]!.alive, weapon).toBe(true);
      expect(blastAt, weapon).toBeGreaterThan(60);
    }
  });

  it('do not try when the bomb is already too near to turn on', () => {
    const g = armed('rifle', 200);
    launchBomb(g, 310, 200, 90);     // 117 px away at 60 degrees, coming down just in front of the bot
    const late = acts(g, 'hard', 1);
    expect(late.bot.counts.bombThreats).toBe(1);
    expect(late.goal).not.toBe('defuse');
  });

  it('live through more bomb attacks than without all this', () => {
    // An enemy launches from 110 to 320 px, from eight directions (56 attacks per gun)
    const survivors = (weapon: string, ammo: number, over: Partial<BotProfile>): number => {
      let alive = 0;
      for (const dist of [110, 140, 170, 200, 240, 280, 320]) {
        for (const angle of [0, 20, -20, 45, -45, 90, -90, 150]) {
          if (survivesBomber(dist, angle, weapon, ammo, over)) alive++;
        }
      }
      return alive;
    };
    for (const [weapon, ammo] of [['rifle', 200], ['shotgun', 20], ['glock', 20]] as const) {
      const before = survivors(weapon, ammo, { defusesBombs: 0 });
      const after = survivors(weapon, ammo, { defusesBombs: 2 });
      expect(after, weapon).toBeGreaterThan(before);
      expect(after, weapon).toBeGreaterThanOrEqual(50);
    }
  }, 120_000);
});
