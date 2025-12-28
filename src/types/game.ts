// Game types - clean interface between lobby and game

import type { SlotIndex, GameMode } from './lobby';

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
  gameMode: GameMode;
}

// === Tron Game Types ===

export interface TrailSegment {
  x: number;  // Screen pixel
  y: number;  // Screen pixel
}

// Player state during gameplay (serializable for network)
export interface TronPlayerState {
  slotIndex: SlotIndex;
  x: number;           // Fixed-point ×1000
  y: number;           // Fixed-point ×1000
  direction: number;   // Angle in degrees (0-360)
  alive: boolean;
  color: string;
  nickname: string;
}

export type RoundPhase = 'countdown' | 'playing' | 'round_end' | 'waiting_ready';

// Full round state (broadcast by host)
export interface TronRoundState {
  phase: RoundPhase;
  players: TronPlayerState[];
  countdown: number;           // Seconds remaining in countdown
  roundWinner: SlotIndex | 'draw' | null;
}

// Match state (scores, ready status)
export interface TronMatchState {
  scores: Record<number, number>;  // slotIndex -> score
  currentRound: number;
  currentLevelIndex: number;  // Index into LEVELS array
  playersReady: number[];  // Slots that pressed action
  gameMode: GameMode;
}

// Full game state for network broadcast
export interface TronGameStateData {
  round: TronRoundState;
  match: TronMatchState;
  // Trail data sent separately for efficiency - only new segments
  newTrailSegments: { slotIndex: SlotIndex; segments: TrailSegment[] }[];
}

// Input includes action key for ready signal
export interface TronInput {
  left: boolean;
  right: boolean;
  action: boolean;  // Ready signal / special action
}

// === Level Types ===

export interface LevelDefinition {
  id: string;
  name: string;
  imagePath: string | null;  // null for blank level
}

// Level image filenames (relative to /assets/levels/)
// The full path is constructed at runtime using import.meta.env.BASE_URL
export const LEVEL_DEFINITIONS: { id: string; name: string; imageFile: string | null }[] = [
  { id: 'blank', name: 'Blank', imageFile: null },
  { id: 'pop-culture', name: 'Pop Culture', imageFile: 'pop-culture.png' },
  { id: 'selva', name: 'Selva', imageFile: 'selva.png' },
  { id: 'bricks', name: 'Bricks', imageFile: 'bricks.png' },
  { id: 'bus', name: 'Bus', imageFile: 'bus.png' },
  { id: 'dentistry', name: 'Dentistry', imageFile: 'dentistry.png' },
  { id: 'warzone', name: 'Warzone', imageFile: 'warzone.png' },
  { id: 'portals', name: 'Portals', imageFile: 'portals.png' },
];

// Level order (cycles after last level) - constructed with full paths
export const LEVELS: LevelDefinition[] = LEVEL_DEFINITIONS.map(def => ({
  id: def.id,
  name: def.name,
  imagePath: def.imageFile ? `${import.meta.env.BASE_URL}assets/levels/${def.imageFile}` : null,
}));
