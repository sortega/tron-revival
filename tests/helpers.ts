// Test helpers for running the simulation headless
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { TronGameState } from '../src/game/TronGameState';
import { PixelGrid } from '../src/game/PixelGrid';
import { createRng } from '../src/game/rng';
import { FFA_COLORS, getSlotColor } from '../src/types/lobby';
import type { GameMode, SlotIndex } from '../src/types/lobby';
import type { GamePlayer, TronInput } from '../src/types/game';
import { LEVEL_DEFINITIONS } from '../src/types/game';

export function makePlayers(count: number, mode: GameMode = 'ffa'): GamePlayer[] {
  return Array.from({ length: count }, (_, i) => ({
    slotIndex: i as SlotIndex,
    nickname: `P${i}`,
    color: mode === 'ffa' ? FFA_COLORS[i as SlotIndex] : getSlotColor(mode, i as SlotIndex),
    control: { type: 'remote' as const },
  }));
}

export function makeGame(
  playerCount = 2,
  seed = 1,
  opts: { mode?: GameMode; level?: string } = {}
): TronGameState {
  return new TronGameState(
    makePlayers(playerCount, opts.mode),
    opts.mode ?? 'ffa',
    opts.level ?? 'blank',
    createRng(seed)
  );
}

const levelCache = new Map<string, PixelGrid>();

/** Load a level's obstacle grid straight from the PNG in public/assets. */
export function loadLevelGrid(levelId: string): PixelGrid {
  let grid = levelCache.get(levelId);
  if (!grid) {
    const def = LEVEL_DEFINITIONS.find(l => l.id === levelId);
    if (!def) throw new Error(`Unknown level ${levelId}`);
    const png = PNG.sync.read(readFileSync(`public/assets/levels/${def.imageFile}`));
    grid = PixelGrid.fromRgba(png.data);
    levelCache.set(levelId, grid);
  }
  // Return a copy so tests cannot corrupt the cache
  const copy = new PixelGrid();
  copy.copyFrom(grid);
  return copy;
}

export const NO_INPUT: TronInput = { steer: 0, action: false };

export function inputs(...list: Partial<TronInput>[]): Map<SlotIndex, TronInput> {
  const map = new Map<SlotIndex, TronInput>();
  list.forEach((input, i) => map.set(i as SlotIndex, { ...NO_INPUT, ...input }));
  return map;
}

/** Tick with no input until the countdown finishes. */
export function skipCountdown(game: TronGameState): void {
  let guard = 0;
  while (game.phase === 'countdown') {
    game.tick(new Map());
    game.serialize();
    if (++guard > 1000) throw new Error('countdown never finished');
  }
}

/** Place a player at a pixel position (centre of the pixel by default). */
export function place(game: TronGameState, slot: number, x: number, y: number, direction: number): void {
  const p = game.players[slot]!;
  p.x = Math.round(x * 1000);
  p.y = Math.round(y * 1000);
  p.direction = direction;
  p.prevScreenX = -1;
  p.prevScreenY = -1;
}
