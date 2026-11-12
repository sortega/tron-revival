// Headless match runner: plays seeded rounds between bots / baseline drivers and
// collects statistics. Used by bot regression tests and `npm run sim`.

import { BotController, BOT_PROFILES } from '../src/game/ai/BotController';
import { createRng } from '../src/game/rng';
import type { Rng } from '../src/game/rng';
import { TronGameState } from '../src/game/TronGameState';
import { TICK_RATE } from '../src/game/constants';
import type { GameMode, SlotIndex } from '../src/types/lobby';
import type { BotDifficulty, TronInput } from '../src/types/game';
import { loadLevelGrid, makePlayers } from './helpers';

// `calm-*`: same driving skill, but no hunting and no offensive weapon use. Used to
// measure how well a bot stays alive without the noise of combat.
export type DriverSpec = BotDifficulty | `calm-${BotDifficulty}` | 'straight' | 'random';

interface Driver {
  decide(game: TronGameState): TronInput;
}

function makeDriver(spec: DriverSpec, slot: SlotIndex, rng: Rng): Driver {
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
  if (spec.startsWith('calm-')) {
    const base = BOT_PROFILES[spec.slice(5) as BotDifficulty];
    return new BotController(slot, { ...base, hunts: false, weapons: 'panic' }, rng);
  }
  return new BotController(slot, spec as BotDifficulty, rng);
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
}

export function runMatch(opts: MatchOptions): RoundResult[] {
  const rng = createRng(opts.seed);
  const game = new TronGameState(makePlayers(opts.drivers.length, opts.mode), opts.mode ?? 'ffa', opts.level, rng);
  game.setLevelObstacles(loadLevelGrid(opts.level));
  const drivers = opts.drivers.map((spec, i) => makeDriver(spec, i as SlotIndex, createRng(opts.seed * 1000 + i)));
  const maxTicks = (opts.maxRoundSeconds ?? 240) * TICK_RATE;
  const inputs = new Map<SlotIndex, TronInput>();
  const results: RoundResult[] = [];

  for (let round = 0; round < opts.rounds; round++) {
    const startRound = game.currentRound;
    const deathTick: (number | null)[] = drivers.map(() => null);
    const deathCause: (string | null)[] = drivers.map(() => null);
    let ticks = 0;
    let finished = false;
    let guard = 0;

    while (game.currentRound === startRound) {
      drivers.forEach((d, i) => inputs.set(i as SlotIndex, d.decide(game)));
      const wasPlaying = game.phase === 'playing';
      game.tick(inputs);
      const frame = game.serialize();
      for (const d of frame.deaths ?? []) {
        const fx = game.players[d.slotIndex]!.activeEffects.map(e => e.sprite).join('+');
        deathCause[d.slotIndex] = d.cause + (fx ? ` [${fx}]` : '');
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
