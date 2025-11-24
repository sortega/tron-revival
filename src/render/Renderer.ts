/**
 * Canvas Renderer
 * Handles all rendering including trails, players, and UI
 */

import { GAME_WIDTH, GAME_HEIGHT, PANEL_WIDTH, TOTAL_WIDTH, type RGB } from '../constants';
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
  drawTrailPixel(x: number, y: number, color: RGB): void {
    if (x < 0 || x >= GAME_WIDTH || y < 0 || y >= GAME_HEIGHT) return;

    const index = (y * GAME_WIDTH + x) * 4;

    this.trailImageData.data[index] = color.r;
    this.trailImageData.data[index + 1] = color.g;
    this.trailImageData.data[index + 2] = color.b;
    this.trailImageData.data[index + 3] = 255;
  }

  /**
   * Get pixel color at position
   */
  getPixelColor(x: number, y: number): RGB | null {
    if (x < 0 || x >= GAME_WIDTH || y < 0 || y >= GAME_HEIGHT) return null;

    const index = (y * GAME_WIDTH + x) * 4;
    const r = this.trailImageData.data[index] ?? 0;
    const g = this.trailImageData.data[index + 1] ?? 0;
    const b = this.trailImageData.data[index + 2] ?? 0;

    // If pixel is black, return null (empty)
    if (r === 0 && g === 0 && b === 0) return null;

    return { r, g, b };
  }

  /**
   * Check if a pixel color matches an RGB color
   */
  isColorMatch(pixelColor: RGB | null, color: RGB): boolean {
    if (!pixelColor) return false;
    return pixelColor.r === color.r && pixelColor.g === color.g && pixelColor.b === color.b;
  }

  /**
   * Clear trails
   */
  clearTrails(): void {
    for (let i = 0; i < this.trailImageData.data.length; i += 4) {
      this.trailImageData.data[i] = 0;
      this.trailImageData.data[i + 1] = 0;
      this.trailImageData.data[i + 2] = 0;
      this.trailImageData.data[i + 3] = 255;
    }
  }

  /**
   * Render a frame
   */
  render(
    players: Player[],
    scores: Map<number, number>,
    muertesRidiculas: Map<number, number>,
    roundState: 'playing' | 'waiting_for_ready',
    playersReady: Set<number>,
    lastWinner: Player | null
  ): void {
    // Clear main canvas
    this.clear();

    // Update trail canvas with image data
    this.trailCtx.putImageData(this.trailImageData, 0, 0);

    // Draw trails to main canvas
    this.ctx.drawImage(this.trailCanvas, 0, 0);

    // Draw players
    for (const player of players) {
      if (player.alive) {
        this.drawPlayer(player);
      }
    }

    // Draw panel
    this.drawPanel(players, roundState, playersReady);

    // Draw round end overlay
    if (roundState === 'waiting_for_ready') {
      this.drawRoundEndOverlay(players, scores, muertesRidiculas, lastWinner);
    }
  }

  /**
   * Draw a player
   */
  private drawPlayer(player: Player): void {
    this.ctx.fillStyle = `rgb(${player.color.r}, ${player.color.g}, ${player.color.b})`;

    // Draw player as a small square
    this.ctx.fillRect(player.x - 1, player.y - 1, 3, 3);

    // Draw shield indicator
    if (player.shield > 0) {
      this.ctx.strokeStyle = '#0ff';
      this.ctx.lineWidth = 2;
      this.ctx.beginPath();
      this.ctx.arc(player.x, player.y, 8, 0, Math.PI * 2);
      this.ctx.stroke();
    }
  }

  /**
   * Draw round end overlay
   */
  private drawRoundEndOverlay(
    players: Player[],
    scores: Map<number, number>,
    muertesRidiculas: Map<number, number>,
    lastWinner: Player | null
  ): void {
    const centerX = GAME_WIDTH / 2;
    const centerY = GAME_HEIGHT / 2;
    const boxWidth = 400;
    const boxHeight = 250;

    // Draw semi-transparent background
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    this.ctx.fillRect(
      centerX - boxWidth / 2,
      centerY - boxHeight / 2,
      boxWidth,
      boxHeight
    );

    // Draw border
    this.ctx.strokeStyle = '#0f0';
    this.ctx.lineWidth = 2;
    this.ctx.strokeRect(
      centerX - boxWidth / 2,
      centerY - boxHeight / 2,
      boxWidth,
      boxHeight
    );

    // Draw winner announcement
    this.ctx.textAlign = 'center';
    this.ctx.font = 'bold 24px monospace';

    if (lastWinner) {
      this.ctx.fillStyle = `rgb(${lastWinner.color.r}, ${lastWinner.color.g}, ${lastWinner.color.b})`;
      this.ctx.fillText(
        `${lastWinner.name} WINS!`,
        centerX,
        centerY - 80
      );
    } else {
      this.ctx.fillStyle = '#888';
      this.ctx.fillText('DRAW!', centerX, centerY - 80);
    }

    // Draw scores
    this.ctx.font = '16px monospace';
    this.ctx.fillStyle = '#fff';

    let yOffset = centerY - 30;
    for (const player of players) {
      const playerScore = scores.get(player.num) ?? 0;
      const playerMR = muertesRidiculas.get(player.num) ?? 0;
      this.ctx.fillStyle = `rgb(${player.color.r}, ${player.color.g}, ${player.color.b})`;
      this.ctx.fillText(
        `${player.name}: ${playerScore} wins, ${playerMR} muertes ridículas`,
        centerX,
        yOffset
      );
      yOffset += 25;
    }

    // Draw "Fire to continue / ESC to exit"
    this.ctx.fillStyle = '#0f0';
    this.ctx.font = 'bold 18px monospace';
    this.ctx.fillText(
      'FIRE TO CONTINUE',
      centerX,
      centerY + 75
    );

    this.ctx.fillStyle = '#888';
    this.ctx.font = '14px monospace';
    this.ctx.fillText(
      'ESC TO EXIT',
      centerX,
      centerY + 100
    );

    // Reset text alignment
    this.ctx.textAlign = 'left';
  }

  /**
   * Draw side panel
   */
  private drawPanel(
    players: Player[],
    roundState: 'playing' | 'waiting_for_ready',
    playersReady: Set<number>
  ): void {
    this.ctx.fillStyle = '#111';
    this.ctx.fillRect(GAME_WIDTH, 0, PANEL_WIDTH, GAME_HEIGHT);

    // Draw player indicators
    players.forEach((player, i) => {
      const y = i * 150 + 75;

      this.ctx.fillStyle = `rgb(${player.color.r}, ${player.color.g}, ${player.color.b})`;
      this.ctx.fillRect(GAME_WIDTH + 10, y, 30, 30);

      // Draw status
      this.ctx.fillStyle = player.alive ? '#0f0' : '#f00';
      this.ctx.font = '10px monospace';
      this.ctx.fillText(player.alive ? 'ALIVE' : 'DEAD', GAME_WIDTH + 5, y + 45);

      // Draw ready status
      if (roundState === 'waiting_for_ready') {
        const isReady = playersReady.has(player.num);
        this.ctx.fillStyle = isReady ? '#0f0' : '#888';
        this.ctx.fillText(isReady ? 'READY' : 'WAIT', GAME_WIDTH + 5, y + 60);
      }
    });
  }

}
