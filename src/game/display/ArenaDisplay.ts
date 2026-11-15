// ArenaDisplay - the display bitmap of the arena, kept apart from the collision bitmap
// (design/display-layer.md). Fed with the same one-shot events as the old trail canvas;
// derives the level and trail layers (with their shade) for the dirty parts only.

import { PixelGrid, forEachLinePixel } from '../PixelGrid';
import { DisplayCells, KIND_LEVEL, KIND_TRAIL, packCss, shadeCells, shadeReach } from './shade';
import type { ShadeStyle } from './shade';

/** Where derived pixels go: two layers of (width·scale) × (height·scale) pixels. */
export interface LayerSink {
  resize(width: number, height: number): void;
  /** Scratch buffers for a block of at least w × h pixels (reused between calls). */
  buffers(w: number, h: number): { level: Uint32Array; trail: Uint32Array; stride: number };
  /** Write the w × h block held by the buffers last handed out at (x, y), in layer pixels. */
  put(x: number, y: number, w: number, h: number): void;
}

interface Rect { x0: number; y0: number; x1: number; y1: number }  // inclusive, in cells

const MAX_RECTS = 256;
/** Dirty rectangles are derived in blocks of at most this many cells per side. */
const BLOCK = 128;
/** A run of nearby points grows one rectangle up to this size before starting another. */
const RUN_SPAN = 16;

export class ArenaDisplay {
  readonly cells: DisplayCells;
  private style: ShadeStyle;
  private dirty: Rect[] = [];
  private pristine: Uint32Array;
  private run: Rect | null = null;
  private reach: number;   // Cells around a changed cell whose shade changes with it
  /** Rectangles derived by the last flush (diagnostics). */
  lastFlushCells = 0;

  constructor(
    readonly width: number, readonly height: number,
    private readonly sink: LayerSink, style: ShadeStyle,
  ) {
    this.cells = new DisplayCells(width, height);
    this.pristine = new Uint32Array(width * height);
    this.style = style;
    this.reach = shadeReach(style);
    sink.resize(width * style.scale, height * style.scale);
  }

  get scale(): number {
    return this.style.scale;
  }

  /** Change how the cells are drawn; the cells themselves stay. */
  setStyle(style: ShadeStyle): void {
    this.style = style;
    this.reach = shadeReach(style);
    this.sink.resize(this.width * style.scale, this.height * style.scale);
    this.markAll();
  }

  /** Remember the undamaged level (walls of the collision image). Does not show it. */
  setLevel(obstacles: PixelGrid): void {
    this.pristine.fill(0);
    obstacles.forEachRun((x, y, length, color) => {
      this.pristine.fill(packCss(color), y * this.width + x, y * this.width + x + length);
    });
  }

  /**
   * Undamaged level and no trails (new round, Eraser). With `keepTrails` only the level
   * cells are put back (a level image that arrives after the round started).
   */
  restoreLevel(keepTrails = false): void {
    const { kind, color } = this.cells;
    for (let i = 0; i < kind.length; i++) {
      if (keepTrails && kind[i] === KIND_TRAIL) continue;
      const c = this.pristine[i]!;
      kind[i] = c === 0 ? 0 : KIND_LEVEL;
      color[i] = c;
    }
    this.cells.recount();
    this.markAll();
  }

  /**
   * Show a whole arena (joining a game in progress). `isTrail` says which colours are
   * trails — anything else is level.
   */
  paintSnapshot(arena: PixelGrid, isTrail: (color: string) => boolean): void {
    this.cells.clearAll();
    arena.forEachRun((x, y, length, color) => {
      const kind = isTrail(color) ? KIND_TRAIL : KIND_LEVEL;
      const packed = packCss(color);
      for (let i = 0; i < length; i++) this.cells.set(x + i, y, kind, packed);
    });
    this.markAll();
  }

  addTrail(points: readonly { x: number; y: number }[], color: string): void {
    const packed = packCss(color);
    this.run = null;
    for (const p of points) {
      this.cells.set(p.x, p.y, KIND_TRAIL, packed);
      this.markPoint(p.x, p.y);
    }
  }

  addLevel(points: readonly { x: number; y: number }[], color: string): void {
    const packed = packCss(color);
    this.run = null;
    for (const p of points) {
      this.cells.set(p.x, p.y, KIND_LEVEL, packed);
      this.markPoint(p.x, p.y);
    }
  }

  /** Erase a w×h rectangle whose top-left corner is (x, y), wrapping around the edges. */
  clearRect(x: number, y: number, w: number, h: number): void {
    const W = this.width, H = this.height;
    const x0 = ((x % W) + W) % W;
    const y0 = ((y % H) + H) % H;
    const xs: [number, number][] = x0 + w > W ? [[x0, W - x0], [0, Math.min(W, x0 + w - W)]] : [[x0, w]];
    const ys: [number, number][] = y0 + h > H ? [[y0, H - y0], [0, Math.min(H, y0 + h - H)]] : [[y0, h]];
    for (const [rx, rw] of xs) {
      for (const [ry, rh] of ys) {
        for (let yy = ry; yy < ry + rh; yy++) this.cells.clearRun(rx, yy, rw);
        this.mark(rx, ry, rx + rw - 1, ry + rh - 1);
      }
    }
  }

  /** Erase the cells along a line (wrapping). */
  clearLine(x0: number, y0: number, x1: number, y1: number): void {
    this.run = null;
    forEachLinePixel(x0, y0, x1, y1, (x, y) => {
      this.cells.clearCell(x, y);
      this.markPoint(x, y);
    });
    this.run = null;
  }

  /** Derive what changed since the last flush and hand it to the sink. */
  flush(): void {
    this.lastFlushCells = 0;
    if (this.dirty.length === 0) return;
    const rects = this.dirty;
    this.dirty = [];
    this.run = null;
    const S = this.style.scale;
    for (const r of rects) {
      for (let by = r.y0; by <= r.y1; by += BLOCK) {
        const h = Math.min(BLOCK, r.y1 - by + 1);
        for (let bx = r.x0; bx <= r.x1; bx += BLOCK) {
          const w = Math.min(BLOCK, r.x1 - bx + 1);
          const { level, trail, stride } = this.sink.buffers(w * S, h * S);
          shadeCells(this.cells, this.style, bx, by, w, h, level, trail, stride);
          this.sink.put(bx * S, by * S, w * S, h * S);
          this.lastFlushCells += w * h;
        }
      }
    }
  }

  private markAll(): void {
    this.dirty = [{ x0: 0, y0: 0, x1: this.width - 1, y1: this.height - 1 }];
    this.run = null;
  }

  // A changed cell: grows the current run's rectangle while it stays small
  private markPoint(x: number, y: number): void {
    if (!this.cells.inBounds(x, y)) return;
    const run = this.run;
    if (run) {
      const m = this.reach;
      const x0 = Math.min(run.x0, x - m), x1 = Math.max(run.x1, x + m);
      const y0 = Math.min(run.y0, y - m), y1 = Math.max(run.y1, y + m);
      if (x1 - x0 < RUN_SPAN && y1 - y0 < RUN_SPAN) {
        run.x0 = Math.max(0, x0);
        run.y0 = Math.max(0, y0);
        run.x1 = Math.min(this.width - 1, x1);
        run.y1 = Math.min(this.height - 1, y1);
        return;
      }
    }
    this.run = this.mark(x, y, x, y);
  }

  // Changed cells (inclusive); the neighbours' shade changes too
  private mark(x0: number, y0: number, x1: number, y1: number): Rect {
    const m = this.reach;
    const rect: Rect = {
      x0: Math.max(0, x0 - m), y0: Math.max(0, y0 - m),
      x1: Math.min(this.width - 1, x1 + m), y1: Math.min(this.height - 1, y1 + m),
    };
    if (this.dirty.length >= MAX_RECTS) {
      // Too many: collapse everything into one bounding box
      const box = this.dirty.reduce((a, b) => ({
        x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0),
        x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1),
      }), rect);
      this.dirty = [box];
      return box;
    }
    this.dirty.push(rect);
    return rect;
  }
}

/** The two layers as canvases, for compositing with drawImage. */
export class CanvasLayerSink implements LayerSink {
  readonly levelCanvas: HTMLCanvasElement;
  readonly trailCanvas: HTMLCanvasElement;
  private levelCtx: CanvasRenderingContext2D;
  private trailCtx: CanvasRenderingContext2D;
  private pool = new Map<number, Scratch>();
  private current: Scratch | null = null;

  constructor() {
    this.levelCanvas = document.createElement('canvas');
    this.trailCanvas = document.createElement('canvas');
    this.levelCtx = this.levelCanvas.getContext('2d')!;
    this.trailCtx = this.trailCanvas.getContext('2d')!;
  }

  resize(width: number, height: number): void {
    for (const canvas of [this.levelCanvas, this.trailCanvas]) {
      canvas.width = width;   // Also clears it
      canvas.height = height;
    }
  }

  buffers(w: number, h: number): Scratch {
    // A few sizes (powers of two from 8) cover every block, so nothing is allocated per frame
    const bw = bucket(w), bh = bucket(h);
    const key = bw * 8192 + bh;
    let entry = this.pool.get(key);
    if (!entry) {
      const levelImage = new ImageData(bw, bh);
      const trailImage = new ImageData(bw, bh);
      entry = {
        levelImage, trailImage, stride: bw,
        level: new Uint32Array(levelImage.data.buffer),
        trail: new Uint32Array(trailImage.data.buffer),
      };
      this.pool.set(key, entry);
    }
    this.current = entry;
    return entry;
  }

  put(x: number, y: number, w: number, h: number): void {
    const entry = this.current;
    if (!entry) return;
    this.levelCtx.putImageData(entry.levelImage, x, y, 0, 0, w, h);
    this.trailCtx.putImageData(entry.trailImage, x, y, 0, 0, w, h);
  }
}

interface Scratch {
  levelImage: ImageData;
  trailImage: ImageData;
  level: Uint32Array;
  trail: Uint32Array;
  stride: number;
}

function bucket(n: number): number {
  let b = 8;
  while (b < n) b *= 2;
  return b;
}
