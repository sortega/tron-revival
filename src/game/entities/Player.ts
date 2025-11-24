/**
 * Player Entity
 * Represents a player vehicle in the game
 */

import type { PlayerId, PlayerState } from '../../types';
import { PLAYER_TURN_SPEED, PLAYER_MOVE_SPEED, GAME_WIDTH, GAME_HEIGHT, type RGB } from '../../constants';
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
  vivo = true; // Alive
  vel = 100; // Velocity (100 = normal, lower = faster, higher = slower)
  ctrl = 1; // Control multiplier (1 = normal, -1 = reversed)

  // Power-ups
  escudo = 0; // Shield frames remaining
  cruces = 0; // Crossing frames remaining

  // Weapon
  fase = -1; // Weapon fire phase
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
    if (!this.vivo) return;

    // Update power-ups
    if (this.escudo > 0) this.escudo--;
    if (this.cruces > 0) this.cruces--;

    // Handle turning
    if (this.turningLeft) {
      this.dir += PLAYER_TURN_SPEED * this.ctrl;
    }
    if (this.turningRight) {
      this.dir -= PLAYER_TURN_SPEED * this.ctrl;
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
      vivo: this.vivo,
      vel: this.vel,
      ctrl: this.ctrl,
      escudo: this.escudo,
      cruces: this.cruces,
      fase: this.fase,
      ammo: this.ammo,
      target: this.target,
    };
  }
}
