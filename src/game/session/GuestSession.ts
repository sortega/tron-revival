// GuestSession - mirrors a game simulated by a remote host, with client-side
// prediction of the local player and dead reckoning of the others.
// See design/networking.md.

import type { SlotIndex } from '../../types/lobby';
import type { TrailSegment, TronGameStateData, TronInput, TronPlayerState } from '../../types/game';
import { deserializeState } from '../../network/serialization';
import { ByteRate } from './GameSession';
import type { GameSession, GuestTransport, NetworkStats, ViewState } from './GameSession';
import { predictPlayer } from './prediction';

/** Remote players are never extrapolated further than this (≈ 170 ms). */
export const MAX_EXTRAPOLATION_TICKS = 12;
/** Safety valve: with this many unacknowledged inputs the link is effectively dead. */
const MAX_PENDING_INPUTS = 140;

export interface GuestSessionOptions {
  /** Millisecond clock (injectable for tests). */
  now?: () => number;
  /** Predict the local player (default true). */
  predict?: boolean;
  /** Extrapolate remote players (default true). */
  extrapolate?: boolean;
}

interface PendingInput extends TronInput {
  seq: number;
}

export class GuestSession implements GameSession {
  onFrame: ((frame: TronGameStateData) => void) | null = null;
  onEnded: ((reason: string) => void) | null = null;
  readonly runsInBackground = false;

  private readonly transport: GuestTransport;
  private readonly mySlot: SlotIndex | null;
  private readonly now: () => number;
  private readonly predict: boolean;
  private readonly extrapolate: boolean;

  private latest: TronGameStateData | null = null;
  private seq = 0;
  private pending: PendingInput[] = [];
  private view: ViewState | null = null;   // Cached; rebuilt when inputs or state change

  private readonly bytesIn = new ByteRate();
  private lagSamples: number[] = [];
  private lagMs = 0;

  constructor(transport: GuestTransport, mySlot: SlotIndex | null, options: GuestSessionOptions = {}) {
    this.transport = transport;
    this.mySlot = mySlot;
    this.now = options.now ?? (() => performance.now());
    this.predict = options.predict ?? true;
    this.extrapolate = options.extrapolate ?? true;

    transport.onState = (data) => this.handleState(data);
    transport.onHostDisconnected = () => this.onEnded?.('Host disconnected');
  }

  step(localInputs: ReadonlyMap<SlotIndex, TronInput>): void {
    if (this.mySlot === null) return; // Spectator
    const input = localInputs.get(this.mySlot) ?? { steer: 0, action: false };
    const seq = ++this.seq;
    this.transport.sendInput({ steer: input.steer, action: input.action, seq, t: this.now() });

    this.pending.push({ steer: input.steer, action: input.action, seq });
    if (this.pending.length > MAX_PENDING_INPUTS) this.pending.shift();
    this.view = null;
  }

  private handleState(data: Uint8Array): void {
    const state = deserializeState(data);
    const now = this.now();
    this.bytesIn.add(data.length, now);
    this.latest = state;
    this.view = null;

    if (this.mySlot !== null) {
      const ack = state.acks?.[this.mySlot];
      if (ack !== undefined) {
        let drop = 0;
        while (drop < this.pending.length && this.pending[drop]!.seq <= ack) drop++;
        if (drop > 0) this.pending.splice(0, drop);
      }

      const pong = state.pongs?.[this.mySlot];
      if (pong !== undefined) {
        // One-way lag ≈ RTT / 2; median of a rolling window for stability
        this.lagSamples.push(Math.max(0, (now - pong) / 2));
        if (this.lagSamples.length > 20) this.lagSamples.shift();
        const sorted = [...this.lagSamples].sort((a, b) => a - b);
        this.lagMs = Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0);
      }
    }

    this.onFrame?.(state);
  }

  getViewState(): ViewState | null {
    if (!this.latest) return null;
    if (!this.view) this.view = this.buildView(this.latest);
    return this.view;
  }

  /** Predicted state of the local player (after all unacknowledged inputs). */
  getPredictedPlayer(): TronPlayerState | null {
    const view = this.getViewState();
    return view?.round.players.find(p => p.slotIndex === this.mySlot) ?? null;
  }

  getPendingCount(): number {
    return this.pending.length;
  }

  // Latest host state, with the local player moved forward by the inputs the host
  // has not processed yet, and the other players extrapolated by the same amount
  private buildView(state: TronGameStateData): ViewState {
    const { round, match } = state;
    if (round.phase !== 'playing' || this.pending.length === 0 || (!this.predict && !this.extrapolate)) {
      return { round, match };
    }

    const overlayTrails: { color: string; segments: TrailSegment[] }[] = [];
    const lead = Math.min(this.pending.length, MAX_EXTRAPOLATION_TICKS);

    const players = round.players.map(player => {
      if (!player.alive) return player;
      let inputs: readonly TronInput[] | null = null;
      if (player.slotIndex === this.mySlot) {
        if (this.predict) inputs = this.pending;
      } else if (this.extrapolate) {
        // Dead reckoning: assume the player keeps doing what it was doing
        inputs = new Array<TronInput>(lead).fill({ steer: player.steer, action: player.action });
      }
      if (!inputs) return player;
      const predicted = predictPlayer(player, inputs, round.portals);
      if (predicted.trail.length > 0) overlayTrails.push({ color: player.color, segments: predicted.trail });
      return predicted.state;
    });

    return { round: { ...round, players }, match, overlayTrails };
  }

  setLevelObstacles(): void {
    // Guests don't simulate collisions
  }

  getNetworkStats(): NetworkStats {
    return {
      lagMs: this.lagMs,
      bytesIn: this.bytesIn.perSecond(this.now()),
      bytesOut: 0,
      predictedTicks: this.pending.length,
    };
  }

  destroy(): void {
    this.transport.close();
  }
}
