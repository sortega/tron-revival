// Synthetic arenas for bot experiments.

import { PixelGrid } from '../../src/game/PixelGrid';
import { PLAY_HEIGHT, PLAY_WIDTH } from '../../src/game/constants';
import type { Rng } from '../../src/game/rng';
import type { TronGameState } from '../../src/game/TronGameState';

/** A frame around the arena and a wall down the middle: each of two players has its own half. */
export function splitArena(): PixelGrid {
  const grid = new PixelGrid();
  for (let x = 0; x < PLAY_WIDTH; x++) {
    for (const y of [0, 1, PLAY_HEIGHT - 2, PLAY_HEIGHT - 1]) grid.set(x, y, '#888888');
  }
  for (let y = 0; y < PLAY_HEIGHT; y++) {
    for (const x of [0, 1, 374, 375, PLAY_WIDTH - 2, PLAY_WIDTH - 1]) grid.set(x, y, '#888888');
  }
  return grid;
}

/** Put the two players of a split arena somewhere in their halves, heading anywhere. */
export function scatterInHalves(game: TronGameState, rng: Rng): void {
  game.players.forEach((p, i) => {
    const left = i % 2 === 0;
    p.x = Math.round(((left ? 60 : 435) + rng() * 255) * 1000);
    p.y = Math.round((80 + rng() * 440) * 1000);
    p.direction = Math.floor(rng() * 90) * 4;
    p.prevScreenX = -1;
    p.prevScreenY = -1;
  });
}
