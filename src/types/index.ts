/**
 * Core Type Definitions
 */

// Player ID type
export type PlayerId = string;

// Game phases
export type GamePhase = 'waiting' | 'countdown' | 'playing' | 'results';

// Game modes
export type GameMode = 'ffa' | 'team'; // Free-for-all or team

// Input actions
export type InputAction = 'left' | 'right' | 'fire';

// Player state
export interface PlayerState {
  id: PlayerId;
  name: string;
  num: number; // Player number (0-3)
  color: number; // Color index for trail

  // Position (stored as integers * 1000 for sub-pixel precision)
  rx: number;
  ry: number;
  dir: number; // Direction in angle units (0-360000)

  // Rendering position (rounded pixels)
  x: number;
  y: number;

  // State
  vivo: boolean; // Alive/dead
  vel: number; // Velocity (100 = normal, lower = faster)
  ctrl: number; // Control direction (1 = normal, -1 = reversed)

  // Power-ups
  escudo: number; // Shield remaining frames
  cruces: number; // Crossing remaining frames

  // Weapon
  fase: number; // Weapon fire phase (-1 = not firing)
  ammo: number; // Ammunition remaining
  target: number; // Has weapon equipped
}

// Input
export interface Input {
  frame: number;
  playerId: PlayerId;
  action: InputAction;
  pressed: boolean;
  timestamp: number;
}

// Item types
export interface ItemState {
  id: string;
  x: number;
  y: number;
  clase: number; // 0 = automatic, 1 = weapon
  tipo: number; // Item type within class
  vivo: number; // Lifetime remaining
}

// Game state
export interface GameState {
  // Match info
  matchId: string;
  mapId: number;
  mode: GameMode;
  phase: GamePhase;

  // Players
  players: Map<PlayerId, PlayerState>;

  // Entities
  items: Map<string, ItemState>;
  // projectiles, portals, hazards will be added later

  // Field state (pixel data for trails)
  // Will be implemented with ImageData

  // Scores
  scores: Map<PlayerId, number>;

  // Timing
  frameNumber: number;
  timestamp: number;
}

// Network messages
export type GuestToHostMessage =
  | { type: 'input'; input: Input }
  | { type: 'ready' };

export type HostToGuestMessage =
  | { type: 'state'; state: Partial<GameState>; frame: number }
  | { type: 'start_game'; countdown: number }
  | { type: 'end_game'; winner: PlayerId | null };
