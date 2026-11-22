// What the game stream to a player is made of, in Node: bytes a second by part of the
// message, for a few scenes, and what general-purpose compression would save.
// See design/networking.md, "Wire format".
//
//   npm run bench:net                    all scenes
//   npm run bench:net -- --only=uzi      scenes whose name contains "uzi"
//   npm run bench:net -- --json=out.json also write the totals

import { writeFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { decode, encode } from '@msgpack/msgpack';
import { HostSession } from '../../src/game/session/HostSession';
import type { HostTransport } from '../../src/game/session/GameSession';
import { createRng } from '../../src/game/rng';
import type { Rng } from '../../src/game/rng';
import { TICK_RATE } from '../../src/game/constants';
import { LEVELS } from '../../src/types/game';
import type { BotDifficulty, GameConfig, TronInput } from '../../src/types/game';
import { FFA_COLORS } from '../../src/types/lobby';
import type { SlotIndex } from '../../src/types/lobby';
import type { TronGameState } from '../../src/game/TronGameState';
import { loadLevelGrid } from '../../tests/helpers';

type Kind = 'human' | BotDifficulty;

interface Scene {
  name: string;
  players: Kind[];
  level: string;
  script?: (game: TronGameState, tick: number, inputs: Map<SlotIndex, TronInput>) => void;
}

function wanderer(rng: Rng): (tick: number) => TronInput {
  let steer = 0;
  return (tick) => {
    if (rng() < 0.05) steer = Math.floor(rng() * 3) - 1;
    return { steer, action: tick % 20 === 0 };
  };
}

// Nobody stays dead, everybody drives along its own row
function keepAlive(game: TronGameState): void {
  game.players.forEach((p, i) => {
    if (!p.alive) {
      p.alive = true;
      p.prevScreenX = -1;
      p.prevScreenY = -1;
    }
    p.direction = 0;
    p.y = (80 + i * 140) * 1000 + 500;
  });
  game.items.length = 0;
}

const HUMANS: Kind[] = ['human', 'human', 'human', 'human'];
const armed = (weapon: string, who: (slot: number) => boolean, fire: (tick: number) => boolean): Scene['script'] =>
  (game, tick, inputs) => {
    keepAlive(game);
    for (const p of game.players) {
      if (!who(p.slotIndex)) continue;
      if (weapon === 'uzi') p.equipWeapon('uzi', undefined, 1000); else p.equipWeapon(weapon, 500);
      inputs.set(p.slotIndex, { steer: 0, action: fire(tick) });
    }
  };

const SCENES: Scene[] = [
  { name: 'quiet-2-humans', players: ['human', 'human'], level: 'blank' },
  { name: 'quiet-4-humans', players: HUMANS, level: 'cycle' },
  { name: 'human+3-hard-bots', players: ['human', 'hard', 'hard', 'hard'], level: 'cycle' },
  { name: 'rifle-1-of-4', players: HUMANS, level: 'bricks', script: armed('rifle', s => s === 0, () => true) },
  { name: 'shotgun-1-of-4', players: HUMANS, level: 'bricks', script: armed('shotgun', s => s === 0, t => t % 6 < 3) },
  { name: 'uzi-1-of-4', players: HUMANS, level: 'bricks', script: armed('uzi', s => s === 0, () => true) },
  { name: 'uzi-4-of-4', players: HUMANS, level: 'bricks', script: armed('uzi', () => true, () => true) },
];

const POSITIONAL = [
  'tick', 'phase', 'countdown', 'roundWinner', 'doorTick', 'players', 'trails', 'projectiles', 'explosions',
  'bodyguards', 'pongs', 'acks',
];

// Encoded size of a value as a member of a map with that key
const sizeOf = (key: string, value: unknown): number => encode({ [key]: value }, { ignoreUndefined: true }).length - 1;

interface Totals {
  messages: number;
  bytes: number;
  max: number;
  parts: Map<string, number>;
  deflate: number;        // Each message deflated by itself
  deflateDict: number;    // ...with the message before it as the dictionary
}

function run(scene: Scene, ticks: number, seed = 12345): Totals {
  const totals: Totals = { messages: 0, bytes: 0, max: 0, parts: new Map(), deflate: 0, deflateDict: 0 };
  let measuring = false;
  let previous: Uint8Array | null = null;
  const add = (part: string, bytes: number): void => { totals.parts.set(part, (totals.parts.get(part) ?? 0) + bytes); };
  const transport: HostTransport = {
    onInput: null,
    close: () => {},
    broadcastState: (data) => {
      if (measuring) {
        totals.messages++;
        totals.bytes += data.length;
        totals.max = Math.max(totals.max, data.length);
        // The positional part of a frame (PackedGameState in network/serialization.ts),
        // then what it has now and then, by name
        const message = decode(data) as unknown[];
        let accounted = 0;
        message.forEach((value, i) => {
          if (i === POSITIONAL.length && value && typeof value === 'object') {
            for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
              const size = sizeOf(k, v);
              add(k, size);
              accounted += size;
            }
          } else {
            const size = encode(value).length;
            add(POSITIONAL[i] ?? `[${i}]`, size);
            accounted += size;
          }
        });
        add('(framing)', data.length - accounted);
        totals.deflate += Math.min(data.length, zlib.deflateRawSync(data, { level: 6 }).length);
        totals.deflateDict += Math.min(data.length, zlib.deflateRawSync(data, { level: 6, ...(previous && { dictionary: previous }) }).length);
      }
      previous = data.slice();
    },
  };
  const config: GameConfig = {
    players: scene.players.map((kind, i) => ({
      slotIndex: i as SlotIndex, nickname: `P${i}`, color: FFA_COLORS[i as SlotIndex],
      control: kind === 'human' ? { type: 'local', scheme: 'solo' } : { type: 'ai', difficulty: kind },
    })),
    gameMode: 'ffa', levelMode: scene.level,
  };
  const session = new HostSession(config, { rng: createRng(seed), transport, now: () => 0 });
  const game = session.game;
  const humans = scene.players.map((kind, i) => kind === 'human' ? wanderer(createRng(seed + 1 + i)) : null);
  const inputs = new Map<SlotIndex, TronInput>();
  let loadedLevel = -1;
  // Only the time a round is being played counts: that is when bandwidth matters
  let played = 0;
  for (let tick = 0; played < ticks && tick < ticks * 20; tick++) {
    if (game.currentLevelIndex !== loadedLevel) {
      loadedLevel = game.currentLevelIndex;
      session.setLevelObstacles(loadedLevel, loadLevelGrid(LEVELS[loadedLevel]!.id));
    }
    humans.forEach((h, i) => { if (h) inputs.set(i as SlotIndex, h(tick)); });
    measuring = game.phase === 'playing';
    if (measuring) {
      played++;
      scene.script?.(game, tick, inputs);
    }
    session.step(inputs);
  }
  return totals;
}

const args = process.argv.slice(2);
const only = args.find(a => a.startsWith('--only='))?.slice(7);
const json = args.find(a => a.startsWith('--json='))?.slice(7);
const ticks = Number(args.find(a => a.startsWith('--ticks='))?.slice(8) ?? 4200);
const results: Record<string, unknown> = {};
const kb = (bytes: number, messages: number): string => ((bytes / messages) * TICK_RATE / 1024).toFixed(1).padStart(6);

for (const scene of SCENES) {
  if (only && !scene.name.includes(only)) continue;
  const t = run(scene, ticks);
  console.log(`\n${scene.name}: ${kb(t.bytes, t.messages).trim()} KB/s, ${(t.bytes / t.messages).toFixed(0)} bytes a message (largest ${t.max})`);
  const parts = [...t.parts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [part, bytes] of parts) {
    if (bytes / t.bytes < 0.005) continue;
    console.log(`  ${part.padEnd(24)} ${kb(bytes, t.messages)} KB/s ${(100 * bytes / t.bytes).toFixed(1).padStart(5)} %`);
  }
  console.log(`  deflate, each message      ${kb(t.deflate, t.messages)} KB/s  (${(100 * t.deflate / t.bytes).toFixed(0)} %)`);
  console.log(`  deflate, previous as dict. ${kb(t.deflateDict, t.messages)} KB/s  (${(100 * t.deflateDict / t.bytes).toFixed(0)} %)`);
  results[scene.name] = {
    kbPerSecond: (t.bytes / t.messages) * TICK_RATE / 1024, bytesPerMessage: t.bytes / t.messages, largest: t.max,
    parts: Object.fromEntries(parts.map(([k, v]) => [k, v / t.messages])),
    deflate: t.deflate / t.bytes, deflateDict: t.deflateDict / t.bytes,
  };
}
if (json) writeFileSync(json, JSON.stringify(results, null, 2));
