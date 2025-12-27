// TronPlayer - Player entity with movement and trail

import type { SlotIndex } from '../types/lobby';
import type { TronPlayerState, TrailSegment, TronInput } from '../types/game';

// Game constants
export const PLAY_WIDTH = 750;
export const PLAY_HEIGHT = 600;
const FIXED_POINT_SCALE = 1000;
const TURN_SPEED = 4;        // Degrees per frame
const MOVE_SPEED = 1000;     // 1 pixel per frame (in fixed-point)

// Starting positions based on player count and index
// In canvas coordinates: 0°=right, 90°=down, 180°=left, 270°=up
// Positions are assigned by player index (order in array), not by slot
const STARTING_POSITIONS: Record<number, { x: number; y: number; direction: number }[]> = {
  2: [
    { x: 50, y: 50, direction: 45 },       // upper-left, facing southeast
    { x: 700, y: 550, direction: 225 },    // lower-right, facing northwest
  ],
  3: [
    { x: 50, y: 50, direction: 45 },       // upper-left, facing southeast
    { x: 700, y: 50, direction: 135 },     // upper-right, facing southwest
    { x: 50, y: 550, direction: 315 },     // lower-left, facing northeast
  ],
  4: [
    { x: 50, y: 50, direction: 45 },       // upper-left, facing southeast
    { x: 700, y: 50, direction: 135 },     // upper-right, facing southwest
    { x: 50, y: 550, direction: 315 },     // lower-left, facing northeast
    { x: 700, y: 550, direction: 225 },    // lower-right, facing northwest
  ],
};

// Default fallback position (center, facing right)
const DEFAULT_POSITION = { x: 375, y: 300, direction: 0 };

export function getStartingPosition(playerIndex: number, playerCount: number): { x: number; y: number; direction: number } {
  const positions = STARTING_POSITIONS[playerCount];
  const position = positions?.[playerIndex];
  return position ?? DEFAULT_POSITION;
}

export class TronPlayer {
  slotIndex: SlotIndex;
  x: number;           // Fixed-point (×1000)
  y: number;           // Fixed-point (×1000)
  direction: number;   // 0-360 degrees
  alive: boolean;
  color: string;
  nickname: string;

  // Trail segments (screen pixels) - positions the player has LEFT, not the head
  trail: TrailSegment[] = [];

  // Track previous screen position for diagonal collision detection
  prevScreenX: number = -1;
  prevScreenY: number = -1;

  constructor(
    slotIndex: SlotIndex,
    x: number,
    y: number,
    direction: number,
    color: string,
    nickname: string
  ) {
    this.slotIndex = slotIndex;
    this.x = x * FIXED_POINT_SCALE;
    this.y = y * FIXED_POINT_SCALE;
    this.direction = direction;
    this.alive = true;
    this.color = color;
    this.nickname = nickname;
  }

  // Get screen coordinates
  getScreenX(): number {
    return Math.floor(this.x / FIXED_POINT_SCALE);
  }

  getScreenY(): number {
    return Math.floor(this.y / FIXED_POINT_SCALE);
  }

  // Update player position based on input
  // Returns new trail segments added this frame (the position we just LEFT, not the head)
  update(input: TronInput): TrailSegment[] {
    if (!this.alive) return [];

    // Store previous screen position for diagonal collision detection
    this.prevScreenX = this.getScreenX();
    this.prevScreenY = this.getScreenY();

    // Turn
    if (input.left) {
      this.direction = (this.direction - TURN_SPEED + 360) % 360;
    }
    if (input.right) {
      this.direction = (this.direction + TURN_SPEED) % 360;
    }

    // Move forward
    const rad = (this.direction * Math.PI) / 180;
    this.x += Math.cos(rad) * MOVE_SPEED;
    this.y += Math.sin(rad) * MOVE_SPEED;

    // Wrap around edges
    const maxX = PLAY_WIDTH * FIXED_POINT_SCALE;
    const maxY = PLAY_HEIGHT * FIXED_POINT_SCALE;

    if (this.x >= maxX) this.x -= maxX;
    if (this.x < 0) this.x += maxX;
    if (this.y >= maxY) this.y -= maxY;
    if (this.y < 0) this.y += maxY;

    // Check if we moved to a new pixel
    const newScreenX = this.getScreenX();
    const newScreenY = this.getScreenY();
    const newSegments: TrailSegment[] = [];

    // If we moved to a new pixel, the OLD position becomes part of the trail
    if (newScreenX !== this.prevScreenX || newScreenY !== this.prevScreenY) {
      // Add the position we just LEFT to the trail (not the head)
      const segment = { x: this.prevScreenX, y: this.prevScreenY };
      this.trail.push(segment);
      newSegments.push(segment);
    }

    return newSegments;
  }

  // Check collision against a set of occupied pixels
  // Returns true if collision detected
  // For diagonal movement, also checks intermediate pixels to prevent "slipping through"
  checkCollision(occupiedPixels: Set<string>): boolean {
    if (!this.alive) return false;

    const currX = this.getScreenX();
    const currY = this.getScreenY();

    // Check current position
    if (occupiedPixels.has(`${currX},${currY}`)) {
      return true;
    }

    // If we haven't moved yet (prevScreenX < 0), only check current position
    if (this.prevScreenX < 0) return false;

    const dx = currX - this.prevScreenX;
    const dy = currY - this.prevScreenY;

    // For diagonal movement, check the intermediate pixels that we "pass through"
    // When moving from (x,y) to (x+1,y+1), we pass through (x+1,y) and (x,y+1)
    if (dx !== 0 && dy !== 0) {
      // Diagonal move - check both intermediate pixels
      const interX = `${this.prevScreenX + dx},${this.prevScreenY}`;
      const interY = `${this.prevScreenX},${this.prevScreenY + dy}`;

      if (occupiedPixels.has(interX) || occupiedPixels.has(interY)) {
        return true;
      }
    }

    return false;
  }

  // Kill the player
  kill(): void {
    this.alive = false;
  }

  // Reset for new round
  reset(x: number, y: number, direction: number): void {
    this.x = x * FIXED_POINT_SCALE;
    this.y = y * FIXED_POINT_SCALE;
    this.direction = direction;
    this.alive = true;
    this.trail = [];
  }

  // Serialize for network transmission
  serialize(): TronPlayerState {
    return {
      slotIndex: this.slotIndex,
      x: this.x,
      y: this.y,
      direction: this.direction,
      alive: this.alive,
      color: this.color,
      nickname: this.nickname,
    };
  }

  // Update from network state (for guests)
  updateFromState(state: TronPlayerState): void {
    this.x = state.x;
    this.y = state.y;
    this.direction = state.direction;
    this.alive = state.alive;
  }
}
