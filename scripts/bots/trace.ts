// What a bot was thinking: the planner's candidates (BotController.trace) around a
// moment of a replayed round. Arguments as for bots:snapshots, plus the seat and the time:
//
//   npm run bots:trace -- --drivers=hard,old-hard --level=bricks --seed=1 --rot=0 --round=18 --seat=0 --from=41 --to=42

import { BotController } from '../../src/game/ai/BotController';
import { TICK_RATE } from '../../src/game/constants';
import { createRng } from '../../src/game/rng';
import type { GameMode } from '../../src/types/lobby';
import { runMatch } from '../../tests/sim';
import type { DriverSpec } from '../../tests/sim';
import { scatterInHalves, splitArena } from './arenas';

const args = new Map(process.argv.slice(2).map(a => {
  const i = a.indexOf('=');
  return i < 0 ? [a.replace(/^--/, ''), '1'] as const : [a.slice(2, i), a.slice(i + 1)] as const;
}));
const drivers = (args.get('drivers') ?? 'hard,old-hard').split(',') as DriverSpec[];
const level = args.get('level') ?? 'bricks';
const seed = Number(args.get('seed') ?? 1);
const rot = Number(args.get('rot') ?? 0);
const round = Number(args.get('round') ?? 1) - 1;
const seat = Number(args.get('seat') ?? 0);
const from = Number(args.get('from') ?? 0) * TICK_RATE;
const to = Number(args.get('to') ?? 1e9) * TICK_RATE;
const seats = drivers.map((_, i) => drivers[(i + rot) % drivers.length]!);
const scatter = createRng(seed * 7919 + rot);

let bot: BotController | null = null;
runMatch({
  level: level === 'split' ? 'blank' : level, grid: level === 'split' ? splitArena() : undefined,
  drivers: seats, seed: seed * 100 + rot, rounds: round + 1, bare: args.has('bare'),
  mode: (args.get('mode') ?? 'ffa') as GameMode, maxRoundSeconds: Number(args.get('max') ?? 120),
  setup: level === 'split' ? (game) => scatterInHalves(game, scatter) : undefined,
  inspect(all) {
    const driver = all[seat];
    if (!(driver instanceof BotController)) throw new Error(`seat ${seat} (${seats[seat]}) is not a bot`);
    bot = driver;
  },
  observe(game, r, tick) {
    if (!bot) return;
    const me = game.players[seat]!;
    if (r === round && tick >= from && tick <= to && me.alive) {
      const lines = bot.trace ?? [];
      const sense = bot.sense;
      console.log(`t=${(tick / TICK_RATE).toFixed(2)}s tick ${tick} at ${(me.x / 1000).toFixed(0)},${(me.y / 1000).toFixed(0)} dir ${me.direction} steer ${bot.debug.steer} goal ${bot.goalKind}` +
        (sense?.map ? ` filling ${sense.filling} reach ${sense.map.reach[me.slotIndex]} shared ${sense.map.shared[me.slotIndex]}` : ''));
      for (const line of lines) console.log(`    ${line}`);
      bot.trace = [];
    } else {
      bot.trace = r === round && tick >= from - 1 && tick <= to ? [] : null;
    }
  },
});
