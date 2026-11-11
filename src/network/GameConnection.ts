// GameConnection - Clean wrapper for game-phase networking
// Hides lobby details from the game

import type { LobbyConnection } from './LobbyConnection';
import type { SlotIndex } from '../types/lobby';
import type { TronGameStateData, TronInput } from '../types/game';

export interface GameConnectionCallbacks {
  onPlayerInput?: (slotIndex: SlotIndex, input: TronInput) => void;
  onHostDisconnected?: () => void;
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
    this.connection.setCallbacks({
      onGameState: (state) => this.callbacks.onTronState?.(state),
      onPlayerInput: (peerId, input) => {
        const slotIndex = this.slotByPeerId.get(peerId);
        if (slotIndex !== undefined) {
          this.callbacks.onPlayerInput?.(slotIndex, input);
        }
      },
      onHostDisconnected: () => this.callbacks.onHostDisconnected?.(),
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

  // Broadcast pre-serialized binary state (MessagePack-encoded TronGameStateData)
  broadcastBinaryState(data: Uint8Array): void {
    this.connection.broadcastBinaryState(data);
  }

  sendInput(input: TronInput): void {
    this.connection.sendInput(input);
  }

  disconnect(): void {
    this.connection.disconnect();
  }
}
