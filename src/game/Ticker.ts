// Ticker - fixed-timestep driver for the game screen.
// Calls `step` TICK_RATE times per second and `render` once per display frame.

import { TICK_MS } from './constants';
import { perfCount, perfEnabled, perfEnd, perfSample, perfStart } from './perf';

const MAX_STEPS_PER_WAKE = 10;

export interface TickerOptions {
  /** Keep stepping (without rendering) while the tab is hidden. */
  runInBackground: boolean;
}

export class Ticker {
  private rafId: number | null = null;
  private worker: Worker | null = null;
  private workerUrl: string | null = null;
  private lastTime = 0;
  private accumulator = 0;
  private running = false;

  constructor(
    private readonly step: () => void,
    private readonly render: () => void,
    private readonly options: TickerOptions
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
    document.addEventListener('visibilitychange', this.handleVisibility);
    this.handleVisibility();
  }

  stop(): void {
    this.running = false;
    document.removeEventListener('visibilitychange', this.handleVisibility);
    this.stopRaf();
    this.stopWorker();
  }

  private handleVisibility = (): void => {
    if (!this.running) return;
    if (document.hidden) {
      this.stopRaf();
      if (this.options.runInBackground) this.startWorker();
    } else {
      this.stopWorker();
      // Don't try to catch up on time spent paused
      if (!this.options.runInBackground) {
        this.lastTime = performance.now();
        this.accumulator = 0;
      }
      this.rafId = requestAnimationFrame(this.onRaf);
    }
  };

  private lastRaf = 0;

  private onRaf = (): void => {
    const t0 = perfStart();
    if (perfEnabled()) {
      if (this.lastRaf > 0) perfSample('rafGap', t0 - this.lastRaf);
      this.lastRaf = t0;
    }
    this.advance();
    this.render();
    perfEnd('frame', t0);
    if (this.running && !document.hidden) {
      this.rafId = requestAnimationFrame(this.onRaf);
    }
  };

  private advance(): void {
    const now = performance.now();
    this.accumulator += now - this.lastTime;
    this.lastTime = now;

    let steps = 0;
    while (this.accumulator >= TICK_MS && steps < MAX_STEPS_PER_WAKE) {
      this.accumulator -= TICK_MS;
      this.step();
      steps++;
    }
    perfCount('ticks', steps);
    // Too far behind: resynchronise instead of fast-forwarding
    if (this.accumulator >= TICK_MS) {
      perfCount('droppedTicks', Math.floor(this.accumulator / TICK_MS));
      this.accumulator = 0;
    }
  }

  private stopRaf(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  // Timers in a worker are not throttled when the tab is in the background
  private startWorker(): void {
    if (this.worker) return;
    try {
      const source = `setInterval(() => postMessage(0), ${Math.floor(TICK_MS)});`;
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      this.worker = new Worker(url);
      this.workerUrl = url;
      this.worker.onmessage = () => this.advance();
    } catch (err) {
      console.warn('[Ticker] Background ticking unavailable:', err);
    }
  }

  private stopWorker(): void {
    this.worker?.terminate();
    this.worker = null;
    if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
    this.workerUrl = null;
  }
}
