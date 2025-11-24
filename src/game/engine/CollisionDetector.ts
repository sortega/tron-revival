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
   * Returns { collision: boolean, ownColor: boolean }
   */
  checkPlayerCollision(player: Player): { collision: boolean; ownColor: boolean } {
    if (!player.alive) return { collision: false, ownColor: false };

    // Shield protects from all collisions
    if (player.shield > 0) return { collision: false, ownColor: false };

    const { x, y } = player;

    // Check the pixel at player position
    const pixelColor = this.renderer.getPixelColor(x, y);

    // Empty pixel = no collision
    if (!pixelColor) return { collision: false, ownColor: false };

    // Check if it's the player's own color
    const isOwnColor = this.renderer.isColorMatch(pixelColor, player.color);

    // If player has crossing ability, can cross trails
    if (player.crossing > 0) {
      return { collision: false, ownColor: false };
    }

    // Collision detected!
    return { collision: true, ownColor: isOwnColor };
  }

  /**
   * Check diagonal movement collision (prevents threading through corners)
   */
  checkDiagonalCollision(player: Player, oldX: number, oldY: number): boolean {
    if (!player.alive) return false;
    if (player.shield > 0) return false;

    const { x: newX, y: newY } = player;

    // No diagonal movement, no special check needed
    if (oldX === newX || oldY === newY) return false;

    // Check the 4 corner pixels of the diagonal movement
    // This works correctly even with wraparound
    const pixelsToCheck = [
      { x: oldX, y: oldY },
      { x: oldX, y: newY },
      { x: newX, y: oldY },
      { x: newX, y: newY },
    ];

    let collisionCount = 0;

    for (const pixel of pixelsToCheck) {
      const pixelColor = this.renderer.getPixelColor(pixel.x, pixel.y);
      if (pixelColor !== null) {
        collisionCount++;
      }
    }

    // If 2 or more pixels are occupied, it's a collision
    // (prevents threading through corners)
    return collisionCount >= 2;
  }
}
