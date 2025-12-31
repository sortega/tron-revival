// TronRenderer - Canvas rendering for the Tron game

import type { SlotIndex } from '../types/lobby';
import type { TronRoundState, TronMatchState, TrailSegment, LevelDefinition, TeleportPortal, GameItem, TronPlayerState } from '../types/game';
import type { GamePlayer } from '../types/game';
import { PLAY_WIDTH, PLAY_HEIGHT } from './TronPlayer';
import { SpriteAtlas } from '../sprites';
import { SPRITE_HASH } from './spriteHash';

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;
const STATUS_WIDTH = 50;
const PLAYER_HEAD_SIZE = 1;

export class TronRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  // Off-screen canvas for persistent trails
  private readonly trailCanvas: HTMLCanvasElement;
  private trailCtx: CanvasRenderingContext2D;

  // Off-screen canvas for level background
  private readonly levelCanvas: HTMLCanvasElement;
  private levelCtx: CanvasRenderingContext2D;
  private currentLevelId: string | null = null;

  // Player configs for rendering
  private players: GamePlayer[];

  // Sprite atlas for items/portals
  private spriteAtlas: SpriteAtlas | null = null;

  // Resize handler (stored for cleanup)
  private readonly resizeHandler: () => void;

  constructor(container: HTMLElement, players: GamePlayer[], fullscreen: boolean = false) {
    this.players = players;

    // Create main canvas - scaled to fit viewport while keeping aspect ratio
    this.canvas = document.createElement('canvas');
    this.canvas.width = CANVAS_WIDTH;
    this.canvas.height = CANVAS_HEIGHT;
    this.canvas.style.display = 'block';
    this.canvas.style.imageRendering = 'pixelated';

    if (fullscreen) {
      // Mobile: fill container, CSS handles sizing
      this.canvas.style.width = '100%';
      this.canvas.style.height = '100%';
      this.canvas.style.objectFit = 'contain';
      this.canvas.style.border = 'none';
      this.resizeHandler = () => {}; // No resize needed
    } else {
      // Desktop: scale with constraints
      this.canvas.style.border = '2px solid #333';
      const maxWidth = Math.min(window.innerWidth * 0.9, 1600);
      const maxHeight = Math.min(window.innerHeight * 0.85, 1200);
      const scaleX = maxWidth / CANVAS_WIDTH;
      const scaleY = maxHeight / CANVAS_HEIGHT;
      const scale = Math.min(scaleX, scaleY);

      this.canvas.style.width = `${CANVAS_WIDTH * scale}px`;
      this.canvas.style.height = `${CANVAS_HEIGHT * scale}px`;

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
    }

    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.imageSmoothingEnabled = false;

    container.appendChild(this.canvas);

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

    // Load sprite atlas asynchronously - rendering methods check isLoaded() and
    // gracefully skip drawing if sprites aren't ready yet. The countdown phase
    // provides enough time for loading before gameplay begins.
    void this.loadSprites();
  }

  // Load sprite atlas for items and portals
  private async loadSprites(): Promise<void> {
    try {
      this.spriteAtlas = new SpriteAtlas();
      await this.spriteAtlas.load(`${import.meta.env.BASE_URL}assets/sprites/items.${SPRITE_HASH}.json`);
    } catch (error) {
      console.error('Failed to load sprite atlas:', error);
    }
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

    // Draw teleport portals
    for (const portal of round.portals) {
      this.drawPortal(portal);
    }

    // Draw items
    for (const item of round.items) {
      if (item.active) {
        this.drawItem(item);
      }
    }

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
    this.renderStatusPanel(round.players);

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

  // Draw a teleport portal (both endpoints with wrap-around)
  private drawPortal(portal: TeleportPortal): void {
    if (!this.spriteAtlas?.isLoaded()) return;

    // Get the animation frame name (portal_01 to portal_30)
    const frameNum = String(portal.animFrame + 1).padStart(2, '0');
    const frameName = `portal_${frameNum}`;

    // Draw both endpoints with wrap-around rendering
    this.spriteAtlas.drawWrapped(
      this.ctx,
      frameName,
      portal.x1,
      portal.y1,
      PLAY_WIDTH,
      PLAY_HEIGHT
    );

    this.spriteAtlas.drawWrapped(
      this.ctx,
      frameName,
      portal.x2,
      portal.y2,
      PLAY_WIDTH,
      PLAY_HEIGHT
    );
  }

  // Draw an item on the play area
  private drawItem(item: GameItem): void {
    if (!this.spriteAtlas?.isLoaded()) return;

    // Mystery items show the random_item sprite instead of their actual sprite
    const spriteName = item.mystery ? 'random_item' : item.sprite;

    // Draw with wrap-around rendering using sprite name directly
    this.spriteAtlas.drawWrapped(
      this.ctx,
      spriteName,
      item.x,
      item.y,
      PLAY_WIDTH,
      PLAY_HEIGHT
    );
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

  private renderStatusPanel(playerStates: TronPlayerState[]): void {
    const panelX = PLAY_WIDTH;
    const slotHeight = CANVAS_HEIGHT / 4;

    // Draw sidebar background sprite (50x600, covers all 4 slots)
    if (this.spriteAtlas?.isLoaded()) {
      this.spriteAtlas.draw(
        this.ctx,
        'sidebar',
        panelX + STATUS_WIDTH / 2,
        CANVAS_HEIGHT / 2
      );
    }

    for (let i = 0; i < 4; i++) {
      const y = i * slotHeight;
      const slotIndex = i as SlotIndex;
      const player = this.players.find(p => p.slotIndex === slotIndex);
      const playerState = playerStates.find(p => p.slotIndex === slotIndex);

      if (player && playerState) {
        const centerX = panelX + STATUS_WIDTH / 2;
        const hasWeapon = !!playerState.equippedWeapon;
        const hasEffect = playerState.activeEffects && playerState.activeEffects.length > 0;

        // Layout: weapon on top half, effect on bottom half
        // Draw equipped weapon icon and ammo (top half)
        if (hasWeapon && playerState.equippedWeapon && this.spriteAtlas?.isLoaded()) {
          // Draw weapon sidebar icon (uses _sidebar sprite)
          this.spriteAtlas.draw(
            this.ctx,
            playerState.equippedWeapon.sprite + '_sidebar',
            centerX,
            y + slotHeight * 0.25
          );
          // Draw ammo/time below icon in black
          const { ammo, remainingFrames } = playerState.equippedWeapon;
          if (remainingFrames !== undefined) {
            // Time-based weapon: show seconds
            this.ctx.fillStyle = '#000';
            this.ctx.font = 'bold 14px monospace';
            this.ctx.textAlign = 'center';
            this.ctx.textBaseline = 'top';
            this.ctx.fillText(`${Math.ceil(remainingFrames / 60)}s`, centerX, y + slotHeight * 0.25 + 22);
          } else if (ammo !== undefined && ammo > 1) {
            // Shot-based weapon: show ammo count (skip single-use)
            this.ctx.fillStyle = '#000';
            this.ctx.font = 'bold 14px monospace';
            this.ctx.textAlign = 'center';
            this.ctx.textBaseline = 'top';
            this.ctx.fillText(String(ammo), centerX, y + slotHeight * 0.25 + 22);
          }
        }

        // Draw active effect icon and timer (bottom half)
        if (hasEffect) {
          const effect = playerState.activeEffects[0];
          if (effect && this.spriteAtlas?.isLoaded()) {
            // Draw effect sidebar icon (uses _sidebar sprite)
            this.spriteAtlas.draw(
              this.ctx,
              effect.sprite + '_sidebar',
              centerX,
              y + slotHeight * 0.75
            );
            // Draw remaining seconds below icon in black
            const remainingSecs = Math.ceil(effect.remainingFrames / 60);
            this.ctx.fillStyle = '#000';
            this.ctx.font = 'bold 14px monospace';
            this.ctx.textAlign = 'center';
            this.ctx.textBaseline = 'top';
            this.ctx.fillText(`${remainingSecs}s`, centerX, y + slotHeight * 0.75 + 22);
          }
        }

      }
    }
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
    this.ctx.fillText('Press ACTION when ready', PLAY_WIDTH / 2, CANVAS_HEIGHT / 2 + 40);
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
    this.ctx.fillText('Press ACTION when ready', PLAY_WIDTH / 2, instructionY);
  }

  // Clean up
  destroy(): void {
    window.removeEventListener('resize', this.resizeHandler);
    this.canvas.remove();
  }
}
