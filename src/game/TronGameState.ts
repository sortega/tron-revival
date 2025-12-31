// TronGameState - Host-authoritative game state manager

import type { SlotIndex, GameMode } from '../types/lobby';
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

  // Trail collision tracking
  occupiedPixels: Set<string> = new Set();

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

  // Player configs for restarting rounds
  private playerConfigs: GamePlayer[];

  constructor(playerConfigs: GamePlayer[], gameMode: GameMode) {
    this.playerConfigs = playerConfigs;
    this.gameMode = gameMode;

    // Initialize scores
    for (const config of playerConfigs) {
      this.scores.set(config.slotIndex, 0);
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

  // Set level obstacle pixels (called by TronGame after loading level image)
  setLevelObstacles(obstacles: Set<string>): void {
    for (const pixel of obstacles) {
      this.occupiedPixels.add(pixel);
    }
  }

  // Initialize/reset for a new round
  initRound(): void {
    // Clear any pending round-end timeout
    if (this.roundEndTimeout) {
      clearTimeout(this.roundEndTimeout);
      this.roundEndTimeout = null;
    }

    // Stop any looping sounds from previous round
    getSoundManager().stopAllLoops();

    this.phase = 'countdown';
    this.countdown = COUNTDOWN_SECONDS;
    this.roundWinner = null;
    this.occupiedPixels.clear();
    this.frameTrailSegments.clear();
    this.playersReady.clear();
    this.prevActionState.clear();
    this.portals = [];
    this.teleportCooldowns.clear();
    this.items = [];
    this.itemLauncher.reset();

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
        console.log('frameInterval', frameInterval);
        console.log('frameCounter', player.moveFrameCounter);
        if (player.moveFrameCounter >= frameInterval) {
          movesThisFrame = 1;
          player.moveFrameCounter = 0;
        } else {
          movesThisFrame = 0;
        }
      }

      movesPerPlayer.set(player.slotIndex, movesThisFrame);
    }

    console.log('movesPerPlayer', movesPerPlayer);

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

        const input = inputs.get(player.slotIndex) || { left: false, right: false, action: false };
        const newSegments = player.update(input);

        // Check collision immediately after move
        if (player.checkCollision(this.occupiedPixels)) {
          player.kill();
          this.queueSound('laughs');
          continue;
        }

        // Add trail segments to occupied pixels immediately
        for (const seg of newSegments) {
          this.occupiedPixels.add(`${seg.x},${seg.y}`);
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
            // Both players die on diagonal collision
            p1.kill();
            p2.kill();
            this.queueSound('laughs');
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

        if (player.equippedWeapon.ammo !== undefined) {
          // Shot-based weapon: fire only on rising edge (new press)
          const wasPressed = this.prevActionState.get(slotIndex) || false;
          if (input.action && !wasPressed && player.useWeapon()) {
            if (weaponDef?.useSound) {
              this.queueSound(weaponDef.useSound);
            }
          }
        } else if (player.equippedWeapon.remainingFrames !== undefined) {
          // Time-based weapon: consume duration while held
          const loopKey = `weapon-${slotIndex}`;
          if (input.action) {
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

    // Check win condition
    this.checkRoundEnd();
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
      this.currentLevelIndex = (this.currentLevelIndex + 1) % LEVELS.length;
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

    // Debug: log non-standard speed factors
    for (const [slot, factor] of speedFactors) {
      if (factor !== 1) {
        console.log(`[SpeedFactor] Player ${slot}: ${factor}`);
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
      player.activateEffect(item.sprite, def.duration || 0);
    } else {
      player.equipWeapon(item.sprite, def.ammo, def.duration);
    }

    this.queueSound(def.pickupSound || 'item_pickup');
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
    };

    const matchState: TronMatchState = {
      scores: Object.fromEntries(this.scores),
      currentRound: this.currentRound,
      currentLevelIndex: this.currentLevelIndex,
      playersReady: Array.from(this.playersReady),
      gameMode: this.gameMode,
    };

    const newTrailSegments = Array.from(this.frameTrailSegments.entries()).map(
      ([slotIndex, segments]) => ({ slotIndex, segments })
    );

    // Capture and clear sound events
    const soundEvents = [...this.frameSoundEvents];
    this.frameSoundEvents = [];

    return {
      round: roundState,
      match: matchState,
      newTrailSegments,
      soundEvents,
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
    this.playersReady = new Set(state.match.playersReady as SlotIndex[]);

    for (const [slot, score] of Object.entries(state.match.scores)) {
      this.scores.set(Number(slot) as SlotIndex, score);
    }

    // Add new trail segments
    for (const { slotIndex, segments } of state.newTrailSegments) {
      const player = this.players.find(p => p.slotIndex === slotIndex);
      if (player) {
        for (const seg of segments) {
          player.trail.push(seg);
          this.occupiedPixels.add(`${seg.x},${seg.y}`);
        }
      }
    }
  }
}
