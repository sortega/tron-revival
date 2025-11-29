/**
 * Peer Manager
 * Simplified wrapper around PeerJS based on official examples
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
   * Based on official PeerJS example pattern
   */
  async initialize(customId?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // Minimal config - let PeerJS handle defaults
      const config: any = {
        debug: 2, // Errors and warnings only
      };

      // Add both STUN and TURN servers for better NAT traversal
      // Free TURN servers from Open Relay Project
      config.config = {
        iceServers: [
          // STUN server for discovering public IP
          { urls: 'stun:stun.l.google.com:19302' },
          // Free TURN servers for relaying when direct connection fails
          {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject',
          },
          {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject',
          },
        ],
      };

      // Create peer - let PeerJS connect to cloud server
      console.log('[PeerManager] Creating peer with ID:', customId || 'auto');
      this.peer = customId ? new Peer(customId, config) : new Peer(config);

      // Wait for connection to PeerJS server
      this.peer.on('open', (id) => {
        console.log('[PeerManager] ✅ Peer connected to server with ID:', id);
        resolve(id);
      });

      // Handle disconnection from PeerJS server
      this.peer.on('disconnected', () => {
        console.warn('[PeerManager] ⚠️ Disconnected from PeerJS server');
        // Try to reconnect
        if (this.peer && !this.peer.destroyed) {
          console.log('[PeerManager] Attempting to reconnect...');
          this.peer.reconnect();
        }
      });

      // Handle permanent closure
      this.peer.on('close', () => {
        console.log('[PeerManager] 🔌 Peer connection permanently closed');
      });

      // Handle errors - only reject on fatal errors during initialization
      let initialized = false;
      this.peer.on('error', (error: any) => {
        console.error('[PeerManager] ❌ Peer error:', error.type, error);

        // Only reject promise if we haven't initialized yet
        if (!initialized) {
          if (error.type === 'unavailable-id') {
            reject(new Error('Peer ID already in use'));
          } else if (error.type === 'server-error') {
            reject(new Error('Cannot connect to PeerJS server'));
          } else if (error.type === 'socket-error') {
            reject(new Error('WebSocket connection failed'));
          } else if (error.type === 'socket-closed') {
            reject(new Error('WebSocket connection closed'));
          } else {
            // For other errors during init, reject
            reject(error);
          }
        } else {
          // After initialization, just log errors
          console.error('[PeerManager] Non-fatal error after init:', error.type);
        }
      });

      // Mark as initialized when open
      this.peer.on('open', () => {
        initialized = true;
      });
    });
  }

  /**
   * Listen for incoming connections (host)
   */
  onConnection(handler: ConnectionEventHandler): void {
    if (!this.peer) {
      console.error('[PeerManager] Cannot listen for connections - peer not initialized');
      return;
    }

    console.log('[PeerManager] 📡 Listening for incoming connections...');

    this.peer.on('connection', (conn) => {
      console.log('[PeerManager] 📞 Incoming connection from:', conn.peer);

      // Setup connection handlers
      conn.on('open', () => {
        console.log('[PeerManager] ✅ Connection established with:', conn.peer);
        this.connections.set(conn.peer, conn);
        handler(conn);
      });

      conn.on('close', () => {
        console.log('[PeerManager] 🔌 Connection closed with:', conn.peer);
        this.connections.delete(conn.peer);
      });

      conn.on('error', (err) => {
        console.error('[PeerManager] ❌ Connection error with', conn.peer, ':', err);
        this.connections.delete(conn.peer);
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
      console.log('[PeerManager] 🔌 Connecting to peer:', remotePeerId);

      // Create connection
      const conn = this.peer!.connect(remotePeerId, {
        reliable: true,
        serialization: 'json',
      });

      let isConnected = false;
      const timeout = setTimeout(() => {
        if (!isConnected) {
          console.error('[PeerManager] ⏱️ Connection timeout after 30s');
          conn.close();
          reject(new Error('Connection timeout - peer may not be available'));
        }
      }, 30000);

      // Connection opened successfully
      conn.on('open', () => {
        clearTimeout(timeout);
        isConnected = true;
        console.log('[PeerManager] ✅ Connected to peer:', remotePeerId);
        this.connections.set(remotePeerId, conn);
        resolve(conn);
      });

      // Connection failed
      conn.on('error', (err) => {
        clearTimeout(timeout);
        if (!isConnected) {
          console.error('[PeerManager] ❌ Connection failed:', err);
          reject(err);
        }
      });

      // Connection closed before opening
      conn.on('close', () => {
        clearTimeout(timeout);
        if (!isConnected) {
          console.error('[PeerManager] ❌ Connection closed before opening');
          reject(new Error('Connection closed by remote peer'));
        } else {
          console.log('[PeerManager] 🔌 Connection closed');
          this.connections.delete(remotePeerId);
        }
      });
    });
  }

  /**
   * Send data to a specific connection
   */
  send(peerId: string, data: unknown): boolean {
    const conn = this.connections.get(peerId);
    if (!conn || !conn.open) {
      console.warn('[PeerManager] Cannot send - connection not open:', peerId);
      return false;
    }

    try {
      conn.send(data);
      return true;
    } catch (error) {
      console.error('[PeerManager] Error sending data:', error);
      return false;
    }
  }

  /**
   * Broadcast data to all connections
   */
  broadcast(data: unknown): void {
    let sent = 0;
    for (const [peerId, conn] of this.connections) {
      if (conn.open) {
        try {
          conn.send(data);
          sent++;
        } catch (error) {
          console.error(`[PeerManager] Error broadcasting to ${peerId}:`, error);
        }
      }
    }
    console.log(`[PeerManager] 📡 Broadcast to ${sent} peer(s)`);
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
      console.log('[PeerManager] Connection closed:', conn.peer);
      this.connections.delete(conn.peer);
      handler();
    });
  }

  /**
   * Setup error handler for peer
   */
  onError(handler: ErrorEventHandler): void {
    if (!this.peer) return;
    this.peer.on('error', (error: any) => {
      handler(error);
    });
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
    console.log('[PeerManager] Destroying peer and all connections...');

    // Close all connections
    for (const conn of this.connections.values()) {
      try {
        conn.close();
      } catch (e) {
        // Ignore errors during cleanup
      }
    }
    this.connections.clear();

    // Destroy peer
    if (this.peer) {
      try {
        this.peer.destroy();
      } catch (e) {
        console.error('[PeerManager] Error destroying peer:', e);
      }
      this.peer = null;
    }

    console.log('[PeerManager] ✅ Cleanup complete');
  }
}
