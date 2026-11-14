// The authoritative session (simulation + bots) in a Web
// Worker, ticking on its own clock and posting every frame to the game screen.
// As the host of a network game it also encodes the states for the guests; the page only
// relays bytes between this worker and the room. See design/local-and-ai.md.

import type { SlotIndex } from '../../../types/lobby';
import type { TronGameStateData, TronInput } from '../../../types/game';
import { TICK_MS } from '../../constants';
import { PixelGrid } from '../../PixelGrid';
import { perfCount, perfCounter, perfDump, perfEnable, perfEnd, perfSince, perfStart } from '../../perf';
import { HostSession } from '../HostSession';
import type { HostTransport } from '../GameSession';
import type { FromWorker, ToWorker } from './protocol';

interface WorkerScope {
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
  postMessage(message: FromWorker): void;
}
const scope = self as unknown as WorkerScope;

const MAX_STEPS_PER_WAKE = 10;

let session: HostSession | null = null;
// The room lives on the page: states go out and inputs come in as messages
const relay: HostTransport = {
  broadcastState: (data) => scope.postMessage({ type: 'state', data }),
  onInput: null,
  close: () => {},
};
const inputs = new Map<SlotIndex, TronInput>();
let pending: TronGameStateData[] = [];
let lastTime = 0;
let accumulator = 0;
let paused = false;
const summaryCursor = new Map<string, number>();

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
      session = new HostSession(message.config, message.network ? { transport: relay } : {});
      session.onFrame = (frame) => { pending.push(frame); };
      lastTime = performance.now();
      // Timers are clamped to ~4 ms: wake up often and let the accumulator decide
      setInterval(advance, 4);
      break;
    case 'inputs':
      for (const [slot, input] of message.inputs) inputs.set(slot, input);
      break;
    case 'netInput':
      relay.onInput?.(message.slot, message.input);
      break;
    case 'snapshot':
      if (session) scope.postMessage({ type: 'snapshot', id: message.id, data: session.makeSnapshot() });
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
    case 'perfSummary':
      scope.postMessage({ type: 'perfSummary', summary: perfSince(summaryCursor), droppedTicks: perfCounter('droppedTicks') });
      break;
  }
};
