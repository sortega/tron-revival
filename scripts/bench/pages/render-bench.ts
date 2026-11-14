// Render benchmark page: the same synthetic scene drawn by
//   c2d        the game's TronRenderer (Canvas 2D), unmodified
//   imagedata  TronRenderer with the level + trail canvases replaced by one ImageData
//              pushed with putImageData every frame
//   webgl      the WebGLArena prototype (+ a sidebar canvas redrawn once a second)
//   c2d-noglow / c2d-nosidebar   TronRenderer with one part switched off, to see what
//              that part costs (the head glow's shadowBlur; the status panel)
// Driven by scripts/bench/render-bench.mjs; open by hand with
//   /tron-revival/scripts/bench/pages/render-bench.html?variant=webgl&scene=heavy
// See design/research/performance.md.

import { TronRenderer } from '../../../src/game/TronRenderer';
import { SpriteAtlas } from '../../../src/sprites';
import { SPRITE_HASH } from '../../../src/game/spriteHash';
import { forEachLinePixel } from '../../../src/game/PixelGrid';
import { PLAY_HEIGHT, PLAY_WIDTH } from '../../../src/game/constants';
import { LEVELS } from '../../../src/types/game';
import type { GamePlayer, TrailSegment, TronMatchState, TronRoundState } from '../../../src/types/game';
import { FFA_COLORS } from '../../../src/types/lobby';
import type { SlotIndex } from '../../../src/types/lobby';
import { createRng } from '../../../src/game/rng';
import { WebGLArena } from './WebGLArena';

type Variant = 'c2d' | 'c2d-noglow' | 'c2d-nosidebar' | 'imagedata' | 'webgl';
type SceneKind = 'typical' | 'heavy' | 'tint';

const params = new URLSearchParams(location.search);
const variant = (params.get('variant') ?? 'c2d') as Variant;
const sceneKind = (params.get('scene') ?? 'typical') as SceneKind;
const frames = Number(params.get('frames') ?? 600);
const stage = document.getElementById('stage')!;

const players: GamePlayer[] = ([0, 1, 2, 3] as SlotIndex[]).map(slot => ({
  slotIndex: slot, nickname: `P${slot}`, color: FFA_COLORS[slot], control: { type: 'remote' },
}));
const match: TronMatchState = {
  scores: { 0: 1, 1: 2, 2: 0, 3: 1 }, currentRound: 3, currentLevelIndex: 2, playersReady: [],
  gameMode: 'ffa', levelMode: 'cycle', ridiculousDeath: {},
};

// What one display frame brings: the state to draw and the one-shot events before it
interface SceneFrame {
  round: TronRoundState;
  trails: { slot: SlotIndex; segments: TrailSegment[] }[];
  clearedLines: number[];
  clearedRects: { x: number; y: number; w: number; h: number }[];
}

function makeScene(kind: SceneKind): (frame: number) => SceneFrame {
  const rng = createRng(4);
  const heavy = kind === 'heavy';
  const heads = players.map((_, i) => ({ x: 150 + i * 150, y: 120 + i * 110, dir: i * 90 }));
  const items = ['shield', 'glock', 'uzi', 'bomb', 'turbo', 'crossing'].map((sprite, i) => ({
    id: i, sprite, category: 'weapon' as const, x: 100 + i * 110, y: 80 + ((i * 197) % 440), active: true, hp: 40,
  }));
  const tracers = Array.from({ length: heavy ? 160 : 0 }, (_, i) => ({ x: rng() * PLAY_WIDTH, y: rng() * PLAY_HEIGHT, dir: rng() * Math.PI * 2, id: i }));
  let ticks = 0;

  return (frame) => {
    // 70 ticks per second on a 60 Hz display: one tick, and a second one every sixth frame
    const steps = frame % 6 === 0 ? 2 : 1;
    const trails = players.map(p => ({ slot: p.slotIndex, segments: [] as TrailSegment[] }));
    const clearedLines: number[] = [];
    for (let s = 0; s < steps; s++) {
      ticks++;
      heads.forEach((h, i) => {
        if (ticks % 40 < 12) h.dir += i % 2 === 0 ? 4 : -4;
        trails[i]!.segments.push({ x: Math.floor(h.x), y: Math.floor(h.y) });
        h.x = (h.x + Math.cos(h.dir * Math.PI / 180) + PLAY_WIDTH) % PLAY_WIDTH;
        h.y = (h.y + Math.sin(h.dir * Math.PI / 180) + PLAY_HEIGHT) % PLAY_HEIGHT;
      });
      for (const t of tracers) {
        const x0 = Math.floor(t.x);
        const y0 = Math.floor(t.y);
        t.x = (t.x + Math.cos(t.dir) * 15 + PLAY_WIDTH) % PLAY_WIDTH;
        t.y = (t.y + Math.sin(t.dir) * 15 + PLAY_HEIGHT) % PLAY_HEIGHT;
        // Like the Uzi: every tracer erases the line it flew along
        if (Math.abs(t.x - x0) < 20 && Math.abs(t.y - y0) < 20) clearedLines.push(x0, y0, Math.floor(t.x), Math.floor(t.y));
      }
    }
    const round: TronRoundState = {
      phase: 'playing',
      players: players.map((p, i) => ({
        slotIndex: p.slotIndex, x: heads[i]!.x * 1000, y: heads[i]!.y * 1000, direction: heads[i]!.dir,
        // (one dead player in the `tint` scene: its panel is drawn grey)
        alive: !(kind === 'tint' && i === 3),
        color: p.color, nickname: p.nickname,
        equippedWeapon: { sprite: 'uzi', remainingFrames: 700 - (ticks % 700) },
        activeEffects: [{ sprite: 'shield', remainingFrames: 2100 - (ticks % 2100) }],
        speed: 1, moveCounter: 0, tpCooldown: 0, steer: 0, action: false,
      })),
      countdown: 0, roundWinner: null,
      portals: [
        { id: 0, x1: 200, y1: 300, x2: 560, y2: 140, animFrame: Math.floor(ticks / 3) % 30 },
        { id: 1, x1: 380, y1: 480, x2: 640, y2: 420, animFrame: Math.floor(ticks / 3) % 30 },
      ],
      items,
      projectiles: [
        ...tracers.map(t => ({ id: t.id, x: t.x * 1000, y: t.y * 1000, direction: 0, ownerSlot: 0 as SlotIndex, speed: 15000, type: 'tracer' as const })),
        ...(heavy ? [0, 1, 2].map(i => ({ id: 900 + i, x: ((ticks * 2 + i * 250) % PLAY_WIDTH) * 1000, y: (150 + i * 150) * 1000, direction: i * 60, ownerSlot: 0 as SlotIndex, speed: 2000, type: 'bomb' as const })) : []),
        ...(heavy ? [0, 1, 2, 3].map(i => ({ id: 950 + i, x: ((ticks * 5 + i * 180) % PLAY_WIDTH) * 1000, y: (100 + i * 130) * 1000, direction: i * 45, ownerSlot: 0 as SlotIndex, speed: 5000, type: 'bullet' as const })) : []),
      ],
      explosions: heavy ? [0, 1, 2, 3, 4, 5].map(i => ({
        id: i, x: 100 + i * 110, y: 120 + ((i * 173) % 400), frame: (ticks + i * 6) % 39, ...(i < 2 && { scale: 2 }),
      })) : [],
      bodyguards: heavy ? heads.flatMap((h, i) => [0, 1, 2].map(k => ({
        id: i * 3 + k, ownerSlot: i as SlotIndex, phaseOffset: k * 120,
        x: (h.x + Math.cos((ticks * 2.5 + k * 120) * Math.PI / 180) * 30) * 1000,
        y: (h.y + Math.sin((ticks * 2.5 + k * 120) * Math.PI / 180) * 30) * 1000,
      }))) : [],
      doorTick: ticks,
    };
    const clearedRects = heavy && frame % 10 === 0 ? [{ x: (frame * 13) % 700, y: (frame * 7) % 550, w: 10, h: 10 }] : [];
    return { round, trails, clearedLines, clearedRects };
  };
}

interface Drawer {
  apply(frame: SceneFrame): void;   // One-shot events
  draw(frame: SceneFrame, index: number): void;
  /** Hash of the pixels on screen, to compare two versions of a renderer. */
  hash?(): string;
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
}

async function makeCanvas2D(replaceArena: boolean): Promise<Drawer> {
  const renderer = new TronRenderer(stage, players, false);
  await renderer.loadLevel(LEVELS[2]!);
  // Give the sprite atlas time to load
  await new Promise(resolve => setTimeout(resolve, 500));
  const internals = renderer as unknown as {
    ctx: CanvasRenderingContext2D; trailCanvas: HTMLCanvasElement; levelCanvas: HTMLCanvasElement;
  };

  if (variant === 'c2d-noglow') {
    Object.defineProperty(internals.ctx, 'shadowBlur', { get: () => 0, set: () => {} });
  }
  if (variant === 'c2d-nosidebar') {
    (renderer as unknown as { renderStatusPanel: () => void }).renderStatusPanel = () => {};
  }

  let arena: ImageData | null = null;
  let pixels: Uint32Array | null = null;
  if (replaceArena) {
    // One opaque frame buffer for level + trails, blitted instead of the two layers
    const levelCtx = internals.levelCanvas.getContext('2d')!;
    arena = levelCtx.getImageData(0, 0, PLAY_WIDTH, PLAY_HEIGHT);
    pixels = new Uint32Array(arena.data.buffer);
    for (let i = 0; i < pixels.length; i++) pixels[i] = pixels[i]! | 0xff000000;
    const ctx = internals.ctx;
    const drawImage = ctx.drawImage.bind(ctx) as (...args: unknown[]) => void;
    (ctx as unknown as { drawImage: (...args: unknown[]) => void }).drawImage = (...args: unknown[]) => {
      if (args[0] === internals.levelCanvas) return;
      if (args[0] === internals.trailCanvas) {
        ctx.putImageData(arena!, 0, 0);
        return;
      }
      drawImage(...args);
    };
  }
  const colors = players.map(p => {
    const n = parseInt(p.color.slice(1), 16);
    return (0xff000000 | ((n & 255) << 16) | (n & 0xff00) | (n >> 16)) >>> 0;
  });

  return {
    apply(frame) {
      for (const { slot, segments } of frame.trails) {
        if (pixels) for (const seg of segments) pixels[seg.y * PLAY_WIDTH + seg.x] = colors[slot]!;
        else renderer.addTrailSegments(slot, segments);
      }
      const l = frame.clearedLines;
      if (pixels) {
        for (let i = 0; i + 3 < l.length; i += 4) {
          forEachLinePixel(l[i]!, l[i + 1]!, l[i + 2]!, l[i + 3]!, (x, y) => { pixels![y * PLAY_WIDTH + x] = 0xff000000; });
        }
      } else {
        renderer.clearLines(l);
      }
      for (const r of frame.clearedRects) {
        if (pixels) for (let y = r.y; y < r.y + r.h; y++) pixels.fill(0xff000000, y * PLAY_WIDTH + r.x, y * PLAY_WIDTH + r.x + r.w);
        else renderer.clearRect(r.x, r.y, r.w, r.h);
      }
      renderer.updateColorBlindness(sceneKind === 'tint' ? 200 : 0);
    },
    draw(frame) {
      renderer.render(frame.round, match);
    },
    hash() {
      // FNV-1a over the play area and over the status panel
      const fnv = (x: number, w: number): string => {
        const data = internals.ctx.getImageData(x, 0, w, 600).data;
        let h = 0x811c9dc5;
        for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data[i]!, 0x01000193);
        return (h >>> 0).toString(16);
      };
      return `${fnv(0, PLAY_WIDTH)}/${fnv(PLAY_WIDTH, 50)}`;
    },
  };
}

async function makeWebGL(): Promise<Drawer> {
  const atlas = new SpriteAtlas();
  await atlas.load(`${import.meta.env.BASE_URL}assets/sprites/items.${SPRITE_HASH}.json`);
  const arena = new WebGLArena(stage, atlas);
  const level = await loadImage(LEVELS[2]!.imagePath);
  const scratch = document.createElement('canvas');
  scratch.width = PLAY_WIDTH;
  scratch.height = PLAY_HEIGHT;
  const scratchCtx = scratch.getContext('2d')!;
  scratchCtx.drawImage(level, 0, 0, PLAY_WIDTH, PLAY_HEIGHT);
  arena.setLevel(scratchCtx.getImageData(0, 0, PLAY_WIDTH, PLAY_HEIGHT));

  // The sidebar: a 2D canvas next to the arena, redrawn only when its content changes
  // (here: once a second, for the timers)
  const sidebar = document.createElement('canvas');
  sidebar.width = 50;
  sidebar.height = PLAY_HEIGHT;
  stage.appendChild(sidebar);
  const sidebarCtx = sidebar.getContext('2d')!;
  const drawSidebar = (round: TronRoundState): void => {
    atlas.draw(sidebarCtx, 'sidebar', 25, PLAY_HEIGHT / 2);
    round.players.forEach((p, i) => {
      const y = i * 150;
      atlas.draw(sidebarCtx, 'shield_sidebar', 25, y + 37);
      atlas.draw(sidebarCtx, 'uzi_sidebar', 25, y + 112);
      sidebarCtx.fillStyle = '#000';
      sidebarCtx.font = 'bold 14px monospace';
      sidebarCtx.textAlign = 'center';
      sidebarCtx.textBaseline = 'top';
      sidebarCtx.fillText(`${Math.ceil((p.activeEffects[0]?.remainingFrames ?? 0) / 70)}s`, 25, y + 59);
      sidebarCtx.fillText(`${Math.ceil((p.equippedWeapon?.remainingFrames ?? 0) / 70)}s`, 25, y + 134);
    });
  };

  return {
    apply(frame) {
      for (const { slot, segments } of frame.trails) arena.addTrailSegments(players[slot]!.color, segments);
      const l = frame.clearedLines;
      for (let i = 0; i + 3 < l.length; i += 4) {
        forEachLinePixel(l[i]!, l[i + 1]!, l[i + 2]!, l[i + 3]!, (x, y) => arena.clearPixel(x, y));
      }
      for (const r of frame.clearedRects) arena.clearRect(r.x, r.y, r.w, r.h);
    },
    draw(frame, index) {
      arena.render(frame.round);
      if (index % 60 === 0) drawSidebar(frame.round);
    },
  };
}

function summarise(values: number[]): { mean: number; p50: number; p95: number; p99: number; max: number } {
  const sorted = Float64Array.from(values).sort();
  const q = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
  return { mean: values.reduce((a, b) => a + b, 0) / values.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: sorted[sorted.length - 1]! };
}

async function main(): Promise<void> {
  const drawer = variant === 'webgl' ? await makeWebGL() : await makeCanvas2D(variant === 'imagedata');
  const scene = makeScene(sceneKind);
  const apply: number[] = [];
  const draw: number[] = [];
  const gaps: number[] = [];
  let last = 0;
  // `go` is set by the driver once CPU throttling and tracing are in place
  const control = window as unknown as { __go?: boolean; __ready?: boolean; __result?: unknown };
  control.__ready = true;
  if (!params.has('auto')) await new Promise<void>(resolve => {
    const wait = (): void => { if (control.__go) resolve(); else setTimeout(wait, 20); };
    wait();
  });

  const WARMUP = 60;
  for (let i = 0; i < frames + WARMUP; i++) {
    const now = await new Promise<number>(resolve => requestAnimationFrame(resolve));
    const frame = scene(i);
    const t0 = performance.now();
    drawer.apply(frame);
    const t1 = performance.now();
    drawer.draw(frame, i);
    const t2 = performance.now();
    if (i >= WARMUP) {
      apply.push(t1 - t0);
      draw.push(t2 - t1);
      if (last > 0) gaps.push(now - last);
      last = now;
    }
  }
  const result = {
    variant, scene: sceneKind, frames,
    apply: summarise(apply), draw: summarise(draw), total: summarise(apply.map((a, i) => a + draw[i]!)),
    rafGap: summarise(gaps), slowFrames: gaps.filter(g => g > 25).length,
    canvasHash: drawer.hash?.(),
  };
  control.__result = result;
  document.getElementById('result')!.textContent = JSON.stringify(result, null, 2);
}

void main();
