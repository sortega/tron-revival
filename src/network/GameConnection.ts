// GameConnection - Clean wrapper for game-phase networking
// Hides lobby details from the game

import type { LobbyConnection } from './LobbyConnection';
import type { GameInput, PlayerPosition, GameStateMessage } from './protocol';
import type { SlotIndex } from '../types/lobby';
import type { TronGameStateData, TronInput } from '../types/game';

export interface GameConnectionCallbacks {
  onGameState?: (positions: PlayerPosition[]) => void;
  onPlayerInput?: (slotIndex: SlotIndex, input: GameInput | TronInput) => void;
  onHostDisconnected?: () => void;
  // Tron-specific callbacks
  onTronState?: (state: TronGameStateData) => void;
}

export class GameConnection {
  private connection: LobbyConnection;
  private callbacks: GameConnectionCallbacks = {};
  private slotByPeerId: Map<string, SlotIndex>;
  private mySlotIndex: SlotIndex | null;

  constructor(
    connection: LobbyConnection,
    slotByPeerId: Map<string, SlotIndex>,
    mySlotIndex: SlotIndex | null
  ) {
    this.connection = connection;
    this.slotByPeerId = slotByPeerId;
    this.mySlotIndex = mySlotIndex;
    this.setupCallbacks();
  }

  private setupCallbacks(): void {
    this.connection.setCallbacks({
      onGameState: (state: GameStateMessage) => {
        // Check if this is Tron state (from binary channel) or legacy positions array
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const anyPositions = state.positions as any;
        if (anyPositions?.round && anyPositions?.match) {
          // Tron state from binary MessagePack channel
          this.callbacks.onTronState?.(anyPositions as TronGameStateData);
        } else if (Array.isArray(state.positions)) {
          // Legacy placeholder game format - positions is actually an array
          this.callbacks.onGameState?.(state.positions);
        }
      },
      onPlayerInput: (peerId: string, input: GameInput) => {
        const slotIndex = this.slotByPeerId.get(peerId);
        if (slotIndex !== undefined) {
          this.callbacks.onPlayerInput?.(slotIndex, input);
        }
      },
      onHostDisconnected: () => {
        this.callbacks.onHostDisconnected?.();
      },
    });
  }

  setCallbacks(callbacks: GameConnectionCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  isHost(): boolean {
    return this.connection.isHostMode();
  }

  getMySlotIndex(): SlotIndex | null {
    return this.mySlotIndex;
  }

  // Legacy method for placeholder game
  broadcastPositions(positions: PlayerPosition[]): void {
    this.connection.broadcastGameState(positions);
  }

  // Broadcast pre-serialized binary state (MessagePack-encoded TronGameStateData)
  broadcastBinaryState(data: Uint8Array): void {
    this.connection.broadcastBinaryState(data);
  }

  sendInput(input: GameInput | TronInput): void {
    this.connection.sendInput(input as GameInput);
  }

  disconnect(): void {
    this.connection.disconnect();
  }
}
