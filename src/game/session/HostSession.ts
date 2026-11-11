// HostSession - authoritative game session.
// Used for local games (no transport) and by the host of a network game.

import type { SlotIndex } from '../../types/lobby';
import type { GameConfig, TronGameStateData, TronInput } from '../../types/game';
import { TronGameState } from '../TronGameState';
import type { PixelGrid } from '../PixelGrid';
import type { Rng } from '../rng';
import { serializeState } from '../../network/serialization';
import { ByteRate } from './GameSession';
import type { GameSession, HostTransport, NetworkStats, ViewState } from './GameSession';

export interface HostSessionOptions {
  transport?: HostTransport;
  rng?: Rng;
  /** Millisecond clock (injectable for tests). */
  now?: () => number;
}

export class HostSession implements GameSession {
  readonly game: TronGameState;
  onFrame: ((frame: TronGameStateData) => void) | null = null;
  onEnded: ((reason: string) => void) | null = null;

  private readonly transport: HostTransport | null;
  private readonly now: () => number;
  private readonly inputs = new Map<SlotIndex, TronInput>();
  private readonly localSlots = new Set<SlotIndex>();
  private lastFrame: TronGameStateData;
  private readonly bytesOut = new ByteRate();
  private readonly pings = new Map<SlotIndex, { t: number; receivedAt: number }>();

  constructor(config: GameConfig, options: HostSessionOptions = {}) {
    this.transport = options.transport ?? null;
    this.now = options.now ?? (() => performance.now());
    this.game = new TronGameState(config.players, config.gameMode, config.levelMode, options.rng);

    for (const player of config.players) {
      if (player.control.type === 'local') this.localSlots.add(player.slotIndex);
    }

    if (this.transport) {
      this.transport.onInput = (slot, input) => {
        // Only accept network input for slots that are not controlled here
        if (this.localSlots.has(slot)) return;
        this.inputs.set(slot, { steer: clampSteer(input.steer), action: !!input.action });
        if (typeof input.t === 'number') this.pings.set(slot, { t: input.t, receivedAt: this.now() });
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
      this.onFrame?.(initial);
    }

    for (const [slot, input] of localInputs) {
      if (this.localSlots.has(slot)) this.inputs.set(slot, input);
    }

    this.game.tick(this.inputs);
    const frame = this.game.serialize();
    this.lastFrame = frame;
    this.onFrame?.(frame);

    if (this.transport) {
      // Echo each guest's newest timestamp, advanced by the time it waited here
      const now = this.now();
      const pongs: Partial<Record<SlotIndex, number>> = {};
      for (const [slot, ping] of this.pings) pongs[slot] = ping.t + (now - ping.receivedAt);
      const packed = serializeState({ ...frame, pongs });
      this.bytesOut.add(packed.length, this.now());
      this.transport.broadcastState(packed);
    }
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

function clampSteer(steer: unknown): number {
  const n = typeof steer === 'number' && Number.isFinite(steer) ? steer : 0;
  return Math.max(-1, Math.min(1, n));
}
