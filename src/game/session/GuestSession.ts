// GuestSession - mirrors a game simulated by a remote host.

import type { SlotIndex } from '../../types/lobby';
import type { TronGameStateData, TronInput } from '../../types/game';
import { deserializeState } from '../../network/serialization';
import { ByteRate } from './GameSession';
import type { GameSession, GuestTransport, NetworkStats, ViewState } from './GameSession';

export interface GuestSessionOptions {
  /** Millisecond clock (injectable for tests). */
  now?: () => number;
}

export class GuestSession implements GameSession {
  onFrame: ((frame: TronGameStateData) => void) | null = null;
  onEnded: ((reason: string) => void) | null = null;
  readonly runsInBackground = false;

  private readonly transport: GuestTransport;
  private readonly mySlot: SlotIndex | null;
  private readonly now: () => number;
  private latest: TronGameStateData | null = null;
  private seq = 0;
  private readonly bytesIn = new ByteRate();
  private lagSamples: number[] = [];
  private lagMs = 0;

  constructor(transport: GuestTransport, mySlot: SlotIndex | null, options: GuestSessionOptions = {}) {
    this.transport = transport;
    this.mySlot = mySlot;
    this.now = options.now ?? (() => performance.now());

    transport.onState = (data) => this.handleState(data);
    transport.onHostDisconnected = () => this.onEnded?.('Host disconnected');
  }

  step(localInputs: ReadonlyMap<SlotIndex, TronInput>): void {
    if (this.mySlot === null) return; // Spectator
    const input = localInputs.get(this.mySlot) ?? { steer: 0, action: false };
    this.transport.sendInput({ steer: input.steer, action: input.action, seq: ++this.seq, t: this.now() });
  }

  private handleState(data: Uint8Array): void {
    const state = deserializeState(data);
    const now = this.now();
    this.bytesIn.add(data.length, now);
    this.latest = state;

    const pong = this.mySlot !== null ? state.pongs?.[this.mySlot] : undefined;
    if (pong !== undefined) {
      // One-way lag ≈ RTT / 2; median of a rolling window for stability
      this.lagSamples.push(Math.max(0, (now - pong) / 2));
      if (this.lagSamples.length > 20) this.lagSamples.shift();
      const sorted = [...this.lagSamples].sort((a, b) => a - b);
      this.lagMs = Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0);
    }

    this.onFrame?.(state);
  }

  getViewState(): ViewState | null {
    return this.latest;
  }

  setLevelObstacles(): void {
    // Guests don't simulate collisions
  }

  getNetworkStats(): NetworkStats {
    return { lagMs: this.lagMs, bytesIn: this.bytesIn.perSecond(this.now()), bytesOut: 0 };
  }

  destroy(): void {
    this.transport.close();
  }
}
