// Bundle a TypeScript benchmark with Vite (same bundler and target as the game) and run
// it in Node:   node scripts/bench/run-node.mjs scripts/bench/sim-bench.ts [args...]
import { build } from 'vite';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const [entry, ...args] = process.argv.slice(2);
if (!entry) {
  console.error('usage: run-node.mjs <entry.ts> [args...]');
  process.exit(2);
}
const outDir = 'node_modules/.bench';
await build({
  logLevel: 'warn',
  build: { ssr: entry, outDir, emptyOutDir: false, minify: false, target: 'es2020' },
});
const file = path.join(outDir, path.basename(entry).replace(/\.ts$/, '.js'));
const nodeArgs = (process.env.NODE_FLAGS ?? '').split(' ').filter(Boolean);
const result = spawnSync(process.execPath, [...nodeArgs, file, ...args], { stdio: 'inherit' });
process.exit(result.status ?? 1);
