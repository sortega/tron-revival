// PixelGrid - collision map of the play area.
// Each cell stores a palette index (0 = empty) so lookups are allocation-free.

import { PLAY_WIDTH, PLAY_HEIGHT } from './constants';

function wrap(v: number, size: number): number {
  // Nearly always inside already: the modulo is the slow part of a line walk
  return v >= 0 && v < size ? v : ((v % size) + size) % size;
}

/**
 * Visit every pixel of the line (x0,y0)-(x1,y1) (Bresenham, endpoints included).
 * Coordinates may lie outside the play area; visited coordinates are wrapped.
 * Return `true` from the callback to stop early.
 */
export function forEachLinePixel(
  x0: number, y0: number, x1: number, y1: number,
  fn: (x: number, y: number, rawX: number, rawY: number) => boolean | void
): void {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0;
  let y = y0;
  for (;;) {
    if (fn(wrap(x, PLAY_WIDTH), wrap(y, PLAY_HEIGHT), x, y)) return;
    if (x === x1 && y === y1) return;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
}

// Coarse occupancy: the arena divided in COARSE_CELL-pixel squares, each counting its
// occupied pixels. Lets bots reason about free space without scanning every pixel.
export const COARSE_CELL = 8;
export const COARSE_COLS = Math.ceil(PLAY_WIDTH / COARSE_CELL);
export const COARSE_ROWS = Math.ceil(PLAY_HEIGHT / COARSE_CELL);

export class PixelGrid {
  readonly width = PLAY_WIDTH;
  readonly height = PLAY_HEIGHT;
  /**
   * Palette index per pixel, row by row (0 = empty). Exposed read-only for hot loops
   * (bot rollouts); all writes go through the methods below.
   */
  readonly cells = new Uint16Array(PLAY_WIDTH * PLAY_HEIGHT);
  /** Occupied pixels per coarse cell, row by row. Read-only outside this class. */
  readonly coarse = new Uint16Array(COARSE_COLS * COARSE_ROWS);
  private palette: string[] = [''];
  private paletteIndex = new Map<string, number>();

  // Write one cell, keeping the coarse counts in sync. `i` must be in range.
  private write(i: number, value: number): void {
    const old = this.cells[i]!;
    if ((old === 0) !== (value === 0)) {
      const x = i % PLAY_WIDTH;
      const y = (i - x) / PLAY_WIDTH;
      const c = Math.floor(y / COARSE_CELL) * COARSE_COLS + Math.floor(x / COARSE_CELL);
      this.coarse[c] = this.coarse[c]! + (value === 0 ? -1 : 1);
    }
    this.cells[i] = value;
  }

  /** True if the coarse cell (column, row) contains no occupied pixel. Wraps. */
  coarseFree(col: number, row: number): boolean {
    const c = ((row % COARSE_ROWS) + COARSE_ROWS) % COARSE_ROWS * COARSE_COLS
      + ((col % COARSE_COLS) + COARSE_COLS) % COARSE_COLS;
    return this.coarse[c] === 0;
  }

  private inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < PLAY_WIDTH && y < PLAY_HEIGHT;
  }

  /** True if the pixel is occupied. Out-of-bounds pixels are empty. */
  has(x: number, y: number): boolean {
    return this.inBounds(x, y) && this.cells[y * PLAY_WIDTH + x] !== 0;
  }

  /** Like `has`, but wraps coordinates around the arena edges. */
  hasWrapped(x: number, y: number): boolean {
    return this.cells[wrap(y, PLAY_HEIGHT) * PLAY_WIDTH + wrap(x, PLAY_WIDTH)] !== 0;
  }

  /** The value `cells` holds for pixels of this colour, or -1 if there are none. */
  paletteIndexOf(color: string): number {
    return this.paletteIndex.get(color) ?? -1;
  }

  /** Colour of the pixel, or null if empty. */
  get(x: number, y: number): string | null {
    if (!this.inBounds(x, y)) return null;
    const idx = this.cells[y * PLAY_WIDTH + x]!;
    return idx === 0 ? null : this.palette[idx]!;
  }

  set(x: number, y: number, color: string): void {
    if (!this.inBounds(x, y)) return;
    let idx = this.paletteIndex.get(color);
    if (idx === undefined) {
      idx = this.palette.length;
      this.palette.push(color);
      this.paletteIndex.set(color, idx);
    }
    this.write(y * PLAY_WIDTH + x, idx);
  }

  delete(x: number, y: number): void {
    if (this.inBounds(x, y)) this.write(y * PLAY_WIDTH + x, 0);
  }

  clear(): void {
    this.cells.fill(0);
    this.coarse.fill(0);
  }

  /**
   * Clear a w×h rectangle whose top-left corner is (x, y), wrapping around edges.
   * Returns true if any pixel in it was occupied.
   */
  clearRect(x: number, y: number, w: number, h: number): boolean {
    const cells = this.cells;
    let cleared = false;
    for (let dy = 0; dy < h; dy++) {
      const row = wrap(y + dy, PLAY_HEIGHT) * PLAY_WIDTH;
      for (let dx = 0; dx < w; dx++) {
        const i = row + wrap(x + dx, PLAY_WIDTH);
        if (cells[i] !== 0) {
          this.write(i, 0);
          cleared = true;
        }
      }
    }
    return cleared;
  }

  /** Clear every pixel on a line (wrapping). Returns true if any of them was occupied. */
  clearLine(x0: number, y0: number, x1: number, y1: number): boolean {
    // Bresenham, as in forEachLinePixel
    const cells = this.cells;
    let cleared = false;
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let x = x0;
    let y = y0;
    for (;;) {
      const i = wrap(y, PLAY_HEIGHT) * PLAY_WIDTH + wrap(x, PLAY_WIDTH);
      if (cells[i] !== 0) {
        this.write(i, 0);
        cleared = true;
      }
      if (x === x1 && y === y1) return cleared;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
  }

  /**
   * First occupied pixel on a line (wrapping), or null. `rawX`/`rawY` are the same
   * pixel before wrapping, i.e. on the line as given.
   */
  firstHitOnLine(
    x0: number, y0: number, x1: number, y1: number
  ): { x: number; y: number; rawX: number; rawY: number } | null {
    // Bresenham, as in forEachLinePixel (this runs for every projectile every tick)
    const cells = this.cells;
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let x = x0;
    let y = y0;
    for (;;) {
      const wx = wrap(x, PLAY_WIDTH);
      const wy = wrap(y, PLAY_HEIGHT);
      if (cells[wy * PLAY_WIDTH + wx] !== 0) return { x: wx, y: wy, rawX: x, rawY: y };
      if (x === x1 && y === y1) return null;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
  }

  /** Replace the contents of this grid with a copy of another. */
  copyFrom(other: PixelGrid): void {
    this.palette = [...other.palette];
    this.paletteIndex = new Map(other.paletteIndex);
    this.cells.set(other.cells);
    this.coarse.set(other.coarse);
  }

  /** Run-length encoding of the whole grid: palette + [paletteIndex, count, ...]. */
  toRuns(): { palette: string[]; runs: number[] } {
    const runs: number[] = [];
    let current = this.cells[0]!;
    let count = 0;
    for (let i = 0; i < this.cells.length; i++) {
      const value = this.cells[i]!;
      if (value === current) {
        count++;
      } else {
        runs.push(current, count);
        current = value;
        count = 1;
      }
    }
    runs.push(current, count);
    return { palette: [...this.palette], runs };
  }

  /** Inverse of `toRuns`. Malformed input yields a (partially) empty grid, never throws. */
  static fromRuns(palette: readonly string[], runs: readonly number[]): PixelGrid {
    const grid = new PixelGrid();
    let i = 0;
    for (let r = 0; r + 1 < runs.length && i < grid.cells.length; r += 2) {
      const color = palette[runs[r]!];
      const count = Math.max(0, Math.floor(runs[r + 1]!)) || 0;
      const end = Math.min(grid.cells.length, i + count);
      if (runs[r] !== 0 && typeof color === 'string' && color !== '') {
        for (; i < end; i++) grid.set(i % PLAY_WIDTH, Math.floor(i / PLAY_WIDTH), color);
      }
      i = end;
    }
    return grid;
  }

  /** Visit every horizontal run of same-coloured occupied pixels. */
  forEachRun(fn: (x: number, y: number, length: number, color: string) => void): void {
    for (let y = 0; y < PLAY_HEIGHT; y++) {
      const row = y * PLAY_WIDTH;
      let x = 0;
      while (x < PLAY_WIDTH) {
        const value = this.cells[row + x]!;
        let end = x + 1;
        while (end < PLAY_WIDTH && this.cells[row + end] === value) end++;
        if (value !== 0) fn(x, y, end - x, this.palette[value]!);
        x = end;
      }
    }
  }

  /** Number of occupied pixels (O(n); for tests and diagnostics). */
  count(): number {
    let n = 0;
    for (let i = 0; i < this.cells.length; i++) if (this.cells[i] !== 0) n++;
    return n;
  }

  /**
   * Build a grid from RGBA pixel data of a PLAY_WIDTH×PLAY_HEIGHT level image.
   * Every non-black pixel is an obstacle.
   */
  static fromRgba(data: ArrayLike<number>): PixelGrid {
    const grid = new PixelGrid();
    for (let y = 0; y < PLAY_HEIGHT; y++) {
      for (let x = 0; x < PLAY_WIDTH; x++) {
        const i = (y * PLAY_WIDTH + x) * 4;
        const r = data[i] ?? 0;
        const g = data[i + 1] ?? 0;
        const b = data[i + 2] ?? 0;
        if (r !== 0 || g !== 0 || b !== 0) {
          grid.set(x, y, '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1));
        }
      }
    }
    return grid;
  }
}
