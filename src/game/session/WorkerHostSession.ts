// EXPERIMENTAL (`?worker=1`, local games only): a GameSession whose simulation and bots
// run in a Web Worker. The game screen only forwards inputs and draws the frames it is
// sent, so a slow tick cannot delay a display frame.
// See design/research/performance.md.

import type { SlotIndex } from '../../types/lobby';
import type { GameConfig, TronGameStateData, TronInput } from '../../types/game';
import type { PixelGrid } from '../PixelGrid';
import { perfEnd, perfSample, perfStart } from '../perf';
import type { PerfDump } from '../perf';
import { HostSession } from './HostSession';
import type { GameSession, NetworkStats, ViewState } from './GameSession';
import type { FromWorker, ToWorker } from './worker/protocol';

export class WorkerHostSession implements GameSession {
  onFrame: ((frame: TronGameStateData) => void) | null = null;
  onEnded: ((reason: string) => void) | null = null;
  onSnapshot: ((arena: PixelGrid) => void) | null = null;
  readonly runsInBackground = false;

  private readonly worker: Worker;
  private lastFrame: TronGameStateData | null = null;
  private readonly sent = new Map<SlotIndex, TronInput>();
  private perfWaiters: ((dump: PerfDump) => void)[] = [];

  constructor(config: GameConfig) {
    this.worker = new Worker(new URL('./worker/hostWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<FromWorker>) => this.handle(event.data);
    this.post({ type: 'init', config, perf: new URLSearchParams(location.search).has('perf') });
    document.addEventListener('visibilitychange', this.handleVisibility);
  }

  private post(message: ToWorker): void {
    this.worker.postMessage(message);
  }

  private handleVisibility = (): void => {
    this.post({ type: 'pause', paused: document.hidden });
  };

  private handle(message: FromWorker): void {
    if (message.type === 'perf') {
      for (const resolve of this.perfWaiters) resolve(message.dump);
      this.perfWaiters = [];
      return;
    }
    perfSample('workerLag', performance.timeOrigin + performance.now() - message.sentAt);
    const t0 = perfStart();
    for (const frame of message.frames) {
      this.lastFrame = frame;
      this.onFrame?.(frame);
    }
    perfEnd('events', t0);
  }

  step(localInputs: ReadonlyMap<SlotIndex, TronInput>): void {
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
    return this.lastFrame;
  }

  setLevelObstacles(levelIndex: number, obstacles: PixelGrid): void {
    this.post({ type: 'level', levelIndex, ...obstacles.toRuns() });
  }

  getNetworkStats(): NetworkStats | null {
    return null;
  }

  /** Phase timings recorded inside the worker (benchmark harness). */
  workerPerf(): Promise<PerfDump> {
    return new Promise(resolve => {
      this.perfWaiters.push(resolve);
      this.post({ type: 'perf' });
    });
  }

  destroy(): void {
    document.removeEventListener('visibilitychange', this.handleVisibility);
    this.worker.terminate();
  }
}

/** The session of a local game: in a worker with `?worker=1`, otherwise on this thread. */
export function createLocalSession(config: GameConfig): GameSession {
  if (typeof Worker !== 'undefined' && new URLSearchParams(location.search).get('worker') === '1') {
    return new WorkerHostSession(config);
  }
  return new HostSession(config);
}
