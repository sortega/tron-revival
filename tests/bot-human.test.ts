// The humanisation layer of the bots, mechanism by mechanism (design/bots-human.md)
import { describe, expect, it } from 'vitest';
import { BotController } from '../src/game/ai/BotController';
import { HumanBot } from '../src/game/ai/HumanBot';
import { HUMAN_PROFILES, scaleProfile } from '../src/game/ai/humanProfiles';
import type { HumanProfile } from '../src/game/ai/humanProfiles';
import { Motor } from '../src/game/ai/motor';
import { aimSigma, Perception } from '../src/game/ai/perception';
import { PixelGrid } from '../src/game/PixelGrid';
import { createRng } from '../src/game/rng';
import type { BotDifficulty, GameItem, TronInput } from '../src/types/game';
import { inputs, loadLevelGrid, makeGame, place, skipCountdown } from './helpers';

type Game = ReturnType<typeof makeGame>;
const DIFFS: BotDifficulty[] = ['easy', 'normal', 'hard'];
const DEG = Math.PI / 180;

/** Empty arena: slot 0 in the middle heading right, slot 1 `dist` px ahead heading away. */
function arena(dist = 150, players = 2): Game {
  const g = makeGame(players, 1);
  g.setLevelObstacles(new PixelGrid());
  skipCountdown(g);
  g.items.length = 0;
  g.portals.length = 0;
  place(g, 0, 250, 300, 0);
  place(g, 1, 250 + dist, 300, 0);
  return g;
}

function step(g: Game, ...list: Partial<TronInput>[]): void {
  g.tick(inputs(...list));
  g.serialize();
  g.items.length = 0;   // Nothing spawns unless a test puts it there
}

function item(id: number, x: number, y: number, sprite = 'shield'): GameItem {
  return { id, sprite, category: 'automatic', x, y, active: true, hp: 100 };
}

const noAim = (p: HumanProfile): HumanProfile => ({ ...p, aimSigma: 0 });

describe('human bots: strength', () => {
  it('strength 0 is the old bot, input for input', () => {
    const run = (make: () => { decide(g: Game): TronInput }): string => {
      const g = makeGame(2, 5);
      g.setLevelObstacles(loadLevelGrid('bricks'));
      const bots = [make(), new BotController(1, 'normal', createRng(9))];
      const log: TronInput[] = [];
      for (let i = 0; i < 1200; i++) {
        const a = bots[0]!.decide(g);
        const b = bots[1]!.decide(g);
        log.push(a);
        g.tick(inputs(a, b));
        g.serialize();
      }
      return JSON.stringify(log);
    };
    const old = run(() => new BotController(0, 'hard', createRng(3)));
    expect(run(() => new HumanBot(0, 'hard', createRng(3), { strength: 0 }))).toBe(old);
    // ...and the layer does change something
    expect(run(() => new HumanBot(0, 'hard', createRng(3)))).not.toBe(old);
  });

  it('scales delays and errors', () => {
    const p = HUMAN_PROFILES.normal;
    const half = scaleProfile(p, 0.5);
    expect(half.trackDelay).toBe(Math.round(p.trackDelay / 2));
    expect(half.aimSigma).toBeCloseTo(p.aimSigma / 2);
    expect(half.surprise[1]).toBeCloseTo(p.surprise[1] / 2);
    expect(scaleProfile(p, 3).reverse.slip).toBe(1);
    expect(scaleProfile(p, 1)).toBe(p);
  });

  it('hard is the quickest and most precise, easy the slowest', () => {
    const { easy, normal, hard } = HUMAN_PROFILES;
    for (const key of ['trackDelay', 'aimSigma', 'minPress', 'panicDist'] as const) {
      expect(hard[key], key).toBeLessThanOrEqual(normal[key]);
      expect(normal[key], key).toBeLessThanOrEqual(easy[key]);
      expect(hard[key], key).toBeLessThan(easy[key]);
    }
    for (const key of ['surprise', 'fireHesitation', 'tapPeriod', 'disorient'] as const) {
      const mid = (r: readonly [number, number]): number => (r[0] + r[1]) / 2;
      expect(mid(hard[key]), key).toBeLessThan(mid(normal[key]));
      expect(mid(normal[key]), key).toBeLessThan(mid(easy[key]));
    }
    expect(hard.reverse.adapt).toBeLessThan(normal.reverse.adapt);
    expect(normal.reverse.adapt).toBeLessThan(easy.reverse.adapt);
    // "Still human": even hard needs 150-200 ms to follow an enemy
    expect(hard.trackDelay / 70).toBeGreaterThanOrEqual(0.15);
    expect(hard.trackDelay / 70).toBeLessThanOrEqual(0.2);
  });
});

describe('human bots: perception', () => {
  it('sees a turning enemy late: straight on until the delay has passed', () => {
    for (const d of DIFFS) {
      const profile = noAim(HUMAN_PROFILES[d]);
      const g = arena(150);
      const me = g.players[0]!;
      const eye = new Perception(0, profile, createRng(1));
      for (let i = 0; i < 40; i++) {
        eye.perceive(g, me, false, 0);
        step(g, {}, {});
      }
      // The enemy starts turning now
      const turnStart = g.players[1]!.direction;
      for (let i = 1; i <= profile.trackDelay + 10; i++) {
        step(g, {}, { steer: 1 });
        const world = eye.perceive(g, me, false, 0);
        const seen = world.players[1]!;
        const real = g.players[1]!;
        if (i < profile.trackDelay) {
          // Not seen turning yet: same heading, and on the straight line it was following
          expect(seen.direction, `${d} tick ${i}`).toBe(turnStart);
          expect(seen.y / 1000, `${d} tick ${i}`).toBeCloseTo(300, 3);
          expect(real.direction).not.toBe(turnStart);
        }
        if (i >= profile.trackDelay + 2) {
          expect(seen.direction, `${d} tick ${i}`).not.toBe(turnStart);
        }
      }
      // The planner's own view of the bot is not delayed
      expect(eye.perceive(g, me, false, 0).players[0]!.x).toBe(me.x);
    }
  });

  it('extrapolates an enemy going straight to where it really is', () => {
    const g = arena(150);
    const eye = new Perception(0, noAim(HUMAN_PROFILES.easy), createRng(1));
    for (let i = 0; i < 60; i++) {
      eye.perceive(g, g.players[0]!, false, 0);
      step(g, {}, {});
    }
    const seen = eye.perceive(g, g.players[0]!, false, 0).players[1]!;
    expect(seen.x / 1000).toBeCloseTo(g.players[1]!.x / 1000, 1);
    expect(seen.y / 1000).toBeCloseTo(g.players[1]!.y / 1000, 1);
  });

  it('notices a new item only after the surprise delay', () => {
    for (const d of DIFFS) {
      const profile = HUMAN_PROFILES[d];
      for (let seed = 1; seed <= 5; seed++) {
        const g = arena(300);
        const eye = new Perception(0, profile, createRng(seed));
        g.items.push(item(1, 100, 100));
        // Lying there at the start of the round: known
        expect(eye.perceive(g, g.players[0]!, false, 0).items.map(i => i.id)).toEqual([1]);
        for (let i = 0; i < 20; i++) eye.perceive(g, g.players[0]!, false, 0);
        g.items.push(item(2, 200, 100));
        let noticedAfter = -1;
        for (let i = 0; i <= profile.surprise[1] + 1 && noticedAfter < 0; i++) {
          if (eye.perceive(g, g.players[0]!, false, 0).items.some(x => x.id === 2)) noticedAfter = i;
        }
        expect(noticedAfter, d).toBeGreaterThanOrEqual(profile.surprise[0]);
        expect(noticedAfter, d).toBeLessThanOrEqual(profile.surprise[1]);
      }
    }
  });

  it('keeps believing in an item for a moment after it has gone', () => {
    const profile = HUMAN_PROFILES.normal;
    const g = arena(300);
    const eye = new Perception(0, profile, createRng(1));
    g.items.push(item(1, 100, 100));
    for (let i = 0; i < 5; i++) eye.perceive(g, g.players[0]!, false, 0);
    g.items.length = 0;
    for (let i = 0; i < profile.trackDelay; i++) {
      expect(eye.perceive(g, g.players[0]!, false, 0).items.map(x => x.id), `tick ${i}`).toEqual([1]);
    }
    expect(eye.perceive(g, g.players[0]!, false, 0).items).toEqual([]);
  });

  it('does not notice anything new while panicking', () => {
    const profile = HUMAN_PROFILES.hard;
    const g = arena(300);
    const eye = new Perception(0, profile, createRng(1));
    eye.perceive(g, g.players[0]!, false, 0);
    g.items.push(item(7, 200, 100));
    for (let i = 0; i < 200; i++) {
      expect(eye.perceive(g, g.players[0]!, true, 0).items).toEqual([]);
    }
    let seen = false;
    for (let i = 0; i <= profile.surprise[1] && !seen; i++) {
      seen = eye.perceive(g, g.players[0]!, false, 0).items.length === 1;
    }
    expect(seen).toBe(true);
  });

  it('learns late that an enemy has picked up a gun, and sees shots late', () => {
    const profile = HUMAN_PROFILES.normal;
    const g = arena(150);
    const eye = new Perception(0, profile, createRng(2));
    for (let i = 0; i < 5; i++) eye.perceive(g, g.players[0]!, false, 0);
    g.players[1]!.equipWeapon('glock', 20);
    const shots = g.getProjectiles() as unknown as Record<string, unknown>[];
    shots.push({ id: 900, x: 300_000, y: 300_000, direction: 180, ownerSlot: 1, speed: 0, type: 'bullet' });
    let weaponAt = -1;
    let shotAt = -1;
    for (let i = 0; i <= profile.surprise[1] + 1; i++) {
      const world = eye.perceive(g, g.players[0]!, false, 0);
      if (weaponAt < 0 && world.players[1]!.equippedWeapon?.sprite === 'glock') weaponAt = i;
      if (shotAt < 0 && world.getProjectiles().length === 1) shotAt = i;
    }
    for (const at of [weaponAt, shotAt]) {
      expect(at).toBeGreaterThanOrEqual(profile.surprise[0]);
      expect(at).toBeLessThanOrEqual(profile.surprise[1]);
    }
    // The real player is untouched by the bot's beliefs
    expect(g.players[1]!.equippedWeapon?.sprite).toBe('glock');
  });

  it('follows only as many enemies as its attention allows', () => {
    const g = arena(100, 4);
    place(g, 2, 250, 100, 0);   // Further away
    place(g, 3, 250, 520, 0);   // Furthest
    const eye = new Perception(0, noAim(HUMAN_PROFILES.easy), createRng(1));   // Attention: 1
    const me = g.players[0]!;
    for (let i = 0; i < 30; i++) {
      eye.perceive(g, me, false, 0);
      step(g, {}, {}, {}, {});
    }
    // Everybody turns; much later the bot still places the far ones on their old line.
    // (panic = no glances, so that the test does not depend on glance timing)
    for (let i = 0; i < 40; i++) {
      step(g, {}, { steer: 1 }, { steer: 1 }, { steer: 1 });
      eye.perceive(g, me, true, 0);
    }
    const world = eye.perceive(g, me, true, 0);
    expect(world.players[1]!.direction).not.toBe(0);
    expect(world.players[2]!.direction).toBe(0);
    expect(world.players[3]!.direction).toBe(0);
    // Without panic it glances at them eventually
    for (let i = 0; i < HUMAN_PROFILES.easy.glance[1] + 30; i++) eye.perceive(g, me, false, 0);
    expect(eye.perceive(g, me, false, 0).players[2]!.direction).not.toBe(0);
  });

  it('hides Control Reversal from the planner', () => {
    const g = arena(300);
    const me = g.players[0]!;
    me.activateEffect('reverse', 700);
    const world = new Perception(0, HUMAN_PROFILES.hard, createRng(1)).perceive(g, me, false, 0);
    expect(world.players[0]!.hasEffect('reverse')).toBe(false);
    expect(me.hasEffect('reverse')).toBe(true);
    me.activateEffect('shield', 700);
    expect(world.players[0]!.hasEffect('shield')).toBe(true);
  });
});

describe('human bots: aim', () => {
  // Standard deviation of the aim error against a motionless enemy `dist` px away
  function spread(profile: HumanProfile, dist: number, turning: number, seed = 1): { sd: number; mean: number; consistent: boolean } {
    const g = arena(dist);
    const me = g.players[0]!;
    const eye = new Perception(0, profile, createRng(seed));
    const errors: number[] = [];
    let consistent = true;
    for (let i = 0; i < 40_000; i++) {
      const seen = eye.perceive(g, me, false, turning).players[1]!;
      if (i % 4 !== 0) continue;
      const e = eye.perceived(1)!.aimError;
      errors.push(e);
      // The enemy is perceived where the error says: rotated around the bot
      const bearing = Math.atan2(seen.y - me.y, seen.x - me.x) / DEG;
      if (Math.abs(bearing - e) > 0.01) consistent = false;
    }
    const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
    const sd = Math.sqrt(errors.reduce((a, b) => a + (b - mean) ** 2, 0) / errors.length);
    return { sd, mean, consistent };
  }

  it('has the specified spread, growing with distance and with own turning', () => {
    for (const d of DIFFS) {
      const profile = HUMAN_PROFILES[d];
      const near = spread(profile, 100, 0);
      const far = spread(profile, 250, 0);
      expect(near.consistent).toBe(true);
      expect(Math.abs(near.mean), d).toBeLessThan(0.15 * near.sd);
      // (the error wanders slowly, so 10 000 samples are worth ~1 400 independent ones)
      expect(near.sd / aimSigma(profile.aimSigma, 100, 0, 0), d).toBeGreaterThan(0.9);
      expect(near.sd / aimSigma(profile.aimSigma, 100, 0, 0), d).toBeLessThan(1.1);
      expect(far.sd / aimSigma(profile.aimSigma, 250, 0, 0), d).toBeGreaterThan(0.9);
      expect(far.sd / aimSigma(profile.aimSigma, 250, 0, 0), d).toBeLessThan(1.1);
      expect(far.sd).toBeGreaterThan(near.sd * 1.25);
      const turning = spread(profile, 100, 1);
      expect(turning.sd / near.sd, d).toBeGreaterThan(1.4);
      expect(turning.sd / near.sd, d).toBeLessThan(1.8);
    }
    expect(aimSigma(2, 300, 0, 0)).toBeCloseTo(4);
    expect(aimSigma(2, 0, 1, 0)).toBeCloseTo(5);
    expect(aimSigma(2, 0, 0, 1)).toBeCloseTo(3.2);
  });

  it('is normally distributed and drifts rather than jumps', () => {
    const profile = HUMAN_PROFILES.normal;
    const g = arena(150);
    const eye = new Perception(0, profile, createRng(4));
    const errors: number[] = [];
    for (let i = 0; i < 80_000; i++) {
      eye.perceive(g, g.players[0]!, false, 0);
      if (i % 4 === 0) errors.push(eye.perceived(1)!.aimError);
    }
    const sigma = aimSigma(profile.aimSigma, 150, 0, 0);
    const within = (k: number): number => errors.filter(e => Math.abs(e) <= k * sigma).length / errors.length;
    expect(within(1)).toBeGreaterThan(0.64);
    expect(within(1)).toBeLessThan(0.72);
    expect(within(2)).toBeGreaterThan(0.93);
    expect(within(2)).toBeLessThan(0.97);
    // Consecutive values are close: a burst goes wide together
    let jumps = 0;
    for (let i = 1; i < errors.length; i++) jumps += Math.abs(errors[i]! - errors[i - 1]!);
    expect(jumps / errors.length).toBeLessThan(0.6 * sigma);
  });

  it('grows when the target sweeps across', () => {
    // Enemy crossing 80 px ahead, against the same enemy standing still
    const profile = HUMAN_PROFILES.normal;
    const g = arena(80);
    place(g, 1, 330, 200, 90);
    const eye = new Perception(0, profile, createRng(1));
    const me = g.players[0]!;
    // Only the enemy moves (the bot stays put): feed positions by hand
    const enemy = g.players[1]!;
    let sum = 0;
    let n = 0;
    for (let rep = 0; rep < 300; rep++) {
      enemy.y = 250_000;
      for (let i = 0; i < 100; i++) {
        enemy.y += 1000;
        eye.perceive(g, me, false, 0);
        if (i > 30 && i % 4 === 0) {
          sum += eye.perceived(1)!.aimError ** 2;
          n++;
        }
      }
    }
    const still = aimSigma(profile.aimSigma, 80, 0, 0);
    expect(Math.sqrt(sum / n)).toBeGreaterThan(1.4 * still);
  });
});

describe('human bots: steering keys', () => {
  it('lags within the specified range and never taps shorter than the minimum', () => {
    for (const d of DIFFS) {
      const profile = HUMAN_PROFILES[d];
      const lags = new Set<number>();
      for (let seed = 1; seed <= 60; seed++) {
        const motor = new Motor(profile, createRng(seed));
        for (let i = 0; i < 20; i++) expect(motor.steer(0, false, false)).toBe(0);
        let lag = -1;
        for (let i = 0; i < 20 && lag < 0; i++) {
          if (motor.steer(1, false, false) === 1) lag = i;
        }
        expect(lag, d).toBeGreaterThanOrEqual(profile.steerLag[0]);
        expect(lag, d).toBeLessThanOrEqual(profile.steerLag[1]);
        lags.add(lag);
      }
      expect(lags.size, d).toBe(profile.steerLag[1] - profile.steerLag[0] + 1);

      // A planner that twitches every tick: the keys cannot follow
      const motor = new Motor(profile, createRng(7));
      const rng = createRng(8);
      let run = 0;
      let last = 0;
      for (let i = 0; i < 5000; i++) {
        const key = motor.steer(Math.floor(rng() * 3) - 1, false, false);
        if (key !== last) {
          if (last !== 0) expect(run, d).toBeGreaterThanOrEqual(profile.minPress);
          run = 0;
          last = key;
        }
        run++;
      }
    }
  });

  it('holds a turn longer when panicking', () => {
    const profile = HUMAN_PROFILES.easy;
    const held = (panic: boolean): number => {
      let total = 0;
      for (let seed = 1; seed <= 200; seed++) {
        const motor = new Motor(profile, createRng(seed));
        for (let i = 0; i < 30; i++) motor.steer(1, false, panic);
        for (let i = 0; i < 30; i++) if (motor.steer(0, false, panic) !== 0) total++;
      }
      return total / 200;
    };
    expect(held(true)).toBeGreaterThan(held(false) + 0.3);
  });

  it('follows the planner faithfully when nothing is in the way', () => {
    // Long, deliberate turns come out with the same length on average (lag on both ends)
    const motor = new Motor(HUMAN_PROFILES.normal, createRng(3));
    let pressed = 0;
    for (let rep = 0; rep < 400; rep++) {
      for (let i = 0; i < 22; i++) if (motor.steer(1, false, false) !== 0) pressed++;
      for (let i = 0; i < 30; i++) if (motor.steer(0, false, false) !== 0) pressed++;
    }
    expect(pressed / 400).toBeGreaterThan(21);
    expect(pressed / 400).toBeLessThan(23);
  });
});

describe('human bots: changed controls', () => {
  // A planner that wants a 12-tick turn every 30 ticks, alternating sides, for `ticks`
  // ticks with Control Reversal on between `from` and `to`. Returns, per tick, whether
  // the bike turned against the intention.
  function drive(profile: HumanProfile, seed: number, ticks = 1900, from = 200, to = 900): { wrong: boolean[]; motor: Motor } {
    const motor = new Motor(profile, createRng(seed));
    const wrong: boolean[] = [];
    for (let t = 0; t < ticks; t++) {
      const clock = t + seed * 7;   // (so that the reversal does not always start mid-press)
      const side = Math.floor(clock / 30) % 2 === 0 ? 1 : -1;
      const intended = clock % 30 < 12 ? side : 0;
      const reversed = t >= from && t < to;
      const key = motor.steer(intended, reversed, false);
      const turn = reversed ? -key : key;
      // Wrong way: turning against what is (or, with the key lagging, has just been) wanted
      const wanted = side;
      wrong.push(turn !== 0 && turn === -wanted);
    }
    return { wrong, motor };
  }
  const count = (wrong: boolean[], from: number, to: number): number => wrong.slice(from, to).filter(Boolean).length;
  const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);
  const average = (profile: HumanProfile, from: number, to: number): number =>
    SEEDS.reduce((sum, seed) => sum + count(drive(profile, seed).wrong, from, to), 0) / SEEDS.length;

  it('never steers the wrong way with normal controls', () => {
    for (const d of DIFFS) expect(count(drive(HUMAN_PROFILES[d], 1, 1000, 5000, 5000).wrong, 0, 1000)).toBe(0);
  });

  it('steers the wrong way when the reversal starts, then recovers', () => {
    for (const d of DIFFS) {
      const profile = HUMAN_PROFILES[d];
      // Before noticing, every press goes the wrong way
      for (const seed of SEEDS) {
        const { wrong } = drive(profile, seed);
        expect(count(wrong, 0, 200), d).toBe(0);
        expect(count(wrong, 200, 200 + profile.reverse.notice[1] + 30), `${d} seed ${seed}`).toBeGreaterThan(0);
      }
      const firstTwoSeconds = average(profile, 200, 340);
      const lastTwoSeconds = average(profile, 760, 900);
      expect(firstTwoSeconds, d).toBeGreaterThan(5);
      expect(lastTwoSeconds, d).toBeLessThan(firstTwoSeconds * (d === 'easy' ? 0.8 : 0.25));
    }
    // Hard is fluent after two seconds; easy still slips at the end
    expect(average(HUMAN_PROFILES.hard, 340, 900)).toBeLessThan(3);
    expect(average(HUMAN_PROFILES.easy, 760, 900)).toBeGreaterThan(3);
  });

  it('adapts faster the better the player', () => {
    const total = (d: BotDifficulty): number => average(HUMAN_PROFILES[d], 200, 900);
    expect(total('hard')).toBeLessThan(total('normal') * 0.6);
    expect(total('normal')).toBeLessThan(total('easy') * 0.6);
  });

  it('is confused again, briefly, when the reversal ends', () => {
    for (const d of DIFFS) {
      const profile = HUMAN_PROFILES[d];
      const after = average(profile, 900, 1100);
      const onset = average(profile, 200, 400);
      expect(after, d).toBeGreaterThan(1);
      expect(after, d).toBeLessThan(onset * 0.7);
      // ...and it is over soon
      expect(average(profile, 1600, 1900), d).toBeLessThan(0.5);
    }
  });

  it('catches a slip and over-corrects', () => {
    // A slip is flipped after `catch` ticks; the corrected press then outlasts the intention
    const profile = HUMAN_PROFILES.easy;
    let caught = 0;
    let overshoot = 0;
    for (const seed of SEEDS) {
      const motor = new Motor(profile, createRng(seed));
      for (let t = 0; t < 100; t++) motor.steer(0, true, false);   // Reversal noticed, no key down
      const before = motor.stats.catches;
      let wrongTicks = 0;
      let t = 0;
      for (; t < 60; t++) {
        const key = motor.steer(1, true, false);   // Wants to go right: the right key is -1
        if (key === 1) wrongTicks++;
      }
      if (motor.stats.catches === before) continue;   // No slip this time
      caught++;
      expect(wrongTicks).toBeGreaterThanOrEqual(profile.reverse.catch[0]);
      expect(wrongTicks).toBeLessThanOrEqual(profile.reverse.catch[1]);
      // Release: held for lag + over-correction
      let held = 0;
      while (motor.steer(0, true, false) !== 0) held++;
      overshoot += held - profile.steerLag[1];
      expect(held).toBeGreaterThanOrEqual(Math.round(profile.reverse.overCorrect * wrongTicks));
    }
    expect(caught).toBeGreaterThan(SEEDS.length / 2);
    expect(overshoot / caught).toBeGreaterThan(profile.reverse.catch[0] * profile.reverse.overCorrect - 4);
  });

  it('a real bot under Control Reversal wobbles, and the planner does not compensate twice', () => {
    for (const d of DIFFS) {
      const g = makeGame(2, 3);
      g.setLevelObstacles(loadLevelGrid('bricks'));
      skipCountdown(g);
      const bot = new HumanBot(0, d, createRng(5));
      const me = g.players[0]!;
      let wrongAtFiveSeconds = 0;
      for (let t = 0; t < 1100 && me.alive; t++) {
        if (t === 60) me.activateEffect('reverse', 700);
        const input = bot.decide(g);
        g.tick(inputs(input, {}));
        g.serialize();
        g.items.length = 0;
        if (t === 410) wrongAtFiveSeconds = bot.motor!.stats.wrongTicks;
      }
      expect(bot.motor!.stats.wrongTicks, d).toBeGreaterThan(0);
      if (d === 'hard' && me.alive) {
        // Adapted: from the fifth second on, not a single tick the wrong way
        expect(bot.motor!.stats.wrongTicks, d).toBe(wrongAtFiveSeconds);
      }
    }
  });
});

describe('human bots: trigger', () => {
  it('hesitates before the first shot, then taps at a human rate', () => {
    for (const d of DIFFS) {
      const profile = HUMAN_PROFILES[d];
      for (let seed = 1; seed <= 20; seed++) {
        const motor = new Motor(profile, createRng(seed));
        const presses: number[] = [];
        let last = false;
        for (let t = 0; t < 400; t++) {
          motor.steer(0, false, false);
          // The planner: nothing for 50 ticks, then its metronome (4 ticks on, 4 off)
          const raw = t >= 50 && t % 8 < 4;
          const out = motor.trigger(raw, 'glock');
          if (out && !last) presses.push(t);
          last = out;
        }
        const first = presses[0]! - 50;   // The planner's first press is at tick 50
        expect(first, d).toBeGreaterThanOrEqual(profile.fireHesitation[0]);
        expect(first, d).toBeLessThanOrEqual(profile.fireHesitation[1]);
        for (let i = 1; i < presses.length; i++) {
          const gap = presses[i]! - presses[i - 1]!;
          expect(gap, d).toBeGreaterThanOrEqual(profile.tapPeriod[0]);
          expect(gap, d).toBeLessThanOrEqual(profile.tapPeriod[1]);
        }
        expect(presses.length).toBeGreaterThan(10);
      }
    }
  });

  it('holds hold-weapons, with a hesitation and a late release', () => {
    const profile = HUMAN_PROFILES.normal;
    const motor = new Motor(profile, createRng(2));
    const out: boolean[] = [];
    for (let t = 0; t < 200; t++) {
      motor.steer(0, false, false);
      out.push(motor.trigger(t >= 50 && t < 120, 'rifle'));
    }
    const first = out.indexOf(true);
    const last = out.lastIndexOf(true);
    expect(first - 50).toBeGreaterThanOrEqual(profile.fireHesitation[0]);
    expect(first - 50).toBeLessThanOrEqual(profile.fireHesitation[1]);
    expect(out.slice(first, last + 1).every(Boolean)).toBe(true);
    expect(last).toBeGreaterThanOrEqual(120);
    expect(last).toBeLessThanOrEqual(120 + profile.steerLag[1] + 2);
  });

  it('fires one late shot for a chance that lasted an instant', () => {
    for (const d of DIFFS) {
      for (let seed = 1; seed <= 20; seed++) {
        const motor = new Motor(HUMAN_PROFILES[d], createRng(seed));
        let presses = 0;
        let last = false;
        for (let t = 0; t < 100; t++) {
          motor.steer(0, false, false);
          const out = motor.trigger(t >= 20 && t < 24, 'glock');
          // Never before the hesitation is over
          if (out) expect(t, d).toBeGreaterThanOrEqual(20 + HUMAN_PROFILES[d].fireHesitation[0]);
          if (out && !last) presses++;
          last = out;
        }
        expect(presses, d).toBeLessThanOrEqual(1);
      }
    }
  });

  it('a real bot shoots later than the planner alone, and still shoots', () => {
    const firstShot = (make: (rng: () => number) => { decide(g: Game): TronInput }): number => {
      const g = arena(150);
      g.players[0]!.equipWeapon('glock', 20);
      const bot = make(createRng(1));
      for (let t = 0; t < 120; t++) {
        const input = bot.decide(g);
        if (input.action) return t;
        step(g, { ...input, action: false }, {});
      }
      return -1;
    };
    const planner = firstShot(rng => new BotController(0, 'normal', rng));
    const human = firstShot(rng => new HumanBot(0, 'normal', rng));
    expect(planner).toBeGreaterThanOrEqual(0);
    expect(human).toBeGreaterThanOrEqual(planner + HUMAN_PROFILES.normal.fireHesitation[0]);
  });
});

describe('human bots: disorientation', () => {
  it('freezes the keys after being swapped somewhere else', () => {
    for (const d of DIFFS) {
      const profile = HUMAN_PROFILES[d];
      const g = arena(300);
      const bot = new HumanBot(0, d, createRng(4));
      for (let t = 0; t < 30; t++) step(g, bot.decide(g), {});
      // Swap: suddenly near the top edge, heading for a wall of trail
      for (let x = 0; x < 750; x++) g.pixels.set(x, 80, '#ffffff');
      place(g, 0, 400, 140, 270);
      const key = bot.decide(g).steer;
      expect(bot.motor!.frozen, d).toBe(true);
      let frozenFor = 1;
      for (let t = 0; t < 80; t++) {
        step(g, { steer: 0 }, {});   // (keep it from actually moving: we only watch the keys)
        place(g, 0, 400, 140, 270);
        const input = bot.decide(g);
        if (input.steer !== key) break;
        frozenFor++;
      }
      expect(frozenFor, d).toBeGreaterThanOrEqual(profile.disorient[0]);
      expect(frozenFor, d).toBeLessThanOrEqual(profile.disorient[1] + profile.steerLag[1] + 2);
    }
  });
});
