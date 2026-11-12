// Lobby rules: pure functions over the room's shared state. No networking here.
// See design/networking.md ("Lobby").

import type { GameMode, LevelMode, LobbyState, PlayerSlot, SlotIndex } from '../types/lobby';
import { aiPeerId, createEmptySlot, getSlotColor, getSlotColorName } from '../types/lobby';
import type { BotDifficulty, GameConfig, GamePlayer, PlayerControl } from '../types/game';

/** Per-user state: what a user asks for. Writable only by that user. */
export interface Profile {
  name: string;
  /** Desired slot (0-3), -1 = any free slot, null = spectate. */
  want: number | null;
}

export interface SlotEntry {
  userId?: string;       // Human seat
  ai?: BotDifficulty;    // Bot seat
  name: string;
}

/** Room state: written only by the host. */
export interface SharedRoom {
  hostId: string;
  gameMode: GameMode;
  levelMode: LevelMode;
  slots: (SlotEntry | null)[];   // Always 4 entries
  phase: 'lobby' | 'game';
  gameId: number;
}

export const SLOT_INDEXES: SlotIndex[] = [0, 1, 2, 3];
export const MAX_NAME_LENGTH = 24;

export function createSharedRoom(hostId: string): SharedRoom {
  return { hostId, gameMode: 'ffa', levelMode: 'cycle', slots: [null, null, null, null], phase: 'lobby', gameId: 0 };
}

export function sanitizeName(name: unknown, fallback = 'Player'): string {
  const text = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH) : '';
  return text || fallback;
}

function validWant(want: unknown): number | null {
  if (want === null || want === undefined) return null;
  return typeof want === 'number' && Number.isInteger(want) && want >= -1 && want <= 3 ? want : -1;
}

/** Only the host may change the room; the first writer becomes the host. */
export function isRoomWriteAllowed(prev: SharedRoom | null, next: SharedRoom | null, writerId: string): boolean {
  if (!next || !Array.isArray(next.slots) || next.slots.length !== 4) return false;
  if (!prev) return next.hostId === writerId;
  return prev.hostId === writerId && next.hostId === writerId;
}

/**
 * Seat users according to their profiles. `profiles` holds the users currently in
 * the room. Returns the same object if nothing changed.
 */
export function reconcile(room: SharedRoom, profiles: Readonly<Record<string, Profile | null>>): SharedRoom {
  const slots = room.slots.map(s => (s ? { ...s } : null));
  const inLobby = room.phase === 'lobby';
  const seatOf = (userId: string): number => slots.findIndex(s => s?.userId === userId);

  // 1. Free seats: users who chose to spectate, and (in the lobby) users who left.
  //    During a game, the seat of a disconnected player is kept for their return.
  slots.forEach((slot, i) => {
    if (!slot?.userId) return;
    const profile = profiles[slot.userId];
    if (profile ? validWant(profile.want) === null : inLobby) slots[i] = null;
  });

  for (const [userId, profile] of Object.entries(profiles)) {
    if (!profile) continue;
    const want = validWant(profile.want);
    const name = sanitizeName(profile.name);
    let seat = seatOf(userId);

    // 2. Keep names current
    if (seat >= 0) slots[seat]!.name = name;
    if (want === null) continue;

    // 3. Move to a specific free seat (lobby only: no musical chairs mid-game)
    if (seat >= 0 && want >= 0 && want !== seat && slots[want] === null && inLobby) {
      slots[want] = slots[seat]!;
      slots[seat] = null;
      seat = want;
    }

    // 4. Seat newcomers (lobby only: people arriving mid-game spectate)
    if (seat < 0 && inLobby) {
      const target = want >= 0 && slots[want] === null ? want : slots.findIndex(s => s === null);
      if (target >= 0) slots[target] = { userId, name };
    }
  }

  return JSON.stringify(slots) === JSON.stringify(room.slots) ? room : { ...room, slots };
}

export function filledSlots(room: SharedRoom): number {
  return room.slots.filter(s => s !== null).length;
}

export function canStart(room: SharedRoom): boolean {
  const filled = filledSlots(room);
  return room.gameMode === 'team' ? filled === 4 : filled >= 2;
}

export function botName(mode: GameMode, slot: SlotIndex): string {
  return `${getSlotColorName(mode, slot)} Bot`;
}

/** View model used by the lobby screen. */
export function toLobbyState(
  roomId: string, room: SharedRoom, profiles: Readonly<Record<string, Profile | null>>
): LobbyState {
  const slots = SLOT_INDEXES.map((i): PlayerSlot => {
    const entry = room.slots[i];
    if (!entry) return createEmptySlot(i);
    return {
      slotIndex: i,
      peerId: entry.ai ? aiPeerId(i) : entry.userId ?? null,
      nickname: entry.name,
      isHost: entry.userId === room.hostId,
      ...(entry.ai && { ai: entry.ai }),
    };
  }) as LobbyState['slots'];

  const seated = new Set(room.slots.map(s => s?.userId).filter(Boolean));
  const spectators = Object.entries(profiles)
    .filter(([userId, profile]) => profile && !seated.has(userId))
    .map(([userId, profile]) => ({ peerId: userId, nickname: sanitizeName(profile!.name) }));

  return {
    roomId,
    hostPeerId: room.hostId,
    gameMode: room.gameMode,
    levelMode: room.levelMode,
    slots,
    chatMessages: [],
    spectators,
  };
}

/** Game configuration as seen by one participant. */
export function buildGameConfig(room: SharedRoom, selfId: string): GameConfig {
  const isHost = room.hostId === selfId;
  const players: GamePlayer[] = [];
  for (const i of SLOT_INDEXES) {
    const entry = room.slots[i];
    if (!entry) continue;
    let control: PlayerControl = { type: 'remote' };
    if (entry.userId === selfId) control = { type: 'local', scheme: 'solo' };
    // Bots are simulated by the host; for guests they are just remote players
    else if (entry.ai && isHost) control = { type: 'ai', difficulty: entry.ai };
    players.push({ slotIndex: i, nickname: entry.name, color: getSlotColor(room.gameMode, i), control });
  }
  return { players, gameMode: room.gameMode, levelMode: room.levelMode };
}

export function slotOfUser(room: SharedRoom, userId: string): SlotIndex | null {
  const index = room.slots.findIndex(s => s?.userId === userId);
  return index >= 0 ? (index as SlotIndex) : null;
}
