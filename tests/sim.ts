// Headless match runner: plays seeded rounds between bots / baseline drivers and
// collects statistics. Used by bot regression tests and `npm run sim`.

import { BotController, BOT_PROFILES } from '../src/game/ai/BotController';
import { HumanBot } from '../src/game/ai/HumanBot';
import { PLAY_HEIGHT, PLAY_WIDTH } from '../src/game/constants';
import { createRng } from '../src/game/rng';
import type { Rng } from '../src/game/rng';
import { TronGameState } from '../src/game/TronGameState';
import { TICK_RATE } from '../src/game/constants';
import type { GameMode, SlotIndex } from '../src/types/lobby';
import type { BotDifficulty, TronInput } from '../src/types/game';
import { loadLevelGrid, makePlayers } from './helpers';

// Driver specs are a difficulty with optional prefixes, e.g. `calm-normal`, `raw-hard`,
// `raw-calm-hard`, `h0.5-normal`:
// `calm-`: same driving skill, but no hunting and no offensive weapon use. Used to
//          measure how well a bot stays alive without the noise of combat.
// `naive-`: does not know the weapon match-ups.
// `raw-`: the planner alone, without the humanisation layer (design/bots-human.md).
// `h<strength>-`: humanisation strength (default 1).
export type DriverSpec = BotDifficulty | `${string}-${BotDifficulty}` | 'straight' | 'random';

export interface Driver {
  decide(game: TronGameState): TronInput;
}

export function makeDriver(spec: DriverSpec, slot: SlotIndex, rng: Rng): Driver {
  if (spec === 'straight' || spec === 'random') {
    let tick = 0;
    let steer = 0;
    return {
      decide(game) {
        tick++;
        if (spec === 'random' && rng() < 0.05) steer = Math.floor(rng() * 3) - 1;
        // Tap action to ready up between rounds
        const action = game.phase === 'waiting_ready' && !game.playersReady.has(slot) && tick % 20 === 0;
        return { steer, action };
      },
    };
  }
  const parts = spec.split('-');
  const difficulty = parts.pop() as BotDifficulty;
  let profile = BOT_PROFILES[difficulty];
  if (!profile) throw new Error(`Unknown driver ${spec}`);
  let raw = false;
  let strength: number | undefined;
  for (const part of parts) {
    if (part === 'raw') raw = true;
    else if (part === 'calm') profile = { ...profile, hunts: false, weapons: 'panic' };
    else if (part === 'naive') profile = { ...profile, knowsMatchups: false };
    else if (/^h[\d.]+$/.test(part)) strength = Number(part.slice(1));
    else throw new Error(`Unknown driver ${spec}`);
  }
  if (raw) return new BotController(slot, profile, rng);
  return new HumanBot(slot, difficulty, rng, { planner: profile, ...(strength !== undefined && { strength }) });
}

export interface RoundResult {
  ticks: number;                       // Length of the playing phase
  winner: SlotIndex | 'draw' | null;   // null = hit the tick limit
  deathTick: (number | null)[];        // Per player, in `drivers` order; null = survived
  deathCause: (string | null)[];       // Why each player died
}

export interface MatchOptions {
  level: string;
  drivers: DriverSpec[];
  rounds: number;
  seed: number;
  mode?: GameMode;
  maxRoundSeconds?: number;
  /** Called before every tick of the playing phase (`tick` counts from 0 each round). */
  during?: (game: TronGameState, tick: number) => void;
  /** Builds the drivers instead of `makeDriver` (experiments with custom profiles). */
  makeDriver?: (spec: DriverSpec, slot: SlotIndex, rng: Rng) => Driver;
  /** Filled in with details of how the drivers played, when given. */
  stats?: MatchStats;
}

/** How each driver played, accumulated over a match (indexes follow `drivers`). */
export interface MatchStats {
  playTicks: number[];                 // Ticks alive in the playing phase
  steerChanges: number[];              // Times the steering key changed state
  turnTicks: number[];                 // Ticks spent steering
  squeezeTicks: number[];              // Ticks with something within 2 px on both sides (and survived)
  pulls: Record<string, number>[];     // Per weapon: trigger pulls (ticks held, for hold weapons)
  kills: Record<string, number>[];     // Per weapon: enemies killed with it
  aimErrors: number[][];               // |heading - bearing to the target| at each aimed pull, degrees
  decideMs: number[];                  // Time spent deciding
  decideCalls: number[];
}

export function newStats(drivers: number): MatchStats {
  const zeros = () => Array.from({ length: drivers }, () => 0);
  return {
    playTicks: zeros(), steerChanges: zeros(), turnTicks: zeros(), squeezeTicks: zeros(),
    pulls: Array.from({ length: drivers }, () => ({})), kills: Array.from({ length: drivers }, () => ({})),
    aimErrors: Array.from({ length: drivers }, () => []), decideMs: zeros(), decideCalls: zeros(),
  };
}

const HELD = new Set(['rifle', 'uzi', 'turbo', 'slow']);
const AIMED: Record<string, number> = { glock: 300, shotgun: 220, rifle: 350, bomb: 400 };
const SHOT_CAUSES = new Set(['bullet', 'tracer', 'bomb']);

function wrapDelta(d: number, size: number): number {
  return d > size / 2 ? d - size : d < -size / 2 ? d + size : d;
}

// Record what driver `i` did this tick (before the simulation applies it)
function observe(stats: MatchStats, game: TronGameState, i: number, input: TronInput, prev: TronInput, lastFired: (string | null)[], squeezing: number[][]): void {
  const me = game.players[i]!;
  if (!me.alive) return;
  stats.playTicks[i]!++;
  if (input.steer !== prev.steer) stats.steerChanges[i]!++;
  if (input.steer !== 0) stats.turnTicks[i]!++;

  // Squeezing through: something close on the left and on the right
  const x = me.x / 1000;
  const y = me.y / 1000;
  const rad = (me.direction * Math.PI) / 180;
  const px = -Math.sin(rad);
  const py = Math.cos(rad);
  const near = (side: number): boolean => {
    for (let d = 1; d <= 2; d++) {
      if (game.pixels.hasWrapped(Math.floor(x + px * d * side), Math.floor(y + py * d * side))) return true;
    }
    return false;
  };
  // (counted only if the bot is still alive a moment later: crashing into a corner is
  // not threading a gap)
  const pending = squeezing[i] ??= [];
  while (pending.length > 0 && pending[0]! < stats.playTicks[i]! - 15) {
    pending.shift();
    stats.squeezeTicks[i]!++;
  }
  if (near(1) && near(-1)) pending.push(stats.playTicks[i]!);

  const weapon = me.equippedWeapon?.sprite;
  if (!weapon || !input.action) return;
  const held = HELD.has(weapon);
  if (!held && prev.action) return; // Not a rising edge
  stats.pulls[i]![weapon] = (stats.pulls[i]![weapon] ?? 0) + 1;
  lastFired[i] = weapon;
  const range = AIMED[weapon];
  if (range === undefined || prev.action) return;
  // Aimed at somebody? The nearest enemy roughly ahead and in range
  let best = Infinity;
  let error = 0;
  for (const p of game.players) {
    if (p === me || !p.alive) continue;
    const dx = wrapDelta(p.x / 1000 - x, PLAY_WIDTH);
    const dy = wrapDelta(p.y / 1000 - y, PLAY_HEIGHT);
    const dist = Math.hypot(dx, dy);
    const off = Math.abs(((Math.atan2(dy, dx) * 180 / Math.PI - me.direction + 540) % 360) - 180);
    if (dist <= range * 1.2 && off <= 30 && dist < best) {
      best = dist;
      error = off;
    }
  }
  if (best < Infinity) stats.aimErrors[i]!.push(error);
}

export function runMatch(opts: MatchOptions): RoundResult[] {
  const rng = createRng(opts.seed);
  const game = new TronGameState(makePlayers(opts.drivers.length, opts.mode), opts.mode ?? 'ffa', opts.level, rng);
  game.setLevelObstacles(loadLevelGrid(opts.level));
  const drivers = opts.drivers.map((spec, i) => (opts.makeDriver ?? makeDriver)(spec, i as SlotIndex, createRng(opts.seed * 1000 + i)));
  const maxTicks = (opts.maxRoundSeconds ?? 240) * TICK_RATE;
  const inputs = new Map<SlotIndex, TronInput>();
  const results: RoundResult[] = [];
  const stats = opts.stats;
  const prev: TronInput[] = drivers.map(() => ({ steer: 0, action: false }));
  const lastFired: (string | null)[] = drivers.map(() => null);
  const squeezing: number[][] = drivers.map(() => []);

  for (let round = 0; round < opts.rounds; round++) {
    const startRound = game.currentRound;
    const deathTick: (number | null)[] = drivers.map(() => null);
    const deathCause: (string | null)[] = drivers.map(() => null);
    let ticks = 0;
    let finished = false;
    let guard = 0;

    while (game.currentRound === startRound) {
      const wasPlaying = game.phase === 'playing';
      if (wasPlaying && !finished) opts.during?.(game, ticks);
      if (stats) {
        drivers.forEach((d, i) => {
          const t0 = performance.now();
          const input = d.decide(game);
          if (wasPlaying && game.players[i]!.alive) {
            stats.decideMs[i]! += performance.now() - t0;
            stats.decideCalls[i]!++;
            observe(stats, game, i, input, prev[i]!, lastFired, squeezing);
          }
          prev[i] = input;
          inputs.set(i as SlotIndex, input);
        });
      } else {
        drivers.forEach((d, i) => inputs.set(i as SlotIndex, d.decide(game)));
      }
      game.tick(inputs);
      const frame = game.serialize();
      for (const d of frame.deaths ?? []) {
        const fx = game.players[d.slotIndex]!.activeEffects.map(e => e.sprite).join('+');
        deathCause[d.slotIndex] = d.cause + (fx ? ` [${fx}]` : '');
        if (stats) squeezing[d.slotIndex]!.length = 0;
        if (stats && d.by !== undefined && d.by >= 0 && d.by !== d.slotIndex && SHOT_CAUSES.has(d.cause)) {
          const weapon = lastFired[d.by] ?? 'unknown';
          stats.kills[d.by]![weapon] = (stats.kills[d.by]![weapon] ?? 0) + 1;
        }
      }

      if (wasPlaying && !finished) {
        ticks++;
        game.players.forEach((p, i) => {
          if (!p.alive && deathTick[i] === null) deathTick[i] = ticks;
        });
        if (game.phase === 'waiting_ready') {
          finished = true;
          results.push({ ticks, winner: game.roundWinner, deathTick, deathCause });
        } else if (ticks >= maxTicks) {
          // Stalemate: stop the round by force
          finished = true;
          results.push({ ticks, winner: null, deathTick, deathCause });
          for (const p of game.players) p.kill();
        }
      }
      if (++guard > maxTicks + 5000) throw new Error('round never ended');
    }
  }
  return results;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** Survival ticks of player `index` in each round (round length if it survived). */
export function survival(results: RoundResult[], index: number): number[] {
  return results.map(r => r.deathTick[index] ?? r.ticks);
}

export function winRate(results: RoundResult[], index: number): number {
  return results.filter(r => r.winner === index).length / results.length;
}
