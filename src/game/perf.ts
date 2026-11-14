// perf - opt-in timing of the game loop phases, for the benchmark harness.
// See design/research/performance.md. Disabled (the default) every call is a null
// check; nothing is allocated and the clock is not read.

export type PerfPhase =
  | 'bots'        // Host: BotController.decide for every bot
  | 'sim'         // Host: TronGameState.tick
  | 'serialize'   // Host: TronGameState.serialize (the frame)
  | 'events'      // View: applying a frame's one-shot events to the renderer / sound
  | 'net'         // Host: wire encoding + broadcast
  | 'decode'      // Guest: decoding a state from the host
  | 'predict'     // Guest: prediction / dead reckoning for the view
  | 'step'        // One whole simulation tick as seen by the game screen
  | 'render'      // TronRenderer.render
  | 'frame'       // One whole requestAnimationFrame callback (steps + render)
  | 'rafGap'      // Time between two requestAnimationFrame callbacks
  | 'workerLag';  // `?worker=1`: age of a frame when it reaches the game screen

export interface PerfDump {
  samples: Record<string, number[]>;   // Milliseconds, in recording order
  counters: Record<string, number>;
}

let samples: Map<string, number[]> | null = null;
let counters: Map<string, number> = new Map();

export function perfEnable(): void {
  samples = new Map();
  counters = new Map();
}

export function perfDisable(): void {
  samples = null;
}

export function perfEnabled(): boolean {
  return samples !== null;
}

/** Start a measurement: the current time, or 0 when disabled. */
export function perfStart(): number {
  return samples ? performance.now() : 0;
}

/** Record the time elapsed since `t0` (from `perfStart`) under `phase`. */
export function perfEnd(phase: PerfPhase, t0: number): void {
  if (samples) perfSample(phase, performance.now() - t0);
}

export function perfSample(phase: PerfPhase, ms: number): void {
  if (!samples) return;
  let list = samples.get(phase);
  if (!list) {
    list = [];
    samples.set(phase, list);
  }
  list.push(ms);
}

export function perfCount(name: string, n = 1): void {
  if (samples) counters.set(name, (counters.get(name) ?? 0) + n);
}

/** Everything recorded so far; with `reset`, start over. */
export function perfDump(reset = true): PerfDump {
  const dump: PerfDump = {
    samples: Object.fromEntries(samples ?? []),
    counters: Object.fromEntries(counters),
  };
  if (reset && samples) perfEnable();
  return dump;
}
