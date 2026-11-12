// Artificial latency for testing netcode on one machine: open the game with
// `?lag=120` (milliseconds, one way; optionally `&jitter=40`) and every game message
// this client sends or receives is delayed by that much.

import type { SlotIndex } from '../types/lobby';
import type { TronInputMessage } from '../types/game';
import type { GuestTransport, HostTransport } from '../game/session/GameSession';

export interface DebugLag {
  delayMs: number;
  jitterMs: number;
}

// Read once at startup: the URL is rewritten when a room is joined
const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
const lagParam = Number(params?.get('lag') ?? 0);
const jitterParam = Number(params?.get('jitter') ?? 0);

export const DEBUG_LAG: DebugLag | null = lagParam > 0 || jitterParam > 0
  ? { delayMs: Math.max(0, lagParam), jitterMs: Math.max(0, jitterParam) }
  : null;

// Delays calls while keeping their order (like the reliable data channel does)
class DelayLine {
  private lastDue = 0;
  constructor(private readonly lag: DebugLag) {}

  push(run: () => void): void {
    const now = performance.now();
    const due = Math.max(this.lastDue, now + this.lag.delayMs + Math.random() * this.lag.jitterMs);
    this.lastDue = due;
    setTimeout(run, due - now);
  }
}

export class LaggedTransport implements HostTransport, GuestTransport {
  onInput: ((slot: SlotIndex, input: TronInputMessage) => void) | null = null;
  onState: ((data: Uint8Array) => void) | null = null;
  onHostDisconnected: (() => void) | null = null;

  private readonly outgoing: DelayLine;
  private readonly incoming: DelayLine;
  private closed = false;

  constructor(private readonly inner: HostTransport & GuestTransport, lag: DebugLag) {
    this.outgoing = new DelayLine(lag);
    this.incoming = new DelayLine(lag);
    inner.onInput = (slot, input) => this.incoming.push(() => { if (!this.closed) this.onInput?.(slot, input); });
    inner.onState = (data) => this.incoming.push(() => { if (!this.closed) this.onState?.(data); });
    inner.onHostDisconnected = () => this.onHostDisconnected?.();
  }

  broadcastState(data: Uint8Array): void {
    this.outgoing.push(() => { if (!this.closed) this.inner.broadcastState(data); });
  }

  sendInput(input: TronInputMessage): void {
    this.outgoing.push(() => { if (!this.closed) this.inner.sendInput(input); });
  }

  close(): void {
    this.closed = true;
    this.inner.close();
  }
}
