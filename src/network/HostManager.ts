/**
 * Host Manager
 * Manages host-side networking for the authoritative game server
 */

import type { DataConnection } from 'peerjs';
import { PeerManager } from './PeerManager';
import {
  type GuestToHostMessage,
  type PlayerInfo,
  type RoomInfo,
  type StateMessage,
  type WelcomeMessage,
  type PlayerJoinedMessage,
  type PlayerLeftMessage,
  createErrorMessage,
  isGuestToHostMessage,
} from './protocol';
import { PLAYER_COLORS } from '../constants';

const MAX_PLAYERS = 4;

interface ConnectedGuest {
  peerId: string;
  connection: DataConnection;
  playerInfo: PlayerInfo;
}

export class HostManager {
  private peerManager: PeerManager;
  private guests: Map<string, ConnectedGuest> = new Map();
  private roomId: string | null = null;
  private nextPlayerNum = 1; // Host is 0

  // Callbacks
  private onGuestJoinedCallback?: (playerInfo: PlayerInfo) => void;
  private onGuestLeftCallback?: (playerId: string) => void;
  private onGuestInputCallback?: (playerId: string, left: boolean, right: boolean, fire: boolean) => void;
  private onGuestReadyCallback?: (playerId: string, isReady: boolean) => void;

  constructor() {
    this.peerManager = new PeerManager();
  }

  /**
   * Initialize as host and create room
   */
  async createRoom(): Promise<string> {
    // Initialize peer (PeerJS will generate random ID)
    this.roomId = await this.peerManager.initialize();

    // Listen for incoming connections
    this.peerManager.onConnection((conn) => this.handleGuestConnection(conn));

    // Setup error handler
    this.peerManager.onError((error) => {
      console.error('Host peer error:', error);
    });

    console.log(`🎮 Room created with ID: ${this.roomId}`);
    return this.roomId;
  }

  /**
   * Handle incoming guest connection
   */
  private handleGuestConnection(conn: DataConnection): void {
    const peerId = conn.peer;

    // Check if room is full
    if (this.guests.size >= MAX_PLAYERS - 1) {
      console.log(`❌ Room full, rejecting ${peerId}`);
      conn.send(createErrorMessage('ROOM_FULL', 'Room is full (max 4 players)'));
      setTimeout(() => conn.close(), 100);
      return;
    }

    // Setup connection handlers
    this.peerManager.onData(conn, (data) => {
      if (isGuestToHostMessage(data)) {
        this.handleGuestMessage(peerId, data);
      } else {
        console.warn('Invalid message from guest:', data);
      }
    });

    this.peerManager.onClose(conn, () => {
      this.handleGuestDisconnection(peerId);
    });

    console.log(`✅ Guest ${peerId} connected, waiting for join message...`);
  }

  /**
   * Handle messages from guests
   */
  private handleGuestMessage(peerId: string, message: GuestToHostMessage): void {
    switch (message.type) {
      case 'join':
        this.handleJoinMessage(peerId, message.playerName);
        break;

      case 'input':
        if (this.onGuestInputCallback) {
          this.onGuestInputCallback(
            message.playerId,
            message.left,
            message.right,
            message.fire
          );
        }
        break;

      case 'ready':
        if (this.onGuestReadyCallback) {
          this.onGuestReadyCallback(message.playerId, message.isReady);
        }
        break;

      case 'chat':
        console.log(`💬 ${message.playerId}: ${message.message}`);
        break;
    }
  }

  /**
   * Handle guest join message
   */
  private handleJoinMessage(peerId: string, playerName: string): void {
    // Assign player number and color
    const playerNum = this.nextPlayerNum++;
    const colors = [PLAYER_COLORS.RED, PLAYER_COLORS.GREEN, PLAYER_COLORS.BLUE, PLAYER_COLORS.YELLOW];
    const color = colors[playerNum] || PLAYER_COLORS.RED;

    // Create player info
    const playerInfo: PlayerInfo = {
      id: peerId,
      name: playerName,
      num: playerNum,
      color,
      isReady: false,
    };

    // Store guest
    const conn = this.peerManager.getConnections().get(peerId);
    if (!conn) {
      console.error('Connection not found for:', peerId);
      return;
    }

    this.guests.set(peerId, {
      peerId,
      connection: conn,
      playerInfo,
    });

    // Send welcome message
    const welcomeMsg: WelcomeMessage = {
      type: 'welcome',
      playerId: peerId,
      playerNum,
      color,
      roomInfo: this.getRoomInfo(),
    };
    this.peerManager.send(peerId, welcomeMsg);

    // Notify all other guests about new player
    const joinedMsg: PlayerJoinedMessage = {
      type: 'player_joined',
      player: playerInfo,
    };
    this.broadcastToGuests(joinedMsg);

    // Notify callback
    if (this.onGuestJoinedCallback) {
      this.onGuestJoinedCallback(playerInfo);
    }

    console.log(`✅ Guest ${playerName} (${peerId}) joined as Player ${playerNum}`);
  }

  /**
   * Handle guest disconnection
   */
  private handleGuestDisconnection(peerId: string): void {
    const guest = this.guests.get(peerId);
    if (!guest) return;

    // Remove from guests map
    this.guests.delete(peerId);

    // Notify other guests
    const leftMsg: PlayerLeftMessage = {
      type: 'player_left',
      playerId: peerId,
      playerName: guest.playerInfo.name,
    };
    this.broadcastToGuests(leftMsg);

    // Notify callback
    if (this.onGuestLeftCallback) {
      this.onGuestLeftCallback(peerId);
    }

    console.log(`👋 Guest ${guest.playerInfo.name} disconnected`);
  }

  /**
   * Get room info
   */
  private getRoomInfo(): RoomInfo {
    return {
      roomId: this.roomId || '',
      hostId: this.peerManager.getPeerId() || '',
      players: Array.from(this.guests.values()).map((g) => g.playerInfo),
    };
  }

  /**
   * Broadcast game state to all guests
   */
  broadcastGameState(state: StateMessage): void {
    this.broadcastToGuests(state);
  }

  /**
   * Broadcast message to all guests
   */
  private broadcastToGuests(message: unknown): void {
    this.peerManager.broadcast(message);
  }

  /**
   * Get connected guest count
   */
  getGuestCount(): number {
    return this.guests.size;
  }

  /**
   * Get all guest player info
   */
  getGuestPlayerInfo(): PlayerInfo[] {
    return Array.from(this.guests.values()).map((g) => g.playerInfo);
  }

  /**
   * Set callbacks
   */
  onGuestJoined(callback: (playerInfo: PlayerInfo) => void): void {
    this.onGuestJoinedCallback = callback;
  }

  onGuestLeft(callback: (playerId: string) => void): void {
    this.onGuestLeftCallback = callback;
  }

  onGuestInput(callback: (playerId: string, left: boolean, right: boolean, fire: boolean) => void): void {
    this.onGuestInputCallback = callback;
  }

  onGuestReady(callback: (playerId: string, isReady: boolean) => void): void {
    this.onGuestReadyCallback = callback;
  }

  /**
   * Get room ID
   */
  getRoomId(): string | null {
    return this.roomId;
  }

  /**
   * Destroy host and disconnect all guests
   */
  destroy(): void {
    this.guests.clear();
    this.peerManager.destroy();
    this.roomId = null;
    this.nextPlayerNum = 1;
    console.log('🔌 Host destroyed');
  }
}
