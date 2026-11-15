import { describe, expect, it } from 'vitest';
import { ArenaDisplay } from '../src/game/display/ArenaDisplay';
import type { LayerSink } from '../src/game/display/ArenaDisplay';
import { KIND_TRAIL, packCss, packRgba, shadeCells } from '../src/game/display/shade';
import type { ShadeStyle } from '../src/game/display/shade';
import { SOFT } from '../src/game/display/settings';
import { PixelGrid } from '../src/game/PixelGrid';
import { PLAY_WIDTH, PLAY_HEIGHT } from '../src/game/constants';
import { createRng } from '../src/game/rng';
import { loadLevelGrid } from './helpers';
import { PathTracker, SmoothLineKeeper, SmoothLines } from '../src/game/display/SmoothLines';
import type { TronPlayerState } from '../src/types/game';

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

/** No shade at all: only used here, to tell the cells from what is derived from them. */
const PLAIN: ShadeStyle = { scale: 1, bands: [] };
const STYLES: [string, ShadeStyle][] = [['soft', SOFT]];

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

/** A display with a red trail along a path given in pixels with fractions, as the game feeds it. */
function drive(path: [number, number][]): { sink: MemorySink; display: ArenaDisplay } {
  const sink = new MemorySink();
  const display = new ArenaDisplay(PLAY_WIDTH, PLAY_HEIGHT, sink, SOFT);
  for (let i = 1; i < path.length; i++) {
    const [ax, ay] = path[i - 1]!;
    const [bx, by] = path[i]!;
    // The pixel the player left becomes trail; the stretch it moved becomes smooth line
    if (Math.floor(ax) !== Math.floor(bx) || Math.floor(ay) !== Math.floor(by)) {
      display.addTrail([{ x: Math.floor(ax), y: Math.floor(ay) }], RED);
    }
    display.addPath(ax, ay, bx, by, RED);
  }
  display.flush();
  return { sink, display };
}
const at = (sink: MemorySink, x: number, y: number): number => sink.trail[y * PLAY_WIDTH + x]!;
const straight = (y: number): [number, number][] => Array.from({ length: 21 }, (_, i) => [100.5 + i, y] as [number, number]);

describe('smooth line over the hard trail', () => {
  it('the trail itself is a hard pixel of the player colour, exactly where the obstacle is', () => {
    const { sink } = drive(straight(50.3));
    for (let x = 100; x < 120; x++) expect(at(sink, x, 50)).toBe(core);
  });

  it('a path through the middle of its pixels adds nothing: the line covers only them', () => {
    const { sink } = drive(straight(50.5));
    for (let x = 98; x < 123; x++) {
      expect(at(sink, x, 49)).toBe(0);
      expect(at(sink, x, 51)).toBe(0);
    }
  });

  it('a path off-centre spills onto the next row in proportion to how far off it is', () => {
    // 0.3 below the top of row 50: the line covers 80 % of row 50 and 20 % of row 49
    const a = drive(straight(50.3)).sink;
    expect(rgbOf(at(a, 110, 49))).toBe(rgbOf(core));
    expect(alphaOf(at(a, 110, 49))).toBeCloseTo(0.2, 1);
    expect(at(a, 110, 51)).toBe(0);
    // On the border between two rows: half and half (the hard pixel is the lower row)
    const b = drive(straight(50.0)).sink;
    expect(at(b, 110, 50)).toBe(core);
    expect(alphaOf(at(b, 110, 49))).toBeCloseTo(0.5, 1);
    // 0.2 above the bottom of row 50
    const c = drive(straight(50.8)).sink;
    expect(alphaOf(at(c, 110, 51))).toBeCloseTo(0.3, 1);
    expect(at(c, 110, 49)).toBe(0);
  });

  it('a slanted path fills the steps of its staircase, never further than one pixel away', () => {
    const path: [number, number][] = Array.from({ length: 41 }, (_, i) => [100.5 + i, 50.5 + i * 0.4] as [number, number]);
    const { sink, display } = drive(path);
    let soft = 0;
    for (let y = 40; y < 80; y++) {
      for (let x = 95; x < 150; x++) {
        const pixel = at(sink, x, y);
        if (pixel === 0 || pixel === core) continue;
        soft++;
        expect(alphaOf(pixel)).toBeLessThan(1);
        // Next to a trail cell
        let near = false;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (display.cells.kind[(y + dy) * PLAY_WIDTH + x + dx] === KIND_TRAIL) near = true;
        expect(near, `${x},${y}`).toBe(true);
      }
    }
    expect(soft).toBeGreaterThan(30);
  });

  it('it is not drawn over a wall or another trail, and goes when the trail is erased', () => {
    const { sink, display } = drive(straight(50.0));
    display.addLevel([{ x: 105, y: 49 }], '#808080');
    display.addTrail([{ x: 106, y: 49 }], GREEN);
    display.flush();
    expect(at(sink, 105, 49)).toBe(0);
    expect(sink.level[49 * PLAY_WIDTH + 105]).toBe(packRgba(0x80, 0x80, 0x80));
    expect(at(sink, 106, 49)).toBe(packRgba(0x44, 0xff, 0x44));
    // A tracer along the trail erases the hard pixels and the smooth line beside them
    display.clearLine(95, 50, 125, 50);
    display.flush();
    for (let x = 95; x < 126; x++) {
      if (x !== 106) expect(at(sink, x, 49), `${x}`).toBe(0);
      expect(at(sink, x, 50)).toBe(0);
    }
  });
});

describe('gaps stay open', () => {
  it('a free pixel between two trails (or a trail and a wall) shows no smooth line', () => {
    // Two trails one pixel apart, both spilling onto the row between them
    const { sink, display } = drive(straight(50.8));          // Hard row 50, 30 % on row 51
    for (let x = 100; x < 120; x++) display.addTrail([{ x, y: 52 }], GREEN);
    display.addPath(100.5, 52.2, 120.5, 52.2, GREEN);         // 30 % on row 51 too
    display.flush();
    for (let x = 101; x < 119; x++) expect(at(sink, x, 51), `x=${x}`).toBe(0);
    expect(alphaOf(at(sink, 110, 53))).toBe(0);                // Nothing below, either: centred enough
    // The outer side of a trail keeps its line
    const outer = drive(straight(50.3));
    for (let x = 100; x < 120; x++) outer.display.addTrail([{ x, y: 52 }], GREEN);
    outer.display.flush();
    expect(alphaOf(at(outer.sink, 110, 49))).toBeCloseTo(0.2, 1);
    // Against a wall, and diagonally
    const wall = drive(straight(50.8));
    wall.display.addLevel([{ x: 110, y: 52 }], '#808080');
    wall.display.addLevel([{ x: 105, y: 52 }], '#808080');   // Diagonal to (104, 51) and (106, 51)
    wall.display.flush();
    expect(at(wall.sink, 110, 51)).toBe(0);
    expect(at(wall.sink, 104, 51)).toBe(0);                    // Between (103, 50) and (105, 52)
    expect(alphaOf(at(wall.sink, 108, 51))).toBeCloseTo(0.3, 1);
    // The gap opens again when one side is erased
    wall.display.clearRect(110, 52, 1, 1);
    wall.display.addPath(100.5, 50.8, 120.5, 50.8, RED);
    wall.display.flush();
    expect(alphaOf(at(wall.sink, 110, 51))).toBeCloseTo(0.3, 1);
  });
});

describe('smooth lines as data', () => {
  const red = packCss(RED), green = packCss(GREEN);

  it('lines of different colours add up like translucent layers; one colour keeps its most', () => {
    const lines = new SmoothLines(20, 20);
    lines.addPath(2.5, 5.2, 12.5, 5.2, red);     // 30 % on row 4
    lines.addPath(2.5, 5.2, 12.5, 5.2, red);
    expect(lines.alpha[4 * 20 + 6]! / 255).toBeCloseTo(0.3, 1);
    lines.addPath(2.5, 3.9, 12.5, 3.9, green);   // 40 % on row 4, from the other side
    expect(lines.alpha[4 * 20 + 6]! / 255).toBeCloseTo(0.3 + 0.4 - 0.12, 1);
    expect(lines.color[4 * 20 + 6]).toBe(green); // The stronger of the two
  });

  it('survives the trip in a snapshot', () => {
    const lines = new SmoothLines(PLAY_WIDTH, PLAY_HEIGHT);
    const rng = createRng(3);
    for (let n = 0; n < 300; n++) {
      const x = rng() * PLAY_WIDTH, y = rng() * PLAY_HEIGHT;
      lines.addPath(x, y, x + rng() * 6 - 3, y + rng() * 6 - 3, n % 2 ? red : green);
    }
    const data = lines.encode();
    const copy = new SmoothLines(PLAY_WIDTH, PLAY_HEIGHT);
    copy.addPath(1, 1, 5, 5, red);               // Replaced by the load
    copy.load(data);
    let covered = 0;
    for (let i = 0; i < lines.alpha.length; i++) {
      if (lines.alpha[i] !== copy.alpha[i]) throw new Error(`alpha differs at ${i}`);
      if (lines.alpha[i] !== 0) {
        covered++;
        if (lines.color[i] !== copy.color[i]) throw new Error(`colour differs at ${i}`);
      }
    }
    expect(covered).toBeGreaterThan(1000);
    expect(data.data.length).toBeLessThan(covered * 4);
    // Garbage does not throw
    copy.load({ palette: [], data: Uint8Array.from([200, 200, 200, 7, 9]) });
    copy.load(undefined);
    expect(copy.alpha.some(a => a !== 0)).toBe(false);
  });

  it('a path through an edge of the arena is drawn on both sides; a jump is not drawn', () => {
    const tracker = new PathTracker(PLAY_WIDTH, PLAY_HEIGHT);
    const out: number[][] = [];
    const player = (x: number, y: number): TronPlayerState[] =>
      [{ slotIndex: 0, alive: true, x: x * 1000, y: y * 1000 } as TronPlayerState];
    const emit = (_slot: number, ...p: number[]): void => { out.push(p); };
    tracker.update(player(748.5, 100.25), emit);
    tracker.update(player(749.75, 100.25), emit);
    tracker.update(player(1, 100.25), emit);       // Wrapped
    expect(out).toEqual([[748.5, 100.25, 749.75, 100.25], [749.75, 100.25, 751, 100.25], [-0.25, 100.25, 1, 100.25]]);
    out.length = 0;
    tracker.update(player(300, 400), emit);        // Portal
    expect(out).toEqual([]);
    tracker.update(player(301, 400), emit);
    expect(out).toEqual([[300, 400, 301, 400]]);
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
          const color = [RED, GREEN, '#4444ff'][int(3)]!;
          display.addTrail(points, color);
          // And the smooth line of a path through those pixels, somewhere off their centres
          const ox = rng(), oy = rng();
          for (let i = 1; i < points.length; i++) {
            const a = points[i - 1]!, b = points[i]!;
            if (Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1) display.addPath(a.x + ox, a.y + oy, b.x + ox, b.y + oy, color);
          }
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
    // What the host keeps for snapshots, and the paths as the view feeds them
    const keeper = new SmoothLineKeeper(PLAY_WIDTH, PLAY_HEIGHT, slot => packCss(players[slot]!.color));
    const tracker = new PathTracker(PLAY_WIDTH, PLAY_HEIGHT);
    let softCells = 0;

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
      // The host's smooth lines are the view's, and a late joiner gets them from the snapshot
      const joined = new ArenaDisplay(PLAY_WIDTH, PLAY_HEIGHT, new MemorySink(), SOFT);
      joined.loadSmoothLines(keeper.lines.encode());
      let softWrong = 0;
      for (let i = 0; i < PLAY_WIDTH * PLAY_HEIGHT; i++) {
        const a = display.cells.softAlpha[i]!;
        if (a !== 0) softCells++;
        if (a !== keeper.lines.alpha[i] || a !== joined.cells.softAlpha[i]) softWrong++;
        else if (a !== 0 && (display.cells.softColor[i] !== keeper.lines.color[i] || display.cells.softColor[i] !== joined.cells.softColor[i])) softWrong++;
      }
      expect(softWrong).toBe(0);
      checks++;
    };

    for (let tick = 0; tick < 70 * 90; tick++) {
      bots.forEach((bot, i) => inputs.set(players[i]!.slotIndex, bot.decide(game)));
      game.tick(inputs);
      const f = game.serialize();
      // Same order as TronGame.applyFrameEvents
      keeper.apply(f);
      if (f.roundStarted) tracker.reset();
      if (f.roundStarted || f.eraserUsed) display.restoreLevel();
      for (const { slotIndex, segments } of f.newTrailSegments) display.addTrail(segments, players[slotIndex]!.color);
      if (f.round.phase === 'playing') {
        tracker.update(f.round.players, (slot, ax, ay, bx, by) => display.addPath(ax, ay, bx, by, players[slot]!.color));
      }
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
    expect(softCells).toBeGreaterThan(1000);
    expect(erased).toBeGreaterThan(20);           // Weapons were used: the erasing paths ran
    expect(game.currentRound).toBeGreaterThan(1);
    // And what is on the layers is what a derivation from scratch gives: no ghosts
    const expected = fromScratch(display, SOFT);
    expect(same(sink.trail, expected.trail)).toBe(true);
    expect(same(sink.level, expected.level)).toBe(true);
  }, 120_000);
});
