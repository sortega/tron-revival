/**
 * Game Constants
 * Based on original Teratron design
 */

// Screen dimensions
export const GAME_WIDTH = 750;
export const GAME_HEIGHT = 600;
export const PANEL_WIDTH = 50;
export const TOTAL_WIDTH = GAME_WIDTH + PANEL_WIDTH;

// Game timing
export const TARGET_FPS = 70; // Original game ran at 70 FPS
export const TICK_RATE = 60; // Server/host tick rate
export const TICK_INTERVAL = 1000 / TICK_RATE;

// Player constants
export const PLAYER_TURN_SPEED = 4000; // Units per frame (360000 = full circle)
export const PLAYER_MOVE_SPEED = 1000; // Internal units per frame (1000 = 1 pixel)
export const ANGLE_UNITS = 360000; // Full circle in units

// RGB color type
export interface RGB {
  r: number;
  g: number;
  b: number;
}

// Player colors (from original game)
export const PLAYER_COLORS = {
  RED: { r: 255, g: 0, b: 0 },
  GREEN: { r: 0, g: 255, b: 0 },
  BLUE: { r: 0, g: 0, b: 255 },
  YELLOW: { r: 255, g: 255, b: 0 },
  // Team mode colors
  PURPLE: { r: 128, g: 0, b: 128 },
  BROWN: { r: 165, g: 42, b: 42 },
} as const;

// Maps
export const MIN_MAP = 200;
export const MAX_MAP = 207;
export const TOTAL_MAPS = MAX_MAP - MIN_MAP + 1;

// Item spawn rates (original probabilities)
export const ITEM_SPAWN_PROBABILITY = {
  AUTOMATIC: 0.4, // 40% chance for automatic items
  WEAPON: 0.5, // 50% chance for weapons
  NONE: 0.1, // 10% chance for nothing
} as const;

// Power-up durations (in frames at 70 FPS)
export const POWERUP_DURATION = {
  SHIELD: 2100, // ~30 seconds
  CROSSING: 2100, // ~30 seconds
  SPEED_BOOST: 1400, // ~20 seconds
  SPEED_SLOW: 1400, // ~20 seconds
  CONTROL_REVERSAL: 700, // ~10 seconds
} as const;

// Player spawn configuration
export interface SpawnPosition {
  x: number;
  y: number;
  dir: number;
}

export const SPAWN_POSITIONS: Record<number, SpawnPosition[]> = {
  2: [
    { x: 50, y: 50, dir: -45000 }, // Top-left, facing SE
    { x: 700, y: 550, dir: 135000 }, // Bottom-right, facing NW
  ],
  3: [
    { x: 50, y: 50, dir: -45000 }, // Top-left
    { x: 700, y: 50, dir: 225000 }, // Top-right
    { x: 50, y: 550, dir: 45000 }, // Bottom-left
  ],
  4: [
    { x: 50, y: 50, dir: -45000 }, // Top-left
    { x: 700, y: 50, dir: 225000 }, // Top-right
    { x: 50, y: 550, dir: 45000 }, // Bottom-left
    { x: 700, y: 550, dir: 135000 }, // Bottom-right
  ],
};

// Other constants
export const TRAIL_HEAD_COLOR: RGB = { r: 255, g: 255, b: 255 };
export const WRAPAROUND_THRESHOLD = 100; // Threshold for detecting screen wraparound
