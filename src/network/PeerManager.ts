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
      // Configure ICE servers for NAT traversal
      const config = {
        debug: 3, // Show all debug logs
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
          ],
          iceTransportPolicy: 'all' as const,
          iceCandidatePoolSize: 10,
          bundlePolicy: 'max-bundle' as const,
          rtcpMuxPolicy: 'require' as const,
        },
      };

      // Create peer with custom ID or let PeerJS generate one
      this.peer = customId ? new Peer(customId, config) : new Peer(config);

      this.peer.on('open', (id) => {
        console.log('✅ Peer initialized with ID:', id);
        resolve(id);
      });

      this.peer.on('disconnected', () => {
        console.warn('⚠️ Peer disconnected from server, attempting to reconnect...');
        // Attempt to reconnect
        if (this.peer && !this.peer.destroyed) {
          this.peer.reconnect();
        }
      });

      this.peer.on('close', () => {
        console.log('🔌 Peer connection closed');
      });

      this.peer.on('error', (error) => {
        console.error('❌ Peer error:', error);
        // Don't reject on certain errors, just log them
        if (error.type === 'peer-unavailable') {
          console.error('Peer is not available - they may have disconnected');
        } else if (error.type === 'network') {
          console.error('Network error - check internet connection');
        } else {
          reject(error);
        }
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

      // Wait for connection to open before calling handler
      conn.on('open', () => {
        console.log('✅ Connection opened with:', conn.peer);
        this.connections.set(conn.peer, conn);
        handler(conn);
      });

      conn.on('error', (err) => {
        console.error('Connection error with', conn.peer, ':', err);
      });
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
      console.log('🔌 Attempting to connect to:', remotePeerId);

      const conn = this.peer!.connect(remotePeerId, {
        reliable: true, // Use reliable ordered channel
        serialization: 'json',
      });

      let connected = false;

      // Log connection state changes
      conn.on('iceStateChanged', (state) => {
        console.log('🔌 ICE state:', state);
      });

      conn.on('open', () => {
        connected = true;
        console.log('✅ Connected to:', remotePeerId);
        this.connections.set(remotePeerId, conn);
        resolve(conn);
      });

      conn.on('error', (error) => {
        if (!connected) {
          console.error('❌ Connection error:', error);
          reject(error);
        }
      });

      // Increased timeout for NAT traversal (30 seconds)
      const timeoutId = setTimeout(() => {
        if (!connected) {
          console.error('⏱️ Connection timeout after 30 seconds');
          conn.close();
          reject(new Error('Connection timeout - peer may not exist or network issues'));
        }
      }, 30000);

      // Clear timeout if connected
      conn.on('open', () => {
        clearTimeout(timeoutId);
      });
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
