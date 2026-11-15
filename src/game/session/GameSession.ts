// GameSession - what the game screen needs from "a game in progress", whether it
// is simulated on this machine (local game / network host) or mirrored from a
// remote host (network guest). See design/local-and-ai.md.

import type { SlotIndex } from '../../types/lobby';
import type { TrailSegment, TronGameStateData, TronInput, TronInputMessage, TronMatchState, TronRoundState } from '../../types/game';
import type { PixelGrid } from '../PixelGrid';
import type { SmoothLinesData } from '../display/SmoothLines';

export interface NetworkStats {
  lagMs: number;     // Estimated one-way latency to the host
  bytesIn: number;   // bytes/sec incoming
  bytesOut: number;  // bytes/sec outgoing
  predictedTicks?: number;  // Guest: inputs sent but not yet acknowledged by the host
  silentMs?: number;        // Guest: time since the last state from the host
}

/** A guest that has heard nothing from the host for this long tells the player. */
export const HOST_SILENCE_MS = 1500;

export interface ViewState {
  round: TronRoundState;
  match: TronMatchState;
  /** Provisional trail pixels (predicted / extrapolated), redrawn every frame. */
  overlayTrails?: { color: string; segments: TrailSegment[] }[];
}

export interface GameSession {
  /** Advance one simulation tick with the inputs of this machine's human players. */
  step(localInputs: ReadonlyMap<SlotIndex, TronInput>): void;
  /** Called exactly once per simulated frame, in order, with its one-shot events. */
  onFrame: ((frame: TronGameStateData) => void) | null;
  /**
   * Called when joining a game in progress, before any frame: the arena as it is
   * now (trails, level damage). Only guests ever call this.
   */
  onSnapshot: ((arena: PixelGrid, smoothLines?: SmoothLinesData) => void) | null;
  /** What to draw right now; null until a guest has received its first state. */
  getViewState(): ViewState | null;
  /** Level obstacles for the level being played (ignored by guests). */
  setLevelObstacles(levelIndex: number, obstacles: PixelGrid): void;
  /** Lag and bitrate when networked, otherwise null. */
  getNetworkStats(): NetworkStats | null;
  /** True if the simulation must keep running while the tab is hidden. */
  readonly runsInBackground: boolean;
  /** The session cannot continue (e.g. the host left). */
  onEnded: ((reason: string) => void) | null;
  destroy(): void;
}

// === Transports: the network as seen by a session ===

export interface HostTransport {
  /** Send an encoded state to every guest. */
  broadcastState(data: Uint8Array): void;
  onInput: ((slot: SlotIndex, input: TronInputMessage) => void) | null;
  close(): void;
}

export interface GuestTransport {
  sendInput(input: TronInputMessage): void;
  onState: ((data: Uint8Array) => void) | null;
  onHostDisconnected: (() => void) | null;
  close(): void;
}

/** Sliding-window byte counter for bitrate display. */
export class ByteRate {
  private samples: { time: number; bytes: number }[] = [];
  constructor(private readonly windowMs = 2000) {}

  add(bytes: number, now: number): void {
    this.samples.push({ time: now, bytes });
    const cutoff = now - this.windowMs;
    while (this.samples.length > 0 && this.samples[0]!.time < cutoff) this.samples.shift();
  }

  perSecond(now: number): number {
    const cutoff = now - this.windowMs;
    let total = 0;
    for (const s of this.samples) if (s.time >= cutoff) total += s.bytes;
    return Math.round((total * 1000) / this.windowMs);
  }
}
