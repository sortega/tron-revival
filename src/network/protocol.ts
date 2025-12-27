// Network protocol for lobby and game communication

import type { LobbyState, SlotIndex } from '../types/lobby';

// === Guest → Host Messages ===

export interface JoinRequestMessage {
  type: 'join_request';
  nickname: string;
  preferredSlot?: SlotIndex;
}

export interface SlotChangeMessage {
  type: 'slot_change';
  targetSlot: SlotIndex;
}

export interface NicknameChangeMessage {
  type: 'nickname_change';
  nickname: string;
}

export interface ChatSendMessage {
  type: 'chat_send';
  text: string;
}

export interface LeaveMessage {
  type: 'leave';
}

export interface AnnounceMessage {
  type: 'announce';
  nickname: string;
}

export type GuestToHostMessage =
  | JoinRequestMessage
  | SlotChangeMessage
  | NicknameChangeMessage
  | ChatSendMessage
  | LeaveMessage
  | AnnounceMessage;

// === Host → Guest Messages ===

export interface LobbyStateMessage {
  type: 'lobby_state';
  state: LobbyState;
}

export interface JoinAcceptedMessage {
  type: 'join_accepted';
  yourPeerId: string;
  assignedSlot: SlotIndex;
}

export interface JoinRejectedMessage {
  type: 'join_rejected';
  reason: 'room_full' | 'game_in_progress' | 'invalid_request';
}

export interface GameStartMessage {
  type: 'game_start';
  countdown: number;
}

export interface HostDisconnectedMessage {
  type: 'host_disconnected';
}

export type HostToGuestMessage =
  | LobbyStateMessage
  | JoinAcceptedMessage
  | JoinRejectedMessage
  | GameStartMessage
  | HostDisconnectedMessage;

// === Game Phase Messages ===

export interface GameInput {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
}

export interface PlayerPosition {
  slotIndex: SlotIndex;
  x: number;
  y: number;
}

export interface GameStateMessage {
  type: 'game_state';
  positions: PlayerPosition[];
  timestamp: number;
}

export interface PlayerInputMessage {
  type: 'player_input';
  input: GameInput;
}

// === Unified Message Types ===

export type LobbyMessage = GuestToHostMessage | HostToGuestMessage;
export type GameMessage = GameStateMessage | PlayerInputMessage;

// Type guards

export function isGuestToHostMessage(msg: unknown): msg is GuestToHostMessage {
  if (typeof msg !== 'object' || msg === null) return false;
  const type = (msg as { type?: string }).type;
  return ['join_request', 'slot_change', 'nickname_change', 'chat_send', 'leave', 'announce'].includes(type ?? '');
}

export function isHostToGuestMessage(msg: unknown): msg is HostToGuestMessage {
  if (typeof msg !== 'object' || msg === null) return false;
  const type = (msg as { type?: string }).type;
  return ['lobby_state', 'join_accepted', 'join_rejected', 'game_start', 'host_disconnected'].includes(type ?? '');
}
