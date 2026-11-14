// Self time per function from a V8 .cpuprofile (as written by `node --cpu-prof`):
//   NODE_FLAGS="--cpu-prof --cpu-prof-dir=/tmp/prof" npm run bench:sim -- --only=3bots-hard
//   node scripts/bench/top-functions.mjs /tmp/prof/<file>.cpuprofile [rows]
import { readFileSync } from 'node:fs';

const [file, rows = '25'] = process.argv.slice(2);
const profile = JSON.parse(readFileSync(file, 'utf8'));
const self = new Map();
const byId = new Map(profile.nodes.map(n => [n.id, n]));
const dt = profile.timeDeltas;
let total = 0;
profile.samples.forEach((id, i) => {
  const node = byId.get(id);
  const f = node.callFrame;
  const key = `${f.functionName || '(anonymous)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
  self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0));
  total += dt[i] ?? 0;
});
const sorted = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, Number(rows));
for (const [key, us] of sorted) {
  console.log(`${(100 * us / total).toFixed(1).padStart(5)}%  ${(us / 1000).toFixed(0).padStart(7)} ms  ${key}`);
}
