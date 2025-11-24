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

    // Check the intermediate pixels on the path
    // For diagonal movement, we need to check both adjacent pixels
    const pixelsToCheck = [
      { x: oldX, y: newY }, // One corner
      { x: newX, y: oldY }, // Other corner
    ];

    for (const pixel of pixelsToCheck) {
      const pixelColor = this.renderer.getPixelColor(pixel.x, pixel.y);
      // If either of the corners is occupied, it's a collision
      if (pixelColor !== null) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if two players crossed paths this frame
   */
  checkPlayersCrossing(
    player1: Player,
    old1X: number,
    old1Y: number,
    player2: Player,
    old2X: number,
    old2Y: number
  ): boolean {
    if (!player1.alive || !player2.alive) return false;
    if (player1.shield > 0 || player2.shield > 0) return false;
    if (player1.crossing > 0 || player2.crossing > 0) return false;

    const new1X = player1.x;
    const new1Y = player1.y;
    const new2X = player2.x;
    const new2Y = player2.y;

    // Check if players swapped positions (moved through each other)
    if (old1X === new2X && old1Y === new2Y && old2X === new1X && old2Y === new1Y) {
      return true;
    }

    // Check if diagonal paths crossed
    // Player 1: (old1X, old1Y) → (new1X, new1Y)
    // Player 2: (old2X, old2Y) → (new2X, new2Y)

    // Both moved diagonally
    const p1Diagonal = old1X !== new1X && old1Y !== new1Y;
    const p2Diagonal = old2X !== new2X && old2Y !== new2Y;

    if (p1Diagonal && p2Diagonal) {
      // Check if they crossed through each other's corners
      // Player 1 crosses through player 2's path if player 1's corners touch player 2's line
      const p1Corner1 = { x: old1X, y: new1Y };
      const p1Corner2 = { x: new1X, y: old1Y };
      const p2Corner1 = { x: old2X, y: new2Y };
      const p2Corner2 = { x: new2X, y: old2Y };

      // Check if corners intersect
      if ((p1Corner1.x === p2Corner2.x && p1Corner1.y === p2Corner2.y) ||
          (p1Corner2.x === p2Corner1.x && p1Corner2.y === p2Corner1.y)) {
        return true;
      }
    }

    return false;
  }
}
