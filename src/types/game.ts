// Game types - clean interface between lobby and game

import type { SlotIndex, GameMode, LevelMode } from './lobby';

export type ControlScheme = 'solo' | 'arrows' | 'wasd' | 'ijkl' | 'numpad';
export type BotDifficulty = 'easy' | 'normal' | 'hard';

// How a player is controlled, from this machine's point of view
export type PlayerControl =
  | { type: 'local'; scheme: ControlScheme }   // human on this machine
  | { type: 'remote' }                          // input arrives over the network
  | { type: 'ai'; difficulty: BotDifficulty };  // bot run by the authoritative session

export interface GamePlayer {
  slotIndex: SlotIndex;
  nickname: string;
  color: string;
  control: PlayerControl;
  /**
   * Who plays this slot (network games: a userId, or 'ai'). When the occupant of a slot
   * changes between rounds, the slot's score starts again (design/spectators.md).
   */
  owner?: string;
}

/** A player as announced in the game stream: slot, nickname, colour, owner ('ai' = bot). */
export type RosterEntry = [slot: number, nickname: string, color: string, owner: string];

/** The one-shot events of a frame: must be applied exactly once, in tick order. */
export interface FrameEvents {
  tick?: number;
  newTrailSegments: { slotIndex: SlotIndex; segments: TrailSegment[] }[];
  borderSegments?: { color: string; segments: TrailSegment[] }[];
  soundEvents: SoundEvent[];
  eraserUsed?: boolean;
  ridiculousDeathSlots?: SlotIndex[];
  clearedAreas?: ClearedRect[];
  clearedLines?: number[];
  roundStarted?: boolean;
  deaths?: DeathEvent[];
  roster?: RosterEntry[];
}

export interface GameConfig {
  players: GamePlayer[];
  gameMode: GameMode;
  levelMode: LevelMode;
}

// === Tron Game Types ===

export interface TrailSegment {
  x: number;  // Screen pixel
  y: number;  // Screen pixel
}

// Rectangle of cleared pixels: top-left corner + size. May extend past the edges (wraps).
export interface ClearedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type DeathCause =
  | 'trail'       // Another player's trail (or a locked border)
  | 'own-trail'   // Own colour ("ridiculous death")
  | 'level'       // Level obstacle
  | 'crossing'    // Head-on / diagonal crossing with another player
  | 'bullet' | 'tracer' | 'bomb' | 'bodyguard'
  | 'door';       // Automatic door (level hazard)

export interface DeathEvent {
  slotIndex: SlotIndex;
  cause: DeathCause;
  x: number;
  y: number;
  /** Slot of the player responsible (can be the victim); NO_OWNER for the level. */
  by?: number;
}

// Projectile type: 'bullet' = Glock (explodes on impact), 'tracer' = Rifle (clears trail, has lifespan), 'bomb' = heavy missile
export type ProjectileType = 'bullet' | 'tracer' | 'bomb';

/** `Projectile.ownerSlot` of projectiles fired by the level itself. */
export const NO_OWNER = -1;

// Projectile in flight (bullets from Glock, tracers from Rifle, bombs)
export interface Projectile {
  id: number;
  x: number;           // Fixed-point ×1000
  y: number;           // Fixed-point ×1000
  direction: number;   // Angle in degrees
  ownerSlot: SlotIndex | typeof NO_OWNER;  // NO_OWNER: fired by the level
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
  // Movement details that let guests predict / extrapolate (see networking.md)
  speed: number;         // Speed factor this tick, without the player's own Turbo weapon
  moveCounter: number;   // Slow-movement frame counter
  tpCooldown: number;    // Frames until portals work again for this player
  steer: number;         // Input applied this tick
  action: boolean;
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
  doorTick: number;            // Playing ticks elapsed this round (clock of the level's doors)
  hand?: HandView;             // The dentist's hand, on its level
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
  clearedAreas?: ClearedRect[];
  // Cleared pixel lines (tracer paths), flat [x0, y0, x1, y1, ...]; coordinates may be
  // outside the play area and wrap around
  clearedLines?: number[];
  // A new round started on this tick - renderer must reset trails and level damage
  roundStarted?: boolean;
  // Players that died on this tick and why
  deaths?: DeathEvent[];
  // Color blindness effect remaining frames (for trail color cycling and sprite animation)
  colorBlindnessFrames?: number;
  // White flash effect remaining frames (bomb-on-bomb collision)
  whiteFlashFrames?: number;
  // Per-slot echo of the newest input timestamp (`TronInputMessage.t`) the host has
  // consumed, corrected for the time it waited on the host. RTT = now - pong.
  pongs?: Partial<Record<SlotIndex, number>>;
  // Host tick this frame belongs to
  tick?: number;
  // Last input sequence number consumed for each remote slot
  acks?: Partial<Record<SlotIndex, number>>;
  // Who plays, when it changed (and periodically): design/spectators.md
  roster?: RosterEntry[];
  // Reduced-rate stream: events of the ticks skipped since the previous message, oldest first
  earlier?: FrameEvents[];
}

// Input includes action key for ready signal
export interface TronInput {
  steer: number;    // Proportional steering: -1 (full left) to 1 (full right), 0 = straight
  action: boolean;  // Ready signal / special action
}

// Input as sent by a guest to the host
export interface TronInputMessage extends TronInput {
  seq: number;  // Sequence number, one per simulated guest tick
  t: number;    // Guest clock (ms) when sent; echoed back for RTT measurement
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

import type { DoorDefinition } from '../game/doors';
export type { DoorDefinition } from '../game/doors';
import { gunFromPoints } from '../game/guns';
import type { GunDefinition } from '../game/guns';
export type { GunDefinition } from '../game/guns';
import type { HandDefinition, HandView } from '../game/hand';
export type { HandDefinition, HandView } from '../game/hand';

export interface LevelDefinition {
  id: string;
  name: string;
  imagePath: string;
  /** Display-only background image; never a wall (design/display-layer.md) */
  backgroundPath?: string;
  /** The background is light: shade and markers need a dark edge to show on it */
  lightBackground?: boolean;
  /** Automatic doors (design/level-hazards.md) */
  doors?: DoorDefinition[];
  /** Guns that fire shell bursts at random (design/level-hazards.md) */
  guns?: GunDefinition[];
  /** The dentist's hand (design/level-hazards.md) */
  hand?: HandDefinition;
}

// Level image filenames (relative to /assets/levels/)
// The full path is constructed at runtime using import.meta.env.BASE_URL
export const LEVEL_DEFINITIONS: { id: string; name: string; imageFile: string; backgroundFile?: string; lightBackground?: boolean; doors?: DoorDefinition[]; guns?: GunDefinition[]; hand?: HandDefinition }[] = [
  { id: 'blank', name: 'Blank', imageFile: 'blank.png' },
  { id: 'pop-culture', name: 'Pop Culture', imageFile: 'pop-culture.png' },
  { id: 'selva', name: 'Selva', imageFile: 'selva.png' },
  { id: 'bricks', name: 'Bricks', imageFile: 'bricks.png' },
  { id: 'bus', name: 'Bus', imageFile: 'bus.png' },
  {
    id: 'dentistry', name: 'Dentistry', imageFile: 'dentistry.png',
    // Control points 1-30 of the original map 205: teeth, mostly
    hand: { targets: ([
      [59, 20], [109, 38], [181, 17], [335, 26], [478, 13], [443, 21],
      [356, 45], [628, 73], [570, 49], [98, 571], [72, 588], [177, 577],
      [239, 573], [321, 553], [368, 576], [432, 562], [485, 556], [565, 570],
      [621, 584], [615, 554], [631, 200], [615, 212], [256, 424], [262, 425],
      [18, 360], [79, 360], [57, 346], [220, 152], [229, 37], [227, 151],
    ] as const).map(([x, y]) => ({ x, y })) },
  },
  {
    id: 'warzone', name: 'Warzone', imageFile: 'warzone.png',
    // Control points 1-4 of the original map 206: muzzle and aim of the tank and the cannon
    guns: [gunFromPoints(385, 250, 413, 243), gunFromPoints(623, 264, 582, 270)],
  },
  {
    id: 'portals', name: 'Portals', imageFile: 'portals.png',
    // Control points 1-4 and 6 of the original map 207
    doors: [
      { x: 384, y: 0, vertical: false },
      { x: 749, y: 285, vertical: true },
      { x: 381, y: 599, vertical: false },
      { x: 0, y: 287, vertical: true },
      { x: 385, y: 290, vertical: true },
    ],
  },
  // Levels with a display-only background (design/display-layer.md); images generated
  // by scripts/build-research-levels.ts
  { id: 'blueprint', name: 'Blueprint', imageFile: 'blueprint.png', backgroundFile: 'blueprint-bg.png' },
];

// Level order (cycles after last level) - constructed with full paths
export const LEVELS: LevelDefinition[] = LEVEL_DEFINITIONS.map(def => ({
  id: def.id,
  name: def.name,
  imagePath: `${import.meta.env.BASE_URL}assets/levels/${def.imageFile}`,
  ...(def.backgroundFile && { backgroundPath: `${import.meta.env.BASE_URL}assets/levels/${def.backgroundFile}` }),
  ...(def.lightBackground && { lightBackground: true }),
  ...(def.doors && { doors: def.doors }),
  ...(def.guns && { guns: def.guns }),
  ...(def.hand && { hand: def.hand }),
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
  { name: 'Shield', sprite: 'shield', category: 'automatic', duration: 2100, pickupSound: 'shield' },        // 30s - through trails, scenery and doors
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
export const ITEM_SPAWN_MARGIN = 80;       // Min distance from players when spawning
