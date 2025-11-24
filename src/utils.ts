/**
 * Utility Functions
 */

import { ANGLE_UNITS, GAME_WIDTH, GAME_HEIGHT } from './constants';

/**
 * Normalize angle to 0-360000 range
 */
export function normalizeAngle(angle: number): number {
  angle = angle % ANGLE_UNITS;
  if (angle < 0) angle += ANGLE_UNITS;
  return angle;
}

/**
 * Convert internal coordinate (x1000) to pixel
 */
export function toPixel(coord: number): number {
  let res = Math.floor(coord / 1000);
  const remainder = coord % 1000;

  if (remainder > 500) res++;
  if (remainder < -500) res--;

  return res;
}

/**
 * Convert pixel to internal coordinate (x1000)
 */
export function fromPixel(pixel: number): number {
  return pixel * 1000;
}

/**
 * Wrap X coordinate (toroidal topology)
 */
export function wrapX(x: number): number {
  if (x >= GAME_WIDTH) return x - GAME_WIDTH;
  if (x < 0) return x + GAME_WIDTH;
  return x;
}

/**
 * Wrap Y coordinate (toroidal topology)
 */
export function wrapY(y: number): number {
  if (y >= GAME_HEIGHT) return y - GAME_HEIGHT;
  if (y < 0) return y + GAME_HEIGHT;
  return y;
}

/**
 * Get cosine in angle units (0-360000)
 */
export function cos(angle: number): number {
  return Math.cos((angle * Math.PI) / 180000);
}

/**
 * Get sine in angle units (0-360000)
 */
export function sin(angle: number): number {
  return Math.sin((angle * Math.PI) / 180000);
}
