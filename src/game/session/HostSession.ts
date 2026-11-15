// HostSession - authoritative game session.
// Used for local games (no transport) and by the host of a network game.

import type { SlotIndex } from '../../types/lobby';
import type { GameConfig, TronGameStateData, TronInput } from '../../types/game';
import { TronGameState } from '../TronGameState';
import type { PixelGrid } from '../PixelGrid';
import type { SmoothLinesData } from '../display/SmoothLines';
import type { Rng } from '../rng';
import { encodeSnapshot, serializeState } from '../../network/serialization';
import type { WireState } from '../../network/serialization';
import { PLAY_HEIGHT, PLAY_WIDTH, TICK_RATE } from '../constants';
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
}

export class HostSession implements GameSession {
  readonly game: TronGameState;
  onFrame: ((frame: TronGameStateData) => void) | null = null;
  onEnded: ((reason: string) => void) | null = null;
  onSnapshot: ((arena: PixelGrid, smoothLines?: SmoothLinesData) => void) | null = null;

  private readonly transport: HostTransport | null;
  private readonly now: () => number;
  private readonly inputs = new Map<SlotIndex, TronInput>();
  private readonly localSlots = new Set<SlotIndex>();
  private readonly bots: HumanBot[] = [];
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
    this.transport = options.transport ?? null;
    this.now = options.now ?? (() => performance.now());
    this.game = new TronGameState(config.players, config.gameMode, config.levelMode, options.rng);

    const rng = options.rng ?? Math.random;
    for (const player of config.players) {
      if (player.control.type === 'local') {
        this.localSlots.add(player.slotIndex);
      } else if (player.control.type === 'ai') {
        // Each bot gets its own random stream so bots don't perturb each other
        const botRng = createRng(Math.floor(rng() * 0x100000000));
        this.bots.push(createBot(player.slotIndex, player.control.difficulty, botRng, options.botHumanisation));
      }
    }

    const colors = new Map(config.players.map(p => [p.slotIndex, packCss(p.color)]));
    this.smoothLines = this.transport
      ? new SmoothLineKeeper(PLAY_WIDTH, PLAY_HEIGHT, slot => colors.get(slot))
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

  get runsInBackground(): boolean {
    return this.transport !== null;
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
    t0 = perfStart();
    const frame = this.game.serialize();
    perfEnd('serialize', t0);
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
      // Echo each guest's newest timestamp, advanced by the time it waited here
      const now = this.now();
      const pongs: Partial<Record<SlotIndex, number>> = {};
      for (const [slot, ping] of this.pings) pongs[slot] = ping.t + (now - ping.receivedAt);
      // Slow-changing parts are only sent when they change (and once a second, as a
      // safety net); guests keep the last value they received
      const refresh = this.framesSent++ % TICK_RATE === 0;
      const wire: WireState = { ...frame, tick, pongs, acks: this.acks };
      const round: WireState['round'] = { ...frame.round };
      wire.round = round;
      if (!this.changed('match', frame.match) && !refresh) delete wire.match;
      if (!this.changed('items', frame.round.items) && !refresh) delete round.items;
      if (!this.changed('portals', frame.round.portals) && !refresh) delete round.portals;
      const packed = serializeState(wire);
      this.bytesOut.add(packed.length, now);
      this.transport.broadcastState(packed);
      perfEnd('net', t0);
    }
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
    });
    return encodeSnapshot({
      tick: this.tick - 1, ...this.game.pixels.toRuns(), state,
      smoothLines: this.smoothLines?.lines.encode(),
    });
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
    return { lagMs: 0, bytesIn: 0, bytesOut: this.bytesOut.perSecond(this.now()) };
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
