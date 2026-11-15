// Pictures of the territory map at moments of a seeded bot match: the arena with the
// territory layer on the left and the risk layer on the right. See design/bots-territory.md.
//
//   npm run bots:snapshots -- --drivers=hard,old-hard --level=bricks --seed=3 --out=snapshots
//
//   --every=350     ticks between pictures (default 350 = 5 s); a picture is also taken
//                   whenever somebody dies
//   --rounds=1      rounds to play        --max=120   seconds per round
//   --bare          no items, no portals  --level=split  two closed halves
//   --rot=1 --round=7 --from=40   replay a round reported by `bots:strength --log-deaths`,
//                                 with pictures from second 40 on

import { mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { TerritoryMap, worldOf } from '../../src/game/ai/territory';
import { TUNING } from '../../src/game/ai/territorySense';
import { paintTerritory, VIEW_COLS, VIEW_ROWS } from '../../src/game/ai/territoryView';
import type { TerritoryLayer } from '../../src/game/ai/territoryView';
import { COARSE_CELL, PixelGrid } from '../../src/game/PixelGrid';
import { PLAY_HEIGHT, PLAY_WIDTH, TICK_RATE } from '../../src/game/constants';
import type { TronGameState } from '../../src/game/TronGameState';
import type { GameMode } from '../../src/types/lobby';
import { runMatch } from '../../tests/sim';
import type { DriverSpec } from '../../tests/sim';
import { createRng } from '../../src/game/rng';
import { scatterInHalves, splitArena } from './arenas';

const args = new Map(process.argv.slice(2).map(a => {
  const i = a.indexOf('=');
  return i < 0 ? [a.replace(/^--/, ''), '1'] as const : [a.slice(2, i), a.slice(i + 1)] as const;
}));
const drivers = (args.get('drivers') ?? 'hard,old-hard').split(',') as DriverSpec[];
const level = args.get('level') ?? 'bricks';
const seed = Number(args.get('seed') ?? 1);
const every = Number(args.get('every') ?? 350);
const out = args.get('out') ?? 'snapshots';
mkdirSync(out, { recursive: true });

const GAP = 6;
const overlay = new Uint8ClampedArray(VIEW_COLS * VIEW_ROWS * 4);

function draw(game: TronGameState, map: TerritoryMap, png: PNG, offsetX: number, layer: TerritoryLayer): void {
  paintTerritory(map, layer, game.players.map(p => p.color), overlay);
  const pixels: PixelGrid = game.pixels;
  for (let y = 0; y < PLAY_HEIGHT; y++) {
    for (let x = 0; x < PLAY_WIDTH; x++) {
      const o = (y * png.width + x + offsetX) * 4;
      const color = pixels.get(x, y);
      let r: number, g: number, b: number;
      if (color) {
        const v = parseInt(color.slice(1), 16);
        r = (v >> 16) & 255; g = (v >> 8) & 255; b = v & 255;
      } else {
        const c = (Math.floor(y / COARSE_CELL) * VIEW_COLS + Math.floor(x / COARSE_CELL)) * 4;
        const a = overlay[c + 3]! / 255;
        r = overlay[c]! * a; g = overlay[c + 1]! * a; b = overlay[c + 2]! * a;
      }
      png.data[o] = r; png.data[o + 1] = g; png.data[o + 2] = b; png.data[o + 3] = 255;
    }
  }
  // Heads: a white blob with a line showing the heading
  for (const p of game.players) {
    if (!p.alive) continue;
    const rad = p.direction * Math.PI / 180;
    for (let d = -3; d <= 12; d++) {
      for (let w = -2; w <= 2; w++) {
        if (d > 3 && w !== 0) continue;
        const x = Math.round(p.x / 1000 + Math.cos(rad) * d - Math.sin(rad) * w);
        const y = Math.round(p.y / 1000 + Math.sin(rad) * d + Math.cos(rad) * w);
        if (x < 0 || y < 0 || x >= PLAY_WIDTH || y >= PLAY_HEIGHT) continue;
        const o = (y * png.width + x + offsetX) * 4;
        png.data[o] = png.data[o + 1] = png.data[o + 2] = 255;
      }
    }
  }
}

// --rot and --round replay a round of `bots:strength --log-deaths` (same seeds and seats)
const rot = Number(args.get('rot') ?? 0);
const onlyRound = args.has('round') ? Number(args.get('round')) - 1 : -1;
const from = Number(args.get('from') ?? 0) * TICK_RATE;
const seats = drivers.map((_, i) => drivers[(i + rot) % drivers.length]!);
for (const pair of (args.get('tune') ?? '').split(',').filter(Boolean)) {
  const [key, value] = pair.split(':');
  (TUNING as Record<string, number>)[key!] = Number(value);
}
const map = new TerritoryMap();
const scatter = createRng(seed * 7919 + rot);
const alive: boolean[] = [];
let lastRound = -1;
const files: string[] = [];
runMatch({
  level: level === 'split' ? 'blank' : level, grid: level === 'split' ? splitArena() : undefined,
  drivers: seats, seed: seed * 100 + rot, rounds: onlyRound >= 0 ? onlyRound + 1 : Number(args.get('rounds') ?? 1), bare: args.has('bare'),
  mode: (args.get('mode') ?? 'ffa') as GameMode, maxRoundSeconds: Number(args.get('max') ?? 120),
  setup: level === 'split' ? (game) => scatterInHalves(game, scatter) : undefined,
  observe(game, round, tick) {
    if (round !== lastRound) {
      lastRound = round;
      game.players.forEach((_, i) => { alive[i] = true; });
    }
    let death = false;
    game.players.forEach((p, i) => {
      if (alive[i] && !p.alive) death = true;
      alive[i] = p.alive;
    });
    if (round < onlyRound || tick < from || (tick % every !== 0 && !death)) return;
    map.rebuild(worldOf(game));
    const png = new PNG({ width: PLAY_WIDTH * 2 + GAP, height: PLAY_HEIGHT });
    png.data.fill(60);
    draw(game, map, png, 0, 'territory');
    draw(game, map, png, PLAY_WIDTH + GAP, 'risk');
    const file = `${out}/${level}-s${seed}-r${round + 1}-${(tick / TICK_RATE).toFixed(1).padStart(5, '0')}s${death ? '-death' : ''}.png`;
    writeFileSync(file, PNG.sync.write(png));
    files.push(file);
    const info = game.players.map((p, i) =>
      `${seats[i]}${p.alive ? '' : '(dead)'} reach ${map.reach[p.slotIndex]} area ${map.area[p.slotIndex]} shared ${map.shared[p.slotIndex]}`).join(' | ');
    console.log(`${file}  ${info}`);
  },
});
console.log(`${files.length} pictures in ${out}/ (left: territory, right: risk)`);
