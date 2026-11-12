// Local game configuration logic (no DOM dependencies). See design/local-and-ai.md.

import type { GameMode, LevelMode, SlotIndex } from '../types/lobby';
import { getSlotColor, getSlotColorName } from '../types/lobby';
import type { BotDifficulty, ControlScheme, GameConfig, GamePlayer } from '../types/game';
import { SHARED_SCHEMES } from './input/controlSchemes';

export type LocalSlotKind = 'off' | 'human' | `ai-${BotDifficulty}`;

export const SLOT_KINDS: { kind: LocalSlotKind; label: string }[] = [
  { kind: 'off', label: 'Off' },
  { kind: 'human', label: 'Human' },
  { kind: 'ai-easy', label: 'AI Easy' },
  { kind: 'ai-normal', label: 'AI Normal' },
  { kind: 'ai-hard', label: 'AI Hard' },
];

export interface LocalSetupState {
  slots: [LocalSlotKind, LocalSlotKind, LocalSlotKind, LocalSlotKind];
  gameMode: GameMode;
  levelMode: LevelMode;
}

export const SLOTS: SlotIndex[] = [0, 1, 2, 3];

export function defaultLocalSetup(): LocalSetupState {
  return { slots: ['human', 'ai-normal', 'off', 'off'], gameMode: 'ffa', levelMode: 'cycle' };
}

/** Control scheme for each human slot: `solo` when alone, distinct shared schemes otherwise. */
export function assignSchemes(slots: readonly LocalSlotKind[]): Map<SlotIndex, ControlScheme> {
  const humans = SLOTS.filter(i => slots[i] === 'human');
  const schemes = new Map<SlotIndex, ControlScheme>();
  if (humans.length === 1) {
    schemes.set(humans[0]!, 'solo');
  } else {
    humans.forEach((slot, i) => schemes.set(slot, SHARED_SCHEMES[i]!));
  }
  return schemes;
}

export function canStartLocal(setup: LocalSetupState): boolean {
  const active = setup.slots.filter(k => k !== 'off').length;
  return setup.gameMode === 'team' ? active === 4 : active >= 2;
}

/** Build the game configuration for a local setup. */
export function buildLocalConfig(setup: LocalSetupState): GameConfig {
  const schemes = assignSchemes(setup.slots);
  const players: GamePlayer[] = [];
  for (const slot of SLOTS) {
    const kind = setup.slots[slot]!;
    if (kind === 'off') continue;
    const colorName = getSlotColorName(setup.gameMode, slot);
    const base = setup.gameMode === 'team' ? `${colorName} ${slot < 2 ? 1 : 2}` : colorName;
    players.push({
      slotIndex: slot,
      nickname: kind === 'human' ? base : `${base} Bot`,
      color: getSlotColor(setup.gameMode, slot),
      control: kind === 'human'
        ? { type: 'local', scheme: schemes.get(slot)! }
        : { type: 'ai', difficulty: kind.slice(3) as BotDifficulty },
    });
  }
  return { players, gameMode: setup.gameMode, levelMode: setup.levelMode };
}
