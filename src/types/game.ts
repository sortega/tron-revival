// Game types - clean interface between lobby and game

import type { SlotIndex } from './lobby';

export interface GamePlayer {
  slotIndex: SlotIndex;
  nickname: string;
  color: string;
  isLocal: boolean;  // This player is controlled locally
}

export interface Spectator {
  nickname: string;
}

export interface GameConfig {
  players: GamePlayer[];
  spectators: Spectator[];
  isHost: boolean;
}
