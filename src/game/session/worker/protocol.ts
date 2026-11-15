// Messages between the game screen and a simulation running
// in a Web Worker. See design/research/performance.md.

import type { SlotIndex } from '../../../types/lobby';
import type { GameConfig, GamePlayer, TronGameStateData, TronInput, TronInputMessage } from '../../../types/game';
import type { PerfDump, PerfSummary } from '../../perf';

export type ToWorker =
  /** `network`: this is the host of a network game; encoded states come back as `state`. */
  | { type: 'init'; config: GameConfig; perf: boolean; network: boolean; botHumanisation: number;
      /** The room can carry a reduced stream for those who watch; is anybody watching? */
      spectatorStream: boolean; spectators: boolean }
  /** Network host: somebody started watching, or nobody does any more. */
  | { type: 'spectators'; present: boolean }
  /** Network host: who plays from the next round on (design/spectators.md). */
  | { type: 'nextPlayers'; players: GamePlayer[] }
  /** Network host: an input received from a guest. */
  | { type: 'netInput'; slot: SlotIndex; input: TronInputMessage }
  /** Network host: a player joining mid-game needs the game so far. */
  | { type: 'snapshot'; id: number }
  | { type: 'inputs'; inputs: [SlotIndex, TronInput][] }
  | { type: 'level'; levelIndex: number; palette: string[]; runs: number[] }
  | { type: 'pause'; paused: boolean }
  | { type: 'perf' }
  | { type: 'perfSummary' };

export type FromWorker =
  /** The frames simulated since the last message (normally one), oldest first. */
  | { type: 'frames'; frames: TronGameStateData[]; sentAt: number }
  /** Network host: an encoded state to broadcast to the guests. */
  | { type: 'state'; data: Uint8Array }
  /** Network host: a reduced-rate state for the guests who only watch. */
  | { type: 'spectatorState'; data: Uint8Array }
  /** A round started with these players. Sent before the first frame and state of that round. */
  | { type: 'roster'; players: GamePlayer[] }
  | { type: 'snapshot'; id: number; data: Uint8Array }
  | { type: 'perf'; dump: PerfDump }
  /** What the worker's phase timers recorded since the last summary. */
  | { type: 'perfSummary'; summary: PerfSummary; droppedTicks: number };
