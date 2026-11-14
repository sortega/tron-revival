// EXPERIMENTAL (`?worker=1`): messages between the game screen and a simulation running
// in a Web Worker. See design/research/performance.md.

import type { SlotIndex } from '../../../types/lobby';
import type { GameConfig, TronGameStateData, TronInput } from '../../../types/game';
import type { PerfDump, PerfSummary } from '../../perf';

export type ToWorker =
  | { type: 'init'; config: GameConfig; perf: boolean }
  | { type: 'inputs'; inputs: [SlotIndex, TronInput][] }
  | { type: 'level'; levelIndex: number; palette: string[]; runs: number[] }
  | { type: 'pause'; paused: boolean }
  | { type: 'perf' }
  | { type: 'perfSummary' };

export type FromWorker =
  /** The frames simulated since the last message (normally one), oldest first. */
  | { type: 'frames'; frames: TronGameStateData[]; sentAt: number }
  | { type: 'perf'; dump: PerfDump }
  /** What the worker's phase timers recorded since the last summary. */
  | { type: 'perfSummary'; summary: PerfSummary; droppedTicks: number };
