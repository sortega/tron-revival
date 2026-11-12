import { describe, expect, it } from 'vitest';
import {
  DOOR_CLOSED_TICKS, DOOR_CYCLE_TICKS, DOOR_MOVING_TICKS, DOOR_OPEN_TICKS,
  doorFrame, doorSolidAt,
} from '../src/game/doors';
import { serializeState, deserializeState } from '../src/network/serialization';
import { TICK_RATE } from '../src/game/constants';
import { inputs, loadLevelGrid, makeGame, place, skipCountdown } from './helpers';
import { runMatch } from './sim';

function portalsGame(): ReturnType<typeof makeGame> {
  const game = makeGame(2, 1, { level: 'portals' });
  game.setLevelObstacles(loadLevelGrid('portals'));
  skipCountdown(game);
  // Nothing but the doors should interfere
  game.items.length = 0;
  game.portals.length = 0;
  return game;
}

function run(game: ReturnType<typeof makeGame>, ticks: number): string[] {
  const causes: string[] = [];
  for (let i = 0; i < ticks; i++) {
    game.tick(new Map());
    game.items.length = 0;
    for (const d of game.serialize().deaths ?? []) causes.push(`${d.slotIndex}:${d.cause}`);
  }
  return causes;
}

describe('door timing', () => {
  it('cycles closed, opening, open, closing', () => {
    expect(doorFrame(0)).toBe(0);
    expect(doorFrame(DOOR_CLOSED_TICKS - 1)).toBe(0);
    expect(doorFrame(DOOR_CLOSED_TICKS + 3)).toBe(1);
    expect(doorFrame(DOOR_CLOSED_TICKS + DOOR_MOVING_TICKS - 1)).toBe(9);
    expect(doorFrame(DOOR_CLOSED_TICKS + DOOR_MOVING_TICKS + DOOR_OPEN_TICKS - 1)).toBe(9);
    expect(doorFrame(DOOR_CYCLE_TICKS - DOOR_MOVING_TICKS)).toBe(9);
    expect(doorFrame(DOOR_CYCLE_TICKS - 1)).toBe(0);
    expect(doorFrame(DOOR_CYCLE_TICKS)).toBe(0);
    const frames = Array.from({ length: DOOR_CYCLE_TICKS }, (_, t) => doorFrame(t));
    expect(new Set(frames).size).toBe(10);
    for (let t = 1; t < frames.length; t++) {
      expect(Math.abs(frames[t]! - frames[t - 1]!)).toBeLessThanOrEqual(1);
    }
  });
});

describe('door geometry', () => {
  const horizontal = { x: 384, y: 300, vertical: false };
  const vertical = { x: 385, y: 290, vertical: true };

  it('matches the original sprite', () => {
    // Posts: always solid over the full thickness
    expect(doorSolidAt(horizontal, 9, 384 - 60, 300 - 25)).toBe(true);
    expect(doorSolidAt(horizontal, 9, 384 + 59, 300 + 24)).toBe(true);
    expect(doorSolidAt(horizontal, 9, 384 - 61, 300)).toBe(false);
    expect(doorSolidAt(horizontal, 9, 384, 300 + 25)).toBe(false);
    // Closed leaves leave a 5 px recess on each face
    expect(doorSolidAt(horizontal, 0, 384, 300)).toBe(true);
    expect(doorSolidAt(horizontal, 0, 384, 300 - 25)).toBe(false);
    expect(doorSolidAt(horizontal, 0, 384, 300 - 20)).toBe(true);
    // Open: 60 px opening, u 30..89
    const open = [];
    for (let x = 384 - 60; x < 384 + 60; x++) if (!doorSolidAt(horizontal, 9, x, 300)) open.push(x - 384 + 60);
    expect(open[0]).toBe(30);
    expect(open[open.length - 1]).toBe(89);
    expect(open.length).toBe(60);
  });

  it('swaps axes for vertical doors', () => {
    expect(doorSolidAt(vertical, 0, 385, 290)).toBe(true);
    expect(doorSolidAt(vertical, 9, 385, 290)).toBe(false);
    expect(doorSolidAt(vertical, 9, 385, 290 - 60)).toBe(true);
    expect(doorSolidAt(vertical, 9, 385 - 26, 290)).toBe(false);
    expect(doorSolidAt(vertical, 9, 385, 290 - 61)).toBe(false);
  });
});

describe('doors in the simulation', () => {
  it('kill a player that drives into a closed door', () => {
    const game = portalsGame();
    place(game, 0, 300, 290, 0);   // heading right, towards the centre door
    place(game, 1, 100, 500, 0);
    const causes = run(game, 80);
    expect(causes).toContain('0:door');
    expect(game.players[0]!.getScreenX()).toBe(365); // 385 - 25 + 5 px recess
  });

  it('kill despite a shield', () => {
    const game = portalsGame();
    place(game, 0, 300, 290, 0);
    place(game, 1, 100, 500, 0);
    game.players[0]!.activeEffects.push({ sprite: 'shield', remainingFrames: 2000 });
    expect(run(game, 80)).toContain('0:door');
  });

  it('let a player through while open, wrapping around the edge', () => {
    const game = portalsGame();
    place(game, 1, 100, 500, 0);
    game.doorTick = DOOR_CLOSED_TICKS + DOOR_MOVING_TICKS; // now fully open
    // Up through the top door (x 384) and out of the bottom door (x 381)
    place(game, 0, 383, 40, 270);
    const causes = run(game, 90);
    expect(causes).toEqual([]);
    expect(game.players[0]!.alive).toBe(true);
    expect(game.players[0]!.getScreenY()).toBeGreaterThan(500);
  });

  it('crush a player still in the doorway when it closes', () => {
    const game = portalsGame();
    place(game, 1, 100, 500, 0);
    game.doorTick = DOOR_CLOSED_TICKS + DOOR_MOVING_TICKS + DOOR_OPEN_TICKS - 5;
    place(game, 0, 380, 245, 90);  // driving down inside the centre doorway
    expect(run(game, 40)).toContain('0:door');
  });

  it('only run while playing and restart every round', () => {
    const game = makeGame(2, 1, { level: 'portals' });
    game.setLevelObstacles(loadLevelGrid('portals'));
    for (let i = 0; i < 20; i++) game.tick(new Map());
    expect(game.phase).toBe('countdown');
    expect(game.doorTick).toBe(0);
    skipCountdown(game);
    place(game, 0, 100, 100, 0);
    place(game, 1, 100, 500, 0);
    run(game, 30);
    const state = deserializeState(serializeState(game.serialize()));
    expect(state.round.doorTick).toBe(game.doorTick);
    game.players[1]!.kill();
    game.tick(new Map());
    expect(game.phase).toBe('waiting_ready');
    const frozen = game.doorTick;
    expect(frozen).toBeGreaterThan(30);
    for (let i = 0; i < 20; i++) game.tick(new Map());
    expect(game.doorTick).toBe(frozen);
    game.tick(inputs({ action: true }, { action: true }));
    expect(game.doorTick).toBe(0);
  });
});

describe('bots and doors', () => {
  it('rarely get crushed', () => {
    const r = runMatch({ level: 'portals', drivers: ['calm-normal', 'calm-hard'], rounds: 6, seed: 4, maxRoundSeconds: 45 });
    const causes = r.flatMap(x => x.deathCause).filter(c => c !== null);
    const doorDeaths = causes.filter(c => c!.startsWith('door')).length;
    console.log('portals deaths:', causes.join(', '), '| median round', r.map(x => (x.ticks / TICK_RATE).toFixed(0)).join(' '));
    expect(doorDeaths).toBeLessThanOrEqual(1);
  }, 120_000);
});
