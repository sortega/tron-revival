// Shared simulation constants (no DOM / browser dependencies)

export const PLAY_WIDTH = 750;
export const PLAY_HEIGHT = 600;

/** Simulation ticks per second (the original game ran at 70 FPS). */
export const TICK_RATE = 70;
export const TICK_MS = 1000 / TICK_RATE;

/** Positions are stored as integers ×1000 for sub-pixel precision. */
export const FIXED_POINT_SCALE = 1000;

/** Ticks after a round ends during which action presses are not taken as "ready" (100 ms). */
export const READY_LOCK_TICKS = Math.round(0.1 * TICK_RATE);
