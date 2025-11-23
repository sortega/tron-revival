/**
 * Game Loop Engine
 * Fixed timestep game loop for consistent physics
 */

import { TICK_INTERVAL } from '../../constants';

export class GameLoop {
  private running = false;
  private lastTime = 0;
  private accumulator = 0;
  private frameId: number | null = null;

  constructor(
    private update: (deltaTime: number) => void,
    private render: () => void
  ) {}

  start(): void {
    if (this.running) return;

    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = 0;

    this.loop(this.lastTime);
  }

  stop(): void {
    this.running = false;
    if (this.frameId !== null) {
      cancelAnimationFrame(this.frameId);
      this.frameId = null;
    }
  }

  private loop = (currentTime: number): void => {
    if (!this.running) return;

    this.frameId = requestAnimationFrame(this.loop);

    // Calculate delta time
    const deltaTime = currentTime - this.lastTime;
    this.lastTime = currentTime;

    // Accumulate time
    this.accumulator += deltaTime;

    // Fixed timestep updates
    while (this.accumulator >= TICK_INTERVAL) {
      this.update(TICK_INTERVAL);
      this.accumulator -= TICK_INTERVAL;
    }

    // Render at display refresh rate
    this.render();
  };
}
