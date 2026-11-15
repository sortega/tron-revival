// Simulated network for netcode tests: a host and guests exchanging messages over
// links with configurable latency and jitter, on a virtual clock.

import type { SlotIndex } from '../src/types/lobby';
import type { TronInputMessage } from '../src/types/game';
import type { GuestTransport, HostTransport } from '../src/game/session/GameSession';
import { TICK_MS } from '../src/game/constants';
import { createRng } from '../src/game/rng';
import type { Rng } from '../src/game/rng';

export interface LinkOptions {
  delayMs: number;      // One-way latency
  jitterMs?: number;    // Extra random latency, uniform in [0, jitterMs]
}

interface Event {
  at: number;
  order: number;
  run: () => void;
}

export class SimNet {
  time = 0;
  private events: Event[] = [];
  private order = 0;
  private readonly rng: Rng;

  readonly hostTransport: HostTransport;
  private guests = new Map<SlotIndex, { transport: GuestTransport; link: LinkOptions; lastUp: number; lastDown: number }>();
  // Users identified by id, whose role (player in a slot, or watcher) can change
  private members = new Map<string, { transport: GuestTransport; link: LinkOptions; lastUp: number; lastDown: number }>();
  private roles = new Map<string, SlotIndex>();
  /** Bytes sent on each stream (one copy, whatever the number of receivers). */
  bytes = { players: 0, watchers: 0, playerMessages: 0, watcherMessages: 0 };

  constructor(seed = 1) {
    this.rng = createRng(seed);
    this.hostTransport = {
      onInput: null,
      broadcastState: (data) => {
        this.bytes.players += data.length;
        this.bytes.playerMessages++;
        for (const [id, member] of this.members) if (this.roles.has(id)) this.deliver(member, data);
        for (const guest of this.guests.values()) {
          // Reliable ordered channel: never delivered before an earlier message
          const at = Math.max(guest.lastDown, this.time + this.latency(guest.link));
          guest.lastDown = at;
          const copy = data.slice();
          this.schedule(at, () => guest.transport.onState?.(copy));
        }
      },
      close: () => {},
    };
  }

  now = (): number => this.time;

  private deliver(to: { transport: GuestTransport; link: LinkOptions; lastDown: number }, data: Uint8Array): void {
    const at = Math.max(to.lastDown, this.time + this.latency(to.link));
    to.lastDown = at;
    const copy = data.slice();
    this.schedule(at, () => to.transport.onState?.(copy));
  }

  /** Give the host a reduced stream for members who do not play (design/spectators.md). */
  enableSpectatorStream(): void {
    this.hostTransport.sendSpectatorState = (data) => {
      this.bytes.watchers += data.length;
      this.bytes.watcherMessages++;
      for (const [id, member] of this.members) if (!this.roles.has(id)) this.deliver(member, data);
    };
    this.hostTransport.hasSpectators = () => [...this.members.keys()].some(id => !this.roles.has(id));
  }

  /** A user known by id: a watcher until `setRoles` gives it a slot. */
  addMember(id: string, link: LinkOptions): GuestTransport {
    const entry = {
      link,
      lastUp: 0,
      lastDown: 0,
      transport: {
        onState: null,
        onHostDisconnected: null,
        sendInput: (input: TronInputMessage) => {
          const at = Math.max(entry.lastUp, this.time + this.latency(link));
          entry.lastUp = at;
          const copy = { ...input };
          this.schedule(at, () => {
            // Like the room: inputs count only for the slot the sender owns right now
            const slot = this.roles.get(id);
            if (slot !== undefined) this.hostTransport.onInput?.(slot, copy);
          });
        },
        close: () => {},
      } as GuestTransport,
    };
    this.members.set(id, entry);
    return entry.transport;
  }

  /** Who plays where, as the host's roster says. */
  setRoles(roles: ReadonlyMap<string, SlotIndex>): void {
    this.roles = new Map(roles);
  }

  private latency(link: LinkOptions): number {
    return link.delayMs + (link.jitterMs ? this.rng() * link.jitterMs : 0);
  }

  addGuest(slot: SlotIndex, link: LinkOptions): GuestTransport {
    const entry = {
      link,
      lastUp: 0,
      lastDown: 0,
      transport: {
        onState: null,
        onHostDisconnected: null,
        sendInput: (input: TronInputMessage) => {
          const at = Math.max(entry.lastUp, this.time + this.latency(link));
          entry.lastUp = at;
          const copy = { ...input };
          this.schedule(at, () => this.hostTransport.onInput?.(slot, copy));
        },
        close: () => {},
      } as GuestTransport,
    };
    this.guests.set(slot, entry);
    return entry.transport;
  }

  schedule(at: number, run: () => void): void {
    this.events.push({ at, order: this.order++, run });
  }

  /** Call `tick` every simulation tick, starting at `phaseMs`. `rate` scales the clock speed. */
  every(tick: () => void, phaseMs = 0, rate = 1): void {
    const period = TICK_MS / rate;
    const fire = (at: number) => {
      tick();
      this.schedule(at + period, () => fire(at + period));
    };
    this.schedule(phaseMs, () => fire(phaseMs));
  }

  /** Run all events up to (and including) time `until`. */
  runUntil(until: number): void {
    for (;;) {
      let best = -1;
      for (let i = 0; i < this.events.length; i++) {
        const e = this.events[i]!;
        if (e.at > until) continue;
        if (best < 0 || e.at < this.events[best]!.at || (e.at === this.events[best]!.at && e.order < this.events[best]!.order)) best = i;
      }
      if (best < 0) break;
      const [event] = this.events.splice(best, 1);
      this.time = event!.at;
      event!.run();
    }
    this.time = until;
  }
}
