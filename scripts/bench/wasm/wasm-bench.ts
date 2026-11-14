// Like-for-like microbenchmark: the hot loops in TypeScript (kernelTs.ts) and in
// WebAssembly (kernel.as.ts, AssemblyScript), including the cost of crossing the
// JS↔WASM boundary and whether the results are bit-identical.
// Run with `npm run bench:wasm`. See design/research/performance.md.

import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { JsKernel } from './kernelTs';
import { createRng } from '../../../src/game/rng';
import { loadLevelGrid } from '../../../tests/helpers';

const W = 750;
const H = 600;

interface WasmExports {
  memory: WebAssembly.Memory;
  cellsPtr(): number;
  coarsePtr(): number;
  outPtr(): number;
  has(x: number, y: number): number;
  set(x: number, y: number, value: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  clearLine(x0: number, y0: number, x1: number, y1: number): void;
  firstHitOnLine(x0: number, y0: number, x1: number, y1: number): number;
  rollout(x: number, y: number, dir: number, steer: number, turnSteps: number, maxSteps: number, clearanceSteps: number): number;
  planBatch(x: number, y: number, dir: number, maxSteps: number, clearanceSteps: number): number;
  nativeSin(x: number): number;
  nativeCos(x: number): number;
}

function loadWasm(file: string): WasmExports {
  const module = new WebAssembly.Module(readFileSync(file));
  const instance = new WebAssembly.Instance(module, {
    env: {
      abort: () => { throw new Error('wasm abort'); },
      // Only used by the variant built with `--use JS_TRIG=1`
      cos: Math.cos, sin: Math.sin,
    },
  });
  return instance.exports as unknown as WasmExports;
}

// A realistic arena: a level plus the trails of some wandering players
function fillArena(set: (x: number, y: number, v: number) => void): void {
  const level = loadLevelGrid('selva');
  level.forEachRun((x, y, length) => { for (let i = 0; i < length; i++) set(x + i, y, 1); });
  const rng = createRng(7);
  for (let walker = 0; walker < 12; walker++) {
    let x = rng() * W;
    let y = rng() * H;
    let dir = rng() * 360;
    let steer = 0;
    for (let step = 0; step < 1500; step++) {
      if (rng() < 0.05) steer = Math.floor(rng() * 3) - 1;
      dir = (dir + steer * 4 + 360) % 360;
      x = (x + Math.cos(dir * Math.PI / 180) + W) % W;
      y = (y + Math.sin(dir * Math.PI / 180) + H) % H;
      set(Math.floor(x), Math.floor(y), 2 + (walker % 4));
    }
  }
}

function time(label: string, iterations: number, unit: string, fn: () => number): number {
  // Warm up, then best of 5 (microbenchmarks: the minimum is the least noisy)
  fn();
  fn();
  let best = Infinity;
  let sink = 0;
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    sink += fn();
    best = Math.min(best, performance.now() - t0);
  }
  const ns = best * 1e6 / iterations;
  console.log(`  ${label.padEnd(46)} ${ns.toFixed(1).padStart(10)} ns/${unit}   (checksum ${sink})`);
  return ns;
}

const js = new JsKernel();
const wasm = loadWasm('node_modules/.bench/kernel.native.wasm');
const wasmJsMath = loadWasm('node_modules/.bench/kernel.jsmath.wasm');
fillArena((x, y, v) => js.set(x, y, v));
fillArena((x, y, v) => wasm.set(x, y, v));
fillArena((x, y, v) => wasmJsMath.set(x, y, v));

// The TypeScript loops over the WASM module's memory (no copy: a typed-array view)
const shared = new JsKernel(new Uint16Array(wasm.memory.buffer, wasm.cellsPtr(), W * H));

// Starting points on free pixels
const rng = createRng(99);
const starts: { x: number; y: number; dir: number }[] = [];
while (starts.length < 3000) {
  const x = rng() * W;
  const y = rng() * H;
  if (!js.has(Math.floor(x), Math.floor(y))) starts.push({ x, y, dir: Math.floor(rng() * 90) * 4 });
}
const lines: number[] = [];
for (let i = 0; i < 20000; i++) {
  const x = Math.floor(rng() * W);
  const y = Math.floor(rng() * H);
  const len = i % 2 === 0 ? 12 : 100;
  const a = rng() * Math.PI * 2;
  lines.push(x, y, Math.round(x + Math.cos(a) * len), Math.round(y + Math.sin(a) * len));
}

const LOOKAHEAD = 180;
const CLEARANCE = 110;
const TURNS = [3, 8, 22, 45];

console.log('Bot plan (9 rollouts, lookahead 180, clearance sampling), per plan:');
const planJs = time('TypeScript', starts.length, 'plan', () => {
  let sum = 0;
  for (const s of starts) sum += js.planBatch(s.x, s.y, s.dir, LOOKAHEAD, CLEARANCE);
  return sum;
});
const planShared = time('TypeScript over WASM memory (shared grid)', starts.length, 'plan', () => {
  let sum = 0;
  for (const s of starts) sum += shared.planBatch(s.x, s.y, s.dir, LOOKAHEAD, CLEARANCE);
  return sum;
});
const planWasm = time('WASM, one call per plan', starts.length, 'plan', () => {
  let sum = 0;
  for (const s of starts) sum += wasm.planBatch(s.x, s.y, s.dir, LOOKAHEAD, CLEARANCE);
  return sum;
});
const planWasmCalls = time('WASM, one call per rollout (9 crossings)', starts.length, 'plan', () => {
  let sum = 0;
  for (const s of starts) {
    sum += wasm.rollout(s.x, s.y, s.dir, 0, 0, LOOKAHEAD, CLEARANCE);
    for (const t of TURNS) {
      sum += wasm.rollout(s.x, s.y, s.dir, -1, t, LOOKAHEAD, CLEARANCE);
      sum += wasm.rollout(s.x, s.y, s.dir, 1, t, LOOKAHEAD, CLEARANCE);
    }
  }
  return sum;
});
const planWasmJsMath = time('WASM importing Math.sin/cos from JS', starts.length, 'plan', () => {
  let sum = 0;
  for (const s of starts) sum += wasmJsMath.planBatch(s.x, s.y, s.dir, LOOKAHEAD, CLEARANCE);
  return sum;
});

console.log('\nfirstHitOnLine (half 12 px, half 100 px lines), per line:');
const lineJs = time('TypeScript', lines.length / 4, 'line', () => {
  let sum = 0;
  for (let i = 0; i < lines.length; i += 4) sum += js.firstHitOnLine(lines[i]!, lines[i + 1]!, lines[i + 2]!, lines[i + 3]!) >= 0 ? 1 : 0;
  return sum;
});
const lineJsFast = time('TypeScript, modulo only outside the arena', lines.length / 4, 'line', () => {
  let sum = 0;
  for (let i = 0; i < lines.length; i += 4) sum += js.firstHitOnLineFast(lines[i]!, lines[i + 1]!, lines[i + 2]!, lines[i + 3]!) >= 0 ? 1 : 0;
  return sum;
});
const lineWasm = time('WASM, one call per line', lines.length / 4, 'line', () => {
  let sum = 0;
  for (let i = 0; i < lines.length; i += 4) sum += wasm.firstHitOnLine(lines[i]!, lines[i + 1]!, lines[i + 2]!, lines[i + 3]!) >= 0 ? 1 : 0;
  return sum;
});

console.log('\nSingle-pixel lookups (the chattiest possible use), per lookup:');
const N = 2_000_000;
const hasJs = time('TypeScript has()', N, 'call', () => {
  let sum = 0;
  for (let i = 0; i < N; i++) sum += js.has((i * 7) % W, (i * 13) % H) ? 1 : 0;
  return sum;
});
const hasWasm = time('WASM has() called from JS', N, 'call', () => {
  let sum = 0;
  for (let i = 0; i < N; i++) sum += wasm.has((i * 7) % W, (i * 13) % H);
  return sum;
});

console.log('\nclearRect of a blast (r = 60 circle as strips) + refill, per blast:');
const blast = (clearRect: (x: number, y: number, w: number, h: number) => void, cx: number, cy: number): void => {
  for (let dy = -60; dy <= 60; dy++) {
    const half = Math.floor(Math.sqrt(3600 - dy * dy));
    clearRect(cx - half, cy + dy, 2 * half + 1, 1);
  }
};
const blastJs = time('TypeScript', 500, 'blast', () => {
  for (let i = 0; i < 500; i++) blast((x, y, w, h) => js.clearRect(x, y, w, h), (i * 37) % W, (i * 91) % H);
  return 0;
});
const blastWasm = time('WASM (121 calls per blast)', 500, 'blast', () => {
  for (let i = 0; i < 500; i++) blast((x, y, w, h) => wasm.clearRect(x, y, w, h), (i * 37) % W, (i * 91) % H);
  return 0;
});

// Determinism: do both sides compute the same paths?
const outJs = js.out;
const check = (name: string, w: WasmExports): void => {
  const out = new Float64Array(w.memory.buffer, w.outPtr(), 8);
  let distDiff = 0;
  let bitDiff = 0;
  let total = 0;
  // Fresh arenas: the blasts above changed them
  for (const s of starts) {
    for (const [steer, turn] of [[0, 0], [1, 22], [-1, 45]] as const) {
      const a = js.rollout(s.x, s.y, s.dir, steer, turn, LOOKAHEAD, 0);
      const ax = outJs[1]!;
      const ay = outJs[2]!;
      const b = w.rollout(s.x, s.y, s.dir, steer, turn, LOOKAHEAD, 0);
      total++;
      if (a !== b) distDiff++;
      else if (!Object.is(ax, out[1]) || !Object.is(ay, out[2])) bitDiff++;
    }
  }
  console.log(`  ${name.padEnd(40)} ${distDiff} of ${total} rollouts end at a different step; ${bitDiff} more differ in the last bits of the end position`);
};
// Rebuild the arenas so that all three are identical again
js.cells.fill(0);
js.coarse.fill(0);
new Uint16Array(wasm.memory.buffer, wasm.cellsPtr(), W * H).fill(0);
new Uint16Array(wasmJsMath.memory.buffer, wasmJsMath.cellsPtr(), W * H).fill(0);
fillArena((x, y, v) => js.set(x, y, v));
fillArena((x, y, v) => wasm.set(x, y, v));
fillArena((x, y, v) => wasmJsMath.set(x, y, v));
console.log('\nDeterminism (TypeScript vs WASM on the same arena):');
check('WASM with AssemblyScript sin/cos', wasm);
check('WASM importing Math.sin/cos from JS', wasmJsMath);

// The headings the game can produce: any multiple of 4 degrees, and (analogue steering)
// anything in between
{
  const angles = createRng(123);
  let whole = 0;
  let any = 0;
  const TRIES = 1_000_000;
  for (let i = 0; i < 360; i += 4) {
    const rad = (i * Math.PI) / 180;
    if (!Object.is(Math.sin(rad), wasm.nativeSin(rad)) || !Object.is(Math.cos(rad), wasm.nativeCos(rad))) whole++;
  }
  for (let i = 0; i < TRIES; i++) {
    const rad = (angles() * 360 * Math.PI) / 180;
    if (!Object.is(Math.sin(rad), wasm.nativeSin(rad)) || !Object.is(Math.cos(rad), wasm.nativeCos(rad))) any++;
  }
  console.log(`  sin/cos, AssemblyScript vs this JS engine: ${whole} of 90 multiples of 4 degrees differ; ${any} of ${TRIES} random headings differ`);
}

console.log('\nSummary (WASM time / TypeScript time; below 1 = WASM faster):');
const ratio = (a: number, b: number): string => (a / b).toFixed(2);
console.log(`  plan, batched            ${ratio(planWasm, planJs)}`);
console.log(`  plan, call per rollout   ${ratio(planWasmCalls, planJs)}`);
console.log(`  plan, JS Math imports    ${ratio(planWasmJsMath, planJs)}`);
console.log(`  plan, TS on WASM memory  ${ratio(planShared, planJs)}`);
console.log(`  firstHitOnLine           ${ratio(lineWasm, lineJs)}   (${ratio(lineWasm, lineJsFast)} against the faster TypeScript walk)`);
console.log(`  has()                    ${ratio(hasWasm, hasJs)}`);
console.log(`  blast clearRect          ${ratio(blastWasm, blastJs)}`);
