import { describe, expect, it } from 'vitest';
import { ArenaDisplay } from '../src/game/display/ArenaDisplay';
import type { LayerSink } from '../src/game/display/ArenaDisplay';
import { DisplayCells, KIND_LEVEL, KIND_TRAIL, luminance, packCss, packRgba, shadeCells } from '../src/game/display/shade';
import type { ShadeStyle } from '../src/game/display/shade';
import { styleFor } from '../src/game/display/settings';
import { PixelGrid } from '../src/game/PixelGrid';
import { PLAY_WIDTH, PLAY_HEIGHT } from '../src/game/constants';
import { createRng } from '../src/game/rng';
import { loadLevelGrid } from './helpers';

/** Layers kept in memory, like the canvases would. */
class MemorySink implements LayerSink {
  level = new Uint32Array(0);
  trail = new Uint32Array(0);
  width = 0;
  puts = 0;
  private scratch = { level: new Uint32Array(0), trail: new Uint32Array(0), stride: 0 };

  resize(width: number, height: number): void {
    this.width = width;
    this.level = new Uint32Array(width * height);
    this.trail = new Uint32Array(width * height);
  }

  buffers(w: number, h: number): { level: Uint32Array; trail: Uint32Array; stride: number } {
    // A wider stride than needed and stale contents, like the pooled canvas buffers
    const stride = w + 3;
    this.scratch = { level: new Uint32Array(stride * h).fill(0xdeadbeef), trail: new Uint32Array(stride * h).fill(0xdeadbeef), stride };
    return this.scratch;
  }

  put(x: number, y: number, w: number, h: number): void {
    this.puts++;
    for (let row = 0; row < h; row++) {
      const from = row * this.scratch.stride;
      const to = (y + row) * this.width + x;
      this.level.set(this.scratch.level.subarray(from, from + w), to);
      this.trail.set(this.scratch.trail.subarray(from, from + w), to);
    }
  }
}

const SOFT = styleFor(false);      // Dark levels: the one look of the game
const DARK_EDGE = styleFor(true);  // Light levels (Paper)
/** No shade at all: only used here, to tell the cells from what is derived from them. */
const PLAIN: ShadeStyle = { scale: 1, bands: [] };
const STYLES: [string, ShadeStyle][] = [['soft', SOFT], ['dark edge', DARK_EDGE], ['plain', PLAIN]];

/** The picture derived from scratch from the cells of a display. */
function fromScratch(display: ArenaDisplay, style: ShadeStyle): { level: Uint32Array; trail: Uint32Array } {
  const level = new Uint32Array(PLAY_WIDTH * PLAY_HEIGHT);
  const trail = new Uint32Array(PLAY_WIDTH * PLAY_HEIGHT);
  shadeCells(display.cells, style, 0, 0, PLAY_WIDTH, PLAY_HEIGHT, level, trail);
  return { level, trail };
}

function same(a: Uint32Array, b: Uint32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const RED = '#ff4444';
const GREEN = '#44ff44';
const core = packRgba(0xff, 0x44, 0x44);
const alphaOf = (pixel: number): number => (pixel >>> 24) / 255;
const rgbOf = (pixel: number): number => pixel & 0x00ffffff;

/** Derive a 16×16 arena with red trail on the given cells. */
function derive(points: [number, number][], style: ShadeStyle = SOFT): Uint32Array {
  const cells = new DisplayCells(16, 16);
  for (const [x, y] of points) cells.set(x, y, KIND_TRAIL, packCss(RED));
  const trail = new Uint32Array(256);
  shadeCells(cells, style, 0, 0, 16, 16, new Uint32Array(256), trail);
  return trail;
}
const at = (trail: Uint32Array, x: number, y: number): number => trail[y * 16 + x]!;

describe('soft trails', () => {
  it('the trail itself is a hard pixel of the player colour, exactly where the obstacle is', () => {
    const trail = derive([[5, 5], [6, 5], [7, 6]]);
    for (const [x, y] of [[5, 5], [6, 5], [7, 6]] as const) expect(at(trail, x, y)).toBe(core);
    expect(trail.filter(v => v === core).length).toBe(3);
  });

  it('around it: the same colour, semi-transparent, one pixel out and no further', () => {
    const trail = derive([[8, 8]]);
    let lit = 0;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const pixel = at(trail, x, y);
        if (pixel === 0) continue;
        lit++;
        expect(Math.max(Math.abs(x - 8), Math.abs(y - 8))).toBeLessThanOrEqual(1);
        if (x === 8 && y === 8) continue;
        expect(rgbOf(pixel)).toBe(rgbOf(core));
        expect(alphaOf(pixel)).toBeGreaterThan(0.03);
        expect(alphaOf(pixel)).toBeLessThan(0.6);
      }
    }
    expect(lit).toBe(9);
    // Beside the pixel more than at its corners
    expect(alphaOf(at(trail, 7, 8))).toBeGreaterThan(alphaOf(at(trail, 7, 7)) * 2);
  });

  it('smooths more than it thickens: the notch of a staircase gets more than the side of a straight line', () => {
    const straight = derive(Array.from({ length: 10 }, (_, i) => [3 + i, 8] as [number, number]));
    const beside = alphaOf(at(straight, 8, 7));
    const diagonal = derive(Array.from({ length: 8 }, (_, i) => [4 + i, 4 + i] as [number, number]));
    const notch = alphaOf(at(diagonal, 8, 7));   // Touches (7,7) from the right and (8,8) from above
    expect(notch).toBeGreaterThan(beside);
    // Subtle either way: never close to solid
    expect(beside).toBeGreaterThan(0.2);
    expect(beside).toBeLessThan(0.45);
    expect(notch).toBeLessThanOrEqual(0.5);
  });

  it('on a light level the edge is opaque and much darker than the trail', () => {
    const trail = derive([[8, 8]], DARK_EDGE);
    const edge = at(trail, 7, 8);
    expect(edge >>> 24).toBe(255);
    expect(luminance(edge)).toBeLessThan(luminance(core) * 0.3);
  });

  it('a gap between two trails is never closed by the shade, however narrow', () => {
    for (const [name, style] of STYLES.slice(0, 2)) {
      for (let gap = 1; gap <= 4; gap++) {
        for (const vertical of [false, true]) {
          // Two parallel trails with `gap` free cells between them
          const cells = new DisplayCells(16, 16);
          for (let t = 0; t < 16; t++) {
            if (vertical) {
              cells.set(4, t, KIND_TRAIL, packCss(RED));
              cells.set(5 + gap, t, KIND_TRAIL, packCss(GREEN));
            } else {
              cells.set(t, 4, KIND_TRAIL, packCss(RED));
              cells.set(t, 5 + gap, KIND_TRAIL, packCss(GREEN));
            }
          }
          const trail = new Uint32Array(256);
          shadeCells(cells, style, 0, 0, 16, 16, new Uint32Array(256), trail);
          // Count the gap cells left completely untouched, across the middle of the trails
          let clear = 0;
          for (let g = 0; g < gap; g++) {
            if ((vertical ? at(trail, 5 + g, 8) : at(trail, 8, 5 + g)) === 0) clear++;
          }
          expect(clear, `${name}, gap ${gap}, ${vertical ? 'vertical' : 'horizontal'}`).toBeGreaterThanOrEqual(1);
          // The outer sides are shaded all the same
          expect(vertical ? at(trail, 3, 8) : at(trail, 8, 3), name).not.toBe(0);
        }
      }
    }
  });

  it('the shade never covers a wall or another trail', () => {
    const cells = new DisplayCells(8, 8);
    cells.set(3, 3, KIND_TRAIL, packCss(RED));
    cells.set(4, 3, KIND_TRAIL, packCss(GREEN));
    cells.set(3, 4, KIND_LEVEL, packCss('#808080'));
    for (const [name, style] of STYLES) {
      const level = new Uint32Array(64);
      const trail = new Uint32Array(64);
      shadeCells(cells, style, 0, 0, 8, 8, level, trail);
      expect(trail[3 * 8 + 4], name).toBe(packRgba(0x44, 0xff, 0x44));
      expect(trail[4 * 8 + 3], name).toBe(0);
      expect(level[4 * 8 + 3], name).toBe(packRgba(0x80, 0x80, 0x80));
      expect(level.filter(v => v !== 0).length, name).toBe(1);
    }
  });
});

describe('ArenaDisplay', () => {
  it('incremental updates equal a derivation from scratch: no ghosts after erasing', () => {
    for (const [name, style] of STYLES) {
      const sink = new MemorySink();
      const display = new ArenaDisplay(PLAY_WIDTH, PLAY_HEIGHT, sink, style);
      display.setLevel(loadLevelGrid('bricks'));
      display.restoreLevel();
      display.flush();
      const rng = createRng(7);
      const int = (n: number): number => Math.floor(rng() * n);
      for (let step = 0; step < 400; step++) {
        const kind = int(10);
        if (kind < 5) {
          // A stretch of trail
          let x = int(PLAY_WIDTH), y = int(PLAY_HEIGHT);
          const points = [];
          for (let i = 0; i < 1 + int(40); i++) {
            points.push({ x, y });
            x = (x + int(3) - 1 + PLAY_WIDTH) % PLAY_WIDTH;
            y = (y + int(3) - 1 + PLAY_HEIGHT) % PLAY_HEIGHT;
          }
          display.addTrail(points, [RED, GREEN, '#4444ff'][int(3)]!);
        } else if (kind < 7) {
          // Bomb-sized hole, possibly across the edges
          display.clearRect(int(PLAY_WIDTH) - 60, int(PLAY_HEIGHT) - 60, 1 + int(120), 1 + int(120));
        } else if (kind < 9) {
          // Tracer path, possibly beyond the edges (wraps)
          const x = int(PLAY_WIDTH), y = int(PLAY_HEIGHT);
          display.clearLine(x, y, x + int(400) - 200, y + int(400) - 200);
        } else {
          display.addLevel([{ x: int(PLAY_WIDTH), y: 0 }, { x: 0, y: int(PLAY_HEIGHT) }], '#ffff44');
        }
        if (step % 3 === 0) display.flush();
      }
      display.flush();
      const expected = fromScratch(display, style);
      expect(same(sink.trail, expected.trail), `${name} trail layer`).toBe(true);
      expect(same(sink.level, expected.level), `${name} level layer`).toBe(true);

      // Erase everything: nothing may be left on either layer
      display.clearRect(0, 0, PLAY_WIDTH, PLAY_HEIGHT);
      display.flush();
      expect(sink.trail.every(v => v === 0), `${name} trail ghosts`).toBe(true);
      expect(sink.level.every(v => v === 0), `${name} level ghosts`).toBe(true);
    }
  });

  it('a tick only re-derives a few cells', () => {
    const sink = new MemorySink();
    const display = new ArenaDisplay(PLAY_WIDTH, PLAY_HEIGHT, sink, SOFT);
    display.flush();
    for (let slot = 0; slot < 4; slot++) {
      display.addTrail([{ x: 100 * slot + 10, y: 50 }, { x: 100 * slot + 11, y: 51 }], RED);
    }
    display.flush();
    expect(display.lastFlushCells).toBeLessThanOrEqual(4 * 36);
  });

  it('a level with another background re-derives the same cells in its style', () => {
    const sink = new MemorySink();
    const display = new ArenaDisplay(PLAY_WIDTH, PLAY_HEIGHT, sink, SOFT);
    display.addTrail([{ x: 10, y: 10 }, { x: 11, y: 10 }], RED);
    display.flush();
    display.setStyle(DARK_EDGE);
    display.flush();
    expect(same(sink.trail, fromScratch(display, DARK_EDGE).trail)).toBe(true);
    expect(sink.trail[10 * PLAY_WIDTH + 9]! >>> 24).toBe(255);
  });

  it('new round / eraser: undamaged level, no trails; a late level image keeps the trails', () => {
    const sink = new MemorySink();
    const display = new ArenaDisplay(PLAY_WIDTH, PLAY_HEIGHT, sink, PLAIN);
    const level = loadLevelGrid('bricks');
    display.setLevel(level);
    display.restoreLevel();
    display.addTrail([{ x: 1, y: 1 }], RED);
    display.clearRect(0, 0, PLAY_WIDTH, 300);
    display.restoreLevel();
    display.flush();
    expect(sink.trail.every(v => v === 0)).toBe(true);
    expect(sink.level.filter(v => v !== 0).length).toBe(level.count());

    display.addTrail([{ x: 1, y: 1 }], RED);
    display.restoreLevel(true);
    display.flush();
    expect(sink.trail.filter(v => v !== 0).length).toBe(1);
  });

  it('a snapshot is split into trails (player colours) and level', () => {
    const arena = new PixelGrid();
    arena.set(5, 5, RED);
    arena.set(6, 5, '#123456');
    const sink = new MemorySink();
    const display = new ArenaDisplay(PLAY_WIDTH, PLAY_HEIGHT, sink, PLAIN);
    display.paintSnapshot(arena, color => color === RED);
    display.flush();
    expect(sink.trail[5 * PLAY_WIDTH + 5]).toBe(packCss(RED));
    expect(sink.trail[5 * PLAY_WIDTH + 6]).toBe(0);
    expect(sink.level[5 * PLAY_WIDTH + 6]).toBe(packCss('#123456'));
  });
});

describe('display follows the game', () => {
  it('fed with the frame events of a real match, the display bitmap is the collision bitmap cell for cell', async () => {
    const { TronGameState } = await import('../src/game/TronGameState');
    const { BotController } = await import('../src/game/ai/BotController');
    const { makePlayers } = await import('./helpers');
    const sink = new MemorySink();
    const display = new ArenaDisplay(PLAY_WIDTH, PLAY_HEIGHT, sink, SOFT);
    const players = makePlayers(4);
    const game = new TronGameState(players, 'ffa', 'bricks', createRng(5));
    const level = loadLevelGrid('bricks');
    game.setLevelObstacles(level);
    display.setLevel(level);
    display.restoreLevel(true);
    const bots = players.map((p, i) => new BotController(p.slotIndex, 'hard', createRng(100 + i)));
    const inputs = new Map();
    let erased = 0;
    let checks = 0;

    const compare = (): void => {
      let wrong = 0;
      for (let y = 0; y < PLAY_HEIGHT; y++) {
        for (let x = 0; x < PLAY_WIDTH; x++) {
          const i = y * PLAY_WIDTH + x;
          const color = game.pixels.get(x, y);
          const shown = display.cells.kind[i] !== 0;
          if (shown !== (color !== null)) wrong++;
          else if (color !== null && display.cells.color[i] !== packCss(color)) wrong++;
        }
      }
      expect(wrong).toBe(0);
      checks++;
    };

    for (let tick = 0; tick < 70 * 90; tick++) {
      bots.forEach((bot, i) => inputs.set(players[i]!.slotIndex, bot.decide(game)));
      game.tick(inputs);
      const f = game.serialize();
      // Same order as TronGame.applyFrameEvents
      if (f.roundStarted || f.eraserUsed) display.restoreLevel();
      for (const { slotIndex, segments } of f.newTrailSegments) display.addTrail(segments, players[slotIndex]!.color);
      for (const { color, segments } of f.borderSegments ?? []) display.addLevel(segments, color);
      const lines = f.clearedLines ?? [];
      for (let i = 0; i + 3 < lines.length; i += 4) display.clearLine(lines[i]!, lines[i + 1]!, lines[i + 2]!, lines[i + 3]!);
      for (const r of f.clearedAreas ?? []) display.clearRect(r.x, r.y, r.w, r.h);
      erased += lines.length / 4 + (f.clearedAreas?.length ?? 0);
      display.flush();
      if (tick % 700 === 699) compare();
    }
    compare();
    expect(checks).toBeGreaterThan(5);
    expect(erased).toBeGreaterThan(20);           // Weapons were used: the erasing paths ran
    expect(game.currentRound).toBeGreaterThan(1);
    // And what is on the layers is what a derivation from scratch gives: no ghosts
    const expected = fromScratch(display, SOFT);
    expect(same(sink.trail, expected.trail)).toBe(true);
    expect(same(sink.level, expected.level)).toBe(true);
  }, 120_000);
});
