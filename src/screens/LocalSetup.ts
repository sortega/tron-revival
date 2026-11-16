// Local game setup screen: choose who plays in each slot, mode and level.
// See design/local-and-ai.md.

import type { Screen, ScreenManager } from './ScreenManager';
import { getSlotColor } from '../types/lobby';
import { normalizeLevelMode } from '../game/levelMode';
import { bindLevelPicker, levelPickerHtml } from './levelPicker';
import { CONTROL_SCHEMES } from '../game/input/controlSchemes';
import { SLOTS, SLOT_KINDS, assignSchemes, buildLocalConfig, canStartLocal, defaultLocalSetup } from '../game/localSetup';
import type { LocalSetupState, LocalSlotKind } from '../game/localSetup';
import { createHostSession } from '../game/session/WorkerHostSession';

const STORAGE_KEY = 'teratron-local-setup';

function loadSetup(): LocalSetupState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LocalSetupState>;
      const valid = new Set(SLOT_KINDS.map(k => k.kind));
      if (Array.isArray(parsed.slots) && parsed.slots.length === 4 && parsed.slots.every(k => valid.has(k))) {
        return {
          slots: parsed.slots,
          gameMode: parsed.gameMode === 'team' ? 'team' : 'ffa',
          levelMode: normalizeLevelMode(parsed.levelMode),
        };
      }
    }
  } catch {
    // Corrupt storage: fall back to defaults
  }
  return defaultLocalSetup();
}

export class LocalSetup implements Screen {
  private setup: LocalSetupState = loadSetup();

  constructor(private container: HTMLElement, private screenManager: ScreenManager) {}

  render(): void {
    const { setup } = this;
    const schemes = assignSchemes(setup.slots);
    const canStart = canStartLocal(setup);

    const rows = SLOTS.map(slot => {
      const kind = setup.slots[slot]!;
      const color = getSlotColor(setup.gameMode, slot);
      const scheme = schemes.get(slot);
      const detail = kind === 'human' && scheme ? CONTROL_SCHEMES[scheme].label : '';
      return `
        <div class="ui-seat setup-seat">
          <div class="ui-seat-dot" style="background: ${color};
                      box-shadow: ${kind === 'off' ? 'none' : `0 0 8px ${color}`}; opacity: ${kind === 'off' ? 0.3 : 1};"></div>
          <select id="slotKind${slot}" class="ui-select">
            ${SLOT_KINDS.map(k => `<option value="${k.kind}" ${k.kind === kind ? 'selected' : ''}>${k.label}</option>`).join('')}
          </select>
          <div class="setup-seat-detail">${detail}</div>
        </div>`;
    }).join('');

    // Layout: screens.css and design/screen-layout.md (one column; two on a phone on its side)
    this.container.innerHTML = `
      <div class="ui-screen setup-screen">
        <h1 class="ui-title setup-title">LOCAL GAME</h1>
        <div class="ui-panel setup-panel">
          <div class="setup-col">
            <h3 class="ui-heading">Players</h3>
            ${rows}
          </div>
          <div class="setup-col">
            <div class="ui-field setup-mode">
              <label class="ui-label">Game Mode:</label>
              <div class="ui-row">
                <button id="ffaBtn" class="ui-toggle" aria-pressed="${setup.gameMode === 'ffa'}">FFA</button>
                <button id="teamBtn" class="ui-toggle" aria-pressed="${setup.gameMode === 'team'}">TEAMS</button>
              </div>
            </div>
            <div class="ui-field">
              <label class="ui-label">Level:</label>
              ${levelPickerHtml(setup.levelMode, true)}
            </div>
            <div class="setup-start ui-sticky">
              <button id="startBtn" class="ui-start" ${canStart ? '' : 'disabled'}>
                START GAME
                ${canStart ? '' : `<small>(${setup.gameMode === 'team' ? 'teams need all 4 slots' : 'needs at least 2 players'})</small>`}
              </button>
            </div>
            <button id="backBtn" class="ui-btn ui-btn-red ui-btn-wide">BACK</button>
          </div>
        </div>
      </div>
    `;

    for (const slot of SLOTS) {
      document.getElementById(`slotKind${slot}`)?.addEventListener('change', (e) => {
        setup.slots[slot] = (e.target as HTMLSelectElement).value as LocalSlotKind;
        this.update();
      });
    }
    document.getElementById('ffaBtn')?.addEventListener('click', () => { setup.gameMode = 'ffa'; this.update(); });
    document.getElementById('teamBtn')?.addEventListener('click', () => { setup.gameMode = 'team'; this.update(); });
    bindLevelPicker(() => setup.levelMode, (mode) => {
      setup.levelMode = mode;
      this.update();
    });
    document.getElementById('startBtn')?.addEventListener('click', () => {
      if (!canStartLocal(setup)) return;
      const config = buildLocalConfig(setup);
      this.screenManager.showGame(config, createHostSession(config));
    });
    document.getElementById('backBtn')?.addEventListener('click', () => this.screenManager.showMainMenu());
  }

  private update(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.setup));
    this.render();
  }

  cleanup(): void {
    // Nothing to release
  }
}
