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

### Backend Framework

**Node.js + Express + Socket.io**
- **Express**: HTTP server for static files and room management
- **Socket.io**: WebSocket communication with fallbacks
  - Automatic reconnection
  - Event-based API
  - Room support built-in
  - Widely used and stable

**Alternative**: Raw WebSocket API
- More control, less abstraction
- Consider if Socket.io proves too heavy
- Defer decision to implementation phase

### Build Tools

- **Vite**: Fast dev server and production builds
  - Native ESM support
  - TypeScript out of the box
  - Fast HMR for development
  - Simple configuration

- **Package Manager**: npm or pnpm
  - Monorepo structure with workspaces

## System Architecture

### High-Level Overview

```
┌─────────────────┐         ┌─────────────────┐
│  Client (Web)   │◄───────►│  Game Server    │
│                 │  WS/WS  │   (Node.js)     │
│  - Rendering    │         │                 │
│  - Input        │         │  - Game State   │
│  - Prediction   │         │  - Physics      │
│  - Interpolation│         │  - Validation   │
└─────────────────┘         └─────────────────┘
        │                            │
        │                            │
        ▼                            ▼
┌─────────────────┐         ┌─────────────────┐
│  Local State    │         │  Room Manager   │
│  - Predicted    │         │  - Lobbies      │
│  - Rendering    │         │  - Sessions     │
└─────────────────┘         └─────────────────┘
```

### Client-Server Model

**Authoritative Server**
- Server is the source of truth for game state
- All game logic runs on server
- Clients send inputs, receive state updates
- Server validates all actions

**Why authoritative?**
- Prevents cheating
- Ensures consistency across clients
- Simpler conflict resolution
- Standard for multiplayer games

### Network Architecture

See detailed design: [multiplayer.md](./multiplayer.md) *(to be created)*

**Key decisions:**
- **Room-based matchmaking**: Players create/join rooms via shareable links
- **State synchronization**: Server broadcasts game state at fixed rate (e.g., 30-60 Hz)
- **Input handling**: Clients send input events, server processes immediately
- **Latency handling**:
  - Client-side prediction for local player
  - Server reconciliation for corrections
  - Interpolation for remote players

**Room System:**
```
Room ID (generated) → http://teratron.example.com/room/abc123

Players join → Lobby (waiting room)
            → Game (active match)
            → Results (post-game)
```

## Code Organization

### Monorepo Structure

```
tron-revival/
├── packages/
│   ├── client/          # Browser game client
│   │   ├── src/
│   │   │   ├── game/    # Core game rendering & logic
│   │   │   ├── network/ # Network client
│   │   │   ├── ui/      # Menus, lobby, etc.
│   │   │   └── main.ts
│   │   └── index.html
│   │
│   ├── server/          # Game server
│   │   ├── src/
│   │   │   ├── game/    # Server-side game logic
│   │   │   ├── network/ # WebSocket server
│   │   │   ├── rooms/   # Room management
│   │   │   └── main.ts
│   │   └── package.json
│   │
│   └── shared/          # Shared code (types, constants, utilities)
│       ├── src/
│       │   ├── types/   # Game state types, network messages
│       │   ├── constants.ts
│       │   └── utils.ts
│       └── package.json
│
├── design/              # Design documents (this folder)
├── old-tron/            # Original game reference
├── assets/              # Game assets (graphics, sounds)
├── CLAUDE.md
├── package.json         # Root package for monorepo
└── README.md
```

### Shared Code

**What goes in `shared/`:**
- Type definitions (game state, network messages)
- Constants (map dimensions, item types, speeds)
- Pure utility functions (collision detection, coordinate math)
- Game rules that must match client/server

**What doesn't:**
- Rendering code (client only)
- Network server logic (server only)
- DOM manipulation (client only)

### Key Modules

See detailed designs:
- [game-state.md](./game-state.md) *(to be created)* - State management
- [rendering.md](./rendering.md) *(to be created)* - Canvas rendering approach
- [collision.md](./collision.md) *(to be created)* - Pixel-perfect collision
- [multiplayer.md](./multiplayer.md) *(to be created)* - Network protocol

## Game Loop Architecture

### Server Game Loop

```typescript
// Authoritative game loop on server
const TICK_RATE = 60; // Server updates per second
const TICK_INTERVAL = 1000 / TICK_RATE;

function serverTick() {
  // 1. Process player inputs (queued from network)
  processInputs();

  // 2. Update game state
  updatePlayers();
  updateProjectiles();
  updateItems();
  checkCollisions();

  // 3. Broadcast state to all clients
  broadcastGameState();

  // 4. Schedule next tick
  setTimeout(serverTick, TICK_INTERVAL);
}
```

### Client Game Loop

```typescript
// Client rendering loop (separate from server tick)
function clientLoop(timestamp) {
  // 1. Send inputs to server
  sendPendingInputs();

  // 2. Apply client-side prediction
  predictLocalPlayer();

  // 3. Interpolate remote entities
  interpolateRemotePlayers();

  // 4. Render current frame
  render();

  // 5. Request next frame
  requestAnimationFrame(clientLoop);
}
```

**Decoupling:**
- Server ticks at fixed rate (e.g., 60 Hz)
- Client renders at display refresh rate (60-144 Hz)
- Interpolation/extrapolation bridges the gap

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

### Client Side

```typescript
interface Input {
  frame: number;        // Client frame when input occurred
  playerId: string;
  action: 'left' | 'right' | 'fire';
  pressed: boolean;
  timestamp: number;
}
```

**Input buffering:**
- Queue inputs locally
- Send to server immediately
- Keep history for prediction/reconciliation

### Server Side

**Input processing:**
1. Receive input from network
2. Validate (is this player alive? is action legal?)
3. Apply to game state
4. Include in next state broadcast

**Anti-cheat:**
- Server validates all inputs
- Rate limiting on input frequency
- Sanity checks on player state changes

## Networking Protocol

### Message Types

```typescript
// Client → Server
type ClientMessage =
  | { type: 'join', playerName: string }
  | { type: 'input', input: Input }
  | { type: 'ready' }
  | { type: 'leave' };

// Server → Client
type ServerMessage =
  | { type: 'joined', playerId: string, gameState: GameState }
  | { type: 'state', state: GameState | DeltaState }
  | { type: 'event', event: GameEvent } // Player died, item spawned, etc.
  | { type: 'error', message: string };
```

**Event-driven:**
- Use Socket.io events or similar
- Type-safe message parsing
- Versioning for protocol changes

See [multiplayer.md](./multiplayer.md) for complete protocol spec.

## Performance Considerations

### Target Performance

- **Client rendering**: 60 FPS minimum, 120+ ideal
- **Server tick rate**: 60 Hz (matches original 70 FPS closely)
- **Network latency**: Playable up to 100ms, good under 50ms
- **Bandwidth**: <50 KB/s per client (optimized)

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

**Memory:**
- Object pooling for projectiles, particles
- Reuse arrays instead of allocating new ones
- Clear old trails periodically (if memory becomes issue)

### Scaling

**Initial target:** 2-4 players per game (matches original)

**Room capacity:**
- Single server should handle 100+ concurrent rooms
- Each room is independent (no cross-room state)
- Horizontal scaling: Add more servers, use room routing

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

- Client-server architecture
- Room system (create/join)
- Basic state synchronization
- 2-player networked game
- Simple prediction/interpolation

**Deliverables:**
- 2-player online demo
- Network protocol established
- Room management working

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

### Hosting Options

**Client:**
- Static hosting (Vercel, Netlify, GitHub Pages)
- CDN distribution
- Simple build: `npm run build` → static files

**Server:**
- VPS (DigitalOcean, Linode, AWS EC2)
- Container platform (Docker, Fly.io)
- Needs WebSocket support
- Modest requirements (1-2 CPU cores, 1-2 GB RAM to start)

### Infrastructure

```
                    ┌──────────────┐
   Players ────────►│  CDN/Static  │
                    │  (Client)    │
                    └──────┬───────┘
                           │
                           ▼
                    ┌──────────────┐
                    │ Game Server  │◄──── WebSocket
                    │  (Node.js)   │
                    └──────────────┘
```

**Simplest setup:**
- Client: Vercel/Netlify (free tier)
- Server: Single VPS ($5-10/month)
- Domain: Point to both (separate subdomains or paths)

### Environment Configuration

```typescript
// Client config
const config = {
  serverUrl: process.env.VITE_SERVER_URL || 'ws://localhost:3000',
  // ...
};

// Server config
const config = {
  port: process.env.PORT || 3000,
  corsOrigins: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:5173'],
  // ...
};
```

## Open Questions

These will be resolved during implementation:

1. **Exact network update rate:** 30 Hz, 60 Hz, or adaptive?
2. **State snapshot frequency:** How often to send full state vs deltas?
3. **Client prediction scope:** Predict just local player, or all entities?
4. **Binary vs JSON protocol:** Optimize if needed
5. **Multiple canvas layers:** Single or multiple canvases?
6. **Asset loading strategy:** Preload all, or lazy load by map?
7. **Browser testing scope:** How far back do we support? (probably just evergreen)

## Next Steps

1. Create detailed design documents:
   - [ ] `multiplayer.md` - Network protocol and synchronization
   - [ ] `game-state.md` - Complete state structure and transitions
   - [ ] `rendering.md` - Canvas rendering implementation
   - [ ] `collision.md` - Collision detection algorithms

2. Set up project structure:
   - [ ] Initialize monorepo
   - [ ] Configure TypeScript
   - [ ] Set up build tools (Vite)
   - [ ] Create package scaffolding

3. Begin Phase 1 implementation:
   - [ ] Basic game loop
   - [ ] Player movement
   - [ ] Trail rendering
   - [ ] Collision detection
