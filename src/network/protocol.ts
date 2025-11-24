/**
 * Network Protocol
 * Message type definitions for PeerJS communication
 */

import type { RGB } from '../constants';
import type { RoundState } from '../game/managers/RoundManager';
import type { PlayerState } from '../types';

// ============================================================================
// Guest → Host Messages
// ============================================================================

export interface JoinMessage {
  type: 'join';
  playerName: string;
  timestamp: number;
}

export interface InputMessage {
  type: 'input';
  playerId: string;
  left: boolean;
  right: boolean;
  fire: boolean;
  timestamp: number;
}

export interface ReadyMessage {
  type: 'ready';
  playerId: string;
  isReady: boolean;
}

export type GuestToHostMessage =
  | JoinMessage
  | InputMessage
  | ReadyMessage;

// ============================================================================
// Host → Guest Messages
// ============================================================================

export interface PlayerInfo {
  id: string;
  name: string;
  num: number;
  color: RGB;
  isReady: boolean;
}

export interface RoomInfo {
  roomId: string;
  hostId: string;
  players: PlayerInfo[];
}

export interface WelcomeMessage {
  type: 'welcome';
  playerId: string;
  playerNum: number;
  color: RGB;
  roomInfo: RoomInfo;
}

export interface StateMessage {
  type: 'state';
  frameNumber: number;
  timestamp: number;

  // Player states
  players: PlayerState[];

  // Round manager state
  roundState: RoundState;
  scores: [number, number][]; // [playerNum, score][]
  muertesRidiculas: [number, number][]; // [playerNum, count][]
  playersReady: number[]; // Array of ready player numbers
  lastWinnerId: string | null;
}

export interface StartGameMessage {
  type: 'start_game';
  countdown: number;
  mapId: number;
  mode: 'ffa' | 'team';
}

export type GameEventType = 'collision' | 'death' | 'item_spawned' | 'item_collected';

export interface EventMessage {
  type: 'event';
  eventType: GameEventType;
  data: unknown;
  timestamp: number;
}

export interface PlayerJoinedMessage {
  type: 'player_joined';
  player: PlayerInfo;
}

export interface PlayerLeftMessage {
  type: 'player_left';
  playerId: string;
  playerName: string;
}

export type ErrorCode =
  | 'ROOM_FULL'
  | 'INVALID_INPUT'
  | 'CONNECTION_FAILED'
  | 'GAME_STARTED'
  | 'UNKNOWN';

export interface ErrorMessage {
  type: 'error';
  code: ErrorCode;
  message: string;
}

export type HostToGuestMessage =
  | WelcomeMessage
  | StateMessage
  | StartGameMessage
  | EventMessage
  | PlayerJoinedMessage
  | PlayerLeftMessage
  | ErrorMessage;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Type guard for GuestToHostMessage
 */
export function isGuestToHostMessage(msg: unknown): msg is GuestToHostMessage {
  if (typeof msg !== 'object' || msg === null) return false;
  const type = (msg as { type?: string }).type;
  return (
    type === 'join' ||
    type === 'input' ||
    type === 'ready'
  );
}

/**
 * Type guard for HostToGuestMessage
 */
export function isHostToGuestMessage(msg: unknown): msg is HostToGuestMessage {
  if (typeof msg !== 'object' || msg === null) return false;
  const type = (msg as { type?: string }).type;
  return (
    type === 'welcome' ||
    type === 'state' ||
    type === 'start_game' ||
    type === 'event' ||
    type === 'player_joined' ||
    type === 'player_left' ||
    type === 'error'
  );
}

/**
 * Create a join message
 */
export function createJoinMessage(playerName: string): JoinMessage {
  return {
    type: 'join',
    playerName,
    timestamp: Date.now(),
  };
}

/**
 * Create an input message
 */
export function createInputMessage(
  playerId: string,
  left: boolean,
  right: boolean,
  fire: boolean
): InputMessage {
  return {
    type: 'input',
    playerId,
    left,
    right,
    fire,
    timestamp: Date.now(),
  };
}

/**
 * Create a ready message
 */
export function createReadyMessage(playerId: string, isReady: boolean): ReadyMessage {
  return {
    type: 'ready',
    playerId,
    isReady,
  };
}

/**
 * Create an error message
 */
export function createErrorMessage(code: ErrorCode, message: string): ErrorMessage {
  return {
    type: 'error',
    code,
    message,
  };
}
