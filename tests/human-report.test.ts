// `npm run sim:human`: before/after statistics of the bot humanisation layer
// (design/bots-human.md). Not part of the regular test run.
//
//   HUMAN_REPORT=1            all sections (slow), or a comma-separated list of
//                             survival,straight,ladder,weapons,cost,strength
//   OUT=<file>                also write the report there
//   ROUNDS=<n>                scale the number of rounds (default 1 = as documented)

import { writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { LEVEL_DEFINITIONS } from '../src/types/game';
import { TICK_RATE } from '../src/game/constants';
import { median, newStats, runMatch, survival, winRate } from './sim';
import type { DriverSpec, MatchStats, RoundResult } from './sim';

const LEVELS = LEVEL_DEFINITIONS.map(l => l.id);
const SCALE = Number(process.env.ROUNDS ?? 1);
const rounds = (n: number): number => Math.max(2, Math.round(n * SCALE));
const want = (section: string): boolean => {
  const v = process.env.HUMAN_REPORT ?? '';
  return v === '1' || v.split(',').includes(section);
};
const pct = (x: number): string => `${(x * 100).toFixed(0)}%`.padStart(5);
const secs = (ticks: number): string => (ticks / TICK_RATE).toFixed(1).padStart(6);
const DIFFS = ['easy', 'normal', 'hard'] as const;
const VARIANTS = ['raw-', ''] as const; // Before, after

const lines: string[] = [];
const say = (line = ''): void => {
  lines.push(line);
  if (process.env.OUT) writeFileSync(process.env.OUT, lines.join('\n') + '\n');
};

function many(level: string, drivers: DriverSpec[], n: number, seeds: number[], maxRoundSeconds = 120, stats?: MatchStats): RoundResult[] {
  return seeds.flatMap(seed => runMatch({ level, drivers, rounds: n, seed, maxRoundSeconds, ...(stats && { stats }) }));
}

describe.runIf(!!process.env.HUMAN_REPORT)('human bots report', () => {
  it.runIf(want('survival'))('survival and early deaths per level', () => {
    say('## Survival when left alone (calm mirror matches; median seconds until a bot dies) and deaths before 3 s');
    say('level         |      easy          normal          hard     | early deaths (<3 s), normal+hard');
    say('              |   raw  human     raw  human     raw  human  |   raw      human');
    const totals = { raw: [0, 0], human: [0, 0] };
    for (const level of LEVELS) {
      const cells: string[] = [];
      const early = { raw: 0, human: 0 };
      let n = 0;
      for (const d of DIFFS) {
        for (const v of VARIANTS) {
          const spec = `${v}calm-${d}` as DriverSpec;
          const r = many(level, [spec, spec], rounds(6), [11, 12], 90);
          const s = [...survival(r, 0), ...survival(r, 1)];
          cells.push(secs(median(s)));
          if (d !== 'easy') {
            early[v === '' ? 'human' : 'raw'] += s.filter(t => t < 3 * TICK_RATE).length;
            if (v === '') n += s.length;
          }
        }
      }
      totals.raw[0]! += early.raw; totals.raw[1]! += n;
      totals.human[0]! += early.human; totals.human[1]! += n;
      say(`${level.padEnd(13)} | ${cells[0]} ${cells[1]}  ${cells[2]} ${cells[3]}  ${cells[4]} ${cells[5]}  |  ${String(early.raw).padStart(2)}/${n}    ${String(early.human).padStart(2)}/${n}`);
    }
    say(`early deaths overall: raw ${totals.raw[0]}/${totals.raw[1]}, human ${totals.human[0]}/${totals.human[1]}`);
    say();
  }, 3_600_000);

  it.runIf(want('straight'))('normal beats straight on every level', () => {
    say('## normal vs a player driving straight (win rate of normal)');
    say('level         |   raw  human');
    for (const level of LEVELS) {
      const cells = VARIANTS.map(v => pct(winRate(many(level, [`${v}normal` as DriverSpec, 'straight'], rounds(10), [6, 7], 60), 0)));
      say(`${level.padEnd(13)} | ${cells.join('  ')}`);
    }
    say();
  }, 3_600_000);

  it.runIf(want('ladder'))('ordering of the profiles', () => {
    say('## Duels (win rate of the first; draws and time-outs count for nobody)');
    say('level    match-up            |   raw  human');
    for (const level of ['blank', 'bricks', 'selva']) {
      for (const [a, b] of [['hard', 'easy'], ['hard', 'normal'], ['normal', 'easy']] as const) {
        const cells = VARIANTS.map(v => {
          // Both seatings, so that the starting corner does not matter
          const r1 = many(level, [`${v}${a}` as DriverSpec, `${v}${b}` as DriverSpec], rounds(12), [5, 6]);
          const r2 = many(level, [`${v}${b}` as DriverSpec, `${v}${a}` as DriverSpec], rounds(12), [7, 8]);
          const wins = r1.filter(r => r.winner === 0).length + r2.filter(r => r.winner === 1).length;
          const losses = r1.filter(r => r.winner === 1).length + r2.filter(r => r.winner === 0).length;
          return `${pct(wins / (r1.length + r2.length))} (lost${pct(losses / (r1.length + r2.length))})`;
        });
        say(`${level.padEnd(8)} ${`${a} vs ${b}`.padEnd(19)} | ${cells.join('  ')}`);
      }
    }
    say();
    say('## Human vs raw of the same profile (win rate of the human version; blank)');
    for (const d of DIFFS) {
      const r1 = many('blank', [d, `raw-${d}`], rounds(12), [5, 6]);
      const r2 = many('blank', [`raw-${d}`, d], rounds(12), [7, 8]);
      const wins = r1.filter(r => r.winner === 0).length + r2.filter(r => r.winner === 1).length;
      const losses = r1.filter(r => r.winner === 1).length + r2.filter(r => r.winner === 0).length;
      say(`${d.padEnd(7)} human wins ${pct(wins / (r1.length + r2.length))}, raw wins ${pct(losses / (r1.length + r2.length))}`);
    }
    say();
    say('## 4-player FFA on blank (easy, normal, hard, hard): win rates');
    for (const v of VARIANTS) {
      const r = many('blank', DIFFS.map(d => `${v}${d}` as DriverSpec).concat(`${v}hard` as DriverSpec), rounds(20), [3, 4]);
      say(`${v === '' ? 'human' : 'raw  '}: ${[0, 1, 2, 3].map(i => pct(winRate(r, i))).join(' ')}   median round ${secs(median(r.map(x => x.ticks)))} s`);
    }
    say();
  }, 3_600_000);

  it.runIf(want('weapons'))('weapons, aim and steering', () => {
    say('## Weapons and steering (4-player FFA of one profile on blank and bricks)');
    for (const d of ['normal', 'hard'] as const) {
      for (const v of VARIANTS) {
        const stats = newStats(4);
        const spec = `${v}${d}` as DriverSpec;
        for (const level of ['blank', 'bricks']) many(level, [spec, spec, spec, spec], rounds(15), [21, 22], 120, stats);
        const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
        const play = sum(stats.playTicks);
        const merge = (rs: Record<string, number>[]): Record<string, number> => {
          const out: Record<string, number> = {};
          for (const r of rs) for (const [k, n] of Object.entries(r)) out[k] = (out[k] ?? 0) + n;
          return out;
        };
        const pulls = merge(stats.pulls);
        const kills = merge(stats.kills);
        const errors = stats.aimErrors.flat();
        const mean = errors.length ? sum(errors) / errors.length : 0;
        const rms = errors.length ? Math.sqrt(sum(errors.map(e => e * e)) / errors.length) : 0;
        say(`${(v === '' ? 'human ' : 'raw ') + d}: ${(play / TICK_RATE / 60).toFixed(1)} bot-minutes`);
        say(`  steering: ${(sum(stats.steerChanges) / (play / TICK_RATE)).toFixed(2)} key changes/s, turning ${pct(sum(stats.turnTicks) / play)} of the time, squeezing (≤2 px both sides) ${(sum(stats.squeezeTicks) / (play / TICK_RATE / 60)).toFixed(1)} ticks/min`);
        say(`  aimed pulls: ${errors.length}, heading error mean ${mean.toFixed(2)}°, rms ${rms.toFixed(2)}°`);
        for (const w of ['glock', 'shotgun', 'bomb', 'rifle', 'uzi']) {
          const p = pulls[w] ?? 0;
          const k = kills[w] ?? 0;
          const unit = w === 'rifle' || w === 'uzi' ? 'kills per 10 s of fire' : 'kills per 100 pulls';
          const rate = p === 0 ? 0 : w === 'rifle' || w === 'uzi' ? k / (p / TICK_RATE / 10) : (k / p) * 100;
          say(`  ${w.padEnd(8)} pulls ${String(p).padStart(6)}  kills ${String(k).padStart(4)}  ${rate.toFixed(2)} ${unit}`);
        }
      }
    }
    say();
  }, 3_600_000);

  it.runIf(want('cost'))('cost per tick', () => {
    say('## Cost of a decision (ms per bot and tick; duels on blank and bricks)');
    say('profile |    raw   human   overhead');
    for (const d of DIFFS) {
      const cells: number[] = [];
      for (const v of VARIANTS) {
        const stats = newStats(2);
        const spec = `${v}${d}` as DriverSpec;
        for (const level of ['blank', 'bricks']) many(level, [spec, spec], rounds(6), [31], 60, stats);
        cells.push((stats.decideMs[0]! + stats.decideMs[1]!) / (stats.decideCalls[0]! + stats.decideCalls[1]!));
      }
      say(`${d.padEnd(7)} | ${cells[0]!.toFixed(4)}  ${cells[1]!.toFixed(4)}  ${((cells[1]! / cells[0]! - 1) * 100).toFixed(0)}%`);
    }
    say();
  }, 3_600_000);

  it.runIf(want('strength'))('strength dial', () => {
    say('## Strength dial: hard at strength s against raw normal (blank; win rate of hard), and its calm survival');
    for (const s of [0, 0.5, 1, 1.5, 2]) {
      const spec = `h${s}-hard` as DriverSpec;
      const r = many('blank', [spec, 'raw-normal'], rounds(12), [5, 6]);
      const calm = many('blank', [`h${s}-calm-hard` as DriverSpec, `h${s}-calm-hard` as DriverSpec], rounds(6), [11], 90);
      say(`s=${s}: wins ${pct(winRate(r, 0))}, loses ${pct(winRate(r, 1))}; calm mirror survival ${secs(median([...survival(calm, 0), ...survival(calm, 1)]))} s`);
    }
    say();
  }, 3_600_000);

  it('prints', () => {
    console.log('\n' + lines.join('\n') + '\n');
  });
});
