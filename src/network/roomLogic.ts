// Lobby rules: pure functions over the room's shared state. No networking here.
// See design/networking.md ("Lobby").

import type { GameMode, LevelMode, LobbyState, PlayerSlot, SlotIndex, Spectator } from '../types/lobby';
import { aiPeerId, createEmptySlot, getSlotColor, getSlotColorName } from '../types/lobby';
import type { BotDifficulty, GameConfig, GamePlayer, PlayerControl } from '../types/game';

/** Per-user state: what a user asks for. Writable only by that user. */
export interface Profile {
  name: string;
  /** Desired slot (0-3), -1 = any free slot, null = spectate (or step down). */
  want: number | null;
  /** Asks for a seat at the next round of the game in progress (design/spectators.md). */
  joinNext?: boolean;
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
  /** Users waiting for a seat in the running game, in the order they asked. */
  queue?: string[];
  /** Admitted users without a seat, in order of arrival (at most MAX_WATCHERS). */
  watchers?: string[];
}

/** Users without a seat a room admits: each one is a connection for every participant. */
export const MAX_WATCHERS = 6;

export const SLOT_INDEXES: SlotIndex[] = [0, 1, 2, 3];
export const MAX_NAME_LENGTH = 24;

export function createSharedRoom(hostId: string): SharedRoom {
  return { hostId, gameMode: 'ffa', levelMode: 'cycle', slots: [null, null, null, null], phase: 'lobby', gameId: 0, queue: [], watchers: [] };
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

const wantsNextRound = (profile: Profile | null | undefined): boolean =>
  !!profile && profile.joinNext === true && validWant(profile.want) !== null;

const sameList = (a: readonly unknown[] | undefined, b: readonly unknown[]): boolean =>
  JSON.stringify(a ?? []) === JSON.stringify(b);

/**
 * Seat users according to their profiles, and keep the queue and the list of admitted
 * watchers. `profiles` holds the users currently in the room. Returns the same object
 * if nothing changed.
 *
 * During a game the seats are left alone: they change only at a round start, through
 * `planNextRound` (design/spectators.md).
 */
export function reconcile(room: SharedRoom, profiles: Readonly<Record<string, Profile | null>>): SharedRoom {
  const slots = room.slots.map(s => (s ? { ...s } : null));
  const inLobby = room.phase === 'lobby';
  const seatOf = (userId: string): number => slots.findIndex(s => s?.userId === userId);
  const wasSeated = new Set(room.slots.map(s => s?.userId).filter((id): id is string => !!id));

  // Waiting list: keep the order in which people asked
  const queue = (room.queue ?? []).filter(id => wantsNextRound(profiles[id]) && seatOf(id) < 0);
  for (const [userId, profile] of Object.entries(profiles)) {
    if (wantsNextRound(profile) && seatOf(userId) < 0 && !queue.includes(userId)) queue.push(userId);
  }

  if (inLobby) {
    // 1. Free seats: users who chose to spectate, and users who left
    slots.forEach((slot, i) => {
      if (!slot?.userId) return;
      const profile = profiles[slot.userId];
      if (!profile || validWant(profile.want) === null) slots[i] = null;
    });

    // Those who were waiting for a seat go first
    const order = [...queue, ...Object.keys(profiles).filter(id => !queue.includes(id))];
    for (const userId of order) {
      const profile = profiles[userId];
      if (!profile) continue;
      const want = validWant(profile.want);
      const name = sanitizeName(profile.name);
      let seat = seatOf(userId);

      // 2. Keep names current
      if (seat >= 0) slots[seat]!.name = name;
      if (want === null) continue;

      // 3. Move to a specific free seat
      if (seat >= 0 && want >= 0 && want !== seat && slots[want] === null) {
        slots[want] = slots[seat]!;
        slots[seat] = null;
        seat = want;
      }

      // 4. Seat newcomers
      if (seat < 0) {
        const target = want >= 0 && slots[want] === null ? want : slots.findIndex(s => s === null);
        if (target >= 0) slots[target] = { userId, name };
      }
    }
  }

  const stillQueued = queue.filter(id => seatOf(id) < 0);

  // Watchers: whoever was already here stays; newcomers only while there is room.
  // The host is always admitted.
  const known = new Set([...(room.watchers ?? []), ...wasSeated, room.hostId]);
  const unseated = (id: string): boolean => !!profiles[id] && seatOf(id) < 0;
  const watchers = (room.watchers ?? []).filter(unseated);
  for (const userId of Object.keys(profiles)) {
    if (!unseated(userId) || watchers.includes(userId)) continue;
    if (known.has(userId) || watchers.length < MAX_WATCHERS) watchers.push(userId);
  }

  if (JSON.stringify(slots) === JSON.stringify(room.slots) &&
      sameList(room.queue, stillQueued) && sameList(room.watchers, watchers)) return room;
  return { ...room, slots, queue: stillQueued, watchers };
}

/**
 * Seats for the next round of the game in progress: players who stepped down or said
 * goodbye (`departed`) leave, queued spectators take free seats or replace bots, and
 * bots fill in if the game would fall below its minimum. Returns `room.slots` itself
 * when nothing changes. Pure, so every client can preview it.
 */
export function planNextRound(
  room: SharedRoom,
  profiles: Readonly<Record<string, Profile | null>>,
  departed: ReadonlySet<string> = new Set()
): (SlotEntry | null)[] {
  const slots = room.slots.map(s => (s ? { ...s } : null));

  slots.forEach((slot, i) => {
    if (!slot?.userId) return;
    const profile = profiles[slot.userId];
    if (profile ? validWant(profile.want) === null : departed.has(slot.userId)) slots[i] = null;
    else if (profile) slot.name = sanitizeName(profile.name);
    // Absent without a goodbye: the seat is kept for their return
  });

  for (const userId of room.queue ?? []) {
    const profile = profiles[userId];
    if (!wantsNextRound(profile) || slots.some(s => s?.userId === userId)) continue;
    let target = slots.findIndex(s => s === null);
    if (target < 0) target = slots.findIndex(s => !!s?.ai);   // Humans replace bots
    if (target < 0) break;                                      // Nobody displaces a human
    slots[target] = { userId, name: sanitizeName(profile!.name) };
  }

  const minimum = room.gameMode === 'team' ? 4 : 2;
  for (let filled = slots.filter(Boolean).length; filled < minimum; filled++) {
    const free = slots.findIndex(s => s === null);
    slots[free] = { ai: 'normal', name: botName(room.gameMode, free as SlotIndex) };
  }

  return JSON.stringify(slots) === JSON.stringify(room.slots) ? room.slots : slots;
}

/** Who is around a game, as shown on the game screen. */
export interface Audience {
  /** Users in the room without a seat. */
  spectators: number;
  /** Names of those who take a seat / give theirs up at the next round. */
  joining: string[];
  leaving: string[];
  /** Names of those queued with no seat in sight. */
  waiting: string[];
  /** This user's own situation. */
  me: 'playing' | 'leaving' | 'joining' | 'waiting' | 'watching';
  /** 1-based position among those waiting (0 if not waiting). */
  queuePosition: number;
}

export function audienceOf(
  room: SharedRoom,
  profiles: Readonly<Record<string, Profile | null>>,
  selfId: string | null,
  departed: ReadonlySet<string> = new Set()
): Audience {
  const seated = new Set(room.slots.map(s => s?.userId).filter(Boolean));
  const next = room.phase === 'game' ? planNextRound(room, profiles, departed) : room.slots;
  const nextSeated = new Set(next.map(s => s?.userId).filter(Boolean));
  const nameOf = (userId: string): string => sanitizeName(profiles[userId]?.name);

  const joining = next.filter(s => s?.userId && !seated.has(s.userId)).map(s => s!.name);
  const leaving = room.slots.filter(s => s?.userId && !nextSeated.has(s.userId)).map(s => s!.name);
  const waitingIds = (room.queue ?? []).filter(id => wantsNextRound(profiles[id]) && !nextSeated.has(id) && !seated.has(id));

  let me: Audience['me'] = 'watching';
  if (selfId && seated.has(selfId)) me = nextSeated.has(selfId) ? 'playing' : 'leaving';
  else if (selfId && nextSeated.has(selfId)) me = 'joining';
  else if (selfId && wantsNextRound(profiles[selfId])) me = 'waiting';   // Also before the host has queued us

  return {
    spectators: Object.entries(profiles).filter(([userId, profile]) => profile && !seated.has(userId)).length,
    joining, leaving,
    waiting: waitingIds.map(nameOf),
    me,
    queuePosition: selfId ? waitingIds.indexOf(selfId) + 1 : 0,
  };
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
    .map(([userId, profile]): Spectator => ({
      peerId: userId,
      nickname: sanitizeName(profile!.name),
      ...((room.queue ?? []).includes(userId) && { queued: true }),
    }));

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
    players.push({
      slotIndex: i, nickname: entry.name, color: getSlotColor(room.gameMode, i), control,
      owner: entry.userId ?? 'ai',
    });
  }
  return { players, gameMode: room.gameMode, levelMode: room.levelMode };
}

export function slotOfUser(room: SharedRoom, userId: string): SlotIndex | null {
  const index = room.slots.findIndex(s => s?.userId === userId);
  return index >= 0 ? (index as SlotIndex) : null;
}
