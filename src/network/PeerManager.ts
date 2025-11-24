/**
 * Peer Manager
 * Thin wrapper around PeerJS for connection management
 */

import Peer, { type DataConnection } from 'peerjs';

export type PeerEventHandler = (data: unknown) => void;
export type ConnectionEventHandler = (conn: DataConnection) => void;
export type ErrorEventHandler = (error: Error) => void;

export class PeerManager {
  private peer: Peer | null = null;
  private connections: Map<string, DataConnection> = new Map();

  /**
   * Initialize peer with optional custom ID
   */
  async initialize(customId?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // Create peer with custom ID or let PeerJS generate one
      this.peer = customId ? new Peer(customId) : new Peer();

      this.peer.on('open', (id) => {
        console.log('✅ Peer initialized with ID:', id);
        resolve(id);
      });

      this.peer.on('error', (error) => {
        console.error('❌ Peer error:', error);
        reject(error);
      });
    });
  }

  /**
   * Listen for incoming connections (host)
   */
  onConnection(handler: ConnectionEventHandler): void {
    if (!this.peer) {
      console.error('Peer not initialized');
      return;
    }

    this.peer.on('connection', (conn) => {
      console.log('📞 Incoming connection from:', conn.peer);
      this.connections.set(conn.peer, conn);
      handler(conn);
    });
  }

  /**
   * Connect to a remote peer (guest)
   */
  async connect(remotePeerId: string): Promise<DataConnection> {
    if (!this.peer) {
      throw new Error('Peer not initialized');
    }

    return new Promise((resolve, reject) => {
      const conn = this.peer!.connect(remotePeerId, {
        reliable: true, // Use reliable ordered channel
      });

      conn.on('open', () => {
        console.log('✅ Connected to:', remotePeerId);
        this.connections.set(remotePeerId, conn);
        resolve(conn);
      });

      conn.on('error', (error) => {
        console.error('❌ Connection error:', error);
        reject(error);
      });

      // Timeout after 10 seconds
      setTimeout(() => {
        if (!conn.open) {
          reject(new Error('Connection timeout'));
        }
      }, 10000);
    });
  }

  /**
   * Send data to a specific connection
   */
  send(peerId: string, data: unknown): boolean {
    const conn = this.connections.get(peerId);
    if (!conn || !conn.open) {
      console.warn('Cannot send: connection not open for', peerId);
      return false;
    }

    try {
      conn.send(data);
      return true;
    } catch (error) {
      console.error('Error sending data:', error);
      return false;
    }
  }

  /**
   * Broadcast data to all connections
   */
  broadcast(data: unknown): void {
    for (const [peerId, conn] of this.connections) {
      if (conn.open) {
        try {
          conn.send(data);
        } catch (error) {
          console.error(`Error broadcasting to ${peerId}:`, error);
        }
      }
    }
  }

  /**
   * Setup data handler for a connection
   */
  onData(conn: DataConnection, handler: PeerEventHandler): void {
    conn.on('data', handler);
  }

  /**
   * Setup close handler for a connection
   */
  onClose(conn: DataConnection, handler: () => void): void {
    conn.on('close', () => {
      console.log('🔌 Connection closed:', conn.peer);
      this.connections.delete(conn.peer);
      handler();
    });
  }

  /**
   * Setup error handler for peer
   */
  onError(handler: ErrorEventHandler): void {
    if (!this.peer) return;
    this.peer.on('error', handler);
  }

  /**
   * Get peer ID
   */
  getPeerId(): string | null {
    return this.peer?.id ?? null;
  }

  /**
   * Get all active connections
   */
  getConnections(): Map<string, DataConnection> {
    return this.connections;
  }

  /**
   * Get connection count
   */
  getConnectionCount(): number {
    return this.connections.size;
  }

  /**
   * Disconnect a specific peer
   */
  disconnect(peerId: string): void {
    const conn = this.connections.get(peerId);
    if (conn) {
      conn.close();
      this.connections.delete(peerId);
    }
  }

  /**
   * Disconnect all and destroy peer
   */
  destroy(): void {
    // Close all connections
    for (const conn of this.connections.values()) {
      conn.close();
    }
    this.connections.clear();

    // Destroy peer
    if (this.peer) {
      this.peer.destroy();
      this.peer = null;
    }

    console.log('🔌 Peer destroyed');
  }
}
