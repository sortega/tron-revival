// Play strength of bot profiles against each other, with a classification of deaths.
// See design/bots-territory.md.
//
//   npm run bots:strength -- --drivers=hard,old-hard --levels=blank,bricks --rounds=80
//
//   --drivers=a,b[,c,d]   driver specs of tests/sim.ts (hard, old-hard, calm-normal, straight...)
//   --levels=...          level ids, or `split` (two closed halves: pure space filling)
//   --rounds=80           rounds per level; seats rotate every quarter of them
//   --seed=1  --max=120 (seconds per round)  --mode=team  --bare (no items, no portals)
//   --var=name:base:{json}   an experimental profile `var-name`: `base` with fields
//                            overridden (the `territory` object is merged)
//   --json=file           append one JSON line per level
//   --log-deaths          one line per death, with the arguments that replay it in bots:snapshots
//
// Deaths by crashing (trail, own-trail, level) are classified by the room the victim had:
//   open               600 cells or more to drive in a second before: a driving accident,
//                      a squeeze, a sudden cut-off
//   trapped-contested  had room six seconds before and lost it, with an enemy in the same
//                      region then: cut off, or drove into a pocket during a fight
//   trapped-alone      the same with no enemy able to reach its region: boxed itself in
//   ran-out-alone      had been confined for a while, alone: lost the endgame (or filled
//                      its region badly)
//   ran-out-contested  confined for a while together with an enemy
//
// `counts` (shown when not all zero): how often the bots of a profile shot at items and
// at H-bombs (`BotController.counts`), and `itemsShot`: items destroyed by shots, whoever
// fired them, per level.

import { appendFileSync } from 'node:fs';
import { BOT_PROFILES } from '../../src/game/ai/BotController';
import type { BotCounts, BotProfile } from '../../src/game/ai/BotController';
import { TerritoryMap, worldOf } from '../../src/game/ai/territory';
import { TUNING } from '../../src/game/ai/territorySense';
import { TICK_RATE } from '../../src/game/constants';
import { createRng } from '../../src/game/rng';
import type { BotDifficulty } from '../../src/types/game';
import type { GameMode } from '../../src/types/lobby';
import { PROFILE_VARIANTS, runMatch } from '../../tests/sim';
import type { DriverSpec } from '../../tests/sim';
import { scatterInHalves, splitArena } from './arenas';

const args = new Map(process.argv.slice(2).filter(a => !a.startsWith('--var=')).map(a => {
  const i = a.indexOf('=');
  return i < 0 ? [a.replace(/^--/, ''), '1'] as const : [a.slice(2, i), a.slice(i + 1)] as const;
}));
for (const a of process.argv.slice(2).filter(a => a.startsWith('--var='))) {
  const [name, base, ...json] = a.slice(6).split(':');
  const over = JSON.parse(json.join(':') || '{}') as Partial<BotProfile>;
  const profile = BOT_PROFILES[base as BotDifficulty];
  PROFILE_VARIANTS[name!] = {
    ...profile, ...over,
    territory: over.territory === null ? null : over.territory || profile.territory
      ? { roomCap: 400, foeWeight: 1, fills: false, riskWeight: 0, racesForItems: false, intercepts: false, expands: false, ...profile.territory, ...over.territory }
      : null,
  } as BotProfile;
}

// --tune=key:value,...   weights of src/game/ai/territorySense.ts
for (const pair of (args.get('tune') ?? '').split(',').filter(Boolean)) {
  const [key, value] = pair.split(':');
  (TUNING as Record<string, number>)[key!] = Number(value);
}

const drivers = (args.get('drivers') ?? 'hard,old-hard').split(',') as DriverSpec[];
const levels = (args.get('levels') ?? 'blank').split(',');
const rounds = Number(args.get('rounds') ?? 80);
const seed = Number(args.get('seed') ?? 1);
const maxRoundSeconds = Number(args.get('max') ?? 120);
const mode = (args.get('mode') ?? 'ffa') as GameMode;
const bare = args.has('bare');

interface Sample { tick: number; reach: number; shared: number }

const CRAMPED = 600;   // Cells: less than this is not much room (the bots' "plenty" is 400)

// What state was a player in before it crashed? From its room 1 s and 6 s earlier.
function classify(h: Sample[]): string {
  if (h.length === 0) return 'open';
  const late = h[Math.max(0, h.length - 8)]!;
  const early = h[Math.max(0, h.length - 43)]!;
  if (late.reach >= CRAMPED) return 'open';
  // Had room six seconds earlier and lost it, or had been confined for a while?
  const kind = early.reach >= CRAMPED && early.reach >= late.reach * 3 ? 'trapped' : 'ran-out';
  const who = (kind === 'trapped' ? early.shared : late.shared) === 0 ? 'alone' : 'contested';
  return `${kind}-${who}`;
}

interface Tally {
  rounds: number; wins: number; survival: number[]; early: number;
  causes: Record<string, number>;
  counts: Record<string, number>;
}

// A driver's own counters, whether it is a planner or a human-like bot around one
function countsOf(driver: unknown): BotCounts | null {
  const d = driver as { counts?: BotCounts; planner?: { counts?: BotCounts } };
  return d.counts ?? d.planner?.counts ?? null;
}

for (const level of levels) {
  const tally = new Map<string, Tally>();
  for (const d of new Set(drivers)) tally.set(d, { rounds: 0, wins: 0, survival: [], early: 0, causes: {}, counts: {} });
  let itemsShot = 0;
  let draws = 0;
  let timeouts = 0;
  const lengths: number[] = [];

  // Rotate the seats so that no profile keeps a starting corner
  const rotations = Math.min(drivers.length, 4);
  for (let rot = 0; rot < rotations; rot++) {
    const seats = drivers.map((_, i) => drivers[(i + rot) % drivers.length]!);
    const n = Math.floor(rounds / rotations) + (rot < rounds % rotations ? 1 : 0);
    if (n === 0) continue;

    // The state of every player a second before the present, sampled every 10 ticks
    const map = new TerritoryMap();
    const history: Sample[][] = seats.map(() => []);
    const classes: (string | null)[] = seats.map(() => null);
    let currentRound = -1;
    const perRound: (string | null)[][] = [];
    const scatter = createRng(seed * 7919 + rot);
    let bots: unknown[] = [];
    const shot = new Set<number>();
    const results = runMatch({
      inspect: (list) => { bots = list; },
      level: level === 'split' ? 'blank' : level, grid: level === 'split' ? splitArena() : undefined,
      drivers: seats, rounds: n, seed: seed * 100 + rot, mode, maxRoundSeconds, bare,
      setup: level === 'split' ? (game) => scatterInHalves(game, scatter) : undefined,
      observe(game, round, tick) {
        if (round !== currentRound) {
          currentRound = round;
          history.forEach(h => { h.length = 0; });
          classes.fill(null);
          perRound[round] = seats.map(() => null);
          shot.clear();
        }
        // Items destroyed by shots (a blast or a pick-up leaves their hit points alone)
        for (const item of game.items) {
          if (!item.active && item.hp <= 0 && !shot.has(item.id)) {
            shot.add(item.id);
            itemsShot++;
          }
        }
        game.players.forEach((p, i) => {
          if (!p.alive && classes[i] === null) {
            const h = history[i]!;
            classes[i] = classify(h);
            perRound[round]![i] = classes[i]!;
          }
        });
        if (tick % 10 === 0) {
          map.rebuild(worldOf(game));
          game.players.forEach((p, i) => {
            if (p.alive) history[i]!.push({ tick, reach: map.reach[p.slotIndex]!, shared: map.shared[p.slotIndex]! });
          });
        }
      },
    });

    seats.forEach((spec, i) => {
      const counts = countsOf(bots[i]);
      const t = tally.get(spec)!;
      for (const [key, n] of Object.entries(counts ?? {})) t.counts[key] = (t.counts[key] ?? 0) + (n as number);
    });

    results.forEach((r, round) => {
      lengths.push(r.ticks);
      if (r.winner === 'draw') draws++;
      if (r.winner === null) timeouts++;
      seats.forEach((spec, i) => {
        const t = tally.get(spec)!;
        t.rounds++;
        // In team games a win is the team's
        const won = r.winner !== null && r.winner !== 'draw' &&
          (mode === 'team' ? r.winner % 2 === i % 2 : r.winner === i);
        if (won) t.wins++;
        const died = r.deathTick[i];
        t.survival.push(died ?? r.ticks);
        if (died !== null && died !== undefined) {
          if (died < 3 * TICK_RATE) t.early++;
          const cause = (r.deathCause[i] ?? 'unknown').split(' ')[0]!;
          const crash = cause === 'trail' || cause === 'own-trail' || cause === 'level';
          const key = crash ? `${cause}/${perRound[round]?.[i] ?? 'open'}` : cause;
          t.causes[key] = (t.causes[key] ?? 0) + 1;
          // --log-deaths: where to look with bots:snapshots (--rot, --round)
          if (args.has('log-deaths')) console.log(`    death ${spec} ${key} at ${(died / TICK_RATE).toFixed(1)}s: --level=${level} --seed=${seed} --rot=${rot} --round=${round + 1}`);
        }
      });
    });
  }

  const median = (v: number[]): number => v.length === 0 ? 0 : [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]!;
  const mean = (v: number[]): number => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
  const out = {
    level, mode, drivers, rounds, seed, bare, draws, timeouts, itemsShot,
    medianRound: +(median(lengths) / TICK_RATE).toFixed(1),
    profiles: Object.fromEntries([...tally].map(([spec, t]) => [spec, {
      seats: t.rounds,
      winPct: +(100 * t.wins / t.rounds).toFixed(1),
      medianSurvival: +(median(t.survival) / TICK_RATE).toFixed(1),
      meanSurvival: +(mean(t.survival) / TICK_RATE).toFixed(1),
      early: t.early,
      deaths: Object.fromEntries(Object.entries(t.causes).sort((a, b) => b[1] - a[1])),
      counts: t.counts,
    }])),
  };
  console.log(`${level.padEnd(12)} ${mode} ${drivers.join(',')} ${rounds} rounds, median ${out.medianRound}s, draws ${draws}, timeouts ${timeouts}`);
  for (const [spec, p] of Object.entries(out.profiles)) {
    console.log(`  ${spec.padEnd(16)} win ${String(p.winPct).padStart(5)}%  survival median ${String(p.medianSurvival).padStart(6)}s mean ${String(p.meanSurvival).padStart(6)}s  early ${p.early}  deaths ${JSON.stringify(p.deaths)}`);
    if (Object.values(p.counts).some(n => n > 0)) console.log(`  ${''.padEnd(16)} counts ${JSON.stringify(p.counts)}`);
  }
  if (itemsShot > 0) console.log(`  items destroyed by shots: ${itemsShot}`);
  if (args.has('summary')) console.log(`JSON ${JSON.stringify(out)}`);
  if (args.has('json')) appendFileSync(args.get('json')!, JSON.stringify(out) + '\n');
}
