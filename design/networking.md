# Networking Design - Multiplayer with Trystero

This document details the multiplayer networking architecture for Teratron Web, using pure peer-to-peer connections with Trystero.

## Table of Contents

1. [Overview](#overview)
2. [Trystero Architecture](#trystero-architecture)
3. [Connection Model](#connection-model)
4. [Room System](#room-system)
5. [Lobby Design](#lobby-design)
6. [Network Protocol](#network-protocol)
7. [State Synchronization](#state-synchronization)
8. [Implementation Structure](#implementation-structure)
9. [Technical Considerations](#technical-considerations)

## Overview

**Pure Peer-to-Peer with Host Authority**

Teratron uses a pure P2P architecture with one client acting as the authoritative host. This provides:

- **Zero infrastructure costs**: No game servers needed
- **Low latency**: Direct connections between players
- **Simple deployment**: Just static file hosting
- **Ideal for 2-4 players**: WebRTC mesh scales perfectly at this size

**Core Principles:**
- Host runs authoritative game logic
- Guests send inputs only
- Host broadcasts game state to all guests
- All players see identical game state
- Room creation/joining via shareable links

## Trystero Architecture

### Why Trystero?

**Trystero provides:**
- Truly serverless signaling via decentralized networks
- No single point of failure - multiple fallback strategies
- Simple WebRTC abstraction (no manual offer/answer/ICE handling)
- Room-based peer discovery built-in
- Automatic connection management
- End-to-end encryption

**What we write:** Client-side TypeScript only
**What we deploy:** Static HTML/CSS/JS files
**Cost:** $0 (uses public relays/brokers)

### Signaling Strategy

**Current implementation uses MQTT** for peer discovery via public MQTT brokers.

```typescript
import { joinRoom } from 'trystero/mqtt';

const room = joinRoom(
  {
    appId: 'teratron-lobby',
    rtcConfig: { iceServers: ICE_SERVERS },
  },
  roomId
);
```

**ICE servers for NAT traversal:**
```typescript
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
```

### How It Works

```
┌─────────────────────────────┐
│      MQTT Public Brokers    │
│    (Peer discovery only)    │
└───────────┬─────────────────┘
            │
   ┌────────┼────────────┐
   │        │            │
   ▼        ▼            ▼
┌──────┐ ┌──────┐ ┌──────┐
│ Host │◄┤Guest │ │Guest │
│      │◄┼──────┼►│      │
└──────┘ └──────┘ └──────┘
    WebRTC P2P Mesh
```

**Connection Flow:**
1. Host joins a Trystero room with unique app+room ID
2. Host shares room link: `https://teratron.com/?room=red-bear-moon`
3. Guests open link and extract room ID from URL
4. Guests join the same Trystero room
5. Trystero handles peer discovery via MQTT brokers
6. Direct P2P connections established via WebRTC
7. URL is cleared after connecting to avoid stale rejoins on refresh

## Connection Model

### LobbyConnection Class

A unified class that handles both host and guest roles, determined by the `isHost` flag at construction.

```typescript
class LobbyConnection {
  private room: Room | null = null;
  private isHost: boolean;
  private myPeerId: string | null = null;
  private lobbyState: LobbyState | null = null;
  private mySlotIndex: SlotIndex | null = null;

  // Action senders for different channels
  private sendLobbyMsg: ((msg, target?) => void) | null = null;
  private sendGameState: ((msg, target?) => void) | null = null;
  private sendGameInput: ((msg, target?) => void) | null = null;

  // Connection lifecycle
  createRoom(nickname: string): string;  // Host only
  joinRoom(roomId: string, nickname: string): void;
  disconnect(): void;

  // Lobby actions (work for both host and guest)
  announce(nickname: string): void;
  joinSlot(slotIndex: SlotIndex, nickname: string): void;
  leaveSlot(): void;
  changeSlot(targetSlot: SlotIndex): void;
  sendNicknameChange(nickname: string): void;
  sendChat(text: string): void;

  // Game phase
  startGame(): void;  // Host only
  broadcastGameState(positions: PlayerPosition[]): void;  // Host only
  sendInput(input: GameInput): void;  // Guest only
}
```

### GameConnection Class

A clean wrapper that hides lobby details from the game phase:

```typescript
class GameConnection {
  constructor(
    connection: LobbyConnection,
    slotByPeerId: Map<string, SlotIndex>,
    mySlotIndex: SlotIndex | null
  );

  isHost(): boolean;
  getMySlotIndex(): SlotIndex | null;

  // Game state (host broadcasts, guests receive)
  broadcastTronState(state: TronGameStateData): void;
  setCallbacks(callbacks: GameConnectionCallbacks): void;

  // Input (guests send to host)
  sendInput(input: TronInput): void;

  disconnect(): void;
}
```

### Why Host Authority?

**Benefits:**
- Prevents cheating (host validates all inputs)
- Ensures consistency (single source of truth)
- Simpler than full P2P consensus
- No split-brain scenarios
- Single physics simulation

**Tradeoffs:**
- Host has slight advantage (zero latency for own inputs)
- Host disconnection ends the game
- Host could theoretically cheat (acceptable for friendly games)

## Room System

### Room Code Generation

Room codes use three random words for easy verbal sharing:

```typescript
const ROOM_WORDS = [
  'red', 'blue', 'gold', 'jade', 'pink', 'gray', 'lime', 'plum', 'rose', 'teal',
  'bear', 'bird', 'crab', 'deer', 'duck', 'fish', 'frog', 'goat', 'hawk', 'lion',
  'moon', 'star', 'rain', 'snow', 'wind', 'fire', 'lake', 'rock', 'sand', 'wave',
  // ... more words
];

function generateRoomCode(): string {
  const words: string[] = [];
  for (let i = 0; i < 3; i++) {
    const index = Math.floor(Math.random() * ROOM_WORDS.length);
    words.push(ROOM_WORDS[index]);
  }
  return words.join('-');  // e.g., "red-bear-moon"
}
```

**Room Link Format:**
```
https://teratron.com/?room=red-bear-moon
```

### URL Handling

- When opening a link with `?room=xxx`, the app auto-joins as guest
- After successfully connecting, the URL is cleared via `history.replaceState()`
- This prevents stale rejoin attempts on page refresh or dev server restart

### Room Lifecycle

```
[Created] → [Lobby] → [Game] → [Round End] → [Lobby] → ...
                                    ↓
                              [Disconnect]
```

**Capacity:**
- Minimum: 2 players for FFA mode
- Maximum: 4 players
- Team mode requires exactly 4 players

## Lobby Design

### Lobby State

The host maintains authoritative lobby state, broadcast to all guests:

```typescript
interface LobbyState {
  roomId: string;
  hostPeerId: string;
  gameMode: GameMode;        // 'ffa' | 'team'
  levelMode: LevelMode;      // 'cycle' | specific level id
  slots: [PlayerSlot, PlayerSlot, PlayerSlot, PlayerSlot];
  chatMessages: ChatMessage[];
  spectators: Spectator[];   // Connected peers not in a slot
}

interface PlayerSlot {
  slotIndex: SlotIndex;      // 0 | 1 | 2 | 3
  peerId: string | null;     // null = slot is open
  nickname: string;
  isHost: boolean;
}

interface ChatMessage {
  id: string;
  senderSlotIndex: SlotIndex | null;
  senderNickname: string;
  text: string;
  timestamp: number;
}
```

### Slot System

- 4 fixed slots (0-3) with associated colors:
  - FFA: Red, Green, Blue, Yellow
  - Team: Purple (0,2), Brown (1,3)
- Players choose which slot to join
- Host can be in any slot (or no slot as spectator)
- Spectators can watch without playing

### Features

**Player List:**
- Shows all 4 slots with status (filled/open)
- Each slot shows color, nickname, "(Host)" marker
- Spectators shown separately

**Chat:**
- Text chat in lobby
- Messages capped at 100
- Shows sender nickname and slot color

**Game Start (Host only):**
- Enabled when 2+ players in FFA, 4 players in Team mode
- Broadcasts `game_start` to all peers

## Network Protocol

### Message Channels

Three separate Trystero action channels:

1. **`lobby`** - Lobby management messages
2. **`gameState`** - Host broadcasts game state
3. **`gameInput`** - Guests send inputs to host

### Guest → Host Messages

```typescript
type GuestToHostMessage =
  | { type: 'announce'; nickname: string }
  | { type: 'join_request'; nickname: string; preferredSlot?: SlotIndex }
  | { type: 'slot_change'; targetSlot: SlotIndex }
  | { type: 'nickname_change'; nickname: string }
  | { type: 'chat_send'; text: string }
  | { type: 'leave' };
```

### Host → Guest Messages

```typescript
type HostToGuestMessage =
  | { type: 'lobby_state'; state: LobbyState }
  | { type: 'join_accepted'; yourPeerId: string; assignedSlot: SlotIndex }
  | { type: 'join_rejected'; reason: 'room_full' | 'game_in_progress' | 'invalid_request' }
  | { type: 'game_start'; countdown: number }
  | { type: 'host_disconnected' };
```

### Game Phase Messages

```typescript
// Host → Guests (via gameState channel)
interface TronStateMessage {
  type: 'tron_state';
  state: TronGameStateData;
  timestamp: number;
}

// Guest → Host (via gameInput channel)
interface TronInputMessage {
  type: 'tron_input';
  input: TronInput;  // { left, right, action }
}
```

## State Synchronization

### Tron Game State

The host broadcasts complete game state every tick:

```typescript
interface TronGameStateData {
  round: TronRoundState;
  match: TronMatchState;
  newTrailSegments: { slotIndex: SlotIndex; segments: TrailSegment[] }[];
  borderSegments?: { color: string; segments: TrailSegment[] }[];
  soundEvents: SoundEvent[];
  eraserUsed?: boolean;
  ridiculousDeathSlots?: SlotIndex[];
  clearedAreas?: { x: number; y: number; radius: number }[];
  colorBlindnessFrames?: number;
}

interface TronRoundState {
  phase: 'countdown' | 'playing' | 'waiting_ready';
  players: TronPlayerState[];
  countdown: number;
  roundWinner: SlotIndex | 'draw' | null;
  portals: TeleportPortal[];
  items: GameItem[];
  projectiles: Projectile[];
  explosions: Explosion[];
  bodyguards: Bodyguard[];
}

interface TronMatchState {
  scores: Partial<Record<SlotIndex, number>>;
  currentRound: number;
  currentLevelIndex: number;
  playersReady: SlotIndex[];
  gameMode: GameMode;
  levelMode: LevelMode;
  ridiculousDeath: Partial<Record<SlotIndex, number>>;
}
```

### Trail Synchronization

**Incremental approach:**
- Host sends only new trail segments each tick
- Guests accumulate segments locally
- Eraser clears all trails (signaled via `eraserUsed` flag)
- Cleared areas from bullet impacts sent as coordinates

### Sound Synchronization

Sound events included in state for guests to play locally:

```typescript
interface SoundEvent {
  sound: string;
  loop?: boolean;
  loopKey?: string;
  stopLoop?: string;
}
```

### Input Handling

**Guest inputs:**
```typescript
interface TronInput {
  left: boolean;
  right: boolean;
  action: boolean;  // Ready signal / fire weapon
}
```

- Guests send input state on the `gameInput` channel
- Host applies inputs to authoritative game state
- Ready signal (`action: true` during `waiting_ready` phase) advances to next round

## Implementation Structure

### File Structure

```
src/
├── network/
│   ├── LobbyConnection.ts    # Unified host/guest connection
│   ├── GameConnection.ts     # Game-phase wrapper
│   └── protocol.ts           # Message type definitions
│
├── screens/
│   ├── ScreenManager.ts      # Screen transitions, URL handling
│   ├── MainMenu.ts           # Main menu UI
│   ├── NetworkLobby.ts       # Lobby UI (host + guest views)
│   └── PlaceholderGame.ts    # Game screen wrapper
│
├── types/
│   ├── lobby.ts              # LobbyState, PlayerSlot, etc.
│   └── game.ts               # TronGameStateData, TronInput, etc.
│
├── game/
│   ├── TronGameState.ts      # Authoritative game logic (host)
│   ├── TronRenderer.ts       # Rendering (all clients)
│   └── ...
│
└── main.ts                   # Entry point, initialization
```

### Dependencies

```json
{
  "dependencies": {
    "trystero": "^0.21.0",
    "nanoid": "^5.0.0"
  }
}
```

## Technical Considerations

### Connection Quality

**Monitoring (via Trystero):**
- `room.getPeers()` returns connected peer IDs
- `onPeerJoin` / `onPeerLeave` callbacks

**Handling disconnections:**
- Guest disconnect: Host removes from lobby, broadcasts update
- Host disconnect: Guests receive `host_disconnected`, return to menu

### Error Handling

**Connection errors:**
- Room full → `join_rejected` with reason
- Connection timeout → Return to menu with error
- Host disconnect → Notify guests, end game

### Security Considerations

**P2P limitations (acceptable for friendly games):**
- Host sees guest IP addresses (WebRTC limitation)
- Host could modify game state maliciously
- No server-side validation

**Mitigations:**
- Target audience: Friends playing together
- Social deterrent against cheating

### Browser Compatibility

**Target browsers:** Chrome, Firefox, Safari, Edge (all with WebRTC support)

**Fallback:** Detect WebRTC support on load, show error if unsupported.
