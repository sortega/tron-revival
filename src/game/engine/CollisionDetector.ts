/**
 * Collision Detection
 * Pixel-perfect collision detection for trails
 */

import type { Player } from '../entities/Player';
import type { Renderer } from '../../render/Renderer';

export class CollisionDetector {
  constructor(private renderer: Renderer) {}

  /**
   * Check if a player collides with anything at their current position
   */
  checkPlayerCollision(player: Player): boolean {
    if (!player.vivo) return false;

    // Shield protects from all collisions
    if (player.escudo > 0) return false;

    const { x, y } = player;

    // Check the pixel at player position
    const pixelColor = this.renderer.getPixelColor(x, y);

    // Empty pixel = no collision
    if (pixelColor === 0) return false;

    // If player has crossing ability, can cross own trail
    if (player.cruces > 0) {
      // Would need to check if it's the player's own color
      // For now, simplified: crossing allows passing through anything
      return false;
    }

    // Collision detected!
    return true;
  }

  /**
   * Check diagonal movement collision (prevents threading through corners)
   */
  checkDiagonalCollision(player: Player, oldX: number, oldY: number): boolean {
    if (!player.vivo) return false;
    if (player.escudo > 0) return false;

    const { x: newX, y: newY } = player;

    // No diagonal movement, no special check needed
    if (oldX === newX || oldY === newY) return false;

    // Check all pixels in the 2x2 area between old and new position
    const minX = Math.min(oldX, newX);
    const maxX = Math.max(oldX, newX);
    const minY = Math.min(oldY, newY);
    const maxY = Math.max(oldY, newY);

    let collisionCount = 0;

    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        const pixelColor = this.renderer.getPixelColor(x, y);
        if (pixelColor !== 0) {
          collisionCount++;
        }
      }
    }

    // If 2 or more pixels are occupied, it's a collision
    // (prevents threading through corners)
    return collisionCount >= 2;
  }
}
