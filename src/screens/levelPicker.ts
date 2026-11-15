// Level picker shared by the local set-up and the network lobby: one chip per level.
// See src/game/levelMode.ts for what a tap does.

import { LEVELS } from '../types/game';
import type { LevelMode } from '../types/lobby';
import { describeLevels, levelIndices, toggleLevel } from '../game/levelMode';
import { escapeHtml } from '../util/html';

const CHIP = 'padding: 0.35rem 0.55rem; font-family: monospace; font-size: 0.8rem; border-radius: 3px;';

function chip(id: string, label: string, on: boolean): string {
  return `<button id="${id}" aria-pressed="${on}" style="${CHIP} cursor: pointer;
    background: ${on ? '#033' : '#000'}; color: ${on ? '#0ff' : '#577'}; border: 1px solid ${on ? '#0ff' : '#244'};">${escapeHtml(label)}</button>`;
}

/** The picker; for someone who cannot change it (a guest), just the list of levels. */
export function levelPickerHtml(mode: LevelMode, editable: boolean): string {
  if (!editable) {
    return `<div id="levelList" style="${CHIP} color: #666; border: 1px solid #333;">${escapeHtml(describeLevels(mode))}</div>`;
  }
  const chosen = new Set(levelIndices(mode));
  const all = chosen.size === LEVELS.length;
  return `<div style="display: flex; flex-wrap: wrap; gap: 0.35rem;">
    ${chip('levelAll', 'ALL', all)}
    ${LEVELS.map((level, index) => chip(`level-${level.id}`, level.name, !all && chosen.has(index))).join('')}
  </div>
  <div style="color: #577; font-size: 0.7rem; margin-top: 0.35rem;">${all ? 'Every level in turn. Tap one to play only that.' : 'Tap to add or remove levels; they are played in turn.'}</div>`;
}

/** Wire the chips: `getMode` is read at the time of the tap. */
export function bindLevelPicker(getMode: () => LevelMode, onChange: (mode: LevelMode) => void): void {
  document.getElementById('levelAll')?.addEventListener('click', () => onChange('cycle'));
  for (const level of LEVELS) {
    document.getElementById(`level-${level.id}`)?.addEventListener('click', () => onChange(toggleLevel(getMode(), level.id)));
  }
}
