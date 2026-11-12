// TronGameState - Host-authoritative game state manager

import type { SlotIndex, GameMode, LevelMode } from '../types/lobby';
import type {
  TronRoundState,
  TronMatchState,
  TronGameStateData,
  TronInput,
  TrailSegment,
  RoundPhase,
  TeleportPortal,
  GameItem,
  SoundEvent,
  Projectile,
  Explosion,
  Bodyguard,
  ClearedRect,
  DeathCause,
  DeathEvent,
} from '../types/game';
import type { GamePlayer } from '../types/game';
import { anyDoorSolidAt, doorFrame } from './doors';
import { GUN_BURST_CHANCE } from './guns';
import { createHand, stepHand } from './hand';
import type { HandState } from './hand';
import {
  BODYGUARD_HP,
  LEVELS,
  NO_OWNER,
  PORTAL_RADIUS,
  PORTAL_OUTER_RADIUS,
  PORTAL_FRAME_COUNT,
  AUTOMATIC_ITEMS,
  WEAPON_ITEMS,
  ITEM_COLLISION_RADIUS,
} from '../types/game';
import { TronPlayer, getStartingPosition } from './TronPlayer';

/** A solid pixel found on a line: wrapped into the arena, and as it lies on the line. */
type LineHit = { x: number; y: number; rawX: number; rawY: number };

/** The path a tracer travels in one tick, in pixels (the end may lie beyond an edge). */
interface TracerPath {
  ownerSlot: Projectile['ownerSlot'];
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
import { PLAY_WIDTH, PLAY_HEIGHT, READY_LOCK_TICKS, TICK_RATE } from './constants';
import { ItemLauncher } from './ItemLauncher';
import { PixelGrid } from './PixelGrid';
import { TELEPORT_COOLDOWN_FRAMES, findPortalExit, movePlayer, movesForTick, ownTurboBoost, teleportTo } from './movement';
import type { Rng } from './rng';

const COUNTDOWN_SECONDS = 3;
const NO_INPUT: TronInput = { steer: 0, action: false };

// Helper: Check if two line segments intersect (for diagonal collision detection)
// Uses cross product method to detect if segments AB and CD intersect
function segmentsIntersect(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number
): boolean {
  // Direction vectors
  const abx = bx - ax, aby = by - ay;
  const cdx = dx - cx, cdy = dy - cy;
  const acx = cx - ax, acy = cy - ay;

  // Cross products
  const denom = abx * cdy - aby * cdx;

  // Parallel lines (including same line)
  if (denom === 0) return false;

  const t = (acx * cdy - acy * cdx) / denom;
  const u = (acx * aby - acy * abx) / denom;

  // Check if intersection point is within both segments (exclusive of endpoints)
  // Use small epsilon to avoid floating point issues at exact endpoints
  const eps = 0.001;
  return t > eps && t < 1 - eps && u > eps && u < 1 - eps;
}

// True if the player's last move was a normal step (no wrap-around / teleport jump)
function isContiguousMove(p: TronPlayer): boolean {
  return Math.abs(p.getScreenX() - p.prevScreenX) <= 2 && Math.abs(p.getScreenY() - p.prevScreenY) <= 2;
}

export class TronGameState {
  // Players
  players: TronPlayer[] = [];

  // Round state
  phase: RoundPhase = 'countdown';
  countdown: number = COUNTDOWN_SECONDS;
  roundWinner: SlotIndex | 'draw' | null = null;

  // Match state
  scores: Map<SlotIndex, number> = new Map();
  currentRound: number = 1;
  currentLevelIndex: number = 0;
  /** Playing ticks elapsed this round; drives the level's automatic doors */
  doorTick = 0;
  /** The dentist's hand, on the level that has one */
  private hand: HandState | null = null;
  playersReady: Set<SlotIndex> = new Set();
  // Ticks left before action presses count as "ready" (see design/architecture.md)
  private readyLockTicks = 0;
  gameMode: GameMode;
  levelMode: LevelMode;

  // Collision map: trails, level obstacles and locked borders, with their colour
  readonly pixels = new PixelGrid();

  // Ridiculous death tracking (crashing into own color)
  ridiculousDeaths: Map<SlotIndex, number> = new Map();
  // Track ridiculous death events this frame (for sidebar display) - multiple players can have it
  frameRidiculousDeaths: SlotIndex[] = [];

  // Pristine copy of the current level's obstacles. Never modified by gameplay:
  // weapons damage `pixels`, and round start / Eraser restore from this copy.
  private levelObstacles = new PixelGrid();

  // Random source (seedable for tests)
  private readonly rng: Rng;

  // Teleport portals
  portals: TeleportPortal[] = [];
  private nextPortalId = 0;
  private readonly PORTAL_MIN_DISTANCE = 100;       // Minimum distance between portal endpoints
  private readonly PORTAL_MIN_PLAYER_DISTANCE = 80; // Minimum distance from player start positions
  private readonly PORTAL_ANIM_SPEED = 3;           // Advance portal frame every N ticks (slower = higher)
  private portalAnimTick = 0;

  // Items
  items: GameItem[] = [];
  private itemLauncher: ItemLauncher;

  // New trail segments this frame (for network efficiency)
  private frameTrailSegments: Map<SlotIndex, TrailSegment[]> = new Map();

  // Sound events this frame (for network sync)
  private frameSoundEvents: SoundEvent[] = [];

  // Track previous action state for one-shot ready detection
  private prevActionState: Map<SlotIndex, boolean> = new Map();

  // Border lock animations (multiple players can have active locks)
  private borderLocks: Map<SlotIndex, {
    color: string;
    progress: number;  // 0 to 150
  }> = new Map();

  // New border segments this frame (for rendering) - per player with color
  private frameBorderSegments: { color: string; segments: TrailSegment[] }[] = [];

  // Eraser was used this frame
  private frameEraserUsed: boolean = false;

  // Cleared areas this frame (from bullet impacts)
  private frameClearedAreas: ClearedRect[] = [];
  // Cleared lines this frame (tracer paths), flat [x0, y0, x1, y1, ...]
  private frameClearedLines: number[] = [];
  // Deaths this frame, with their cause
  private frameDeaths: DeathEvent[] = [];
  // A new round started this frame (renderer must reset trails)
  private frameRoundStarted: boolean = false;

  // Projectile system
  private projectiles: Projectile[] = [];
  private explosions: Explosion[] = [];
  private nextProjectileId = 0;
  private nextExplosionId = 0;

  // Projectile constants (Glock bullets)
  private readonly BULLET_BASE_SPEED = 5000;  // 5 pixels/frame in fixed-point (at speed factor 1)
  private readonly BULLET_KILL_RADIUS = 6;    // Kill players within 6 pixels
  private readonly BULLET_CLEAR_RADIUS = 5;   // Clear 10x10 area (±5)
  private readonly BULLET_TRACER_RADIUS = 3;  // A bullet explodes when it passes this close to a tracer
  private readonly BULLET_ITEM_DAMAGE_RADIUS = 16; // Damage items within 16 pixels
  private readonly EXPLOSION_FRAMES = 39;     // 39 animation frames

  // Rifle burst state and constants
  private rifleBurstState: Map<SlotIndex, {
    frameCounter: number;      // Counts frames since last burst
    shotsRemaining: number;    // Shots left in current burst (0-5)
    shotDelay: number;         // Delay counter between shots in burst
  }> = new Map();
  private readonly RIFLE_BURST_INTERVAL = 20;   // Frames between bursts
  private readonly RIFLE_SHOTS_PER_BURST = 5;
  private readonly RIFLE_SHOT_DELAY = 1;        // Frames between shots in burst
  private readonly PROJECTILE_OWNER_COOLDOWN = 10; // Frames before owner collision is checked
  private readonly TRACER_LIFESPAN = 120;       // Frames before tracer expires
  private readonly TRACER_KILL_RADIUS = 1;      // Original 1px touch-kill
  private readonly TRACER_CLEAR_RADIUS = 1;     // 3x3 area on death

  // Uzi weapon constants
  private readonly UZI_TRACERS_PER_FRAME = 20;  // Spray 20 bullets per frame
  private readonly UZI_SPREAD_DEGREES = 30;     // ±30° random deviation
  private readonly UZI_MIN_SPEED = 5000;        // 5 pixels/frame in fixed-point
  private readonly UZI_MAX_SPEED = 25000;       // 25 pixels/frame in fixed-point
  private readonly UZI_TRACER_LIFESPAN = 2;     // 2 frames to be visible for at least one render

  // Shotgun weapon constants
  private readonly SHOTGUN_PELLETS = 30;        // 30 pellets per shot
  private readonly SHOTGUN_SPREAD_DEGREES = 5;  // ±5° random deviation
  private readonly SHOTGUN_MIN_SPEED = 10000;   // 10 pixels/frame in fixed-point
  private readonly SHOTGUN_MAX_SPEED = 30000;   // 30 pixels/frame in fixed-point
  private readonly SHOTGUN_PELLET_LIFESPAN = 10; // 10 frames lifespan

  // Bomb weapon constants
  private readonly BOMB_SPEED = 2000;             // 2 pixels/frame in fixed-point
  private readonly BOMB_CLEAR_RADIUS = 60;        // 120x120 area (±60)
  private readonly BOMB_KILL_RADIUS = 50;         // Kills players within 50px
  private readonly BOMB_ITEM_DAMAGE_RADIUS = 70;  // Destroys items within 70px
  private readonly BOMB_EXPLOSION_SCALE = 2;    // Large bomb explosion
  // The bomb collides as a 12x18 box along its heading (design/projectiles.md)
  private readonly BOMB_HALF_LENGTH = 9;
  private readonly BOMB_HALF_WIDTH = 6;
  private readonly BOMB_PLAYER_MARGIN = 2;        // A player's head is not a point
  private readonly GLOCK_DAMAGE = 50;             // Glock bullet damage to bomb
  private readonly TRACER_DAMAGE = 10;            // Tracer bullet damage to bomb

  // Color blindness effect state (triggered by Swap item)
  private colorBlindnessRemainingFrames: number = 0;
  private readonly COLOR_BLINDNESS_DURATION = 280;   // 4 seconds at 70fps
  private readonly COLOR_BLINDNESS_PROBABILITY = 0.1; // 10% chance

  // White flash effect state (triggered by bomb-on-bomb collision)
  // 400ms solid white (28 frames) + 4 seconds fade (280 frames) = 308 frames total
  private whiteFlashRemainingFrames: number = 0;
  private readonly WHITE_FLASH_DURATION = 308;

  // Bodyguard constants
  private readonly BODYGUARD_ORBIT_RADIUS = 30;      // 30 pixels from player
  private readonly BODYGUARD_ORBIT_PERIOD = 140;     // 2 seconds at 70fps
  private readonly BODYGUARD_KILL_RADIUS = 5;        // Kill players within 5px
  private readonly BODYGUARD_ACTION_RADIUS = 50;     // Area around the owner that satellites defend
  private readonly BODYGUARD_BLOCK_RADIUS = 5;       // Stops projectiles passing this close
  private readonly BODYGUARD_LOOKAHEAD = 6;          // Ticks of projectile flight considered
  private readonly BODYGUARD_DEADLY_MISS = 10;       // A course passing this close to the owner comes first
  private readonly BODYGUARD_STANDOFF = 12;          // Block at least this far from the owner (bullets explode)
  private readonly BODYGUARD_SPEED = 10000;          // 10 pixels/tick

  // Bodyguard state
  private bodyguards: Bodyguard[] = [];
  private nextBodyguardId = 0;
  private bodyguardBaseAngle: number = 0;  // Shared rotation angle for synchronized orbits

  // Player configs for restarting rounds
  private playerConfigs: GamePlayer[];

  constructor(playerConfigs: GamePlayer[], gameMode: GameMode, levelMode: LevelMode, rng: Rng = Math.random) {
    this.rng = rng;
    this.itemLauncher = new ItemLauncher(rng);
    this.playerConfigs = playerConfigs;
    this.gameMode = gameMode;
    this.levelMode = levelMode;

    // Set initial level based on levelMode
    if (levelMode !== 'cycle') {
      const levelIndex = LEVELS.findIndex(l => l.id === levelMode);
      if (levelIndex >= 0) {
        this.currentLevelIndex = levelIndex;
      }
    }

    // Initialize scores and ridiculous death counts
    for (const config of playerConfigs) {
      this.scores.set(config.slotIndex, 0);
      this.ridiculousDeaths.set(config.slotIndex, 0);
    }

    // Initialize players for first round
    this.initRound();
  }

  // Read-only views for bots and tests
  getProjectiles(): readonly Projectile[] {
    return this.projectiles;
  }

  getBodyguards(): readonly Bodyguard[] {
    return this.bodyguards;
  }

  // Queue a sound event for network sync
  private queueSound(sound: string): void {
    this.frameSoundEvents.push({ sound });
  }

  // Looping sounds currently playing, so that start/stop events are only emitted on
  // transitions (not on every frame the condition holds)
  private activeLoops = new Set<string>();

  // Start a looping sound (no-op if that loop is already playing)
  private queueLoopSound(sound: string, loopKey: string): void {
    if (this.activeLoops.has(loopKey)) return;
    this.activeLoops.add(loopKey);
    this.frameSoundEvents.push({ sound, loop: true, loopKey });
  }

  // Stop a looping sound (no-op if it is not playing)
  private queueStopLoop(loopKey: string): void {
    if (!this.activeLoops.delete(loopKey)) return;
    this.frameSoundEvents.push({ sound: '', stopLoop: loopKey });
  }

  private recordDeath(player: TronPlayer, cause: DeathCause): void {
    this.frameDeaths.push({ slotIndex: player.slotIndex, cause, x: player.getScreenX(), y: player.getScreenY() });
  }

  // Kill a player and handle ridiculous death if applicable
  private killPlayerWithSound(player: TronPlayer, isRidiculousDeath: boolean, cause: DeathCause): void {
    player.kill();
    this.recordDeath(player, cause);
    if (isRidiculousDeath) {
      const count = (this.ridiculousDeaths.get(player.slotIndex) || 0) + 1;
      this.ridiculousDeaths.set(player.slotIndex, count);
      this.frameRidiculousDeaths.push(player.slotIndex);
      this.queueSound('panico');
    } else {
      this.queueSound('laughs');
    }
  }

  // Set level obstacle pixels with colors (called by TronGame after loading level image)
  setLevelObstacles(obstacles: PixelGrid): void {
    this.levelObstacles = obstacles;
    // Levels are loaded during the countdown, before any trail exists
    this.pixels.copyFrom(obstacles);
  }

  // Initialize/reset for a new round
  initRound(): void {
    this.phase = 'countdown';
    this.countdown = COUNTDOWN_SECONDS;
    this.roundWinner = null;
    this.pixels.copyFrom(this.levelObstacles);
    this.frameRoundStarted = true;
    this.activeLoops.clear(); // The view stops all loops when a round starts or ends
    this.frameTrailSegments.clear();
    this.playersReady.clear();
    this.prevActionState.clear();
    this.portals = [];
    this.items = [];
    this.itemLauncher.reset();
    this.borderLocks.clear();
    this.frameBorderSegments.length = 0;
    this.projectiles = [];
    this.explosions = [];
    this.rifleBurstState.clear();
    this.colorBlindnessRemainingFrames = 0;
    this.whiteFlashRemainingFrames = 0;
    this.bodyguards = [];
    this.nextBodyguardId = 0;
    this.bodyguardBaseAngle = 0;
    this.doorTick = 0;
    this.hand = LEVELS[this.currentLevelIndex]?.hand ? createHand() : null;

    const playerCount = this.playerConfigs.length;

    // Create or reset players
    if (this.players.length === 0) {
      // First time - create players
      this.playerConfigs.forEach((config, index) => {
        const startPos = getStartingPosition(index, playerCount);
        const player = new TronPlayer(
          config.slotIndex,
          startPos.x,
          startPos.y,
          startPos.direction,
          config.color,
          config.nickname
        );
        this.players.push(player);
      });
    } else {
      // Reset existing players
      this.players.forEach((player, index) => {
        const startPos = getStartingPosition(index, playerCount);
        player.reset(startPos.x, startPos.y, startPos.direction);
      });
    }

    // Spawn 2 portals at round start
    this.spawnPortals();

    // Spawn initial items (6 items at round start)
    this.itemLauncher.spawnInitialItems(this.items, () =>
      this.players.map(p => ({
        x: p.getScreenX(),
        y: p.getScreenY()
      }))
    );
  }

  // Process one game tick (called at ~70fps by host)
  tick(inputs: Map<SlotIndex, TronInput>): void {
    // Clear frame trail segments
    this.frameTrailSegments.clear();

    switch (this.phase) {
      case 'countdown':
        this.tickCountdown();
        break;

      case 'playing':
        this.tickPlaying(inputs);
        break;

      case 'waiting_ready':
        this.tickWaitingReady(inputs);
        break;
    }
  }

  private tickCountdown(): void {
    this.countdown -= 1 / TICK_RATE;

    if (this.countdown <= 0) {
      this.countdown = 0;
      this.phase = 'playing';
      this.queueSound('round_start');
    }
  }

  private tickPlaying(inputs: Map<SlotIndex, TronInput>): void {
    // Level doors: one shared clock, sampled once per tick
    this.doorTick++;
    const doors = LEVELS[this.currentLevelIndex]?.doors;
    const frameOfDoors = doors ? doorFrame(this.doorTick) : 0;

    // Level guns fire at random
    const guns = LEVELS[this.currentLevelIndex]?.guns;
    if (guns && guns.length > 0 && this.rng() < GUN_BURST_CHANCE) {
      const gun = guns[Math.floor(this.rng() * guns.length)]!;
      this.createPellets(gun.x * 1000, gun.y * 1000, gun.direction, NO_OWNER);
      this.queueSound('explosion');
    }

    // The dentist's hand drills away one pixel at a time
    const handDef = LEVELS[this.currentLevelIndex]?.hand;
    if (handDef && this.hand) {
      if (stepHand(this.hand, handDef, this.rng)) {
        this.queueLoopSound('drill', 'hand');
        const { x, y } = this.hand;
        if (x >= 0 && x < PLAY_WIDTH && y >= 0 && y < PLAY_HEIGHT) this.clearSquare(x, y, 1);
      } else {
        this.queueStopLoop('hand');
      }
    }

    // Decrement teleport cooldowns
    for (const player of this.players) {
      if (player.teleportCooldown > 0) player.teleportCooldown--;
    }

    // Calculate speedFactors for all players
    const speedFactors = this.calculateSpeedFactors(inputs);

    // Calculate moves per frame for each player
    const movesPerPlayer: Map<SlotIndex, number> = new Map();
    for (const player of this.players) {
      const input = inputs.get(player.slotIndex) ?? NO_INPUT;
      const factor = speedFactors.get(player.slotIndex) ?? 1;
      // Recorded for guests, which predict movement from these (see movement.ts)
      player.baseSpeed = factor - ownTurboBoost(player, input);
      player.lastSteer = input.steer;
      player.lastAction = input.action;
      if (!player.alive) continue;
      movesPerPlayer.set(player.slotIndex, movesForTick(player, factor));
    }

    // Find maximum moves this frame (for step-by-step simulation)
    const maxMoves = Math.max(1, ...Array.from(movesPerPlayer.values()));

    // Track new trail segments for network transmission
    const newSegmentsByPlayer: Map<SlotIndex, TrailSegment[]> = new Map();
    for (const player of this.players) {
      newSegmentsByPlayer.set(player.slotIndex, []);
    }

    // Process movements step by step (ensures proper collision detection with speedup)
    for (let step = 0; step < maxMoves; step++) {
      // Move all players that should move this step
      for (const player of this.players) {
        if (!player.alive) continue;

        const playerMoves = movesPerPlayer.get(player.slotIndex) ?? 1;
        if (step >= playerMoves) continue; // This player doesn't move this step

        // Control Reversal is applied inside movePlayer
        const newSegments = movePlayer(player, inputs.get(player.slotIndex) ?? NO_INPUT);

        // Check collision immediately after move
        const collisionPixel = player.checkCollision(this.pixels);
        if (collisionPixel) {
          const pixelOwner = this.pixels.get(collisionPixel.x, collisionPixel.y);
          const hasShield = player.hasEffect('shield');
          const hasCrossing = player.hasEffect('crossing');
          const isOwnColor = pixelOwner === player.color;

          // Shield: complete invincibility
          // Crossing: can pass through own color only
          const isProtected = hasShield || (hasCrossing && isOwnColor);

          if (!isProtected) {
            this.killPlayerWithSound(player, isOwnColor,
              isOwnColor ? 'own-trail' : this.players.some(p => p.color === pixelOwner) ? 'trail' : 'level');
            continue;
          }
        }

        // Doors kill on contact, shield or not
        if (doors && anyDoorSolidAt(doors, frameOfDoors, player.getScreenX(), player.getScreenY())) {
          this.killPlayerWithSound(player, false, 'door');
          continue;
        }

        // Add trail segments to collision map
        for (const seg of newSegments) {
          this.pixels.set(seg.x, seg.y, player.color);
        }

        // Accumulate for network transmission
        const existing = newSegmentsByPlayer.get(player.slotIndex) || [];
        existing.push(...newSegments);
        newSegmentsByPlayer.set(player.slotIndex, existing);
      }

      // Check for diagonal crossings between players after each step
      const alivePlayers = this.players.filter(p => p.alive);
      for (let i = 0; i < alivePlayers.length; i++) {
        const p1 = alivePlayers[i];
        if (!p1 || p1.prevScreenX < 0) continue;

        for (let j = i + 1; j < alivePlayers.length; j++) {
          const p2 = alivePlayers[j];
          if (!p2 || p2.prevScreenX < 0) continue;

          // A move that wrapped around an edge (or teleported) is not a straight
          // segment across the arena - skip it to avoid phantom crossings
          if (!isContiguousMove(p1) || !isContiguousMove(p2)) continue;

          // Check if movement segments intersect
          if (segmentsIntersect(
            p1.prevScreenX, p1.prevScreenY, p1.getScreenX(), p1.getScreenY(),
            p2.prevScreenX, p2.prevScreenY, p2.getScreenX(), p2.getScreenY()
          )) {
            // Players with shield survive diagonal collision
            const p1HasShield = p1.hasEffect('shield');
            const p2HasShield = p2.hasEffect('shield');

            if (!p1HasShield) { p1.kill(); this.recordDeath(p1, 'crossing'); }
            if (!p2HasShield) { p2.kill(); this.recordDeath(p2, 'crossing'); }

            if (!p1HasShield || !p2HasShield) {
              this.queueSound('laughs');
            }
          }
        }
      }
    }

    // Store trail segments for network transmission
    for (const [slotIndex, segments] of newSegmentsByPlayer) {
      if (segments.length > 0) {
        this.frameTrailSegments.set(slotIndex, segments);
      }
    }

    // Check teleport collision for alive players
    for (const player of this.players) {
      if (!player.alive) continue;
      if (player.teleportCooldown === 0) {
        this.checkTeleport(player);
      }
    }

    // Spawn items periodically
    this.itemLauncher.tick(this.items, () =>
      this.players.filter(p => p.alive).map(p => ({
        x: p.getScreenX(),
        y: p.getScreenY()
      }))
    );

    // Check item pickups for alive players
    for (const player of this.players) {
      if (player.alive) {
        this.checkItemPickup(player);
      }
    }

    // Tick player effects (decrement durations)
    for (const player of this.players) {
      player.tickEffects();
    }

    // Handle weapon use (action button)
    for (const [slotIndex, input] of inputs) {
      const player = this.players.find(p => p.slotIndex === slotIndex);
      if (player?.alive && player.equippedWeapon) {
        const weaponDef = WEAPON_ITEMS.find(d => d.sprite === player.equippedWeapon!.sprite);
        const weaponSprite = player.equippedWeapon.sprite;

        // Rifle: special automatic burst-fire handling
        if (weaponSprite === 'rifle') {
          if (input.action && player.equippedWeapon) {
            // Initialize or get burst state
            let burst = this.rifleBurstState.get(slotIndex);
            if (!burst) {
              // Start at RIFLE_BURST_INTERVAL so first burst fires immediately
              burst = { frameCounter: this.RIFLE_BURST_INTERVAL, shotsRemaining: 0, shotDelay: 0 };
              this.rifleBurstState.set(slotIndex, burst);
            }

            burst.frameCounter++;

            // Start new burst every 20 frames if not already bursting and have enough ammo
            if (burst.shotsRemaining === 0 && burst.frameCounter >= this.RIFLE_BURST_INTERVAL) {
              if ((player.equippedWeapon.ammo ?? 0) >= this.RIFLE_SHOTS_PER_BURST) {
                burst.shotsRemaining = this.RIFLE_SHOTS_PER_BURST;
                burst.shotDelay = 0;
                burst.frameCounter = 0;
                this.queueSound('rifle');  // Play sound at start of burst
              }
            }

            // Fire shots in burst with delay
            if (burst.shotsRemaining > 0) {
              if (burst.shotDelay === 0) {
                const playerSpeedFactor = speedFactors.get(player.slotIndex) ?? 1;
                this.createTracerProjectile(player, playerSpeedFactor);
                player.useWeapon();  // Decrement ammo by 1
                burst.shotsRemaining--;
                burst.shotDelay = this.RIFLE_SHOT_DELAY;
              } else {
                burst.shotDelay--;
              }
            }
          } else {
            // Action released or weapon gone - clear burst state
            this.rifleBurstState.delete(slotIndex);
          }
        } else if (player.equippedWeapon.ammo !== undefined) {
          // Other shot-based weapons: fire only on rising edge (new press)
          const wasPressed = this.prevActionState.get(slotIndex) || false;
          if (input.action && !wasPressed && player.useWeapon()) {
            // Special handling for glock - creates projectile
            if (weaponSprite === 'glock') {
              const playerSpeedFactor = speedFactors.get(player.slotIndex) ?? 1;
              this.createProjectile(player, playerSpeedFactor);
              this.queueSound('glock');
            } else if (weaponSprite === 'shotgun') {
              // Shotgun: fires 30 pellets in a spread
              this.createShotgunPellets(player);
              this.queueSound('shotgun');
            } else if (weaponSprite === 'bomb') {
              // Bomb: fires a single heavy missile
              this.createBombProjectile(player);
              this.queueSound('bomb');
            } else if (weaponSprite === 'lock_borders') {
            // Special handling for lock_borders - starts border animation
              // Only start alarm if this is the first active border lock
              const wasEmpty = this.borderLocks.size === 0;
              this.borderLocks.set(slotIndex, {
                color: player.color,
                progress: 0,
              });
              if (wasEmpty) {
                this.queueLoopSound('alarm', 'border-lock');
              }
            } else if (weaponDef?.useSound) {
              this.queueSound(weaponDef.useSound);
            }
          }
        } else if (player.equippedWeapon.remainingFrames !== undefined) {
          // Time-based weapon: consume duration while held
          const loopKey = `weapon-${slotIndex}`;
          if (input.action) {
            // Uzi: spray 20 tracers per frame while held
            if (weaponDef?.sprite === 'uzi') {
              this.createUziTracers(player);
            }
            player.tickWeapon();
            // Start looping sound if defined
            if (weaponDef?.loopSound && weaponDef.useSound) {
              this.queueLoopSound(weaponDef.useSound, loopKey);
            }
            // Stop loop if weapon ran out
            if (!player.equippedWeapon) {
              this.queueStopLoop(loopKey);
            }
          } else {
            // Action released - stop looping sound
            this.queueStopLoop(loopKey);
          }
        }
      } else {
        // Player dead or no weapon - stop any looping sound
        this.queueStopLoop(`weapon-${slotIndex}`);
      }
      // Update previous action state for next frame
      this.prevActionState.set(slotIndex, input.action);
    }

    // Animate border lock if active
    this.animateBorderLock();

    // Update visual effects (projectiles, explosions, bodyguards, portals, color blindness)
    this.tickVisualEffects();

    // Check win condition
    this.checkRoundEnd();
  }

  // Animate all active border lock effects
  private animateBorderLock(): void {
    this.frameBorderSegments.length = 0;

    if (this.borderLocks.size === 0) {
      return;
    }

    const completedLocks: SlotIndex[] = [];

    // Process each active border lock
    for (const [slotIndex, lock] of this.borderLocks) {
      const z = lock.progress;
      const segments: TrailSegment[] = [];

      // Draw 5 segments on horizontal edges per frame (matching original)
      for (let i = 0; i < 5; i++) {
        const x = z + i * 150;
        if (x < PLAY_WIDTH) {
          // Top edge (y=0)
          this.pixels.set(x, 0, lock.color);
          segments.push({ x, y: 0 });
          // Bottom edge (y=PLAY_HEIGHT-1)
          this.pixels.set(x, PLAY_HEIGHT - 1, lock.color);
          segments.push({ x, y: PLAY_HEIGHT - 1 });
        }
      }

      // Draw 4 segments on vertical edges per frame (600 height / 150 = 4)
      for (let i = 0; i < 4; i++) {
        const y = z + i * 150;
        if (y < PLAY_HEIGHT) {
          // Left edge (x=0)
          this.pixels.set(0, y, lock.color);
          segments.push({ x: 0, y });
          // Right edge (x=PLAY_WIDTH-1)
          this.pixels.set(PLAY_WIDTH - 1, y, lock.color);
          segments.push({ x: PLAY_WIDTH - 1, y });
        }
      }

      // Store segments with this player's color
      if (segments.length > 0) {
        this.frameBorderSegments.push({ color: lock.color, segments });
      }

      // Advance progress
      lock.progress++;
      if (lock.progress >= 150) {
        completedLocks.push(slotIndex);
      }
    }

    // Remove completed locks
    for (const slotIndex of completedLocks) {
      this.borderLocks.delete(slotIndex);
    }

    // Stop alarm only when ALL border locks are done
    if (this.borderLocks.size === 0 && completedLocks.length > 0) {
      this.queueStopLoop('border-lock');
    }
  }

  // Create a bullet projectile from a player's position (Glock)
  private createProjectile(player: TronPlayer, speedFactor: number): void {
    const dirRad = (player.direction * Math.PI) / 180;
    const startOffset = 5000; // 5 pixels ahead in fixed-point
    // Bullet speed scales with player speed factor (minimum 0.5x to prevent too slow bullets)
    const bulletSpeed = this.BULLET_BASE_SPEED * Math.max(0.5, speedFactor);
    this.projectiles.push({
      id: this.nextProjectileId++,
      x: player.x + Math.cos(dirRad) * startOffset,
      y: player.y + Math.sin(dirRad) * startOffset,
      direction: player.direction,
      ownerSlot: player.slotIndex,
      speed: bulletSpeed,
      type: 'bullet',
      ownerCooldown: this.PROJECTILE_OWNER_COOLDOWN,
    });
  }

  // Create a tracer projectile from a player's position (Rifle)
  private createTracerProjectile(player: TronPlayer, speedFactor: number): void {
    const dirRad = (player.direction * Math.PI) / 180;
    const startOffset = 3000; // 3 pixels ahead in fixed-point
    const bulletSpeed = this.BULLET_BASE_SPEED * Math.max(0.5, speedFactor);
    this.projectiles.push({
      id: this.nextProjectileId++,
      x: player.x + Math.cos(dirRad) * startOffset,
      y: player.y + Math.sin(dirRad) * startOffset,
      direction: player.direction,
      ownerSlot: player.slotIndex,
      speed: bulletSpeed,
      type: 'tracer',
      remainingFrames: this.TRACER_LIFESPAN,
      ownerCooldown: this.PROJECTILE_OWNER_COOLDOWN,
    });
  }

  // Create Uzi spray tracers (20 per frame with random spread and speed)
  private createUziTracers(player: TronPlayer): void {
    const startOffset = 3000; // 3 pixels ahead in fixed-point

    for (let i = 0; i < this.UZI_TRACERS_PER_FRAME; i++) {
      // Random direction within ±30° of player heading
      const spreadAngle = (this.rng() * 2 - 1) * this.UZI_SPREAD_DEGREES;
      const direction = player.direction + spreadAngle;
      const dirRad = (direction * Math.PI) / 180;

      // Random speed between 10-50 pixels/frame
      const speed = this.UZI_MIN_SPEED + this.rng() * (this.UZI_MAX_SPEED - this.UZI_MIN_SPEED);

      this.projectiles.push({
        id: this.nextProjectileId++,
        x: player.x + Math.cos(dirRad) * startOffset,
        y: player.y + Math.sin(dirRad) * startOffset,
        direction: direction,
        ownerSlot: player.slotIndex,
        speed: speed,
        type: 'tracer',
        remainingFrames: this.UZI_TRACER_LIFESPAN,
        ownerCooldown: this.PROJECTILE_OWNER_COOLDOWN,
      });
    }
  }

  // Create Shotgun pellets (30 pellets with spread on single shot)
  private createShotgunPellets(player: TronPlayer): void {
    const startOffset = 3000; // 3 pixels ahead in fixed-point
    this.createPellets(player.x, player.y, player.direction, player.slotIndex, startOffset);
  }

  // A blast of pellets from a fixed-point position: the Shotgun, and the level's guns
  private createPellets(
    x: number, y: number, heading: number, ownerSlot: Projectile['ownerSlot'], startOffset = 0
  ): void {
    for (let i = 0; i < this.SHOTGUN_PELLETS; i++) {
      // Random direction within ±5° of the heading
      const spreadAngle = (this.rng() * 2 - 1) * this.SHOTGUN_SPREAD_DEGREES;
      const direction = heading + spreadAngle;
      const dirRad = (direction * Math.PI) / 180;

      // Random speed between 10-30 pixels/frame
      const speed = this.SHOTGUN_MIN_SPEED + this.rng() * (this.SHOTGUN_MAX_SPEED - this.SHOTGUN_MIN_SPEED);

      this.projectiles.push({
        id: this.nextProjectileId++,
        x: x + Math.cos(dirRad) * startOffset,
        y: y + Math.sin(dirRad) * startOffset,
        direction: direction,
        ownerSlot,
        speed: speed,
        type: 'tracer',
        remainingFrames: this.SHOTGUN_PELLET_LIFESPAN,
        ownerCooldown: ownerSlot === NO_OWNER ? 0 : this.PROJECTILE_OWNER_COOLDOWN,
      });
    }
  }

  // Create a bomb projectile
  private createBombProjectile(player: TronPlayer): void {
    const startOffset = 3000; // 3 pixels ahead in fixed-point
    const dirRad = (player.direction * Math.PI) / 180;

    this.projectiles.push({
      id: this.nextProjectileId++,
      x: player.x + Math.cos(dirRad) * startOffset,
      y: player.y + Math.sin(dirRad) * startOffset,
      direction: player.direction,
      ownerSlot: player.slotIndex,
      speed: this.BOMB_SPEED,
      type: 'bomb',
      ownerCooldown: this.PROJECTILE_OWNER_COOLDOWN,
    });
  }

  // Move projectiles and check collisions
  private tickProjectiles(): void {
    const toRemove: number[] = [];

    // The paths tracers travel this tick, for bullets to run into
    const tracerPaths: TracerPath[] = [];
    if (this.projectiles.some(p => p.type === 'bullet')) {
      for (const p of this.projectiles) {
        if (p.type !== 'tracer') continue;
        const rad = (p.direction * Math.PI) / 180;
        tracerPaths.push({
          ownerSlot: p.ownerSlot,
          x0: p.x / 1000,
          y0: p.y / 1000,
          x1: (p.x + Math.cos(rad) * p.speed) / 1000,
          y1: (p.y + Math.sin(rad) * p.speed) / 1000,
        });
      }
    }

    for (const proj of this.projectiles) {
      // Store previous position for line collision check
      const prevX = Math.floor(proj.x / 1000);
      const prevY = Math.floor(proj.y / 1000);

      // Move bullet using its stored speed (don't wrap yet - need unwrapped coords for collision)
      const dirRad = (proj.direction * Math.PI) / 180;
      proj.x += Math.cos(dirRad) * proj.speed;
      proj.y += Math.sin(dirRad) * proj.speed;

      // Get unwrapped coordinates for collision check (Bresenham handles wrap internally)
      const unwrappedX = Math.floor(proj.x / 1000);
      const unwrappedY = Math.floor(proj.y / 1000);

      // Now wrap the stored position
      if (proj.x >= PLAY_WIDTH * 1000) proj.x -= PLAY_WIDTH * 1000;
      if (proj.x < 0) proj.x += PLAY_WIDTH * 1000;
      if (proj.y >= PLAY_HEIGHT * 1000) proj.y -= PLAY_HEIGHT * 1000;
      if (proj.y < 0) proj.y += PLAY_HEIGHT * 1000;

      const newX = Math.floor(proj.x / 1000);
      const newY = Math.floor(proj.y / 1000);

      // Check portal teleportation (uses wrapped coordinates)
      let teleported = false;
      for (const portal of this.portals) {
        const d1 = Math.sqrt((newX - portal.x1) ** 2 + (newY - portal.y1) ** 2);
        if (d1 < PORTAL_RADIUS) {
          this.teleportProjectile(proj, portal.x2, portal.y2);
          teleported = true;
          break;
        }
        const d2 = Math.sqrt((newX - portal.x2) ** 2 + (newY - portal.y2) ** 2);
        if (d2 < PORTAL_RADIUS) {
          this.teleportProjectile(proj, portal.x1, portal.y1);
          teleported = true;
          break;
        }
      }
      if (teleported) continue;

      // Check all pixels along the path using Bresenham's line algorithm
      // Use UNWRAPPED coordinates so Bresenham follows the actual path
      // MUST check collision BEFORE clearing pixels for tracers!
      // Bombs use thick line collision (6px half-width) to match their sprite size
      // (and reach 9 px ahead of the centre: the bomb explodes when its nose touches)
      const impactPoint = proj.type === 'bomb'
        ? this.checkThickLineCollision(
            prevX, prevY,
            Math.round(unwrappedX + Math.cos(dirRad) * this.BOMB_HALF_LENGTH),
            Math.round(unwrappedY + Math.sin(dirRad) * this.BOMB_HALF_LENGTH),
            this.BOMB_HALF_WIDTH)
        : this.checkLineCollision(prevX, prevY, unwrappedX, unwrappedY);
      if (impactPoint) {
        if (proj.type === 'bullet') {
          this.projectileImpact(impactPoint.x, impactPoint.y, proj.ownerSlot);
        } else if (proj.type === 'bomb') {
          this.bombImpact(impactPoint.x, impactPoint.y, proj.ownerSlot);
        } else {
          // Clear path up to impact point, then expire
          // (to the hit as it lies on the path: beyond an edge it must not be wrapped,
          // or the line would be drawn back across the whole arena)
          this.clearPixelPath(prevX, prevY, impactPoint.rawX, impactPoint.rawY);
          this.tracerExpire(impactPoint.x, impactPoint.y);
        }
        toRemove.push(proj.id);
        continue;
      }

      // Tracer-specific: clear pixels along path and decrement lifespan
      if (proj.type === 'tracer') {
        this.clearPixelPath(prevX, prevY, unwrappedX, unwrappedY);

        // Decrement lifespan
        if (proj.remainingFrames !== undefined) {
          proj.remainingFrames--;
          if (proj.remainingFrames <= 0) {
            this.tracerExpire(newX, newY);
            toRemove.push(proj.id);
            continue;
          }
        }
      }

      // Decrement owner cooldown
      if (proj.ownerCooldown !== undefined && proj.ownerCooldown > 0) {
        proj.ownerCooldown--;
      }
      const skipOwner = proj.ownerCooldown !== undefined && proj.ownerCooldown > 0;

      // Satellites stop enemy projectiles that pass through them (design/bodyguards.md)
      const blocker = this.findBlocker(proj, prevX, prevY, unwrappedX, unwrappedY);

      // A bullet that crosses a tracer explodes there (design/projectiles.md)
      const tracerHit = proj.type === 'bullet'
        ? this.findTracerOnPath(proj, prevX, prevY, unwrappedX, unwrappedY, tracerPaths)
        : null;
      // A bullet or tracer that crosses a flying bomb sets it off
      const bombHit = proj.type === 'bomb'
        ? null
        : this.findBombOnPath(prevX, prevY, unwrappedX, unwrappedY, toRemove);
      // Whatever comes first on the path counts
      const stopT = Math.min(
        blocker ? blocker.t : Infinity, tracerHit ? tracerHit.t : Infinity, bombHit ? bombHit.t : Infinity
      );

      // Check collision with players (shield does NOT protect!)
      // Skip player collisions during waiting_ready phase (round is over, let bullets fly visually)
      let hitPlayer = false;
      if (this.phase !== 'waiting_ready') {
        // Bomb uses direct impact radius (like bullets), not the kill radius
        const killRadius = proj.type === 'bullet' ? this.BULLET_KILL_RADIUS :
                          proj.type === 'bomb' ? this.BULLET_KILL_RADIUS : this.TRACER_KILL_RADIUS;
        for (const player of this.players) {
          if (!player.alive) continue;
          // Skip owner during cooldown period
          if (skipOwner && player.slotIndex === proj.ownerSlot) continue;
          const px = player.getScreenX();
          const py = player.getScreenY();
          // A bomb collides as a box; the others by distance to the path travelled.
          // A satellite earlier on the path saves the player.
          let hit: boolean;
          if (proj.type === 'bomb') {
            hit = !blocker && this.bombCovers(proj, px, py, this.BOMB_PLAYER_MARGIN);
          } else {
            const closest = this.closestOnPath(px, py, prevX, prevY, unwrappedX, unwrappedY);
            hit = closest.dist < killRadius && closest.t < stopT;
          }
          if (hit) {
            if (proj.type === 'bullet') {
              this.projectileImpact(px, py, proj.ownerSlot);
            } else if (proj.type === 'bomb') {
              this.bombImpact(px, py, proj.ownerSlot);
            } else {
              this.tracerExpire(px, py);
              this.killPlayerWithSound(player, player.slotIndex === proj.ownerSlot, 'tracer');
            }
            toRemove.push(proj.id);
            hitPlayer = true;
            break;
          }
        }
      }
      if (hitPlayer) continue;
      if (bombHit && bombHit.t <= stopT) {
        // Any shot sets the bomb off where it is, as a tracer did in the original
        const bomb = bombHit.bomb;
        toRemove.push(bomb.id);
        this.bombImpact(Math.floor(bomb.x / 1000), Math.floor(bomb.y / 1000), bomb.ownerSlot);
        toRemove.push(proj.id);
        continue;
      }
      if (tracerHit && tracerHit.t <= stopT) {
        this.projectileImpact(tracerHit.x, tracerHit.y, proj.ownerSlot);
        toRemove.push(proj.id);
        continue;
      }
      if (blocker) {
        this.blockProjectile(blocker.bg, proj);
        toRemove.push(proj.id);
        continue;
      }

      // Check collision with items
      let hitItem = false;
      for (const item of this.items) {
        if (!item.active) continue;
        // Check distance to the path travelled
        const dist = this.distanceToPath(item.x, item.y, prevX, prevY, unwrappedX, unwrappedY);
        if (dist < ITEM_COLLISION_RADIUS) {
          if (proj.type === 'bomb') {
            // Bomb explodes on item contact
            this.bombImpact(item.x, item.y, proj.ownerSlot);
            toRemove.push(proj.id);
            hitItem = true;
            break;
          } else {
            // Bullets and tracers damage item HP
            const damage = proj.type === 'bullet' ? this.GLOCK_DAMAGE : this.TRACER_DAMAGE;
            item.hp -= damage;
            if (item.hp <= 0) {
              item.active = false;
            }
            // Projectile is consumed (no explosion for item hits)
            if (proj.type === 'tracer') {
              this.tracerExpire(item.x, item.y);
            }
            toRemove.push(proj.id);
            hitItem = true;
            break;
          }
        }
      }
      if (hitItem) continue;

      // Check collision with other projectiles
      // - Bullets collide with bullets (mutual destruction + explosion)
      // - Bullets and tracers set bombs off (handled above, on the path travelled)
      // - Bombs collide with bombs (mega explosion with doubled radii + white flash)
      // - Tracers don't collide with each other (allows shotgun/uzi spread)
      if (proj.type === 'bullet' || proj.type === 'tracer') {
        for (const other of this.projectiles) {
          if (other.id === proj.id) continue;
          if (toRemove.includes(other.id)) continue;
          const otherX = Math.floor(other.x / 1000);
          const otherY = Math.floor(other.y / 1000);
          const dist = Math.sqrt((newX - otherX) ** 2 + (newY - otherY) ** 2);
          if (dist < 3) {  // Small collision radius for projectiles
            if (proj.type === 'bullet' && other.type === 'bullet') {
              // Two bullets collide - mutual destruction + explosion
              const midX = Math.floor((newX + otherX) / 2);
              const midY = Math.floor((newY + otherY) / 2);
              this.projectileImpact(midX, midY, proj.ownerSlot);
              toRemove.push(proj.id);
              toRemove.push(other.id);
              break;
            }
            // Tracers don't collide with each other or with bullets
          }
        }
      }

      // Check bomb-on-bomb collision using oriented bounding boxes (bomb sprite is ~12x18 pixels)
      if (proj.type === 'bomb') {
        for (const other of this.projectiles) {
          if (other.id === proj.id) continue;
          if (other.type !== 'bomb') continue;
          if (toRemove.includes(other.id)) continue;
          const otherX = Math.floor(other.x / 1000);
          const otherY = Math.floor(other.y / 1000);
          // Check OBB collision between two rotated bombs
          if (this.checkBombOBBCollision(newX, newY, proj.direction, otherX, otherY, other.direction)) {
            // Two bombs collide - mega explosion at midpoint
            const midX = Math.floor((newX + otherX) / 2);
            const midY = Math.floor((newY + otherY) / 2);
            this.megaBombImpact(midX, midY);
            toRemove.push(proj.id);
            toRemove.push(other.id);
            break;
          }
        }
      }
    }

    // Remove impacted projectiles
    this.projectiles = this.projectiles.filter(p => !toRemove.includes(p.id));
    this.removeDeadBodyguards();
  }

  // Teleport a projectile to exit portal position
  private teleportProjectile(proj: Projectile, portalX: number, portalY: number): void {
    const dirRad = (proj.direction * Math.PI) / 180;
    // Exit at outer ring of destination portal, maintaining direction
    proj.x = (portalX + Math.cos(dirRad) * PORTAL_OUTER_RADIUS) * 1000;
    proj.y = (portalY + Math.sin(dirRad) * PORTAL_OUTER_RADIUS) * 1000;
  }

  // Clear pixels along projectile path (for tracer bullets)
  private clearPixelPath(x0: number, y0: number, x1: number, y1: number): void {
    this.pixels.clearLine(x0, y0, x1, y1);
    this.frameClearedLines.push(x0, y0, x1, y1);
  }

  // Tracer bullet expiration (no explosion)
  private tracerExpire(x: number, y: number): void {
    const r = this.TRACER_CLEAR_RADIUS;
    this.clearSquare(x - r, y - r, 2 * r + 1);
    // No explosion, no bomb sound
  }

  // Clear a size×size square (top-left corner at x,y; wraps) from the collision map
  // and report it to the renderer
  private clearSquare(x: number, y: number, size: number): void {
    this.pixels.clearRect(x, y, size, size);
    this.frameClearedAreas.push({ x, y, w: size, h: size });
  }

  // Clear a disc (wraps) from the collision map, reported to the renderer as a stack of
  // strips: consecutive rows of the same width share one
  private clearCircle(cx: number, cy: number, radius: number): void {
    let stripTop = 0;
    let stripHalf = -1;
    const flush = (bottom: number): void => {
      if (stripHalf < 0) return;
      const area = { x: cx - stripHalf, y: stripTop, w: 2 * stripHalf + 1, h: bottom - stripTop };
      this.pixels.clearRect(area.x, area.y, area.w, area.h);
      this.frameClearedAreas.push(area);
    };
    for (let dy = -radius; dy <= radius; dy++) {
      const half = Math.floor(Math.sqrt(radius * radius - dy * dy));
      if (half !== stripHalf) {
        flush(cy + dy);
        stripTop = cy + dy;
        stripHalf = half;
      }
    }
    flush(cy + radius + 1);
  }

  // Check all pixels along a line for collision (Bresenham's algorithm)
  private checkLineCollision(x0: number, y0: number, x1: number, y1: number): LineHit | null {
    return this.pixels.firstHitOnLine(x0, y0, x1, y1);
  }

  // Check collision along a thick line (for bombs which have width)
  // Returns the first collision point or null
  private checkThickLineCollision(
    x0: number, y0: number, x1: number, y1: number, halfWidth: number
  ): LineHit | null {
    // Check the center line first
    const centerHit = this.checkLineCollision(x0, y0, x1, y1);
    if (centerHit) return centerHit;

    // Get perpendicular direction
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return null;

    // Perpendicular unit vector
    const perpX = -dy / len;
    const perpY = dx / len;

    // Check offset lines on both sides of center
    for (let offset = 1; offset <= halfWidth; offset++) {
      // Left side
      const leftHit = this.checkLineCollision(
        Math.round(x0 + perpX * offset), Math.round(y0 + perpY * offset),
        Math.round(x1 + perpX * offset), Math.round(y1 + perpY * offset)
      );
      if (leftHit) return leftHit;

      // Right side
      const rightHit = this.checkLineCollision(
        Math.round(x0 - perpX * offset), Math.round(y0 - perpY * offset),
        Math.round(x1 - perpX * offset), Math.round(y1 - perpY * offset)
      );
      if (rightHit) return rightHit;
    }

    return null;
  }

  // The first flying bomb whose body a bullet's or tracer's path crosses this tick
  private findBombOnPath(
    x0: number, y0: number, x1: number, y1: number, removed: readonly number[]
  ): { bomb: Projectile; t: number } | null {
    let best: { bomb: Projectile; t: number } | null = null;
    for (const bomb of this.projectiles) {
      if (bomb.type !== 'bomb' || removed.includes(bomb.id)) continue;
      // The path in the bomb's own frame: x along its heading, y across
      const bx = bomb.x / 1000;
      const by = bomb.y / 1000;
      const sx = this.wrapDelta(x0 - bx, PLAY_WIDTH);
      const sy = this.wrapDelta(y0 - by, PLAY_HEIGHT);
      const rad = (bomb.direction * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const ax = sx * cos + sy * sin;
      const ay = -sx * sin + sy * cos;
      const dx = (x1 - x0) * cos + (y1 - y0) * sin;
      const dy = -(x1 - x0) * sin + (y1 - y0) * cos;

      // Segment against the box (slab test)
      let enter = 0;
      let leave = 1;
      let crosses = true;
      for (const [start, delta, half] of [
        [ax, dx, this.BOMB_HALF_LENGTH + 1], [ay, dy, this.BOMB_HALF_WIDTH + 1],
      ] as const) {
        if (Math.abs(delta) < 1e-9) {
          if (Math.abs(start) > half) crosses = false;
          continue;
        }
        const t1 = (-half - start) / delta;
        const t2 = (half - start) / delta;
        enter = Math.max(enter, Math.min(t1, t2));
        leave = Math.min(leave, Math.max(t1, t2));
      }
      if (crosses && enter <= leave && (!best || enter < best.t)) best = { bomb, t: enter };
    }
    return best;
  }

  // Where a bullet's path this tick first comes within reach of a tracer's path.
  // Tracers of the bullet's own shooter do not count.
  private findTracerOnPath(
    bullet: Projectile, x0: number, y0: number, x1: number, y1: number, tracers: readonly TracerPath[]
  ): { t: number; x: number; y: number } | null {
    let best: { t: number; x: number; y: number } | null = null;
    const dx = x1 - x0;
    const dy = y1 - y0;
    for (const tracer of tracers) {
      if (tracer.ownerSlot === bullet.ownerSlot) continue;
      // Compare with the tracer's nearest image (the arena wraps); both paths are short
      const ox = this.wrapDelta(tracer.x0 - x0, PLAY_WIDTH) - (tracer.x0 - x0);
      const oy = this.wrapDelta(tracer.y0 - y0, PLAY_HEIGHT) - (tracer.y0 - y0);
      const bx0 = tracer.x0 + ox;
      const by0 = tracer.y0 + oy;
      const ex = tracer.x1 - tracer.x0;
      const ey = tracer.y1 - tracer.y0;
      if (Math.abs(bx0 - x0) > 60 || Math.abs(by0 - y0) > 60) continue; // Too far to meet this tick

      // Closest points of two segments
      const rx = x0 - bx0;
      const ry = y0 - by0;
      const a = dx * dx + dy * dy;
      const e = ex * ex + ey * ey;
      const f = ex * rx + ey * ry;
      let s = 0;
      let u = 0;
      if (a > 0 && e > 0) {
        const b = dx * ex + dy * ey;
        const c = dx * rx + dy * ry;
        const denom = a * e - b * b;
        s = denom > 1e-9 ? Math.max(0, Math.min(1, (b * f - c * e) / denom)) : 0;
        u = (b * s + f) / e;
        if (u < 0) {
          u = 0;
          s = Math.max(0, Math.min(1, -c / a));
        } else if (u > 1) {
          u = 1;
          s = Math.max(0, Math.min(1, (b - c) / a));
        }
      } else if (a > 0) {
        s = Math.max(0, Math.min(1, -(dx * rx + dy * ry) / a));
      } else if (e > 0) {
        u = Math.max(0, Math.min(1, f / e));
      }
      const px = x0 + dx * s;
      const py = y0 + dy * s;
      const dist = Math.hypot(px - (bx0 + ex * u), py - (by0 + ey * u));
      if (dist < this.BULLET_TRACER_RADIUS && (!best || s < best.t)) {
        best = {
          t: s,
          x: ((Math.round(px) % PLAY_WIDTH) + PLAY_WIDTH) % PLAY_WIDTH,
          y: ((Math.round(py) % PLAY_HEIGHT) + PLAY_HEIGHT) % PLAY_HEIGHT,
        };
      }
    }
    return best;
  }

  // Closest approach of the path travelled this tick (x0,y0 → x1,y1) to a point: the
  // distance and how far along the path (0..1). The end of the path may lie beyond an
  // edge (unwrapped): then the point is also tried wrapped around.
  private closestOnPath(
    px: number, py: number, x0: number, y0: number, x1: number, y1: number
  ): { dist: number; t: number } {
    const shiftX = x1 < 0 ? -PLAY_WIDTH : x1 >= PLAY_WIDTH ? PLAY_WIDTH : 0;
    const shiftY = y1 < 0 ? -PLAY_HEIGHT : y1 >= PLAY_HEIGHT ? PLAY_HEIGHT : 0;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const lenSq = dx * dx + dy * dy;
    let best = { dist: Infinity, t: 0 };
    for (const sx of shiftX !== 0 ? [0, shiftX] : [0]) {
      for (const sy of shiftY !== 0 ? [0, shiftY] : [0]) {
        const qx = px + sx - x0;
        const qy = py + sy - y0;
        const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, (qx * dx + qy * dy) / lenSq));
        const dist = Math.hypot(qx - t * dx, qy - t * dy);
        if (dist < best.dist) best = { dist, t };
      }
    }
    return best;
  }

  private distanceToPath(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
    return this.closestOnPath(px, py, x0, y0, x1, y1).dist;
  }

  // Is a point inside a bomb's body (a box along its heading), grown by `margin`?
  private bombCovers(bomb: Projectile, px: number, py: number, margin: number): boolean {
    let dx = px - Math.floor(bomb.x / 1000);
    let dy = py - Math.floor(bomb.y / 1000);
    if (dx > PLAY_WIDTH / 2) dx -= PLAY_WIDTH; else if (dx < -PLAY_WIDTH / 2) dx += PLAY_WIDTH;
    if (dy > PLAY_HEIGHT / 2) dy -= PLAY_HEIGHT; else if (dy < -PLAY_HEIGHT / 2) dy += PLAY_HEIGHT;
    const rad = (bomb.direction * Math.PI) / 180;
    const along = dx * Math.cos(rad) + dy * Math.sin(rad);
    const across = -dx * Math.sin(rad) + dy * Math.cos(rad);
    return Math.abs(along) <= this.BOMB_HALF_LENGTH + margin && Math.abs(across) <= this.BOMB_HALF_WIDTH + margin;
  }

  // Check collision between two oriented bomb bounding boxes using Separating Axis Theorem
  // Bomb dimensions: ~12x18 pixels (half-width 6, half-height 9)
  private checkBombOBBCollision(
    x1: number, y1: number, dir1: number,
    x2: number, y2: number, dir2: number
  ): boolean {
    const HALF_WIDTH = 6;
    const HALF_HEIGHT = 9;

    // Convert directions to radians
    const rad1 = (dir1 * Math.PI) / 180;
    const rad2 = (dir2 * Math.PI) / 180;

    // Get the 4 axes to test (2 from each box's orientation)
    const axes = [
      { x: Math.cos(rad1), y: Math.sin(rad1) },           // Box1 length axis
      { x: -Math.sin(rad1), y: Math.cos(rad1) },          // Box1 width axis
      { x: Math.cos(rad2), y: Math.sin(rad2) },           // Box2 length axis
      { x: -Math.sin(rad2), y: Math.cos(rad2) },          // Box2 width axis
    ];

    // Get corners of each box relative to their centers
    const getCorners = (cx: number, cy: number, rad: number) => {
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      // Rotate the half-extents
      const dx1 = HALF_HEIGHT * cos;
      const dy1 = HALF_HEIGHT * sin;
      const dx2 = HALF_WIDTH * -sin;
      const dy2 = HALF_WIDTH * cos;
      return [
        { x: cx + dx1 + dx2, y: cy + dy1 + dy2 },
        { x: cx + dx1 - dx2, y: cy + dy1 - dy2 },
        { x: cx - dx1 - dx2, y: cy - dy1 - dy2 },
        { x: cx - dx1 + dx2, y: cy - dy1 + dy2 },
      ];
    };

    const corners1 = getCorners(x1, y1, rad1);
    const corners2 = getCorners(x2, y2, rad2);

    // Project corners onto axis and get min/max
    const project = (corners: { x: number; y: number }[], axis: { x: number; y: number }) => {
      let min = Infinity;
      let max = -Infinity;
      for (const c of corners) {
        const p = c.x * axis.x + c.y * axis.y;
        min = Math.min(min, p);
        max = Math.max(max, p);
      }
      return { min, max };
    };

    // Check for separation on each axis
    for (const axis of axes) {
      const proj1 = project(corners1, axis);
      const proj2 = project(corners2, axis);
      // If projections don't overlap, boxes are separated
      if (proj1.max < proj2.min || proj2.max < proj1.min) {
        return false;
      }
    }

    // No separating axis found - boxes collide
    return true;
  }

  // Handle projectile impact - explosion, clear area, kill nearby players
  private projectileImpact(x: number, y: number, ownerSlot?: Projectile['ownerSlot']): void {
    // Create explosion animation
    this.explosions.push({
      id: this.nextExplosionId++,
      x,
      y,
      frame: 0,
    });

    // Clear the blast area (wraps around edges)
    this.clearSquare(x - this.BULLET_CLEAR_RADIUS, y - this.BULLET_CLEAR_RADIUS, 2 * this.BULLET_CLEAR_RADIUS);

    // Kill players within 6 pixels (NO SHIELD CHECK - explicit requirement!)
    for (const player of this.players) {
      if (!player.alive) continue;
      const px = player.getScreenX();
      const py = player.getScreenY();
      const dist = Math.sqrt((px - x) ** 2 + (py - y) ** 2);
      if (dist < this.BULLET_KILL_RADIUS) {
        const isSelfKill = ownerSlot !== undefined && player.slotIndex === ownerSlot;
        this.killPlayerWithSound(player, isSelfKill, 'bullet');
      }
    }

    // Destroy unpicked items within 16 pixels
    for (const item of this.items) {
      if (!item.active) continue;
      const dist = Math.sqrt((item.x - x) ** 2 + (item.y - y) ** 2);
      if (dist < this.BULLET_ITEM_DAMAGE_RADIUS) {
        item.active = false;
      }
    }

    // TODO: Original game may have used a different explosion sound for Glock bullets
    // (the one we have is EXPLOSIO.WAV which might be for bombs only)
    this.queueSound('explosion');
  }

  // Handle bomb impact - large explosion, clear area, kill nearby players
  private bombImpact(x: number, y: number, ownerSlot?: Projectile['ownerSlot']): void {
    this.blast(x, y, 1, ownerSlot);
    this.queueSound('explosion');
  }

  // A bomb blast: everything within a circle goes (design/projectiles.md). `scale`
  // multiplies the radii (2 for two bombs colliding).
  private blast(x: number, y: number, scale: number, ownerSlot?: Projectile['ownerSlot']): void {
    this.explosions.push({
      id: this.nextExplosionId++,
      x,
      y,
      frame: 0,
      scale: this.BOMB_EXPLOSION_SCALE * scale,
    });

    this.clearCircle(x, y, this.BOMB_CLEAR_RADIUS * scale);

    const within = (px: number, py: number, radius: number): boolean =>
      Math.hypot(this.wrapDelta(px - x, PLAY_WIDTH), this.wrapDelta(py - y, PLAY_HEIGHT)) < radius;

    for (const player of this.players) {
      if (!player.alive) continue;
      if (within(player.getScreenX(), player.getScreenY(), this.BOMB_KILL_RADIUS * scale)) {
        const isSelfKill = ownerSlot !== undefined && player.slotIndex === ownerSlot;
        this.killPlayerWithSound(player, isSelfKill, 'bomb');
      }
    }
    for (const item of this.items) {
      if (item.active && within(item.x, item.y, this.BOMB_ITEM_DAMAGE_RADIUS * scale)) item.active = false;
    }
    for (const bg of this.bodyguards) {
      if (within(bg.x / 1000, bg.y / 1000, this.BOMB_KILL_RADIUS * scale)) bg.id = -1; // Mark for removal
    }
  }

  // Handle mega bomb impact (bomb-on-bomb collision) - doubled radii and white flash
  private megaBombImpact(x: number, y: number): void {
    this.blast(x, y, 2);

    // Trigger white flash effect
    this.whiteFlashRemainingFrames = this.WHITE_FLASH_DURATION;

    this.queueSound('explosion');
  }

  // Advance explosion animations
  private tickExplosions(): void {
    for (const exp of this.explosions) {
      exp.frame++;
    }
    // Remove finished explosions
    this.explosions = this.explosions.filter(e => e.frame < this.EXPLOSION_FRAMES);
  }

  // Tick effects. Once the round is over (`roundOver`) only pure animations continue:
  // projectiles and bodyguards freeze in place.
  private tickVisualEffects(roundOver: boolean = false): void {
    // Animate portals (slower rotation)
    this.portalAnimTick++;
    if (this.portalAnimTick >= this.PORTAL_ANIM_SPEED) {
      this.portalAnimTick = 0;
      for (const portal of this.portals) {
        portal.animFrame = (portal.animFrame + 1) % PORTAL_FRAME_COUNT;
      }
    }

    // Tick color blindness effect countdown
    if (this.colorBlindnessRemainingFrames > 0) {
      this.colorBlindnessRemainingFrames--;
    }

    // Tick white flash effect countdown
    if (this.whiteFlashRemainingFrames > 0) {
      this.whiteFlashRemainingFrames--;
    }

    // Update projectiles, explosions, and bodyguards
    this.tickExplosions();
    if (!roundOver) {
      this.tickProjectiles();
      this.tickBodyguards();
    }
  }

  private tickWaitingReady(inputs: Map<SlotIndex, TronInput>): void {
    // Explosions and portals keep animating; projectiles and bodyguards are frozen
    this.tickVisualEffects(true);

    // Presses right after the round ends are ignored: they were meant as shots
    const locked = this.readyLockTicks > 0;
    if (locked) this.readyLockTicks--;

    // Check for action key presses (one-shot: only on rising edge)
    for (const [slotIndex, input] of inputs) {
      const wasPressed = this.prevActionState.get(slotIndex) || false;
      const isPressed = input.action;

      // Toggle ready on rising edge (key just pressed)
      if (isPressed && !wasPressed && !locked) {
        if (this.playersReady.has(slotIndex)) {
          this.playersReady.delete(slotIndex);
        } else {
          this.playersReady.add(slotIndex);
        }
      }

      // Update previous state
      this.prevActionState.set(slotIndex, isPressed);
    }

    // Check if all players are ready
    if (this.playersReady.size >= this.players.length) {
      this.currentRound++;
      // Only cycle levels if levelMode is 'cycle', otherwise keep same level
      if (this.levelMode === 'cycle') {
        this.currentLevelIndex = (this.currentLevelIndex + 1) % LEVELS.length;
      }
      this.initRound();
    }
  }

  // Calculate speedFactor for each player based on active effects and weapons
  private calculateSpeedFactors(inputs: Map<SlotIndex, TronInput>): Map<SlotIndex, number> {
    const speedFactors = new Map<SlotIndex, number>();

    // Initialize with base speed and apply automatic effects to self
    for (const player of this.players) {
      let factor = 1; // Base speed

      // Turbo auto effect: +1 to self
      if (player.hasEffect('automatic_turbo')) {
        factor += 1;
      }

      // Slow auto effect: -1 to self (you picked up slow, you're slower)
      if (player.hasEffect('automatic_slow')) {
        factor -= 1;
      }

      speedFactors.set(player.slotIndex, factor);
    }

    // Apply turbo/slow weapons (only when action is held)
    for (const [slotIndex, input] of inputs) {
      const player = this.players.find(p => p.slotIndex === slotIndex);
      if (player?.alive && player.equippedWeapon && input.action) {
        if (player.equippedWeapon.sprite === 'turbo') {
          // Turbo weapon: +1 to self
          speedFactors.set(slotIndex, (speedFactors.get(slotIndex) ?? 1) + 1);
        } else if (player.equippedWeapon.sprite === 'slow') {
          // Slow weapon: -1 to all others
          for (const other of this.players) {
            if (other.slotIndex !== slotIndex) {
              speedFactors.set(other.slotIndex, (speedFactors.get(other.slotIndex) ?? 1) - 1);
            }
          }
        }
      }
    }

    return speedFactors;
  }

  // Spawn a single teleport portal pair at round start
  private spawnPortals(): void {
    // Get all player starting positions to avoid
    const playerCount = this.playerConfigs.length;
    const startPositions: { x: number; y: number }[] = [];
    for (let i = 0; i < playerCount; i++) {
      const pos = getStartingPosition(i, playerCount);
      startPositions.push({ x: pos.x, y: pos.y });
    }

    // Spawn a single portal pair
    const portal = this.createPortal(startPositions);
    if (portal) {
      this.portals.push(portal);
    }
  }

  // Create a single portal, avoiding player positions
  private createPortal(avoidPositions: { x: number; y: number }[]): TeleportPortal | null {
    const margin = 30; // Keep portals away from edges
    const maxAttempts = 100;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Random position for first endpoint
      const x1 = margin + this.rng() * (PLAY_WIDTH - 2 * margin);
      const y1 = margin + this.rng() * (PLAY_HEIGHT - 2 * margin);

      // Random position for second endpoint
      const x2 = margin + this.rng() * (PLAY_WIDTH - 2 * margin);
      const y2 = margin + this.rng() * (PLAY_HEIGHT - 2 * margin);

      // Check distance between endpoints
      const dx = x2 - x1;
      const dy = y2 - y1;
      const endpointDistance = Math.sqrt(dx * dx + dy * dy);

      if (endpointDistance < this.PORTAL_MIN_DISTANCE) {
        continue;
      }

      // Check distance from player start positions
      let tooCloseToPlayer = false;
      for (const pos of avoidPositions) {
        const d1 = Math.sqrt((x1 - pos.x) ** 2 + (y1 - pos.y) ** 2);
        const d2 = Math.sqrt((x2 - pos.x) ** 2 + (y2 - pos.y) ** 2);
        if (d1 < this.PORTAL_MIN_PLAYER_DISTANCE || d2 < this.PORTAL_MIN_PLAYER_DISTANCE) {
          tooCloseToPlayer = true;
          break;
        }
      }

      if (tooCloseToPlayer) {
        continue;
      }

      // Valid portal position found
      return {
        id: this.nextPortalId++,
        x1: Math.floor(x1),
        y1: Math.floor(y1),
        x2: Math.floor(x2),
        y2: Math.floor(y2),
        animFrame: Math.floor(this.rng() * PORTAL_FRAME_COUNT), // Random start frame
      };
    }

    return null;
  }

  // Check if player is touching a portal and teleport them to the other end
  private checkTeleport(player: TronPlayer): void {
    const exit = findPortalExit(this.portals, player.getScreenX(), player.getScreenY());
    if (!exit) return;
    teleportTo(player, exit);
    // Cooldown prevents immediate re-teleport
    player.teleportCooldown = TELEPORT_COOLDOWN_FRAMES;
    this.queueSound('teleport');
  }

  // Check if player picks up an item
  private checkItemPickup(player: TronPlayer): void {
    const px = player.getScreenX();
    const py = player.getScreenY();

    for (const item of this.items) {
      if (!item.active) continue;

      let collision: boolean;

      if (item.mystery) {
        // Triangular collision for mystery items (triangle pointing up)
        collision = this.pointInTriangle(
          px, py,
          item.x, item.y - ITEM_COLLISION_RADIUS,                    // Top vertex
          item.x - ITEM_COLLISION_RADIUS, item.y + ITEM_COLLISION_RADIUS,  // Bottom-left
          item.x + ITEM_COLLISION_RADIUS, item.y + ITEM_COLLISION_RADIUS   // Bottom-right
        );
      } else if (item.category === 'automatic') {
        // Circular collision for automatic (round) items
        const dist = Math.sqrt((px - item.x) ** 2 + (py - item.y) ** 2);
        collision = dist < ITEM_COLLISION_RADIUS;
      } else {
        // Square/box collision for weapon (square) items
        const halfSize = ITEM_COLLISION_RADIUS;
        collision = px >= item.x - halfSize && px <= item.x + halfSize &&
                    py >= item.y - halfSize && py <= item.y + halfSize;
      }

      if (collision) {
        this.pickupItem(player, item);
        item.active = false;
      }
    }
  }

  // Check if point (px, py) is inside triangle defined by vertices (x1,y1), (x2,y2), (x3,y3)
  private pointInTriangle(
    px: number, py: number,
    x1: number, y1: number,
    x2: number, y2: number,
    x3: number, y3: number
  ): boolean {
    // Using barycentric coordinates / sign method
    const sign = (p1x: number, p1y: number, p2x: number, p2y: number, p3x: number, p3y: number) =>
      (p1x - p3x) * (p2y - p3y) - (p2x - p3x) * (p1y - p3y);

    const d1 = sign(px, py, x1, y1, x2, y2);
    const d2 = sign(px, py, x2, y2, x3, y3);
    const d3 = sign(px, py, x3, y3, x1, y1);

    const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
    const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);

    return !(hasNeg && hasPos);
  }

  // Handle item pickup
  private pickupItem(player: TronPlayer, item: GameItem): void {
    const def = item.category === 'automatic'
      ? AUTOMATIC_ITEMS.find(d => d.sprite === item.sprite)
      : WEAPON_ITEMS.find(d => d.sprite === item.sprite);

    if (!def) return;

    if (item.category === 'automatic') {
      // Special handling for instant effects
      if (item.sprite === 'eraser') {
        this.activateEraser();
      } else if (item.sprite === 'random_item') {
        // Swap item uses random_item sprite
        this.activateSwap();
      } else if (item.sprite === 'bodyguard_item') {
        this.activateBodyguard(player);
      } else {
        player.activateEffect(item.sprite, def.duration || 0);
      }
    } else {
      player.equipWeapon(item.sprite, def.ammo, def.duration);
    }

    this.queueSound(def.pickupSound || 'item_pickup');
  }

  // Eraser: clear all trails, restore level, stop border locks
  private activateEraser(): void {
    // Clear all player trails
    for (const player of this.players) {
      player.trail = [];
    }

    // Reset collision map to only level obstacles
    this.pixels.copyFrom(this.levelObstacles);

    // Stop any active border locks
    if (this.borderLocks.size > 0) {
      this.borderLocks.clear();
      this.queueStopLoop('border-lock');
    }

    // Signal renderer to clear trails and restore level
    this.frameEraserUsed = true;
  }

  // Swap (Cambiazo): randomly permute positions of all alive players
  private activateSwap(): void {
    const alivePlayers = this.players.filter(p => p.alive);
    if (alivePlayers.length < 2) return;

    // 10% chance to trigger color blindness effect
    const hasColorBlindness = this.rng() < this.COLOR_BLINDNESS_PROBABILITY;
    if (hasColorBlindness) {
      this.colorBlindnessRemainingFrames = this.COLOR_BLINDNESS_DURATION;
    }

    // Save all positions
    const positions = alivePlayers.map(p => ({ x: p.x, y: p.y, direction: p.direction }));

    // Generate random permutation (Fisher-Yates shuffle)
    // When color blindness is active, "no swap" is also an option (include identity permutation)
    const permutation = positions.map((_, i) => i);

    if (hasColorBlindness) {
      // With color blindness, there's a 1/(n+1) chance of no swap at all
      // by potentially keeping the identity permutation
      if (this.rng() < 1 / (alivePlayers.length + 1)) {
        return; // No swap, just the visual effect
      }
    }

    // Shuffle until we get a derangement (no one stays in place) for a proper swap
    // This ensures every player moves to a different position
    let attempts = 0;
    do {
      // Fisher-Yates shuffle
      for (let i = permutation.length - 1; i > 0; i--) {
        const j = Math.floor(this.rng() * (i + 1));
        [permutation[i], permutation[j]] = [permutation[j]!, permutation[i]!];
      }
      attempts++;
    } while (this.hasFixedPoint(permutation) && attempts < 100);

    // Apply permutation: player i gets position from permutation[i]
    for (let i = 0; i < alivePlayers.length; i++) {
      const player = alivePlayers[i]!;
      const newPos = positions[permutation[i]!]!;
      player.x = newPos.x;
      player.y = newPos.y;
      player.direction = newPos.direction;
    }
  }

  // Check if permutation has any fixed points (element at its original position)
  private hasFixedPoint(perm: number[]): boolean {
    return perm.some((val, idx) => val === idx);
  }

  // Spawn a bodyguard for the player
  private activateBodyguard(player: TronPlayer): void {
    // Spawn new bodyguard at player's current position
    this.bodyguards.push({
      id: this.nextBodyguardId++,
      ownerSlot: player.slotIndex,
      x: player.x,
      y: player.y,
      phaseOffset: 0, // Will be redistributed below
      hp: BODYGUARD_HP,
    });

    // Redistribute phase offsets for all bodyguards of this player
    const playerBodyguards = this.bodyguards.filter(b => b.ownerSlot === player.slotIndex);
    const count = playerBodyguards.length;
    playerBodyguards.forEach((bg, i) => {
      bg.phaseOffset = (360 / count) * i;
    });
  }

  // === Satellites: see design/bodyguards.md ===

  private bodyguardAlive(bg: Bodyguard): boolean {
    return bg.id >= 0 && bg.hp > 0;
  }

  // Satellites spare their owner and, in team mode, the owner's team-mates
  private bodyguardSpares(bg: Bodyguard, slot: SlotIndex): boolean {
    return slot === bg.ownerSlot || (this.gameMode === 'team' && slot % 2 === bg.ownerSlot % 2);
  }

  private wrapDelta(d: number, size: number): number {
    if (d > size / 2) return d - size;
    if (d < -size / 2) return d + size;
    return d;
  }

  // Move a satellite towards a position (shortest way round). Returns the path travelled,
  // in pixels; its end may lie beyond an edge.
  private moveBodyguardToward(
    bg: Bodyguard, targetX: number, targetY: number
  ): { x0: number; y0: number; x1: number; y1: number } {
    const x0 = bg.x / 1000;
    const y0 = bg.y / 1000;
    const dx = this.wrapDelta(targetX - x0, PLAY_WIDTH);
    const dy = this.wrapDelta(targetY - y0, PLAY_HEIGHT);
    const dist = Math.hypot(dx, dy);
    if (dist < 0.001) return { x0, y0, x1: x0, y1: y0 };

    const step = Math.min(dist, this.BODYGUARD_SPEED / 1000);
    const x1 = x0 + (dx / dist) * step;
    const y1 = y0 + (dy / dist) * step;
    bg.x = ((x1 + PLAY_WIDTH) % PLAY_WIDTH) * 1000;
    bg.y = ((y1 + PLAY_HEIGHT) % PLAY_HEIGHT) * 1000;
    return { x0, y0, x1, y1 };
  }

  // The first satellite an enemy projectile meets on the path it travels this tick
  private findBlocker(
    proj: Projectile, x0: number, y0: number, x1: number, y1: number
  ): { bg: Bodyguard; t: number } | null {
    let best: { bg: Bodyguard; t: number } | null = null;
    for (const bg of this.bodyguards) {
      if (bg.ownerSlot === proj.ownerSlot || !this.bodyguardAlive(bg)) continue;
      const bx = bg.x / 1000;
      const by = bg.y / 1000;
      if (proj.type === 'bomb') {
        if (this.bombCovers(proj, bx, by, this.BODYGUARD_BLOCK_RADIUS)) return { bg, t: 0 };
        continue;
      }
      const closest = this.closestOnPath(bx, by, x0, y0, x1, y1);
      if (closest.dist < this.BODYGUARD_BLOCK_RADIUS && (!best || closest.t < best.t)) {
        best = { bg, t: closest.t };
      }
    }
    return best;
  }

  // A satellite stops a projectile and wears down. The caller removes the projectile.
  private blockProjectile(bg: Bodyguard, proj: Projectile): void {
    if (proj.type === 'bomb') {
      // The bomb goes off here (and its blast takes the satellite with it)
      this.bombImpact(Math.floor(proj.x / 1000), Math.floor(proj.y / 1000), proj.ownerSlot);
      return;
    }
    bg.hp -= proj.type === 'bullet' ? this.GLOCK_DAMAGE : this.TRACER_DAMAGE;
    if (bg.hp <= 0) {
      this.explosions.push({
        id: this.nextExplosionId++,
        x: Math.floor(bg.x / 1000),
        y: Math.floor(bg.y / 1000),
        frame: 0,
      });
      this.queueSound('explosion');
    }
  }

  // Drop destroyed satellites and spread the survivors evenly around their orbit
  private removeDeadBodyguards(): void {
    const owners = new Set<SlotIndex>();
    for (const bg of this.bodyguards) {
      if (!this.bodyguardAlive(bg)) owners.add(bg.ownerSlot);
    }
    if (owners.size === 0) return;
    this.bodyguards = this.bodyguards.filter(bg => this.bodyguardAlive(bg));
    for (const ownerSlot of owners) {
      const remaining = this.bodyguards.filter(b => b.ownerSlot === ownerSlot);
      remaining.forEach((bg, i) => {
        bg.phaseOffset = (360 / remaining.length) * i;
      });
    }
  }

  // Where a satellite could stop a projectile: points on its course over the next few
  // ticks that lie inside the owner's area of action, on the way in. Positions are
  // relative to the owner, who is assumed to keep moving as now; `t` is the number of
  // ticks until the projectile gets there. `miss` is how close the course gets.
  private threatPoints(
    proj: Projectile, owner: TronPlayer
  ): { points: { x: number; y: number; t: number }[]; miss: number } | null {
    const rad = (proj.direction * Math.PI) / 180;
    const speed = proj.speed / 1000;
    const ownerRad = (owner.direction * Math.PI) / 180;
    const vx = Math.cos(rad) * speed - Math.cos(ownerRad);
    const vy = Math.sin(rad) * speed - Math.sin(ownerRad);
    const rx = this.wrapDelta((proj.x - owner.x) / 1000, PLAY_WIDTH);
    const ry = this.wrapDelta((proj.y - owner.y) / 1000, PLAY_HEIGHT);
    // Cheap rejection: cannot get near in the time considered
    const reach = this.BODYGUARD_ACTION_RADIUS + (speed + 1) * this.BODYGUARD_LOOKAHEAD;
    if (Math.abs(rx) > reach || Math.abs(ry) > reach) return null;

    // Sample finely enough that a fast tracer cannot jump over the area
    const perTick = Math.max(1, Math.ceil(speed / (this.BODYGUARD_SPEED / 1000)));
    const life = proj.remainingFrames ?? Infinity;
    const inside: { x: number; y: number; t: number; dist: number }[] = [];
    let miss = Infinity;
    for (let k = 0; k <= this.BODYGUARD_LOOKAHEAD * perTick; k++) {
      const t = k / perTick;
      if (t > life) break;
      const x = rx + vx * t;
      const y = ry + vy * t;
      const dist = Math.hypot(x, y);
      if (dist > miss) break; // Past its closest approach: on the way out
      miss = dist;
      if (dist <= this.BODYGUARD_ACTION_RADIUS) inside.push({ x, y, t, dist });
    }
    if (inside.length === 0) return null;
    // Stop it before it is close enough to hurt the owner (a bullet explodes), if possible
    const early = inside.filter(p => p.dist >= this.BODYGUARD_STANDOFF);
    return { points: early.length > 0 ? early : inside, miss };
  }

  // Tick all satellites: pick a job for each, move, and resolve contacts
  private tickBodyguards(): void {
    // Advance shared base angle (all bodyguards orbit in sync)
    this.bodyguardBaseAngle = (this.bodyguardBaseAngle + 360 / this.BODYGUARD_ORBIT_PERIOD) % 360;

    const radius = this.BODYGUARD_ACTION_RADIUS;
    const speed = this.BODYGUARD_SPEED / 1000;
    const blocked = new Set<number>();

    for (const ownerSlot of new Set(this.bodyguards.map(bg => bg.ownerSlot))) {
      const guards = this.bodyguards.filter(bg => bg.ownerSlot === ownerSlot && this.bodyguardAlive(bg));
      const owner = this.players.find(p => p.slotIndex === ownerSlot);
      if (!owner || !owner.alive) {
        for (const bg of guards) bg.id = -1; // Satellites go with their owner
        continue;
      }
      const ownerX = owner.x / 1000;
      const ownerY = owner.y / 1000;
      const relative = (bg: Bodyguard): { x: number; y: number } => ({
        x: this.wrapDelta(bg.x / 1000 - ownerX, PLAY_WIDTH),
        y: this.wrapDelta(bg.y / 1000 - ownerY, PLAY_HEIGHT),
      });

      // Where each satellite should go, relative to the owner
      const targets = new Map<Bodyguard, { x: number; y: number }>();
      const free = new Set(guards);

      // 1. Block projectiles: most urgent threat first, each by the satellite that can
      //    be on its course soonest
      const threats: { points: { x: number; y: number; t: number }[]; miss: number }[] = [];
      for (const proj of this.projectiles) {
        if (proj.ownerSlot === ownerSlot || blocked.has(proj.id)) continue;
        const threat = this.threatPoints(proj, owner);
        if (threat) threats.push(threat);
      }
      // Shots that would hit come before shots that would miss; then the most urgent
      const deadly = (miss: number): number => (miss < this.BODYGUARD_DEADLY_MISS ? 0 : 1);
      threats.sort((a, b) => deadly(a.miss) - deadly(b.miss) || a.points[0]!.t - b.points[0]!.t);
      for (const threat of threats) {
        if (free.size === 0) break;
        let best: { bg: Bodyguard; point: { x: number; y: number }; cost: number } | null = null;
        for (const bg of free) {
          const at = relative(bg);
          // Of the points on the course it can reach in time, the one closest to the
          // owner (a satellite right next to the owner covers a whole spread of shots);
          // failing that, the point it gets closest to reaching
          let point = threat.points[0]!;
          let cost = Infinity;
          for (const candidate of threat.points) {
            // By the time the projectile is `t` ticks ahead the satellite has moved
            // ceil(t) times (at least once: it moves right now)
            const moves = Math.max(1, Math.ceil(candidate.t));
            const short = Math.hypot(candidate.x - at.x, candidate.y - at.y) - this.BODYGUARD_BLOCK_RADIUS - speed * moves;
            const candidateCost = short <= 0 ? Math.hypot(candidate.x, candidate.y) : 1000 + short;
            if (candidateCost < cost) {
              point = candidate;
              cost = candidateCost;
            }
          }
          if (!best || cost < best.cost) best = { bg, point, cost };
        }
        if (best) {
          targets.set(best.bg, best.point);
          free.delete(best.bg);
        }
      }

      // 2. Attack intruders: enemy heads inside the area
      if (free.size > 0) {
        const intruders: { x: number; y: number }[] = [];
        for (const player of this.players) {
          if (!player.alive || this.bodyguardSpares(guards[0]!, player.slotIndex)) continue;
          const x = this.wrapDelta(player.getScreenX() - ownerX, PLAY_WIDTH);
          const y = this.wrapDelta(player.getScreenY() - ownerY, PLAY_HEIGHT);
          if (Math.hypot(x, y) <= radius) intruders.push({ x, y });
        }
        if (intruders.length > 0) {
          for (const bg of free) {
            const at = relative(bg);
            let nearest = intruders[0]!;
            for (const intruder of intruders) {
              if (Math.hypot(intruder.x - at.x, intruder.y - at.y) < Math.hypot(nearest.x - at.x, nearest.y - at.y)) {
                nearest = intruder;
              }
            }
            targets.set(bg, nearest);
          }
        }
      }

      for (const bg of guards) {
        // 3. Nothing to do: orbit the owner (base angle + phase offset)
        let target = targets.get(bg);
        if (!target) {
          const rad = ((this.bodyguardBaseAngle + bg.phaseOffset) * Math.PI) / 180;
          target = { x: Math.cos(rad) * this.BODYGUARD_ORBIT_RADIUS, y: Math.sin(rad) * this.BODYGUARD_ORBIT_RADIUS };
        }
        // Never leave the area of action
        const far = Math.hypot(target.x, target.y);
        if (far > radius) target = { x: (target.x / far) * radius, y: (target.y / far) * radius };

        const path = this.moveBodyguardToward(bg, ownerX + target.x, ownerY + target.y);

        // Enemy projectiles it ran into
        for (const proj of this.projectiles) {
          if (!this.bodyguardAlive(bg)) break;
          if (proj.ownerSlot === bg.ownerSlot || blocked.has(proj.id)) continue;
          const touching = proj.type === 'bomb'
            ? this.bombCovers(proj, bg.x / 1000, bg.y / 1000, this.BODYGUARD_BLOCK_RADIUS)
            : this.distanceToPath(proj.x / 1000, proj.y / 1000, path.x0, path.y0, path.x1, path.y1) < this.BODYGUARD_BLOCK_RADIUS;
          if (touching) {
            this.blockProjectile(bg, proj);
            blocked.add(proj.id);
          }
        }

        // Enemy players it ran into (not once the round is over)
        if (this.phase !== 'waiting_ready') {
          for (const player of this.players) {
            if (!player.alive || this.bodyguardSpares(bg, player.slotIndex)) continue;
            const dist = this.distanceToPath(player.getScreenX(), player.getScreenY(), path.x0, path.y0, path.x1, path.y1);
            if (dist < this.BODYGUARD_KILL_RADIUS) {
              this.killPlayerWithSound(player, false, 'bodyguard');
            }
          }
        }
      }
    }

    if (blocked.size > 0) {
      this.projectiles = this.projectiles.filter(p => !blocked.has(p.id));
    }
    this.removeDeadBodyguards();
  }

  private checkRoundEnd(): void {
    const alivePlayers = this.players.filter(p => p.alive);

    if (this.gameMode === 'ffa') {
      // FFA: Last player standing wins
      if (alivePlayers.length <= 1) {
        this.endRound(alivePlayers);
      }
    } else {
      // Team mode: Check if either team is eliminated
      const team1Alive = alivePlayers.some(p => p.slotIndex % 2 === 0); // Slots 0, 2
      const team2Alive = alivePlayers.some(p => p.slotIndex % 2 === 1); // Slots 1, 3

      if (!team1Alive || !team2Alive) {
        this.endRound(alivePlayers);
      }
    }
  }

  private endRound(alivePlayers: TronPlayer[]): void {
    this.phase = 'waiting_ready';
    this.readyLockTicks = READY_LOCK_TICKS;

    // Clear border lock state
    this.borderLocks.clear();
    this.activeLoops.clear();

    const winner = alivePlayers[0];
    if (!winner) {
      // Draw - no points (no alive players)
      this.roundWinner = 'draw';
    } else if (this.gameMode === 'ffa') {
      // FFA: Winner is the last alive player
      this.roundWinner = winner.slotIndex;
      this.scores.set(winner.slotIndex, (this.scores.get(winner.slotIndex) || 0) + 1);
    } else {
      // Team mode (design/teams.md): every player still standing scores a win; the
      // team score is the sum of its members' wins
      this.roundWinner = winner.slotIndex; // Representative of the winning team
      for (const player of alivePlayers) {
        this.scores.set(player.slotIndex, (this.scores.get(player.slotIndex) || 0) + 1);
      }
    }
  }

  // Serialize for network transmission
  serialize(): TronGameStateData {
    const roundState: TronRoundState = {
      phase: this.phase,
      players: this.players.map(p => p.serialize()),
      countdown: this.countdown,
      roundWinner: this.roundWinner,
      portals: this.portals,
      items: this.items,
      projectiles: this.projectiles,
      explosions: this.explosions,
      bodyguards: this.bodyguards,
      doorTick: this.doorTick,
      ...(this.hand && { hand: { x: this.hand.x, y: this.hand.y } }),
    };

    const matchState: TronMatchState = {
      scores: Object.fromEntries(this.scores),
      currentRound: this.currentRound,
      currentLevelIndex: this.currentLevelIndex,
      playersReady: Array.from(this.playersReady),
      gameMode: this.gameMode,
      levelMode: this.levelMode,
      ridiculousDeath: Object.fromEntries(this.ridiculousDeaths),
    };

    const newTrailSegments = Array.from(this.frameTrailSegments.entries()).map(
      ([slotIndex, segments]) => ({ slotIndex, segments })
    );

    // Capture and clear sound events
    const soundEvents = [...this.frameSoundEvents];
    this.frameSoundEvents = [];

    // Capture and clear border segments
    const borderSegments = this.frameBorderSegments.length > 0
      ? [...this.frameBorderSegments]
      : undefined;
    this.frameBorderSegments.length = 0;

    // Capture and clear eraser flag
    const eraserUsed = this.frameEraserUsed || undefined;
    this.frameEraserUsed = false;

    // Capture and clear ridiculous death slots
    const ridiculousDeathSlots = this.frameRidiculousDeaths.length > 0 ? [...this.frameRidiculousDeaths] : undefined;
    this.frameRidiculousDeaths = [];

    // Capture and clear bullet impact areas
    const clearedAreas = this.frameClearedAreas.length > 0 ? this.frameClearedAreas : undefined;
    this.frameClearedAreas = [];
    const clearedLines = this.frameClearedLines.length > 0 ? this.frameClearedLines : undefined;
    this.frameClearedLines = [];
    const deaths = this.frameDeaths.length > 0 ? this.frameDeaths : undefined;
    this.frameDeaths = [];
    const roundStarted = this.frameRoundStarted || undefined;
    this.frameRoundStarted = false;

    return {
      round: roundState,
      match: matchState,
      newTrailSegments,
      borderSegments,
      soundEvents,
      eraserUsed,
      ridiculousDeathSlots,
      clearedAreas,
      clearedLines,
      roundStarted,
      deaths,
      colorBlindnessFrames: this.colorBlindnessRemainingFrames > 0 ? this.colorBlindnessRemainingFrames : undefined,
      whiteFlashFrames: this.whiteFlashRemainingFrames > 0 ? this.whiteFlashRemainingFrames : undefined,
    };
  }

  // Update from network state (for guests)
  updateFromState(state: TronGameStateData): void {
    // Update round state
    this.phase = state.round.phase;
    this.countdown = state.round.countdown;
    this.roundWinner = state.round.roundWinner;
    this.portals = state.round.portals;
    this.items = state.round.items || [];
    this.doorTick = state.round.doorTick ?? 0;

    // Update player states
    for (const playerState of state.round.players) {
      const player = this.players.find(p => p.slotIndex === playerState.slotIndex);
      if (player) {
        player.updateFromState(playerState);
      }
    }

    // Update match state
    this.currentRound = state.match.currentRound;
    this.currentLevelIndex = state.match.currentLevelIndex;
    this.gameMode = state.match.gameMode;
    this.levelMode = state.match.levelMode;
    this.playersReady = new Set(state.match.playersReady as SlotIndex[]);

    for (const [slot, score] of Object.entries(state.match.scores)) {
      this.scores.set(Number(slot) as SlotIndex, score);
    }

    // Update ridiculous death counts
    if (state.match.ridiculousDeath) {
      for (const [slot, count] of Object.entries(state.match.ridiculousDeath)) {
        this.ridiculousDeaths.set(Number(slot) as SlotIndex, count);
      }
    }

    // Update ridiculous death slots (for rendering)
    this.frameRidiculousDeaths = state.ridiculousDeathSlots ?? [];

    // Add new trail segments
    for (const { slotIndex, segments } of state.newTrailSegments) {
      const player = this.players.find(p => p.slotIndex === slotIndex);
      if (player) {
        for (const seg of segments) {
          player.trail.push(seg);
          this.pixels.set(seg.x, seg.y, player.color);
        }
      }
    }
  }
}
