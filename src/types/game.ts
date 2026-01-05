// Game types - clean interface between lobby and game

import type { SlotIndex, GameMode, LevelMode } from './lobby';

export interface GamePlayer {
  slotIndex: SlotIndex;
  nickname: string;
  color: string;
  isLocal: boolean;  // This player is controlled locally
}

export interface Spectator {
  nickname: string;
}

export interface GameConfig {
  players: GamePlayer[];
  spectators: Spectator[];
  isHost: boolean;
  gameMode: GameMode;
  levelMode: LevelMode;
}

// === Tron Game Types ===

export interface TrailSegment {
  x: number;  // Screen pixel
  y: number;  // Screen pixel
}

// Projectile type: 'bullet' = Glock (explodes on impact), 'tracer' = Rifle (clears trail, has lifespan), 'bomb' = heavy missile
export type ProjectileType = 'bullet' | 'tracer' | 'bomb';

// Projectile in flight (bullets from Glock, tracers from Rifle, bombs)
export interface Projectile {
  id: number;
  x: number;           // Fixed-point ×1000
  y: number;           // Fixed-point ×1000
  direction: number;   // Angle in degrees
  ownerSlot: SlotIndex;
  speed: number;       // Speed in fixed-point (pixels × 1000)
  type: ProjectileType;          // Determines behavior on collision
  remainingFrames?: number;      // Lifespan for tracer bullets (undefined = infinite)
  ownerCooldown?: number;        // Frames until owner collision is checked (prevents instant self-kill)
  hp?: number;                   // Bomb HP (starts at 100, destroyed when reaches 0)
}

// Explosion animation
export interface Explosion {
  id: number;
  x: number;           // Screen pixel
  y: number;           // Screen pixel
  frame: number;       // 0-38 (39 frames)
  scale?: number;      // Render scale (default 0.2, bomb uses 0.3)
}

// Bodyguard - orbiting protective entity
export interface Bodyguard {
  id: number;
  ownerSlot: SlotIndex;
  x: number;           // Fixed-point ×1000
  y: number;           // Fixed-point ×1000
  phaseOffset: number; // Phase offset in degrees (for multiple bodyguards)
}

// Player state during gameplay (serializable for network)
export interface TronPlayerState {
  slotIndex: SlotIndex;
  x: number;           // Fixed-point ×1000
  y: number;           // Fixed-point ×1000
  direction: number;   // Angle in degrees (0-360)
  alive: boolean;
  color: string;
  nickname: string;
  equippedWeapon: EquippedWeapon | null;
  activeEffects: ActiveEffect[];
}

export type RoundPhase = 'countdown' | 'playing' | 'waiting_ready';

// Full round state (broadcast by host)
export interface TronRoundState {
  phase: RoundPhase;
  players: TronPlayerState[];
  countdown: number;           // Seconds remaining in countdown
  roundWinner: SlotIndex | 'draw' | null;
  portals: TeleportPortal[];   // Active teleport portals
  items: GameItem[];           // Spawned items in world
  projectiles: Projectile[];   // Bullets in flight
  explosions: Explosion[];     // Active explosion animations
  bodyguards: Bodyguard[];     // Active bodyguards
}

// Match state (scores, ready status)
export interface TronMatchState {
  scores: Partial<Record<SlotIndex, number>>;  // slotIndex -> score (only active slots)
  currentRound: number;
  currentLevelIndex: number;  // Index into LEVELS array
  playersReady: SlotIndex[];  // Slots that pressed action
  gameMode: GameMode;
  levelMode: LevelMode;
  ridiculousDeath: Partial<Record<SlotIndex, number>>;  // Deaths by crashing into own color
}

// Sound event for network sync
export interface SoundEvent {
  sound: string;  // SoundName, but using string for serialization
  loop?: boolean;
  loopKey?: string;
  stopLoop?: string;  // Key of loop to stop
}

// Full game state for network broadcast
export interface TronGameStateData {
  round: TronRoundState;
  match: TronMatchState;
  // Trail data sent separately for efficiency - only new segments
  newTrailSegments: { slotIndex: SlotIndex; segments: TrailSegment[] }[];
  // Border lock segments (for rendering animated border) - multiple players can have active locks
  borderSegments?: { color: string; segments: TrailSegment[] }[];
  // Sound events to play on this frame
  soundEvents: SoundEvent[];
  // Eraser was used - renderer should clear trails and restore level
  eraserUsed?: boolean;
  // Ridiculous death happened - show it in these players' sidebar slots
  ridiculousDeathSlots?: SlotIndex[];
  // Cleared pixel areas (from bullet impacts) - renderer should clear these from trail canvas
  clearedAreas?: { x: number; y: number; radius: number }[];
  // Color blindness effect remaining frames (for trail color cycling and sprite animation)
  colorBlindnessFrames?: number;
  // White flash effect remaining frames (bomb-on-bomb collision)
  whiteFlashFrames?: number;
  // Timestamp when state was sent (for lag estimation)
  sentAt?: number;
  // Echo of guest's pingTimestamp for RTT measurement
  pongTimestamp?: number;
}

// Input includes action key for ready signal
export interface TronInput {
  left: boolean;
  right: boolean;
  action: boolean;  // Ready signal / special action
  pingTimestamp?: number;  // For RTT measurement (guest's Date.now() when sending)
}

// === Teleport Portal Types ===

export interface TeleportPortal {
  id: number;
  // Entry point
  x1: number;  // Screen pixel (center)
  y1: number;  // Screen pixel (center)
  // Exit point
  x2: number;  // Screen pixel (center)
  y2: number;  // Screen pixel (center)
  animFrame: number;  // Current animation frame (0-29)
}

// Portal constants
export const PORTAL_RADIUS = 14;  // Collision radius (matches 40x40 sprite visual radius)
export const PORTAL_OUTER_RADIUS = 18;  // Where player appears after teleport
export const PORTAL_FRAME_COUNT = 30;  // Animation frames (portal_01 to portal_30)

// === Level Types ===

export interface LevelDefinition {
  id: string;
  name: string;
  imagePath: string;
}

// Level image filenames (relative to /assets/levels/)
// The full path is constructed at runtime using import.meta.env.BASE_URL
export const LEVEL_DEFINITIONS: { id: string; name: string; imageFile: string }[] = [
  { id: 'blank', name: 'Blank', imageFile: 'blank.png' },
  { id: 'pop-culture', name: 'Pop Culture', imageFile: 'pop-culture.png' },
  { id: 'selva', name: 'Selva', imageFile: 'selva.png' },
  { id: 'bricks', name: 'Bricks', imageFile: 'bricks.png' },
  { id: 'bus', name: 'Bus', imageFile: 'bus.png' },
  { id: 'dentistry', name: 'Dentistry', imageFile: 'dentistry.png' },
  { id: 'warzone', name: 'Warzone', imageFile: 'warzone.png' },
  { id: 'portals', name: 'Portals', imageFile: 'portals.png' },
];

// Level order (cycles after last level) - constructed with full paths
export const LEVELS: LevelDefinition[] = LEVEL_DEFINITIONS.map(def => ({
  id: def.id,
  name: def.name,
  imagePath: `${import.meta.env.BASE_URL}assets/levels/${def.imageFile}`,
}));

// === Item Types ===

// Item category determines activation behavior
export type ItemCategory = 'automatic' | 'weapon';

// Import and re-export sound types from SoundManager
import type { PickupSound, UseSound } from '../game/SoundManager';
export type { PickupSound, UseSound } from '../game/SoundManager';

// Item definition (static configuration)
export interface ItemDefinition {
  name: string;
  sprite: string;         // Sprite name (also serves as unique identifier)
  category: ItemCategory;
  duration?: number;      // Frames at 70fps (automatic items + time-based weapons)
  ammo?: number;          // Shot count (shot-based weapons only)
  pickupSound?: PickupSound;  // Sound when picked up (default: 'item_pickup')
  useSound?: UseSound;        // Sound when weapon is used (weapons only)
  loopSound?: boolean;        // Loop useSound while held (time-based weapons)
}

// Spawned item in the game world
export interface GameItem {
  id: number;             // Unique instance id for this spawn
  sprite: string;         // References ItemDefinition.sprite
  category: ItemCategory;
  x: number;              // Screen position
  y: number;
  active: boolean;
  mystery?: boolean;      // Uses random_item sprite with triangular collision
  hp: number;             // Item HP (destroyed when reaches 0)
}

// Player's equipped weapon (square items)
export interface EquippedWeapon {
  sprite: string;           // References ItemDefinition.sprite
  ammo?: number;            // Remaining shots (shot-based weapons)
  remainingFrames?: number; // Remaining duration (time-based weapons)
}

// Player's active effect (round items)
export interface ActiveEffect {
  sprite: string;         // References ItemDefinition.sprite
  remainingFrames: number;
}

// Automatic items (round) - instant activation on pickup
export const AUTOMATIC_ITEMS: ItemDefinition[] = [
  { name: 'Crossing', sprite: 'crossing', category: 'automatic', duration: 2100, pickupSound: 'shield' },    // 30s - cross own trail
  { name: 'Shield', sprite: 'shield', category: 'automatic', duration: 2100, pickupSound: 'shield' },        // 30s - invincible
  { name: 'Eraser', sprite: 'eraser', category: 'automatic', duration: 0, pickupSound: 'reset' },            // Instant
  { name: 'Swap', sprite: 'random_item', category: 'automatic', duration: 0, pickupSound: 'teleport' },         // Instant
  { name: 'Bodyguard', sprite: 'bodyguard_item', category: 'automatic', duration: 0, pickupSound: 'item_pickup' }, // Spawns orbiting protector
  { name: 'Control Reversal', sprite: 'reverse', category: 'automatic', duration: 700, pickupSound: 'item_pickup' }, // 10s - self-debuff!
  { name: 'Slow', sprite: 'automatic_slow', category: 'automatic', duration: 1400, pickupSound: 'slow' },    // 20s
  { name: 'Turbo', sprite: 'automatic_turbo', category: 'automatic', duration: 1400, pickupSound: 'turbo' }, // 20s
];

// Weapon items (square) - manual activation with action button
export const WEAPON_ITEMS: ItemDefinition[] = [
  // Shot-based weapons (use ammo)
  { name: 'Glock', sprite: 'glock', category: 'weapon', ammo: 20, useSound: 'glock' },
  { name: 'Rifle', sprite: 'rifle', category: 'weapon', ammo: 200, useSound: 'rifle' },
  { name: 'Bomb', sprite: 'bomb', category: 'weapon', ammo: 1, useSound: 'bomb' },
  { name: 'Lock Borders', sprite: 'lock_borders', category: 'weapon', ammo: 1 },  // Sound handled via loop
  { name: 'Shotgun', sprite: 'shotgun', category: 'weapon', ammo: 20, useSound: 'shotgun' },
  // Time-based weapons (use duration)
  { name: 'Uzi', sprite: 'uzi', category: 'weapon', duration: 700, useSound: 'uzi', loopSound: true }, // 10s
  { name: 'Turbo', sprite: 'turbo', category: 'weapon', duration: 700, useSound: 'slow' },   // 10s
  { name: 'Slow', sprite: 'slow', category: 'weapon', duration: 700, useSound: 'turbo' },     // 10s
];

// Item constants
export const ITEM_COLLISION_RADIUS = 15;   // Pickup radius in pixels
export const MAX_ITEMS_ON_FIELD = 6;       // Maximum spawned items at once
export const ITEM_SPAWN_MARGIN = 80;       // Min distance from players when spawning
