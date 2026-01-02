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
} from '../types/game';
import type { GamePlayer } from '../types/game';
import {
  LEVELS,
  PORTAL_RADIUS,
  PORTAL_OUTER_RADIUS,
  PORTAL_FRAME_COUNT,
  AUTOMATIC_ITEMS,
  WEAPON_ITEMS,
  ITEM_COLLISION_RADIUS,
} from '../types/game';
import { TronPlayer, getStartingPosition, PLAY_WIDTH, PLAY_HEIGHT } from './TronPlayer';
import { ItemLauncher } from './ItemLauncher';
import { getSoundManager } from './SoundManager';

const COUNTDOWN_SECONDS = 3;

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
  playersReady: Set<SlotIndex> = new Set();
  gameMode: GameMode;
  levelMode: LevelMode;

  // Trail collision tracking - maps pixel coordinates to their color
  pixelOwners: Map<string, string> = new Map();

  // Ridiculous death tracking (crashing into own color)
  ridiculousDeaths: Map<SlotIndex, number> = new Map();
  // Track ridiculous death events this frame (for sidebar display) - multiple players can have it
  frameRidiculousDeaths: SlotIndex[] = [];

  // Level obstacles with colors (stored separately for eraser restore)
  private levelObstacles: Map<string, string> = new Map();

  // Teleport portals
  portals: TeleportPortal[] = [];
  private nextPortalId = 0;
  private readonly PORTAL_MIN_DISTANCE = 100;       // Minimum distance between portal endpoints
  private readonly PORTAL_MIN_PLAYER_DISTANCE = 80; // Minimum distance from player start positions

  // Items
  items: GameItem[] = [];
  private itemLauncher = new ItemLauncher();

  // Track teleport cooldowns to prevent instant re-teleport
  private teleportCooldowns: Map<SlotIndex, number> = new Map();
  private readonly TELEPORT_COOLDOWN_FRAMES = 35;   // 0.5 seconds at 70fps

  // New trail segments this frame (for network efficiency)
  private frameTrailSegments: Map<SlotIndex, TrailSegment[]> = new Map();

  // Sound events this frame (for network sync)
  private frameSoundEvents: SoundEvent[] = [];

  // Track previous action state for one-shot ready detection
  private prevActionState: Map<SlotIndex, boolean> = new Map();

  // Timeout for round end transition (stored for cleanup)
  private roundEndTimeout: ReturnType<typeof setTimeout> | null = null;

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
  private frameClearedAreas: { x: number; y: number; radius: number }[] = [];

  // Projectile system
  private projectiles: Projectile[] = [];
  private explosions: Explosion[] = [];
  private nextProjectileId = 0;
  private nextExplosionId = 0;

  // Projectile constants (Glock bullets)
  private readonly BULLET_BASE_SPEED = 5000;  // 5 pixels/frame in fixed-point (at speed factor 1)
  private readonly BULLET_KILL_RADIUS = 6;    // Kill players within 6 pixels
  private readonly BULLET_CLEAR_RADIUS = 5;   // Clear 10x10 area (±5)
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
  private readonly UZI_MIN_SPEED = 5000;       // 5 pixels/frame in fixed-point
  private readonly UZI_MAX_SPEED = 25000;       // 25 pixels/frame in fixed-point
  private readonly UZI_TRACER_LIFESPAN = 2;     // 1 frame lifespan (immediate spray effect)

  // Color blindness effect state (triggered by Swap item)
  private colorBlindnessRemainingFrames: number = 0;
  private readonly COLOR_BLINDNESS_DURATION = 280;   // 4 seconds at 70fps
  private readonly COLOR_BLINDNESS_PROBABILITY = 0.1; // 10% chance

  // Player configs for restarting rounds
  private playerConfigs: GamePlayer[];

  constructor(playerConfigs: GamePlayer[], gameMode: GameMode, levelMode: LevelMode) {
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

  // Queue a sound event for network sync
  private queueSound(sound: string): void {
    this.frameSoundEvents.push({ sound });
  }

  // Queue a looping sound
  private queueLoopSound(sound: string, loopKey: string): void {
    this.frameSoundEvents.push({ sound, loop: true, loopKey });
  }

  // Queue stopping a looping sound
  private queueStopLoop(loopKey: string): void {
    this.frameSoundEvents.push({ sound: '', stopLoop: loopKey });
  }

  // Kill a player and handle ridiculous death if applicable
  private killPlayerWithSound(player: TronPlayer, isRidiculousDeath: boolean): void {
    player.kill();
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
  setLevelObstacles(obstacles: Map<string, string>): void {
    // Store separately for eraser restore
    this.levelObstacles = new Map(obstacles);
    // Add to collision map
    for (const [pixel, color] of obstacles) {
      this.pixelOwners.set(pixel, color);
    }
  }

  // Initialize/reset for a new round
  initRound(): void {
    // Clear any pending round-end timeout
    if (this.roundEndTimeout) {
      clearTimeout(this.roundEndTimeout);
      this.roundEndTimeout = null;
    }

    this.phase = 'countdown';
    this.countdown = COUNTDOWN_SECONDS;
    this.roundWinner = null;
    this.pixelOwners.clear();
    this.frameTrailSegments.clear();
    this.playersReady.clear();
    this.prevActionState.clear();
    this.portals = [];
    this.teleportCooldowns.clear();
    this.items = [];
    this.itemLauncher.reset();
    this.borderLocks.clear();
    this.frameBorderSegments.length = 0;
    this.projectiles = [];
    this.explosions = [];
    this.rifleBurstState.clear();
    this.colorBlindnessRemainingFrames = 0;

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

      case 'round_end':
        // Process ready signals during round_end (same as waiting_ready)
        this.tickWaitingReady(inputs);
        break;

      case 'waiting_ready':
        this.tickWaitingReady(inputs);
        break;
    }
  }

  private tickCountdown(): void {
    this.countdown -= 1 / 70; // Assuming 70fps

    if (this.countdown <= 0) {
      this.countdown = 0;
      this.phase = 'playing';
      this.queueSound('round_start');
    }
  }

  private tickPlaying(inputs: Map<SlotIndex, TronInput>): void {
    // Animate portals
    for (const portal of this.portals) {
      portal.animFrame = (portal.animFrame + 1) % PORTAL_FRAME_COUNT;
    }

    // Decrement teleport cooldowns
    for (const [slotIndex, cooldown] of this.teleportCooldowns) {
      if (cooldown > 0) {
        this.teleportCooldowns.set(slotIndex, cooldown - 1);
      }
    }

    // Calculate speedFactors for all players
    const speedFactors = this.calculateSpeedFactors(inputs);

    // Calculate moves per frame for each player
    const movesPerPlayer: Map<SlotIndex, number> = new Map();
    for (const player of this.players) {
      if (!player.alive) continue;

      const factor = speedFactors.get(player.slotIndex) ?? 1;
      let movesThisFrame: number;

      if (factor >= 1) {
        // Fast: move 'factor' times this frame
        movesThisFrame = factor;
      } else {
        // Slow: move once every N frames where N = 2 - factor
        // factor 0 -> every 2 frames, factor -1 -> every 3 frames, etc.
        player.moveFrameCounter++;
        const frameInterval = 2 - factor;
        if (player.moveFrameCounter >= frameInterval) {
          movesThisFrame = 1;
          player.moveFrameCounter = 0;
        } else {
          movesThisFrame = 0;
        }
      }

      movesPerPlayer.set(player.slotIndex, movesThisFrame);
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

        let input = inputs.get(player.slotIndex) || { left: false, right: false, action: false };

        // Control Reversal effect swaps left/right
        if (player.hasEffect('reverse')) {
          input = { left: input.right, right: input.left, action: input.action };
        }

        const newSegments = player.update(input);

        // Check collision immediately after move
        const collisionPixel = player.checkCollision(this.pixelOwners);
        if (collisionPixel) {
          const pixelOwner = this.pixelOwners.get(collisionPixel);
          const hasShield = player.hasEffect('shield');
          const hasCrossing = player.hasEffect('crossing');
          const isOwnColor = pixelOwner === player.color;

          // Shield: complete invincibility
          // Crossing: can pass through own color only
          const isProtected = hasShield || (hasCrossing && isOwnColor);

          if (!isProtected) {
            this.killPlayerWithSound(player, isOwnColor);
            continue;
          }
        }

        // Add trail segments to collision map
        for (const seg of newSegments) {
          this.pixelOwners.set(`${seg.x},${seg.y}`, player.color);
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

          // Check if movement segments intersect
          if (segmentsIntersect(
            p1.prevScreenX, p1.prevScreenY, p1.getScreenX(), p1.getScreenY(),
            p2.prevScreenX, p2.prevScreenY, p2.getScreenX(), p2.getScreenY()
          )) {
            // Players with shield survive diagonal collision
            const p1HasShield = p1.hasEffect('shield');
            const p2HasShield = p2.hasEffect('shield');

            if (!p1HasShield) p1.kill();
            if (!p2HasShield) p2.kill();

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
      const cooldown = this.teleportCooldowns.get(player.slotIndex) || 0;
      if (cooldown === 0) {
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

    // Update projectiles
    this.tickProjectiles();

    // Update explosions
    this.tickExplosions();

    // Tick color blindness effect
    if (this.colorBlindnessRemainingFrames > 0) {
      this.colorBlindnessRemainingFrames--;
    }

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
          this.pixelOwners.set(`${x},0`, lock.color);
          segments.push({ x, y: 0 });
          // Bottom edge (y=PLAY_HEIGHT-1)
          this.pixelOwners.set(`${x},${PLAY_HEIGHT - 1}`, lock.color);
          segments.push({ x, y: PLAY_HEIGHT - 1 });
        }
      }

      // Draw 4 segments on vertical edges per frame (600 height / 150 = 4)
      for (let i = 0; i < 4; i++) {
        const y = z + i * 150;
        if (y < PLAY_HEIGHT) {
          // Left edge (x=0)
          this.pixelOwners.set(`0,${y}`, lock.color);
          segments.push({ x: 0, y });
          // Right edge (x=PLAY_WIDTH-1)
          this.pixelOwners.set(`${PLAY_WIDTH - 1},${y}`, lock.color);
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
      const spreadAngle = (Math.random() * 2 - 1) * this.UZI_SPREAD_DEGREES;
      const direction = player.direction + spreadAngle;
      const dirRad = (direction * Math.PI) / 180;

      // Random speed between 10-50 pixels/frame
      const speed = this.UZI_MIN_SPEED + Math.random() * (this.UZI_MAX_SPEED - this.UZI_MIN_SPEED);

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

  // Move projectiles and check collisions
  private tickProjectiles(): void {
    const toRemove: number[] = [];

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
      const impactPoint = this.checkLineCollision(prevX, prevY, unwrappedX, unwrappedY);
      if (impactPoint) {
        if (proj.type === 'bullet') {
          this.projectileImpact(impactPoint.x, impactPoint.y, proj.ownerSlot);
        } else {
          // Clear path up to impact point, then expire
          this.clearPixelPath(prevX, prevY, impactPoint.x, impactPoint.y);
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

      // Check collision with players (shield does NOT protect!)
      const killRadius = proj.type === 'bullet' ? this.BULLET_KILL_RADIUS : this.TRACER_KILL_RADIUS;
      let hitPlayer = false;
      for (const player of this.players) {
        if (!player.alive) continue;
        // Skip owner during cooldown period
        if (skipOwner && player.slotIndex === proj.ownerSlot) continue;
        const px = player.getScreenX();
        const py = player.getScreenY();
        // Check distance to the line segment, not just endpoints
        const dist = this.pointToLineDistance(px, py, prevX, prevY, newX, newY);
        if (dist < killRadius) {
          if (proj.type === 'bullet') {
            this.projectileImpact(px, py, proj.ownerSlot);
          } else {
            this.tracerExpire(px, py);
            this.killPlayerWithSound(player, player.slotIndex === proj.ownerSlot);
          }
          toRemove.push(proj.id);
          hitPlayer = true;
          break;
        }
      }
      if (hitPlayer) continue;

      // Check collision with items
      let hitItem = false;
      for (const item of this.items) {
        if (!item.active) continue;
        // Check distance to the line segment
        const dist = this.pointToLineDistance(item.x, item.y, prevX, prevY, newX, newY);
        if (dist < ITEM_COLLISION_RADIUS) {
          if (proj.type === 'bullet') {
            this.projectileImpact(item.x, item.y, proj.ownerSlot);
          } else {
            this.tracerExpire(item.x, item.y);
            item.active = false;  // Tracer destroys the item it hits
          }
          toRemove.push(proj.id);
          hitItem = true;
          break;
        }
      }
      if (hitItem) continue;

      // Check collision with other projectiles
      for (const other of this.projectiles) {
        if (other.id === proj.id) continue;
        if (toRemove.includes(other.id)) continue;
        const otherX = Math.floor(other.x / 1000);
        const otherY = Math.floor(other.y / 1000);
        const dist = Math.sqrt((newX - otherX) ** 2 + (newY - otherY) ** 2);
        if (dist < 3) {  // Small collision radius for projectiles
          // Both projectiles are destroyed
          const midX = Math.floor((newX + otherX) / 2);
          const midY = Math.floor((newY + otherY) / 2);
          // If either is a bullet, create explosion (pass first bullet's owner for self-kill check)
          if (proj.type === 'bullet' || other.type === 'bullet') {
            const bulletOwner = proj.type === 'bullet' ? proj.ownerSlot : other.ownerSlot;
            this.projectileImpact(midX, midY, bulletOwner);
          } else {
            this.tracerExpire(midX, midY);
          }
          toRemove.push(proj.id);
          toRemove.push(other.id);
          break;
        }
      }
    }

    // Remove impacted projectiles
    this.projectiles = this.projectiles.filter(p => !toRemove.includes(p.id));
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
    // Bresenham's algorithm - clear each pixel along path
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;

    let x = x0, y = y0;
    while (true) {
      const wx = ((x % PLAY_WIDTH) + PLAY_WIDTH) % PLAY_WIDTH;
      const wy = ((y % PLAY_HEIGHT) + PLAY_HEIGHT) % PLAY_HEIGHT;
      const key = `${wx},${wy}`;
      this.pixelOwners.delete(key);
      this.levelObstacles.delete(key);  // Also clear level obstacles
      this.frameClearedAreas.push({ x: wx, y: wy, radius: 0 });  // Single pixel

      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
  }

  // Tracer bullet expiration (no explosion)
  private tracerExpire(x: number, y: number): void {
    // Clear 3x3 area
    for (let dx = -this.TRACER_CLEAR_RADIUS; dx <= this.TRACER_CLEAR_RADIUS; dx++) {
      for (let dy = -this.TRACER_CLEAR_RADIUS; dy <= this.TRACER_CLEAR_RADIUS; dy++) {
        const cx = ((x + dx) % PLAY_WIDTH + PLAY_WIDTH) % PLAY_WIDTH;
        const cy = ((y + dy) % PLAY_HEIGHT + PLAY_HEIGHT) % PLAY_HEIGHT;
        const key = `${cx},${cy}`;
        this.pixelOwners.delete(key);
        this.levelObstacles.delete(key);  // Also clear level obstacles
      }
    }
    this.frameClearedAreas.push({ x, y, radius: this.TRACER_CLEAR_RADIUS });
    // No explosion, no bomb sound
  }

  // Check all pixels along a line for collision (Bresenham's algorithm)
  private checkLineCollision(x0: number, y0: number, x1: number, y1: number): { x: number; y: number } | null {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;

    let x = x0;
    let y = y0;

    while (true) {
      // Check this pixel (with wrap-around)
      const wx = ((x % PLAY_WIDTH) + PLAY_WIDTH) % PLAY_WIDTH;
      const wy = ((y % PLAY_HEIGHT) + PLAY_HEIGHT) % PLAY_HEIGHT;
      const key = `${wx},${wy}`;

      // Check both player trails AND level obstacles
      if (this.pixelOwners.has(key) || this.levelObstacles.has(key)) {
        return { x: wx, y: wy };
      }

      if (x === x1 && y === y1) break;

      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        x += sx;
      }
      if (e2 < dx) {
        err += dx;
        y += sy;
      }
    }

    return null;
  }

  // Calculate distance from point to line segment
  private pointToLineDistance(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;

    if (lenSq === 0) {
      // Line segment is a point
      return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);
    }

    // Project point onto line, clamped to segment
    let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));

    const closestX = x1 + t * dx;
    const closestY = y1 + t * dy;

    return Math.sqrt((px - closestX) ** 2 + (py - closestY) ** 2);
  }

  // Handle projectile impact - explosion, clear area, kill nearby players
  private projectileImpact(x: number, y: number, ownerSlot?: SlotIndex): void {
    // Create explosion animation
    this.explosions.push({
      id: this.nextExplosionId++,
      x,
      y,
      frame: 0,
    });

    // Clear 10x10 pixel area (with wrap-around)
    for (let dx = -this.BULLET_CLEAR_RADIUS; dx < this.BULLET_CLEAR_RADIUS; dx++) {
      for (let dy = -this.BULLET_CLEAR_RADIUS; dy < this.BULLET_CLEAR_RADIUS; dy++) {
        const cx = ((x + dx) % PLAY_WIDTH + PLAY_WIDTH) % PLAY_WIDTH;
        const cy = ((y + dy) % PLAY_HEIGHT + PLAY_HEIGHT) % PLAY_HEIGHT;
        this.pixelOwners.delete(`${cx},${cy}`);
      }
    }

    // Track cleared area for renderer
    this.frameClearedAreas.push({ x, y, radius: this.BULLET_CLEAR_RADIUS });

    // Kill players within 6 pixels (NO SHIELD CHECK - explicit requirement!)
    for (const player of this.players) {
      if (!player.alive) continue;
      const px = player.getScreenX();
      const py = player.getScreenY();
      const dist = Math.sqrt((px - x) ** 2 + (py - y) ** 2);
      if (dist < this.BULLET_KILL_RADIUS) {
        const isSelfKill = ownerSlot !== undefined && player.slotIndex === ownerSlot;
        this.killPlayerWithSound(player, isSelfKill);
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

  // Advance explosion animations
  private tickExplosions(): void {
    for (const exp of this.explosions) {
      exp.frame++;
    }
    // Remove finished explosions
    this.explosions = this.explosions.filter(e => e.frame < this.EXPLOSION_FRAMES);
  }

  private tickWaitingReady(inputs: Map<SlotIndex, TronInput>): void {
    // Check for action key presses (one-shot: only on rising edge)
    for (const [slotIndex, input] of inputs) {
      const wasPressed = this.prevActionState.get(slotIndex) || false;
      const isPressed = input.action;

      // Toggle ready on rising edge (key just pressed)
      if (isPressed && !wasPressed) {
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
      const x1 = margin + Math.random() * (PLAY_WIDTH - 2 * margin);
      const y1 = margin + Math.random() * (PLAY_HEIGHT - 2 * margin);

      // Random position for second endpoint
      const x2 = margin + Math.random() * (PLAY_WIDTH - 2 * margin);
      const y2 = margin + Math.random() * (PLAY_HEIGHT - 2 * margin);

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
        animFrame: Math.floor(Math.random() * PORTAL_FRAME_COUNT), // Random start frame
      };
    }

    return null;
  }

  // Check if player is touching a portal and teleport them
  private checkTeleport(player: TronPlayer): void {
    const px = player.getScreenX();
    const py = player.getScreenY();

    for (const portal of this.portals) {
      // Check distance to first endpoint
      const d1 = Math.sqrt((px - portal.x1) ** 2 + (py - portal.y1) ** 2);
      if (d1 < PORTAL_RADIUS) {
        this.teleportPlayer(player, portal.x2, portal.y2);
        return;
      }

      // Check distance to second endpoint
      const d2 = Math.sqrt((px - portal.x2) ** 2 + (py - portal.y2) ** 2);
      if (d2 < PORTAL_RADIUS) {
        this.teleportPlayer(player, portal.x1, portal.y1);
        return;
      }
    }
  }

  // Teleport a player to the outer ring of a portal, maintaining direction
  private teleportPlayer(player: TronPlayer, portalX: number, portalY: number): void {
    // Calculate exit position on the outer ring of the destination portal
    // Player appears on the outer edge, moving in the same direction
    const dirRad = (player.direction * Math.PI) / 180;
    const exitX = portalX + Math.cos(dirRad) * PORTAL_OUTER_RADIUS;
    const exitY = portalY + Math.sin(dirRad) * PORTAL_OUTER_RADIUS;

    // Update player position (convert to fixed-point)
    player.x = Math.floor(exitX * 1000);
    player.y = Math.floor(exitY * 1000);

    // Set cooldown to prevent immediate re-teleport
    this.teleportCooldowns.set(player.slotIndex, this.TELEPORT_COOLDOWN_FRAMES);

    this.queueSound('teleport');
  }

  // Check if player picks up an item
  private checkItemPickup(player: TronPlayer): void {
    const px = player.getScreenX();
    const py = player.getScreenY();

    for (const item of this.items) {
      if (!item.active) continue;

      let collision = false;

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
    this.pixelOwners = new Map(this.levelObstacles);

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
    const hasColorBlindness = Math.random() < this.COLOR_BLINDNESS_PROBABILITY;
    if (hasColorBlindness) {
      this.colorBlindnessRemainingFrames = this.COLOR_BLINDNESS_DURATION;
    }

    // Save all positions
    const positions = alivePlayers.map(p => ({ x: p.x, y: p.y, direction: p.direction }));

    // Generate random permutation (Fisher-Yates shuffle)
    // When color blindness is active, "no swap" is also an option (include identity permutation)
    let permutation = positions.map((_, i) => i);

    if (hasColorBlindness) {
      // With color blindness, there's a 1/(n+1) chance of no swap at all
      // by potentially keeping the identity permutation
      if (Math.random() < 1 / (alivePlayers.length + 1)) {
        return; // No swap, just the visual effect
      }
    }

    // Shuffle until we get a derangement (no one stays in place) for a proper swap
    // This ensures every player moves to a different position
    let attempts = 0;
    do {
      // Fisher-Yates shuffle
      for (let i = permutation.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
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
    this.phase = 'round_end';

    // Clear any pending sound events (prevents loop-start events from replaying after round ends)
    this.frameSoundEvents = [];

    // Stop all sound loops at end of round
    getSoundManager().stopAllLoops();

    // Clear border lock state
    this.borderLocks.clear();

    const winner = alivePlayers[0];
    if (!winner) {
      // Draw - no points (no alive players)
      this.roundWinner = 'draw';
    } else if (this.gameMode === 'ffa') {
      // FFA: Winner is the last alive player
      this.roundWinner = winner.slotIndex;
      this.scores.set(winner.slotIndex, (this.scores.get(winner.slotIndex) || 0) + 1);
    } else {
      // Team mode: Winning team members all get a point
      const winningTeam = winner.slotIndex % 2; // 0 for team 1, 1 for team 2
      this.roundWinner = winner.slotIndex; // Representative winner

      // Award points to all team members
      for (const player of this.players) {
        if (player.slotIndex % 2 === winningTeam) {
          this.scores.set(player.slotIndex, (this.scores.get(player.slotIndex) || 0) + 1);
        }
      }
    }

    // Transition to waiting after a brief delay
    // Note: Don't clear playersReady here - players can signal ready during round_end
    // and their status should be preserved. playersReady is cleared in initRound().
    this.roundEndTimeout = setTimeout(() => {
      if (this.phase === 'round_end') {
        this.phase = 'waiting_ready';
      }
      this.roundEndTimeout = null;
    }, 2000);
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
    const clearedAreas = this.frameClearedAreas.length > 0 ? [...this.frameClearedAreas] : undefined;
    this.frameClearedAreas = [];

    return {
      round: roundState,
      match: matchState,
      newTrailSegments,
      borderSegments,
      soundEvents,
      eraserUsed,
      ridiculousDeathSlots,
      clearedAreas,
      colorBlindnessFrames: this.colorBlindnessRemainingFrames > 0 ? this.colorBlindnessRemainingFrames : undefined,
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
          this.pixelOwners.set(`${seg.x},${seg.y}`, player.color);
        }
      }
    }
  }
}
