// SmoothLines - the translucent part of the trails (design/display-layer.md): for every
// cell, how much the one-pixel-wide line along the path the players really followed covers
// it (0-255) and in what colour. Never an obstacle. Pure and headless: the host keeps one
// next to the simulation so that it can travel in the snapshot of a game in progress, and
// every view keeps one inside its display bitmap.

import { forEachLinePixel } from '../PixelGrid';
import type { SlotIndex } from '../../types/lobby';
import type { TronGameStateData, TronPlayerState } from '../../types/game';

/** Points per pixel of path at which a line is sampled. */
const PATH_SAMPLES = 4;
/** A player moving further than this in a frame did not travel there (portal, swap). */
const PATH_JUMP = 8;

/** The lines of a whole arena, compact enough for a snapshot. */
export interface SmoothLinesData {
  palette: number[];   // Packed colours
  /** Runs of covered cells: varint gap, varint length, then (alpha, palette index) per cell. */
  data: Uint8Array;
}

export class SmoothLines {
  readonly alpha: Uint8Array;
  readonly color: Uint32Array;

  constructor(readonly width: number, readonly height: number) {
    this.alpha = new Uint8Array(width * height);
    this.color = new Uint32Array(width * height);
  }

  /**
   * A point of a path, in pixels (a pixel spans [n, n+1)): the 1×1 square centred on it
   * is shared out among the up to four cells it overlaps, in proportion to the overlap.
   * Along one trail (one colour) a cell keeps the most it was ever covered; the line of
   * another colour adds to it as one translucent layer over another, and the cell takes
   * the colour of the stronger of the two.
   */
  splat(px: number, py: number, color: number): void {
    const fx = Math.floor(px - 0.5);
    const fy = Math.floor(py - 0.5);
    const wx = px - 0.5 - fx;
    const wy = py - 0.5 - fy;
    for (let dy = 0; dy < 2; dy++) {
      const y = fy + dy;
      if (y < 0 || y >= this.height) continue;
      for (let dx = 0; dx < 2; dx++) {
        const x = fx + dx;
        if (x < 0 || x >= this.width) continue;
        const cover = Math.round(255 * (dx === 0 ? 1 - wx : wx) * (dy === 0 ? 1 - wy : wy));
        if (cover === 0) continue;
        const i = y * this.width + x;
        const under = this.mixed.get(i);
        if (under) {
          // Over another trail's line: this path's most, as a layer over what was there
          if (cover > under.cover) {
            under.cover = cover;
            this.alpha[i] = under.alpha + cover - Math.round((under.alpha * cover) / 255);
            this.color[i] = cover > under.alpha ? color : under.color;
          }
          continue;
        }
        const had = this.alpha[i]!;
        if (had === 0 || this.color[i] === color) {
          if (cover > had) {
            this.alpha[i] = cover;
            this.color[i] = color;
          }
        } else {
          this.mixed.set(i, { alpha: had, color: this.color[i]!, cover: 0 });
          dx--;   // Again, now as a layer
        }
      }
    }
  }

  // Cells where the path being drawn lies over another trail's line: what was there, and
  // the most this path covered them
  private readonly mixed = new Map<number, { alpha: number; color: number; cover: number }>();

  /**
   * The path from (ax, ay) to (bx, by), in pixels with fractions. `touched` is told the
   * cell of every sample.
   */
  addPath(ax: number, ay: number, bx: number, by: number, color: number, touched?: (x: number, y: number) => void): void {
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) * PATH_SAMPLES));
    if (this.mixed.size > 0) this.mixed.clear();
    for (let i = 0; i <= steps; i++) {
      const x = ax + ((bx - ax) * i) / steps;
      const y = ay + ((by - ay) * i) / steps;
      this.splat(x, y, color);
      touched?.(Math.floor(x), Math.floor(y));
    }
  }

  /**
   * Erase the lines on the cells (x0, y0)-(x1, y1), inclusive and inside the arena, and one
   * cell around them: a line never reaches further than that from the trail cells of its
   * path, so erasing it around erased cells leaves no ghost.
   */
  clearAround(x0: number, y0: number, x1: number, y1: number): void {
    const xa = Math.max(0, x0 - 1), xb = Math.min(this.width - 1, x1 + 1);
    for (let y = Math.max(0, y0 - 1); y <= Math.min(this.height - 1, y1 + 1); y++) {
      this.alpha.fill(0, y * this.width + xa, y * this.width + xb + 1);
    }
  }

  clearAll(): void {
    this.alpha.fill(0);
  }

  /** As ArenaDisplay.clearRect: a w×h rectangle from (x, y), wrapping around the edges. */
  clearRect(x: number, y: number, w: number, h: number): void {
    const W = this.width, H = this.height;
    const x0 = ((x % W) + W) % W;
    const y0 = ((y % H) + H) % H;
    const xs: [number, number][] = x0 + w > W ? [[x0, W - x0], [0, Math.min(W, x0 + w - W)]] : [[x0, w]];
    const ys: [number, number][] = y0 + h > H ? [[y0, H - y0], [0, Math.min(H, y0 + h - H)]] : [[y0, h]];
    for (const [rx, rw] of xs) {
      for (const [ry, rh] of ys) {
        // Row by row, as the display does: the cell around each row
        for (let yy = ry; yy < ry + rh; yy++) this.clearAround(rx, yy, rx + rw - 1, yy);
      }
    }
  }

  /** As ArenaDisplay.clearLine (wrapping). */
  clearLine(x0: number, y0: number, x1: number, y1: number): void {
    forEachLinePixel(x0, y0, x1, y1, (x, y) => {
      if (x >= 0 && y >= 0 && x < this.width && y < this.height) this.clearAround(x, y, x, y);
    });
  }

  encode(): SmoothLinesData {
    const palette: number[] = [];
    const index = new Map<number, number>();
    const out: number[] = [];
    const varint = (n: number): void => {
      while (n >= 128) {
        out.push((n & 127) | 128);
        n = Math.floor(n / 128);
      }
      out.push(n);
    };
    const { alpha, color } = this;
    let end = 0;   // One past the last run
    for (let i = 0; i < alpha.length; i++) {
      if (alpha[i] === 0) continue;
      let j = i;
      while (j < alpha.length && alpha[j] !== 0) j++;
      varint(i - end);
      varint(j - i);
      for (let k = i; k < j; k++) {
        let p = index.get(color[k]!);
        if (p === undefined) {
          p = Math.min(255, palette.length);
          if (palette.length < 256) palette.push(color[k]!);
          index.set(color[k]!, p);
        }
        out.push(alpha[k]!, p);
      }
      end = j;
      i = j;
    }
    return { palette, data: Uint8Array.from(out) };
  }

  /** Replace everything with `lines`. Malformed input yields partial lines, never throws. */
  load(lines: SmoothLinesData | undefined | null): void {
    this.clearAll();
    if (!lines || !Array.isArray(lines.palette) || !(lines.data instanceof Uint8Array)) return;
    const { palette, data } = lines;
    let at = 0;
    const varint = (): number => {
      let n = 0, scale = 1;
      while (at < data.length) {
        const b = data[at++]!;
        n += (b & 127) * scale;
        if (b < 128) break;
        scale *= 128;
      }
      return n;
    };
    let i = 0;
    while (at < data.length) {
      i += varint();
      const length = varint();
      for (let k = 0; k < length && at + 1 < data.length; k++, i++) {
        const a = data[at++]!;
        const c = palette[data[at++]!];
        if (i < this.alpha.length && typeof c === 'number') {
          this.alpha[i] = a;
          this.color[i] = c >>> 0;
        }
      }
    }
  }
}

/**
 * Follows the players from frame to frame and reports the stretch each one moved, in
 * pixels with fractions. A stretch across an edge of the arena is reported as its two
 * halves; other jumps (portal, swap) are not reported.
 */
export class PathTracker {
  private readonly last = new Map<SlotIndex, { x: number; y: number }>();

  constructor(private readonly width: number, private readonly height: number) {}

  reset(): void {
    this.last.clear();
  }

  update(
    players: readonly TronPlayerState[],
    emit: (slot: SlotIndex, ax: number, ay: number, bx: number, by: number) => void,
  ): void {
    for (const state of players) {
      if (!state.alive) {
        this.last.delete(state.slotIndex);
        continue;
      }
      // Rounded as on the wire, so that host and guests draw the very same lines
      const x = Math.round(state.x) / 1000;
      const y = Math.round(state.y) / 1000;
      const last = this.last.get(state.slotIndex);
      if (last && (x !== last.x || y !== last.y)) {
        // Through an edge: the same stretch, seen from the other side
        let ux = x, uy = y;
        if (x - last.x > this.width - PATH_JUMP) ux -= this.width;
        else if (last.x - x > this.width - PATH_JUMP) ux += this.width;
        if (y - last.y > this.height - PATH_JUMP) uy -= this.height;
        else if (last.y - y > this.height - PATH_JUMP) uy += this.height;
        if (Math.abs(ux - last.x) < PATH_JUMP && Math.abs(uy - last.y) < PATH_JUMP) {
          emit(state.slotIndex, last.x, last.y, ux, uy);
          if (ux !== x || uy !== y) emit(state.slotIndex, last.x + x - ux, last.y + y - uy, x, y);
        }
      }
      this.last.set(state.slotIndex, { x, y });
    }
  }
}

/**
 * The smooth lines of a game, kept from its frames without a view: what the host puts in
 * the snapshot for those who join late. Applies the same events, in the same order, as
 * the view does to its display bitmap (TronGame.applyFrameEvents).
 */
export class SmoothLineKeeper {
  readonly lines: SmoothLines;
  private readonly tracker: PathTracker;

  constructor(width: number, height: number, private readonly colorOf: (slot: SlotIndex) => number | undefined) {
    this.lines = new SmoothLines(width, height);
    this.tracker = new PathTracker(width, height);
  }

  apply(frame: TronGameStateData): void {
    const lines = this.lines;
    if (frame.roundStarted) {
      this.tracker.reset();
      lines.clearAll();
    }
    if (frame.eraserUsed) lines.clearAll();
    if (frame.round.phase === 'playing') {
      this.tracker.update(frame.round.players, (slot, ax, ay, bx, by) => {
        const color = this.colorOf(slot);
        if (color !== undefined) lines.addPath(ax, ay, bx, by, color);
      });
    }
    const cleared = frame.clearedLines;
    if (cleared) {
      for (let i = 0; i + 3 < cleared.length; i += 4) {
        lines.clearLine(cleared[i]!, cleared[i + 1]!, cleared[i + 2]!, cleared[i + 3]!);
      }
    }
    if (frame.clearedAreas) {
      for (const { x, y, w, h } of frame.clearedAreas) lines.clearRect(x, y, w, h);
    }
  }
}
