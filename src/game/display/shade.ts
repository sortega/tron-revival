// Display bitmap of the arena and the shade derived from it (design/display-layer.md).
//
// Pure: no DOM. The collision bitmap (PixelGrid) is not involved; this is only what is
// drawn. Colours are packed as they sit in ImageData on a little-endian machine:
// 0xAABBGGRR.

export const KIND_EMPTY = 0;
export const KIND_TRAIL = 1;
export const KIND_LEVEL = 2;

/** One step of the fringe, outwards from the trail. */
export interface FringeBand {
  /** Width in sub-pixels. */
  width: number;
  /** The band is the trail colour multiplied by this (0 = black)... */
  dim: number;
  /** ...at this opacity, 0–255. */
  alpha: number;
}

export interface ShadeStyle {
  /** Layer pixels per logical pixel. */
  scale: number;
  /** Fringe around trails, from the trail outwards. Empty: none. */
  bands: readonly FringeBand[];
  /**
   * Soft shade: the opacity of a fringe pixel is not the band's but the sum of these for
   * every trail pixel touching it (side by side / corner to corner), up to `max`. A pixel
   * in the notch of a staircase touches more trail than one beside a straight line, so
   * slanted trails are smoothed more than they are thickened. Needs one band of width 1.
   */
  soft?: { orthogonal: number; diagonal: number; max: number };
}

export function packRgba(r: number, g: number, b: number, a = 255): number {
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/** '#rrggbb' (or '#rgb') to a packed opaque colour; anything else is white. */
export function packCss(color: string): number {
  let hex = color.startsWith('#') ? color.slice(1) : '';
  if (hex.length === 3) hex = hex.replace(/./g, c => c + c);
  const n = hex.length === 6 ? parseInt(hex, 16) : NaN;
  if (Number.isNaN(n)) return 0xffffffff;
  return packRgba((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

/** CSS colour of a packed colour. */
export function cssOf(packed: number): string {
  return `rgba(${packed & 255}, ${(packed >> 8) & 255}, ${(packed >> 16) & 255}, ${((packed >>> 24) / 255).toFixed(3)})`;
}

/** WCAG relative luminance (0–1) of a packed colour. */
export function luminance(packed: number): number {
  const lin = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(packed & 255) + 0.7152 * lin((packed >> 8) & 255) + 0.0722 * lin((packed >> 16) & 255);
}

/** Packed colour of a fringe band next to a trail drawn in the given packed colour. */
export function bandColor(band: FringeBand, trail: number): number {
  const d = band.dim;
  const r = Math.round((trail & 255) * d);
  const g = Math.round(((trail >> 8) & 255) * d);
  const b = Math.round(((trail >> 16) & 255) * d);
  return ((band.alpha << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/** Total fringe width in sub-pixels. */
export function fringeWidth(style: ShadeStyle): number {
  let w = 0;
  for (const band of style.bands) w += band.width;
  return w;
}

/** How many cells the fringe extends from a trail cell. */
function fringeCells(style: ShadeStyle): number {
  return Math.min(3, Math.ceil(fringeWidth(style) / style.scale));
}

/**
 * How many cells away a trail cell can change what is drawn on a cell: the fringe, and
 * twice that for the rule that keeps narrow gaps clear.
 */
export function shadeReach(style: ShadeStyle): number {
  return Math.max(1, 2 * fringeCells(style));
}

// Distance (in cells, 1 = adjacent) to the first trail cell from cell i going by `step`
// along a row or column, looking at most `max` cells; 0 if there is none. `room` is how
// many cells there are before the edge of the arena in that direction.
function trailWithin(kind: Uint8Array, i: number, step: number, max: number, room: number): number {
  const n = max < room ? max : room;
  for (let d = 1; d <= n; d++) {
    if (kind[i + d * step] === KIND_TRAIL) return d;
  }
  return 0;
}

export class DisplayCells {
  readonly color: Uint32Array;
  readonly kind: Uint8Array;
  /** Trail cells per row: lets the derivation skip the rows that have no trail near. */
  readonly rowTrails: Uint16Array;

  constructor(readonly width: number, readonly height: number) {
    this.color = new Uint32Array(width * height);
    this.kind = new Uint8Array(width * height);
    this.rowTrails = new Uint16Array(height);
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  set(x: number, y: number, kind: number, color: number): void {
    if (!this.inBounds(x, y)) return;
    const i = y * this.width + x;
    const delta = (kind === KIND_TRAIL ? 1 : 0) - (this.kind[i] === KIND_TRAIL ? 1 : 0);
    if (delta !== 0) this.rowTrails[y] = this.rowTrails[y]! + delta;
    this.kind[i] = kind;
    this.color[i] = color;
  }

  clearCell(x: number, y: number): void {
    if (!this.inBounds(x, y)) return;
    const i = y * this.width + x;
    if (this.kind[i] === KIND_TRAIL) this.rowTrails[y] = this.rowTrails[y]! - 1;
    this.kind[i] = KIND_EMPTY;
  }

  /** Empty `w` cells of row `y` from column `x` (all inside the arena). */
  clearRun(x: number, y: number, w: number): void {
    const from = y * this.width + x;
    let trails = 0;
    for (let i = from; i < from + w; i++) {
      if (this.kind[i] === KIND_TRAIL) trails++;
      this.kind[i] = KIND_EMPTY;
    }
    this.rowTrails[y] = this.rowTrails[y]! - trails;
  }

  clearAll(): void {
    this.kind.fill(KIND_EMPTY);
    this.rowTrails.fill(0);
  }

  /** After writing `kind` directly: count the trail cells again. */
  recount(): void {
    this.rowTrails.fill(0);
    for (let y = 0; y < this.height; y++) {
      let n = 0;
      const row = y * this.width;
      for (let x = 0; x < this.width; x++) if (this.kind[row + x] === KIND_TRAIL) n++;
      this.rowTrails[y] = n;
    }
  }
}

// Scratch: trail cells near the cell being derived (offsets in cells, and their index)
const nearDx = new Int8Array(64);
const nearDy = new Int8Array(64);
const nearIndex = new Int32Array(64);
// Scratch: which cells of the rectangle being derived have a trail cell within reach
let nearMask = new Uint8Array(0);

/**
 * Derive the picture of the cells in the rectangle (x0, y0, w, h) (which must lie inside
 * the arena) into two buffers of packed pixels, `stride` pixels per row: the level layer
 * and the trail layer. Every pixel of the (w·scale) × (h·scale) block is written.
 *
 * A sub-pixel of an empty cell is fringe if its distance to the nearest trail cell
 * (Chebyshev, in sub-pixels; 1 = touching) is within the bands; orthogonal neighbours win
 * ties. The fringe never covers a wall or another trail, and **a gap is never closed**:
 * a free cell with trail on both sides of it (left and right, or above and below) no
 * further apart than two fringes gets no fringe at all, so every gap between trails,
 * however narrow, keeps at least one cell exactly as it is without shade.
 */
export function shadeCells(
  cells: DisplayCells, style: ShadeStyle,
  x0: number, y0: number, w: number, h: number,
  outLevel: Uint32Array, outTrail: Uint32Array,
  stride = w * style.scale,
): void {
  const S = style.scale;
  const W = cells.width;
  const H = cells.height;
  const { kind, color, rowTrails } = cells;
  const bands = style.bands;
  const reach = fringeWidth(style);
  const R = fringeCells(style);   // Cells to look around (7×7 at most)
  const soft = style.soft;

  // Band colours of the trail colour seen last (trails come in long same-coloured runs)
  let cachedFor = -1;
  let cachedCore = 0;
  const cachedBands: number[] = bands.map(() => 0);
  const prepare = (c: number): void => {
    if (c === cachedFor) return;
    cachedFor = c;
    cachedCore = c;
    for (let b = 0; b < bands.length; b++) cachedBands[b] = bandColor(bands[b]!, cachedCore);
  };

  // Mark the cells within reach of a trail cell: only those need the search below. Most
  // of the arena is far from any trail, and many rows have none at all.
  if (nearMask.length < w * h) nearMask = new Uint8Array(w * h);
  const mask = nearMask;
  mask.fill(0, 0, w * h);
  if (R > 0) {
    const xFrom = Math.max(0, x0 - R), xTo = Math.min(W - 1, x0 + w - 1 + R);
    for (let yy = Math.max(0, y0 - R); yy <= Math.min(H - 1, y0 + h - 1 + R); yy++) {
      if (rowTrails[yy] === 0) continue;
      const row = yy * W;
      for (let xx = xFrom; xx <= xTo; xx++) {
        if (kind[row + xx] !== KIND_TRAIL) continue;
        const my0 = Math.max(0, yy - R - y0), my1 = Math.min(h - 1, yy + R - y0);
        const mx0 = Math.max(0, xx - R - x0), mx1 = Math.min(w - 1, xx + R - x0);
        for (let my = my0; my <= my1; my++) mask.fill(1, my * w + mx0, my * w + mx1 + 1);
      }
    }
  }

  for (let cy = 0; cy < h; cy++) {
    const y = y0 + cy;
    for (let cx = 0; cx < w; cx++) {
      const x = x0 + cx;
      const i = y * W + x;
      const k = kind[i]!;
      const base = cy * S * stride + cx * S;

      if (k !== KIND_EMPTY) {
        let level = 0;
        let trail = 0;
        if (k === KIND_LEVEL) {
          level = color[i]!;
        } else {
          prepare(color[i]!);
          trail = cachedCore;
        }
        for (let sy = 0; sy < S; sy++) {
          const o = base + sy * stride;
          for (let sx = 0; sx < S; sx++) {
            outLevel[o + sx] = level;
            outTrail[o + sx] = trail;
          }
        }
        continue;
      }

      // Empty cell: collect the trail cells within reach, nearest ring first and
      // orthogonal before diagonal, so that the first one found at a distance wins
      let near = 0;
      if (mask[cy * w + cx] !== 0) {
        for (let ring = 1; ring <= R; ring++) {
          for (let pass = 0; pass < 2; pass++) {
            for (let dy = -ring; dy <= ring; dy++) {
              const yy = y + dy;
              if (yy < 0 || yy >= H) continue;
              for (let dx = -ring; dx <= ring; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
                const orthogonal = dx === 0 || dy === 0;
                if (orthogonal !== (pass === 0)) continue;
                const xx = x + dx;
                if (xx < 0 || xx >= W) continue;
                const n = yy * W + xx;
                if (kind[n] === KIND_TRAIL && near < 64) {
                  nearDx[near] = dx;
                  nearDy[near] = dy;
                  nearIndex[near] = n;
                  near++;
                }
              }
            }
          }
        }
      }
      // In a gap between trails no wider than two fringes: leave it clear
      if (near > 0) {
        const l = trailWithin(kind, i, -1, 2 * R, x);
        const r = l > 0 ? trailWithin(kind, i, 1, 2 * R, W - 1 - x) : 0;
        const u = trailWithin(kind, i, -W, 2 * R, y);
        const d = u > 0 ? trailWithin(kind, i, W, 2 * R, H - 1 - y) : 0;
        if ((r > 0 && l + r - 1 <= 2 * R) || (d > 0 && u + d - 1 <= 2 * R)) near = 0;
      }
      if (near === 0) {
        for (let sy = 0; sy < S; sy++) {
          const o = base + sy * stride;
          for (let sx = 0; sx < S; sx++) {
            outLevel[o + sx] = 0;
            outTrail[o + sx] = 0;
          }
        }
        continue;
      }

      // Soft shade: how much trail touches this cell
      let softAlpha = 0;
      if (soft) {
        let sum = 0;
        for (let t = 0; t < near; t++) {
          if (Math.abs(nearDx[t]!) > 1 || Math.abs(nearDy[t]!) > 1) continue;
          sum += nearDx[t] === 0 || nearDy[t] === 0 ? soft.orthogonal : soft.diagonal;
        }
        softAlpha = Math.round(255 * Math.min(soft.max, sum));
      }

      for (let sy = 0; sy < S; sy++) {
        const o = base + sy * stride;
        for (let sx = 0; sx < S; sx++) {
          // Distance in sub-pixels to each trail cell within reach; keep the nearest
          let best = reach + 1;
          let bestIndex = -1;
          for (let t = 0; t < near; t++) {
            const dx = nearDx[t]!;
            const dy = nearDy[t]!;
            const ddx = dx < 0 ? sx + 1 + (-dx - 1) * S : dx > 0 ? S - sx + (dx - 1) * S : 0;
            const ddy = dy < 0 ? sy + 1 + (-dy - 1) * S : dy > 0 ? S - sy + (dy - 1) * S : 0;
            const d = ddx > ddy ? ddx : ddy;
            if (d < best) {
              best = d;
              bestIndex = nearIndex[t]!;
            }
          }
          let pixel = 0;
          if (bestIndex >= 0) {
            prepare(color[bestIndex]!);
            let edge = 0;
            for (let b = 0; b < bands.length; b++) {
              edge += bands[b]!.width;
              if (best <= edge) {
                pixel = cachedBands[b]!;
                break;
              }
            }
          }
          if (soft && pixel !== 0) pixel = ((pixel & 0x00ffffff) | (softAlpha << 24)) >>> 0;
          outTrail[o + sx] = pixel;
          outLevel[o + sx] = 0;
        }
      }
    }
  }
}
