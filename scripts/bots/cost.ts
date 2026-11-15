// What a bot decision costs, with and without the territory map, on the same game states.
// See design/bots-territory.md ("Cost").
//
//   npm run bots:cost [-- --levels=blank,portals --ticks=8400 --tune=openCap:400]
//
// A match of three hard bots and a wandering "human" is played. Every tick, for every bot
// alive, "shadow" controllers of each profile decide on the very same state (their answer
// is thrown away), and each decision is timed. `npm run bench:sim` measures the real
// thing end to end, but its matches unfold differently once the bots behave differently
// (who is alive, for how long, where), which hides differences of this size.

import { performance } from 'node:perf_hooks';
import { BotController, BOT_PROFILES } from '../../src/game/ai/BotController';
import type { BotProfile } from '../../src/game/ai/BotController';
import { TerritoryMap, territoryOf, worldOf } from '../../src/game/ai/territory';
import { TUNING } from '../../src/game/ai/territorySense';
import { createRng } from '../../src/game/rng';
import { TronGameState } from '../../src/game/TronGameState';
import type { SlotIndex } from '../../src/types/lobby';
import type { TronInput } from '../../src/types/game';
import { loadLevelGrid, makePlayers } from '../../tests/helpers';

const args = new Map(process.argv.slice(2).map(a => {
  const i = a.indexOf('=');
  return i < 0 ? [a.replace(/^--/, ''), '1'] as const : [a.slice(2, i), a.slice(i + 1)] as const;
}));
for (const pair of (args.get('tune') ?? '').split(',').filter(Boolean)) {
  const [key, value] = pair.split(':');
  (TUNING as Record<string, number>)[key!] = Number(value);
}
const levels = (args.get('levels') ?? 'blank,bricks,selva,warzone,portals').split(',');
const ticks = Number(args.get('ticks') ?? 8400);

const PROFILES: Record<string, BotProfile> = {
  'easy': BOT_PROFILES.easy,
  'normal old': { ...BOT_PROFILES.normal, territory: null },
  'normal new': BOT_PROFILES.normal,
  'hard old': { ...BOT_PROFILES.hard, territory: null },
  'hard new': BOT_PROFILES.hard,
};
const names = Object.keys(PROFILES);

function stats(values: number[]): { mean: number; p50: number; p99: number; max: number } {
  const sorted = Float64Array.from(values).sort();
  const q = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  let sum = 0;
  for (const v of sorted) sum += v;
  return { mean: sum / Math.max(1, sorted.length), p50: q(0.5), p99: q(0.99), max: sorted[sorted.length - 1] ?? 0 };
}
const us = (ms: number): string => (ms * 1000).toFixed(0).padStart(6);

console.log(`Cost of a bot decision in µs (same states for every profile; ${ticks} ticks per level; 3 hard bots + a wanderer playing).`);
console.log('"3 bots" is the sum of three decisions of a tick plus, for the new bots, the map slice of that tick.');
console.log(`${'level'.padEnd(10)} ${'profile'.padEnd(11)}   mean    p50    p99    max | 3 bots: mean    p99    max`);

for (const level of levels) {
  const seed = 4242;
  const rng = createRng(seed);
  const game = new TronGameState(makePlayers(4), 'ffa', level, rng);
  game.setLevelObstacles(loadLevelGrid(level));
  const drivers = [1, 2, 3].map(slot => new BotController(slot as SlotIndex, 'hard', createRng(seed + slot)));
  const shadows = [1, 2, 3].map(slot =>
    names.map((name, k) => new BotController(slot as SlotIndex, PROFILES[name]!, createRng(seed * 31 + slot * 7 + k))));
  const perCall: number[][] = names.map(() => []);
  // The same, only for the states in which the new hard bot is filling its region
  const whileFilling: number[][] = names.map(() => []);
  const took = names.map(() => 0);
  const hardNew = names.indexOf('hard new');
  const perTick: number[][] = names.map(() => []);
  const mapMs: number[] = [];
  const inputs = new Map<SlotIndex, TronInput>();
  const wanderRng = createRng(seed + 99);
  let steer = 0;
  let measured = 0;

  for (let tick = 0; measured < ticks && tick < ticks * 6; tick++) {
    if (wanderRng() < 0.05) steer = Math.floor(wanderRng() * 3) - 1;
    inputs.set(0, { steer, action: tick % 20 === 0 });
    const playing = game.phase === 'playing';
    let mapCost = 0;
    if (playing) {
      // The slice of the map that the first bot of the tick would pay for
      const t0 = performance.now();
      territoryOf(game);
      mapCost = performance.now() - t0;
      mapMs.push(mapCost);
      const sums = names.map(() => 0);
      let alive = 0;
      shadows.forEach((set, b) => {
        if (!game.players[b + 1]!.alive) {
          for (const shadow of set) shadow.decide(game);   // (so that they reset for the next round)
          return;
        }
        alive++;
        // Rotate the order so that no profile always runs on a warm (or cold) cache
        for (let k = 0; k < set.length; k++) {
          const which = (k + tick) % set.length;
          const t = performance.now();
          set[which]!.decide(game);
          const dt = performance.now() - t;
          perCall[which]!.push(dt);
          took[which] = dt;
          sums[which] = sums[which]! + dt;
        }
        if (set[hardNew]!.sense?.filling) names.forEach((_, k) => whileFilling[k]!.push(took[k]!));
      });
      if (alive === 3) {
        names.forEach((name, k) => perTick[k]!.push(sums[k]! + (name.endsWith('new') ? mapCost : 0)));
        measured++;
      }
    }
    if (!playing) for (const set of shadows) for (const shadow of set) shadow.decide(game);
    drivers.forEach(d => inputs.set(d.slot, d.decide(game)));
    game.tick(inputs);
    game.serialize();
  }

  names.forEach((name, k) => {
    const call = stats(perCall[k]!);
    const three = stats(perTick[k]!);
    console.log(`${(k === 0 ? level : '').padEnd(10)} ${name.padEnd(11)} ${us(call.mean)} ${us(call.p50)} ${us(call.p99)} ${us(call.max)} |         ${us(three.mean)} ${us(three.p99)} ${us(three.max)}`);
  });
  if (whileFilling[0]!.length > 0) {
    const share = (100 * whileFilling[0]!.length / perCall[0]!.length).toFixed(0);
    for (const name of ['hard old', 'hard new']) {
      const call = stats(whileFilling[names.indexOf(name)]!);
      console.log(`${''.padEnd(10)} ${name.padEnd(11)} ${us(call.mean)} ${us(call.p50)} ${us(call.p99)} ${us(call.max)} |  while the new hard bot is filling (${share}% of decisions)`);
    }
  }
  const map = stats(mapMs);
  console.log(`${''.padEnd(10)} ${'map slice'.padEnd(11)} ${us(map.mean)} ${us(map.p50)} ${us(map.p99)} ${us(map.max)} |  (per tick, shared by all bots; ${perTick[0]!.length} ticks with 3 bots alive)`);
  // A full rebuild (what the first tick of a round pays), on the last state
  const fresh = new TerritoryMap();
  const world = worldOf(game);
  const full: number[] = [];
  for (let i = 0; i < 300; i++) {
    const t = performance.now();
    fresh.rebuild(world);
    full.push(performance.now() - t);
  }
  const rebuild = stats(full.slice(50));
  console.log(`${''.padEnd(10)} ${'map rebuild'.padEnd(11)} ${us(rebuild.mean)} ${us(rebuild.p50)} ${us(rebuild.p99)} ${us(rebuild.max)} |  (everything at once, regions included: once per round)`);
}
