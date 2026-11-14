// Local game setup screen: choose who plays in each slot, mode and level.
// See design/local-and-ai.md.

import type { Screen, ScreenManager } from './ScreenManager';
import { getSlotColor } from '../types/lobby';
import { LEVELS } from '../types/game';
import { CONTROL_SCHEMES } from '../game/input/controlSchemes';
import { SLOTS, SLOT_KINDS, assignSchemes, buildLocalConfig, canStartLocal, defaultLocalSetup } from '../game/localSetup';
import type { LocalSetupState, LocalSlotKind } from '../game/localSetup';
import { createLocalSession } from '../game/session/WorkerHostSession';

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
          levelMode: parsed.levelMode === 'cycle' || LEVELS.some(l => l.id === parsed.levelMode)
            ? parsed.levelMode! : 'cycle',
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
    const btn = (active: boolean) => `
      flex: 1; padding: 0.5rem; font-family: monospace; cursor: pointer;
      background: ${active ? '#030' : '#111'};
      color: ${active ? '#0f0' : '#666'};
      border: 1px solid ${active ? '#0f0' : '#333'};`;

    const rows = SLOTS.map(slot => {
      const kind = setup.slots[slot]!;
      const color = getSlotColor(setup.gameMode, slot);
      const scheme = schemes.get(slot);
      const detail = kind === 'human' && scheme ? CONTROL_SCHEMES[scheme].label : '';
      return `
        <div style="display: flex; align-items: center; gap: 0.75rem; padding: 0.6rem; margin-bottom: 0.5rem;
                    background: #0a0a0a; border: 1px solid #333; border-radius: 4px;">
          <div style="width: 20px; height: 20px; flex: none; border-radius: 50%; background: ${color};
                      box-shadow: ${kind === 'off' ? 'none' : `0 0 8px ${color}`}; opacity: ${kind === 'off' ? 0.3 : 1};"></div>
          <select id="slotKind${slot}" style="padding: 0.4rem; font-family: monospace; background: #000; color: #0ff;
                      border: 1px solid #0ff; cursor: pointer;">
            ${SLOT_KINDS.map(k => `<option value="${k.kind}" ${k.kind === kind ? 'selected' : ''}>${k.label}</option>`).join('')}
          </select>
          <div style="flex: 1; color: #888; font-size: 0.85rem;">${detail}</div>
        </div>`;
    }).join('');

    this.container.innerHTML = `
      <div style="display: flex; flex-direction: column; align-items: center; min-height: 100vh; padding: 1rem;">
        <h1 style="color: #0ff; text-shadow: 0 0 10px #0ff; margin-bottom: 1rem; font-size: 2rem;">LOCAL GAME</h1>
        <div style="width: 100%; max-width: 480px; background: #111; padding: 1rem; border: 1px solid #333; border-radius: 4px;">
          <h3 style="color: #0ff; margin-bottom: 0.75rem;">Players</h3>
          ${rows}

          <label style="color: #888; display: block; margin: 1rem 0 0.5rem;">Game Mode:</label>
          <div style="display: flex; gap: 0.5rem;">
            <button id="ffaBtn" style="${btn(setup.gameMode === 'ffa')}">FFA</button>
            <button id="teamBtn" style="${btn(setup.gameMode === 'team')}">TEAMS</button>
          </div>

          <label style="color: #888; display: block; margin: 1rem 0 0.5rem;">Level:</label>
          <select id="levelSelect" style="width: 100%; padding: 0.5rem; font-family: monospace; background: #000;
                      color: #0ff; border: 1px solid #0ff; cursor: pointer;">
            <option value="cycle" ${setup.levelMode === 'cycle' ? 'selected' : ''}>Cycle All</option>
            ${LEVELS.map(l => `<option value="${l.id}" ${setup.levelMode === l.id ? 'selected' : ''}>${l.name}</option>`).join('')}
          </select>

          <button id="startBtn" ${canStart ? '' : 'disabled'} style="width: 100%; margin-top: 1.25rem; padding: 1rem;
                      font-size: 1.1rem; font-family: monospace;
                      cursor: ${canStart ? 'pointer' : 'not-allowed'};
                      background: ${canStart ? '#030' : '#111'}; color: ${canStart ? '#0f0' : '#666'};
                      border: 2px solid ${canStart ? '#0f0' : '#333'};">
            START GAME
            ${canStart ? '' : `<br><span style="font-size: 0.7rem;">(${setup.gameMode === 'team' ? 'teams need all 4 slots' : 'needs at least 2 players'})</span>`}
          </button>
          <button id="backBtn" style="width: 100%; margin-top: 0.5rem; padding: 0.5rem; font-family: monospace;
                      cursor: pointer; background: #200; color: #f44; border: 1px solid #f44;">BACK</button>
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
    document.getElementById('levelSelect')?.addEventListener('change', (e) => {
      setup.levelMode = (e.target as HTMLSelectElement).value;
      this.update();
    });
    document.getElementById('startBtn')?.addEventListener('click', () => {
      if (!canStartLocal(setup)) return;
      const config = buildLocalConfig(setup);
      this.screenManager.showGame(config, createLocalSession(config));
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
