import { describe, expect, it } from 'vitest';
import { ArenaDisplay } from '../src/game/display/ArenaDisplay';
import type { LayerSink } from '../src/game/display/ArenaDisplay';
import { DisplayCells, KIND_LEVEL, KIND_TRAIL, luminance, packCss, packRgba, shadeCells, trailColor } from '../src/game/display/shade';
import {
  DEFAULT_DISPLAY, HEAD_VARIANTS, SHADE_VARIANTS, formatDisplaySettings, haloFor, parseDisplaySettings,
  resolveDisplay, styleFor as styleForEnv,
} from '../src/game/display/settings';
import type { DisplayEnv, DisplaySettings } from '../src/game/display/settings';
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

const PHONE: DisplayEnv = { cssPerLogical: 0.65, lightBackground: false };
const DESKTOP: DisplayEnv = { cssPerLogical: 1.275, lightBackground: false };
const PAPER_PHONE: DisplayEnv = { cssPerLogical: 0.65, lightBackground: true };
const styleFor = (s: DisplaySettings, env: DisplayEnv = PHONE) => styleForEnv(s, env);

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

  /** The lit pixels of the trail layer for one red trail cell at (3, 3) of an 8×8 arena. */
  function oneCell(shade: DisplaySettings['shade'], env: DisplayEnv = PHONE): { S: number; trail: Uint32Array; lit: string[] } {
    const cells = new DisplayCells(8, 8);
    cells.set(3, 3, KIND_TRAIL, packCss(RED));
    const style = styleFor(settings(shade), env);
    const S = style.scale;
    const level = new Uint32Array(64 * S * S);
    const trail = new Uint32Array(64 * S * S);
    shadeCells(cells, style, 0, 0, 8, 8, level, trail);
    const lit: string[] = [];
    for (let y = 0; y < 8 * S; y++) for (let x = 0; x < 8 * S; x++) if (trail[y * 8 * S + x] !== 0) lit.push(`${x},${y}`);
    return { S, trail, lit };
  }
  const core = packRgba(0xff, 0x44, 0x44);

  it('thin: a 2×2 core with one sub-pixel (half a pixel) of shade all around', () => {
    const { S, trail, lit } = oneCell('thin');
    expect(S).toBe(2);
    expect(trail.filter(v => v === core).length).toBe(4);
    // Sub-pixels 5..8 in both axes: the core (6..7) plus one on each side
    expect(lit.length).toBe(16);
    expect(lit[0]).toBe('5,5');
    expect(lit[15]).toBe('8,8');
    // The fringe is a dimmer red
    expect(luminance(trail[5 * 16 + 6]!)).toBeLessThan(luminance(core));
  });

  it('bold: one full pixel of shade all around, the trail reads three pixels wide', () => {
    const { S, trail, lit } = oneCell('bold');
    expect(S).toBe(1);
    expect(lit.length).toBe(9);
    expect(lit[0]).toBe('2,2');
    expect(lit[8]).toBe('4,4');
    expect(trail[3 * 8 + 3]).toBe(core);
    // Clearly dimmer than the core, clearly brighter than nothing
    const ratio = luminance(trail[3 * 8 + 2]!) / luminance(core);
    expect(ratio).toBeGreaterThan(0.3);
    expect(ratio).toBeLessThan(0.7);
  });

  it('wide: two pixels all around, the second fainter than the first', () => {
    const { trail, lit } = oneCell('wide');
    expect(lit.length).toBe(25);
    expect(trail[3 * 8 + 3]).toBe(core);
    const inner = trail[3 * 8 + 2]!;
    const outer = trail[3 * 8 + 1]!;
    expect(outer >>> 24).toBeLessThan(inner >>> 24);
    expect(outer >>> 24).toBeGreaterThan(0);
  });

  it('auto is bold on a phone and thin on a desktop; off is nothing', () => {
    expect(oneCell('auto', PHONE).lit).toEqual(oneCell('bold', PHONE).lit);
    expect(oneCell('auto', DESKTOP).lit).toEqual(oneCell('thin', DESKTOP).lit);
    expect(oneCell('off').lit).toEqual(['3,3']);
    expect(resolveDisplay({ shade: 'auto', head: 'auto', fx: [] }, PHONE)).toEqual({ shade: 'bold', head: 'soft' });
    expect(resolveDisplay({ shade: 'auto', head: 'auto', fx: [] }, DESKTOP)).toEqual({ shade: 'thin', head: 'ring' });
  });

  it('on a light level the shade is darker than the background needs, not lighter', () => {
    for (const shade of ['thin', 'bold', 'wide'] as const) {
      const { S, trail } = oneCell(shade, PAPER_PHONE);
      const fringe = trail[3 * S * 8 * S + 3 * S - 1]!;   // Just left of the core
      expect(fringe >>> 24, shade).toBeGreaterThan(150);
      expect(luminance(fringe), shade).toBeLessThan(0.1);
    }
  });

  it('a gap between two trails is never closed by the shade, however narrow', () => {
    for (const shade of ['thin', 'bold', 'wide'] as const) {
      const style = styleFor(settings(shade));
      const S = style.scale;
      for (let gap = 1; gap <= 6; gap++) {
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
          const level = new Uint32Array(256 * S * S);
          const trail = new Uint32Array(256 * S * S);
          shadeCells(cells, style, 0, 0, 16, 16, level, trail);
          // Count the gap cells left completely untouched, across the middle of the trails
          let clear = 0;
          for (let g = 0; g < gap; g++) {
            const cx = vertical ? 5 + g : 8;
            const cy = vertical ? 8 : 5 + g;
            let lit = 0;
            for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) if (trail[(cy * S + sy) * 16 * S + cx * S + sx] !== 0) lit++;
            if (lit === 0) clear++;
          }
          expect(clear, `${shade}, gap ${gap}, ${vertical ? 'vertical' : 'horizontal'}`).toBeGreaterThanOrEqual(1);
          // The outer sides are shaded all the same
          const outer = vertical ? trail[(8 * S) * 16 * S + 4 * S - 1]! : trail[(4 * S - 1) * 16 * S + 8 * S]!;
          expect(outer, shade).not.toBe(0);
        }
      }
    }
  });

  it('boost lightens the dark trail colours only, and not on a light level', () => {
    const boosted = styleFor(settings('bold', ['boost']));
    const blue = packCss('#4444ff');
    const purple = packCss('#aa00aa');
    expect(luminance(trailColor(boosted, blue))).toBeGreaterThan(luminance(blue) * 1.8);
    expect(luminance(trailColor(boosted, purple))).toBeGreaterThan(luminance(purple) * 1.8);
    for (const color of [RED, GREEN, '#ffff44', '#aa6600']) {
      expect(trailColor(boosted, packCss(color)), color).toBe(packCss(color));
    }
    expect(trailColor(styleFor(settings('bold', ['boost']), PAPER_PHONE), blue)).toBe(blue);
    expect(trailColor(styleFor(settings('off', ['boost'])), blue)).toBe(blue);   // off is the plain picture
    expect(trailColor(styleFor(settings('bold')), blue)).toBe(blue);
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
      const s = settings(shade, ['shadow', 'boost']);
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
    for (const [shade, most] of [['thin', 36], ['bold', 36], ['wide', 100]] as const) {
      const display = new ArenaDisplay(PLAY_WIDTH, PLAY_HEIGHT, sink, styleFor(settings(shade)));
      display.flush();
      for (let slot = 0; slot < 4; slot++) {
        display.addTrail([{ x: 100 * slot + 10, y: 50 }, { x: 100 * slot + 11, y: 51 }], RED);
      }
      display.flush();
      expect(display.lastFlushCells, shade).toBeLessThanOrEqual(4 * most);
    }
  });

  it('switching the variant keeps the cells', () => {
    const sink = new MemorySink();
    const display = new ArenaDisplay(PLAY_WIDTH, PLAY_HEIGHT, sink, styleFor(settings('off')));
    display.addTrail([{ x: 10, y: 10 }, { x: 11, y: 10 }], RED);
    display.flush();
    const s = settings('thin');
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
    const display = new ArenaDisplay(PLAY_WIDTH, PLAY_HEIGHT, sink, styleFor(settings('off')));
    display.paintSnapshot(arena, color => color === RED);
    display.flush();
    expect(sink.trail[5 * PLAY_WIDTH + 5]).toBe(packCss(RED));
    expect(sink.trail[5 * PLAY_WIDTH + 6]).toBe(0);
    expect(sink.level[5 * PLAY_WIDTH + 6]).toBe(packCss('#123456'));
  });
});

describe('display settings', () => {
  it('URL over stored over defaults; unknown values are ignored', () => {
    expect(parseDisplaySettings('')).toEqual(DEFAULT_DISPLAY);
    expect(parseDisplaySettings('?shade=bold&head=soft&fx=shadow,tracer,nope')).toEqual(
      { shade: 'bold', head: 'soft', fx: ['shadow', 'tracer'] });
    expect(parseDisplaySettings('?shade=bogus', 'shade=wide&head=ring&fx=fade')).toEqual(
      { shade: 'wide', head: 'ring', fx: ['fade'] });
    // What an earlier version of this branch may have left in localStorage
    expect(parseDisplaySettings('', 'shade=half&head=box&fx=pattern')).toEqual({ ...DEFAULT_DISPLAY, fx: [] });
    expect(parseDisplaySettings('?fx=', 'fx=fade').fx).toEqual([]);
    expect(parseDisplaySettings('?fx=all').fx.length).toBe(4);
    const s: DisplaySettings = { shade: 'thin', head: 'wide', fx: ['boost'] };
    expect(parseDisplaySettings(formatDisplaySettings(s))).toEqual(s);
  });

  it('every head variant is a halo that fades outwards', () => {
    for (const head of HEAD_VARIANTS) {
      if (head === 'auto') continue;
      const halo = haloFor(head);
      expect(halo.length, head).toBeGreaterThanOrEqual(1);
      for (let i = 1; i < halo.length; i++) expect(halo[i]!, head).toBeLessThan(halo[i - 1]!);
      for (const alpha of halo) expect(alpha, head).toBeLessThan(1);   // Transparent: never a solid block
    }
  });
});

describe('display follows the game', () => {
  it('fed with the frame events of a real match, the display bitmap is the collision bitmap cell for cell', async () => {
    const { TronGameState } = await import('../src/game/TronGameState');
    const { BotController } = await import('../src/game/ai/BotController');
    const { makePlayers } = await import('./helpers');
    const s = settings('wide', ['shadow', 'boost']);
    const sink = new MemorySink();
    const display = new ArenaDisplay(PLAY_WIDTH, PLAY_HEIGHT, sink, styleFor(s));
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
    const expected = fromScratch(display, s);
    expect(same(sink.trail, expected.trail)).toBe(true);
    expect(same(sink.level, expected.level)).toBe(true);
  }, 120_000);
});
