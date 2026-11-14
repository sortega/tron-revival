// Display bitmap of the arena and the shade derived from it (design/display-layer.md).
//
// Pure: no DOM. The collision bitmap (PixelGrid) is not involved; this is only what is
// drawn. Colours are packed as they sit in ImageData on a little-endian machine:
// 0xAABBGGRR.

export const KIND_EMPTY = 0;
export const KIND_TRAIL = 1;
export const KIND_LEVEL = 2;

export type FringeMode = 'none' | 'color' | 'dark' | 'dim';

export interface ShadeStyle {
  /** Device pixels per logical pixel in the derived layers. */
  scale: number;
  fringe: FringeMode;
  /** Fringe width in sub-pixels (≤ scale). */
  fringeWidth: number;
  /** 0–255 */
  fringeAlpha: number;
  /** For 'dim': the fringe is the trail colour multiplied by this. */
  fringeDim: number;
  /** Also shade the sub-pixels that only touch a trail cell diagonally. */
  diagonal: boolean;
  /** Walls cast a shadow of `fringeWidth` sub-pixels down-right. */
  wallShadow: boolean;
  /** Each slot's fringe has its own rhythm. */
  pattern: boolean;
}

const SHADOW = packRgba(0, 0, 0, 120);

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

export class DisplayCells {
  readonly color: Uint32Array;
  readonly kind: Uint8Array;
  /** Slot of a trail cell (for patterns). */
  readonly tag: Uint8Array;

  constructor(readonly width: number, readonly height: number) {
    this.color = new Uint32Array(width * height);
    this.kind = new Uint8Array(width * height);
    this.tag = new Uint8Array(width * height);
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  set(x: number, y: number, kind: number, color: number, tag = 0): void {
    if (!this.inBounds(x, y)) return;
    const i = y * this.width + x;
    this.kind[i] = kind;
    this.color[i] = color;
    this.tag[i] = tag;
  }

  clearCell(x: number, y: number): void {
    if (!this.inBounds(x, y)) return;
    this.kind[y * this.width + x] = KIND_EMPTY;
  }

  clearAll(): void {
    this.kind.fill(KIND_EMPTY);
  }
}

/** Does slot `tag`'s fringe show next to the trail cell (x, y)? */
function patternOn(tag: number, x: number, y: number): boolean {
  switch (tag & 3) {
    case 0: return true;                                   // solid
    case 1: return ((x + 2 * y) & 7) < 4;                  // dashes
    case 2: return (x + 2 * y) % 3 === 0;                  // dots
    default: return (((2 * x - y) % 12) + 12) % 12 < 9;    // long dashes
  }
}

function fringeColor(style: ShadeStyle, trail: number): number {
  const a = style.fringeAlpha << 24;
  if (style.fringe === 'dark') return a >>> 0;
  if (style.fringe === 'color') return ((trail & 0x00ffffff) | a) >>> 0;
  const d = style.fringeDim;
  const r = Math.round((trail & 255) * d);
  const g = Math.round(((trail >> 8) & 255) * d);
  const b = Math.round(((trail >> 16) & 255) * d);
  return (a | (b << 16) | (g << 8) | r) >>> 0;
}

/**
 * Derive the picture of the cells in the rectangle (x0, y0, w, h) (which must lie inside
 * the arena) into two buffers of packed pixels, `stride` pixels per row: the level layer
 * and the trail layer. Every pixel of the (w·scale) × (h·scale) block is written.
 */
export function shadeCells(
  cells: DisplayCells, style: ShadeStyle,
  x0: number, y0: number, w: number, h: number,
  outLevel: Uint32Array, outTrail: Uint32Array,
  stride = w * style.scale,
): void {
  const S = style.scale;
  const f = Math.min(style.fringeWidth, S);
  const W = cells.width;
  const H = cells.height;
  const { kind, color, tag } = cells;
  const fringed = style.fringe !== 'none' && f > 0;

  for (let cy = 0; cy < h; cy++) {
    const y = y0 + cy;
    for (let cx = 0; cx < w; cx++) {
      const x = x0 + cx;
      const i = y * W + x;
      const k = kind[i]!;
      const base = cy * S * stride + cx * S;

      if (k !== KIND_EMPTY) {
        const c = color[i]!;
        const level = k === KIND_LEVEL ? c : 0;
        const trail = k === KIND_TRAIL ? c : 0;
        for (let sy = 0; sy < S; sy++) {
          const o = base + sy * stride;
          for (let sx = 0; sx < S; sx++) {
            outLevel[o + sx] = level;
            outTrail[o + sx] = trail;
          }
        }
        continue;
      }

      // Empty cell: its sub-pixels may carry the shade of the neighbours.
      // Neighbour kinds (0 outside the arena): l, r, u, d and the four diagonals.
      const hasL = x > 0, hasR = x < W - 1, hasU = y > 0, hasD = y < H - 1;
      const kl = hasL ? kind[i - 1]! : 0;
      const kr = hasR ? kind[i + 1]! : 0;
      const ku = hasU ? kind[i - W]! : 0;
      const kd = hasD ? kind[i + W]! : 0;
      const kul = hasU && hasL ? kind[i - W - 1]! : 0;
      const kur = hasU && hasR ? kind[i - W + 1]! : 0;
      const kdl = hasD && hasL ? kind[i + W - 1]! : 0;
      const kdr = hasD && hasR ? kind[i + W + 1]! : 0;

      if ((kl | kr | ku | kd | kul | kur | kdl | kdr) === 0) {
        for (let sy = 0; sy < S; sy++) {
          const o = base + sy * stride;
          for (let sx = 0; sx < S; sx++) {
            outLevel[o + sx] = 0;
            outTrail[o + sx] = 0;
          }
        }
        continue;
      }

      for (let sy = 0; sy < S; sy++) {
        const up = sy < f, down = sy >= S - f;
        const o = base + sy * stride;
        for (let sx = 0; sx < S; sx++) {
          const left = sx < f, right = sx >= S - f;

          // Trail fringe: the first trail neighbour this sub-pixel touches
          let n = -1;
          if (fringed) {
            if (left && kl === KIND_TRAIL) n = i - 1;
            else if (right && kr === KIND_TRAIL) n = i + 1;
            else if (up && ku === KIND_TRAIL) n = i - W;
            else if (down && kd === KIND_TRAIL) n = i + W;
            else if (style.diagonal) {
              if (up && left && kul === KIND_TRAIL) n = i - W - 1;
              else if (up && right && kur === KIND_TRAIL) n = i - W + 1;
              else if (down && left && kdl === KIND_TRAIL) n = i + W - 1;
              else if (down && right && kdr === KIND_TRAIL) n = i + W + 1;
            }
            if (n >= 0 && style.pattern && !patternOn(tag[n]!, n % W, (n / W) | 0)) n = -1;
          }
          outTrail[o + sx] = n >= 0 ? fringeColor(style, color[n]!) : 0;

          // Wall shadow, cast down-right
          let shadow = false;
          if (style.wallShadow) {
            shadow = (left && kl === KIND_LEVEL) || (up && ku === KIND_LEVEL)
              || (left && up && kul === KIND_LEVEL);
          }
          outLevel[o + sx] = shadow ? SHADOW : 0;
        }
      }
    }
  }
}
