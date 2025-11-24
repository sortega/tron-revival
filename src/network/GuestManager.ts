/**
 * Guest Manager
 * Manages guest-side networking for connecting to host
 */

import type { DataConnection } from 'peerjs';
import { PeerManager } from './PeerManager';
import {
  type HostToGuestMessage,
  type StateMessage,
  type PlayerInfo,
  type RoomInfo,
  createJoinMessage,
  createInputMessage,
  createReadyMessage,
  isHostToGuestMessage,
} from './protocol';

export class GuestManager {
  private peerManager: PeerManager;
  private hostConnection: DataConnection | null = null;
  private localPlayerId: string | null = null;
  private localPlayerNum: number | null = null;
  private roomInfo: RoomInfo | null = null;

  // Callbacks
  private onWelcomeCallback?: (playerId: string, playerNum: number, roomInfo: RoomInfo) => void;
  private onStateUpdateCallback?: (state: StateMessage) => void;
  private onPlayerJoinedCallback?: (player: PlayerInfo) => void;
  private onPlayerLeftCallback?: (playerId: string) => void;
  private onStartGameCallback?: () => void;
  private onErrorCallback?: (code: string, message: string) => void;
  private onDisconnectedCallback?: () => void;

  constructor() {
    this.peerManager = new PeerManager();
  }

  /**
   * Join a room by connecting to host
   */
  async joinRoom(roomId: string, playerName: string): Promise<void> {
    // Initialize peer
    await this.peerManager.initialize();

    // Connect to host
    console.log(`🔌 Connecting to host: ${roomId}...`);
    this.hostConnection = await this.peerManager.connect(roomId);

    // Setup message handler
    this.peerManager.onData(this.hostConnection, (data) => {
      if (isHostToGuestMessage(data)) {
        this.handleHostMessage(data);
      } else {
        console.warn('Invalid message from host:', data);
      }
    });

    // Setup disconnect handler
    this.peerManager.onClose(this.hostConnection, () => {
      console.log('🔌 Disconnected from host');
      if (this.onDisconnectedCallback) {
        this.onDisconnectedCallback();
      }
    });

    // Send join message
    const joinMsg = createJoinMessage(playerName);
    this.hostConnection.send(joinMsg);

    console.log(`✅ Join message sent, waiting for welcome...`);
  }

  /**
   * Handle messages from host
   */
  private handleHostMessage(message: HostToGuestMessage): void {
    switch (message.type) {
      case 'welcome':
        this.localPlayerId = message.playerId;
        this.localPlayerNum = message.playerNum;
        this.roomInfo = message.roomInfo;
        console.log(`✅ Welcomed as Player ${message.playerNum}`);
        if (this.onWelcomeCallback) {
          this.onWelcomeCallback(message.playerId, message.playerNum, message.roomInfo);
        }
        break;

      case 'state':
        if (this.onStateUpdateCallback) {
          this.onStateUpdateCallback(message);
        }
        break;

      case 'start_game':
        console.log(`🎮 Game starting...`);
        if (this.onStartGameCallback) {
          this.onStartGameCallback();
        }
        break;

      case 'player_joined':
        console.log(`👋 ${message.player.name} joined`);
        if (this.onPlayerJoinedCallback) {
          this.onPlayerJoinedCallback(message.player);
        }
        break;

      case 'player_left':
        console.log(`👋 ${message.playerName} left`);
        if (this.onPlayerLeftCallback) {
          this.onPlayerLeftCallback(message.playerId);
        }
        break;

      case 'error':
        console.error(`❌ Error from host: ${message.code} - ${message.message}`);
        if (this.onErrorCallback) {
          this.onErrorCallback(message.code, message.message);
        }
        break;

      case 'event':
        // Handle game events (optional)
        console.log('Game event:', message.eventType, message.data);
        break;
    }
  }

  /**
   * Send input to host
   */
  sendInput(left: boolean, right: boolean, fire: boolean): void {
    if (!this.hostConnection || !this.localPlayerId) {
      return;
    }

    const inputMsg = createInputMessage(this.localPlayerId, left, right, fire);
    this.hostConnection.send(inputMsg);
  }

  /**
   * Send ready status to host
   */
  sendReady(isReady: boolean): void {
    if (!this.hostConnection || !this.localPlayerId) {
      return;
    }

    const readyMsg = createReadyMessage(this.localPlayerId, isReady);
    this.hostConnection.send(readyMsg);
  }

  /**
   * Get local player ID
   */
  getLocalPlayerId(): string | null {
    return this.localPlayerId;
  }

  /**
   * Get local player number
   */
  getLocalPlayerNum(): number | null {
    return this.localPlayerNum;
  }

  /**
   * Get room info
   */
  getRoomInfo(): RoomInfo | null {
    return this.roomInfo;
  }

  /**
   * Set callbacks
   */
  onWelcome(callback: (playerId: string, playerNum: number, roomInfo: RoomInfo) => void): void {
    this.onWelcomeCallback = callback;
  }

  onStateUpdate(callback: (state: StateMessage) => void): void {
    this.onStateUpdateCallback = callback;
  }

  onPlayerJoined(callback: (player: PlayerInfo) => void): void {
    this.onPlayerJoinedCallback = callback;
  }

  onPlayerLeft(callback: (playerId: string) => void): void {
    this.onPlayerLeftCallback = callback;
  }

  onStartGame(callback: () => void): void {
    this.onStartGameCallback = callback;
  }

  onError(callback: (code: string, message: string) => void): void {
    this.onErrorCallback = callback;
  }

  onDisconnected(callback: () => void): void {
    this.onDisconnectedCallback = callback;
  }

  /**
   * Disconnect from host
   */
  disconnect(): void {
    if (this.hostConnection) {
      this.hostConnection.close();
      this.hostConnection = null;
    }
    this.peerManager.destroy();
    this.localPlayerId = null;
    this.localPlayerNum = null;
    this.roomInfo = null;
    console.log('🔌 Guest disconnected');
  }

  /**
   * Destroy guest manager
   */
  destroy(): void {
    this.disconnect();
  }
}
