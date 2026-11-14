// `npm run sim:human`: before/after statistics of the bot humanisation layer
// (design/bots-human.md). Not part of the regular test run.
//
//   HUMAN_REPORT=1            all sections (slow: about an hour), or a comma-separated list of
//                             survival,early,straight,ladder,versus,weapons,range,reversal,cost,strength
//   LADDER_LEVELS=<a,b>       levels of the `ladder` section (default blank,bricks,selva)
//   OUT=<file>                also write the report there
//   ROUNDS=<n>                scale the number of rounds (default 1 = as documented)

import { writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { LEVEL_DEFINITIONS } from '../src/types/game';
import { TICK_RATE } from '../src/game/constants';
import { PixelGrid } from '../src/game/PixelGrid';
import { createRng } from '../src/game/rng';
import type { SlotIndex } from '../src/types/lobby';
import type { TronInput } from '../src/types/game';
import { makeGame, place, skipCountdown } from './helpers';
import { makeDriver, median, newStats, runMatch, survival, winRate } from './sim';
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
  it.runIf(want('survival'))('survival when left alone', () => {
    // Survival times in this game have a very long tail, so medians of a few dozen rounds
    // swing by tens of seconds; the share of bots dead within 20 s is a steadier measure.
    say('## Survival when left alone (calm mirror matches cut at 45 s, 24 rounds = 48 bots per cell)');
    say('   share of bots dead within 20 s, and (median seconds survived)');
    say('level         |          easy                 normal                 hard');
    say('              |     raw        human       raw        human       raw        human');
    const dead = [0, 0, 0, 0, 0, 0];
    let n = 0;
    for (const level of LEVELS) {
      const cells: string[] = [];
      let k = 0;
      let count = 0;
      for (const d of DIFFS) {
        for (const v of VARIANTS) {
          const spec = `${v}calm-${d}` as DriverSpec;
          const r = many(level, [spec, spec], rounds(8), [11, 12, 13], 45);
          const t = [...survival(r, 0), ...survival(r, 1)];
          const early = t.filter(x => x < 20 * TICK_RATE).length;
          dead[k++]! += early;
          count = t.length;
          cells.push(`${pct(early / t.length)} (${secs(median(t)).trim().padStart(4)})`);
        }
      }
      n += count;
      say(`${level.padEnd(13)} | ${cells.join('  ')}`);
    }
    say(`all levels    | ${dead.map(x => `${pct(x / n)}       `).join('  ')}  (of ${n} bots per cell)`);
    say();
  }, 3_600_000);

  it.runIf(want('early'))('deaths in the opening seconds', () => {
    say('## Deaths before 3 s (calm normal against calm hard, rounds cut at 8 s, every level, 10 seeds x 4 rounds)');
    say('level         |   raw: normal hard |  human: normal hard');
    const total = [0, 0, 0, 0];
    let n = 0;
    const seeds = Array.from({ length: Math.max(1, Math.round(10 * SCALE)) }, (_, i) => 9 + i);
    for (const level of LEVELS) {
      const cells: number[] = [];
      let rounds = 0;
      for (const v of VARIANTS) {
        const r = many(level, [`${v}calm-normal` as DriverSpec, `${v}calm-hard` as DriverSpec], 4, seeds, 8);
        rounds = r.length;
        for (const i of [0, 1]) cells.push(r.filter(x => x.deathTick[i] != null && x.deathTick[i]! < 3 * TICK_RATE).length);
      }
      cells.forEach((c, i) => { total[i]! += c; });
      n += rounds;
      say(`${level.padEnd(13)} |       ${String(cells[0]).padStart(3)}  ${String(cells[1]).padStart(3)}      |        ${String(cells[2]).padStart(3)}  ${String(cells[3]).padStart(3)}     (of ${rounds} each)`);
    }
    say(`total         |       ${String(total[0]).padStart(3)}  ${String(total[1]).padStart(3)}      |        ${String(total[2]).padStart(3)}  ${String(total[3]).padStart(3)}     (of ${n} each)`);
    say(`rate: raw ${pct((total[0]! + total[1]!) / (2 * n))}, human ${pct((total[2]! + total[3]!) / (2 * n))}`);
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
    say('## Duels, 80 rounds each, both seatings (win rate of the first; draws and time-outs count for nobody)');
    say('level    match-up            |   raw  human');
    for (const level of (process.env.LADDER_LEVELS ?? 'blank,bricks,selva').split(',')) {
      for (const [a, b] of [['hard', 'easy'], ['hard', 'normal'], ['normal', 'easy']] as const) {
        const cells = VARIANTS.map(v => {
          // Both seatings, so that the starting corner does not matter
          const r1 = many(level, [`${v}${a}` as DriverSpec, `${v}${b}` as DriverSpec], rounds(20), [5, 6]);
          const r2 = many(level, [`${v}${b}` as DriverSpec, `${v}${a}` as DriverSpec], rounds(20), [7, 8]);
          const wins = r1.filter(r => r.winner === 0).length + r2.filter(r => r.winner === 1).length;
          const losses = r1.filter(r => r.winner === 1).length + r2.filter(r => r.winner === 0).length;
          return `${pct(wins / (r1.length + r2.length))} (lost${pct(losses / (r1.length + r2.length))})`;
        });
        say(`${level.padEnd(8)} ${`${a} vs ${b}`.padEnd(19)} | ${cells.join('  ')}`);
      }
    }
    say();
  }, 3_600_000);

  it.runIf(want('versus'))('human against raw, and a free-for-all', () => {
    say('## Human vs raw of the same profile (win rate of the human version; blank, 80 rounds)');
    for (const d of DIFFS) {
      const r1 = many('blank', [d, `raw-${d}`], rounds(20), [5, 6]);
      const r2 = many('blank', [`raw-${d}`, d], rounds(20), [7, 8]);
      const wins = r1.filter(r => r.winner === 0).length + r2.filter(r => r.winner === 1).length;
      const losses = r1.filter(r => r.winner === 1).length + r2.filter(r => r.winner === 0).length;
      say(`${d.padEnd(7)} human wins ${pct(wins / (r1.length + r2.length))}, raw wins ${pct(losses / (r1.length + r2.length))}`);
    }
    say();
    say('## 4-player FFA on blank (easy, normal, hard, hard), 80 rounds: win rates');
    for (const v of VARIANTS) {
      const r = many('blank', DIFFS.map(d => `${v}${d}` as DriverSpec).concat(`${v}hard` as DriverSpec), rounds(40), [3, 4]);
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

  it.runIf(want('range'))('shooting range', () => {
    // One armed bot and one unarmed, harmless target wandering 120-260 px away (40-90 for
    // the Uzi) in an empty arena, for 8 s. Every pull of the trigger here is an aimed one.
    say('## Shooting range (armed bot against an unarmed wandering target in an empty arena, 8 s per trial)');
    say('   error = |heading - direction to the target| when the trigger is pulled; shots = pulls (ticks held for rifle and Uzi)');
    say('weapon   bot           | trials  fired in  first shot  shots/trial  error: median   p90   | kills  per trial  per 100 shots');
    const trials = rounds(150);
    const HOLD = new Set(['rifle', 'uzi']);
    for (const weapon of ['glock', 'shotgun', 'rifle', 'uzi']) {
      for (const d of ['normal', 'hard'] as const) {
        for (const v of VARIANTS) {
          let fired = 0;
          let shots = 0;
          let kills = 0;
          const first: number[] = [];
          const errors: number[] = [];
          for (let trial = 0; trial < trials; trial++) {
            const rng = createRng(5000 + trial);
            const g = makeGame(2, 100 + trial);
            g.setLevelObstacles(new PixelGrid());
            skipCountdown(g);
            const dist = weapon === 'uzi' ? 40 + rng() * 50 : 120 + rng() * 140;
            const bearing = (rng() * 100 - 50) * Math.PI / 180;
            place(g, 0, 375, 300, 0);
            place(g, 1, 375 + Math.cos(bearing) * dist, 300 + Math.sin(bearing) * dist, Math.floor(rng() * 90) * 4);
            g.players[0]!.equipWeapon(weapon, weapon === 'glock' || weapon === 'shotgun' ? 20 : weapon === 'rifle' ? 200 : undefined, weapon === 'uzi' ? 700 : undefined);
            const bots = [makeDriver(`${v}${d}` as DriverSpec, 0, createRng(trial * 7 + 1)), makeDriver('raw-calm-normal', 1, createRng(trial * 7 + 2))];
            const inputs = new Map<SlotIndex, TronInput>();
            let prev = false;
            let firstShot = -1;
            for (let t = 0; t < 560 && g.phase === 'playing'; t++) {
              g.items.length = 0;
              g.portals.length = 0;
              const me = g.players[0]!;
              const it = g.players[1]!;
              bots.forEach((b, i) => inputs.set(i as SlotIndex, b.decide(g)));
              const input = inputs.get(0)!;
              if (me.alive && it.alive && me.equippedWeapon?.sprite === weapon && input.action && (HOLD.has(weapon) || !prev)) {
                shots++;
                if (firstShot < 0) firstShot = t;
                // (the arena wraps: the shortest way to the target)
                const wrap = (d: number, size: number): number => (d > size / 2 ? d - size : d < -size / 2 ? d + size : d);
                const to = Math.atan2(wrap((it.y - me.y) / 1000, 600), wrap((it.x - me.x) / 1000, 750)) * 180 / Math.PI;
                errors.push(Math.abs(((to - me.direction + 540) % 360) - 180));
              }
              prev = input.action;
              g.tick(inputs);
              const frame = g.serialize();
              for (const death of frame.deaths ?? []) {
                if (death.slotIndex === 1 && death.by === 0 && death.cause !== 'trail' && death.cause !== 'crossing') kills++;
              }
            }
            if (firstShot >= 0) {
              fired++;
              first.push(firstShot);
            }
          }
          errors.sort((a, b) => a - b);
          const q = (p: number): string => (errors.length ? errors[Math.min(errors.length - 1, Math.floor(errors.length * p))]! : 0).toFixed(1).padStart(5);
          say(`${weapon.padEnd(8)} ${((v === '' ? 'human ' : 'raw ') + d).padEnd(13)} | ${String(trials).padStart(5)}   ${pct(fired / trials)}    ${secs(median(first))} s   ${(shots / trials).toFixed(1).padStart(8)}        ${q(0.5)}° ${q(0.9)}°  | ${String(kills).padStart(4)}    ${(kills / trials).toFixed(2)}      ${(shots ? (kills / shots) * 100 : 0).toFixed(2)}`);
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

  it.runIf(want('reversal'))('Control Reversal', () => {
    say('## Control Reversal: a calm bot gets it 2 s into the round (bricks and blank, against an old calm hard bot)');
    say('   deaths during the 10 s it lasts / rounds in which the bot was alive when it started; "none" = same rounds without the item');
    say('profile |  raw: none  reversed  |  human: none  reversed');
    for (const d of DIFFS) {
      const cells: string[] = [];
      for (const v of VARIANTS) {
        for (const reversed of [false, true]) {
          let deaths = 0;
          let n = 0;
          for (const level of ['bricks', 'blank']) {
            for (const seed of [41, 42, 43]) {
              const r = runMatch({
                level, drivers: [`${v}calm-${d}` as DriverSpec, 'raw-calm-hard'], rounds: rounds(8), seed, maxRoundSeconds: 14,
                during: (game, tick) => {
                  if (reversed && tick === 140 && game.players[0]!.alive) game.players[0]!.activateEffect('reverse', 700);
                },
              });
              for (const x of r) {
                const died = x.deathTick[0] ?? null;
                if (died !== null && died <= 140) continue;
                if (x.ticks <= 140) continue;
                n++;
                if (died !== null && died <= 840) deaths++;
              }
            }
          }
          cells.push(`${String(deaths).padStart(3)}/${String(n).padEnd(3)}`);
        }
      }
      say(`${d.padEnd(7)} |   ${cells[0]}  ${cells[1]}   |   ${cells[2]}  ${cells[3]}`);
    }
    say();
  }, 3_600_000);

  it.runIf(want('strength'))('strength dial', () => {
    say('## Strength dial: hard at strength s');
    say('   against the old normal bot on blank and bricks (win / lose), and left alone on blank (dead within 20 s)');
    for (const st of [0, 0.5, 1, 1.5, 2]) {
      const spec = `h${st}-hard` as DriverSpec;
      const r1 = ['blank', 'bricks'].flatMap(level => many(level, [spec, 'raw-normal'], rounds(10), [5, 6]));
      const r2 = ['blank', 'bricks'].flatMap(level => many(level, ['raw-normal', spec], rounds(10), [7, 8]));
      const wins = r1.filter(r => r.winner === 0).length + r2.filter(r => r.winner === 1).length;
      const losses = r1.filter(r => r.winner === 1).length + r2.filter(r => r.winner === 0).length;
      const total = r1.length + r2.length;
      const calm = many('blank', [`h${st}-calm-hard` as DriverSpec, `h${st}-calm-hard` as DriverSpec], rounds(8), [11, 12, 13], 45);
      const t = [...survival(calm, 0), ...survival(calm, 1)];
      say(`s=${String(st).padEnd(3)}: wins ${pct(wins / total)}, loses ${pct(losses / total)} (of ${total});  dead within 20 s ${pct(t.filter(x => x < 20 * TICK_RATE).length / t.length)} (of ${t.length})`);
    }
    say();
  }, 3_600_000);

  it('prints', () => {
    console.log('\n' + lines.join('\n') + '\n');
  });
});
