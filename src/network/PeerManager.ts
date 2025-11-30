/**
 * Peer Manager - Trystero Implementation
 * Uses Trystero for serverless WebRTC P2P connections
 * No dependency on external signaling servers!
 */

import { joinRoom, Room } from 'trystero';

export type PeerEventHandler = (data: unknown) => void;
export type ConnectionEventHandler = (peerId: string) => void;
export type ErrorEventHandler = (error: Error) => void;

interface PeerConnection {
  peerId: string;
  open: boolean;
}

export class PeerManager {
  private room: Room | null = null;
  private roomId: string | null = null;
  private myPeerId: string | null = null;
  private connections: Map<string, PeerConnection> = new Map();
  private onConnectionHandler: ConnectionEventHandler | null = null;
  private dataHandlers: Map<string, PeerEventHandler> = new Map();

  // Trystero actions
  private sendDataAction: ((data: unknown, peerId: string) => void) | null = null;
  private receiveDataAction: ((handler: (data: unknown, peerId: string) => void) => void) | null = null;

  /**
   * Initialize peer and join a room
   */
  async initialize(roomId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        console.log('[PeerManager] Joining room:', roomId);

        this.roomId = roomId;

        // Join room using BitTorrent strategy (most reliable, no external deps)
        this.room = joinRoom(
          {
            appId: 'tron-revival', // Unique app identifier
          },
          roomId
        );

        // Generate our peer ID (Trystero doesn't provide one, so we create it)
        this.myPeerId = this.generatePeerId();
        console.log('[PeerManager] ✅ My peer ID:', this.myPeerId);

        // Setup data channel for game messages
        const [sendData, receiveData] = this.room.makeAction('gameData');
        this.sendDataAction = sendData;
        this.receiveDataAction = receiveData;

        // Setup data receiver
        receiveData((data, peerId) => {
          console.log('[PeerManager] 📨 Data from', peerId, ':', data);
          const handler = this.dataHandlers.get(peerId);
          if (handler) {
            handler(data);
          }
        });

        // Listen for peers joining
        this.room.onPeerJoin((peerId) => {
          console.log('[PeerManager] 👋 Peer joined:', peerId);

          const connection: PeerConnection = {
            peerId,
            open: true,
          };
          this.connections.set(peerId, connection);

          // Notify connection handler
          if (this.onConnectionHandler) {
            this.onConnectionHandler(peerId);
          }
        });

        // Listen for peers leaving
        this.room.onPeerLeave((peerId) => {
          console.log('[PeerManager] 👋 Peer left:', peerId);
          this.connections.delete(peerId);
          this.dataHandlers.delete(peerId);
        });

        console.log('[PeerManager] ✅ Room joined successfully');
        resolve(this.myPeerId);
      } catch (error) {
        console.error('[PeerManager] ❌ Failed to join room:', error);
        reject(error);
      }
    });
  }

  /**
   * Listen for incoming connections (peers joining room)
   */
  onConnection(handler: ConnectionEventHandler): void {
    console.log('[PeerManager] 📡 Listening for connections...');
    this.onConnectionHandler = handler;

    // Call handler for existing connections
    for (const [peerId] of this.connections) {
      handler(peerId);
    }
  }

  /**
   * Setup data handler for a specific peer
   */
  onData(peerId: string, handler: PeerEventHandler): void {
    this.dataHandlers.set(peerId, handler);
  }

  /**
   * Send data to a specific peer
   */
  send(peerId: string, data: unknown): boolean {
    if (!this.sendDataAction) {
      console.warn('[PeerManager] Cannot send - not initialized');
      return false;
    }

    const conn = this.connections.get(peerId);
    if (!conn || !conn.open) {
      console.warn('[PeerManager] Cannot send - peer not connected:', peerId);
      return false;
    }

    try {
      this.sendDataAction(data, peerId);
      return true;
    } catch (error) {
      console.error('[PeerManager] Error sending data:', error);
      return false;
    }
  }

  /**
   * Broadcast data to all connected peers
   */
  broadcast(data: unknown): void {
    if (!this.sendDataAction) {
      console.warn('[PeerManager] Cannot broadcast - not initialized');
      return;
    }

    let sent = 0;
    for (const [peerId, conn] of this.connections) {
      if (conn.open) {
        try {
          this.sendDataAction(data, peerId);
          sent++;
        } catch (error) {
          console.error(`[PeerManager] Error broadcasting to ${peerId}:`, error);
        }
      }
    }
    console.log(`[PeerManager] 📡 Broadcast to ${sent} peer(s)`);
  }

  /**
   * Get our peer ID
   */
  getPeerId(): string | null {
    return this.myPeerId;
  }

  /**
   * Get all connected peer IDs
   */
  getConnections(): Map<string, PeerConnection> {
    return this.connections;
  }

  /**
   * Get connection count
   */
  getConnectionCount(): number {
    return this.connections.size;
  }

  /**
   * Get room ID
   */
  getRoomId(): string | null {
    return this.roomId;
  }

  /**
   * Disconnect from room
   */
  destroy(): void {
    console.log('[PeerManager] Destroying peer and leaving room...');

    if (this.room) {
      this.room.leave();
      this.room = null;
    }

    this.connections.clear();
    this.dataHandlers.clear();
    this.onConnectionHandler = null;
    this.sendDataAction = null;
    this.receiveDataAction = null;

    console.log('[PeerManager] ✅ Cleanup complete');
  }

  /**
   * Generate a random peer ID
   */
  private generatePeerId(): string {
    return `peer-${Math.random().toString(36).substring(2, 11)}`;
  }
}
