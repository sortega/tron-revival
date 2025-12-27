// GameConnection - Clean wrapper for game-phase networking
// Hides lobby details from the game

import type { LobbyConnection } from './LobbyConnection';
import type { GameInput, PlayerPosition, GameStateMessage } from './protocol';
import type { SlotIndex } from '../types/lobby';

export interface GameConnectionCallbacks {
  onGameState?: (positions: PlayerPosition[]) => void;
  onPlayerInput?: (slotIndex: SlotIndex, input: GameInput) => void;
  onHostDisconnected?: () => void;
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
        this.callbacks.onGameState?.(state.positions);
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

  broadcastPositions(positions: PlayerPosition[]): void {
    this.connection.broadcastGameState(positions);
  }

  sendInput(input: GameInput): void {
    this.connection.sendInput(input);
  }

  disconnect(): void {
    this.connection.disconnect();
  }
}
