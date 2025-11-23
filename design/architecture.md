# Teratron Web - Architecture

This document outlines the high-level architecture for the modern web implementation of Teratron.

## Design Principles

1. **Faithful gameplay**: Preserve the core mechanics documented in [old-tron-design.md](./old-tron-design.md)
2. **Multiplayer-first**: Network architecture designed from the ground up
3. **Performance**: Maintain 60+ FPS in typical browsers
4. **Simplicity**: Avoid over-engineering, focus on what's needed
5. **Web-native**: Embrace modern web standards and practices

## Technology Stack

### Core Technologies

- **Language**: TypeScript
  - Type safety for game state and network messages
  - Better tooling and refactoring support
  - Compiles to efficient JavaScript

- **Runtime**: Node.js (server) + Modern browsers (client)
  - Use ES2020+ features
  - Target evergreen browsers (Chrome, Firefox, Safari, Edge)

### Rendering

- **Canvas 2D API**
  - Perfect for pixel-perfect 2D graphics
  - Direct pixel manipulation for trails
  - Good performance for our needs
  - Simple API, no framework overhead

**Why not WebGL?**
- Canvas 2D is sufficient for pixel-based rendering
- Simpler to implement pixel-perfect collision
- Lower complexity, better maintainability
- WebGL would be over-engineering for this use case

### Frontend Framework

**Recommendation: Minimal or no framework**
- Use vanilla TypeScript + Canvas for game rendering
- Optional: Lightweight library for UI (menu screens, lobby)
  - Options: Preact, Lit, or vanilla Web Components
  - Not critical path - can decide during implementation

**Why minimal?**
- Game loop doesn't benefit from React-style reactivity
- Direct DOM manipulation is fine for menus
- Reduces bundle size and complexity
- Easier to optimize performance

### Networking

**Pure Peer-to-Peer - No Custom Server!**

Use existing P2P infrastructure - zero server-side code to write or host!

**PeerJS** (or similar service)
- **What it provides:**
  - Free public signaling server (already running!)
  - Simple WebRTC abstraction
  - Room/peer ID system
  - Automatic connection management
- **What we write:** Client-side code only (TypeScript)
- **Cost:** $0 (uses PeerJS's free public server)

**How it works:**
1. Include PeerJS library in client
2. Create peer with unique ID (or random if host)
3. Share peer ID via URL: `http://teratron.com/?room=abc123`
4. Other players connect to peer ID
5. Direct P2P connections established automatically
6. No custom server code needed!

**Alternatives to PeerJS:**
- **Simple-peer**: Lower-level, more control
- **Trystero**: Serverless P2P using public infrastructure (BitTorrent, IPFS, etc.)
- **Gun.js**: Decentralized database with P2P sync
- Roll our own minimal signaling (only if needed later)

**Decision: Start with PeerJS**
- Simplest to implement
- Proven, widely used
- Free public infrastructure
- Can replace later if needed

### Build Tools

- **Vite**: Fast dev server and production builds
  - Native ESM support
  - TypeScript out of the box
  - Fast HMR for development
  - Simple configuration

- **Package Manager**: npm
  - Universal, comes with Node.js
  - Simple setup for single-package project

## System Architecture

### High-Level Overview

```
                    ┌────────────────────────┐
                    │ PeerJS Public Servers  │ (Free, already running!)
                    │  (Signaling only)      │
                    └───────────┬────────────┘
                                │ (Initial connection setup only)
                   ┌────────────┼────────────┐
                   │            │            │
                   ▼            ▼            ▼
         ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
         │ Host Client │ │  Client 2   │ │  Client 3   │
         │             │◄┼────────────►│ │             │
         │ - Game Loop │ │ WebRTC P2P  │◄┤ WebRTC P2P │
         │ - Authority │ │             │ │             │
         │ - Rendering │ │ - Rendering │ │ - Rendering │
         └─────────────┘ └─────────────┘ └─────────────┘

         After initial setup, all communication is direct P2P
         No custom server needed - just static file hosting!
```

### Peer-to-Peer Model with Host Authority

**Host Client (Authoritative)**
- One client (first to create room) acts as authoritative host
- Runs complete game logic locally
- Broadcasts game state to all connected peers via WebRTC
- Processes all inputs (own + received from peers)
- Source of truth for game state

**Guest Clients**
- Connect to host and other peers via WebRTC
- Send inputs to host
- Receive state updates from host
- Render game state locally
- Optional: Can connect to each other for redundancy/chat

**Why peer-to-peer with host authority?**
- **Zero server costs**: No dedicated game servers needed
- **Simpler operations**: Just static file hosting + minimal signaling
- **Low latency**: Direct connections, no server hop for game data
- **Perfect for 2-4 players**: WebRTC mesh scales well at this size
- **Still authoritative**: Host prevents cheating, ensures consistency

### Network Architecture

See detailed design: [multiplayer.md](./multiplayer.md) *(to be created)*

**Key decisions:**
- **Room-based matchmaking**: Players create/join rooms via shareable links
- **WebRTC signaling**: Use signaling server only for initial connection setup
- **P2P game data**: All game traffic goes directly between clients
- **Host authority**: Host client runs game loop and broadcasts state
- **Input handling**:
  - Guest clients send inputs to host
  - Host processes all inputs and updates state
  - Host broadcasts state to all guests
- **Latency handling**:
  - Client-side prediction for local player (on all clients)
  - Host reconciliation for corrections
  - Interpolation for remote players

**Room System:**
```
Shareable Link: http://teratron.example.com/?room=abc123xyz

Create Room:
  Player 1 → Creates PeerJS peer with ID "abc123xyz" → Becomes Host
          → Gets shareable link with peer ID

Join Room:
  Player 2+ → Opens link → Extracts peer ID from URL
          → Creates own PeerJS peer → Connects to host peer ID
          → PeerJS handles WebRTC setup automatically
          → Direct P2P connection established
```

**Connection Flow (using PeerJS):**
```typescript
// Host creates room
const hostPeer = new Peer('room-abc123xyz'); // Or random ID
const shareableLink = `${window.location.origin}/?room=${hostPeer.id}`;
// Share link with friends!

// Guest joins room
const roomId = new URLSearchParams(window.location.search).get('room');
const guestPeer = new Peer(); // Random ID for guest
const conn = guestPeer.connect(roomId); // Connect to host

// Direct P2P communication established!
// PeerJS handled all the WebRTC signaling
```

**Yes, shareable links work perfectly with pure P2P!**
- No custom server needed
- PeerJS provides the signaling
- Room ID is just the host's peer ID
- Share via URL, Discord, text message, etc.

## Code Organization

### Project Structure (Simplified!)

```
tron-revival/
├── src/                     # All TypeScript code (client-side only!)
│   ├── game/                # Core game logic (runs on host)
│   │   ├── engine/          # Game loop, physics, collision
│   │   ├── entities/        # Players, items, projectiles
│   │   └── maps/            # Map loading, hazards
│   ├── render/              # Canvas rendering
│   ├── network/             # P2P connections (PeerJS wrapper)
│   │   ├── host.ts          # Host-specific logic
│   │   ├── guest.ts         # Guest-specific logic
│   │   └── peer-manager.ts  # PeerJS connection management
│   ├── ui/                  # Menus, lobby, HUD
│   ├── types/               # TypeScript type definitions
│   ├── constants.ts         # Game constants
│   ├── utils.ts             # Shared utilities
│   └── main.ts              # Entry point
│
├── public/                  # Static assets
│   ├── assets/              # Graphics, sounds, fonts
│   └── index.html
│
├── design/                  # Design documents
├── old-tron/                # Original game reference
├── CLAUDE.md
├── package.json             # Single package!
├── tsconfig.json
├── vite.config.ts
└── README.md
```

**No monorepo needed!**
- Just one package: the client
- All TypeScript code is client-side
- No server code to maintain
- Simpler project structure

### Key Modules

See detailed designs:
- [game-state.md](./game-state.md) *(to be created)* - State management
- [rendering.md](./rendering.md) *(to be created)* - Canvas rendering approach
- [collision.md](./collision.md) *(to be created)* - Pixel-perfect collision
- [multiplayer.md](./multiplayer.md) *(to be created)* - Network protocol

## Game Loop Architecture

### Host Client Game Loop

```typescript
// Authoritative game loop runs on host client
const TICK_RATE = 60; // Game updates per second
const TICK_INTERVAL = 1000 / TICK_RATE;

function hostGameTick() {
  // 1. Process all player inputs (own + received from peers)
  processAllInputs();

  // 2. Update game state (authoritative)
  updatePlayers();
  updateProjectiles();
  updateItems();
  checkCollisions();

  // 3. Broadcast state to all connected peers via WebRTC
  broadcastGameStateToGuests();

  // 4. Render locally
  renderFrame();

  // 5. Schedule next tick
  setTimeout(hostGameTick, TICK_INTERVAL);
}
```

### Guest Client Loop

```typescript
// Guest rendering loop (receives state from host)
function guestLoop(timestamp) {
  // 1. Send inputs to host via WebRTC
  sendInputsToHost();

  // 2. Apply client-side prediction for local player
  predictLocalPlayer();

  // 3. Interpolate state updates from host
  interpolateGameState();

  // 4. Render current frame
  render();

  // 5. Request next frame
  requestAnimationFrame(guestLoop);
}
```

**Decoupling:**
- Host ticks at fixed rate (60 Hz) running game logic + rendering
- Guests render at display refresh rate (60-144 Hz)
- Guests interpolate between host state updates
- Local input prediction makes controls feel responsive

## State Management

### Game State Structure

```typescript
interface GameState {
  // Match info
  matchId: string;
  mapId: number;
  mode: 'ffa' | 'team';
  phase: 'waiting' | 'countdown' | 'playing' | 'results';

  // Players
  players: Map<PlayerId, PlayerState>;

  // Entities
  items: Map<ItemId, ItemState>;
  projectiles: Map<ProjectileId, ProjectileState>;
  portals: [Portal, Portal];
  mapHazards: MapHazard[]; // Mano, Bandas, etc.

  // Field state
  trails: TrailMap; // Pixel data for collision

  // Scores
  scores: Map<PlayerId, number>;

  // Timing
  frameNumber: number;
  timestamp: number;
}
```

See [game-state.md](./game-state.md) for complete structure.

### State Synchronization Strategy

**Full state snapshots** (every N ticks):
- Complete game state sent to clients
- Used for synchronization and correction
- Larger payload but guaranteed consistency

**Delta updates** (between snapshots):
- Only changed data sent
- More efficient bandwidth usage
- Requires reliable ordering

**Hybrid approach** (recommended):
- Full snapshot every 1-2 seconds
- Delta updates at tick rate (60 Hz)
- Clients can recover from missed packets

## Rendering Strategy

### Trail Rendering

**Pixel-based approach:**
- Use Canvas 2D `ImageData` for direct pixel manipulation
- Each frame:
  1. Get current pixel data
  2. Draw new player positions as pixels
  3. Draw other entities on top
  4. Put pixel data back to canvas

**Alternative: Sprite-based trails:**
- Store trail segments as line primitives
- Render using Canvas `stroke()` operations
- May be faster but less faithful to original

**Decision:** Start with pixel-based for authenticity, optimize if needed.

### Layer System

```
┌─────────────────────────┐
│  UI Layer (HUD/Text)    │  ← Canvas/DOM overlay
├─────────────────────────┤
│  Effects Layer          │  ← Explosions, particles
├─────────────────────────┤
│  Entity Layer           │  ← Players, items, projectiles
├─────────────────────────┤
│  Trail Layer            │  ← Pixel-based trails
├─────────────────────────┤
│  Background Layer       │  ← Static map background
└─────────────────────────┘
```

**Implementation:**
- Single canvas with multiple draw passes, OR
- Multiple stacked canvases for optimization
- Decision deferred to implementation

See [rendering.md](./rendering.md) for details.

## Collision Detection

### Trail Collision

**Pixel-perfect detection:**
```typescript
function checkCollision(x: number, y: number, playerColor: number): boolean {
  const pixel = trailData.getPixel(x, y);

  if (pixel === 0) return false; // Empty
  if (pixel === playerColor && player.hasCrossing) return false;

  return true; // Collision!
}
```

**Optimization:**
- Only check pixels where player actually moved
- Use dirty rectangles for updated regions
- Spatial partitioning if needed (unlikely for 750x600)

### Entity Collision

**Bounding box + pixel check:**
- First pass: AABB collision between entities
- Second pass: Pixel-perfect check if boxes overlap
- Efficient for items, projectiles, hazards

See [collision.md](./collision.md) for full algorithm.

## Input Handling

### All Clients (Local Input)

```typescript
interface Input {
  frame: number;        // Client frame when input occurred
  playerId: string;
  action: 'left' | 'right' | 'fire';
  pressed: boolean;
  timestamp: number;
}
```

**Input buffering (all clients):**
- Queue inputs locally
- Apply immediately for prediction
- Keep history for reconciliation

### Guest Clients → Host

**Sending inputs:**
- Send input to host via WebRTC data channel immediately
- Use unreliable channel for responsiveness
- Include sequence number for ordering

### Host (Input Processing)

**Input processing:**
1. Receive inputs from all guests via WebRTC
2. Combine with own inputs
3. Validate (is player alive? is action legal?)
4. Apply all inputs to authoritative game state
5. Broadcast updated state to all guests

**Anti-cheat (limited in P2P):**
- Host validates inputs (basic sanity checks)
- Rate limiting on input frequency
- Note: Full anti-cheat harder in P2P (host could cheat)
  - Acceptable for friendly games
  - Could add peer validation later if needed

## Networking Protocol

### PeerJS Connection (Handled Automatically!)

PeerJS handles all the WebRTC signaling automatically. We just need to:
```typescript
// Host
const peer = new Peer('room-abc123');
peer.on('connection', (conn) => {
  // New player connected!
  conn.on('data', handleGuestMessage);
});

// Guest
const peer = new Peer();
const conn = peer.connect('room-abc123');
conn.on('data', handleHostMessage);
```

### Game Messages (Peer-to-Peer via PeerJS)

```typescript
// Guest → Host (via WebRTC)
type GuestToHostMessage =
  | { type: 'input', input: Input }
  | { type: 'ready' }
  | { type: 'chat', message: string }; // Optional

// Host → Guest (via WebRTC)
type HostToGuestMessage =
  | { type: 'state', state: GameState | DeltaState, frame: number }
  | { type: 'start_game', countdown: number }
  | { type: 'event', event: GameEvent } // Player died, item spawned, etc.
  | { type: 'end_game', winner: string };
```

**Protocol notes:**
- PeerJS handles all WebRTC setup automatically
- We send/receive plain JavaScript objects (PeerJS handles serialization)
- Data is sent over PeerJS's data channel (WebRTC underneath)
- Type-safe message parsing with TypeScript discriminated unions
- Optional: Add version field for protocol evolution

**PeerJS Benefits:**
- No WebRTC boilerplate (offers, answers, ICE candidates handled)
- Automatic serialization (just send objects)
- Connection state management
- Fallback to older browsers

See [multiplayer.md](./multiplayer.md) for complete protocol spec.

## Performance Considerations

### Target Performance

- **Client rendering**: 60 FPS minimum, 120+ ideal
- **Host tick rate**: 60 Hz (matches original 70 FPS closely)
- **Network latency**: Playable up to 100ms, good under 50ms (P2P is often better!)
- **Bandwidth**: <30 KB/s per client (P2P, optimized)

### Optimization Strategies

**Rendering:**
- Only redraw changed regions (dirty rectangles)
- Reuse canvas contexts
- Batch draw operations
- Offscreen canvas for compositing

**Networking:**
- Delta compression for state updates
- Binary protocol instead of JSON (if needed)
- Adaptive update rate based on action intensity
- Use unreliable data channels for non-critical data

**Memory:**
- Object pooling for projectiles, particles
- Reuse arrays instead of allocating new ones
- Clear old trails periodically (if memory becomes issue)

### Scaling

**Game size:** 2-4 players per room (matches original)

**P2P Mesh topology:**
- Works perfectly for small player counts
- Each client connects to all others (mesh)
- 4 players = 6 total connections (manageable)
- No server bottleneck for game data

**PeerJS public servers:**
- PeerJS cloud service handles all signaling (free!)
- Can support thousands of concurrent connections
- Once P2P connected, PeerJS server not actively used
- If PeerJS ever has issues, can switch to self-hosted PeerServer
- Or use alternative service (Trystero, simple-peer, etc.)

## Asset Pipeline

### Graphics

**Source format:** Original FPG files (Div2 format)
**Target format:**
- PNG spritesheets for items, UI elements
- SVG for resolution-independent UI (optional)
- Solid colors for trails (generated programmatically)

**Conversion:**
- Extract graphics from FPG using custom tool or manual export
- Maintain original pixel art style (no smoothing/filtering)
- Organize into logical spritesheets

### Audio

**Source format:** WAV files
**Target format:**
- Keep as WAV or convert to MP3/OGG for compression
- Use Web Audio API for playback
- Preload all sounds (small total size)

### Fonts

**Source format:** FNT files (Div2 format)
**Target format:**
- Bitmap font (PNG + JSON descriptor), or
- Web font (WOFF2) if we redraw the fonts
- Maintain retro look

## Development Phases

### Phase 1: Core Mechanics (Local)
*Goal: Prove the core gameplay works in browser*

- Single-player game loop
- Basic rendering (trails, player movement)
- Collision detection
- One test map
- Essential items (shield, crossing)
- No networking

**Deliverables:**
- Playable single-player demo
- Validated rendering approach
- Performance baseline

### Phase 2: Multiplayer Foundation
*Goal: Get basic online play working*

- PeerJS integration (super simple!)
- Room system (create/join via shareable links)
- Host/guest architecture
- Basic state synchronization
- 2-player networked game
- Simple prediction/interpolation

**Deliverables:**
- 2-player online demo via PeerJS
- P2P protocol working
- Shareable room links
- No server deployment needed!

### Phase 3: Complete Feature Set
*Goal: Implement all original game features*

- All items and weapons
- All maps and hazards
- 4-player support
- Team mode
- Full UI (menus, results)
- Audio integration

**Deliverables:**
- Feature-complete game
- All original mechanics implemented

### Phase 4: Polish & Optimization
*Goal: Production-ready quality*

- Performance optimization
- Network optimization
- Browser compatibility testing
- UX improvements
- Bug fixes
- Deployment setup

**Deliverables:**
- Stable, polished game
- Deployment documentation
- Player-facing documentation

## Deployment

### Hosting (Incredibly Simple!)

**Client (Static Files) - That's It!**
- Static hosting (Vercel, Netlify, GitHub Pages, Cloudflare Pages)
- CDN distribution for global reach
- Simple build: `npm run build` → static files
- **Cost: FREE**

**No Server Needed!**
- PeerJS cloud handles all signaling (free!)
- No backend code to deploy
- No databases to manage
- No server monitoring

### Infrastructure

```
                    ┌──────────────┐
   Players ────────►│  CDN/Static  │ (Just HTML/CSS/JS)
                    │  Hosting     │
                    └──────┬───────┘
                           │
            (Loads PeerJS library from CDN)
                           │
                           ▼
                    ┌──────────────┐
                    │   PeerJS     │ (Free public service)
                    │   Cloud      │
                    └──────┬───────┘
                           │
                    (Initial setup only)
                           │
                           ▼
              ┌────────────┴────────────┐
              │   WebRTC P2P Mesh       │
              │  (Direct connections)   │
              │  Player 1 ↔ Player 2    │
              │  Player 1 ↔ Player 3    │
              │  Player 2 ↔ Player 3    │
              └─────────────────────────┘
```

**Deployment Options (all FREE!):**

1. **GitHub Pages** (easiest)
   ```bash
   npm run build
   npm run deploy  # Pushes to gh-pages branch
   # Done! Live at: https://username.github.io/tron-revival
   ```

2. **Vercel** (automatic)
   - Connect GitHub repo
   - Auto-deploys on push
   - Custom domain support
   - https://tron-revival.vercel.app

3. **Netlify** (drag & drop)
   - Drag dist/ folder
   - Or connect Git repo
   - https://tron-revival.netlify.app

**Total infrastructure cost: $0/month** 🎉

### Configuration

```typescript
// Minimal config needed
const config = {
  // PeerJS cloud (free)
  peerServerHost: 'peerjs.com',
  peerServerPort: 443,
  peerServerPath: '/',
  peerServerSecure: true,

  // Or use custom PeerServer if needed (optional)
  // peerServerHost: 'your-peerserver.com',
};
```

**No environment variables needed!** (unless using custom PeerServer)

## Open Questions

These will be resolved during implementation:

1. **Host update rate:** 30 Hz, 60 Hz, or adaptive?
2. **State snapshot frequency:** How often to send full state vs deltas?
3. **PeerJS reliability:** Use PeerJS's default settings or configure data channels?
4. **Client prediction scope:** Predict just local player, or all entities?
5. **Data format:** JSON (easier to debug) or binary (more efficient)?
6. **Multiple canvas layers:** Single or multiple canvases?
7. **Asset loading strategy:** Preload all, or lazy load by map?
8. **Browser testing scope:** How far back do we support? (probably just evergreen)
9. **Host migration:** What happens if host disconnects? (probably just end game for MVP)
10. **PeerServer fallback:** Self-host PeerServer if PeerJS cloud has issues, or use alternative?

## Next Steps

1. Create detailed design documents:
   - [ ] `multiplayer.md` - PeerJS P2P protocol and synchronization
   - [ ] `game-state.md` - Complete state structure and transitions
   - [ ] `rendering.md` - Canvas rendering implementation
   - [ ] `collision.md` - Collision detection algorithms

2. Set up project (super simple!):
   - [ ] `npm create vite@latest tron-revival -- --template vanilla-ts`
   - [ ] `npm install peerjs` (only dependency!)
   - [ ] Set up folder structure (src/game, src/render, src/network, etc.)
   - [ ] Configure TypeScript

3. Begin Phase 1 implementation:
   - [ ] Basic game loop (single player / local multiplayer first)
   - [ ] Player movement
   - [ ] Trail rendering
   - [ ] Collision detection

## Summary of Pure P2P Architecture Benefits

**Cost savings:**
- **Zero infrastructure costs** - no servers at all!
- Free static hosting (GitHub Pages, Vercel, Netlify)
- PeerJS cloud handles signaling (free!)
- Total: **$0/month** to run

**Simplicity:**
- **Single TypeScript codebase** - no backend code
- One package.json, one build command
- No server deployment, monitoring, or maintenance
- Just: `npm run build` → upload to static host → done!

**Performance:**
- Lower latency (direct P2P connections, no server hop)
- No server bottleneck for game data
- Scales naturally (each game is independent)

**Developer Experience:**
- All code in one language (TypeScript)
- No API contracts to maintain
- Simpler debugging (all code runs in browser)
- Faster iteration (no server restarts)

**Tradeoffs (acceptable for this game):**
- Host can theoretically cheat → Fine for friendly games
- Host leaving ends game → Add migration later if needed
- Limited to 2-4 players → Perfect for our game design!
- Relies on PeerJS service → Can self-host PeerServer if needed

**This is the ideal architecture for a small multiplayer game like Teratron!**
