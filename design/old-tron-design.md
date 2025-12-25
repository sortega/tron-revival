# Teratron Original Game Design

This document describes the complete mechanics of the original Teratron game written in Div2 for MS-DOS (dated 09/08/01).

## Game Overview

**Teratron** (also titled "TERA-TRON") is a multiplayer Tron-style game where 2-4 players control vehicles that leave colored trails behind them. Players die when they collide with any trail (including their own), with the last player standing winning the round.

### Core Concept

- Players navigate an arena leaving pixel trails
- Collision with any trail = death
- Arena has wraparound edges (toroidal topology)
- Items spawn that grant power-ups and weapons
- Multiple maps with unique hazards

## Game Modes

### 1. Free-For-All (2-4 players)
- Every player for themselves
- Last survivor wins
- Available for 2, 3, or 4 players

### 2. Team Battle (2v2)
- 4 players in two teams:
  - **Violetas** (Purples): Players 0 & 2
  - **Marrones** (Browns): Players 1 & 3
- Last team with surviving members wins
- Team scores combined

## Players

### Player Names and Colors

**Free-for-all mode:**
- Player 0: "Rojo" (Red) - Color index 52
- Player 1: "Verde" (Green) - Color index 114
- Player 2: "Azul" (Blue) - Color index 32
- Player 3: "Amarillo" (Yellow) - Color index 60

**Team vs mode:**
- Players 0 & 2: Color index 80 (Purple team)
- Players 1 & 3: Color index 215 (Brown team)

### Starting Positions (by player count)

**2 Players:**
- Player 0: Top-left corner (50, 50) facing SE (-45°)
- Player 1: Bottom-right corner (700, 550) facing NW (135°)

**3 Players:**
- Player 0: Top-left corner (50, 50) facing SE (-45°)
- Player 1: Top-right corner (700, 50) facing SW (225°)
- Player 2: Bottom-left corner (50, 550) facing NE (45°)

**4 Players:**
- Player 0: Top-left corner (50, 50) facing SE (-45°)
- Player 1: Top-right corner (700, 50) facing SW (225°)
- Player 2: Bottom-left corner (50, 550) facing NE (45°)
- Player 3: Bottom-right corner (700, 550) facing NW (135°)

## Controls

### Default Keyboard Bindings

- **Player 0**: Z (left turn), X (right turn), Left Control (action)
- **Player 1**: Left Arrow (left), Right Arrow (right), Insert (action)
- **Player 2**: L (left), Semicolon (right), K (action)
- **Player 3**: Delete (left), Enter (right), Numpad Plus (action) OR Mouse (left/right movement + left click for action)

### Control Mechanics

- Turn rate: 4000 units per frame (in a 360000-unit circle)
- Movement: 1 unit per frame at normal speed
- Turning is relative (left/right), not absolute directional

## Technical Specs

### Screen Layout

- **Total resolution**: 800x600 pixels
- **Game area (Region 1)**: 750x600 pixels (left side)
- **Panel area (Region 2)**: 50x600 pixels (right side, starts at x=750)
- **Target frame rate**: 70 FPS

### Coordinate System

- Internal coordinates: integers multiplied by 1000 for sub-pixel precision
- Display coordinates: rounded to nearest pixel (500+ rounds up)
- Angles: 0-360000 units (1000 units = 1 degree)
  - 0° = right/east
  - 90000 = up/north
  - 180000 = left/west
  - 270000 = down/south

### Wraparound Mechanics

- X coordinate wraps: 0 ↔ 750
- Y coordinate wraps: 0 ↔ 600
- Players, projectiles, and effects wrap seamlessly
- Creates toroidal (donut-shaped) playing field

## Items

Items spawn randomly throughout the match. Initial spawn: 6 items. Then random spawning every 200-800 frames.

### Spawn Probability

- 40% chance: Automatic items (types 1-7 randomly)
- 50% chance: Weapon items (weighted distribution)
- 10% chance: No item spawns

### Automatic Items (clase 0)

These activate immediately when picked up.

#### 1. Cruces (Crossing) - Graph 110
- **Effect**: Allows player to cross their own trail without dying
- **Duration**: 2100 frames (~30 seconds at 70 FPS)
- **Display**: Shows cross icon + timer in player's panel section
- **Sound**: shield.wav

#### 2. Escudo (Shield) - Graph 111
- **Effect**: Complete invincibility - no collision damage
- **Duration**: 2100 frames (~30 seconds)
- **Display**: Shows shield icon + timer in player's panel section
- **Stacking**: Resets timer if already shielded
- **Sound**: shield.wav

#### 3. Borrador (Eraser) - Graph 112
- **Effect**: Instantly clears all trails from the map
- **Duration**: Instant
- **Side effect**: Also removes any "Cerradura" (border lock) effects
- **Sound**: reset.wav

#### 4. Cambiazo (Swap) - Graph 113
- **Effect**: All living players swap positions and directions
- **Mechanic**: Players rotate positions (0→1→2→3→0)
- **Duration**: Instant

#### 5. Controles Trastornados (Control Reversal) - Graph 114
- **Effect**: Reverses left/right controls for the victim
- **Duration**: 700 frames (~10 seconds)
- **Note**: Only affects player who picked it up (self-debuff!)

#### 6. Rapidez (Speed Boost) - Graph 115
- **Effect**: Increases movement speed by 50%
- **Duration**: 1400 frames (~20 seconds)
- **Mechanic**: Reduces `vel` value by 50 (lower = faster)
- **Sound**: turbo.wav

#### 7. Lentitud (Slowness) - Graph 116
- **Effect**: Decreases movement speed by 50%
- **Duration**: 1400 frames (~20 seconds)
- **Mechanic**: Increases `vel` value by 50 (higher = slower)
- **Sound**: lento.wav

### Weapon Items (clase 1)

These require the player to press the action button to use. Ammo displayed in panel.

#### 1. Tiros (Single Shots) - Graph 117
- **Ammo**: 20 shots
- **Fire mode**: Press action button to shoot
- **Effect**: Fires single projectile in facing direction
- **Projectile**: Small explosion on impact, clears 10x10 pixel area
- **Kills**: Players within 6 pixels of impact
- **Sound**: armado.wav (equip), tiro.wav (fire), explosion.wav (impact)

#### 2. Fusil (Rifle) - Graph 118
- **Ammo**: 200 shots
- **Fire mode**: Automatic burst - fires 5-shot burst every 20 frames while held
- **Effect**: Rapid-fire projectiles
- **Projectile**: Each bullet travels ~120 frames, speed 5 units/frame
- **Sound**: armado.wav (equip), fusil.wav (every 20 frames)

#### 3. Ametralladora (Machine Gun) - Graph 119
- **Ammo**: 700 shots
- **Fire mode**: Hold action button for continuous spray
- **Effect**: Sprays 20 bullets per frame with random spread (±30° deviation)
- **Projectile speed**: 10-50 units/frame (random)
- **Projectile life**: 10 frames each
- **Sound**: armado.wav (equip), straya.wav (continuous while firing)

#### 4. Misil H (Heavy Missile) - Graph 120
- **Ammo**: 1 shot
- **Fire mode**: Press action to launch
- **Effect**: Large devastating explosion clearing 120x120 pixel area
- **Kills**: Players within 50 pixels (accounting for wraparound)
- **Side effect**: Destroys all items in 70 pixel radius
- **Sound**: armado.wav (equip), bombava.wav (launch), explosion.wav (impact)

#### 5. Cerrar Bordes (Lock Borders) - Graph 121
- **Ammo**: 1 use
- **Fire mode**: Press action to activate
- **Effect**: Draws deadly lines around all four edges of the arena
- **Pattern**: Lines drawn in segments over 150 frames
  - Horizontal lines at y=0 and y=599
  - Vertical lines at x=0 and x=749
- **Duration**: Active until destroyed by "Borrador" item
- **Color**: Uses the color of the player who activated it
- **Sound**: alarma.wav (continuous during drawing)

#### 6. Escopeta (Shotgun) - Graph 122
- **Ammo**: 20 shots
- **Fire mode**: Press action button to shoot
- **Effect**: Fires spread of 30 pellets
- **Projectile**: Each pellet has random deviation (±5° spread)
- **Projectile speed**: 10-30 units/frame (random per pellet)
- **Projectile life**: 10 frames each
- **Sound**: armado.wav (equip), escopeta.wav (fire)

#### 7. Velocidad (Turbo Boost) - Graph 123
- **Ammo**: 700 frames worth
- **Fire mode**: Hold action button to activate
- **Effect**: Temporarily increases speed while held
- **Mechanic**: Reduces `vel` by 50 while active
- **Display**: Shows ammo counter (frames remaining / 70)
- **Sound**: turbo.wav (on activation)

### Weapon Spawn Distribution

Weapon type spawn weights (from original ItemLauncher code):
- Type 1 (Shots): 20% (cases 0-19)
- Type 2 (Rifle): 15% (cases 20-34)
- Type 3 (Machine gun): 20% (cases 35-54)
- Type 5 (Lock borders): 10% (cases 55-64)
- Type 6 (Shotgun): 15% (cases 65-79)
- Type 7 (Turbo): 20% (cases 80-99)
- Type 4 (Heavy missile): Remainder (default case - rare!)

## Maps

8 maps total, cycling through maps 200-207.

### Standard Maps (200-204)
- Basic arenas with static obstacles
- Obstacles read from map graphic control points

### Special Maps

#### Map 205: Mano (Hand)
- **Feature**: A giant hand (graph 7) that chases players
- **Behavior**:
  - Moves to random map positions marked by control points
  - Stays at each location briefly, vibrating
  - Kills players on contact (flags=4 when touching)
  - Returns to corner (800, 600) between hunting phases
- **Sound**: torno.wav (while at target location)

#### Map 206: Guerra (War)
- **Feature**: Random explosions across the battlefield
- **Behavior**:
  - 1/200 chance per frame to spawn explosion
  - Explosions spawn at predefined points (control points 1-4)
  - Each explosion spawns 30 pellets
- **Sound**: explosion.wav

#### Map 207: Bandas (Bands)
- **Feature**: Moving barriers that extend/retract
- **Behavior**:
  - Up to 6 bands placed at control point positions
  - Each band alternates between hidden and extended (graph 30-39)
  - Cycle: Closed (200 frames) → Opening (30 frames) → Open (200 frames) → Closing (30 frames)
  - Kills players on contact
  - Bands at even positions phase at 90° offset from odd positions

### Portal System (All Maps)

Every map spawns two **Bocas** (portals):
- **Appearance**: Animated mouths (boom.fpg, graphs 100-129)
- **Function**: Teleport players and projectiles between them
- **Mechanics**:
  - Player entering portal 0 exits from portal 1 (and vice versa)
  - Projectiles also teleport
  - "Traya" particles can teleport
  - Exit position: 15 units from portal center in current travel direction
- **Sound**: wc.wav (when player teleports)

## Collision System

### Death Conditions

A player dies when:
1. Colliding with any colored pixel (trail) that isn't their own color (unless they have "Cruces")
2. Colliding with their own color pixel without "Cruces" active
3. Colliding with another player's process
4. Being hit by projectile/explosion
5. Touching special map hazards (Mano, Bandas)
6. Colliding with "Traya" particles

### Protection

Players are protected from collision death when:
- **Escudo** (shield) is active: Complete invincibility
- **Cruces** (crossing) is active: Can cross own trail only

### Diagonal Movement Collision

Special check for diagonal moves:
- If moving diagonally (both x and y change)
- Check all pixels in the 2x2 area between old and new position
- Die if 2+ pixels are non-empty (chungo)
- Prevents "threading the needle" through corners

## Game Flow

### 1. Startup Sequence
1. Load assets (graphics, fonts, sounds)
2. Show splash screen (fotos.fpg, graph 3)
3. Play intro animation (Intro.fli)
4. Display main menu

### 2. Main Menu
- Option 1: Play (2 players)
- Option 2: Play (3 players)
- Option 3: Play (4 players)
- Option 4: Play (2 vs 2 teams)
- Option 6: Exit (Puerta)

### 3. Round Start
1. Load map background
2. Spawn players at starting positions
3. Play inicio.wav sound
4. Wait for all players to become "vivo" (alive)
5. Start item launcher
6. Begin gameplay

### 4. During Round
- Players move and leave trails
- Items spawn randomly
- Map hazards activate
- Portals teleport entities

### 5. Round End
- Game continues until 1 player/team remains
- OR all players die simultaneously (tie)
- Player death plays uah.wav + explosion animation
- Winner gets +1 point

### 6. Results Screen
Shows:
- Winner announcement (or "Empate" for tie)
- All player scores
- "¿Otra? (y/n)" prompt

If player chooses yes:
- Advance to next map (wrapping after map 207)
- Start new round with same player count
- Scores persist

If player chooses no:
- Return to main menu
- Scores reset

## Audio

### Sound Effects
- **inicio.wav**: Round start
- **escopeta.wav**: Shotgun fire
- **armado.wav**: Weapon equipped
- **tiro.wav**: Single shot fire
- **traya.wav**: Machine gun spray (looping)
- **boom.wav** / **explosion.wav**: Explosions
- **bombava.wav**: Heavy missile launch
- **alarma.wav**: Border lock drawing (looping)
- **reset.wav**: Eraser activation
- **turbo.wav**: Speed boost
- **lento.wav**: Slowness
- **escudo.wav** / **shield.wav**: Shield/crossing pickup
- **fusil.wav**: Rifle burst
- **uah.wav**: Player death
- **wc.wav**: Portal teleport
- **torno.wav**: Hand grinding sound (looping)

## Panel Display (Right Side)

Each player gets a 50px × 150px section showing:
- Player number position: `player_num × 150 + offset`
- Active power-up icons:
  - **Graph 10**: Cruces icon (at y offset +30)
  - **Graph 11**: Escudo icon (at y offset +75)
  - Countdown timers shown next to icons
- Weapon info:
  - **Weapon icon**: Graph 17-23 (at y offset +120)
  - **Ammo counter**: Numeric display

## Miscellaneous Mechanics

### Speed System
- **Normal speed**: `vel = 100`
- **Lower values** = faster movement
- **Higher values** = slower movement
- Speed modifiers stack with base speed

### Frame Timing
- Most effects: 100 frame units (default)
- Fast actions: 10 frame units
- Slow actions: 150 frame units

### Score Tracking
- Scores persist across rounds in same session
- Team mode: Individual scores tracked, team total shown
- Scores reset when returning to main menu

### Options System (Partially Implemented)
- Can save preferred starting map
- Saved to "opciones.dat" file
- Loading screen shows map preview at reduced scale (37%)

## Assets Referenced

### Graphics Files
- **tron.fpg**: Main game graphics
  - Graph 1-3: Menu backgrounds
  - Graph 4: Heavy missile
  - Graph 5: Regular shot
  - Graph 6: Map preview hole
  - Graph 7: Hand (Mano)
  - Graph 10-11: Power-up icons
  - Graph 17-23: Weapon icons
  - Graph 30-39: Banda animation
  - Graph 109-116: Automatic items
  - Graph 117-123: Weapon items
  - Graph 124: Mystery item
  - Graph 200-207: Maps

- **boom.fpg**: Explosion and portal animations
  - Graph 1-39: Explosion frames
  - Graph 100-129: Portal animation

### Font Files
- **titlefon.fnt**: Main menu text
- **panelfon.fnt**: Score and panel text
- **opcionfon.fnt**: Options screen text

### Animation Files
- **Intro.fli**: Intro animation (FLI format)

## Notes for Modern Implementation

### Key Characteristics to Preserve
1. **Pixel-perfect collision**: Trails are actual pixels, not abstract entities
2. **Sub-pixel precision**: Smooth movement despite pixel-based rendering
3. **Wraparound topology**: Seamless edge wrapping
4. **Simultaneous multiplayer**: All players move in same frame
5. **Twitch gameplay**: Fast reaction times required
6. **Item chaos**: Random items create dynamic situations

### Potential Improvements for Web Version
- Network latency handling (not in original)
- Spectator mode
- Replay system
- More flexible control mapping
- Gamepad support
- Resolution scaling options
- More maps
- Match statistics

### Technical Challenges
- Maintaining pixel-perfect collision in browser
- Ensuring smooth 70 FPS across devices
- Network synchronization for multiplayer
- Asset conversion from legacy formats (FPG, FLI, FNT)
