import { describe, expect, it } from 'vitest';
import { BotController, BOT_PROFILES } from '../src/game/ai/BotController';
import { cellOf, territoryOf } from '../src/game/ai/territory';
import { TerritorySense } from '../src/game/ai/territorySense';
import { PixelGrid } from '../src/game/PixelGrid';
import { PLAY_HEIGHT, PLAY_WIDTH } from '../src/game/constants';
import { createRng } from '../src/game/rng';
import type { BotDifficulty } from '../src/types/game';
import { scatterInHalves, splitArena } from '../scripts/bots/arenas';
import { makeGame, place, skipCountdown } from './helpers';
import { runMatch, winRate } from './sim';

const WALL = '#888888';
type Game = ReturnType<typeof makeGame>;

function hline(grid: PixelGrid, y: number, x0: number, x1: number): void {
  for (let x = x0; x <= x1; x++) grid.set(x, y, WALL);
}

function vline(grid: PixelGrid, x: number, y0: number, y1: number): void {
  for (let y = y0; y <= y1; y++) grid.set(x, y, WALL);
}

function frame(grid: PixelGrid): void {
  hline(grid, 0, 0, PLAY_WIDTH - 1);
  hline(grid, PLAY_HEIGHT - 1, 0, PLAY_WIDTH - 1);
  vline(grid, 0, 0, PLAY_HEIGHT - 1);
  vline(grid, PLAY_WIDTH - 1, 0, PLAY_HEIGHT - 1);
}

/** A two-player game on the given obstacles, playing, without items or portals. */
function gameOn(grid: PixelGrid): Game {
  const g = makeGame(2, 1);
  g.setLevelObstacles(grid);
  skipCountdown(g);
  g.items.length = 0;
  g.portals.length = 0;
  return g;
}

/** Let the bot in slot 0 drive for `ticks`; slot 1 stands still (kept alive, no trail). */
function drive(g: Game, bot: BotController, ticks: number): void {
  const other = g.players[1]!;
  const { x, y } = other;
  for (let i = 0; i < ticks && g.players[0]!.alive; i++) {
    g.tick(new Map([[0, bot.decide(g)], [1, { steer: 0, action: false }]]));
    g.pixels.delete(Math.floor(other.x / 1000), Math.floor(other.y / 1000));
    other.x = x;
    other.y = y;
    other.prevScreenX = -1;
    other.prevScreenY = -1;
    other.alive = true;
    g.items.length = 0;
    g.portals.length = 0;
    g.serialize();
  }
}

/**
 * The bot comes up a corridor into a junction with a chamber on each side: a small one
 * (about 500 cells, still more than the 400 the old flood fill could tell apart) and a
 * large one. The other player is sealed in a box.
 */
function twoChambers(smallOnLeft: boolean): Game {
  const grid = new PixelGrid();
  frame(grid);
  hline(grid, 300, 0, 349);            // Floor of the chambers, with the corridor's mouth
  hline(grid, 300, 401, PLAY_WIDTH - 1);
  vline(grid, 349, 300, PLAY_HEIGHT - 1);  // The corridor
  vline(grid, 401, 300, PLAY_HEIGHT - 1);
  vline(grid, 375, 0, 262);            // The wall between the chambers: going in closes the door behind
  // The small chamber is cut down to 120 px
  vline(grid, smallOnLeft ? 250 : 500, 0, 300);
  const g = gameOn(grid);
  place(g, 0, 375, 520, 270);
  place(g, 1, 100, 500, 0);            // Outside all of it
  return g;
}

describe('bots and territory: room', () => {
  it('a bot on its own takes the larger of two chambers', () => {
    for (const smallOnLeft of [true, false]) {
      const g = twoChambers(smallOnLeft);
      const bot = new BotController(0, 'hard', createRng(1));
      drive(g, bot, 330);
      const me = g.players[0]!;
      expect(me.alive, `small on the ${smallOnLeft ? 'left' : 'right'}`).toBe(true);
      expect(bot.sense!.filling).toBe(true);
      expect(me.y / 1000).toBeLessThan(300);
      if (smallOnLeft) expect(me.x / 1000).toBeGreaterThan(375); else expect(me.x / 1000).toBeLessThan(375);
    }
  });

  it('room that an enemy gets to first counts for less', () => {
    // Two identical closed boxes; the enemy is in the right one
    const grid = new PixelGrid();
    frame(grid);
    for (const x0 of [100, 500]) {
      hline(grid, 200, x0, x0 + 150);
      hline(grid, 400, x0, x0 + 150);
      vline(grid, x0, 200, 400);
      vline(grid, x0 + 150, 200, 400);
    }
    const g = gameOn(grid);
    place(g, 0, 375, 100, 90);
    place(g, 1, 640, 300, 180);
    const sense = new TerritorySense({ ...BOT_PROFILES.normal.territory!, foeWeight: 0.5 });
    sense.begin(g, 0, []);
    expect(sense.filling).toBe(false);
    // A path that ends inside each box (how it got in does not matter here)
    const left = sense.judge(g.pixels, [cellOf(230, 300)], 220, 300, 180, 200).room;
    const right = sense.judge(g.pixels, [cellOf(630, 300)], 620, 300, 180, 200).room;
    expect(left).toBe(1);                      // A box is just over 400 cells: plenty
    expect(right).toBeLessThan(0.7);           // ...but not if the enemy takes most of them
    // Without territory (weight 1) they are the same
    const blind = new TerritorySense({ ...BOT_PROFILES.normal.territory!, foeWeight: 1 });
    blind.begin(g, 0, []);
    expect(blind.judge(g.pixels, [cellOf(630, 300)], 620, 300, 180, 200).room).toBe(1);
  });

  it('does not count the room behind a wall', () => {
    const grid = new PixelGrid();
    frame(grid);
    // A dead end: the path stops 3 px short of a wall with the open arena behind it
    vline(grid, 400, 0, PLAY_HEIGHT - 1);
    hline(grid, 280, 200, 400);
    hline(grid, 320, 200, 400);
    const g = gameOn(grid);
    place(g, 0, 150, 300, 0);
    place(g, 1, 600, 300, 180);
    const sense = new TerritorySense(BOT_PROFILES.hard.territory!);
    sense.begin(g, 0, []);
    const cells = [];
    for (let x = 160; x <= 392; x += 8) cells.push(cellOf(x, 300));
    expect(sense.judge(g.pixels, cells, 396, 300, 0, 246).room).toBeLessThan(0.05);
  });
});

describe('bots and territory: which side of a cut is bigger', () => {
  it('looks further into the room of the best path, and only of that one', () => {
    // A chamber of some 850 cells whose door the path closes behind it; outside, the arena
    const grid = new PixelGrid();
    frame(grid);
    hline(grid, 60, 60, 300);
    hline(grid, 300, 60, 300);
    vline(grid, 60, 60, 300);
    vline(grid, 300, 60, 170);
    vline(grid, 300, 190, 300);
    const g = gameOn(grid);
    place(g, 0, 400, 180, 180);
    place(g, 1, 600, 500, 180);
    const into: number[] = [];
    for (let x = 392; x >= 250; x -= 8) into.push(cellOf(x, 180));
    const open: number[] = [];
    for (let x = 400; x <= 600; x += 8) open.push(cellOf(x, 450));

    const judgeBoth = (sense: TerritorySense): number[] => {
      sense.begin(g, 0, []);
      const a = sense.judge(g.pixels, into, 250, 180, 180, 150).room;
      const b = sense.judge(g.pixels, open, 600, 450, 0, 200).room;
      return [a, b];
    };
    // Counted to 400 cells, both have plenty
    const hard = new TerritorySense(BOT_PROFILES.hard.territory!);
    expect(judgeBoth(hard)).toEqual([1, 1]);
    // ...but the chamber is the better-scored path, so it is counted on: 850 of 1400
    const scores = [100, 90];
    expect(hard.review(scores, 180)).toBe(1);
    expect(scores[0]).toBeLessThan(60);
    expect(scores[0]).toBeGreaterThan(0);
    expect(scores[1]).toBe(90);
    // Had the open path been ahead, nothing would have been counted further
    judgeBoth(hard);
    const others = [80, 90];
    expect(hard.review(others, 180)).toBe(1);
    expect(others).toEqual([80, 90]);
    // A normal bot's plenty is 400 cells: it cannot tell them apart
    const normal = new TerritorySense(BOT_PROFILES.normal.territory!);
    expect(judgeBoth(normal)).toEqual([1, 1]);
    const same = [100, 90];
    expect(normal.review(same, 130)).toBe(0);
    expect(same).toEqual([100, 90]);
  });
});

describe('bots and territory: endgame', () => {
  it('knows when it is alone in its region', () => {
    const closed = gameOn(splitArena());
    place(closed, 0, 150, 300, 0);
    place(closed, 1, 600, 300, 180);
    const bot = new BotController(0, 'hard', createRng(1));
    bot.decide(closed);
    expect(bot.sense!.filling).toBe(true);
    expect(territoryOf(closed).shared[0]).toBe(0);

    const grid = splitArena();
    for (let y = 250; y < 350; y++) for (const x of [374, 375]) grid.delete(x, y);
    const open = gameOn(grid);
    place(open, 0, 150, 300, 0);
    place(open, 1, 600, 300, 180);
    const other = new BotController(0, 'hard', createRng(1));
    other.decide(open);
    expect(other.sense!.filling).toBe(false);
    // Normal and easy bots do not fill
    const normal = new BotController(0, 'normal', createRng(1));
    normal.decide(closed);
    expect(normal.sense!.filling).toBe(false);
    expect(new BotController(0, 'easy', createRng(1)).sense).toBeNull();
  });

  it('fills its half of a split arena better than a bot without the map', () => {
    const scatter = createRng(5);
    const r = runMatch({
      level: 'blank', grid: splitArena(), drivers: ['hard', 'old-hard'], rounds: 6, seed: 3,
      bare: true, maxRoundSeconds: 400, setup: (game) => scatterInHalves(game, scatter),
    });
    expect(winRate(r, 0)).toBeGreaterThanOrEqual(5 / 6);
  }, 240_000);
});

describe('bots and territory: goals', () => {
  /** Bot in slot 0 at (250, 300) heading right, on an empty framed arena. */
  function duel(enemyX: number, enemyY: number, enemyDir: number): Game {
    const grid = new PixelGrid();
    frame(grid);
    const g = gameOn(grid);
    place(g, 0, 250, 300, 0);
    place(g, 1, enemyX, enemyY, enemyDir);
    return g;
  }

  function goalOf(g: Game, difficulty: BotDifficulty | 'old-hard'): string | null {
    const bot = difficulty === 'old-hard'
      ? new BotController(0, { ...BOT_PROFILES.hard, territory: null }, createRng(1))
      : new BotController(0, difficulty, createRng(1));
    bot.decide(g);
    return bot.goalKind;
  }

  it('a hard bot does not chase an enemy it cannot get ahead of', () => {
    // The enemy is ahead and driving away: everything on its course is its own
    const away = duel(400, 300, 0);
    expect(goalOf(away, 'old-hard')).toBe('seek');
    expect(goalOf(away, 'hard')).toBeNull();
    // Crossing in front of us: we can be on its course before it is
    const crossing = duel(330, 150, 90);
    expect(goalOf(crossing, 'hard')).toBe('seek');
    // Armed, it goes for the enemy as before
    away.players[0]!.equipWeapon('glock', 20);
    expect(goalOf(away, 'hard')).toBe('seek');
  });

  it('heads for the point where it gets ahead of the prey', () => {
    const g = duel(330, 150, 90);
    const sense = new TerritorySense(BOT_PROFILES.hard.territory!);
    sense.begin(g, 0, []);
    const cut = sense.intercept(1, 330, 150, 90)!;
    expect(cut).not.toBeNull();
    expect(cut.x).toBeCloseTo(330, 0);
    expect(cut.y).toBeGreaterThan(200);        // On its course, well ahead of it
    expect(cut.y).toBeLessThan(450);
    const map = territoryOf(g);
    expect(map.time[0]![cellOf(cut.x, cut.y)]).toBeLessThan(map.time[1]![cellOf(cut.x, cut.y)]!);
  });

  it('finds the border between its territory and the enemy\'s', () => {
    // Facing each other 400 px apart: the border is half-way
    const g = duel(650, 300, 180);
    const sense = new TerritorySense({ ...BOT_PROFILES.hard.territory!, expands: true });
    sense.begin(g, 0, []);
    const border = sense.frontier()!;
    expect(border).not.toBeNull();
    expect(border.x).toBeGreaterThan(400);
    expect(border.x).toBeLessThan(500);
    const map = territoryOf(g);
    const cell = cellOf(border.x, border.y);
    expect(Math.abs(map.time[0]![cell]! - map.foeTime[0]![cell]!)).toBeLessThanOrEqual(4);
    // A bot told to expand heads there when it has nothing else to do
    const bot = new BotController(0, { ...BOT_PROFILES.normal, territory: { ...BOT_PROFILES.normal.territory!, expands: true } }, createRng(1));
    bot.decide(g);
    expect(bot.goalKind).toBe('expand');
    // Alone in its region there is no border
    const alone = gameOn(splitArena());
    place(alone, 0, 150, 300, 0);
    place(alone, 1, 600, 300, 180);
    sense.begin(alone, 0, []);
    expect(sense.frontier()).toBeNull();
  });

  it('leaves alone the items an enemy gets to first, or that it cannot reach', () => {
    const item = (x: number, y: number) => ({ id: 77, sprite: 'shield', category: 'automatic' as const, x, y, active: true, hp: 40 });
    for (const difficulty of ['normal', 'hard'] as const) {
      const theirs = duel(450, 300, 180);
      theirs.items.push(item(430, 300));
      expect(goalOf(theirs, difficulty), difficulty).not.toBe('item');
      expect(goalOf(theirs, 'old-hard')).toBe('item');

      const ours = duel(450, 300, 180);
      ours.items.push(item(300, 320));
      expect(goalOf(ours, difficulty), difficulty).toBe('item');
    }
    // Behind a wall
    const grid = new PixelGrid();
    frame(grid);
    vline(grid, 300, 0, PLAY_HEIGHT - 1);
    const walled = gameOn(grid);
    place(walled, 0, 250, 300, 90);
    place(walled, 1, 600, 500, 180);
    walled.items.push(item(340, 300));
    expect(goalOf(walled, 'hard')).not.toBe('item');
    expect(goalOf(walled, 'old-hard')).toBe('item');
  });
});
