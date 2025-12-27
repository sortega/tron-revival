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
