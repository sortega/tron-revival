// Headless benchmark of the simulation, bots and wire encoding in Node.
// See design/research/performance.md.
//
//   npm run bench:sim                      all scenarios, table on stdout
//   npm run bench:sim -- --only=bots       scenarios whose name contains "bots"
//   npm run bench:sim -- --json=out.json   also write the raw statistics
//   npm run bench:sim -- --ticks=8400      longer runs (default 4200 = 60 s of game)
//   npm run bench:fingerprint              hash of seeded matches: must not change
//                                          when an optimisation claims to be exact
//
// The scenarios drive a real HostSession (the object a phone hosting a game runs), with
// the phase timers of src/game/perf.ts.

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { PerformanceObserver, performance } from 'node:perf_hooks';
import v8 from 'node:v8';
import { HostSession } from '../../src/game/session/HostSession';
import { GuestSession } from '../../src/game/session/GuestSession';
import type { GuestTransport, HostTransport } from '../../src/game/session/GameSession';
import { perfDump, perfEnable } from '../../src/game/perf';
import { BOT_PROFILES } from '../../src/game/ai/BotController';
import { createRng } from '../../src/game/rng';
import type { Rng } from '../../src/game/rng';
import { TICK_MS } from '../../src/game/constants';
import { LEVELS } from '../../src/types/game';
import type { BotDifficulty, GameConfig, GamePlayer, TronGameStateData, TronInput } from '../../src/types/game';
import { FFA_COLORS } from '../../src/types/lobby';
import type { SlotIndex } from '../../src/types/lobby';
import type { TronGameState } from '../../src/game/TronGameState';
import { loadLevelGrid } from '../../tests/helpers';

type Kind = 'human' | BotDifficulty;

interface Scenario {
  name: string;
  players: Kind[];
  level: string;                 // Level id or 'cycle'
  network?: boolean;             // Host with a transport: also encodes every frame
  guest?: boolean;               // ...and a guest decoding them (timed as decode/predict)
  /** Runs before every tick; may poke the simulation to set a scene up. */
  script?: (game: TronGameState, tick: number, inputs: Map<SlotIndex, TronInput>) => void;
}

// The simulation's private parts, for setting scenes up
interface GameInternals {
  megaBombImpact(x: number, y: number): void;
}

function makeConfig(s: Scenario): GameConfig {
  const players: GamePlayer[] = s.players.map((kind, i) => ({
    slotIndex: i as SlotIndex,
    nickname: `P${i}`,
    color: FFA_COLORS[i as SlotIndex],
    control: kind === 'human' ? { type: 'local', scheme: 'solo' } : { type: 'ai', difficulty: kind },
  }));
  return { players, gameMode: 'ffa', levelMode: s.level };
}

// A human who wanders: random steering, taps action now and then (which also readies up)
function wanderer(rng: Rng): (tick: number) => TronInput {
  let steer = 0;
  return (tick) => {
    if (rng() < 0.05) steer = Math.floor(rng() * 3) - 1;
    return { steer, action: tick % 20 === 0 };
  };
}

// Keep a scripted scene going: nobody stays dead, everybody drives along its own row
function keepAlive(game: TronGameState, rows = true): void {
  game.players.forEach((p, i) => {
    if (!p.alive) {
      p.alive = true;
      p.prevScreenX = -1;
      p.prevScreenY = -1;
    }
    if (rows) {
      p.direction = 0;
      p.y = (80 + i * 140) * 1000 + 500;
    }
  });
  game.items.length = 0;
}

const ALL_HUMAN: Kind[] = ['human', 'human', 'human', 'human'];

const SCENARIOS: Scenario[] = [
  { name: '2p-nobots-blank', players: ['human', 'human'], level: 'blank' },
  { name: '4p-nobots-cycle', players: ALL_HUMAN, level: 'cycle' },
  ...(['easy', 'normal', 'hard'] as const).flatMap((d): Scenario[] => [
    { name: `1bot-${d}`, players: ['human', d], level: 'cycle' },
    { name: `3bots-${d}`, players: ['human', d, d, d], level: 'cycle' },
  ]),
  { name: '4bots-hard', players: ['hard', 'hard', 'hard', 'hard'], level: 'cycle' },
  { name: '3bots-hard-portals', players: ['human', 'hard', 'hard', 'hard'], level: 'portals' },
  { name: '3bots-hard-warzone', players: ['human', 'hard', 'hard', 'hard'], level: 'warzone' },
  {
    name: 'heavy-uzi-4p', players: ALL_HUMAN, level: 'bricks',
    script: (game, _tick, inputs) => {
      keepAlive(game);
      for (const p of game.players) {
        p.equipWeapon('uzi', undefined, 1000);
        inputs.set(p.slotIndex, { steer: 0, action: true });
      }
    },
  },
  {
    name: 'heavy-rifle-shotgun-4p', players: ALL_HUMAN, level: 'bricks',
    script: (game, tick, inputs) => {
      keepAlive(game);
      game.players.forEach((p, i) => {
        if (i % 2 === 0) {
          p.equipWeapon('rifle', 500);
          inputs.set(p.slotIndex, { steer: 0, action: true });
        } else {
          p.equipWeapon('shotgun', 50);
          inputs.set(p.slotIndex, { steer: 0, action: tick % 6 < 3 });
        }
      });
    },
  },
  {
    name: 'heavy-hbombs-4p', players: ALL_HUMAN, level: 'bricks',
    script: (game, tick, inputs) => {
      keepAlive(game);
      for (const p of game.players) {
        p.equipWeapon('bomb', 50);
        // A new bomb every 30 ticks, staggered between players
        inputs.set(p.slotIndex, { steer: 0, action: (tick + p.slotIndex * 7) % 30 < 2 });
      }
    },
  },
  {
    name: 'heavy-megabomb', players: ALL_HUMAN, level: 'bricks',
    script: (game, tick, inputs) => {
      keepAlive(game);
      for (const p of game.players) inputs.set(p.slotIndex, { steer: 0, action: false });
      // The worst single event: a double-radius blast, once a second
      if (tick % 70 === 0) {
        (game as unknown as GameInternals).megaBombImpact(100 + (tick * 7) % 550, 100 + (tick * 3) % 400);
      }
    },
  },
  {
    name: 'heavy-satellites-12', players: ALL_HUMAN, level: 'blank',
    script: (game, tick, inputs) => {
      keepAlive(game);
      game.players.forEach((p, i) => {
        // Three satellites each (picked up on the first ticks), then rifle fire for them to block
        if (tick < 3) {
          game.items.push({ id: 9000 + tick * 4 + i, sprite: 'bodyguard_item', category: 'automatic', x: p.getScreenX(), y: p.getScreenY(), active: true, hp: 40 });
        }
        p.equipWeapon('rifle', 500);
        inputs.set(p.slotIndex, { steer: tick % 140 < 20 ? 1 : 0, action: true });
      });
    },
  },
  { name: 'net-host-3bots-hard', players: ['human', 'hard', 'hard', 'hard'], level: 'cycle', network: true, guest: true },
  {
    name: 'net-host-heavy-uzi', players: ALL_HUMAN, level: 'bricks', network: true, guest: true,
    script: (game, _tick, inputs) => {
      keepAlive(game);
      for (const p of game.players) {
        p.equipWeapon('uzi', undefined, 1000);
        inputs.set(p.slotIndex, { steer: 0, action: true });
      }
    },
  },
];

interface Stats { n: number; mean: number; p50: number; p95: number; p99: number; max: number }

function stats(values: number[]): Stats {
  if (values.length === 0) return { n: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = Float64Array.from(values).sort();
  const q = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
  let sum = 0;
  for (const v of sorted) sum += v;
  return { n: sorted.length, mean: sum / sorted.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: sorted[sorted.length - 1]! };
}

interface Result {
  scenario: string;
  ticks: number;
  phases: Record<string, Stats>;   // Milliseconds per tick
  total: Stats;                    // Sum of the host phases, per tick
  gc: { count: number; totalMs: number; maxMs: number };
  allocKbPerTick: number;
  wireBytesPerTick: number;
  /** Bot decisions that mattered (bot alive, round being played), and their mean cost in ms. */
  botTicks: number;
  botMs: number;
}

function buildSession(s: Scenario, seed: number): {
  session: HostSession; guest: GuestSession | null; wire: { bytes: number };
} {
  const wire = { bytes: 0 };
  let guestTransport: GuestTransport | null = null;
  const transport: HostTransport | undefined = s.network ? {
    onInput: null,
    broadcastState: (data) => {
      wire.bytes += data.length;
      guestTransport?.onState?.(data);
    },
    close: () => {},
  } : undefined;
  const config = makeConfig(s);
  const session = new HostSession(config, { rng: createRng(seed), transport, now: () => performance.now() });
  let guest: GuestSession | null = null;
  if (s.guest) {
    guestTransport = { sendInput: () => {}, onState: null, onHostDisconnected: null, close: () => {} };
    // A spectating guest: decodes and applies every frame
    guest = new GuestSession(guestTransport, null, config.players.map(p => ({ slotIndex: p.slotIndex, color: p.color, nickname: p.nickname })));
  }
  return { session, guest, wire };
}

async function run(s: Scenario, ticks: number, warmup: number, seed = 12345): Promise<Result> {
  const { session, guest, wire } = buildSession(s, seed);
  const game = session.game;
  const humans = s.players.map((kind, i) => kind === 'human' ? wanderer(createRng(seed + 1 + i)) : null);
  const inputs = new Map<SlotIndex, TronInput>();
  let loadedLevel = -1;

  const gc = { count: 0, totalMs: 0, maxMs: 0 };
  const record = (entries: { duration: number }[]): void => {
    for (const entry of entries) {
      gc.count++;
      gc.totalMs += entry.duration;
      gc.maxMs = Math.max(gc.maxMs, entry.duration);
    }
  };
  const observer = new PerformanceObserver((list) => record(list.getEntries()));

  const allocatedBytes = (): number => (v8.getHeapStatistics() as unknown as { total_allocated_bytes: number }).total_allocated_bytes;
  let allocatedAtStart = 0;
  let botTicks = 0;
  for (let tick = -warmup; tick < ticks; tick++) {
    if (tick === 0) {
      perfEnable();
      wire.bytes = 0;
      observer.observe({ entryTypes: ['gc'] });
      allocatedAtStart = allocatedBytes();
    }
    if (game.currentLevelIndex !== loadedLevel) {
      loadedLevel = game.currentLevelIndex;
      session.setLevelObstacles(loadedLevel, loadLevelGrid(LEVELS[loadedLevel]!.id));
    }
    humans.forEach((h, i) => { if (h) inputs.set(i as SlotIndex, h(tick + warmup)); });
    if (s.script && game.phase === 'playing') s.script(game, tick + warmup, inputs);
    if (tick >= 0 && game.phase === 'playing') {
      s.players.forEach((kind, i) => { if (kind !== 'human' && game.players[i]!.alive) botTicks++; });
    }
    session.step(inputs);
    guest?.getViewState();
  }
  const allocated = allocatedBytes() - allocatedAtStart;
  // GC entries are only delivered once the event loop turns
  await new Promise(resolve => setTimeout(resolve, 20));
  observer.disconnect();
  const dump = perfDump();

  const phases: Record<string, Stats> = {};
  for (const [phase, values] of Object.entries(dump.samples)) phases[phase] = stats(values);
  // Per-tick total of what the host does (the guest's phases are a different machine)
  const hostPhases = ['bots', 'sim', 'serialize', 'net'].filter(p => dump.samples[p]);
  const totals: number[] = [];
  for (let i = 0; i < ticks; i++) {
    let sum = 0;
    for (const p of hostPhases) sum += dump.samples[p]![i] ?? 0;
    totals.push(sum);
  }
  return {
    scenario: s.name, ticks, phases, total: stats(totals), gc,
    allocKbPerTick: allocated / ticks / 1024,
    wireBytesPerTick: wire.bytes / ticks,
    botTicks,
    botMs: botTicks > 0 ? (dump.samples['bots'] ?? []).reduce((a, b) => a + b, 0) / botTicks : 0,
  };
}

/**
 * Hashes of seeded bot matches, to prove that an optimisation changed nothing:
 *   state   what is simulated: players, projectiles, items... of every tick, and the
 *           final collision grid. Must never change.
 *   frames  the whole frame of every tick, one-shot events included (trail pixels,
 *           cleared areas, sounds). Changes only if the events are reported differently.
 *   wire    every packet a guest would receive.
 */
function fingerprint(): Record<string, string> {
  const out: Record<string, string> = {};
  const cases: { name: string; players: Kind[]; level: string; seed: number; ticks: number; script?: Scenario['script'] }[] = [
    { name: 'hard-normal-easy@bus', players: ['hard', 'normal', 'easy'], level: 'bus', seed: 77, ticks: 6000 },
    { name: '4hard@cycle', players: ['hard', 'hard', 'hard', 'hard'], level: 'cycle', seed: 3, ticks: 12000 },
    { name: 'normal-hard@portals', players: ['normal', 'hard'], level: 'portals', seed: 9, ticks: 6000 },
    { name: '3normal+human@warzone', players: ['human', 'normal', 'normal', 'normal'], level: 'warzone', seed: 21, ticks: 6000 },
    { name: 'hard-easy@dentistry', players: ['hard', 'easy'], level: 'dentistry', seed: 5, ticks: 6000 },
    // The scripted weapon scenes of the benchmark
    ...SCENARIOS.filter(s => s.script && !s.network).map(s => ({
      name: s.name, players: s.players, level: s.level, seed: 31, ticks: 2100, script: s.script,
    })),
  ];
  for (const c of cases) {
    const hash = createHash('sha256');
    const stateHash = createHash('sha256');
    const wireHash = createHash('sha256');
    const transport: HostTransport = { onInput: null, broadcastState: (data) => { wireHash.update(data); }, close: () => {} };
    // A fixed clock: pongs and byte rates must not leak wall time into the wire hash
    const session = new HostSession(makeConfig({ ...c }), { rng: createRng(c.seed), transport, now: () => 0 });
    session.onFrame = (frame: TronGameStateData) => {
      hash.update(JSON.stringify(frame));
      stateHash.update(JSON.stringify([frame.round, frame.match, frame.deaths, frame.soundEvents]));
    };
    const game = session.game;
    const human = wanderer(createRng(c.seed + 1));
    const inputs = new Map<SlotIndex, TronInput>();
    let loadedLevel = -1;
    for (let tick = 0; tick < c.ticks; tick++) {
      if (game.currentLevelIndex !== loadedLevel) {
        loadedLevel = game.currentLevelIndex;
        session.setLevelObstacles(loadedLevel, loadLevelGrid(LEVELS[loadedLevel]!.id));
      }
      c.players.forEach((kind, i) => { if (kind === 'human') inputs.set(i as SlotIndex, human(tick)); });
      if (c.script && game.phase === 'playing') c.script(game, tick, inputs);
      session.step(inputs);
    }
    stateHash.update(JSON.stringify(game.pixels.toRuns()));
    out[c.name] = `state:${stateHash.digest('hex').slice(0, 16)} frames:${hash.digest('hex').slice(0, 16)} wire:${wireHash.digest('hex').slice(0, 16)} rounds:${game.currentRound}`;
  }
  return out;
}

function fmt(ms: number): string {
  return (ms * 1000).toFixed(ms < 0.01 ? 1 : 0).padStart(6);
}

async function main(): Promise<void> {
  const args = new Map(process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k!, v ?? '1'] as const;
  }));

  // `--no-territory`: the bots as they were before they read the territory map
  // (design/bots-territory.md). The fingerprint must then match the one from before.
  if (args.has('no-territory')) {
    for (const profile of Object.values(BOT_PROFILES)) profile.territory = null;
  }

  if (args.has('fingerprint')) {
    const prints = fingerprint();
    for (const [name, value] of Object.entries(prints)) console.log(`${name.padEnd(28)} ${value}`);
    if (args.has('json')) writeFileSync(args.get('json')!, JSON.stringify(prints, null, 2));
    return;
  }

  const ticks = Number(args.get('ticks') ?? 4200);
  const warmup = Number(args.get('warmup') ?? 1400);
  const only = args.get('only');
  const results: Result[] = [];
  console.log(`Simulation benchmark: ${ticks} ticks per scenario after ${warmup} warm-up ticks. Times in µs per tick; budget ${(TICK_MS * 1000).toFixed(0)} µs.`);
  console.log(`${'scenario'.padEnd(26)} ${'phase'.padEnd(10)}   mean    p50    p95    p99    max`);
  for (const s of SCENARIOS) {
    if (only && !s.name.includes(only)) continue;
    const r = await run(s, ticks, warmup);
    results.push(r);
    const rows: [string, Stats][] = [['TOTAL', r.total], ...Object.entries(r.phases).filter(([p]) => p !== 'events' || s.guest)];
    for (const [phase, st] of rows) {
      console.log(`${(phase === 'TOTAL' ? r.scenario : '').padEnd(26)} ${phase.padEnd(10)} ${fmt(st.mean)} ${fmt(st.p50)} ${fmt(st.p95)} ${fmt(st.p99)} ${fmt(st.max)}`);
    }
    console.log(`${''.padEnd(26)} gc: ${r.gc.count} pauses, ${r.gc.totalMs.toFixed(1)} ms total, max ${r.gc.maxMs.toFixed(2)} ms; ~${r.allocKbPerTick.toFixed(1)} KB allocated/tick` +
      (r.botTicks > 0 ? `; ${(r.botMs * 1000).toFixed(0)} µs per live bot per tick (${r.botTicks} bot-ticks)` : '') +
      (r.wireBytesPerTick > 0 ? `; wire ${r.wireBytesPerTick.toFixed(0)} B/tick (${(r.wireBytesPerTick * 70 / 1024).toFixed(1)} KB/s)` : ''));
  }
  if (args.has('json')) {
    writeFileSync(args.get('json')!, JSON.stringify({ node: process.version, ticks, warmup, results }, null, 2));
  }
}

void main();
