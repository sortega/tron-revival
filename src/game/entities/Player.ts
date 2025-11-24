/**
 * Player Entity
 * Represents a player vehicle in the game
 */

import type { PlayerId, PlayerState } from '../../types';
import { PLAYER_TURN_SPEED, PLAYER_MOVE_SPEED, GAME_WIDTH, GAME_HEIGHT, type RGB, type SpawnPosition } from '../../constants';
import { normalizeAngle, toPixel, cos, sin, fromPixel } from '../../utils';

export class Player {
  // Position (internal coordinates x1000 for sub-pixel precision)
  rx: number;
  ry: number;
  dir: number; // Direction in angle units

  // Display position (pixels)
  x: number;
  y: number;

  // State
  alive = true;
  velocity = 100; // 100 = normal, lower = faster, higher = slower
  controlMultiplier = 1; // 1 = normal, -1 = reversed

  // Power-ups
  shield = 0; // Shield frames remaining
  crossing = 0; // Crossing frames remaining

  // Weapon
  firePhase = -1; // Weapon fire phase
  ammo = 0;
  target = 0; // Has weapon equipped

  // Input state
  turningLeft = false;
  turningRight = false;
  firing = false;

  constructor(
    public id: PlayerId,
    public name: string,
    public num: number,
    public color: RGB,
    startX: number,
    startY: number,
    startDir: number
  ) {
    this.rx = fromPixel(startX);
    this.ry = fromPixel(startY);
    this.dir = normalizeAngle(startDir);
    this.x = startX;
    this.y = startY;
  }

  /**
   * Update player state
   */
  update(): void {
    if (!this.alive) return;

    // Update power-ups
    if (this.shield > 0) this.shield--;
    if (this.crossing > 0) this.crossing--;

    // Handle turning
    if (this.turningLeft) {
      this.dir += PLAYER_TURN_SPEED * this.controlMultiplier;
    }
    if (this.turningRight) {
      this.dir -= PLAYER_TURN_SPEED * this.controlMultiplier;
    }
    this.dir = normalizeAngle(this.dir);

    // Move forward
    this.rx += cos(this.dir) * PLAYER_MOVE_SPEED;
    this.ry -= sin(this.dir) * PLAYER_MOVE_SPEED;

    // Convert to pixels
    const newX = toPixel(this.rx);
    const newY = toPixel(this.ry);

    // Handle wrapping
    if (newX >= GAME_WIDTH) this.rx -= fromPixel(GAME_WIDTH);
    if (newX < 0) this.rx += fromPixel(GAME_WIDTH);
    if (newY >= GAME_HEIGHT) this.ry -= fromPixel(GAME_HEIGHT);
    if (newY < 0) this.ry += fromPixel(GAME_HEIGHT);

    // Update display position
    this.x = toPixel(this.rx);
    this.y = toPixel(this.ry);
  }

  /**
   * Reset player to spawn position
   */
  reset(spawn: SpawnPosition): void {
    this.rx = fromPixel(spawn.x);
    this.ry = fromPixel(spawn.y);
    this.dir = normalizeAngle(spawn.dir);
    this.x = spawn.x;
    this.y = spawn.y;
    this.alive = true;

    // Reset power-ups
    this.shield = 0;
    this.crossing = 0;

    // Reset weapon
    this.firePhase = -1;
    this.ammo = 0;
    this.target = 0;

    // Reset state
    this.velocity = 100;
    this.controlMultiplier = 1;

    // Reset input
    this.turningLeft = false;
    this.turningRight = false;
    this.firing = false;
  }

  /**
   * Convert to PlayerState for serialization
   */
  toState(): PlayerState {
    return {
      id: this.id,
      name: this.name,
      num: this.num,
      color: this.color,
      rx: this.rx,
      ry: this.ry,
      dir: this.dir,
      x: this.x,
      y: this.y,
      alive: this.alive,
      velocity: this.velocity,
      controlMultiplier: this.controlMultiplier,
      shield: this.shield,
      crossing: this.crossing,
      firePhase: this.firePhase,
      ammo: this.ammo,
      target: this.target,
    };
  }
}
