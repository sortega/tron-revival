import { describe, expect, it } from 'vitest';
import { ArenaDisplay } from '../src/game/display/ArenaDisplay';
import type { LayerSink } from '../src/game/display/ArenaDisplay';
import { DisplayCells, KIND_LEVEL, KIND_TRAIL, packCss, packRgba, shadeCells } from '../src/game/display/shade';
import {
  DEFAULT_DISPLAY, SHADE_VARIANTS, formatDisplaySettings, parseDisplaySettings, styleFor,
} from '../src/game/display/settings';
import type { DisplaySettings } from '../src/game/display/settings';
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

const settings = (shade: DisplaySettings['shade'], fx: DisplaySettings['fx'] = []): DisplaySettings =>
  ({ shade, head: 'ring', fx });

/** The picture derived from scratch from the cells of a display. */
function fromScratch(display: ArenaDisplay, s: DisplaySettings): { level: Uint32Array; trail: Uint32Array } {
  const style = styleFor(s);
  const n = PLAY_WIDTH * style.scale * PLAY_HEIGHT * style.scale;
  const level = new Uint32Array(n);
  const trail = new Uint32Array(n);
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

describe('shade derivation', () => {
  it('classic style is the cells and nothing else', () => {
    const cells = new DisplayCells(8, 8);
    cells.set(3, 3, KIND_TRAIL, packCss(RED));
    cells.set(5, 5, KIND_LEVEL, packCss('#808080'));
    const level = new Uint32Array(64);
    const trail = new Uint32Array(64);
    shadeCells(cells, styleFor(settings('off')), 0, 0, 8, 8, level, trail);
    expect(trail.filter(v => v !== 0).length).toBe(1);
    expect(trail[3 * 8 + 3]).toBe(packRgba(0xff, 0x44, 0x44));
    expect(level.filter(v => v !== 0).length).toBe(1);
    expect(level[5 * 8 + 5]).toBe(packRgba(0x80, 0x80, 0x80));
  });

  it('half-pixel fringe: a 2×2 core with one sub-pixel of shade all around', () => {
    const cells = new DisplayCells(8, 8);
    cells.set(3, 3, KIND_TRAIL, packCss(RED));
    const level = new Uint32Array(256);
    const trail = new Uint32Array(256);
    shadeCells(cells, styleFor(settings('half')), 0, 0, 8, 8, level, trail);
    const core = packRgba(0xff, 0x44, 0x44);
    const lit: string[] = [];
    let cores = 0;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const v = trail[y * 16 + x]!;
        if (v === core) cores++;
        if (v !== 0) lit.push(`${x},${y}`);
      }
    }
    expect(cores).toBe(4);
    // Sub-pixels 5..8 in both axes: the core (6..7) plus one on each side
    expect(lit.length).toBe(16);
    expect(lit[0]).toBe('5,5');
    expect(lit[15]).toBe('8,8');
    // The fringe is translucent and keeps the hue
    expect(trail[5 * 16 + 6]! >>> 24).toBeLessThan(255);
    expect(trail[5 * 16 + 6]! & 0xffffff).toBe(core & 0xffffff);
  });

  it('the fringe never covers a wall or another trail', () => {
    const cells = new DisplayCells(8, 8);
    cells.set(3, 3, KIND_TRAIL, packCss(RED));
    cells.set(4, 3, KIND_TRAIL, packCss(GREEN));
    cells.set(3, 4, KIND_LEVEL, packCss('#808080'));
    for (const shade of SHADE_VARIANTS) {
      const style = styleFor(settings(shade, ['shadow']));
      const S = style.scale;
      const level = new Uint32Array(64 * S * S);
      const trail = new Uint32Array(64 * S * S);
      shadeCells(cells, style, 0, 0, 8, 8, level, trail);
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          expect(trail[(3 * S + sy) * 8 * S + 4 * S + sx], shade).toBe(packRgba(0x44, 0xff, 0x44));
          expect(trail[(4 * S + sy) * 8 * S + 3 * S + sx], shade).toBe(0);
          expect(level[(4 * S + sy) * 8 * S + 3 * S + sx], shade).toBe(packRgba(0x80, 0x80, 0x80));
          // No wall shadow under a trail
          expect(level[(3 * S + sy) * 8 * S + 3 * S + sx], shade).toBe(0);
        }
      }
    }
  });
});

describe('ArenaDisplay', () => {
  it('incremental updates equal a derivation from scratch: no ghosts after erasing', () => {
    for (const shade of SHADE_VARIANTS) {
      const s = settings(shade, ['shadow', 'pattern']);
      const sink = new MemorySink();
      const display = new ArenaDisplay(PLAY_WIDTH, PLAY_HEIGHT, sink, styleFor(s));
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
          display.addTrail(points, [RED, GREEN][int(2)]!, int(4));
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
      const expected = fromScratch(display, s);
      expect(same(sink.trail, expected.trail), `${shade} trail layer`).toBe(true);
      expect(same(sink.level, expected.level), `${shade} level layer`).toBe(true);

      // Erase everything: nothing may be left on either layer
      display.clearRect(0, 0, PLAY_WIDTH, PLAY_HEIGHT);
      display.flush();
      expect(sink.trail.every(v => v === 0), `${shade} trail ghosts`).toBe(true);
      expect(sink.level.every(v => v === 0), `${shade} level ghosts`).toBe(true);
    }
  });

  it('a tick only re-derives a few cells', () => {
    const sink = new MemorySink();
    const display = new ArenaDisplay(PLAY_WIDTH, PLAY_HEIGHT, sink, styleFor(settings('half')));
    display.flush();
    for (let slot = 0; slot < 4; slot++) {
      display.addTrail([{ x: 100 * slot + 10, y: 50 }, { x: 100 * slot + 11, y: 51 }], RED, slot);
    }
    display.flush();
    expect(display.lastFlushCells).toBeLessThanOrEqual(4 * 16);
  });

  it('switching the variant keeps the cells', () => {
    const sink = new MemorySink();
    const display = new ArenaDisplay(PLAY_WIDTH, PLAY_HEIGHT, sink, styleFor(settings('off')));
    display.addTrail([{ x: 10, y: 10 }, { x: 11, y: 10 }], RED, 0);
    display.flush();
    const s = settings('auto');
    display.setStyle(styleFor(s));
    display.flush();
    expect(sink.width).toBe(PLAY_WIDTH * 2);
    expect(same(sink.trail, fromScratch(display, s).trail)).toBe(true);
    expect(sink.trail.some(v => v !== 0)).toBe(true);
  });

  it('new round / eraser: undamaged level, no trails; a late level image keeps the trails', () => {
    const sink = new MemorySink();
    const display = new ArenaDisplay(PLAY_WIDTH, PLAY_HEIGHT, sink, styleFor(settings('off')));
    const level = loadLevelGrid('bricks');
    display.setLevel(level);
    display.restoreLevel();
    display.addTrail([{ x: 1, y: 1 }], RED, 0);
    display.clearRect(0, 0, PLAY_WIDTH, 300);
    display.restoreLevel();
    display.flush();
    expect(sink.trail.every(v => v === 0)).toBe(true);
    expect(sink.level.filter(v => v !== 0).length).toBe(level.count());

    display.addTrail([{ x: 1, y: 1 }], RED, 0);
    display.restoreLevel(true);
    display.flush();
    expect(sink.trail.filter(v => v !== 0).length).toBe(1);
  });

  it('a snapshot is split into trails (player colours) and level', () => {
    const arena = new PixelGrid();
    arena.set(5, 5, RED);
    arena.set(6, 5, '#123456');
    const sink = new MemorySink();
    const display = new ArenaDisplay(PLAY_WIDTH, PLAY_HEIGHT, sink, styleFor(settings('off')));
    display.paintSnapshot(arena, color => (color === RED ? 0 : null));
    display.flush();
    expect(sink.trail[5 * PLAY_WIDTH + 5]).toBe(packCss(RED));
    expect(sink.trail[5 * PLAY_WIDTH + 6]).toBe(0);
    expect(sink.level[5 * PLAY_WIDTH + 6]).toBe(packCss('#123456'));
  });
});

describe('display settings', () => {
  it('URL over stored over defaults; unknown values are ignored', () => {
    expect(parseDisplaySettings('')).toEqual(DEFAULT_DISPLAY);
    expect(parseDisplaySettings('?shade=half&head=ring&fx=shadow,tracer,nope')).toEqual(
      { shade: 'half', head: 'ring', fx: ['shadow', 'tracer'] });
    expect(parseDisplaySettings('?shade=bogus', 'shade=auto&head=box&fx=fade')).toEqual(
      { shade: 'auto', head: 'box', fx: ['fade'] });
    expect(parseDisplaySettings('?fx=', 'fx=fade').fx).toEqual([]);
    expect(parseDisplaySettings('?fx=all').fx.length).toBe(4);
    const s: DisplaySettings = { shade: 'outline', head: 'dot', fx: ['pattern'] };
    expect(parseDisplaySettings(formatDisplaySettings(s))).toEqual(s);
  });
});
