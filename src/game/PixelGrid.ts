// PixelGrid - collision map of the play area.
// Each cell stores a palette index (0 = empty) so lookups are allocation-free.

import { PLAY_WIDTH, PLAY_HEIGHT } from './constants';

function wrap(v: number, size: number): number {
  return ((v % size) + size) % size;
}

/**
 * Visit every pixel of the line (x0,y0)-(x1,y1) (Bresenham, endpoints included).
 * Coordinates may lie outside the play area; visited coordinates are wrapped.
 * Return `true` from the callback to stop early.
 */
export function forEachLinePixel(
  x0: number, y0: number, x1: number, y1: number,
  fn: (x: number, y: number) => boolean | void
): void {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0;
  let y = y0;
  for (;;) {
    if (fn(wrap(x, PLAY_WIDTH), wrap(y, PLAY_HEIGHT))) return;
    if (x === x1 && y === y1) return;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
}

export class PixelGrid {
  readonly width = PLAY_WIDTH;
  readonly height = PLAY_HEIGHT;
  private cells = new Uint16Array(PLAY_WIDTH * PLAY_HEIGHT);
  private palette: string[] = [''];
  private paletteIndex = new Map<string, number>();

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
    this.cells[y * PLAY_WIDTH + x] = idx;
  }

  delete(x: number, y: number): void {
    if (this.inBounds(x, y)) this.cells[y * PLAY_WIDTH + x] = 0;
  }

  clear(): void {
    this.cells.fill(0);
  }

  /** Clear a w×h rectangle whose top-left corner is (x, y), wrapping around edges. */
  clearRect(x: number, y: number, w: number, h: number): void {
    for (let dy = 0; dy < h; dy++) {
      const row = wrap(y + dy, PLAY_HEIGHT) * PLAY_WIDTH;
      for (let dx = 0; dx < w; dx++) {
        this.cells[row + wrap(x + dx, PLAY_WIDTH)] = 0;
      }
    }
  }

  /** Clear every pixel on a line (wrapping). */
  clearLine(x0: number, y0: number, x1: number, y1: number): void {
    forEachLinePixel(x0, y0, x1, y1, (x, y) => {
      this.cells[y * PLAY_WIDTH + x] = 0;
    });
  }

  /** First occupied pixel on a line (wrapping), or null. */
  firstHitOnLine(x0: number, y0: number, x1: number, y1: number): { x: number; y: number } | null {
    let hit: { x: number; y: number } | null = null;
    forEachLinePixel(x0, y0, x1, y1, (x, y) => {
      if (this.cells[y * PLAY_WIDTH + x] !== 0) {
        hit = { x, y };
        return true;
      }
      return false;
    });
    return hit;
  }

  /** Replace the contents of this grid with a copy of another. */
  copyFrom(other: PixelGrid): void {
    this.palette = [...other.palette];
    this.paletteIndex = new Map(other.paletteIndex);
    this.cells.set(other.cells);
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
