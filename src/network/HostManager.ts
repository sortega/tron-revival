/**
 * Host Manager
 * Manages host-side networking for the authoritative game server
 * Now using Trystero for serverless P2P!
 */

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
    // Generate a random room ID
    this.roomId = this.generateRoomId();

    // Initialize peer manager and join room
    await this.peerManager.initialize(this.roomId);

    // Listen for incoming connections
    this.peerManager.onConnection((peerId) => this.handleGuestConnection(peerId));

    console.log(`🎮 Room created with ID: ${this.roomId}`);
    return this.roomId;
  }

  /**
   * Handle incoming guest connection
   */
  private handleGuestConnection(peerId: string): void {
    console.log(`[HostManager] 📞 Peer joined room: ${peerId}`);

    // Check if room is full
    if (this.guests.size >= MAX_PLAYERS - 1) {
      console.log(`[HostManager] ❌ Room full (${this.guests.size}/${MAX_PLAYERS - 1}), rejecting ${peerId}`);
      this.peerManager.send(peerId, createErrorMessage('ROOM_FULL', 'Room is full (max 4 players)'));
      return;
    }

    console.log(`[HostManager] Room has space (${this.guests.size}/${MAX_PLAYERS - 1})`);

    // Setup data handler for this peer
    this.peerManager.onData(peerId, (data) => {
      console.log(`[HostManager] Received data from ${peerId}:`, data);
      if (isGuestToHostMessage(data)) {
        this.handleGuestMessage(peerId, data);
      } else {
        console.warn(`[HostManager] Invalid message from guest ${peerId}:`, data);
      }
    });

    console.log(`[HostManager] ✅ Guest ${peerId} connected, waiting for join message...`);
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
    }
  }

  /**
   * Handle guest join message
   */
  private handleJoinMessage(peerId: string, playerName: string): void {
    console.log(`[HostManager] Processing join request from ${peerId} with name: ${playerName}`);

    // Assign player number and color
    const playerNum = this.nextPlayerNum++;
    const colors = [PLAYER_COLORS.RED, PLAYER_COLORS.GREEN, PLAYER_COLORS.BLUE, PLAYER_COLORS.YELLOW];
    const color = colors[playerNum] || PLAYER_COLORS.RED;
    console.log(`[HostManager] Assigned player number ${playerNum} with color:`, color);

    // Create player info
    const playerInfo: PlayerInfo = {
      id: peerId,
      name: playerName,
      num: playerNum,
      color,
      isReady: false,
    };

    // Store guest
    this.guests.set(peerId, {
      peerId,
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
   * Generate a random room ID
   */
  private generateRoomId(): string {
    // Generate a short, readable room code
    const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
    let roomId = '';
    for (let i = 0; i < 8; i++) {
      roomId += chars[Math.floor(Math.random() * chars.length)];
    }
    return roomId;
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
