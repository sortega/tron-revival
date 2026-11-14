// A GameSession whose simulation and bots run in a Web Worker: the default for local
// games and for the host of a network game. The game screen only forwards inputs and
// draws the frames it is sent, so a slow tick cannot delay a display frame; for a network
// game the page also relays bytes between the worker and the room.
// `?worker=0` keeps everything on the page's thread, as does a browser where the worker
// cannot start. See design/local-and-ai.md and design/research/performance.md.

import type { SlotIndex } from '../../types/lobby';
import type { GameConfig, TronGameStateData, TronInput } from '../../types/game';
import type { PixelGrid } from '../PixelGrid';
import { perfEnd, perfSample, perfStart } from '../perf';
import type { PerfDump, PerfSummary } from '../perf';
import { HostSession } from './HostSession';
import { ByteRate } from './GameSession';
import type { GameSession, HostTransport, NetworkStats, ViewState } from './GameSession';
import type { FromWorker, ToWorker } from './worker/protocol';

/** A session that can describe the game in progress to a player joining late. */
export interface AuthoritativeSession extends GameSession {
  makeSnapshot(): Uint8Array | Promise<Uint8Array>;
}

export class WorkerHostSession implements AuthoritativeSession {
  onFrame: ((frame: TronGameStateData) => void) | null = null;
  onEnded: ((reason: string) => void) | null = null;
  onSnapshot: ((arena: PixelGrid) => void) | null = null;

  private worker: Worker | null;
  /** Set if the worker could not start: the game then runs on this thread. */
  private fallback: HostSession | null = null;
  private lastFrame: TronGameStateData | null = null;
  private framesReceived = 0;
  private readonly sent = new Map<SlotIndex, TronInput>();
  private level: { levelIndex: number; obstacles: PixelGrid } | null = null;
  private readonly bytesOut = new ByteRate();
  private snapshotId = 0;
  private readonly snapshotWaiters = new Map<number, (data: Uint8Array) => void>();
  private perfWaiters: ((dump: PerfDump) => void)[] = [];
  private summaryWaiters: ((result: { summary: PerfSummary; droppedTicks: number }) => void)[] = [];

  constructor(private readonly config: GameConfig, private readonly transport: HostTransport | null = null) {
    this.worker = new Worker(new URL('./worker/hostWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<FromWorker>) => this.handle(event.data);
    this.worker.onerror = (event) => this.fallBack(event.message);
    this.post({
      type: 'init',
      config,
      perf: new URLSearchParams(location.search).has('perf'),
      network: transport !== null,
    });
    if (transport) {
      transport.onInput = (slot, input) => this.post({ type: 'netInput', slot, input });
    } else {
      // A local game pauses while hidden; a network game must go on for the guests
      document.addEventListener('visibilitychange', this.handleVisibility);
    }
  }

  /** The ticker keeps waking a hidden page for a network game (needed after a fallback). */
  get runsInBackground(): boolean {
    return this.transport !== null;
  }

  private post(message: ToWorker): void {
    this.worker?.postMessage(message);
  }

  private handleVisibility = (): void => {
    this.post({ type: 'pause', paused: document.hidden });
  };

  // The worker failed. Before its first frame we can still start over on this thread;
  // later there is no game state to continue from.
  private fallBack(reason: string): void {
    if (this.fallback || !this.worker) return;
    console.warn('[worker] simulation worker failed:', reason);
    this.worker.terminate();
    this.worker = null;
    document.removeEventListener('visibilitychange', this.handleVisibility);
    if (this.framesReceived > 0) {
      this.onEnded?.('The game stopped unexpectedly.');
      return;
    }
    const fallback = new HostSession(this.config, this.transport ? { transport: this.transport } : {});
    fallback.onFrame = (frame) => this.onFrame?.(frame);
    if (this.level) fallback.setLevelObstacles(this.level.levelIndex, this.level.obstacles);
    this.fallback = fallback;
    for (const resolve of this.snapshotWaiters.values()) resolve(fallback.makeSnapshot());
    this.snapshotWaiters.clear();
  }

  private handle(message: FromWorker): void {
    switch (message.type) {
      case 'state':
        this.bytesOut.add(message.data.length, performance.now());
        this.transport?.broadcastState(message.data);
        return;
      case 'snapshot':
        this.snapshotWaiters.get(message.id)?.(message.data);
        this.snapshotWaiters.delete(message.id);
        return;
      case 'perf':
        for (const resolve of this.perfWaiters) resolve(message.dump);
        this.perfWaiters = [];
        return;
      case 'perfSummary':
        for (const resolve of this.summaryWaiters) resolve(message);
        this.summaryWaiters = [];
        return;
      case 'frames': {
        perfSample('workerLag', performance.timeOrigin + performance.now() - message.sentAt);
        const t0 = perfStart();
        for (const frame of message.frames) {
          this.framesReceived++;
          this.lastFrame = frame;
          this.onFrame?.(frame);
        }
        perfEnd('events', t0);
      }
    }
  }

  step(localInputs: ReadonlyMap<SlotIndex, TronInput>): void {
    if (this.fallback) {
      this.fallback.step(localInputs);
      return;
    }
    // Only what changed crosses to the worker
    const changed: [SlotIndex, TronInput][] = [];
    for (const [slot, input] of localInputs) {
      const last = this.sent.get(slot);
      if (!last || last.steer !== input.steer || last.action !== input.action) {
        const copy = { steer: input.steer, action: input.action };
        this.sent.set(slot, copy);
        changed.push([slot, copy]);
      }
    }
    if (changed.length > 0) this.post({ type: 'inputs', inputs: changed });
  }

  getViewState(): ViewState | null {
    return this.fallback ? this.fallback.getViewState() : this.lastFrame;
  }

  setLevelObstacles(levelIndex: number, obstacles: PixelGrid): void {
    this.level = { levelIndex, obstacles };
    if (this.fallback) this.fallback.setLevelObstacles(levelIndex, obstacles);
    else this.post({ type: 'level', levelIndex, ...obstacles.toRuns() });
  }

  getNetworkStats(): NetworkStats | null {
    if (this.fallback) return this.fallback.getNetworkStats();
    if (!this.transport) return null;
    return { lagMs: 0, bytesIn: 0, bytesOut: this.bytesOut.perSecond(performance.now()) };
  }

  /** The game in progress, for a player joining mid-game. */
  makeSnapshot(): Uint8Array | Promise<Uint8Array> {
    if (this.fallback) return this.fallback.makeSnapshot();
    return new Promise(resolve => {
      const id = this.snapshotId++;
      this.snapshotWaiters.set(id, resolve);
      this.post({ type: 'snapshot', id });
    });
  }

  /** True while the simulation is in the worker (false after falling back). */
  get inWorker(): boolean {
    return this.worker !== null;
  }

  /** Phase timings recorded inside the worker (benchmark harness). */
  workerPerf(): Promise<PerfDump> {
    return new Promise(resolve => {
      this.perfWaiters.push(resolve);
      this.post({ type: 'perf' });
    });
  }

  /** What the worker's phase timers recorded since the last call (live readout). */
  workerSummary(): Promise<{ summary: PerfSummary; droppedTicks: number }> {
    return new Promise(resolve => {
      this.summaryWaiters.push(resolve);
      this.post({ type: 'perfSummary' });
    });
  }

  destroy(): void {
    document.removeEventListener('visibilitychange', this.handleVisibility);
    this.worker?.terminate();
    this.worker = null;
    // After a fallback the in-thread session owns (and closes) the transport
    if (this.fallback) this.fallback.destroy();
    else this.transport?.close();
  }
}

/**
 * The authoritative session of a local game, or of a network game when `transport` is
 * given: in a worker unless `?worker=0` or workers are unavailable.
 */
export function createHostSession(config: GameConfig, transport: HostTransport | null = null): AuthoritativeSession {
  const off = new URLSearchParams(location.search).get('worker') === '0';
  if (!off && typeof Worker !== 'undefined') {
    try {
      return new WorkerHostSession(config, transport);
    } catch (err) {
      console.warn('[worker] cannot start the simulation worker:', err);
    }
  }
  return new HostSession(config, transport ? { transport } : {});
}
