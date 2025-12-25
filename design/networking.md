# Networking Design - Multiplayer with Trystero

This document details the multiplayer networking architecture for Teratron Web, using pure peer-to-peer connections with Trystero.

## Table of Contents

1. [Overview](#overview)
2. [PeerJS Architecture](#peerjs-architecture)
3. [Connection Model](#connection-model)
4. [Menu System](#menu-system)
5. [Room System](#room-system)
6. [Lobby Design](#lobby-design)
7. [Network Protocol](#network-protocol)
8. [State Synchronization](#state-synchronization)
9. [Implementation Structure](#implementation-structure)
10. [Technical Considerations](#technical-considerations)

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
- Truly serverless signaling via decentralized networks (Nostr, BitTorrent, MQTT)
- No single point of failure - multiple fallback strategies
- Simple WebRTC abstraction (no manual offer/answer/ICE handling)
- Room-based peer discovery built-in
- Automatic connection management
- End-to-end encryption

**What we write:** Client-side TypeScript only
**What we deploy:** Static HTML/CSS/JS files
**Cost:** $0 (uses public relays)

### How Trystero Works

```
┌─────────────────────────────┐
│   Decentralized Signaling   │
│  (Nostr / BitTorrent / MQTT)│
└───────────┬─────────────────┘
            │ (Peer discovery only)
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
2. Host shares room link: `https://teratron.com/?room=abc123xyz`
3. Guests open link and extract room ID from URL
4. Guests join the same Trystero room
5. Trystero handles peer discovery via decentralized network
6. Direct P2P connections established via WebRTC
7. After connection, signaling network not actively used

**Signaling Strategies:**
- **Nostr** (default): Uses Nostr relays - reliable, growing network
- **BitTorrent**: Uses WebTorrent trackers - very decentralized
- **MQTT**: Uses public MQTT brokers - reliable fallback

**Decision:** Use Nostr as primary, with fallback options if needed.

## Connection Model

### Host Client (Authoritative)

**Responsibilities:**
- Create and manage the game room
- Run the complete game loop at 60 Hz
- Process all player inputs (own + received from guests)
- Update authoritative game state
- Broadcast game state to all connected guests via WebRTC
- Handle player connections and disconnections
- Manage RoundManager (scores, ready-up, round state)
- Decide when to start rounds and games

**State:**
```typescript
class HostManager {
  private room: Room;                // Trystero room instance
  private sendState: ActionSender;   // Broadcast function for game state
  private sendEvent: ActionSender;   // Broadcast function for events
  private game: Game;                // Authoritative game instance
  private players: Map<string, PlayerInfo>; // Connected players

  // Manages room lifecycle
  createRoom(): string;              // Returns shareable room ID
  handlePeerJoin(peerId: string): void;
  handlePeerLeave(peerId: string): void;

  // Game loop
  broadcastGameState(): void;        // Send state to all guests
  processGuestInput(peerId: string, input: InputMessage): void;
}
```

### Guest Client

**Responsibilities:**
- Connect to host via room ID/link
- Send local player inputs to host
- Receive game state updates from host
- Render game state locally (no physics simulation)
- Display UI (scores, ready indicators, etc.)
- Handle disconnection gracefully

**State:**
```typescript
class GuestManager {
  private room: Room;                    // Trystero room instance
  private sendInput: ActionSender;       // Send function for inputs
  private hostPeerId: string | null;     // Host's peer ID
  private localPlayerId: string;         // This guest's player ID
  private game: Game;                    // For rendering only

  // Connection
  joinRoom(roomId: string): Promise<void>;
  disconnect(): void;

  // Communication
  sendInput(input: InputMessage): void;
  handleStateUpdate(state: StateMessage): void;
}
```

### Why Host Authority?

**Benefits:**
- Prevents cheating (host validates all inputs)
- Ensures consistency (single source of truth)
- Simpler than full P2P consensus
- No split-brain scenarios
- Easier to implement collision detection (single physics simulation)

**Tradeoffs:**
- Host has slight advantage (zero latency for own inputs)
- Host disconnection ends the game (acceptable for MVP)
- Host could theoretically cheat (acceptable for friendly games)

**Future improvement:** Host migration if host disconnects (Phase 3+)

## Menu System

### Menu Flow

```
┌─────────────────┐
│   Main Menu     │
├─────────────────┤
│                 │
│  Local Game     │──────► Player Count Selection (2-4) ──► Start Game
│                 │
│  Network Game   │──┐
│                 │  │
└─────────────────┘  │
                     │
                     ▼
        ┌────────────────────┐
        │  Network Menu      │
        ├────────────────────┤
        │                    │
        │  Create Room       │──► Room Created ──► Lobby (Host)
        │                    │
        │  Join Room         │──► Enter Code ──► Lobby (Guest)
        │                    │
        │  Back              │──► Main Menu
        │                    │
        └────────────────────┘
                     │
                     ▼
            ┌────────────────┐
            │     Lobby      │
            ├────────────────┤
            │ Players: 2/4   │
            │                │
            │ • Player 1 ✓   │
            │ • Player 2     │
            │                │
            │ Room: abc123   │
            │ [Copy Link]    │
            │                │
            │ [Start Game]   │ (Host only)
            │ or             │
            │ "Waiting..."   │ (Guests)
            │                │
            └────────────────┘
                     │
                     ▼
              ┌──────────┐
              │   Game   │
              └──────────┘
```

### UI Components

#### Main Menu (`src/ui/MainMenu.ts`)

**Layout:**
```
╔═══════════════════════════════════╗
║                                   ║
║           TERATRON                ║
║                                   ║
║      ┌──────────────────┐         ║
║      │   Local Game     │         ║
║      └──────────────────┘         ║
║                                   ║
║      ┌──────────────────┐         ║
║      │  Network Game    │         ║
║      └──────────────────┘         ║
║                                   ║
╚═══════════════════════════════════╝
```

**Behavior:**
- Click "Local Game" → Show player count selection (2-4)
- Click "Network Game" → Show network menu
- Uses retro styling consistent with original game

#### Network Menu (`src/ui/NetworkMenu.ts`)

**Layout:**
```
╔═══════════════════════════════════╗
║        NETWORK GAME               ║
║                                   ║
║      ┌──────────────────┐         ║
║      │   Create Room    │         ║
║      └──────────────────┘         ║
║                                   ║
║      ┌──────────────────┐         ║
║      │    Join Room     │         ║
║      └──────────────────┘         ║
║                                   ║
║      ┌──────────────────┐         ║
║      │      Back        │         ║
║      └──────────────────┘         ║
║                                   ║
╚═══════════════════════════════════╝
```

**Behavior:**
- "Create Room" → Initialize PeerJS, generate room ID, show lobby
- "Join Room" → Show input dialog for room code
- "Back" → Return to main menu

#### Join Room Dialog

**Layout:**
```
╔═══════════════════════════════════╗
║          JOIN ROOM                ║
║                                   ║
║  Enter room code or paste link:   ║
║  ┌──────────────────────────────┐ ║
║  │ abc123xyz                    │ ║
║  └──────────────────────────────┘ ║
║                                   ║
║  ┌─────────┐    ┌─────────┐      ║
║  │  Join   │    │ Cancel  │      ║
║  └─────────┘    └─────────┘      ║
║                                   ║
╚═══════════════════════════════════╝
```

**Behavior:**
- Input accepts room code (e.g., `abc123xyz`) or full URL
- Extract room ID from URL if pasted
- Validate room ID format
- Connect to host via PeerJS
- Show error if connection fails
- On success → Navigate to lobby

## Room System

### Room Creation (Host)

**Flow:**
1. User clicks "Create Room"
2. Generate room ID and join Trystero room:
   ```typescript
   import { joinRoom } from 'trystero/nostr';

   const roomId = generateRoomId(); // e.g., 'abc123xyz'
   const room = joinRoom({ appId: 'teratron' }, roomId);
   const shareableLink = `${window.location.origin}/?room=${roomId}`;
   ```
3. Set up action channels:
   ```typescript
   const [sendState, getState] = room.makeAction('state');
   const [sendEvent, getEvent] = room.makeAction('event');
   ```
4. Listen for peer connections:
   ```typescript
   room.onPeerJoin(peerId => {
     // New guest connected
     handlePeerJoin(peerId);
   });
   room.onPeerLeave(peerId => {
     handlePeerLeave(peerId);
   });
   ```
5. Display lobby with shareable link

**Room ID Generation:**
- Generate short readable ID (e.g., `happy-cat-123`)
- Combined with appId ensures uniqueness
- **Decision:** Use nanoid or similar for short, URL-safe IDs

**Room Link Format:**
```
https://teratron.com/?room=abc123xyz

Parameters:
- room: Unique room identifier (required)
```

### Room Joining (Guest)

**Flow:**
1. User opens shareable link or enters room code
2. Extract room ID from URL:
   ```typescript
   const urlParams = new URLSearchParams(window.location.search);
   const roomId = urlParams.get('room');
   ```
3. Join the same Trystero room:
   ```typescript
   import { joinRoom } from 'trystero/nostr';

   const room = joinRoom({ appId: 'teratron' }, roomId);
   ```
4. Set up action channels and wait for host:
   ```typescript
   const [sendInput, getInput] = room.makeAction('input');
   const [, getState] = room.makeAction('state');

   getState((state, peerId) => {
     // Receiving state from host
     handleStateUpdate(state);
   });

   room.onPeerJoin(peerId => {
     // Could be host or another guest
     sendJoinMessage(peerId);
   });
   ```
5. Send join message with player info
6. Display lobby

**Error Handling:**
- Room not found → Show error, return to network menu
- Room full (4 players) → Show error, return to network menu
- Connection timeout → Show error with retry option
- Host disconnected → Show error, return to main menu

### Room Lifecycle

```
[Created] → [Waiting for Players] → [Ready] → [Playing] → [Round End] → [Ready Again] → ...
                                                                ↓
                                                          [Game Over] → [Lobby]
```

**States:**
- **Created**: Host created room, waiting for first guest
- **Waiting**: 1+ players, waiting for minimum 2 players
- **Ready**: 2+ players, host can start game
- **Playing**: Game in progress
- **Round End**: Between rounds, players ready-up
- **Game Over**: Match complete, return to lobby or disconnect

**Capacity:**
- Minimum: 2 players (1 host + 1 guest)
- Maximum: 4 players (1 host + 3 guests)
- No mid-game joins (MVP) - players must join before game starts

## Lobby Design

### Lobby Screen (`src/ui/Lobby.ts`)

**Host View:**
```
╔═══════════════════════════════════╗
║             LOBBY                 ║
║                                   ║
║  Players: 3/4                     ║
║  ┌──────────────────────────────┐ ║
║  │ • RED    (You - Host)     ✓  │ ║
║  │ • GREEN  (Player 2)          │ ║
║  │ • BLUE   (Player 3)       ✓  │ ║
║  │ • YELLOW (Waiting...)        │ ║
║  └──────────────────────────────┘ ║
║                                   ║
║  Room Code: abc123xyz             ║
║  ┌──────────────────────────────┐ ║
║  │ https://teratron.com/?roo... │ ║
║  └──────────────────────────────┘ ║
║  [Copy Link] [Share QR Code]      ║
║                                   ║
║  ┌──────────────────────────────┐ ║
║  │        START GAME            │ ║ (Enabled when 2+ players)
║  └──────────────────────────────┘ ║
║  [Disconnect]                     ║
║                                   ║
╚═══════════════════════════════════╝
```

**Guest View:**
```
╔═══════════════════════════════════╗
║             LOBBY                 ║
║                                   ║
║  Players: 3/4                     ║
║  ┌──────────────────────────────┐ ║
║  │ • RED    (Host)           ✓  │ ║
║  │ • GREEN  (You)               │ ║
║  │ • BLUE   (Player 3)       ✓  │ ║
║  │ • YELLOW (Waiting...)        │ ║
║  └──────────────────────────────┘ ║
║                                   ║
║  Waiting for host to start...     ║
║                                   ║
║  [Ready] (Toggle)                 ║
║  [Disconnect]                     ║
║                                   ║
╚═══════════════════════════════════╝
```

### Lobby Features

**Player List:**
- Shows up to 4 player slots
- Each slot shows:
  - Color indicator (colored circle)
  - Player name or "Waiting..."
  - Ready indicator (✓ or blank)
  - "(You)" for local player
  - "(Host)" for the host player
- Updates in real-time as players join/leave/ready-up

**Shareable Link (Host only):**
- Prominently displayed room code
- Full URL in copyable text field
- "Copy Link" button (copies to clipboard)
- Optional: QR code for mobile sharing

**Ready System:**
- Guests can toggle ready status
- Host always considered ready
- All players see ready status in real-time
- Host can start when 2+ players connected (regardless of ready status)

**Connection Status:**
- Show connection quality indicators (optional, Phase 2+)
- Show ping/latency to host (optional, Phase 2+)
- Handle disconnections gracefully

**Start Game (Host):**
- "Start Game" button visible only to host
- Enabled when 2+ players connected
- Disabled when only 1 player (host alone)
- Click → Send start countdown, begin game

**Leave:**
- "Disconnect" button for all players
- Guest: Disconnect from host, return to main menu
- Host: Disconnect ends room, notifies all guests

## Network Protocol

### Message Types

All messages sent over Trystero action channels as JavaScript objects (Trystero handles serialization).

#### Guest → Host Messages

```typescript
type GuestToHostMessage =
  | JoinMessage
  | InputMessage
  | ReadyMessage
  | ChatMessage; // Optional

interface JoinMessage {
  type: 'join';
  playerName: string;
  timestamp: number;
}

interface InputMessage {
  type: 'input';
  playerId: string;
  left: boolean;      // Turning left
  right: boolean;     // Turning right
  fire: boolean;      // Firing weapon
  timestamp: number;  // Client timestamp
}

interface ReadyMessage {
  type: 'ready';
  playerId: string;
  isReady: boolean;
}

interface ChatMessage {
  type: 'chat';
  playerId: string;
  message: string;
  timestamp: number;
}
```

#### Host → Guest Messages

```typescript
type HostToGuestMessage =
  | WelcomeMessage
  | StateMessage
  | StartGameMessage
  | EventMessage
  | PlayerJoinedMessage
  | PlayerLeftMessage
  | ErrorMessage;

interface WelcomeMessage {
  type: 'welcome';
  playerId: string;         // Assigned player ID
  playerNum: number;        // Player number (0-3)
  color: RGB;               // Assigned color
  roomInfo: RoomInfo;
}

interface RoomInfo {
  roomId: string;
  hostId: string;
  players: PlayerInfo[];    // All connected players
}

interface PlayerInfo {
  id: string;
  name: string;
  num: number;
  color: RGB;
  isReady: boolean;
}

interface StateMessage {
  type: 'state';
  frameNumber: number;
  timestamp: number;

  // Player states
  players: PlayerState[];

  // Round manager state
  roundState: RoundState;
  scores: [number, number][]; // [playerNum, score][]
  muertesRidiculas: [number, number][]; // [playerNum, count][]
  playersReady: number[];     // Array of ready player numbers
  lastWinnerId: string | null;

  // Trails (could be full ImageData or compressed)
  trails?: TrailData;
}

interface PlayerState {
  id: string;
  num: number;
  x: number;
  y: number;
  dir: number;
  alive: boolean;
  // Additional state...
}

interface StartGameMessage {
  type: 'start_game';
  countdown: number;          // Countdown in milliseconds
  mapId: number;
  mode: 'ffa' | 'team';
}

interface EventMessage {
  type: 'event';
  eventType: 'collision' | 'death' | 'item_spawned' | 'item_collected';
  data: any;                  // Event-specific data
  timestamp: number;
}

interface PlayerJoinedMessage {
  type: 'player_joined';
  player: PlayerInfo;
}

interface PlayerLeftMessage {
  type: 'player_left';
  playerId: string;
  playerName: string;
}

interface ErrorMessage {
  type: 'error';
  code: string;               // Error code (e.g., 'ROOM_FULL', 'INVALID_INPUT')
  message: string;            // Human-readable message
}
```

### Message Frequency

**Guest → Host:**
- **Input**: Every frame (~60 Hz) - only when input changes (optimization)
- **Ready**: On ready state change (infrequent)
- **Chat**: User-triggered (infrequent)

**Host → Guest:**
- **State**: Every tick (60 Hz) - full game state
- **Events**: As they occur (collision, death, etc.)
- **Player joined/left**: On connection changes

**Bandwidth Estimate:**
- Input messages: ~20 bytes × 60 Hz = 1.2 KB/s per guest
- State messages: ~500-1000 bytes × 60 Hz = 30-60 KB/s per guest
- Total per guest: ~35-65 KB/s (very reasonable for WebRTC)

**Optimization (Phase 2+):**
- Delta compression for state (only send changes)
- Binary protocol instead of JSON
- Adaptive tick rate based on action intensity

### Connection Management

**Trystero Connection Setup:**

```typescript
import { joinRoom } from 'trystero/nostr';

// Both host and guest use the same setup pattern
const room = joinRoom(
  {
    appId: 'teratron',
    // Optional: custom relay URLs
    // relayUrls: ['wss://relay.example.com'],
    // Optional: TURN servers for restrictive NATs
    rtcConfig: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        // Add TURN servers here for better connectivity
      ]
    }
  },
  roomId
);

// Set up action channels
const [sendState, getState] = room.makeAction('state');
const [sendInput, getInput] = room.makeAction('input');
const [sendEvent, getEvent] = room.makeAction('event');

// Handle peer connections
room.onPeerJoin(peerId => {
  console.log('Peer joined:', peerId);
  handlePeerJoin(peerId);
});

room.onPeerLeave(peerId => {
  console.log('Peer left:', peerId);
  handlePeerLeave(peerId);
});

// Receive messages
getState((state, peerId) => {
  handleStateUpdate(state, peerId);
});

getInput((input, peerId) => {
  handleInput(input, peerId);
});

// Send messages
sendState(gameState);           // Broadcast to all peers
sendState(gameState, peerId);   // Send to specific peer

// Leave room
room.leave();
```

**Reliability:**
- Trystero uses reliable WebRTC data channels by default
- Good for our use case (state consistency critical)
- End-to-end encryption built-in

**Connection Monitoring:**
- `room.getPeers()` returns array of connected peer IDs
- `onPeerJoin` / `onPeerLeave` callbacks for connection changes
- Can add application-level heartbeat if needed

## State Synchronization

### Ensuring All Players Play the Same Game

**Key principle:** Host runs single authoritative game simulation, all guests render identical state.

#### Host State Management

**Host responsibilities:**
1. Run Game.ts with complete game loop
2. Process inputs from all players (own + received from guests)
3. Update game state deterministically
4. Capture complete game state every tick
5. Serialize and broadcast state to all guests
6. Manage RoundManager state (scores, ready-up, winner)

**State capture:**
```typescript
function captureGameState(): StateMessage {
  return {
    type: 'state',
    frameNumber: gameLoop.frameNumber,
    timestamp: Date.now(),

    // Players
    players: players.map(p => p.toState()),

    // Round state
    roundState: roundManager.getState(),
    scores: Array.from(roundManager.getScores().entries()),
    muertesRidiculas: Array.from(roundManager.getMuertesRidiculas().entries()),
    playersReady: Array.from(roundManager.getPlayersReady()),
    lastWinnerId: roundManager.getLastWinner()?.id ?? null,

    // Trails (see Trail Synchronization below)
    trails: captureTrails(),
  };
}
```

**Broadcasting:**
```typescript
function broadcastGameState(): void {
  const state = captureGameState();
  const serialized = JSON.stringify(state); // Or binary format

  for (const [playerId, conn] of guestConnections) {
    if (conn.open) {
      conn.send(serialized);
    }
  }
}
```

#### Guest State Application

**Guest responsibilities:**
1. Receive state messages from host
2. Deserialize state
3. Apply state to local game instance (for rendering)
4. Update UI (scores, ready indicators)
5. Do NOT run physics simulation

**State application:**
```typescript
function applyGameState(state: StateMessage): void {
  // Update frame number
  gameLoop.frameNumber = state.frameNumber;

  // Update players
  for (const playerState of state.players) {
    const player = players.find(p => p.id === playerState.id);
    if (player) {
      player.x = playerState.x;
      player.y = playerState.y;
      player.dir = playerState.dir;
      player.alive = playerState.alive;
      // ... all other state
    }
  }

  // Update round state
  roundManager.setState(state.roundState);
  roundManager.setScores(new Map(state.scores));
  roundManager.setMuertesRidiculas(new Map(state.muertesRidiculas));
  roundManager.setPlayersReady(new Set(state.playersReady));

  // Update trails
  applyTrails(state.trails);

  // Render
  render();
}
```

#### Trail Synchronization

**Challenge:** Trails are pixel data (ImageData), large to sync every frame.

**Options:**

1. **Full trail sync (simple, MVP approach):**
   - Host sends full trail ImageData every tick
   - 750×600×4 bytes = 1.8 MB per frame (too large!)
   - Compress: Convert to PNG or use RLE compression
   - Or: Only sync every N frames (e.g., every second)
   - Guests draw intermediate trails based on player positions

2. **Incremental trail sync (optimized, Phase 2+):**
   - Host sends only new trail pixels since last update
   - Much smaller: ~20-50 pixels per player per frame
   - Guest maintains local trail canvas and adds new pixels
   - Periodic full sync for consistency (every 1-2 seconds)

3. **Position-based sync (recommended for MVP):**
   - Host sends player positions every tick
   - Guests draw trails locally based on position changes
   - Host does NOT send pixel data
   - Trails should match if physics is deterministic
   - Periodic full trail sync for error correction

**Decision for MVP:**
- Use position-based sync (option 3)
- Guests render their own trails from player positions
- This works because trail drawing is deterministic (given positions)
- Host does NOT send trail pixel data
- Future: Add checksum validation and correction if trails diverge

**Trail drawing consistency:**
```typescript
// Same trail drawing logic on host and guests
function drawTrailForPlayer(player: Player, oldX: number, oldY: number): void {
  if (oldX !== player.x || oldY !== player.y) {
    // Convert previous white head to colored
    const prevHead = trailHeads.get(player.num);
    if (prevHead) {
      renderer.drawTrailPixel(prevHead.x, prevHead.y, player.color);
    }

    // Draw new white head at old position
    renderer.drawTrailPixel(oldX, oldY, TRAIL_HEAD_COLOR);
    trailHeads.set(player.num, { x: oldX, y: oldY });
  }
}
```

#### Round State Synchronization

**Round transitions:**
- All round state managed by host's RoundManager
- Host broadcasts RoundManager state in every StateMessage
- Guests update their local RoundManager to match
- Ready-up system:
  - Guest clicks ready → sends ReadyMessage to host
  - Host updates RoundManager
  - Host broadcasts updated state to all guests
  - All guests see updated ready indicators

**Round start:**
- Host's RoundManager decides when to start round (all players ready)
- Host sends StartGameMessage to all guests
- Host and all guests call game.startNewRound() simultaneously
- All players see identical countdown and start

#### Determinism

**Why determinism matters:**
- If physics is deterministic, all clients can simulate locally
- Reduces bandwidth (only send inputs, not full state)
- Enables client-side prediction and rollback

**Current approach (non-deterministic, full state sync):**
- Only host simulates physics
- Host sends full state every tick
- Simpler to implement (MVP approach)
- Slightly higher bandwidth, but acceptable

**Future optimization (deterministic physics + rollback):**
- Make physics deterministic (use fixed-point math, deterministic random)
- All clients run same simulation
- Host sends inputs from all players
- Clients simulate locally and predict ahead
- Host sends corrections only when needed
- Much more complex, defer to Phase 3+

### Latency Handling

**Host latency:** Zero (local simulation)

**Guest latency:**
- Input latency: Time from input → host processes → state received back
- Typical P2P latency: 20-100ms (much better than server-based!)
- 60 Hz tick rate = 16.7ms per tick

**Mitigation (Phase 2+):**
1. **Client-side prediction**: Guest simulates local player immediately
2. **Server reconciliation**: When host state arrives, correct if different
3. **Interpolation**: Smooth out remote player movement
4. **Lag compensation**: Host applies input at past frame (rewind)

**MVP approach:**
- No prediction, no interpolation
- Accept input latency (20-100ms)
- Playable for cooperative games
- Add optimizations if needed after testing

## Implementation Structure

### New Files

#### Network Layer

**`src/network/RoomManager.ts`**
- Wrapper around Trystero
- Handles room creation/joining
- Manages action channels
- Provides type-safe message sending/receiving

**`src/network/HostManager.ts`**
- Host-specific networking logic
- Manages peer connections
- Broadcasts game state
- Processes guest inputs

**`src/network/GuestManager.ts`**
- Guest-specific networking logic
- Joins host's room
- Sends inputs to host
- Applies received state

**`src/network/protocol.ts`**
- TypeScript type definitions for all messages
- Message validation utilities
- Protocol version management

#### UI Layer

**`src/ui/MainMenu.ts`**
- Initial menu screen
- "Local Game" vs "Network Game" choice

**`src/ui/NetworkMenu.ts`**
- "Create Room" vs "Join Room" choice
- Room code input dialog

**`src/ui/Lobby.ts`**
- Pre-game lobby with player list
- Shareable link display (host)
- Ready indicators
- Start button (host)

**`src/ui/UIManager.ts`** (optional)
- Manages UI screen transitions
- Menu navigation state machine

#### Game Layer Modifications

**`src/game/Game.ts`** (modify)
- Add network mode flag: `isNetworkGame: boolean`
- Add `isHost: boolean` flag
- Separate update logic:
  - Host: Run full game loop
  - Guest: Skip physics, render only
- Add methods:
  - `applyNetworkState(state: StateMessage): void`
  - `captureGameState(): StateMessage`

**`src/game/managers/RoundManager.ts`** (modify)
- Add methods to set state from network:
  - `setState(state: RoundState): void`
  - `setScores(scores: Map<number, number>): void`
  - `setPlayersReady(ready: Set<number>): void`
- Expose current state for serialization

**`src/main.ts`** (modify)
- Initialize menu system instead of auto-starting game
- Handle URL parameters (room ID)
- Initialize network managers based on mode

### File Structure

```
src/
├── game/
│   ├── engine/
│   │   ├── GameLoop.ts
│   │   ├── InputManager.ts
│   │   └── CollisionDetector.ts
│   ├── entities/
│   │   └── Player.ts
│   ├── managers/
│   │   └── RoundManager.ts         (modify)
│   └── Game.ts                      (modify)
│
├── network/                         (NEW)
│   ├── RoomManager.ts               (NEW)
│   ├── HostManager.ts               (NEW)
│   ├── GuestManager.ts              (NEW)
│   └── protocol.ts                  (NEW)
│
├── ui/                              (NEW)
│   ├── MainMenu.ts                  (NEW)
│   ├── NetworkMenu.ts               (NEW)
│   ├── Lobby.ts                     (NEW)
│   └── UIManager.ts                 (NEW - optional)
│
├── render/
│   └── Renderer.ts
│
├── audio/
│   └── AudioManager.ts
│
├── types/
│   └── index.ts
│
├── constants.ts
├── utils.ts
└── main.ts                          (modify)
```

### Dependencies

Add to `package.json`:
```json
{
  "dependencies": {
    "trystero": "^0.21.0",
    "nanoid": "^5.0.0"
  }
}
```

Note: Trystero includes TypeScript types, no separate `@types` package needed.

## Technical Considerations

### Connection Quality

**Monitoring:**
- Track RTT (round-trip time) to host
- Measure packet loss (missed state updates)
- Display connection quality indicator in UI (optional)

**Quality levels:**
- Excellent: <30ms, <1% loss
- Good: 30-60ms, <5% loss
- Fair: 60-100ms, <10% loss
- Poor: >100ms or >10% loss

**Handling poor connections:**
- Display warning to player
- Continue playing (WebRTC handles retransmission)
- Optionally: Reduce tick rate or state detail

### Error Handling

**Connection errors:**
- Room not found → Return to network menu with error
- Connection timeout → Retry prompt
- Connection lost during game → End game, return to menu
- Host disconnect → Notify all guests, end game

**Game errors:**
- State deserialization failure → Request full state
- Invalid input → Ignore (host validates)
- Client out of sync → Full state resync (checksum validation)

### Security Considerations

**P2P Security Limitations:**
- Host can see all guest IP addresses (WebRTC limitation)
- Host could modify game state maliciously
- Guests must trust host for fair play
- No server-side validation possible

**Acceptable for friendly games:**
- Target audience: Friends playing together
- Not a competitive e-sports game
- Cheating ruins your own fun
- Social deterrent against cheating

**Future improvements (if needed):**
- Add peer validation (guests vote on state validity)
- Implement deterministic physics + state checksums
- Consider hybrid architecture (light server for validation)

### Browser Compatibility

**Target browsers:**
- Chrome/Edge: Excellent WebRTC support
- Firefox: Good WebRTC support
- Safari: Good WebRTC support (iOS too!)
- Opera: Good WebRTC support

**Compatibility notes:**
- WebRTC supported in all modern browsers (2023+)
- PeerJS handles browser differences automatically
- Test on mobile browsers (performance may vary)

**Fallback:**
- Detect WebRTC support on load
- Show error if not supported (very rare)
- Suggest browser upgrade

### Testing Strategy

**Local testing:**
- Two browser windows on same machine
- One as host, one as guest
- Test with `localhost` PeerJS server (optional)

**Remote testing:**
- Deploy to staging environment
- Test across different networks
- Test with actual network latency
- Test on mobile devices

**Test scenarios:**
- 2 players, 3 players, 4 players
- Guest joins mid-lobby
- Guest leaves mid-lobby
- Guest disconnects during game
- Host disconnects during game
- Poor network conditions (throttling)
- Multiple rounds with ready-up
- Rapid input changes

## Implementation Phases

### Phase 1: P2P Connection Test
- Build minimal connection test page
- Integrate Trystero with Nostr strategy
- Test peer discovery and connection
- Add TURN server configuration
- **Goal:** Verify P2P works in target environments

### Phase 2: Menu System & Lobby
- Build MainMenu, NetworkMenu UI
- Room creation with shareable links
- Lobby with player list
- Ready-up system
- **Goal:** Complete pre-game flow

### Phase 3: State Synchronization
- Implement HostManager and GuestManager
- Full protocol implementation
- Broadcast game state from host
- Apply state on guests
- **Goal:** 2-player networked game working

### Phase 4: Multi-player & Polish
- Support 3-4 players
- Round state synchronization
- Connection quality monitoring
- Error handling and edge cases
- **Goal:** Production-ready multiplayer

## Open Questions

**To be decided during implementation:**

1. **Trail sync approach:** Position-based (recommended) or pixel-based?
2. **State snapshot frequency:** Every tick (60 Hz) or adaptive?
3. **Message serialization:** JSON (easy to debug) or binary (efficient)?
4. **Client prediction:** Add for Phase 2 or defer to Phase 3?
5. **Room ID format:** Use nanoid for short, readable IDs
6. **QR code sharing:** Implement for mobile sharing?
7. **Host migration:** Defer to Phase 3+?
8. **Connection quality UI:** Show RTT/quality indicator?
9. **Chat system:** Add text chat or just game state?
10. **Trystero strategy fallback:** Try Nostr first, fall back to BitTorrent?

## Conclusion

This architecture provides a **zero-cost, zero-server multiplayer solution** that is:
- **Simple to implement**: Pure client-side TypeScript
- **Easy to deploy**: Just static file hosting
- **Low latency**: Direct P2P connections
- **Scalable**: Each game is independent, no central bottleneck
- **Maintainable**: Single codebase, no server ops

Perfect for Teratron's 2-4 player design! 🚀

**Next steps:**
1. Implement Phase 1 (Menu system)
2. Test with local multiplayer
3. Add P2P networking progressively
4. Polish and optimize based on real-world testing
