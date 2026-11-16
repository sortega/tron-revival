// Level picker shared by the local set-up and the network lobby: one chip per level.
// See src/game/levelMode.ts for what a tap does.

import { LEVELS } from '../types/game';
import type { LevelMode } from '../types/lobby';
import { describeLevels, levelIndices, toggleLevel } from '../game/levelMode';
import { escapeHtml } from '../util/html';

// Styles: screens.css (.level-chip and friends)

function chip(id: string, label: string, on: boolean): string {
  return `<button id="${id}" class="level-chip" aria-pressed="${on}">${escapeHtml(label)}</button>`;
}

/** The picker; for someone who cannot change it (a guest), just the list of levels. */
export function levelPickerHtml(mode: LevelMode, editable: boolean): string {
  if (!editable) {
    return `<div id="levelList" class="level-list">${escapeHtml(describeLevels(mode))}</div>`;
  }
  const chosen = new Set(levelIndices(mode));
  const all = chosen.size === LEVELS.length;
  return `<div class="level-chips">
    ${chip('levelAll', 'ALL', all)}
    ${LEVELS.map((level, index) => chip(`level-${level.id}`, level.name, !all && chosen.has(index))).join('')}
  </div>
  <div class="ui-hint">${all ? 'Every level in turn. Tap one to play only that.' : 'Tap to add or remove levels; they are played in turn.'}</div>`;
}

/** Wire the chips: `getMode` is read at the time of the tap. */
export function bindLevelPicker(getMode: () => LevelMode, onChange: (mode: LevelMode) => void): void {
  document.getElementById('levelAll')?.addEventListener('click', () => onChange('cycle'));
  for (const level of LEVELS) {
    document.getElementById(`level-${level.id}`)?.addEventListener('click', () => onChange(toggleLevel(getMode(), level.id)));
  }
}
