// Which levels a game is played on (design/local-and-ai.md, Level selection).
// A level mode is a string: 'cycle' (every level, in order), one level id, or several ids
// separated by commas (those levels, in the order of the level list).

import { LEVELS } from '../types/game';
import type { LevelMode } from '../types/lobby';

/** Indices into LEVELS of the levels of this mode, in playing order. Never empty. */
export function levelIndices(mode: LevelMode): number[] {
  if (mode !== 'cycle') {
    const ids = new Set(String(mode).split(','));
    const chosen = LEVELS.map((level, index) => (ids.has(level.id) ? index : -1)).filter(i => i >= 0);
    if (chosen.length > 0) return chosen;
  }
  return LEVELS.map((_, index) => index);
}

/** The canonical mode for a set of level indices: 'cycle' when it is all of them. */
function modeOf(indices: number[]): LevelMode {
  if (indices.length === 0 || indices.length >= LEVELS.length) return 'cycle';
  return indices.map(i => LEVELS[i]!.id).join(',');
}

/** Whatever came from storage or the network, as a valid mode. */
export function normalizeLevelMode(mode: unknown): LevelMode {
  return typeof mode === 'string' ? modeOf(levelIndices(mode)) : 'cycle';
}

/** The level after `current` in this mode (`current` itself when it is the only one). */
export function nextLevelIndex(mode: LevelMode, current: number): number {
  const list = levelIndices(mode);
  return list[(list.indexOf(current) + 1) % list.length]!;
}

/**
 * The mode after tapping a level in the picker. With every level on, a tap means "only
 * this one"; otherwise it switches the level on or off (the last one stays on).
 */
export function toggleLevel(mode: LevelMode, id: string): LevelMode {
  const index = LEVELS.findIndex(level => level.id === id);
  if (index < 0) return normalizeLevelMode(mode);
  const current = levelIndices(mode);
  if (current.length === LEVELS.length) return modeOf([index]);
  if (!current.includes(index)) return modeOf([...current, index].sort((a, b) => a - b));
  return current.length === 1 ? modeOf(current) : modeOf(current.filter(i => i !== index));
}

/** "All levels", "Bricks", "Bricks, Selva". */
export function describeLevels(mode: LevelMode): string {
  const list = levelIndices(mode);
  return list.length === LEVELS.length ? 'All levels' : list.map(i => LEVELS[i]!.name).join(', ');
}
