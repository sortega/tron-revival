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

// Player colors (from original game)
export const PLAYER_COLORS = {
  RED: 52,
  GREEN: 114,
  BLUE: 32,
  YELLOW: 60,
  // Team mode colors
  PURPLE: 80,
  BROWN: 215,
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
