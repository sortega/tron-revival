// Run many `bots:strength` jobs in parallel: one line of arguments per job, from a file.
//
//   node scripts/bots/batch.mjs jobs.txt [--jobs=8] [--json=results.jsonl] [--quiet]
//
// Ends with totals per match-up over levels and seeds (--quiet prints only those).
//
// Lines starting with # are comments (printed as headings). The script is bundled once.
import { build } from 'vite';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';

const [file, ...rest] = process.argv.slice(2);
if (!file) {
  console.error('usage: batch.mjs <jobs.txt> [--jobs=N] [--json=file]');
  process.exit(2);
}
const opt = (name, fallback) => rest.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const parallel = Number(opt('jobs', Math.max(1, os.cpus().length - 2)));
const json = opt('json', null);

await build({
  logLevel: 'warn',
  build: { ssr: 'scripts/bots/strength.ts', outDir: 'node_modules/.bench', emptyOutDir: false, minify: false, target: 'es2020' },
});

const lines = readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
const jobs = lines.map((line, index) => ({ line, index, output: '', done: line.startsWith('#') }));
let next = 0;
let printed = 0;
let summarised = false;
const quiet = rest.includes('--quiet');

// Totals per match-up (the job's arguments without level and seed), over levels and seeds
const groups = new Map();

function collect(job) {
  const key = job.line.split(/\s+/).filter(a => !/^--(levels|seed|rounds|log-deaths)(=|$)/.test(a)).join(' ');
  const shown = [];
  for (const line of job.output.split('\n')) {
    if (!line.startsWith('JSON ')) {
      shown.push(line);
      continue;
    }
    const result = JSON.parse(line.slice(5));
    let group = groups.get(key);
    if (!group) groups.set(key, group = { levels: new Map() });
    let level = group.levels.get(result.level);
    if (!level) group.levels.set(result.level, level = { rounds: 0, medians: [], profiles: {} });
    level.rounds += result.rounds;
    level.medians.push(result.medianRound);
    for (const [spec, p] of Object.entries(result.profiles)) {
      const t = level.profiles[spec] ?? (level.profiles[spec] = { seats: 0, wins: 0, early: 0, deaths: {} });
      t.seats += p.seats;
      t.wins += Math.round(p.winPct * p.seats / 100);
      t.early += p.early;
      for (const [cause, n] of Object.entries(p.deaths)) t.deaths[cause] = (t.deaths[cause] ?? 0) + n;
    }
  }
  job.output = shown.join('\n');
}

function summary() {
  console.log('\n=== Totals per match-up (win % of seats; ± is the 95 % interval) ===');
  for (const [key, group] of groups) {
    console.log(`\n${key}`);
    const total = {};
    const row = (name, profiles, medians) => {
      const cells = Object.entries(profiles).map(([spec, t]) => {
        const p = t.wins / t.seats;
        return `${spec} ${(100 * p).toFixed(1)}% ±${(196 * Math.sqrt(p * (1 - p) / t.seats)).toFixed(0)} (${t.wins}/${t.seats}, early ${t.early})`;
      });
      const median = medians ? `   median round ${(medians.reduce((a, b) => a + b, 0) / medians.length).toFixed(1)}s` : '';
      console.log(`  ${name.padEnd(12)} ${cells.join('   ')}${median}`);
    };
    for (const [name, level] of group.levels) {
      row(name, level.profiles, level.medians);
      for (const [spec, t] of Object.entries(level.profiles)) {
        const sum = total[spec] ?? (total[spec] = { seats: 0, wins: 0, early: 0, deaths: {} });
        sum.seats += t.seats;
        sum.wins += t.wins;
        sum.early += t.early;
        for (const [cause, n] of Object.entries(t.deaths)) sum.deaths[cause] = (sum.deaths[cause] ?? 0) + n;
      }
    }
    if (group.levels.size > 1) row('ALL', total);
    for (const [spec, t] of Object.entries(total)) {
      const deaths = Object.entries(t.deaths).sort((a, b) => b[1] - a[1]).map(([cause, n]) => `${cause} ${n}`).join(', ');
      console.log(`  deaths of ${spec}: ${deaths}`);
    }
  }
}

function flush() {
  while (printed < jobs.length && jobs[printed].done) {
    const job = jobs[printed++];
    if (job.line.startsWith('#')) {
      process.stdout.write(`\n${job.line}\n`);
    } else {
      collect(job);
      if (!quiet) process.stdout.write(job.output);
    }
  }
  if (printed === jobs.length && jobs.length > 0 && !summarised) {
    summarised = true;
    summary();
  }
}

function start() {
  while (next < jobs.length && jobs[next].done) next++;
  if (next >= jobs.length) return;
  const job = jobs[next++];
  const args = [...job.line.split(/\s+/), '--summary'];
  if (json) args.push(`--json=${json}`);
  const child = spawn(process.execPath, ['node_modules/.bench/strength.js', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => { job.output += d; });
  child.stderr.on('data', d => { job.output += d; });
  child.on('close', () => {
    job.done = true;
    flush();
    start();
  });
}

flush();
for (let i = 0; i < parallel; i++) start();
