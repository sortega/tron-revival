// Game types - clean interface between lobby and game

import type { SlotIndex, GameMode } from './lobby';

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
}

// === Tron Game Types ===

export interface TrailSegment {
  x: number;  // Screen pixel
  y: number;  // Screen pixel
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

export type RoundPhase = 'countdown' | 'playing' | 'round_end' | 'waiting_ready';

// Full round state (broadcast by host)
export interface TronRoundState {
  phase: RoundPhase;
  players: TronPlayerState[];
  countdown: number;           // Seconds remaining in countdown
  roundWinner: SlotIndex | 'draw' | null;
  portals: TeleportPortal[];   // Active teleport portals
  items: GameItem[];           // Spawned items in world
}

// Match state (scores, ready status)
export interface TronMatchState {
  scores: Partial<Record<SlotIndex, number>>;  // slotIndex -> score (only active slots)
  currentRound: number;
  currentLevelIndex: number;  // Index into LEVELS array
  playersReady: SlotIndex[];  // Slots that pressed action
  gameMode: GameMode;
}

// Full game state for network broadcast
export interface TronGameStateData {
  round: TronRoundState;
  match: TronMatchState;
  // Trail data sent separately for efficiency - only new segments
  newTrailSegments: { slotIndex: SlotIndex; segments: TrailSegment[] }[];
}

// Input includes action key for ready signal
export interface TronInput {
  left: boolean;
  right: boolean;
  action: boolean;  // Ready signal / special action
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
export const PORTAL_RADIUS = 12;  // Collision radius (inner part of 40x40 sprite)
export const PORTAL_OUTER_RADIUS = 18;  // Where player appears after teleport
export const PORTAL_FRAME_COUNT = 30;  // Animation frames (portal_01 to portal_30)

// === Level Types ===

export interface LevelDefinition {
  id: string;
  name: string;
  imagePath: string | null;  // null for blank level
}

// Level image filenames (relative to /assets/levels/)
// The full path is constructed at runtime using import.meta.env.BASE_URL
export const LEVEL_DEFINITIONS: { id: string; name: string; imageFile: string | null }[] = [
  { id: 'blank', name: 'Blank', imageFile: null },
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
  imagePath: def.imageFile ? `${import.meta.env.BASE_URL}assets/levels/${def.imageFile}` : null,
}));

// === Item Types ===

// Item category determines activation behavior
export type ItemCategory = 'automatic' | 'weapon';

// Item definition (static configuration)
export interface ItemDefinition {
  name: string;
  sprite: string;         // Sprite name (also serves as unique identifier)
  category: ItemCategory;
  duration?: number;      // Frames at 70fps (automatic items + time-based weapons)
  ammo?: number;          // Shot count (shot-based weapons only)
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
  { name: 'Crossing', sprite: 'crossing', category: 'automatic', duration: 2100 },        // 30s
  { name: 'Shield', sprite: 'shield', category: 'automatic', duration: 2100 },            // 30s
  { name: 'Eraser', sprite: 'eraser', category: 'automatic', duration: 0 },               // Instant
  { name: 'Swap', sprite: 'random_item', category: 'automatic', duration: 0 },            // Instant
  { name: 'Bodyguard', sprite: 'bodyguard_item', category: 'automatic', duration: 0 },    // Instant
  { name: 'Reverse', sprite: 'reverse', category: 'automatic', duration: 700 },           // 10s
  { name: 'Slow', sprite: 'automatic_slow', category: 'automatic', duration: 1400 },      // 20s
  { name: 'Turbo', sprite: 'automatic_turbo', category: 'automatic', duration: 1400 },    // 20s
];

// Weapon items (square) - manual activation with action button
export const WEAPON_ITEMS: ItemDefinition[] = [
  // Shot-based weapons (use ammo)
  { name: 'Glock', sprite: 'glock', category: 'weapon', ammo: 20 },
  { name: 'Rifle', sprite: 'rifle', category: 'weapon', ammo: 200 },
  { name: 'Bomb', sprite: 'bomb', category: 'weapon', ammo: 1 },
  { name: 'Lock Borders', sprite: 'lock_borders', category: 'weapon', ammo: 1 },
  { name: 'Shotgun', sprite: 'shotgun', category: 'weapon', ammo: 20 },
  // Time-based weapons (use duration)
  { name: 'Uzi', sprite: 'uzi', category: 'weapon', duration: 700 },          // 10s
  { name: 'Turbo', sprite: 'turbo', category: 'weapon', duration: 700 },      // 10s
  { name: 'Slow', sprite: 'slow', category: 'weapon', duration: 700 },        // 10s
];

// Item constants
export const ITEM_COLLISION_RADIUS = 15;   // Pickup radius in pixels
export const MAX_ITEMS_ON_FIELD = 6;       // Maximum spawned items at once
export const ITEM_SPAWN_MARGIN = 80;       // Min distance from players when spawning
