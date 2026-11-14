// AssemblyScript prototype of the hot loops: the pixel grid's line / rectangle work and
// the core of a bot rollout (BotController.rollout without hazards, doors, portals and
// items). Compiled by `npm run bench:wasm`; `kernelTs.ts` is the same code in TypeScript.
// See design/research/performance.md.
//
// This file is AssemblyScript, not TypeScript: it is not part of the game build.

const W: i32 = 750;
const H: i32 = 600;
const COARSE_CELL: i32 = 8;
const COARSE_COLS: i32 = 94;   // ceil(750 / 8)
const COARSE_ROWS: i32 = 75;
const TURN_DEG: f64 = 4;
const DEG: f64 = Math.PI / 180;
const SIDE_RANGE: i32 = 31;

const cells = new StaticArray<u16>(W * H);
const coarse = new StaticArray<u16>(COARSE_COLS * COARSE_ROWS);
const sideSamples: StaticArray<i32> = [2, 4, 7, 10, 13, 17, 21, 25, 29];
// Results of the last rollout: narrow, endX, endY, endDir, cellCount
const out = new StaticArray<f64>(8);
const pathCells = new StaticArray<i32>(512);

export function cellsPtr(): usize { return changetype<usize>(cells); }
export function coarsePtr(): usize { return changetype<usize>(coarse); }
export function outPtr(): usize { return changetype<usize>(out); }
export function pathCellsPtr(): usize { return changetype<usize>(pathCells); }

// sin/cos: AssemblyScript's own, or (built with `--use JS_TRIG=1`) JavaScript's, imported
// @ts-ignore: decorator
@external("env", "cos") declare function importedCos(x: f64): f64;
// @ts-ignore: decorator
@external("env", "sin") declare function importedSin(x: f64): f64;
// @ts-ignore: decorator
@inline function kcos(x: f64): f64 {
  // @ts-ignore: defined on the command line
  return isDefined(JS_TRIG) ? importedCos(x) : Math.cos(x);
}
// @ts-ignore: decorator
@inline function ksin(x: f64): f64 {
  // @ts-ignore: defined on the command line
  return isDefined(JS_TRIG) ? importedSin(x) : Math.sin(x);
}

// @ts-ignore: decorator
@inline function wrap(v: i32, size: i32): i32 {
  return ((v % size) + size) % size;
}

// @ts-ignore: decorator
@inline function write(i: i32, value: u16): void {
  const old = unchecked(cells[i]);
  if ((old == 0) != (value == 0)) {
    const x = i % W;
    const y = (i - x) / W;
    const c = (y / COARSE_CELL) * COARSE_COLS + x / COARSE_CELL;
    unchecked(coarse[c] = coarse[c] + (value == 0 ? -1 : 1) as u16);
  }
  unchecked(cells[i] = value);
}

export function has(x: i32, y: i32): bool {
  return x >= 0 && y >= 0 && x < W && y < H && unchecked(cells[y * W + x]) != 0;
}

export function set(x: i32, y: i32, value: u16): void {
  if (x >= 0 && y >= 0 && x < W && y < H) write(y * W + x, value);
}

export function clearRect(x: i32, y: i32, w: i32, h: i32): void {
  for (let dy = 0; dy < h; dy++) {
    const row = wrap(y + dy, H) * W;
    for (let dx = 0; dx < w; dx++) write(row + wrap(x + dx, W), 0);
  }
}

/** Index of the first occupied pixel on the line (wrapping), or -1. */
export function firstHitOnLine(x0: i32, y0: i32, x1: i32, y1: i32): i32 {
  const dx = abs(x1 - x0);
  const dy = abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0;
  let y = y0;
  while (true) {
    const i = wrap(y, H) * W + wrap(x, W);
    if (unchecked(cells[i]) != 0) return i;
    if (x == x1 && y == y1) return -1;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
  return -1;
}

export function clearLine(x0: i32, y0: i32, x1: i32, y1: i32): void {
  const dx = abs(x1 - x0);
  const dy = abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0;
  let y = y0;
  while (true) {
    write(wrap(y, H) * W + wrap(x, W), 0);
    if (x == x1 && y == y1) return;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
}

function sideClearance(x: i32, y: i32, dx: f64, dy: f64): i32 {
  for (let i = 0; i < sideSamples.length; i++) {
    const d = unchecked(sideSamples[i]);
    // Math.round as in JavaScript: half-way cases towards +infinity
    const sx = wrap(<i32>Math.floor(<f64>x + dx * <f64>d + 0.5), W);
    const sy = wrap(<i32>Math.floor(<f64>y + dy * <f64>d + 0.5), H);
    if (unchecked(cells[sy * W + sx]) != 0) return d;
  }
  return SIDE_RANGE;
}

/**
 * Steer for `turnSteps` steps, then straight, until something is hit or `maxSteps`.
 * Returns the distance travelled; the rest of the result is in `out`.
 */
export function rollout(
  startX: f64, startY: f64, startDir: f64, steer: f64, turnSteps: i32, maxSteps: i32, clearanceSteps: i32
): i32 {
  let x = startX;
  let y = startY;
  let dir = startDir;
  let px = <i32>Math.floor(x);
  let py = <i32>Math.floor(y);
  let narrow = 0;
  let cellCount = 0;
  let lastCell = -1;
  let cos = kcos(dir * DEG);
  let sin = ksin(dir * DEG);
  let step = 1;
  for (; step <= maxSteps; step++) {
    if (step <= turnSteps && steer != 0) {
      dir = (dir + steer * TURN_DEG + 360) % 360;
      cos = kcos(dir * DEG);
      sin = ksin(dir * DEG);
    }
    x += cos;
    y += sin;
    if (x < 0) x += <f64>W; else if (x >= <f64>W) x -= <f64>W;
    if (y < 0) y += <f64>H; else if (y >= <f64>H) y -= <f64>H;
    const nx = <i32>Math.floor(x);
    const ny = <i32>Math.floor(y);
    if (nx != px || ny != py) {
      if (has(nx, ny)) break;
      const dx = nx - px;
      const dy = ny - py;
      if (dx != 0 && dy != 0 && abs(dx) == 1 && abs(dy) == 1 && (has(px + dx, py) || has(px, py + dy))) break;
      if (step > 4 && step <= clearanceSteps && step % 4 == 0) {
        const left = sideClearance(nx, ny, sin, -cos);
        const right = sideClearance(nx, ny, -sin, cos);
        if (left < SIDE_RANGE && right < SIDE_RANGE) narrow += 6;
        else if (min(left, right) <= 4) narrow += 1;
      }
      px = nx;
      py = ny;
      const cell = (ny >> 3) * COARSE_COLS + (nx >> 3);
      if (cell != lastCell) {
        if (cellCount < 512) unchecked(pathCells[cellCount++] = cell);
        lastCell = cell;
      }
    }
  }
  unchecked(out[0] = <f64>narrow);
  unchecked(out[1] = x);
  unchecked(out[2] = y);
  unchecked(out[3] = dir);
  unchecked(out[4] = <f64>cellCount);
  return step - 1;
}

/**
 * A whole plan in one call: the nine candidate manoeuvres of the real bot, returning
 * the sum of their distances (enough to compare the work done on both sides).
 */
export function planBatch(x: f64, y: f64, dir: f64, maxSteps: i32, clearanceSteps: i32): i32 {
  let total = rollout(x, y, dir, 0, 0, maxSteps, clearanceSteps);
  const turns: StaticArray<i32> = [3, 8, 22, 45];
  for (let i = 0; i < turns.length; i++) {
    const t = unchecked(turns[i]);
    total += rollout(x, y, dir, -1, t, maxSteps, clearanceSteps);
    total += rollout(x, y, dir, 1, t, maxSteps, clearanceSteps);
  }
  return total;
}

// For the determinism check: AssemblyScript's own sin and cos
export function nativeSin(x: f64): f64 { return Math.sin(x); }
export function nativeCos(x: f64): f64 { return Math.cos(x); }
