// Human factors of a bot: how late it sees, how clumsily it presses, how badly it aims.
// See design/bots-human.md. Times are in simulation ticks (70 per second).

import type { BotDifficulty } from '../../types/game';
import type { Rng } from '../rng';

/** Uniform range [min, max] in ticks. */
export type Range = readonly [number, number];

export interface ReverseProfile {
  notice: Range;        // Ticks until the bot realises its controls have changed
  slip: number;         // Probability that a press uses the old mapping, right after noticing
  adapt: number;        // Time constant (ticks) with which that probability decays
  catch: Range;         // Ticks until a wrong-way press is noticed and flipped
  overCorrect: number;  // Extra hold after flipping, as a fraction of the wrong-way time
}

export interface HumanProfile {
  trackDelay: number;       // Latency of enemies being followed
  surprise: Range;          // Latency of unexpected events (new item, shot, weapon change)
  attention: number;        // Enemies followed continuously
  glance: Range;            // Interval between looks at the other enemies
  aimSigma: number;         // Base standard deviation of the aim error, degrees
  fireHesitation: Range;    // From wanting to fire to the first press
  tapPeriod: Range;         // Between presses of a single-shot weapon
  steerLag: Range;          // From a change of intention to the key
  minPress: number;         // Shortest key press
  sideMargin: number;       // Pixels the planner keeps clear on each side: it knows its hands
  headMargin: number;       // Extra pixels it keeps from enemy heads: it knows it sees them late
  panicDist: number;        // Free pixels ahead under which the bot panics
  panicOversteer: Range;    // Extra ticks a turn is held when panicking
  reverse: ReverseProfile;  // Control Reversal
  disorient: Range;         // Frozen after being swapped / teleported
}

export const HUMAN_PROFILES: Record<BotDifficulty, HumanProfile> = {
  easy: {
    trackDelay: 24, surprise: [35, 55], attention: 1, glance: [50, 90], aimSigma: 4,
    fireHesitation: [14, 30], tapPeriod: [13, 20], steerLag: [0, 2], minPress: 4, sideMargin: 2, headMargin: 10,
    panicDist: 28, panicOversteer: [0, 1],
    reverse: { notice: [40, 70], slip: 0.8, adapt: 300, catch: [12, 20], overCorrect: 0.6 },
    disorient: [30, 50],
  },
  normal: {
    trackDelay: 15, surprise: [22, 32], attention: 2, glance: [35, 60], aimSigma: 2,
    fireHesitation: [7, 14], tapPeriod: [10, 13], steerLag: [0, 2], minPress: 4, sideMargin: 2, headMargin: 7,
    panicDist: 20, panicOversteer: [0, 1],
    reverse: { notice: [22, 34], slip: 0.75, adapt: 150, catch: [10, 16], overCorrect: 0.6 },
    disorient: [18, 28],
  },
  hard: {
    trackDelay: 11, surprise: [16, 22], attention: 3, glance: [35, 60], aimSigma: 1.2,
    fireHesitation: [4, 9], tapPeriod: [8, 10], steerLag: [0, 1], minPress: 3, sideMargin: 1, headMargin: 5,
    panicDist: 14, panicOversteer: [0, 1],
    reverse: { notice: [14, 20], slip: 0.5, adapt: 50, catch: [7, 11], overCorrect: 0.3 },
    disorient: [10, 16],
  },
};

/** Default strength of the humanisation: 0 = the old perfect bots, 1 = as specified. */
export const BOT_HUMANISATION = 1;

/** The strength to use when nobody says otherwise: `?human=<number>` in the URL, or the default. */
export function defaultHumanisation(): number {
  if (typeof window !== 'undefined' && window.location) {
    const param = new URLSearchParams(window.location.search).get('human');
    const value = param === null ? NaN : Number(param);
    if (Number.isFinite(value) && value >= 0) return Math.min(value, 3);
  }
  return BOT_HUMANISATION;
}

function scaleRange(r: Range, s: number): Range {
  return [r[0] * s, r[1] * s];
}

/** A profile with every delay, jitter and error multiplied by `s` (probabilities clamped). */
export function scaleProfile(p: HumanProfile, s: number): HumanProfile {
  if (s === 1) return p;
  return {
    trackDelay: Math.round(p.trackDelay * s),
    surprise: scaleRange(p.surprise, s),
    attention: p.attention,
    glance: scaleRange(p.glance, s),
    aimSigma: p.aimSigma * s,
    fireHesitation: scaleRange(p.fireHesitation, s),
    tapPeriod: [8 + (p.tapPeriod[0] - 8) * s, 8 + (p.tapPeriod[1] - 8) * s],
    steerLag: scaleRange(p.steerLag, s),
    minPress: Math.max(1, Math.round(1 + (p.minPress - 1) * s)),
    sideMargin: Math.round(p.sideMargin * Math.min(s, 2)),
    headMargin: Math.round(p.headMargin * s),
    panicDist: p.panicDist,
    panicOversteer: scaleRange(p.panicOversteer, s),
    reverse: {
      notice: scaleRange(p.reverse.notice, s),
      slip: Math.min(1, p.reverse.slip * s),
      adapt: p.reverse.adapt * s,
      catch: scaleRange(p.reverse.catch, s),
      overCorrect: p.reverse.overCorrect * s,
    },
    disorient: scaleRange(p.disorient, s),
  };
}

/** Whole number of ticks drawn uniformly from a range. */
export function drawTicks(range: Range, rng: Rng): number {
  return Math.round(range[0] + (range[1] - range[0]) * rng());
}

/** Standard normal deviate from a uniform stream (Box-Muller). */
export function gaussian(rng: Rng): number {
  const u = 1 - rng(); // (0, 1]
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
