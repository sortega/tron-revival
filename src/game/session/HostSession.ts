// HostSession - authoritative game session.
// Used for local games (no transport) and by the host of a network game.

import type { SlotIndex } from '../../types/lobby';
import type { FrameEvents, GameConfig, GamePlayer, TronGameStateData, TronInput } from '../../types/game';
import { TronGameState } from '../TronGameState';
import type { PixelGrid } from '../PixelGrid';
import type { SmoothLinesData } from '../display/SmoothLines';
import type { Rng } from '../rng';
import { encodeSnapshot, eventsOf, portalsKey, serializeState, toRoster } from '../../network/serialization';
import type { WireState } from '../../network/serialization';
import { PLAY_HEIGHT, PLAY_WIDTH, SPEED_UP_FACTOR, SPEED_UP_LOCK_TICKS, TICK_RATE } from '../constants';
import { SmoothLineKeeper } from '../display/SmoothLines';
import { packCss } from '../display/shade';
import { createBot } from '../ai/HumanBot';
import type { HumanBot } from '../ai/HumanBot';
import { createRng } from '../rng';
import { ByteRate } from './GameSession';
import type { GameSession, HostTransport, NetworkStats, ViewState } from './GameSession';
import { perfEnd, perfStart } from '../perf';

export interface HostSessionOptions {
  transport?: HostTransport;
  rng?: Rng;
  /** Millisecond clock (injectable for tests). */
  now?: () => number;
  /** Strength of the bots' human imperfections: 0 = none, 1 = as designed (design/bots-human.md). */
  botHumanisation?: number;
  /**
   * A round started with different players. Called before the first frame of that
   * round is sent, so the transport can change who gets which stream.
   */
  onRosterApplied?: (players: readonly GamePlayer[]) => void;
}

/** Watchers get one message every this many ticks (design/spectators.md). */
export const SPECTATOR_SEND_EVERY = 3;

const sameRoster = (a: readonly GamePlayer[], b: readonly GamePlayer[]): boolean =>
  JSON.stringify(a.map(p => [p.slotIndex, p.nickname, p.color, p.owner, p.control])) ===
  JSON.stringify(b.map(p => [p.slotIndex, p.nickname, p.color, p.owner, p.control]));

export class HostSession implements GameSession {
  readonly game: TronGameState;
  onFrame: ((frame: TronGameStateData) => void) | null = null;
  onEnded: ((reason: string) => void) | null = null;
  onSnapshot: ((arena: PixelGrid, smoothLines?: SmoothLinesData) => void) | null = null;
  onRoster: ((players: GamePlayer[]) => void) | null = null;

  private readonly options: HostSessionOptions;
  private readonly rng: Rng;
  private players: GamePlayer[];
  private pendingPlayers: GamePlayer[] | null = null;
  private rosterVersion = 0;
  // Frames not yet sent to the players: more than one only while sped up
  private outbox: (TronGameStateData & { tick: number })[] = [];
  // Speeding up while only bots are alive (design/local-and-ai.md)
  private botsOnlyTicks = 0;
  private speedUpOffered = false;
  private speedUpHeld = false;
  // Reduced stream: frames not yet sent to the watchers
  private backlog: (TronGameStateData & { tick: number })[] = [];
  private readonly spectatorBytesOut = new ByteRate();
  private spectatorMessages = 0;

  private readonly transport: HostTransport | null;
  private readonly now: () => number;
  private readonly inputs = new Map<SlotIndex, TronInput>();
  private readonly localSlots = new Set<SlotIndex>();
  private bots: HumanBot[] = [];
  private lastFrame: TronGameStateData;
  private readonly bytesOut = new ByteRate();
  private readonly pings = new Map<SlotIndex, { t: number; receivedAt: number }>();
  private readonly queues = new Map<SlotIndex, QueuedInput[]>();
  private readonly acks: Partial<Record<SlotIndex, number>> = {};
  private readonly lastSent = new Map<string, string>();
  private framesSent = 0;
  // The translucent part of the trails, for the snapshot of those who join late
  private readonly smoothLines: SmoothLineKeeper | null;
  private tick = 0;

  constructor(config: GameConfig, options: HostSessionOptions = {}) {
    this.options = options;
    this.transport = options.transport ?? null;
    this.now = options.now ?? (() => performance.now());
    this.game = new TronGameState(config.players, config.gameMode, config.levelMode, options.rng);
    this.players = config.players;

    this.rng = options.rng ?? Math.random;
    for (const player of config.players) {
      if (player.control.type === 'local') {
        this.localSlots.add(player.slotIndex);
      } else if (player.control.type === 'ai') {
        this.bots.push(this.createBot(player));
      }
    }

    // (seats change hands at round starts, design/spectators.md: the colour is the seat's)
    this.smoothLines = this.transport
      ? new SmoothLineKeeper(PLAY_WIDTH, PLAY_HEIGHT, slot => this.colorOf(slot))
      : null;

    if (this.transport) {
      this.transport.onInput = (slot, input) => {
        // Only accept network input for slots that are not controlled here
        if (this.localSlots.has(slot) || this.bots.some(b => b.slot === slot)) return;
        let queue = this.queues.get(slot);
        if (!queue) {
          queue = [];
          this.queues.set(slot, queue);
        }
        queue.push({
          steer: clampSteer(input.steer),
          action: !!input.action,
          seq: typeof input.seq === 'number' ? input.seq : 0,
          t: typeof input.t === 'number' ? input.t : 0,
          receivedAt: this.now(),
        });
      };
    }

    // Initial frame so that the view has something to draw before the first tick.
    // It is delivered to onFrame on the first step.
    this.lastFrame = this.game.serialize();
    this.pendingInitialFrame = this.lastFrame;
  }

  private pendingInitialFrame: TronGameStateData | null;

  private readonly colors = new Map<SlotIndex, number>();
  private colorOf(slot: SlotIndex): number | undefined {
    let color = this.colors.get(slot);
    if (color === undefined) {
      const player = this.players.find(p => p.slotIndex === slot);
      if (!player) return undefined;
      color = packCss(player.color);
      this.colors.set(slot, color);
    }
    return color;
  }

  private createBot(player: GamePlayer): HumanBot {
    // Each bot gets its own random stream so bots don't perturb each other
    const botRng = createRng(Math.floor(this.rng() * 0x100000000));
    const difficulty = player.control.type === 'ai' ? player.control.difficulty : 'normal';
    return createBot(player.slotIndex, difficulty, botRng, this.options.botHumanisation);
  }

  /**
   * Who plays from the next round on (design/spectators.md). Takes effect when that
   * round starts; passing the current players cancels a pending change.
   */
  setNextPlayers(players: GamePlayer[]): void {
    this.pendingPlayers = sameRoster(players, this.players) ? null : players;
    this.game.setNextPlayers(this.pendingPlayers);
  }

  /** The players of the round being played. */
  getPlayers(): readonly GamePlayer[] {
    return this.players;
  }

  // The simulation has just started a round with `pendingPlayers`
  private applyRoster(): void {
    this.rosterVersion = this.game.rosterVersion;
    const next = this.pendingPlayers;
    this.pendingPlayers = null;
    if (!next) return;

    const previous = new Map(this.players.map(p => [p.slotIndex, p]));
    const bots: HumanBot[] = [];
    this.localSlots.clear();
    for (const slot of [0, 1, 2, 3] as SlotIndex[]) {
      const before = previous.get(slot);
      const after = next.find(p => p.slotIndex === slot);
      if (!after || before?.owner !== after.owner) {
        // A new occupant must not inherit the input stream of the previous one
        this.inputs.delete(slot);
        this.queues.delete(slot);
        this.pings.delete(slot);
        delete this.acks[slot];
      }
      if (!after) continue;
      if (after.control.type === 'local') {
        this.localSlots.add(slot);
      } else if (after.control.type === 'ai') {
        const kept = before && JSON.stringify(before.control) === JSON.stringify(after.control)
          ? this.bots.find(b => b.slot === slot) : undefined;
        bots.push(kept ?? this.createBot(after));
      }
    }
    this.bots = bots;
    this.players = next;
    this.colors.clear();

    // Watchers get everything up to the previous tick before the audience changes
    this.flushSpectators();
    this.options.onRosterApplied?.(next);
    this.onRoster?.(next);
  }

  get runsInBackground(): boolean {
    return this.transport !== null;
  }

  get timeScale(): number {
    return this.speedUpOffered && this.speedUpHeld ? SPEED_UP_FACTOR : 1;
  }

  setSpeedUp(held: boolean): void {
    this.speedUpHeld = held;
  }

  // Whether time may be ('offered'), or is being ('on'), sped up after this tick
  private speedUpState(round: TronGameStateData['round']): 'offered' | 'on' | undefined {
    const alive = round.players.filter(p => p.alive);
    const botsOnly = round.phase === 'playing' && alive.length > 0 &&
      alive.every(p => this.bots.some(b => b.slot === p.slotIndex));
    this.botsOnlyTicks = botsOnly ? this.botsOnlyTicks + 1 : 0;
    this.speedUpOffered = this.botsOnlyTicks > SPEED_UP_LOCK_TICKS;
    if (!this.speedUpOffered) return undefined;
    return this.speedUpHeld ? 'on' : 'offered';
  }

  step(localInputs: ReadonlyMap<SlotIndex, TronInput>): void {
    if (this.pendingInitialFrame) {
      const initial = this.pendingInitialFrame;
      this.pendingInitialFrame = null;
      this.emit(initial);
    }

    for (const [slot, input] of localInputs) {
      if (this.localSlots.has(slot)) this.inputs.set(slot, input);
    }

    // Remote players: consume exactly one queued input per tick, so that every guest
    // tick maps to one host tick (this is what makes guest prediction exact)
    for (const [slot, queue] of this.queues) {
      // Too far behind (burst, or a guest clock running fast): skip the oldest
      while (queue.length > MAX_INPUT_QUEUE) queue.shift();
      const next = queue.shift();
      // Queue empty: keep the previous input for this tick and ack nothing new
      if (!next) continue;
      this.inputs.set(slot, { steer: next.steer, action: next.action });
      this.acks[slot] = next.seq;
      this.pings.set(slot, next);
    }

    let t0 = perfStart();
    for (const bot of this.bots) {
      this.inputs.set(bot.slot, bot.decide(this.game));
    }
    perfEnd('bots', t0);

    t0 = perfStart();
    this.game.tick(this.inputs);
    perfEnd('sim', t0);
    if (this.game.rosterVersion !== this.rosterVersion) this.applyRoster();
    t0 = perfStart();
    const frame = this.game.serialize();
    perfEnd('serialize', t0);
    const speedUp = this.speedUpState(frame.round);
    if (speedUp) frame.round.speedUp = speedUp;
    this.lastFrame = frame;
    this.emit(frame);
  }

  // Deliver a frame to the local view and to every guest
  private emit(frame: TronGameStateData): void {
    let t0 = perfStart();
    this.onFrame?.(frame);
    perfEnd('events', t0);
    this.smoothLines?.apply(frame);
    const tick = this.tick++;

    if (this.transport) {
      t0 = perfStart();
      // One message per tick; while sped up, one for every `timeScale` ticks
      this.outbox.push({ ...frame, tick });
      if (this.outbox.length >= this.timeScale) this.flushPlayers();

      // Reduced stream for those who only watch
      if (this.transport.sendSpectatorState) {
        if (this.transport.hasSpectators?.() ?? true) {
          this.backlog.push({ ...frame, tick });
          if (this.backlog.length >= SPECTATOR_SEND_EVERY * this.timeScale) this.flushSpectators();
        } else if (this.spectatorMessages > 0 || this.backlog.length > 0) {
          // Nobody watching: whoever comes next starts from a snapshot and a full message
          this.backlog = [];
          this.spectatorMessages = 0;
          for (const key of [...this.lastSent.keys()]) if (key.startsWith('w:')) this.lastSent.delete(key);
        }
      }
      perfEnd('net', t0);
    }
  }

  // Send the players the latest state, plus the events of the ticks before it that were
  // not sent (only while sped up)
  private flushPlayers(): void {
    const frames = this.outbox;
    const last = frames[frames.length - 1];
    if (!last || !this.transport) return;
    this.outbox = [];

    // Echo each guest's newest timestamp, advanced by the time it waited here
    const now = this.now();
    const pongs: Partial<Record<SlotIndex, number>> = {};
    for (const [slot, ping] of this.pings) pongs[slot] = ping.t + (now - ping.receivedAt);
    // Slow-changing parts are only sent when they change (and once a second, as a
    // safety net); guests keep the last value they received
    const refresh = this.framesSent++ % TICK_RATE === 0;
    const earlier: FrameEvents[] = frames.slice(0, -1).map(eventsOf);
    const wire: WireState = { ...last, pongs, acks: this.acks, ...(earlier.length > 0 && { earlier }) };
    const round: WireState['round'] = { ...last.round };
    wire.round = round;
    if (!this.changed('match', last.match) && !refresh) delete wire.match;
    if (!this.changed('items', last.round.items) && !refresh) delete round.items;
    this.trimPortals('portals', round, refresh);
    const roster = toRoster(this.players);
    if (this.changed('roster', roster) || refresh) wire.roster = roster;
    const packed = serializeState(wire);
    this.bytesOut.add(packed.length, now);
    this.transport.broadcastState(packed);
  }

  // Send the watchers the latest state plus the events of the ticks since the last message
  private flushSpectators(): void {
    const frames = this.backlog;
    const last = frames[frames.length - 1];
    if (!last || !this.transport?.sendSpectatorState) return;
    this.backlog = [];

    const refresh = this.spectatorMessages++ % Math.ceil(TICK_RATE / SPECTATOR_SEND_EVERY) === 0;
    const earlier: FrameEvents[] = frames.slice(0, -1).map(eventsOf);
    const wire: WireState = { ...last, ...(earlier.length > 0 && { earlier }) };
    const round: WireState['round'] = { ...last.round };
    wire.round = round;
    if (!this.changed('w:match', last.match) && !refresh) delete wire.match;
    if (!this.changed('w:items', last.round.items) && !refresh) delete round.items;
    this.trimPortals('w:portals', round, refresh);
    const roster = toRoster(this.players);
    if (this.changed('w:roster', roster) || refresh) wire.roster = roster;
    const packed = serializeState(wire);
    this.spectatorBytesOut.add(packed.length, this.now());
    this.transport.sendSpectatorState(packed);
  }

  /** Sequence number of the last input consumed for a remote slot. */
  getAck(slot: SlotIndex): number | undefined {
    return this.acks[slot];
  }

  /**
   * Everything a client needs to join the game in progress: the arena and a full
   * frame (without one-shot events, which are already reflected in the arena).
   */
  makeSnapshot(): Uint8Array {
    const frame = this.lastFrame;
    const state = serializeState({
      round: frame.round,
      match: frame.match,
      newTrailSegments: [],
      soundEvents: [],
      colorBlindnessFrames: frame.colorBlindnessFrames,
      whiteFlashFrames: frame.whiteFlashFrames,
      acks: this.acks,
      roster: toRoster(this.players),
    });
    return encodeSnapshot({
      tick: this.tick - 1, ...this.game.pixels.toRuns(), state,
      smoothLines: this.smoothLines?.lines.encode(),
    });
  }

  // Portals travel when they change; in between only their animation frames do, when
  // those change (every few ticks)
  private trimPortals(key: string, round: WireState['round'], refresh: boolean): void {
    const portals = round.portals ?? [];
    const frames = portals.map(p => p.animFrame);
    if (this.changed(key, portalsKey(portals)) || refresh) {
      this.changed(`${key}:frames`, frames);
      return;
    }
    delete round.portals;
    if (portals.length > 0 && this.changed(`${key}:frames`, frames)) round.portalFrames = frames;
  }

  // True if `value` differs from what was last recorded under `key`
  private changed(key: string, value: unknown): boolean {
    const json = JSON.stringify(value);
    if (this.lastSent.get(key) === json) return false;
    this.lastSent.set(key, json);
    return true;
  }

  getViewState(): ViewState {
    return this.lastFrame;
  }

  setLevelObstacles(levelIndex: number, obstacles: PixelGrid): void {
    if (levelIndex === this.game.currentLevelIndex) {
      this.game.setLevelObstacles(obstacles);
    }
  }

  getNetworkStats(): NetworkStats | null {
    if (!this.transport) return null;
    return {
      lagMs: 0, bytesIn: 0, bytesOut: this.bytesOut.perSecond(this.now()),
      bytesOutSpectators: this.spectatorBytesOut.perSecond(this.now()),
    };
  }

  destroy(): void {
    this.transport?.close();
  }
}

/** Inputs a guest may have waiting on the host before the oldest are skipped. */
export const MAX_INPUT_QUEUE = 4;

interface QueuedInput extends TronInput {
  seq: number;
  t: number;
  receivedAt: number;
}

function clampSteer(steer: unknown): number {
  const n = typeof steer === 'number' && Number.isFinite(steer) ? steer : 0;
  return Math.max(-1, Math.min(1, n));
}
