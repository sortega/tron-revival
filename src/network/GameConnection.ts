// GameConnection - game-phase view of the lobby connection.
// Implements the transports used by HostSession and GuestSession.

import type { LobbyConnection } from './LobbyConnection';
import type { SlotIndex } from '../types/lobby';
import type { TronInputMessage } from '../types/game';
import type { GuestTransport, HostTransport } from '../game/session/GameSession';

export class GameConnection implements HostTransport, GuestTransport {
  onInput: ((slot: SlotIndex, input: TronInputMessage) => void) | null = null;
  onState: ((data: Uint8Array) => void) | null = null;
  onHostDisconnected: (() => void) | null = null;

  constructor(
    private readonly connection: LobbyConnection,
    private readonly slotByPeerId: Map<string, SlotIndex>
  ) {
    this.connection.setCallbacks({
      onGameState: (data) => this.onState?.(data),
      onPlayerInput: (peerId, input) => {
        const slotIndex = this.slotByPeerId.get(peerId);
        if (slotIndex !== undefined) {
          this.onInput?.(slotIndex, input);
        }
      },
      onHostDisconnected: () => this.onHostDisconnected?.(),
    });
  }

  broadcastState(data: Uint8Array): void {
    this.connection.broadcastBinaryState(data);
  }

  sendInput(input: TronInputMessage): void {
    this.connection.sendInput(input);
  }

  close(): void {
    this.connection.disconnect();
  }
}
