// EXPERIMENTAL (`?worker=1`): the authoritative session (simulation + bots) in a Web
// Worker, ticking on its own clock and posting every frame to the game screen.
// See design/research/performance.md.

import type { SlotIndex } from '../../../types/lobby';
import type { TronGameStateData, TronInput } from '../../../types/game';
import { TICK_MS } from '../../constants';
import { PixelGrid } from '../../PixelGrid';
import { perfCount, perfDump, perfEnable, perfEnd, perfStart } from '../../perf';
import { HostSession } from '../HostSession';
import type { FromWorker, ToWorker } from './protocol';

interface WorkerScope {
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
  postMessage(message: FromWorker): void;
}
const scope = self as unknown as WorkerScope;

const MAX_STEPS_PER_WAKE = 10;

let session: HostSession | null = null;
const inputs = new Map<SlotIndex, TronInput>();
let pending: TronGameStateData[] = [];
let lastTime = 0;
let accumulator = 0;
let paused = false;

function advance(): void {
  if (!session || paused) return;
  const now = performance.now();
  accumulator += now - lastTime;
  lastTime = now;
  let steps = 0;
  while (accumulator >= TICK_MS && steps < MAX_STEPS_PER_WAKE) {
    accumulator -= TICK_MS;
    const t0 = perfStart();
    session.step(inputs);
    perfEnd('step', t0);
    steps++;
  }
  perfCount('ticks', steps);
  if (accumulator >= TICK_MS) {
    perfCount('droppedTicks', Math.floor(accumulator / TICK_MS));
    accumulator = 0;
  }
  if (pending.length > 0) {
    scope.postMessage({ type: 'frames', frames: pending, sentAt: performance.timeOrigin + performance.now() });
    pending = [];
  }
}

scope.onmessage = (event) => {
  const message = event.data;
  switch (message.type) {
    case 'init':
      if (message.perf) perfEnable();
      session = new HostSession(message.config);
      session.onFrame = (frame) => { pending.push(frame); };
      lastTime = performance.now();
      // Timers are clamped to ~4 ms: wake up often and let the accumulator decide
      setInterval(advance, 4);
      break;
    case 'inputs':
      for (const [slot, input] of message.inputs) inputs.set(slot, input);
      break;
    case 'level':
      session?.setLevelObstacles(message.levelIndex, PixelGrid.fromRuns(message.palette, message.runs));
      break;
    case 'pause':
      paused = message.paused;
      lastTime = performance.now();
      accumulator = 0;
      break;
    case 'perf':
      scope.postMessage({ type: 'perf', dump: perfDump() });
      break;
  }
};
