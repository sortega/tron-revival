import { joinRoom as joinNostr, Room } from 'trystero/nostr';
import { joinRoom as joinTorrent } from 'trystero/torrent';
import { joinRoom as joinMqtt } from 'trystero/mqtt';
import { nanoid } from 'nanoid';

const APP_ID = 'teratron-test';

type Strategy = 'nostr' | 'torrent' | 'mqtt';

// Free public Nostr relays (as of 2024-2025)
const NOSTR_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.snort.social',
  'wss://relay.nostr.band',
];

// Free TURN servers for testing (from Open Relay Project)
const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
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
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

interface LogEntry {
  time: string;
  type: 'info' | 'success' | 'error' | 'message';
  text: string;
}

export class ConnectionTest {
  private container: HTMLElement;
  private room: Room | null = null;
  private roomId: string | null = null;
  private strategy: Strategy = 'mqtt';
  private logs: LogEntry[] = [];
  private peers: Set<string> = new Set();
  private sendMessage: ((msg: string, target?: string) => void) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  render(): void {
    // Check for room ID in URL
    const urlParams = new URLSearchParams(window.location.search);
    const roomFromUrl = urlParams.get('room');

    this.container.innerHTML = `
      <h1>Teratron P2P Test</h1>
      <p style="color: #888; margin-bottom: 1rem;">Test peer-to-peer connectivity before building the game</p>

      <div style="margin-bottom: 1rem;">
        <label style="color: #888;">Signaling strategy: </label>
        <select id="strategySelect" style="padding: 0.25rem;">
          <option value="mqtt" selected>MQTT (public brokers) - most reliable</option>
          <option value="torrent">BitTorrent (WebTorrent trackers)</option>
          <option value="nostr">Nostr (decentralized relays)</option>
        </select>
        <span style="color: #666; font-size: 0.8rem; margin-left: 0.5rem;">
          Both peers must use the same strategy!
        </span>
      </div>

      <div style="display: flex; gap: 1rem; margin-bottom: 1rem; flex-wrap: wrap; align-items: center;">
        <button id="createRoom" style="padding: 0.5rem 1rem; cursor: pointer;">
          Create Room
        </button>
        <span style="color: #888;">or</span>
        <input
          id="roomInput"
          type="text"
          placeholder="Enter room code"
          value="${roomFromUrl || ''}"
          style="padding: 0.5rem; width: 200px;"
        />
        <button id="joinRoom" style="padding: 0.5rem 1rem; cursor: pointer;">
          Join Room
        </button>
      </div>

      <div id="roomInfo" style="display: none; margin-bottom: 1rem; padding: 1rem; background: #222; border-radius: 4px;">
        <div>Room: <code id="roomCode" style="color: #0f0;"></code></div>
        <div style="margin-top: 0.5rem;">
          <button id="copyLink" style="padding: 0.25rem 0.5rem; cursor: pointer;">
            Copy Link
          </button>
          <span id="copyStatus" style="color: #0f0; margin-left: 0.5rem;"></span>
        </div>
        <div style="margin-top: 0.5rem;">
          Peers connected: <span id="peerCount">0</span>
        </div>
      </div>

      <div id="messageSection" style="display: none; margin-bottom: 1rem;">
        <input
          id="messageInput"
          type="text"
          placeholder="Type a message..."
          style="padding: 0.5rem; width: 300px;"
        />
        <button id="sendMessage" style="padding: 0.5rem 1rem; cursor: pointer;">
          Send
        </button>
      </div>

      <div id="disconnectSection" style="display: none; margin-bottom: 1rem;">
        <button id="disconnect" style="padding: 0.5rem 1rem; cursor: pointer; background: #a00; color: white; border: none;">
          Disconnect
        </button>
      </div>

      <div style="width: 100%; max-width: 600px;">
        <h3 style="margin-bottom: 0.5rem;">Connection Log</h3>
        <div
          id="log"
          style="background: #111; padding: 1rem; border-radius: 4px; height: 300px; overflow-y: auto; font-size: 0.9rem;"
        ></div>
      </div>
    `;

    this.setupEventListeners();

    // Auto-join if room ID in URL
    if (roomFromUrl) {
      this.log('info', `Room code found in URL: ${roomFromUrl}`);
      this.joinRoom(roomFromUrl);
    }
  }

  private setupEventListeners(): void {
    document.getElementById('strategySelect')?.addEventListener('change', (e) => {
      this.strategy = (e.target as HTMLSelectElement).value as Strategy;
      this.log('info', `Strategy changed to: ${this.strategy}`);
    });

    document.getElementById('createRoom')?.addEventListener('click', () => {
      this.createRoom();
    });

    document.getElementById('joinRoom')?.addEventListener('click', () => {
      const input = document.getElementById('roomInput') as HTMLInputElement;
      const roomId = this.extractRoomId(input.value.trim());
      if (roomId) {
        this.joinRoom(roomId);
      } else {
        this.log('error', 'Please enter a valid room code or link');
      }
    });

    document.getElementById('copyLink')?.addEventListener('click', () => {
      if (this.roomId) {
        const link = `${window.location.origin}${window.location.pathname}?room=${this.roomId}`;
        navigator.clipboard.writeText(link).then(() => {
          const status = document.getElementById('copyStatus');
          if (status) {
            status.textContent = 'Copied!';
            setTimeout(() => { status.textContent = ''; }, 2000);
          }
        });
      }
    });

    document.getElementById('sendMessage')?.addEventListener('click', () => {
      this.sendChatMessage();
    });

    document.getElementById('messageInput')?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        this.sendChatMessage();
      }
    });

    document.getElementById('disconnect')?.addEventListener('click', () => {
      this.disconnect();
    });
  }

  private extractRoomId(input: string): string | null {
    // If it's a URL, extract the room parameter
    if (input.includes('?room=')) {
      const url = new URL(input.startsWith('http') ? input : `https://example.com${input}`);
      return url.searchParams.get('room');
    }
    // Otherwise treat it as a room ID
    return input || null;
  }

  private createRoom(): void {
    const roomId = nanoid(10);
    this.log('info', `Creating room: ${roomId}`);
    this.joinRoom(roomId);
  }

  private joinRoom(roomId: string): void {
    if (this.room) {
      this.disconnect();
    }

    this.roomId = roomId;
    this.log('info', `Joining room: ${roomId}`);
    const strategyNames = {
      mqtt: 'MQTT brokers',
      torrent: 'BitTorrent trackers',
      nostr: 'Nostr relays',
    };
    this.log('info', `Using ${strategyNames[this.strategy]} for signaling...`);

    try {
      const rtcConfig = { iceServers: ICE_SERVERS };

      if (this.strategy === 'nostr') {
        this.room = joinNostr(
          {
            appId: APP_ID,
            relayUrls: NOSTR_RELAYS,
            rtcConfig,
          },
          roomId
        );
      } else if (this.strategy === 'torrent') {
        this.room = joinTorrent(
          {
            appId: APP_ID,
            rtcConfig,
          },
          roomId
        );
      } else {
        // MQTT strategy
        this.room = joinMqtt(
          {
            appId: APP_ID,
            rtcConfig,
          },
          roomId
        );
      }

      // Set up message channel
      const [sendMsg, getMsg] = this.room.makeAction<string>('chat');
      this.sendMessage = sendMsg;

      getMsg((message, peerId) => {
        this.log('message', `[${peerId.slice(0, 8)}]: ${message}`);
      });

      // Handle peer events
      this.room.onPeerJoin((peerId) => {
        this.peers.add(peerId);
        this.log('success', `Peer joined: ${peerId.slice(0, 8)}...`);
        this.updatePeerCount();
      });

      this.room.onPeerLeave((peerId) => {
        this.peers.delete(peerId);
        this.log('info', `Peer left: ${peerId.slice(0, 8)}...`);
        this.updatePeerCount();
      });

      this.log('success', 'Room joined! Waiting for peers...');
      this.log('info', '(Peer discovery can take 10-30 seconds)');
      this.showRoomInfo();

      // Periodic status check
      let checks = 0;
      const statusInterval = setInterval(() => {
        checks++;
        if (!this.room) {
          clearInterval(statusInterval);
          return;
        }
        if (this.peers.size === 0 && checks <= 6) {
          this.log('info', `Still waiting for peers... (${checks * 5}s)`);
        }
        if (checks > 6 && this.peers.size === 0) {
          this.log('error', 'No peers found after 30s. Try a different strategy or check your network.');
          clearInterval(statusInterval);
        }
        if (this.peers.size > 0) {
          clearInterval(statusInterval);
        }
      }, 5000);

      // Update URL without reload
      const newUrl = `${window.location.pathname}?room=${roomId}`;
      window.history.pushState({}, '', newUrl);

    } catch (err) {
      this.log('error', `Failed to join room: ${err}`);
    }
  }

  private disconnect(): void {
    if (this.room) {
      this.room.leave();
      this.room = null;
      this.roomId = null;
      this.peers.clear();
      this.sendMessage = null;
      this.log('info', 'Disconnected from room');
      this.hideRoomInfo();

      // Clear URL
      window.history.pushState({}, '', window.location.pathname);
    }
  }

  private sendChatMessage(): void {
    const input = document.getElementById('messageInput') as HTMLInputElement;
    const message = input.value.trim();
    if (message && this.sendMessage) {
      this.sendMessage(message);
      this.log('message', `[You]: ${message}`);
      input.value = '';
    }
  }

  private showRoomInfo(): void {
    const roomInfo = document.getElementById('roomInfo');
    const messageSection = document.getElementById('messageSection');
    const disconnectSection = document.getElementById('disconnectSection');
    const roomCode = document.getElementById('roomCode');

    if (roomInfo) roomInfo.style.display = 'block';
    if (messageSection) messageSection.style.display = 'block';
    if (disconnectSection) disconnectSection.style.display = 'block';
    if (roomCode && this.roomId) roomCode.textContent = this.roomId;

    this.updatePeerCount();
  }

  private hideRoomInfo(): void {
    const roomInfo = document.getElementById('roomInfo');
    const messageSection = document.getElementById('messageSection');
    const disconnectSection = document.getElementById('disconnectSection');

    if (roomInfo) roomInfo.style.display = 'none';
    if (messageSection) messageSection.style.display = 'none';
    if (disconnectSection) disconnectSection.style.display = 'none';
  }

  private updatePeerCount(): void {
    const peerCount = document.getElementById('peerCount');
    if (peerCount) {
      peerCount.textContent = String(this.peers.size);
    }
  }

  private log(type: LogEntry['type'], text: string): void {
    const time = new Date().toLocaleTimeString();
    this.logs.push({ time, type, text });

    const logDiv = document.getElementById('log');
    if (logDiv) {
      const colors = {
        info: '#888',
        success: '#0f0',
        error: '#f00',
        message: '#0ff',
      };

      const entry = document.createElement('div');
      entry.style.color = colors[type];
      entry.style.marginBottom = '0.25rem';
      entry.innerHTML = `<span style="color: #666;">[${time}]</span> ${text}`;
      logDiv.appendChild(entry);
      logDiv.scrollTop = logDiv.scrollHeight;
    }

    console.log(`[${type}] ${text}`);
  }
}
