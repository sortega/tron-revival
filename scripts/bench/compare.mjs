// Markdown table comparing two result files of the same benchmark:
//   node scripts/bench/compare.mjs before.json after.json
// Works with the --json output of bench:sim and bench:browser.
import { readFileSync } from 'node:fs';

const [beforeFile, afterFile] = process.argv.slice(2);
if (!beforeFile || !afterFile) {
  console.error('usage: compare.mjs before.json after.json');
  process.exit(2);
}
const before = JSON.parse(readFileSync(beforeFile, 'utf8'));
const after = JSON.parse(readFileSync(afterFile, 'utf8'));

const browser = before.results[0]?.profile !== undefined;
const key = r => (browser ? `${r.profile} | ${r.scenario}` : r.scenario);
const afterBy = new Map(after.results.map(r => [key(r), r]));

if (browser) {
  // Milliseconds per simulation tick (step) and per display frame (frame)
  const f = v => v.toFixed(2);
  const cell = (r, phase) => {
    const s = r?.phases?.[phase];
    return s ? `${f(s.mean)} / ${f(s.p95)} / ${f(s.p99)}` : '–';
  };
  console.log('| profile | scenario | step ms, before (mean / p95 / p99) | step ms, after | frame ms, before | frame ms, after | fps | slow frames | GC ms/s |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const b of before.results) {
    const a = afterBy.get(key(b));
    if (!a) continue;
    const gc = r => (r.trace ? (r.trace.gc.totalMs / r.seconds).toFixed(1) : '?');
    console.log(`| ${key(b)} | ${cell(b, 'step')} | ${cell(a, 'step')} | ${cell(b, 'frame')} | ${cell(a, 'frame')} | ${b.fps.toFixed(1)} → ${a.fps.toFixed(1)} | ${b.slowFrames} → ${a.slowFrames} | ${gc(b)} → ${gc(a)} |`);
  }
} else {
  // Microseconds per tick
  const f = ms => (ms * 1000).toFixed(ms < 0.01 ? 1 : 0);
  console.log('| scenario | before, µs (mean / p95 / p99) | after, µs | speed-up (mean) | KB allocated per tick |');
  console.log('|---|---|---|---|---|');
  for (const b of before.results) {
    const a = afterBy.get(key(b));
    if (!a) continue;
    const cell = r => `${f(r.total.mean)} / ${f(r.total.p95)} / ${f(r.total.p99)}`;
    console.log(`| ${b.scenario} | ${cell(b)} | ${cell(a)} | ×${(b.total.mean / a.total.mean).toFixed(1)} | ${b.allocKbPerTick.toFixed(0)} → ${a.allocKbPerTick.toFixed(0)} |`);
  }
}
