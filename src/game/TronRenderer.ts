// TronRenderer - Canvas rendering for the Tron game

import type { SlotIndex } from '../types/lobby';
import { FFA_COLORS, TEAM_COLORS } from '../types/lobby';
import type { TronRoundState, TronMatchState, TrailSegment, LevelDefinition, TeleportPortal, GameItem, TronPlayerState, Projectile, Explosion, Bodyguard } from '../types/game';
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
  private currentLevelImage: HTMLImageElement | null = null;

  // Player configs for rendering
  private players: GamePlayer[];

  // Sprite atlas for items/portals
  private spriteAtlas: SpriteAtlas | null = null;

  // Ridiculous death display - slots that died ridiculously this round
  private ridiculousDeathSlots: Set<SlotIndex> = new Set();

  // Color blindness effect state
  private colorBlindnessFrames: number = 0;  // Remaining frames (used for color cycling and sprite position)
  private readonly COLOR_BLINDNESS_DURATION = 280;  // Must match TronGameState

  // Trail data storage for color blindness redrawing
  private trailData: Map<SlotIndex, TrailSegment[]> = new Map();

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
  render(round: TronRoundState, match: TronMatchState, fps?: number): void {
    // Clear the play area
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, PLAY_WIDTH, CANVAS_HEIGHT);

    // Draw level background
    this.ctx.drawImage(this.levelCanvas, 0, 0);

    // Handle color blindness color cycling for trails
    if (this.colorBlindnessFrames > 0) {
      // Calculate elapsed frames and color index
      const elapsed = this.COLOR_BLINDNESS_DURATION - this.colorBlindnessFrames;
      const colors = this.getColorBlindnessColors();
      const colorIndex = Math.floor(elapsed / 2) % colors.length;  // Change every 2 frames
      const currentColor = colors[colorIndex]!;

      // Redraw trails with cycling color
      this.trailCtx.clearRect(0, 0, PLAY_WIDTH, PLAY_HEIGHT);
      this.trailCtx.fillStyle = currentColor;
      for (const segments of this.trailData.values()) {
        for (const seg of segments) {
          this.trailCtx.fillRect(seg.x, seg.y, 1, 1);
        }
      }
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

    // Draw projectiles
    for (const proj of round.projectiles) {
      this.drawProjectile(proj);
    }

    // Draw explosions
    for (const exp of round.explosions) {
      this.drawExplosion(exp);
    }

    // Draw bodyguards
    for (const bg of round.bodyguards) {
      this.drawBodyguard(bg);
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

    // Draw color blindness crossing sprites
    if (this.colorBlindnessFrames > 0 && this.spriteAtlas?.isLoaded()) {
      const elapsed = this.COLOR_BLINDNESS_DURATION - this.colorBlindnessFrames;
      const progress = elapsed * 3;  // Speed of crossing (3 pixels per frame)

      // Top sprite: left to right at y=100
      const topX = progress - 100;  // Start off-screen left
      this.spriteAtlas.draw(this.ctx, 'color_blind_to_left', topX, 100);

      // Bottom sprite: right to left at y=PLAY_HEIGHT-100
      const bottomX = PLAY_WIDTH - progress + 100;  // Start off-screen right
      this.spriteAtlas.draw(this.ctx, 'color_blind_to_right', bottomX, PLAY_HEIGHT - 100);
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

    // Draw FPS counter (debug)
    if (fps !== undefined) {
      this.ctx.fillStyle = fps < 60 ? '#f44' : fps < 68 ? '#ff0' : '#0f0';
      this.ctx.font = '12px monospace';
      this.ctx.textAlign = 'left';
      this.ctx.textBaseline = 'top';
      this.ctx.fillText(`${fps} FPS`, 4, 4);
    }
  }

  // Add trail segments to the off-screen canvas
  addTrailSegments(slotIndex: SlotIndex, segments: TrailSegment[]): void {
    const player = this.players.find(p => p.slotIndex === slotIndex);
    if (!player) return;

    // Store for color blindness redrawing
    const existing = this.trailData.get(slotIndex) || [];
    existing.push(...segments);
    this.trailData.set(slotIndex, existing);

    this.trailCtx.fillStyle = player.color;
    for (const seg of segments) {
      this.trailCtx.fillRect(seg.x, seg.y, 1, 1);
    }
  }

  // Add border segments to the level canvas (for lock borders effect)
  // Border pixels become part of the level background, not trails
  addBorderSegments(color: string, segments: TrailSegment[]): void {
    this.levelCtx.fillStyle = color;
    for (const seg of segments) {
      this.levelCtx.fillRect(seg.x, seg.y, 1, 1);
    }
  }

  // Clear all trails and restore level (for new round)
  clearTrails(): void {
    this.trailCtx.clearRect(0, 0, PLAY_WIDTH, PLAY_HEIGHT);
    this.ridiculousDeathSlots.clear();
    this.trailData.clear();
    this.colorBlindnessFrames = 0;
    // Restore level canvas (removes lock borders modifications)
    if (this.currentLevelImage) {
      this.levelCtx.drawImage(this.currentLevelImage, 0, 0, PLAY_WIDTH, PLAY_HEIGHT);
    }
  }

  // Restore level to original state (for eraser)
  // Clears trails and redraws original level image
  restoreLevel(): void {
    // Clear trails
    this.trailCtx.clearRect(0, 0, PLAY_WIDTH, PLAY_HEIGHT);
    this.trailData.clear();

    // Restore level canvas from stored image
    if (this.currentLevelImage) {
      this.levelCtx.drawImage(this.currentLevelImage, 0, 0, PLAY_WIDTH, PLAY_HEIGHT);
    }
  }

  // Clear a circular area from trail canvas (for bullet impacts)
  clearArea(x: number, y: number, radius: number): void {
    // Clear from trail canvas (with wrap-around)
    for (let dx = -radius; dx < radius; dx++) {
      for (let dy = -radius; dy < radius; dy++) {
        const cx = ((x + dx) % PLAY_WIDTH + PLAY_WIDTH) % PLAY_WIDTH;
        const cy = ((y + dy) % PLAY_HEIGHT + PLAY_HEIGHT) % PLAY_HEIGHT;
        this.trailCtx.clearRect(cx, cy, 1, 1);
      }
    }
  }

  // Trigger ridiculous death display for a player
  triggerRidiculousDeath(slotIndex: SlotIndex): void {
    this.ridiculousDeathSlots.add(slotIndex);
  }

  // Update color blindness state from game state
  updateColorBlindness(frames: number): void {
    this.colorBlindnessFrames = frames;
  }

  // Get color blindness color palette (all player colors regardless of game mode)
  private getColorBlindnessColors(): string[] {
    return [
      FFA_COLORS[0], FFA_COLORS[1], FFA_COLORS[2], FFA_COLORS[3],
      TEAM_COLORS.purple, TEAM_COLORS.brown
    ];
  }

  // Load a level background and return obstacle pixels with their colors
  // Returns a Promise that resolves with a map of pixel coordinates -> hex color
  async loadLevel(level: LevelDefinition): Promise<Map<string, string>> {
    const obstacles = new Map<string, string>();

    // Load the level image
    const img = new Image();
    img.src = level.imagePath;

    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error(`Failed to load level image: ${level.imagePath}`));
    });

    // Store the image for potential restoration (eraser)
    this.currentLevelImage = img;

    // Draw to level canvas
    this.levelCtx.drawImage(img, 0, 0, PLAY_WIDTH, PLAY_HEIGHT);

    // Extract non-black pixels as obstacles with their colors
    const imageData = this.levelCtx.getImageData(0, 0, PLAY_WIDTH, PLAY_HEIGHT);
    const data = imageData.data;

    for (let y = 0; y < PLAY_HEIGHT; y++) {
      for (let x = 0; x < PLAY_WIDTH; x++) {
        const idx = (y * PLAY_WIDTH + x) * 4;
        const r = data[idx] ?? 0;
        const g = data[idx + 1] ?? 0;
        const b = data[idx + 2] ?? 0;

        // Non-black pixels are obstacles (only pitch black is passable)
        if (r !== 0 || g !== 0 || b !== 0) {
          // Convert to hex color
          const color = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
          obstacles.set(`${x},${y}`, color);
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

  // Draw a projectile (bullet, tracer, or bomb)
  private drawProjectile(proj: Projectile): void {
    const x = Math.floor(proj.x / 1000);
    const y = Math.floor(proj.y / 1000);

    if (proj.type === 'tracer') {
      // Tracer: single white pixel
      this.ctx.fillStyle = '#fff';
      this.ctx.fillRect(x, y, 1, 1);
    } else if (proj.type === 'bomb') {
      // Bomb: use directional sprites (bomb_0, bomb_30, bomb_60, bomb_90)
      if (!this.spriteAtlas?.isLoaded()) return;
      // Snap direction to nearest 30° increment (0, 30, 60, 90)
      // Then use the sprite for that angle
      const normalizedDir = ((proj.direction % 360) + 360) % 360;
      const snappedAngle = Math.round(normalizedDir / 30) * 30;
      // Map to available sprites (0, 30, 60, 90 then repeat with rotation)
      const baseAngle = snappedAngle % 120;
      const rotation = (Math.floor(snappedAngle / 120) * 120 * Math.PI) / 180;
      const spriteName = `bomb_${baseAngle}`;
      this.spriteAtlas.drawWrapped(this.ctx, spriteName, x, y, PLAY_WIDTH, PLAY_HEIGHT, {
        rotation,
      });
    } else {
      // Bullet: use sprite with rotation
      if (!this.spriteAtlas?.isLoaded()) return;
      const rotation = (proj.direction * Math.PI) / 180;
      this.spriteAtlas.drawWrapped(this.ctx, 'bullet', x, y, PLAY_WIDTH, PLAY_HEIGHT, {
        rotation,
      });
    }
  }

  // Draw an explosion animation
  private drawExplosion(exp: Explosion): void {
    if (!this.spriteAtlas?.isLoaded()) return;

    const frameNum = String(exp.frame + 1).padStart(2, '0');
    const frameName = `explossion_${frameNum}`;

    const scale = exp.scale ?? 0.2;
    this.spriteAtlas.drawWrapped(
      this.ctx,
      frameName,
      exp.x,
      exp.y,
      PLAY_WIDTH,
      PLAY_HEIGHT,
      { scale }
    );
  }

  // Draw a bodyguard orbiting entity
  private drawBodyguard(bg: Bodyguard): void {
    if (!this.spriteAtlas?.isLoaded()) return;

    const x = Math.floor(bg.x / 1000);
    const y = Math.floor(bg.y / 1000);

    this.spriteAtlas.drawWrapped(
      this.ctx,
      'bodyguard',
      x,
      y,
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

        // Check if ridiculous death should be shown (overrides other displays)
        if (this.ridiculousDeathSlots.has(slotIndex) && this.spriteAtlas?.isLoaded()) {
          // Draw ridiculous death sprite covering the slot (50x150)
          this.spriteAtlas.draw(
            this.ctx,
            'ridiculous_death',
            centerX,
            y + slotHeight / 2
          );
          continue; // Skip normal rendering for this slot
        }

        const hasWeapon = !!playerState.equippedWeapon;
        const hasEffect = playerState.activeEffects && playerState.activeEffects.length > 0;

        // Layout: effect on top half, weapon on bottom half
        // Draw active effect icon and timer (top half)
        if (hasEffect) {
          const effect = playerState.activeEffects[0];
          if (effect && this.spriteAtlas?.isLoaded()) {
            // Draw effect sidebar icon (uses _sidebar sprite)
            this.spriteAtlas.draw(
              this.ctx,
              effect.sprite + '_sidebar',
              centerX,
              y + slotHeight * 0.25
            );
            // Draw remaining seconds below icon in black
            const remainingSecs = Math.ceil(effect.remainingFrames / 70);
            this.ctx.fillStyle = '#000';
            this.ctx.font = 'bold 14px monospace';
            this.ctx.textAlign = 'center';
            this.ctx.textBaseline = 'top';
            this.ctx.fillText(`${remainingSecs}s`, centerX, y + slotHeight * 0.25 + 22);
          }
        }

        // Draw equipped weapon icon and ammo (bottom half)
        if (hasWeapon && playerState.equippedWeapon && this.spriteAtlas?.isLoaded()) {
          // Draw weapon sidebar icon (uses _sidebar sprite)
          this.spriteAtlas.draw(
            this.ctx,
            playerState.equippedWeapon.sprite + '_sidebar',
            centerX,
            y + slotHeight * 0.75
          );
          // Draw ammo/time below icon in black
          const { ammo, remainingFrames } = playerState.equippedWeapon;
          if (remainingFrames !== undefined) {
            // Time-based weapon: show seconds
            this.ctx.fillStyle = '#000';
            this.ctx.font = 'bold 14px monospace';
            this.ctx.textAlign = 'center';
            this.ctx.textBaseline = 'top';
            this.ctx.fillText(`${Math.ceil(remainingFrames / 70)}s`, centerX, y + slotHeight * 0.75 + 22);
          } else if (ammo !== undefined && ammo > 1) {
            // Shot-based weapon: show ammo count (skip single-use)
            this.ctx.fillStyle = '#000';
            this.ctx.font = 'bold 14px monospace';
            this.ctx.textAlign = 'center';
            this.ctx.textBaseline = 'top';
            this.ctx.fillText(String(ammo), centerX, y + slotHeight * 0.75 + 22);
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

    // Title - show round number
    this.ctx.fillStyle = '#0ff';
    this.ctx.font = 'bold 36px monospace';
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'middle';
    const title = match.currentRound > 1 ? `ROUND ${match.currentRound}` : 'GET READY';
    this.ctx.fillText(title, PLAY_WIDTH / 2, CANVAS_HEIGHT / 2 - 100);

    // Column positions
    const winsX = PLAY_WIDTH / 2 - 160;
    const mrX = PLAY_WIDTH / 2 - 120;
    const nicknameX = PLAY_WIDTH / 2 - 90;
    const statusX = PLAY_WIDTH / 2 + 80;
    const maxNicknameWidth = 150; // Max width before truncation

    // Headers
    this.ctx.fillStyle = '#888';
    this.ctx.font = 'bold 14px monospace';
    this.ctx.textBaseline = 'alphabetic';
    const headerY = CANVAS_HEIGHT / 2 - 55;
    this.ctx.textAlign = 'right';
    this.ctx.fillText('Wins', winsX, headerY);
    this.ctx.fillText('MR', mrX, headerY);
    this.ctx.textAlign = 'left';
    this.ctx.fillText('Player', nicknameX, headerY);

    // Player scores and ready status
    const startY = CANVAS_HEIGHT / 2 - 30;

    // Sort players by score (descending) for display
    const sortedPlayers = [...this.players].sort((a, b) => {
      const scoreA = match.scores[a.slotIndex] || 0;
      const scoreB = match.scores[b.slotIndex] || 0;
      return scoreB - scoreA;
    });

    sortedPlayers.forEach((player, i) => {
      const isReady = match.playersReady.includes(player.slotIndex);
      const score = match.scores[player.slotIndex] || 0;
      const mr = match.ridiculousDeath?.[player.slotIndex] || 0;
      const y = startY + i * 35;

      // Wins (score)
      this.ctx.fillStyle = '#ff0';
      this.ctx.font = 'bold 20px monospace';
      this.ctx.textAlign = 'right';
      this.ctx.fillText(String(score), winsX, y);

      // MR count
      this.ctx.fillStyle = mr > 0 ? '#f44' : '#666';
      this.ctx.fillText(String(mr), mrX, y);

      // Nickname (truncated with ellipsis if too long)
      this.ctx.fillStyle = player.color;
      this.ctx.font = '20px monospace';
      this.ctx.textAlign = 'left';
      let nickname = player.nickname;
      while (this.ctx.measureText(nickname).width > maxNicknameWidth && nickname.length > 3) {
        nickname = nickname.slice(0, -1);
      }
      if (nickname !== player.nickname) {
        nickname = nickname.slice(0, -2) + '…';
      }
      this.ctx.fillText(nickname, nicknameX, y);

      // Ready status
      const statusText = isReady ? 'READY' : 'waiting...';
      this.ctx.fillStyle = isReady ? '#0f0' : '#666';
      this.ctx.textAlign = 'left';
      this.ctx.fillText(statusText, statusX, y);
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
