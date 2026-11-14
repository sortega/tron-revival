// The TypeScript twin of kernel.as.ts: the same loops over a Uint16Array, written the
// way an optimised BotController / PixelGrid would have them. The benchmark runs both.

const W = 750;
const H = 600;
const COARSE_CELL = 8;
const COARSE_COLS = 94;
const COARSE_ROWS = 75;
const TURN_DEG = 4;
const DEG = Math.PI / 180;
const SIDE_RANGE = 31;
const SIDE_SAMPLES = [2, 4, 7, 10, 13, 17, 21, 25, 29];
const TURNS = [3, 8, 22, 45];

export class JsKernel {
  cells: Uint16Array;
  readonly coarse = new Uint16Array(COARSE_COLS * COARSE_ROWS);
  readonly out = new Float64Array(8);
  readonly pathCells = new Int32Array(512);

  /** `cells` may be a view over memory owned by somebody else (e.g. a WASM module). */
  constructor(cells: Uint16Array = new Uint16Array(W * H)) {
    this.cells = cells;
  }

  private write(i: number, value: number): void {
    const old = this.cells[i]!;
    if ((old === 0) !== (value === 0)) {
      const x = i % W;
      const y = (i - x) / W;
      const c = ((y / COARSE_CELL) | 0) * COARSE_COLS + ((x / COARSE_CELL) | 0);
      this.coarse[c] = this.coarse[c]! + (value === 0 ? -1 : 1);
    }
    this.cells[i] = value;
  }

  has(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < W && y < H && this.cells[y * W + x] !== 0;
  }

  set(x: number, y: number, value: number): void {
    if (x >= 0 && y >= 0 && x < W && y < H) this.write(y * W + x, value);
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    for (let dy = 0; dy < h; dy++) {
      const row = ((((y + dy) % H) + H) % H) * W;
      for (let dx = 0; dx < w; dx++) this.write(row + ((((x + dx) % W) + W) % W), 0);
    }
  }

  firstHitOnLine(x0: number, y0: number, x1: number, y1: number): number {
    const cells = this.cells;
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let x = x0;
    let y = y0;
    for (;;) {
      const i = (((y % H) + H) % H) * W + (((x % W) + W) % W);
      if (cells[i] !== 0) return i;
      if (x === x1 && y === y1) return -1;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
  }

  /** The same walk, taking the modulo only for pixels outside the arena. */
  firstHitOnLineFast(x0: number, y0: number, x1: number, y1: number): number {
    const cells = this.cells;
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let x = x0;
    let y = y0;
    for (;;) {
      const wx = x >= 0 && x < W ? x : ((x % W) + W) % W;
      const wy = y >= 0 && y < H ? y : ((y % H) + H) % H;
      const i = wy * W + wx;
      if (cells[i] !== 0) return i;
      if (x === x1 && y === y1) return -1;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
  }

  clearLine(x0: number, y0: number, x1: number, y1: number): void {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let x = x0;
    let y = y0;
    for (;;) {
      this.write((((y % H) + H) % H) * W + (((x % W) + W) % W), 0);
      if (x === x1 && y === y1) return;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
  }

  private sideClearance(x: number, y: number, dx: number, dy: number): number {
    const cells = this.cells;
    for (let i = 0; i < SIDE_SAMPLES.length; i++) {
      const d = SIDE_SAMPLES[i]!;
      const sx = (((Math.floor(x + dx * d + 0.5) % W) + W) % W);
      const sy = (((Math.floor(y + dy * d + 0.5) % H) + H) % H);
      if (cells[sy * W + sx] !== 0) return d;
    }
    return SIDE_RANGE;
  }

  rollout(
    startX: number, startY: number, startDir: number, steer: number, turnSteps: number, maxSteps: number, clearanceSteps: number
  ): number {
    let x = startX;
    let y = startY;
    let dir = startDir;
    let px = Math.floor(x);
    let py = Math.floor(y);
    let narrow = 0;
    let cellCount = 0;
    let lastCell = -1;
    let cos = Math.cos(dir * DEG);
    let sin = Math.sin(dir * DEG);
    let step = 1;
    for (; step <= maxSteps; step++) {
      if (step <= turnSteps && steer !== 0) {
        dir = (dir + steer * TURN_DEG + 360) % 360;
        cos = Math.cos(dir * DEG);
        sin = Math.sin(dir * DEG);
      }
      x += cos;
      y += sin;
      if (x < 0) x += W; else if (x >= W) x -= W;
      if (y < 0) y += H; else if (y >= H) y -= H;
      const nx = Math.floor(x);
      const ny = Math.floor(y);
      if (nx !== px || ny !== py) {
        if (this.has(nx, ny)) break;
        const dx = nx - px;
        const dy = ny - py;
        if (dx !== 0 && dy !== 0 && Math.abs(dx) === 1 && Math.abs(dy) === 1 && (this.has(px + dx, py) || this.has(px, py + dy))) break;
        if (step > 4 && step <= clearanceSteps && step % 4 === 0) {
          const left = this.sideClearance(nx, ny, sin, -cos);
          const right = this.sideClearance(nx, ny, -sin, cos);
          if (left < SIDE_RANGE && right < SIDE_RANGE) narrow += 6;
          else if (Math.min(left, right) <= 4) narrow += 1;
        }
        px = nx;
        py = ny;
        const cell = (ny >> 3) * COARSE_COLS + (nx >> 3);
        if (cell !== lastCell) {
          if (cellCount < 512) this.pathCells[cellCount++] = cell;
          lastCell = cell;
        }
      }
    }
    this.out[0] = narrow;
    this.out[1] = x;
    this.out[2] = y;
    this.out[3] = dir;
    this.out[4] = cellCount;
    return step - 1;
  }

  planBatch(x: number, y: number, dir: number, maxSteps: number, clearanceSteps: number): number {
    let total = this.rollout(x, y, dir, 0, 0, maxSteps, clearanceSteps);
    for (const t of TURNS) {
      total += this.rollout(x, y, dir, -1, t, maxSteps, clearanceSteps);
      total += this.rollout(x, y, dir, 1, t, maxSteps, clearanceSteps);
    }
    return total;
  }
}
