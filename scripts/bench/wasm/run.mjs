// Compile the AssemblyScript kernel (two variants) and run the WASM-vs-TypeScript
// microbenchmark:   npm run bench:wasm
import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';

const out = 'node_modules/.bench';
mkdirSync(out, { recursive: true });
const asc = 'node_modules/assemblyscript/bin/asc.js';
const common = ['scripts/bench/wasm/kernel.as.ts', '-O3', '--runtime', 'stub', '--noAssert'];

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// 1. sin/cos computed inside the module (AssemblyScript's own implementation)
run(process.execPath, [asc, ...common, '-o', `${out}/kernel.native.wasm`]);
// 2. sin/cos imported from JavaScript, so that both sides use the very same functions
run(process.execPath, [asc, ...common, '--use', 'JS_TRIG=1', '-o', `${out}/kernel.jsmath.wasm`]);
console.log(`kernel.native.wasm ${statSync(`${out}/kernel.native.wasm`).size} bytes, kernel.jsmath.wasm ${statSync(`${out}/kernel.jsmath.wasm`).size} bytes\n`);

run(process.execPath, ['scripts/bench/run-node.mjs', 'scripts/bench/wasm/wasm-bench.ts']);
