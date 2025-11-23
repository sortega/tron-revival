/**
 * Canvas Renderer
 * Handles all rendering including trails, players, and UI
 */

import { GAME_WIDTH, GAME_HEIGHT, PANEL_WIDTH, TOTAL_WIDTH } from '../constants';
import type { Player } from '../game/entities/Player';

export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private trailCanvas: HTMLCanvasElement;
  private trailCtx: CanvasRenderingContext2D;
  private trailImageData: ImageData;

  constructor(container: HTMLElement) {
    // Create main canvas
    this.canvas = document.createElement('canvas');
    this.canvas.width = TOTAL_WIDTH;
    this.canvas.height = GAME_HEIGHT;
    this.canvas.style.border = '2px solid #0f0';
    this.canvas.style.imageRendering = 'pixelated';
    container.appendChild(this.canvas);

    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Could not get 2D context');
    this.ctx = ctx;

    // Create offscreen canvas for trails (pixel data)
    this.trailCanvas = document.createElement('canvas');
    this.trailCanvas.width = GAME_WIDTH;
    this.trailCanvas.height = GAME_HEIGHT;

    const trailCtx = this.trailCanvas.getContext('2d', { willReadFrequently: true });
    if (!trailCtx) throw new Error('Could not get trail context');
    this.trailCtx = trailCtx;

    // Initialize trail image data
    this.trailImageData = this.trailCtx.createImageData(GAME_WIDTH, GAME_HEIGHT);

    // Fill with black (transparent trails)
    for (let i = 0; i < this.trailImageData.data.length; i += 4) {
      this.trailImageData.data[i] = 0; // R
      this.trailImageData.data[i + 1] = 0; // G
      this.trailImageData.data[i + 2] = 0; // B
      this.trailImageData.data[i + 3] = 255; // A
    }
  }

  /**
   * Clear the entire canvas
   */
  clear(): void {
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, TOTAL_WIDTH, GAME_HEIGHT);
  }

  /**
   * Draw a pixel in the trail
   */
  drawTrailPixel(x: number, y: number, colorIndex: number): void {
    if (x < 0 || x >= GAME_WIDTH || y < 0 || y >= GAME_HEIGHT) return;

    const index = (y * GAME_WIDTH + x) * 4;
    const rgb = this.colorIndexToRGB(colorIndex);

    this.trailImageData.data[index] = rgb.r;
    this.trailImageData.data[index + 1] = rgb.g;
    this.trailImageData.data[index + 2] = rgb.b;
    this.trailImageData.data[index + 3] = 255;
  }

  /**
   * Get pixel color index at position
   */
  getPixelColor(x: number, y: number): number {
    if (x < 0 || x >= GAME_WIDTH || y < 0 || y >= GAME_HEIGHT) return 0;

    const index = (y * GAME_WIDTH + x) * 4;
    const r = this.trailImageData.data[index];
    const g = this.trailImageData.data[index + 1];
    const b = this.trailImageData.data[index + 2];

    // If pixel is black, return 0 (empty)
    if (r === 0 && g === 0 && b === 0) return 0;

    // Return color index (simplified - in real game would map RGB back to index)
    return (r ?? 0) + (g ?? 0) + (b ?? 0); // Simple approximation
  }

  /**
   * Render a frame
   */
  render(players: Player[]): void {
    // Clear main canvas
    this.clear();

    // Update trail canvas with image data
    this.trailCtx.putImageData(this.trailImageData, 0, 0);

    // Draw trails to main canvas
    this.ctx.drawImage(this.trailCanvas, 0, 0);

    // Draw players
    for (const player of players) {
      if (player.vivo) {
        this.drawPlayer(player);
      }
    }

    // Draw panel
    this.drawPanel(players);
  }

  /**
   * Draw a player
   */
  private drawPlayer(player: Player): void {
    const rgb = this.colorIndexToRGB(player.color);
    this.ctx.fillStyle = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;

    // Draw player as a small square
    this.ctx.fillRect(player.x - 1, player.y - 1, 3, 3);

    // Draw shield indicator
    if (player.escudo > 0) {
      this.ctx.strokeStyle = '#0ff';
      this.ctx.lineWidth = 2;
      this.ctx.beginPath();
      this.ctx.arc(player.x, player.y, 8, 0, Math.PI * 2);
      this.ctx.stroke();
    }
  }

  /**
   * Draw side panel
   */
  private drawPanel(players: Player[]): void {
    this.ctx.fillStyle = '#111';
    this.ctx.fillRect(GAME_WIDTH, 0, PANEL_WIDTH, GAME_HEIGHT);

    // Draw player indicators
    players.forEach((player, i) => {
      const y = i * 150 + 75;
      const rgb = this.colorIndexToRGB(player.color);

      this.ctx.fillStyle = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
      this.ctx.fillRect(GAME_WIDTH + 10, y, 30, 30);

      // Draw status
      this.ctx.fillStyle = player.vivo ? '#0f0' : '#f00';
      this.ctx.font = '12px monospace';
      this.ctx.fillText(player.vivo ? 'ALIVE' : 'DEAD', GAME_WIDTH + 5, y + 50);
    });
  }

  /**
   * Convert color index to RGB (simplified color palette)
   */
  private colorIndexToRGB(colorIndex: number): { r: number; g: number; b: number } {
    // Simplified color mapping (would use actual palette in full implementation)
    switch (colorIndex) {
      case 52: // Red
        return { r: 255, g: 0, b: 0 };
      case 114: // Green
        return { r: 0, g: 255, b: 0 };
      case 32: // Blue
        return { r: 0, g: 0, b: 255 };
      case 60: // Yellow
        return { r: 255, g: 255, b: 0 };
      case 80: // Purple
        return { r: 128, g: 0, b: 128 };
      case 215: // Brown
        return { r: 165, g: 42, b: 42 };
      default:
        return { r: 255, g: 255, b: 255 };
    }
  }
}
