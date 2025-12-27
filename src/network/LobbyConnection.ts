// Lobby connection wrapper around Trystero

import { joinRoom as joinMqtt, Room } from 'trystero/mqtt';
import { nanoid } from 'nanoid';
import type {
  LobbyState,
  SlotIndex,
  ChatMessage,
  GameMode,
} from '../types/lobby';
import {
  createInitialLobbyState,
  createEmptySlot,
  findFirstOpenSlot,
  findSlotByPeerId,
} from '../types/lobby';
import type {
  GuestToHostMessage,
  HostToGuestMessage,
  GameInput,
  GameStateMessage,
  PlayerInputMessage,
  PlayerPosition,
} from './protocol';

const APP_ID = 'teratron-lobby';

// Free TURN servers for NAT traversal
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
];

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

export interface LobbyConnectionCallbacks {
  onStatusChange?: (status: ConnectionStatus) => void;
  onLobbyStateUpdate?: (state: LobbyState) => void;
  onJoinAccepted?: (peerId: string, slotIndex: SlotIndex) => void;
  onJoinRejected?: (reason: string) => void;
  onGameStart?: (countdown: number) => void;
  onHostDisconnected?: () => void;
  onError?: (error: string) => void;
  // Game phase callbacks
  onGameState?: (state: GameStateMessage) => void;
  onPlayerInput?: (peerId: string, input: GameInput) => void;
}

export class LobbyConnection {
  private room: Room | null = null;
  private roomId: string | null = null;
  private isHost: boolean;
  private myPeerId: string | null = null;
  private status: ConnectionStatus = 'disconnected';
  private callbacks: LobbyConnectionCallbacks = {};

  // Action senders
  private sendLobbyMsg: ((msg: HostToGuestMessage | GuestToHostMessage, target?: string) => void) | null = null;
  private sendGameState: ((msg: GameStateMessage, target?: string) => void) | null = null;
  private sendGameInput: ((msg: PlayerInputMessage, target?: string) => void) | null = null;

  // Host-only state
  private lobbyState: LobbyState | null = null;
  private hostNickname: string = 'Host'; // Used for chat when host not in slot

  // Guest-only state
  private mySlotIndex: SlotIndex | null = null;

  constructor(isHost: boolean) {
    this.isHost = isHost;
  }

  setCallbacks(callbacks: LobbyConnectionCallbacks): void {
    // Merge new callbacks with existing ones (new callbacks override)
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  getRoomId(): string | null {
    return this.roomId;
  }

  getMyPeerId(): string | null {
    return this.myPeerId;
  }

  getMySlotIndex(): SlotIndex | null {
    return this.mySlotIndex;
  }

  getLobbyState(): LobbyState | null {
    return this.lobbyState;
  }

  isHostMode(): boolean {
    return this.isHost;
  }

  // === Connection ===

  createRoom(_nickname: string = 'Host'): string {
    if (!this.isHost) {
      throw new Error('Only host can create room');
    }

    const roomId = nanoid(10);
    this.joinTrysteroRoom(roomId);
    return roomId;
  }

  joinRoom(roomId: string, _nickname: string = 'Player'): void {
    this.joinTrysteroRoom(roomId);
  }

  private joinTrysteroRoom(roomId: string): void {
    if (this.room) {
      this.disconnect();
    }

    this.roomId = roomId;
    this.setStatus('connecting');

    try {
      this.room = joinMqtt(
        {
          appId: APP_ID,
          rtcConfig: { iceServers: ICE_SERVERS },
        },
        roomId
      );

      // Set up lobby message channel
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const [sendLobby, getLobby] = this.room.makeAction<any>('lobby');
      this.sendLobbyMsg = (msg, target) => {
        console.log('[LobbyConnection] Sending lobby message:', msg.type, target ? `to ${target}` : 'broadcast');
        sendLobby(msg, target);
      };

      getLobby((msg: HostToGuestMessage | GuestToHostMessage, peerId: string) => {
        console.log('[LobbyConnection] Received lobby message:', msg.type, 'from:', peerId);
        this.handleLobbyMessage(msg, peerId);
      });

      // Set up game state channel
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const [sendState, getState] = this.room.makeAction<any>('gameState');
      this.sendGameState = (msg, target) => sendState(msg, target);

      getState((msg: GameStateMessage, _peerId: string) => {
        this.callbacks.onGameState?.(msg);
      });

      // Set up game input channel
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const [sendInput, getInput] = this.room.makeAction<any>('gameInput');
      this.sendGameInput = (msg, target) => sendInput(msg, target);

      getInput((msg: PlayerInputMessage, peerId: string) => {
        this.callbacks.onPlayerInput?.(peerId, msg.input);
      });

      // Handle peer events
      this.room.onPeerJoin((peerId) => {
        console.log('[LobbyConnection] Peer joined:', peerId, 'isHost:', this.isHost);
        if (this.isHost) {
          this.handlePeerJoin(peerId);
        } else {
          // Guest: we connected to someone (probably the host)
          console.log('[LobbyConnection] Guest connected to peer, requesting lobby state');
        }
      });

      this.room.onPeerLeave((peerId) => {
        console.log('[LobbyConnection] Peer left:', peerId);
        if (this.isHost) {
          this.handlePeerLeave(peerId);
        } else if (this.lobbyState && peerId === this.lobbyState.hostPeerId) {
          this.callbacks.onHostDisconnected?.();
        }
      });

      console.log('[LobbyConnection] Room joined, waiting for peers... (can take 10-30 seconds)');

      if (this.isHost) {
        // Initialize lobby state with all slots empty
        this.myPeerId = `host-${nanoid(6)}`;
        this.lobbyState = createInitialLobbyState(roomId, this.myPeerId);
        this.setStatus('connected');
        this.callbacks.onLobbyStateUpdate?.(this.lobbyState);
      } else {
        // Guest waits for connection - they'll choose their slot via UI
        this.setStatus('connected');
      }

      // Update URL
      const newUrl = `${window.location.pathname}?room=${roomId}`;
      window.history.pushState({}, '', newUrl);

    } catch (err) {
      console.error('[LobbyConnection] Failed to join room:', err);
      this.callbacks.onError?.(`Failed to join room: ${err}`);
      this.setStatus('disconnected');
    }
  }

  disconnect(): void {
    if (this.room) {
      // Notify peers if we're leaving gracefully
      if (!this.isHost && this.sendLobbyMsg) {
        this.sendLobbyMsg({ type: 'leave' });
      }

      this.room.leave();
      this.room = null;
      this.roomId = null;
      this.lobbyState = null;
      this.mySlotIndex = null;
      this.sendLobbyMsg = null;
      this.sendGameState = null;
      this.sendGameInput = null;
      this.setStatus('disconnected');

      // Clear URL
      window.history.pushState({}, '', window.location.pathname);
    }
  }

  // === Host: Lobby Management ===

  setGameMode(mode: GameMode): void {
    if (!this.isHost || !this.lobbyState) return;
    this.lobbyState.gameMode = mode;
    this.broadcastLobbyState();
  }

  // === Actions (same interface for host and guest) ===

  // Announce yourself without joining a slot
  announce(nickname: string): void {
    this.sendOrProcessLocally({ type: 'announce', nickname });
  }

  joinSlot(slotIndex: SlotIndex, nickname: string): void {
    this.sendOrProcessLocally({
      type: 'join_request',
      nickname,
      preferredSlot: slotIndex,
    });
  }

  leaveSlot(): void {
    this.sendOrProcessLocally({ type: 'leave' });
    this.mySlotIndex = null;
  }

  changeSlot(targetSlot: SlotIndex): void {
    this.sendOrProcessLocally({ type: 'slot_change', targetSlot });
  }

  sendNicknameChange(nickname: string): void {
    if (this.isHost) {
      this.hostNickname = nickname; // Track for unassigned host chat
    }
    this.sendOrProcessLocally({ type: 'nickname_change', nickname });
  }

  sendChat(text: string): void {
    this.sendOrProcessLocally({ type: 'chat_send', text });
  }

  // Helper: host processes locally, guest sends over network
  private sendOrProcessLocally(msg: GuestToHostMessage): void {
    if (this.isHost) {
      // Host processes its own message locally
      if (this.myPeerId) {
        this.handleGuestMessage(msg, this.myPeerId);
      }
    } else if (this.sendLobbyMsg) {
      // Guest sends to host
      this.sendLobbyMsg(msg);
    }
  }

  // === Host: Game Control ===

  startGame(): void {
    if (!this.isHost || !this.sendLobbyMsg || !this.lobbyState) return;

    // Broadcast to all peers
    this.sendLobbyMsg({ type: 'game_start', countdown: 3000 });
    this.callbacks.onGameStart?.(3000);
  }

  // === Game Phase ===

  broadcastGameState(positions: PlayerPosition[]): void {
    if (!this.isHost || !this.sendGameState) return;
    this.sendGameState({
      type: 'game_state',
      positions,
      timestamp: Date.now(),
    });
  }

  sendInput(input: GameInput): void {
    if (this.isHost || !this.sendGameInput) return;
    this.sendGameInput({
      type: 'player_input',
      input,
    });
  }

  // === Private: Message Handling ===

  private handleLobbyMessage(msg: HostToGuestMessage | GuestToHostMessage, peerId: string): void {
    console.log('[LobbyConnection] Received message:', msg.type, 'from:', peerId);

    if (this.isHost) {
      this.handleGuestMessage(msg as GuestToHostMessage, peerId);
    } else {
      this.handleHostMessage(msg as HostToGuestMessage, peerId);
    }
  }

  private handleGuestMessage(msg: GuestToHostMessage, peerId: string): void {
    if (!this.lobbyState) return;

    // Check if this is the host processing their own message
    const isHostPeer = peerId === this.myPeerId;

    switch (msg.type) {
      case 'announce': {
        // Peer announces themselves without joining a slot
        const existingUnassigned = this.lobbyState.unassignedPeers.find(p => p.peerId === peerId);
        if (existingUnassigned) {
          existingUnassigned.nickname = msg.nickname;
        } else {
          this.lobbyState.unassignedPeers.push({ peerId, nickname: msg.nickname });
        }
        this.broadcastLobbyState();
        break;
      }

      case 'join_request': {
        // Find an open slot
        let slotIndex = msg.preferredSlot;
        if (slotIndex === undefined || this.lobbyState.slots[slotIndex].peerId !== null) {
          slotIndex = findFirstOpenSlot(this.lobbyState) ?? undefined;
        }

        if (slotIndex === undefined) {
          // Room full - only send rejection to remote peers
          if (!isHostPeer) {
            this.sendLobbyMsg?.({ type: 'join_rejected', reason: 'room_full' }, peerId);
          }
          return;
        }

        // Remove from unassigned peers if present
        this.lobbyState.unassignedPeers = this.lobbyState.unassignedPeers.filter(p => p.peerId !== peerId);

        // Assign slot (mark as host if it's the host peer)
        this.lobbyState.slots[slotIndex] = {
          slotIndex: slotIndex as SlotIndex,
          peerId,
          nickname: msg.nickname,
          isHost: isHostPeer,
        };

        // Update local slot index
        if (isHostPeer) {
          this.mySlotIndex = slotIndex as SlotIndex;
        } else {
          // Send acceptance to remote peer
          this.sendLobbyMsg?.({ type: 'join_accepted', yourPeerId: peerId, assignedSlot: slotIndex as SlotIndex }, peerId);
        }
        this.broadcastLobbyState();
        break;
      }

      case 'slot_change': {
        const currentSlot = findSlotByPeerId(this.lobbyState, peerId);
        if (!currentSlot) return;

        const targetSlot = this.lobbyState.slots[msg.targetSlot];
        if (targetSlot.peerId !== null) return; // Slot taken

        // Move player (preserve isHost flag)
        const wasHost = currentSlot.isHost;
        this.lobbyState.slots[currentSlot.slotIndex] = createEmptySlot(currentSlot.slotIndex);
        this.lobbyState.slots[msg.targetSlot] = {
          slotIndex: msg.targetSlot,
          peerId,
          nickname: currentSlot.nickname,
          isHost: wasHost,
        };

        if (isHostPeer) {
          this.mySlotIndex = msg.targetSlot;
        }
        this.broadcastLobbyState();
        break;
      }

      case 'nickname_change': {
        // Check if in a slot
        const slot = findSlotByPeerId(this.lobbyState, peerId);
        if (slot) {
          slot.nickname = msg.nickname;
          this.broadcastLobbyState();
          break;
        }
        // Check if unassigned
        const unassigned = this.lobbyState.unassignedPeers.find(p => p.peerId === peerId);
        if (unassigned) {
          unassigned.nickname = msg.nickname;
          this.broadcastLobbyState();
        }
        break;
      }

      case 'chat_send': {
        // Check if in a slot
        const slot = findSlotByPeerId(this.lobbyState, peerId);
        if (slot) {
          this.addChatMessage(slot.slotIndex, slot.nickname, msg.text);
          break;
        }
        // Check if unassigned peer (or host not in slot)
        const unassigned = this.lobbyState.unassignedPeers.find(p => p.peerId === peerId);
        if (unassigned) {
          this.addChatMessage(null, unassigned.nickname, msg.text);
        } else if (isHostPeer) {
          // Host not in slot and not in unassigned - use hostNickname
          this.addChatMessage(null, this.hostNickname, msg.text);
        }
        break;
      }

      case 'leave': {
        // Remove from slot if in one
        const slot = findSlotByPeerId(this.lobbyState, peerId);
        if (slot) {
          this.lobbyState.slots[slot.slotIndex] = createEmptySlot(slot.slotIndex);
        }
        // Remove from unassigned peers
        this.lobbyState.unassignedPeers = this.lobbyState.unassignedPeers.filter(p => p.peerId !== peerId);
        this.broadcastLobbyState();
        break;
      }
    }
  }

  private handleHostMessage(msg: HostToGuestMessage, _peerId: string): void {
    switch (msg.type) {
      case 'lobby_state':
        this.lobbyState = msg.state;
        this.callbacks.onLobbyStateUpdate?.(msg.state);
        break;

      case 'join_accepted':
        this.myPeerId = msg.yourPeerId;
        this.mySlotIndex = msg.assignedSlot;
        this.callbacks.onJoinAccepted?.(msg.yourPeerId, msg.assignedSlot);
        break;

      case 'join_rejected':
        this.callbacks.onJoinRejected?.(msg.reason);
        break;

      case 'game_start':
        this.callbacks.onGameStart?.(msg.countdown);
        break;

      case 'host_disconnected':
        this.callbacks.onHostDisconnected?.();
        break;
    }
  }

  private handlePeerJoin(peerId: string): void {
    // New peer connected, send them current state after a small delay
    // to ensure their callbacks are set up
    if (this.lobbyState && this.sendLobbyMsg) {
      setTimeout(() => {
        if (this.lobbyState && this.sendLobbyMsg) {
          console.log('[LobbyConnection] Sending lobby state to new peer:', peerId);
          this.sendLobbyMsg({ type: 'lobby_state', state: this.lobbyState }, peerId);
        }
      }, 500);
    }
  }

  private handlePeerLeave(peerId: string): void {
    if (!this.lobbyState) return;

    let changed = false;

    // Remove from slot if in one
    const slot = findSlotByPeerId(this.lobbyState, peerId);
    if (slot && !slot.isHost) {
      this.lobbyState.slots[slot.slotIndex] = createEmptySlot(slot.slotIndex);
      changed = true;
    }

    // Remove from unassigned peers
    const prevLength = this.lobbyState.unassignedPeers.length;
    this.lobbyState.unassignedPeers = this.lobbyState.unassignedPeers.filter(p => p.peerId !== peerId);
    if (this.lobbyState.unassignedPeers.length !== prevLength) {
      changed = true;
    }

    if (changed) {
      this.broadcastLobbyState();
    }
  }

  private addChatMessage(slotIndex: SlotIndex | null, nickname: string, text: string): void {
    if (!this.lobbyState) return;

    const message: ChatMessage = {
      id: nanoid(8),
      senderSlotIndex: slotIndex,
      senderNickname: nickname,
      text,
      timestamp: Date.now(),
    };

    this.lobbyState.chatMessages.push(message);

    // Cap at 100 messages
    if (this.lobbyState.chatMessages.length > 100) {
      this.lobbyState.chatMessages = this.lobbyState.chatMessages.slice(-100);
    }

    this.broadcastLobbyState();
  }

  private broadcastLobbyState(): void {
    if (!this.isHost || !this.lobbyState || !this.sendLobbyMsg) return;
    this.sendLobbyMsg({ type: 'lobby_state', state: this.lobbyState });
    this.callbacks.onLobbyStateUpdate?.(this.lobbyState);
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    this.callbacks.onStatusChange?.(status);
  }
}
