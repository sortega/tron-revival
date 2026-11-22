// RoomConnection - a multiplayer room on top of Trystero.
// Lobby state lives in Trystero's synchronised state; the host reconciles player
// profiles into seats. See design/networking.md.

import { normalizeLevelMode } from '../game/levelMode';
import { joinRoom, createUserIdentity, exportUserIdentity, importUserIdentity } from 'trystero';
import type { MessageAction, RequestAction, Room, RoomError, SharedState, UserIdentity, UserState } from 'trystero';
import type { ChatMessage, GameMode, LevelMode, LobbyState, SlotIndex } from '../types/lobby';
import type { BotDifficulty, GameConfig, GamePlayer, TronInputMessage } from '../types/game';
import type { GuestTransport, HostTransport } from '../game/session/GameSession';
import { loadIceSetup } from './ice';
export { generateRoomCode, normalizeRoomCode } from './roomCode';
import {
  MAX_WATCHERS, SLOT_INDEXES, audienceOf, botName, buildGameConfig, canStart, createSharedRoom, isRoomWriteAllowed,
  planNextRound, reconcile, sanitizeName, slotOfUser, toLobbyState,
} from './roomLogic';
import type { Audience, Profile, SharedRoom, SlotEntry } from './roomLogic';
export type { Audience } from './roomLogic';

// Includes a protocol version: incompatible builds never meet in a room
const APP_ID = 'teratron/v4';

const IDENTITY_KEY = 'teratron-identity';
const ROOM_KEY = 'teratron-room';

const GUEST_JOIN_TIMEOUT_MS = 25_000;    // Guest: give up if the room never answers
const HOST_RESUME_WAIT_MS = 4_000;       // Reloaded host: wait this long for peers to return the room
const HOST_GONE_TIMEOUT_MS = 25_000;     // Guests: how long to wait for a vanished host
const MAX_CHAT_MESSAGES = 100;
const MAX_CHAT_LENGTH = 300;
const MAX_BUFFERED_STATES = 300;
const STALE_STATE_WINDOW_MS = 1500;
const REFUSED_AFTER_MS = 10_000;         // Neither seated nor admitted for this long: the room is full

/** Room this tab was in before a reload, if any. */
export function rememberedRoom(): { code: string; host: boolean; joinNext: boolean } | null {
  try {
    const raw = sessionStorage.getItem(ROOM_KEY);
    const parsed = raw ? JSON.parse(raw) as { code?: unknown; host?: unknown; joinNext?: unknown } : null;
    return parsed && typeof parsed.code === 'string'
      ? { code: parsed.code, host: parsed.host === true, joinNext: parsed.joinNext === true } : null;
  } catch {
    return null;
  }
}

export type RoomStatus =
  | 'connecting'   // Joining the signaling network
  | 'searching'    // Joined; waiting for the room's state (guests)
  | 'ready'        // Room state known
  | 'closed';

export interface RoomCallbacks {
  onStatus?: (status: RoomStatus) => void;
  /** Seats, settings, spectators or chat changed. */
  onLobbyUpdate?: (state: LobbyState) => void;
  /** The room moved between lobby and game. `resume`: the game was already running when we arrived. */
  onPhase?: (phase: 'lobby' | 'game', info: { resume: boolean }) => void;
  /** Guests: the host disappeared (false) or came back (true). */
  onHostPresence?: (present: boolean) => void;
  /** Non-fatal problem worth telling the user about. */
  onNotice?: (text: string) => void;
  /** The room is unusable; the connection has been closed. */
  onClosed?: (reason: string) => void;
}

export interface PeerDiagnostics {
  userId: string;
  rttMs: number | null;
  path: 'direct' | 'relay' | 'unknown';
}

export interface RoomOptions {
  /** Create the room (become host) instead of joining an existing one. */
  create: boolean;
  nickname: string;
}

type GameTransport = HostTransport & GuestTransport;

// Per-tab identity: survives reloads (so a reload gets its seat back) but is not
// shared between tabs (so two tabs are two players)
async function loadIdentity(): Promise<UserIdentity> {
  try {
    const saved = sessionStorage.getItem(IDENTITY_KEY);
    if (saved) return await importUserIdentity(saved);
  } catch (err) {
    console.warn('[room] Stored identity unusable, creating a new one:', err);
  }
  const fresh = await createUserIdentity();
  try {
    sessionStorage.setItem(IDENTITY_KEY, exportUserIdentity(fresh));
  } catch {
    // Storage unavailable: identity lasts until reload
  }
  return fresh;
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

export class RoomConnection {
  readonly code: string;
  private readonly options: RoomOptions;
  private callbacks: RoomCallbacks = {};

  private room: Room | null = null;
  private shared: SharedState<SharedRoom | null> | null = null;
  private profiles: UserState<Profile | null> | null = null;
  private stateAction: MessageAction<Uint8Array> | null = null;
  private inputAction: MessageAction<TronInputMessage> | null = null;
  private chatAction: MessageAction<string> | null = null;
  private syncAction: RequestAction<null, Uint8Array> | null = null;
  private byeAction: MessageAction<string> | null = null;

  private status: RoomStatus = 'connecting';
  private selfId: string | null = null;
  private current: SharedRoom | null = null;   // Last room state seen
  // Host: the last room state written. Writes are asynchronous, so `current` can be
  // one step behind; everything the host decides is based on this one
  private written: SharedRoom | null = null;
  // Host, during a game: who plays the round in progress (userId -> slot), users who
  // said goodbye, and where to push the plan for the next round
  private activeRoster: Map<string, SlotIndex> | null = null;
  private departed = new Set<string>();
  private nextPlayersListener: ((players: GamePlayer[]) => void) | null = null;
  private playerTargets: string[] = [];
  private watcherTargets: string[] = [];
  private refusedTimer: ReturnType<typeof setTimeout> | null = null;
  private myProfile: Profile;
  private chat: ChatMessage[] = [];
  private chatSeq = 0;

  private transport: GameTransport | null = null;
  private bufferedStates: Uint8Array[] = [];
  private ignoreStatesUntil = 0;
  private snapshotProvider: (() => Uint8Array | Promise<Uint8Array>) | null = null;

  private hostPresent = true;
  private hostGoneTimer: ReturnType<typeof setTimeout> | null = null;
  private joinTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private turnConfigured = false;

  constructor(code: string, options: RoomOptions) {
    this.code = code;
    this.options = options;
    this.myProfile = { name: sanitizeName(options.nickname), want: -1 };
    // A request to play from the next round survives a reload
    const remembered = rememberedRoom();
    if (remembered?.code === code && remembered.joinNext) this.myProfile.joinNext = true;
  }

  setCallbacks(callbacks: RoomCallbacks): void {
    this.callbacks = callbacks;
  }

  // === Accessors ===

  getStatus(): RoomStatus {
    return this.status;
  }

  getSelfId(): string | null {
    return this.selfId;
  }

  isHost(): boolean {
    return this.selfId !== null && this.current?.hostId === this.selfId;
  }

  getPhase(): 'lobby' | 'game' | null {
    return this.current?.phase ?? null;
  }

  isHostPresent(): boolean {
    return this.hostPresent;
  }

  hasTurn(): boolean {
    return this.turnConfigured;
  }

  getMySlotIndex(): SlotIndex | null {
    return this.current && this.selfId ? slotOfUser(this.current, this.selfId) : null;
  }

  // The room as the host last wrote it (host), or as last received (guests)
  private view(): SharedRoom | null {
    return this.written && this.isHost() ? this.written : this.current;
  }

  /** Who is around the game in progress: spectators, who joins or leaves next round. */
  getAudience(): Audience {
    const room = this.view();
    if (!room) return { spectators: 0, joining: [], leaving: [], waiting: [], me: 'watching', queuePosition: 0 };
    return audienceOf(room, this.presentProfiles(), this.selfId, this.departed);
  }

  /** Link that brings a browser into this room. */
  getLink(): string {
    return `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(this.code)}`;
  }

  getLobbyState(): LobbyState | null {
    if (!this.current) return null;
    const state = toLobbyState(this.code, this.current, this.presentProfiles());
    state.chatMessages = this.chat;
    return state;
  }

  canStartGame(): boolean {
    return this.current !== null && canStart(this.current);
  }

  /** Game configuration from this participant's point of view. */
  getGameConfig(): GameConfig | null {
    return this.current && this.selfId ? buildGameConfig(this.current, this.selfId) : null;
  }

  // === Connection ===

  async connect(): Promise<void> {
    this.setStatus('connecting');
    try {
      const ice = await loadIceSetup();
      if (this.closed) return;
      this.turnConfigured = ice.turnConfig.length > 0;

      const room = joinRoom({
        appId: APP_ID,
        identity: loadIdentity,
        ...(ice.turnConfig.length > 0 && { turnConfig: ice.turnConfig }),
        ...(ice.forceRelay && { rtcConfig: { iceTransportPolicy: 'relay' as const } }),
      }, this.code);
      this.room = room;

      room.onError(err => this.handleRoomError(err));

      this.shared = room.makeState<SharedRoom | null>('room', null, {
        validate: (next, ctx) => isRoomWriteAllowed(ctx.prev, next, ctx.userId),
      }) as SharedState<SharedRoom | null>;
      this.profiles = room.makeUserState<Profile | null>('profile', null) as UserState<Profile | null>;
      this.stateAction = room.makeAction<Uint8Array>('s');
      this.inputAction = room.makeAction<TronInputMessage>('i');
      this.chatAction = room.makeAction<string>('chat');
      this.syncAction = room.makeAction<null, Uint8Array>('sync', { kind: 'request' });
      this.byeAction = room.makeAction<string>('bye');
      // The host says goodbye when it closes the room, so guests need not wait
      this.byeAction.onMessage((_reason, { userId }) => {
        if (userId === this.current?.hostId && userId !== this.selfId) {
          this.close('The host closed the room.');
        } else if (this.isHost() && userId !== this.selfId) {
          // A guest left for good: its seat need not be kept for a return
          this.departed.add(userId);
          this.handlePresenceChange();
        }
      });

      this.shared.onChange(value => this.handleRoomChange(value));
      this.profiles.onChange(() => this.handlePresenceChange());
      room.onUserJoin(({ userId }) => {
        this.departed.delete(userId);
        if (userId === this.current?.hostId) this.setHostPresent(true);
        this.handlePresenceChange();
      });
      room.onUserLeave(({ userId }) => {
        if (userId === this.current?.hostId && userId !== this.selfId) this.setHostPresent(false);
        this.handlePresenceChange();
      });

      this.stateAction.onMessage((data, { userId }) => {
        if (!this.current || userId !== this.current.hostId) return;
        const bytes = toBytes(data);
        if (bytes) this.deliverState(bytes);
      });
      this.inputAction.onMessage((input, { userId }) => {
        if (!this.isHost() || !this.current || typeof input !== 'object' || input === null) return;
        // Only from whoever owns a slot in the round being played
        const slot = this.activeRoster?.get(userId);
        if (slot !== undefined) this.transport?.onInput?.(slot, input);
      });
      this.chatAction.onMessage((text, { userId }) => this.addChat(userId, text));
      this.syncAction.onRequest(() => {
        if (!this.isHost() || !this.snapshotProvider) return new Uint8Array(0);
        // Whoever asks is here: make sure the stream reaches them from this tick on
        this.refreshTargets();
        return this.snapshotProvider();
      });

      const self = await room.getSelf();
      if (this.closed) return;
      this.selfId = self.userId;
      void this.profiles.set(this.myProfile);

      // Keep the room in the URL so that a reload comes back here
      const params = new URLSearchParams(window.location.search);
      params.set('room', this.code);
      window.history.replaceState({}, '', `${window.location.pathname}?${params}`);

      const resumeAsHost = !this.options.create && rememberedRoom()?.code === this.code && rememberedRoom()?.host === true;
      if (this.options.create) {
        this.becomeHost();
      } else {
        this.setStatus('searching');
        // The room state may already have arrived while we were setting up
        const existing = this.shared.get();
        if (existing) this.handleRoomChange(existing);
        this.joinTimer = setTimeout(() => {
          if (this.current || this.closed) return;
          if (resumeAsHost) {
            // We were the host and nobody is left to give the room back: recreate it
            this.becomeHost();
          } else {
            this.close('Could not reach the room. Check the code — or the host may be on a network that blocks direct connections.');
          }
        }, resumeAsHost ? HOST_RESUME_WAIT_MS : GUEST_JOIN_TIMEOUT_MS);
      }
    } catch (err) {
      console.error('[room] Failed to join:', err);
      this.close('Could not connect to the multiplayer network.');
    }
  }

  private becomeHost(): void {
    if (!this.shared || !this.selfId) return;
    this.write(createSharedRoom(this.selfId));
  }

  // Host: publish a new room state
  private write(room: SharedRoom): void {
    this.written = room;
    void this.shared?.set(room);
  }

  /** Leave the room for good. */
  leave(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    try {
      sessionStorage.removeItem(ROOM_KEY);
    } catch {
      // ignore
    }
    const params = new URLSearchParams(window.location.search);
    params.delete('room');
    const query = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (query ? `?${query}` : ''));
    this.transport = null;
    const room = this.room;
    this.room = null;
    if (room) {
      // Let the goodbye go out before tearing the connections down: the host closes
      // the room for everybody, a guest tells the host not to keep its seat
      const hostId = this.current?.hostId;
      const goodbye = this.isHost() ? this.byeAction?.send('closed').catch(() => {})
        : hostId ? this.byeAction?.send('left', { target: hostId }).catch(() => {}) : undefined;
      void Promise.race([goodbye, new Promise(resolve => setTimeout(resolve, 300))])
        .then(() => room.leave())
        .catch(() => {});
    }
    this.setStatus('closed');
  }

  private close(reason: string): void {
    if (this.closed) return;
    const { onClosed } = this.callbacks;
    this.leave();
    onClosed?.(reason);
  }

  private clearTimers(): void {
    if (this.hostGoneTimer) clearTimeout(this.hostGoneTimer);
    if (this.joinTimer) clearTimeout(this.joinTimer);
    if (this.refusedTimer) clearTimeout(this.refusedTimer);
    this.hostGoneTimer = null;
    this.joinTimer = null;
    this.refusedTimer = null;
  }

  private setStatus(status: RoomStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.callbacks.onStatus?.(status);
  }

  private handleRoomError(err: RoomError): void {
    console.warn('[room] error:', err.code, err.message);
    if (err.code === 'relay-failed') {
      this.callbacks.onNotice?.('Trouble reaching the signaling relays; players may take longer to appear.');
    } else if (err.code === 'peer-connect-failed') {
      this.callbacks.onNotice?.(err.turnConfigured
        ? 'Could not establish a connection with a player, even through the relay server.'
        : 'Could not establish a direct connection with a player, and no TURN relay is configured.');
    } else if (err.code === 'identity-failed') {
      this.close('Could not create a player identity in this browser.');
    }
  }

  // === Room state ===

  private presentProfiles(): Readonly<Record<string, Profile | null>> {
    const all = { ...(this.profiles?.getAll() ?? {}) };
    // Our own profile is known locally even before it has been published
    if (this.selfId) all[this.selfId] = this.myProfile;
    return all;
  }

  private handleRoomChange(value: SharedRoom | null): void {
    if (this.closed || !value || !Array.isArray(value.slots)) return;
    const previous = this.current;
    this.current = value;

    if (!previous) {
      if (this.joinTimer) clearTimeout(this.joinTimer);
      this.joinTimer = null;
      this.remember();
      this.setStatus('ready');
      if (!this.isHost()) {
        this.setHostPresent(this.room !== null && value.hostId in this.room.getUsers());
      }
    }

    // A host that comes back (reload) has lost the simulation: back to the lobby
    if (!previous && this.isHost() && value.phase === 'game') {
      this.setPhase('lobby');
      return;
    }

    if (previous?.phase !== value.phase && value.phase === 'lobby') {
      this.activeRoster = null;
      this.nextPlayersListener = null;
      this.departed.clear();
    }
    this.reconcileSeats();
    this.checkAdmission();
    this.emitLobby();

    if (previous?.phase !== value.phase) {
      if (value.phase === 'lobby') {
        // Frames still in flight belong to the game that just ended
        this.bufferedStates = [];
        this.ignoreStatesUntil = performance.now() + STALE_STATE_WINDOW_MS;
      }
      if (previous || value.phase === 'game') {
        this.callbacks.onPhase?.(value.phase, { resume: !previous });
      }
    }
  }

  private handlePresenceChange(): void {
    if (this.closed) return;
    this.reconcileSeats();
    this.checkAdmission();
    this.emitLobby();
  }

  private remember(): void {
    try {
      sessionStorage.setItem(ROOM_KEY, JSON.stringify({
        code: this.code, host: this.isHost(), joinNext: this.myProfile.joinNext === true,
      }));
    } catch {
      // ignore
    }
  }

  // Host: turn profiles into seats (lobby), queue and watchers; during a game, plan
  // the next round and say who gets which stream
  private reconcileSeats(): void {
    const room = this.view();
    if (!this.isHost() || !room || !this.shared) return;
    const next = reconcile(room, this.presentProfiles());
    if (next !== room) this.write(next);
    this.pushPlan();
    this.refreshTargets();
  }

  // Host, during a game: tell the session who plays from the next round on
  private pushPlan(): void {
    const room = this.view();
    if (!this.nextPlayersListener || !room || room.phase !== 'game' || !this.selfId) return;
    const slots = planNextRound(room, this.presentProfiles(), this.departed);
    this.nextPlayersListener(buildGameConfig({ ...room, slots }, this.selfId).players);
  }

  // Host: who gets the full-rate stream (players of this round) and who the reduced one
  private refreshTargets(): void {
    const room = this.view();
    if (!this.isHost() || !room || !this.room || !this.activeRoster) {
      this.playerTargets = [];
      this.watcherTargets = [];
      return;
    }
    const profiles = this.presentProfiles();
    const admitted = new Set([...(room.watchers ?? []), ...room.slots.map(s => s?.userId)]);
    const players: string[] = [];
    const watchers: string[] = [];
    for (const userId of Object.keys(this.room.getUsers())) {
      if (userId === this.selfId) continue;
      if (this.activeRoster.has(userId)) players.push(userId);
      // Not (yet) known by profile: let them watch; known and over the limit: no
      else if (!profiles[userId] || admitted.has(userId)) watchers.push(userId);
    }
    this.playerTargets = players;
    this.watcherTargets = watchers;
  }

  /**
   * Host: a round has started with these players (also called for the first round).
   * The room's seats follow the simulation.
   */
  setActiveRoster(players: readonly GamePlayer[]): void {
    if (!this.isHost()) return;
    const first = this.activeRoster === null;
    this.activeRoster = new Map(players.filter(p => p.owner && p.owner !== 'ai').map(p => [p.owner!, p.slotIndex]));
    if (!first) {
      const slots = SLOT_INDEXES.map((i): SlotEntry | null => {
        const player = players.find(p => p.slotIndex === i);
        if (!player) return null;
        return player.control.type === 'ai'
          ? { ai: player.control.difficulty, name: player.nickname }
          : { userId: player.owner, name: player.nickname };
      });
      // Whoever gave up a seat stays in the room as a watcher, whatever the limit
      const unseated = (room: SharedRoom): string[] => room.slots
        .map(s => s?.userId).filter((id): id is string => !!id && !slots.some(n => n?.userId === id));
      this.updateRoom(room => ({ ...room, slots, watchers: [...(room.watchers ?? []), ...unseated(room)] }));
      for (const userId of [...this.departed]) if (!this.activeRoster.has(userId)) this.departed.delete(userId);
    }
    this.refreshTargets();
    this.emitLobby();
  }

  /** Host: where to send the players of the next round whenever the plan changes. */
  setNextPlayersListener(listener: ((players: GamePlayer[]) => void) | null): void {
    this.nextPlayersListener = listener;
    this.pushPlan();
  }

  // Guests: a room that neither seats nor admits us is full
  private checkAdmission(): void {
    const room = this.current;
    const refused = !!room && !!this.selfId && !this.isHost() && this.hostPresent &&
      slotOfUser(room, this.selfId) === null && !(room.watchers ?? []).includes(this.selfId);
    if (!refused) {
      if (this.refusedTimer) clearTimeout(this.refusedTimer);
      this.refusedTimer = null;
    } else if (!this.refusedTimer) {
      this.refusedTimer = setTimeout(() => {
        this.refusedTimer = null;
        this.close(`The room is full: all seats are taken and it already has ${MAX_WATCHERS} spectators.`);
      }, REFUSED_AFTER_MS);
    }
  }

  private emitLobby(): void {
    const state = this.getLobbyState();
    if (state) this.callbacks.onLobbyUpdate?.(state);
  }

  private setHostPresent(present: boolean): void {
    if (this.hostPresent === present) return;
    this.hostPresent = present;
    if (this.hostGoneTimer) clearTimeout(this.hostGoneTimer);
    this.hostGoneTimer = null;
    if (!present) {
      this.hostGoneTimer = setTimeout(() => this.close('The host left the room.'), HOST_GONE_TIMEOUT_MS);
    }
    this.callbacks.onHostPresence?.(present);
  }

  // Host: apply a change to the room state
  private updateRoom(change: (room: SharedRoom) => SharedRoom): void {
    const room = this.view();
    if (!this.isHost() || !room || !this.shared) return;
    this.write(reconcile(change(room), this.presentProfiles()));
  }

  // === Lobby actions (everyone) ===

  private publishProfile(change: Partial<Profile>): void {
    this.myProfile = { ...this.myProfile, ...change };
    void this.profiles?.set(this.myProfile);
    this.remember();
    // The host acts on its own profile straight away
    this.handlePresenceChange();
  }

  joinSlot(slotIndex: SlotIndex): void {
    this.publishProfile({ want: slotIndex });
  }

  leaveSlot(): void {
    this.publishProfile({ want: null, joinNext: false });
  }

  /** Spectator of a running game: ask for a seat from the next round. */
  askToPlay(): void {
    this.publishProfile({ want: -1, joinNext: true });
  }

  /** Take back `askToPlay`. */
  cancelAsk(): void {
    this.publishProfile({ joinNext: false });
  }

  /** Player of a running game: watch from the next round on. */
  stepDown(): void {
    this.publishProfile({ want: null, joinNext: false });
  }

  /** Take back `stepDown` before the round is over. */
  stayIn(): void {
    this.publishProfile({ want: -1 });
  }

  setNickname(nickname: string): void {
    this.publishProfile({ name: sanitizeName(nickname) });
  }

  sendChat(text: string): void {
    const clean = text.trim().slice(0, MAX_CHAT_LENGTH);
    if (!clean || !this.selfId) return;
    void this.chatAction?.send(clean).catch(() => {});
    this.addChat(this.selfId, clean);
  }

  private addChat(userId: string, text: unknown): void {
    if (typeof text !== 'string' || !text.trim()) return;
    const profile = userId === this.selfId ? this.myProfile : this.profiles?.get(userId);
    this.chat.push({
      id: String(++this.chatSeq),
      senderSlotIndex: this.current ? slotOfUser(this.current, userId) : null,
      senderNickname: sanitizeName(profile?.name),
      text: text.slice(0, MAX_CHAT_LENGTH),
      timestamp: Date.now(),
    });
    if (this.chat.length > MAX_CHAT_MESSAGES) this.chat = this.chat.slice(-MAX_CHAT_MESSAGES);
    this.emitLobby();
  }

  // === Lobby actions (host) ===

  setGameMode(gameMode: GameMode): void {
    this.updateRoom(room => ({
      ...room,
      gameMode,
      // Bot names follow the colour scheme of the mode
      slots: room.slots.map((s, i) => (s?.ai ? { ...s, name: botName(gameMode, i as SlotIndex) } : s)),
    }));
  }

  setLevelMode(levelMode: LevelMode): void {
    this.updateRoom(room => ({ ...room, levelMode: normalizeLevelMode(levelMode) }));
  }

  addBot(slotIndex: SlotIndex, difficulty: BotDifficulty): void {
    this.updateRoom(room => {
      if (room.slots[slotIndex]) return room;
      const slots = [...room.slots];
      slots[slotIndex] = { ai: difficulty, name: botName(room.gameMode, slotIndex) };
      return { ...room, slots };
    });
  }

  setBotDifficulty(slotIndex: SlotIndex, difficulty: BotDifficulty): void {
    this.updateRoom(room => {
      const slot = room.slots[slotIndex];
      if (!slot?.ai) return room;
      const slots = [...room.slots];
      slots[slotIndex] = { ...slot, ai: difficulty };
      return { ...room, slots };
    });
  }

  removeBot(slotIndex: SlotIndex): void {
    this.updateRoom(room => {
      if (!room.slots[slotIndex]?.ai) return room;
      const slots = [...room.slots];
      slots[slotIndex] = null;
      return { ...room, slots };
    });
  }

  startGame(): void {
    const room = this.view();
    if (!room || !canStart(room)) return;
    this.updateRoom(room => ({ ...room, phase: 'game', gameId: room.gameId + 1 }));
  }

  /** Host: move the room between lobby and game. */
  setPhase(phase: 'lobby' | 'game'): void {
    this.updateRoom(room => (room.phase === phase ? room : { ...room, phase }));
  }

  // === Game phase ===

  /** Transport for a game session. Closing it does not leave the room. */
  createTransport(): GameTransport {
    const transport: GameTransport = {
      onInput: null,
      onState: null,
      onHostDisconnected: null,
      broadcastState: (data) => {
        if (this.playerTargets.length > 0) void this.stateAction?.send(data, { target: this.playerTargets }).catch(() => {});
      },
      sendSpectatorState: (data) => {
        if (this.watcherTargets.length > 0) void this.stateAction?.send(data, { target: this.watcherTargets }).catch(() => {});
      },
      hasSpectators: () => this.watcherTargets.length > 0,
      sendInput: (input) => {
        const hostId = this.current?.hostId;
        if (hostId) void this.inputAction?.send(input, { target: hostId }).catch(() => {});
      },
      close: () => {
        if (this.transport === transport) this.transport = null;
      },
    };
    this.transport = transport;
    // Deliver the frames that arrived before the game screen was ready
    const backlog = this.bufferedStates;
    this.bufferedStates = [];
    queueMicrotask(() => {
      for (const data of backlog) if (this.transport === transport) transport.onState?.(data);
    });
    return transport;
  }

  private deliverState(data: Uint8Array): void {
    if (this.transport?.onState) {
      this.transport.onState(data);
    } else if (performance.now() >= this.ignoreStatesUntil && this.bufferedStates.length < MAX_BUFFERED_STATES) {
      this.bufferedStates.push(data);
    }
  }

  /** Host: how to produce a snapshot for players joining mid-game. */
  setSnapshotProvider(provider: (() => Uint8Array | Promise<Uint8Array>) | null): void {
    this.snapshotProvider = provider;
  }

  /** Guest: ask the host for the game in progress. Null if it could not be obtained. */
  async requestSnapshot(): Promise<Uint8Array | null> {
    const hostId = this.current?.hostId;
    if (!hostId || !this.syncAction) return null;
    try {
      const bytes = toBytes(await this.syncAction.request(null, { target: hostId, timeoutMs: 8000 }));
      return bytes && bytes.length > 0 ? bytes : null;
    } catch (err) {
      console.warn('[room] snapshot request failed:', err);
      return null;
    }
  }

  // === Diagnostics ===

  /** Round-trip time and path type of every direct peer connection. */
  async getDiagnostics(): Promise<PeerDiagnostics[]> {
    const result: PeerDiagnostics[] = [];
    for (const peer of Object.values(this.room?.getPeers() ?? {})) {
      const entry: PeerDiagnostics = { userId: peer.userId, rttMs: null, path: 'unknown' };
      try {
        const stats = await peer.connection?.getStats();
        if (stats) {
          const byId = new Map<string, Record<string, unknown>>();
          stats.forEach((report: Record<string, unknown>) => byId.set(report.id as string, report));
          let pair: Record<string, unknown> | undefined;
          for (const report of byId.values()) {
            if (report.type === 'transport' && typeof report.selectedCandidatePairId === 'string') {
              pair = byId.get(report.selectedCandidatePairId);
            }
          }
          // Firefox has no transport report: fall back to the nominated pair
          pair ??= [...byId.values()].find(r => r.type === 'candidate-pair' && (r.selected === true || (r.nominated === true && r.state === 'succeeded')));
          if (pair) {
            if (typeof pair.currentRoundTripTime === 'number') entry.rttMs = Math.round(pair.currentRoundTripTime * 1000);
            const local = byId.get(pair.localCandidateId as string);
            const remote = byId.get(pair.remoteCandidateId as string);
            if (local && remote) {
              entry.path = local.candidateType === 'relay' || remote.candidateType === 'relay' ? 'relay' : 'direct';
            }
          }
        }
      } catch {
        // Connection closing: leave as unknown
      }
      result.push(entry);
    }
    return result;
  }
}
