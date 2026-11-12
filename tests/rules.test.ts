import { describe, expect, it } from 'vitest';
import { PixelGrid } from '../src/game/PixelGrid';
import { serializeState, deserializeState } from '../src/network/serialization';
import { createRng } from '../src/game/rng';
import { PLAY_WIDTH, PLAY_HEIGHT, READY_LOCK_TICKS } from '../src/game/constants';
import type { SlotIndex } from '../src/types/lobby';
import type { TronInput } from '../src/types/game';
import { inputs, loadLevelGrid, makeGame, place, skipCountdown } from './helpers';

function wallLevel(): PixelGrid {
  const level = new PixelGrid();
  for (let y = 0; y < PLAY_HEIGHT; y++) level.set(400, y, '#808080');
  return level;
}

/** End the current round by killing everybody but player 0, then ready up. */
function finishRoundAndReady(game: ReturnType<typeof makeGame>): void {
  for (const p of game.players.slice(1)) p.kill();
  game.tick(new Map());
  game.serialize();
  expect(game.phase).toBe('waiting_ready');
  for (let i = 0; i < READY_LOCK_TICKS; i++) game.tick(new Map());
  const press = inputs(...game.players.map(() => ({ action: true })));
  game.tick(press);
  game.serialize();
}

describe('round lifecycle', () => {
  it('ignores action presses in the first second after a round ends', () => {
    const game = makeGame(2);
    skipCountdown(game);
    game.players[1]!.kill();
    game.tick(new Map());
    expect(game.phase).toBe('waiting_ready');
    const press = inputs({ action: true }, { action: true });
    const release = inputs({}, {});
    // Taps during the lock do nothing
    for (let i = 0; i < READY_LOCK_TICKS - 1; i++) game.tick(i % 2 === 0 ? press : release);
    game.tick(press);
    expect(game.playersReady.size).toBe(0);
    // A button held through the lock does not count either
    game.tick(press);
    game.tick(press);
    expect(game.phase).toBe('waiting_ready');
    // Released and pressed again: ready
    game.tick(release);
    game.tick(press);
    expect(game.phase).toBe('countdown');
  });

  it('counts down, plays and awards the round to the survivor', () => {
    const game = makeGame(2);
    expect(game.phase).toBe('countdown');
    skipCountdown(game);
    expect(game.phase).toBe('playing');
    game.players[1]!.kill();
    game.tick(new Map());
    expect(game.phase).toBe('waiting_ready');
    expect(game.roundWinner).toBe(0);
    expect(game.scores.get(0)).toBe(1);
  });

  it('freezes projectiles and bodyguards when the round ends', () => {
    const game = makeGame(2);
    skipCountdown(game);
    const p = game.players[0]!;
    // Give player 0 a bodyguard and a rifle, and fire a few tracers
    game.items.length = 0;
    game.items.push({ id: 900, sprite: 'bodyguard_item', category: 'automatic', x: p.getScreenX() + 6, y: p.getScreenY() + 6, active: true, hp: 40 });
    for (let i = 0; i < 12; i++) game.tick(new Map());
    p.equipWeapon('rifle', 200);
    for (let i = 0; i < 4; i++) game.tick(inputs({ action: true }));
    expect(game.getBodyguards().length).toBe(1);
    expect(game.getProjectiles().length).toBeGreaterThan(0);

    game.players[1]!.kill();
    game.tick(new Map());
    expect(game.phase).toBe('waiting_ready');
    const snapshot = JSON.stringify([game.getProjectiles(), game.getBodyguards()]);
    for (let i = 0; i < 50; i++) game.tick(new Map());
    expect(JSON.stringify([game.getProjectiles(), game.getBodyguards()])).toBe(snapshot);
  });

  it('flags the start of every round for the renderer', () => {
    const game = makeGame(2);
    expect(game.serialize().roundStarted).toBe(true);
    expect(game.serialize().roundStarted).toBeUndefined();
    skipCountdown(game);
    finishRoundAndReady(game);
    expect(game.phase).toBe('countdown');
    expect(game.currentRound).toBe(2);
  });

  it('keeps level obstacles on later rounds of the same level (B1)', () => {
    const game = makeGame(2);
    game.setLevelObstacles(wallLevel());
    skipCountdown(game);
    expect(game.pixels.has(400, 300)).toBe(true);
    finishRoundAndReady(game);
    expect(game.currentRound).toBe(2);
    expect(game.pixels.has(400, 300)).toBe(true);
    // ...and trails from the previous round are gone
    expect(game.pixels.count()).toBe(PLAY_HEIGHT);
  });
});

describe('death', () => {
  it('takes away the weapon and the effects', () => {
    const game = makeGame(3);
    skipCountdown(game);
    const p = game.players[0]!;
    p.equipWeapon('glock', 20);
    p.activateEffect('shield', 2100);
    expect(game.serialize().round.players[0]!.equippedWeapon).not.toBeNull();
    p.kill();
    game.tick(new Map());
    const state = game.serialize().round.players[0]!;
    expect(state.alive).toBe(false);
    expect(state.equippedWeapon).toBeNull();
    expect(state.activeEffects).toEqual([]);
  });
});

describe('team scoring', () => {
  const team = (): ReturnType<typeof makeGame> => {
    const game = makeGame(4, 1, { mode: 'team' });
    skipCountdown(game);
    return game;
  };
  const scores = (game: ReturnType<typeof makeGame>): number[] => [0, 1, 2, 3].map(s => game.scores.get(s as SlotIndex) ?? 0);

  it('a team finishing with both members alive scores 2', () => {
    const game = team();
    game.players[1]!.kill();
    game.players[3]!.kill();
    game.tick(new Map());
    expect(game.phase).toBe('waiting_ready');
    expect(scores(game)).toEqual([1, 0, 1, 0]);
  });

  it('only the survivor scores when a team-mate died on the way', () => {
    const game = team();
    game.players[0]!.kill();
    game.tick(new Map());
    expect(game.phase).toBe('playing');
    game.players[1]!.kill();
    game.players[3]!.kill();
    game.tick(new Map());
    expect(game.phase).toBe('waiting_ready');
    // Purple (slots 0 and 2) won with one member standing: team score 1
    expect(scores(game)).toEqual([0, 0, 1, 0]);
    expect(game.roundWinner).toBe(2);
  });

  it('a draw scores nothing', () => {
    const game = team();
    for (const p of game.players) p.kill();
    game.tick(new Map());
    expect(game.phase).toBe('waiting_ready');
    expect(scores(game)).toEqual([0, 0, 0, 0]);
    expect(game.roundWinner).toBe('draw');
  });
});

describe('collisions', () => {
  it('kills a player that drives into a level wall', () => {
    const game = makeGame(2);
    game.setLevelObstacles(wallLevel());
    skipCountdown(game);
    place(game, 0, 390.5, 300.5, 0);
    for (let i = 0; i < 20 && game.players[0]!.alive; i++) game.tick(new Map());
    expect(game.players[0]!.alive).toBe(false);
    expect(game.players[0]!.getScreenX()).toBe(400);
  });

  it('kills a player crossing another trail and counts own-colour deaths as ridiculous', () => {
    const game = makeGame(2);
    skipCountdown(game);
    // Player 1 draws a horizontal line, player 0 drives into it
    place(game, 1, 100.5, 300.5, 0);
    place(game, 0, 120.5, 200.5, 90);
    for (let i = 0; i < 200 && game.players[0]!.alive; i++) game.tick(new Map());
    expect(game.players[0]!.alive).toBe(false);
    expect(game.players[1]!.alive).toBe(true);
    expect(game.ridiculousDeaths.get(0)).toBe(0);

    // A full-lock turn makes a ~29px-diameter circle: the player hits its own trail
    const solo = makeGame(2);
    skipCountdown(solo);
    place(solo, 0, 300.5, 300.5, 0);
    place(solo, 1, 600.5, 100.5, 0);
    for (let i = 0; i < 200 && solo.players[0]!.alive; i++) solo.tick(inputs({ steer: 1 }));
    expect(solo.players[0]!.alive).toBe(false);
    expect(solo.ridiculousDeaths.get(0)).toBe(1);
  });

  it('does not kill players when one of them wraps around an edge (B6)', () => {
    const game = makeGame(2);
    skipCountdown(game);
    // P0 wraps horizontally at y≈299.5; P1 crosses y=299.5 in the middle of the arena.
    // The naive segment (749,299)->(0,300) would intersect P1's move.
    place(game, 0, 749.5, 299.9, 10);
    place(game, 1, 375.5, 299.5, 90);
    game.tick(new Map());
    expect(game.players[0]!.getScreenX()).toBe(0);
    expect(game.players[0]!.alive).toBe(true);
    expect(game.players[1]!.alive).toBe(true);
  });

  it('still kills on a true diagonal crossing', () => {
    const game = makeGame(2);
    skipCountdown(game);
    // Two players crossing the same point on perpendicular diagonals
    place(game, 0, 300.1, 300.1, 45);
    place(game, 1, 301.9, 300.1, 135);
    for (let i = 0; i < 5; i++) game.tick(new Map());
    expect(game.players.some(p => !p.alive)).toBe(true);
  });

  it('wraps around the arena edges', () => {
    const game = makeGame(2);
    skipCountdown(game);
    place(game, 0, 748.5, 10.5, 0);
    for (let i = 0; i < 5; i++) game.tick(new Map());
    const p = game.players[0]!;
    expect(p.alive).toBe(true);
    expect(p.getScreenX()).toBe(3);
  });
});

describe('level damage', () => {
  it('eraser restores the pristine level and removes trails (B7)', () => {
    const game = makeGame(2);
    game.setLevelObstacles(wallLevel());
    skipCountdown(game);
    for (let i = 0; i < 30; i++) game.tick(new Map());
    // Simulate weapon damage to the wall
    game.pixels.clearRect(395, 295, 10, 10);
    expect(game.pixels.has(400, 300)).toBe(false);
    // Drop an eraser right in front of player 0
    const p = game.players[0]!;
    game.items.length = 0;
    game.items.push({ id: 999, sprite: 'eraser', category: 'automatic', x: p.getScreenX() + 5, y: p.getScreenY() + 5, active: true, hp: 40 });
    let erased = false;
    for (let i = 0; i < 30 && !erased; i++) {
      game.tick(new Map());
      erased = game.serialize().eraserUsed === true;
    }
    expect(erased).toBe(true);
    expect(game.pixels.has(400, 300)).toBe(true);
    expect(game.pixels.count()).toBeLessThan(PLAY_HEIGHT + 10);
  });
});

describe('fuzz', () => {
  // Random inputs on real levels for several rounds: nothing throws, the state always
  // serializes, and invariants hold.
  const levels = ['blank', 'bricks', 'warzone', 'portals'];
  for (const [i, level] of levels.entries()) {
    it(`survives random play on ${level}`, () => {
      const game = makeGame(4, 100 + i, { level });
      game.setLevelObstacles(loadLevelGrid(level));
      const rng = createRng(7 + i);
      const held = new Map<SlotIndex, TronInput>();
      let roundsFinished = 0;
      for (let tick = 0; tick < 30_000 && roundsFinished < 6; tick++) {
        for (const p of game.players) {
          if (rng() < 0.05 || !held.has(p.slotIndex)) {
            held.set(p.slotIndex, { steer: Math.floor(rng() * 3) - 1, action: rng() < 0.5 });
          }
        }
        const before = game.currentRound;
        game.tick(held);
        const state = game.serialize();
        if (game.currentRound !== before) roundsFinished++;
        for (const p of state.round.players) {
          expect(p.x).toBeGreaterThanOrEqual(0);
          expect(p.x).toBeLessThan(PLAY_WIDTH * 1000);
          expect(p.y).toBeGreaterThanOrEqual(0);
          expect(p.y).toBeLessThan(PLAY_HEIGHT * 1000);
        }
        if (tick % 50 === 0) {
          const copy = deserializeState(serializeState(state), state.round.players);
          expect(copy.round.players).toEqual(state.round.players.map(p => ({ ...p, x: Math.round(p.x), y: Math.round(p.y) })));
          expect(copy.round.items).toEqual(state.round.items.filter(i => i.active));
          expect(copy.round.projectiles.length).toBe(state.round.projectiles.length);
          expect(copy.newTrailSegments).toEqual(state.newTrailSegments);
        }
      }
      expect(roundsFinished).toBeGreaterThanOrEqual(3);
    });
  }

  it('is deterministic for a given seed and inputs', () => {
    const run = (): string => {
      const game = makeGame(3, 42);
      game.setLevelObstacles(loadLevelGrid('selva'));
      const rng = createRng(5);
      const held = new Map<SlotIndex, TronInput>();
      const log: unknown[] = [];
      for (let tick = 0; tick < 3000; tick++) {
        for (const p of game.players) {
          if (rng() < 0.05) held.set(p.slotIndex, { steer: Math.floor(rng() * 3) - 1, action: rng() < 0.5 });
        }
        game.tick(held);
        const s = game.serialize();
        if (tick % 100 === 0) log.push(s.round);
      }
      return JSON.stringify(log);
    };
    expect(run()).toBe(run());
  });
});
