// TronRenderer - Canvas rendering for the Tron game

import type { SlotIndex } from '../types/lobby';
import type { TronRoundState, TronMatchState, TrailSegment, LevelDefinition } from '../types/game';
import type { GamePlayer } from '../types/game';
import { PLAY_WIDTH, PLAY_HEIGHT } from './TronPlayer';

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;
const STATUS_WIDTH = 50;
const PLAYER_HEAD_SIZE = 1;

// Slot colors for the status panel when slot is empty
const SLOT_COLORS: Record<number, string> = {
  0: '#f44',  // Red
  1: '#4f4',  // Green
  2: '#44f',  // Blue
  3: '#ff4',  // Yellow
};

export class TronRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  // Off-screen canvas for persistent trails
  private trailCanvas: HTMLCanvasElement;
  private trailCtx: CanvasRenderingContext2D;

  // Off-screen canvas for level background
  private levelCanvas: HTMLCanvasElement;
  private levelCtx: CanvasRenderingContext2D;
  private currentLevelId: string | null = null;

  // Player configs for rendering
  private players: GamePlayer[];

  // Resize handler (stored for cleanup)
  private resizeHandler: () => void;

  constructor(container: HTMLElement, players: GamePlayer[]) {
    this.players = players;

    // Create main canvas - scaled to fit viewport while keeping aspect ratio
    this.canvas = document.createElement('canvas');
    this.canvas.width = CANVAS_WIDTH;
    this.canvas.height = CANVAS_HEIGHT;
    this.canvas.style.display = 'block';
    this.canvas.style.imageRendering = 'pixelated';
    this.canvas.style.border = '2px solid #333';

    // Scale canvas to use more screen space (up to 90% of viewport width/height)
    // Keep aspect ratio (4:3)
    const maxWidth = Math.min(window.innerWidth * 0.9, 1600);
    const maxHeight = Math.min(window.innerHeight * 0.85, 1200);
    const scaleX = maxWidth / CANVAS_WIDTH;
    const scaleY = maxHeight / CANVAS_HEIGHT;
    const scale = Math.min(scaleX, scaleY);

    this.canvas.style.width = `${CANVAS_WIDTH * scale}px`;
    this.canvas.style.height = `${CANVAS_HEIGHT * scale}px`;

    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.imageSmoothingEnabled = false;

    container.appendChild(this.canvas);

    // Handle window resize
    this.resizeHandler = () => {
      const maxW = Math.min(window.innerWidth * 0.9, 1600);
      const maxH = Math.min(window.innerHeight * 0.85, 1200);
      const sX = maxW / CANVAS_WIDTH;
      const sY = maxH / CANVAS_HEIGHT;
      const s = Math.min(sX, sY);
      this.canvas.style.width = `${CANVAS_WIDTH * s}px`;
      this.canvas.style.height = `${CANVAS_HEIGHT * s}px`;
    };
    window.addEventListener('resize', this.resizeHandler);

    // Create off-screen trail canvas
    this.trailCanvas = document.createElement('canvas');
    this.trailCanvas.width = PLAY_WIDTH;
    this.trailCanvas.height = PLAY_HEIGHT;
    this.trailCtx = this.trailCanvas.getContext('2d')!;
    this.trailCtx.imageSmoothingEnabled = false;

    // Create off-screen level canvas
    this.levelCanvas = document.createElement('canvas');
    this.levelCanvas.width = PLAY_WIDTH;
    this.levelCanvas.height = PLAY_HEIGHT;
    this.levelCtx = this.levelCanvas.getContext('2d')!;
    this.levelCtx.imageSmoothingEnabled = false;
  }

  // Main render function
  render(round: TronRoundState, match: TronMatchState): void {
    // Clear the play area
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, PLAY_WIDTH, CANVAS_HEIGHT);

    // Draw level background (if any)
    if (this.currentLevelId !== null) {
      this.ctx.drawImage(this.levelCanvas, 0, 0);
    }

    // Draw trails from off-screen canvas
    this.ctx.drawImage(this.trailCanvas, 0, 0);

    // Draw player heads
    for (const playerState of round.players) {
      if (playerState.alive) {
        this.drawPlayerHead(
          Math.floor(playerState.x / 1000),
          Math.floor(playerState.y / 1000),
          playerState.color
        );
      }
    }

    // Draw status panel
    this.renderStatusPanel(match);

    // Draw overlays based on phase
    switch (round.phase) {
      case 'countdown':
        this.drawCountdownOverlay(round.countdown);
        break;
      case 'round_end':
        this.drawRoundEndOverlay(round.roundWinner, match);
        break;
      case 'waiting_ready':
        this.drawWaitingReadyOverlay(match);
        break;
    }
  }

  // Add trail segments to the off-screen canvas
  addTrailSegments(slotIndex: SlotIndex, segments: TrailSegment[]): void {
    const player = this.players.find(p => p.slotIndex === slotIndex);
    if (!player) return;

    this.trailCtx.fillStyle = player.color;
    for (const seg of segments) {
      this.trailCtx.fillRect(seg.x, seg.y, 1, 1);
    }
  }

  // Clear all trails (for new round)
  clearTrails(): void {
    this.trailCtx.clearRect(0, 0, PLAY_WIDTH, PLAY_HEIGHT);
  }

  // Load a level background and return obstacle pixels
  // Returns a Promise that resolves with the set of obstacle pixel coordinates
  async loadLevel(level: LevelDefinition): Promise<Set<string>> {
    const obstacles = new Set<string>();

    if (level.imagePath === null) {
      // Blank level - clear level canvas
      this.levelCtx.clearRect(0, 0, PLAY_WIDTH, PLAY_HEIGHT);
      this.currentLevelId = null;
      return obstacles;
    }

    // Load the level image
    const img = new Image();
    img.src = level.imagePath;

    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error(`Failed to load level image: ${level.imagePath}`));
    });

    // Draw to level canvas
    this.levelCtx.drawImage(img, 0, 0, PLAY_WIDTH, PLAY_HEIGHT);
    this.currentLevelId = level.id;

    // Extract non-black pixels as obstacles
    const imageData = this.levelCtx.getImageData(0, 0, PLAY_WIDTH, PLAY_HEIGHT);
    const data = imageData.data;

    for (let y = 0; y < PLAY_HEIGHT; y++) {
      for (let x = 0; x < PLAY_WIDTH; x++) {
        const idx = (y * PLAY_WIDTH + x) * 4;
        const r = data[idx] ?? 0;
        const g = data[idx + 1] ?? 0;
        const b = data[idx + 2] ?? 0;

        // Non-black pixels are obstacles (threshold to handle near-black colors)
        if (r > 10 || g > 10 || b > 10) {
          obstacles.add(`${x},${y}`);
        }
      }
    }

    return obstacles;
  }

  // Clear level (for blank level)
  clearLevel(): void {
    this.levelCtx.clearRect(0, 0, PLAY_WIDTH, PLAY_HEIGHT);
    this.currentLevelId = null;
  }

  private drawPlayerHead(x: number, y: number, color: string): void {
    // Draw a white head with colored glow
    const offset = Math.floor(PLAYER_HEAD_SIZE / 2);

    // Glow effect in player color
    this.ctx.shadowColor = color;
    this.ctx.shadowBlur = 10;

    // White head pixel
    this.ctx.fillStyle = '#fff';
    this.ctx.fillRect(x - offset, y - offset, PLAYER_HEAD_SIZE, PLAYER_HEAD_SIZE);

    this.ctx.shadowBlur = 0;
  }

  private renderStatusPanel(match: TronMatchState): void {
    const panelX = PLAY_WIDTH;
    const slotHeight = CANVAS_HEIGHT / 4;

    for (let i = 0; i < 4; i++) {
      const y = i * slotHeight;
      const slotIndex = i as SlotIndex;
      const player = this.players.find(p => p.slotIndex === slotIndex);

      // Background color for slot
      if (player) {
        this.ctx.fillStyle = player.color;
      } else {
        // Empty slot - dimmed default color
        this.ctx.fillStyle = this.dimColor(SLOT_COLORS[i] || '#333');
      }
      this.ctx.fillRect(panelX, y, STATUS_WIDTH, slotHeight);

      // Score
      if (player) {
        const score = match.scores[slotIndex] || 0;
        this.ctx.fillStyle = '#fff';
        this.ctx.font = 'bold 24px monospace';
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        this.ctx.fillText(String(score), panelX + STATUS_WIDTH / 2, y + slotHeight / 2);

        // Ready indicator
        if (match.playersReady.includes(slotIndex)) {
          this.ctx.fillStyle = '#0f0';
          this.ctx.font = '12px monospace';
          this.ctx.fillText('READY', panelX + STATUS_WIDTH / 2, y + slotHeight - 15);
        }
      }

      // Border between slots
      this.ctx.strokeStyle = '#000';
      this.ctx.lineWidth = 2;
      this.ctx.strokeRect(panelX, y, STATUS_WIDTH, slotHeight);
    }

    // Outer border
    this.ctx.strokeStyle = '#333';
    this.ctx.strokeRect(panelX, 0, STATUS_WIDTH, CANVAS_HEIGHT);
  }

  private drawCountdownOverlay(countdown: number): void {
    // Semi-transparent overlay
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    this.ctx.fillRect(0, 0, PLAY_WIDTH, CANVAS_HEIGHT);

    // Countdown number
    const displayNum = Math.ceil(countdown);
    const text = displayNum > 0 ? String(displayNum) : 'GO!';

    this.ctx.fillStyle = '#0ff';
    this.ctx.font = 'bold 120px monospace';
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'middle';
    this.ctx.shadowColor = '#0ff';
    this.ctx.shadowBlur = 20;
    this.ctx.fillText(text, PLAY_WIDTH / 2, CANVAS_HEIGHT / 2);
    this.ctx.shadowBlur = 0;
  }

  private drawRoundEndOverlay(winner: SlotIndex | 'draw' | null, match: TronMatchState): void {
    // Semi-transparent overlay
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    this.ctx.fillRect(0, 0, PLAY_WIDTH, CANVAS_HEIGHT);

    let titleText: string;
    let titleColor: string;

    if (winner === 'draw') {
      titleText = 'DRAW!';
      titleColor = '#ff0';
    } else if (winner !== null) {
      const winningPlayer = this.players.find(p => p.slotIndex === winner);
      if (match.gameMode === 'team') {
        const teamName = winner % 2 === 0 ? 'PURPLE' : 'BROWN';
        titleText = `TEAM ${teamName} WINS!`;
        titleColor = winner % 2 === 0 ? '#a0a' : '#a60';
      } else {
        titleText = `${winningPlayer?.nickname || 'Player'} WINS!`;
        titleColor = winningPlayer?.color || '#fff';
      }
    } else {
      titleText = 'ROUND OVER';
      titleColor = '#fff';
    }

    // Title
    this.ctx.fillStyle = titleColor;
    this.ctx.font = 'bold 48px monospace';
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'middle';
    this.ctx.shadowColor = titleColor;
    this.ctx.shadowBlur = 15;
    this.ctx.fillText(titleText, PLAY_WIDTH / 2, CANVAS_HEIGHT / 2 - 40);
    this.ctx.shadowBlur = 0;

    // Instructions
    this.ctx.fillStyle = '#888';
    this.ctx.font = '20px monospace';
    this.ctx.fillText('Press SPACE when ready', PLAY_WIDTH / 2, CANVAS_HEIGHT / 2 + 40);
  }

  private drawWaitingReadyOverlay(match: TronMatchState): void {
    // Lighter overlay
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    this.ctx.fillRect(0, 0, PLAY_WIDTH, CANVAS_HEIGHT);

    // Title
    this.ctx.fillStyle = '#0ff';
    this.ctx.font = 'bold 36px monospace';
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'middle';
    this.ctx.fillText('WAITING FOR PLAYERS', PLAY_WIDTH / 2, CANVAS_HEIGHT / 2 - 80);

    // Player ready status - start below title with proper spacing
    this.ctx.textBaseline = 'alphabetic';
    const startY = CANVAS_HEIGHT / 2 - 20;

    this.players.forEach((player, i) => {
      const isReady = match.playersReady.includes(player.slotIndex);
      const statusText = isReady ? 'READY' : 'waiting...';
      const statusColor = isReady ? '#0f0' : '#666';
      const y = startY + i * 35;

      // Nickname right-aligned on left side
      this.ctx.fillStyle = player.color;
      this.ctx.font = '20px monospace';
      this.ctx.textAlign = 'right';
      this.ctx.fillText(player.nickname, PLAY_WIDTH / 2 - 20, y);

      // Status left-aligned on right side
      this.ctx.fillStyle = statusColor;
      this.ctx.textAlign = 'left';
      this.ctx.fillText(statusText, PLAY_WIDTH / 2 + 20, y);
    });

    // Instructions
    this.ctx.fillStyle = '#888';
    this.ctx.font = '16px monospace';
    this.ctx.textAlign = 'center';
    const instructionY = startY + this.players.length * 35 + 40;
    this.ctx.fillText('Press SPACE when ready', PLAY_WIDTH / 2, instructionY);
  }

  private dimColor(color: string): string {
    // Dim a hex color by reducing its brightness
    // Simple implementation - just make it darker
    if (color.startsWith('#') && color.length === 4) {
      // Convert #RGB to #RRGGBB
      const r = color[1];
      const g = color[2];
      const b = color[3];
      color = `#${r}${r}${g}${g}${b}${b}`;
    }

    if (color.startsWith('#') && color.length === 7) {
      const r = Math.floor(parseInt(color.slice(1, 3), 16) * 0.3);
      const g = Math.floor(parseInt(color.slice(3, 5), 16) * 0.3);
      const b = Math.floor(parseInt(color.slice(5, 7), 16) * 0.3);
      return `rgb(${r}, ${g}, ${b})`;
    }

    return '#222';
  }

  // Clean up
  destroy(): void {
    window.removeEventListener('resize', this.resizeHandler);
    this.canvas.remove();
  }
}
