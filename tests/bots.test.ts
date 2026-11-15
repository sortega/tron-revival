import { describe, expect, it } from 'vitest';
import { LEVEL_DEFINITIONS } from '../src/types/game';
import { TICK_RATE } from '../src/game/constants';
import { median, runMatch, survival, winRate } from './sim';

const LEVELS = LEVEL_DEFINITIONS.map(l => l.id);
const secs = (ticks: number): string => (ticks / TICK_RATE).toFixed(1).padStart(6);

// `npm run sim` prints a tuning table instead of asserting
if (process.env.SIM_REPORT) {
  describe('bot report', () => {
    it('prints statistics per level', () => {
      const lines: string[] = [];
      lines.push('level         | solo-ish survival (median s)   | early deaths | hard vs easy | normal vs straight');
      lines.push('              |   easy  normal    hard         | (<3s) n / h  |  hard wins   |  normal wins');
      for (const level of LEVELS) {
        const cells: string[] = [];
        let early = '';
        for (const d of ['easy', 'normal', 'hard'] as const) {
          // Mirror match
          const r = runMatch({ level, drivers: [d, d], rounds: 10, seed: 11, maxRoundSeconds: 120 });
          cells.push(secs(median([...survival(r, 0), ...survival(r, 1)])));
          const n = [...survival(r, 0), ...survival(r, 1)].filter(t => t < 3 * TICK_RATE).length;
          if (d !== 'easy') early += ` ${String(n).padStart(2)}/20`;
        }
        const hve = runMatch({ level, drivers: ['hard', 'easy'], rounds: 16, seed: 5, maxRoundSeconds: 120 });
        const nvs = runMatch({ level, drivers: ['normal', 'straight'], rounds: 10, seed: 6, maxRoundSeconds: 120 });
        lines.push(`${level.padEnd(13)} | ${cells.join('  ')}         | ${early}  |    ${(winRate(hve, 0) * 100).toFixed(0).padStart(3)}%      |    ${(winRate(nvs, 0) * 100).toFixed(0).padStart(3)}%`);
      }
      const ffa = runMatch({ level: 'blank', drivers: ['easy', 'normal', 'hard', 'hard'], rounds: 30, seed: 3, maxRoundSeconds: 120 });
      lines.push('');
      lines.push(`4-player FFA on blank (easy, normal, hard, hard) win rates: ${[0, 1, 2, 3].map(i => (winRate(ffa, i) * 100).toFixed(0) + '%').join(', ')}; median round ${secs(median(ffa.map(r => r.ticks)))}s`);
      console.log('\n' + lines.join('\n') + '\n');
    }, 600_000);
  });
} else {
  describe('bots', () => {
    it('beat a player that drives straight on every level', () => {
      // Ten rounds say little about one level (three unlucky ones in a row do happen, at a
      // true 95 %): each level loosely, all of them together tightly
      let wins = 0;
      for (const level of LEVELS) {
        const r = runMatch({ level, drivers: ['normal', 'straight'], rounds: 10, seed: 6, maxRoundSeconds: 60 });
        expect(winRate(r, 0), level).toBeGreaterThanOrEqual(0.6);
        wins += winRate(r, 0) / LEVELS.length;
      }
      expect(wins).toBeGreaterThanOrEqual(0.9);
    }, 120_000);

    it('almost never die in the opening seconds', () => {
      let early = 0;
      let total = 0;
      for (const level of LEVELS) {
        // Rounds are cut at 4s; count bots dead before 3s. Several seeds: a seed lays out
        // the items the same way on every level, so with a single one the same unlucky
        // race for an item is counted once per level.
        for (const seed of [9, 10, 11]) {
          const r = runMatch({ level, drivers: ['calm-normal', 'calm-hard'], rounds: 3, seed, maxRoundSeconds: 4 });
          early += r.flatMap(x => x.deathTick).filter(t => t !== null && t < 3 * TICK_RATE).length;
          total += r.length * 2;
        }
      }
      expect(early / total).toBeLessThanOrEqual(0.05);
    }, 120_000);

    it('stay alive for a reasonable time when left alone', () => {
      for (const level of ['blank', 'bricks']) {
        const r = runMatch({ level, drivers: ['calm-normal', 'calm-normal'], rounds: 6, seed: 21, maxRoundSeconds: 60 });
        // Round length = survival of the first bot to die
        expect(median(r.map(x => x.ticks)), level).toBeGreaterThanOrEqual(20 * TICK_RATE);
      }
    }, 120_000);

    it('hard beats easy', () => {
      // Two seeds: a single run of 14 rounds swings too much with every rule change
      const r = [5, 6].flatMap(seed =>
        runMatch({ level: 'blank', drivers: ['hard', 'easy'], rounds: 14, seed, maxRoundSeconds: 90 }));
      expect(winRate(r, 0)).toBeGreaterThan(0.6);
    }, 120_000);

    it('play team games to completion', () => {
      const r = runMatch({ level: 'selva', drivers: ['normal', 'normal', 'easy', 'hard'], rounds: 3, seed: 4, mode: 'team', maxRoundSeconds: 90 });
      expect(r.length).toBe(3);
      for (const round of r) expect(round.ticks).toBeGreaterThan(0);
    }, 120_000);

    it('are deterministic for a seed', () => {
      const run = () => JSON.stringify(runMatch({ level: 'bus', drivers: ['hard', 'normal', 'easy'], rounds: 2, seed: 77, maxRoundSeconds: 30 }));
      expect(run()).toBe(run());
    }, 120_000);
  });
}
