// TronRenderer - Canvas rendering for the Tron game

import { decodePng } from './png';
import type { GameMode, SlotIndex } from '../types/lobby';
import { FFA_COLORS, TEAM_COLORS, getSlotColor, getSlotColorName } from '../types/lobby';
import { NO_OWNER } from '../types/game';
import { describeDeath } from './deathLabels';
import type { TronRoundState, TronMatchState, TrailSegment, LevelDefinition, TeleportPortal, GameItem, TronPlayerState, Projectile, Explosion, Bodyguard, DeathCause } from '../types/game';
import type { GamePlayer } from '../types/game';
import { PLAY_WIDTH, PLAY_HEIGHT, TICK_RATE } from './constants';
import { PixelGrid } from './PixelGrid';
import { ArenaDisplay, CanvasLayerSink } from './display/ArenaDisplay';
import { SOFT } from './display/settings';
import { PathTracker } from './display/SmoothLines';
import type { SmoothLinesData } from './display/SmoothLines';
import { SpriteAtlas } from '../sprites';
import { SPRITE_HASH } from './spriteHash';

import type { NetworkStats } from './session/GameSession';
import { DOOR_LENGTH, DOOR_THICKNESS, doorFrame } from './doors';
import type { DoorDefinition } from './doors';
import { HAND_SPRITE, underHand } from './hand';
import type { HandView } from './hand';

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;
const STATUS_WIDTH = 50;
const PLAYER_HEAD_SIZE = 1;

export class TronRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  // Display bitmap of the arena (trails, walls) and the layers derived from it; kept
  // apart from the collision bitmap (design/display-layer.md)
  private readonly layers: CanvasLayerSink;
  private readonly display: ArenaDisplay;
  private lightBackground = false;  // The level's background is light: heads and tracers need dark on it
  private backgroundImage: HTMLImageElement | null = null;  // Display only, never a wall
  private backgroundCanvas: HTMLCanvasElement | null = null;  // The image at the display scale
  private backgroundKey = '';
  private levelHidden = false;  // True while a snapshot stands in for the level image

  // Automatic doors of the current level and their sprite strip (10 frames, stacked)
  private doors: readonly DoorDefinition[] = [];
  private doorImage: HTMLImageElement | null = null;

  // Player configs for rendering
  private players: GamePlayer[];

  // Sprite atlas for items/portals
  private spriteAtlas: SpriteAtlas | null = null;

  // Ridiculous death display - slots that died ridiculously this round
  private ridiculousDeathSlots: Set<SlotIndex> = new Set();

  // Why each player died this round (shown on the round summary)
  private deathCauses: Map<SlotIndex, { cause: DeathCause; by?: number }> = new Map();

  // Color blindness effect state
  private colorBlindnessFrames: number = 0;  // Remaining frames (used for color cycling and sprite position)
  private readonly COLOR_BLINDNESS_DURATION = 280;  // Must match TronGameState

  // White flash effect state (bomb-on-bomb collision)
  // 400ms solid white (28 frames) + 4 seconds fade (280 frames) = 308 frames total
  private whiteFlashFrames: number = 0;
  private readonly WHITE_FLASH_FADE = 280;  // Frames in fade phase (after solid)

  // Scratch canvas used to tint the trails during the color blindness effect
  private readonly tintCanvas: HTMLCanvasElement;
  private readonly tintCtx: CanvasRenderingContext2D;

  // The status panel as last drawn, and what it showed (see renderStatusPanel)
  private readonly sidebarCanvas: HTMLCanvasElement;
  private readonly sidebarCtx: CanvasRenderingContext2D;
  private sidebarKey = '';

  // Resize handler (stored for cleanup)
  private readonly resizeHandler: () => void;

  constructor(container: HTMLElement, players: GamePlayer[], fullscreen: boolean = false) {
    this.players = players;

    // Create main canvas - scaled to fit viewport while keeping aspect ratio
    this.canvas = document.createElement('canvas');
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

    container.appendChild(this.canvas);

    this.canvas.width = CANVAS_WIDTH;
    this.canvas.height = CANVAS_HEIGHT;
    this.ctx.imageSmoothingEnabled = false;

    this.tintCanvas = document.createElement('canvas');
    this.tintCanvas.width = PLAY_WIDTH;
    this.tintCanvas.height = PLAY_HEIGHT;
    this.tintCtx = this.tintCanvas.getContext('2d')!;

    this.sidebarCanvas = document.createElement('canvas');
    this.sidebarCanvas.width = STATUS_WIDTH;
    this.sidebarCanvas.height = CANVAS_HEIGHT;
    this.sidebarCtx = this.sidebarCanvas.getContext('2d')!;
    this.sidebarCtx.imageSmoothingEnabled = false;  // Like the main canvas

    this.layers = new CanvasLayerSink();
    this.display = new ArenaDisplay(PLAY_WIDTH, PLAY_HEIGHT, this.layers, SOFT);

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

  /** The main canvas, for debug overlays drawn after `render` (origin = the arena's). */
  get context(): CanvasRenderingContext2D {
    return this.ctx;
  }

  // Main render function
  render(
    round: TronRoundState, match: TronMatchState, fps?: number, networkStats?: NetworkStats,
    overlayTrails?: { color: string; segments: TrailSegment[] }[]
  ): void {
    // Background of the play area: black, or the level's display-only image
    const background = this.backgroundLayer();
    if (background) {
      this.ctx.drawImage(background, 0, 0, PLAY_WIDTH, PLAY_HEIGHT);
    } else {
      this.ctx.fillStyle = '#000';
      this.ctx.fillRect(0, 0, PLAY_WIDTH, CANVAS_HEIGHT);
    }

    // Bring the derived layers up to date with the display bitmap
    this.display.flush();

    // Walls (and their shadow)
    this.ctx.drawImage(this.layers.levelCanvas, 0, 0, PLAY_WIDTH, PLAY_HEIGHT);

    // Draw trails (and their shade). During color blindness every trail is tinted with
    // one cycling colour
    let trails: HTMLCanvasElement = this.layers.trailCanvas;
    if (this.colorBlindnessFrames > 0) {
      const elapsed = this.COLOR_BLINDNESS_DURATION - this.colorBlindnessFrames;
      const colors = this.getColorBlindnessColors();
      const colorIndex = Math.floor(elapsed / 2) % colors.length;  // Change every 2 frames
      this.tintCtx.globalCompositeOperation = 'copy';
      this.tintCtx.drawImage(trails, 0, 0);
      this.tintCtx.globalCompositeOperation = 'source-in';
      this.tintCtx.fillStyle = colors[colorIndex]!;
      this.tintCtx.fillRect(0, 0, this.tintCanvas.width, this.tintCanvas.height);
      trails = this.tintCanvas;
    }
    this.ctx.drawImage(trails, 0, 0, PLAY_WIDTH, PLAY_HEIGHT);

    // Provisional trails (guest prediction): not part of the trail canvas
    if (overlayTrails) {
      // Without the shade: these pixels are replaced by confirmed trail within a few frames
      for (const { color, segments } of overlayTrails) {
        this.ctx.fillStyle = color;
        for (const seg of segments) this.ctx.fillRect(seg.x, seg.y, 1, 1);
      }
    }

    // Level doors cover the trails underneath
    if (this.doors.length > 0) this.drawDoors(doorFrame(round.doorTick ?? 0));

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
          playerState.slotIndex
        );
      }
    }

    // The dentist's hand goes over everything
    if (round.hand) this.drawHand(round.hand, round.players);

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
    this.renderStatusPanel(round.players, match.gameMode);

    // Draw overlays based on phase
    switch (round.phase) {
      case 'countdown':
        this.drawCountdownOverlay(round.countdown);
        break;
      case 'waiting_ready':
        this.drawWaitingReadyOverlay(match, round.roundWinner);
        break;
    }

    // Draw white flash overlay (bomb-on-bomb collision)
    if (this.whiteFlashFrames > 0) {
      let alpha: number;
      if (this.whiteFlashFrames > this.WHITE_FLASH_FADE) {
        // Solid phase (first 400ms)
        alpha = 1.0;
      } else {
        // Fade phase (remaining 4 seconds)
        alpha = this.whiteFlashFrames / this.WHITE_FLASH_FADE;
      }
      this.ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
      this.ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    }

    // Draw debug overlay (FPS + network stats)
    if (fps !== undefined) {
      this.ctx.font = '12px monospace';
      this.ctx.textAlign = 'left';
      this.ctx.textBaseline = 'top';

      // FPS with color coding
      this.ctx.fillStyle = fps < 60 ? '#f44' : fps < 68 ? '#ff0' : '#0f0';
      this.ctx.fillText(`${fps} FPS`, 4, 4);

      // Network stats (if available)
      if (networkStats) {
        const y = 18;
        // Format bitrates as KB/s
        const kbIn = (networkStats.bytesIn / 1024).toFixed(1);
        const kbOut = (networkStats.bytesOut / 1024).toFixed(1);

        // Lag with color coding (green < 50ms, yellow < 100ms, red >= 100ms)
        const lagColor = networkStats.lagMs < 50 ? '#0f0' : networkStats.lagMs < 100 ? '#ff0' : '#f44';
        this.ctx.fillStyle = lagColor;
        const predicted = networkStats.predictedTicks !== undefined ? `  Predicted: ${networkStats.predictedTicks} ticks` : '';
        this.ctx.fillText(`Lag: ${networkStats.lagMs}ms${predicted}`, 4, y);

        // Bitrate (cyan for data rates)
        this.ctx.fillStyle = '#0ff';
        this.ctx.fillText(`In: ${kbIn} KB/s  Out: ${kbOut} KB/s`, 4, y + 14);
      }
    }
  }

  // Full-screen text shown when there is no game state to draw yet
  /** A banner over the running game (e.g. the host went silent). */
  renderNotice(title: string, detail: string): void {
    const ctx = this.ctx;
    const midY = CANVAS_HEIGHT / 2;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.fillRect(0, midY - 50, PLAY_WIDTH, 100);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#f44';
    ctx.font = 'bold 24px monospace';
    ctx.fillText(title, PLAY_WIDTH / 2, midY - 14);
    ctx.fillStyle = '#ccc';
    ctx.font = '16px monospace';
    ctx.fillText(detail, PLAY_WIDTH / 2, midY + 18);
  }

  renderMessage(text: string): void {
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    this.ctx.fillStyle = '#0ff';
    this.ctx.font = 'bold 24px monospace';
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'middle';
    this.ctx.fillText(text, CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2);
  }

  // Add trail segments to the display bitmap
  addTrailSegments(slotIndex: SlotIndex, segments: TrailSegment[]): void {
    const player = this.players.find(p => p.slotIndex === slotIndex);
    if (!player) return;
    this.display.addTrail(segments, player.color);
  }

  // Add border segments (lock borders effect): they become part of the level, not trails
  addBorderSegments(color: string, segments: TrailSegment[]): void {
    this.display.addLevel(segments, color);
  }

  // Follows the players to draw the path each one really took
  private readonly paths = new PathTracker(PLAY_WIDTH, PLAY_HEIGHT);

  /**
   * Once per simulated frame while playing: the stretch each player moved goes on the
   * display as a smooth line over the hard trail pixels (design/display-layer.md).
   */
  addPaths(players: readonly TronPlayerState[]): void {
    this.paths.update(players, (slot, ax, ay, bx, by) => {
      const color = this.players.find(p => p.slotIndex === slot)?.color;
      if (color) this.display.addPath(ax, ay, bx, by, color);
    });
  }

  // Clear all trails and restore level (for new round)
  clearTrails(): void {
    this.paths.reset();
    this.ridiculousDeathSlots.clear();
    this.deathCauses.clear();
    this.colorBlindnessFrames = 0;
    this.whiteFlashFrames = 0;
    // Also removes lock borders and level damage
    this.restoreLevel();
  }

  // Restore level to original state (for eraser): no trails, undamaged level
  restoreLevel(): void {
    this.levelHidden = false;
    this.display.restoreLevel();
  }

  // Clear a rectangle (top-left x,y; wraps around edges) from trails and level
  clearRect(x: number, y: number, w: number, h: number): void {
    this.display.clearRect(x, y, w, h);
  }

  // Clear the pixels along lines (tracer paths; they wrap around edges), given as a flat
  // [x0, y0, x1, y1, ...]
  clearLines(lines: readonly number[]): void {
    for (let i = 0; i + 3 < lines.length; i += 4) {
      this.display.clearLine(lines[i]!, lines[i + 1]!, lines[i + 2]!, lines[i + 3]!);
    }
  }

  // Paint a whole arena (joining a game in progress). The level image stays hidden
  // until the next round / eraser: the snapshot already contains what is left of it.
  paintArena(arena: PixelGrid, smoothLines?: SmoothLinesData): void {
    this.levelHidden = true;
    const trailColors = new Set(this.players.map(p => p.color.toLowerCase()));
    this.display.paintSnapshot(arena, color => trailColors.has(color.toLowerCase()));
    this.display.loadSmoothLines(smoothLines);
  }

  // Remember why a player died, to show it on the round summary
  recordDeath(slotIndex: SlotIndex, cause: DeathCause, by?: number): void {
    this.deathCauses.set(slotIndex, { cause, by });
  }

  // Trigger ridiculous death display for a player
  triggerRidiculousDeath(slotIndex: SlotIndex): void {
    this.ridiculousDeathSlots.add(slotIndex);
  }

  // Update color blindness state from game state
  updateColorBlindness(frames: number): void {
    this.colorBlindnessFrames = frames;
  }

  // Update white flash state from game state
  updateWhiteFlash(frames: number): void {
    this.whiteFlashFrames = frames;
  }

  // Get color blindness color palette (all player colors regardless of game mode)
  private getColorBlindnessColors(): string[] {
    return [
      FFA_COLORS[0], FFA_COLORS[1], FFA_COLORS[2], FFA_COLORS[3],
      TEAM_COLORS.purple, TEAM_COLORS.brown
    ];
  }

  // Load a level background and return its obstacle pixels (every non-black pixel)
  async loadLevel(level: LevelDefinition): Promise<PixelGrid> {
    const img = new Image();
    img.src = level.imagePath;

    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error(`Failed to load level image: ${level.imagePath}`));
    });

    // Display-only background: never read for collisions
    this.lightBackground = !!level.lightBackground;
    this.backgroundImage = null;
    if (level.backgroundPath) {
      const background = new Image();
      background.src = level.backgroundPath;
      this.backgroundImage = background;
    }

    this.doors = level.doors ?? [];
    if (this.doors.length > 0 && !this.doorImage) {
      const doorImage = new Image();
      doorImage.src = `${import.meta.env.BASE_URL}assets/levels/doors.png`;
      this.doorImage = doorImage;
    }

    // The obstacles are the pixels of the file, decoded here. Reading them back from a
    // canvas is not exact everywhere: Safari adds noise to canvas read-backs, which put
    // stray obstacles on black ground (see png.ts)
    let obstacles: PixelGrid | null = null;
    try {
      const response = await fetch(level.imagePath);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const decoded = await decodePng(new Uint8Array(await response.arrayBuffer()));
      if (decoded.width !== PLAY_WIDTH || decoded.height !== PLAY_HEIGHT) throw new Error('unexpected size');
      obstacles = PixelGrid.fromRgba(decoded.rgba);
    } catch (error) {
      console.warn(`Level ${level.id}: reading obstacles from the canvas instead (${String(error)})`);
    }
    if (!obstacles || this.checkCanvasReadback) {
      const fromCanvas = this.obstaclesFromCanvas(img);
      if (obstacles) this.canvasReadbackDifference = obstacles.differenceFrom(fromCanvas);
      else obstacles = fromCanvas;
    }
    // The same grid is the collision bitmap of the level and the source of its display
    // cells (never a canvas read-back when the file can be decoded)
    this.display.setLevel(obstacles);
    // Not while a snapshot stands in for the level (it holds what is left of it)
    if (!this.levelHidden) this.display.restoreLevel(true);
    return obstacles;
  }

  /** `?perf=1`: also read the level back from a canvas and count how far off it is. */
  checkCanvasReadback = false;
  /** Pixels that are an obstacle in only one of file and canvas read-back (last level). */
  canvasReadbackDifference: number | null = null;

  // Fallback (no DecompressionStream, unusual PNG): the image as a canvas reports it
  private obstaclesFromCanvas(img: HTMLImageElement): PixelGrid {
    const scratch = document.createElement('canvas');
    scratch.width = PLAY_WIDTH;
    scratch.height = PLAY_HEIGHT;
    const scratchCtx = scratch.getContext('2d', { willReadFrequently: true })!;
    scratchCtx.drawImage(img, 0, 0, PLAY_WIDTH, PLAY_HEIGHT);
    return PixelGrid.fromRgba(scratchCtx.getImageData(0, 0, PLAY_WIDTH, PLAY_HEIGHT).data);
  }

  // The level's background image at the scale of the backing store (opaque), so that
  // drawing it every frame is a plain copy; null when the level has none (black)
  private backgroundLayer(): HTMLCanvasElement | null {
    const image = this.backgroundImage;
    if (!image || !image.complete || image.naturalWidth === 0) return null;
    const key = image.src;
    if (this.backgroundKey !== key || !this.backgroundCanvas) {
      const canvas = this.backgroundCanvas ?? document.createElement('canvas');
      canvas.width = PLAY_WIDTH;
      canvas.height = PLAY_HEIGHT;
      const ctx = canvas.getContext('2d', { alpha: false })!;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      this.backgroundCanvas = canvas;
      this.backgroundKey = key;
    }
    return this.backgroundCanvas;
  }

  // The dentist's hand hides what is under it, unless a player is there
  private drawHand(hand: HandView, players: TronPlayerState[]): void {
    if (!this.spriteAtlas?.isLoaded()) return;
    const ctx = this.ctx;
    const covering = players.some(p => p.alive && underHand(hand, Math.floor(p.x / 1000), Math.floor(p.y / 1000)));
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, PLAY_WIDTH, PLAY_HEIGHT);
    ctx.clip();
    if (covering) ctx.globalAlpha = 0.45;
    this.spriteAtlas.draw(ctx, 'dentist_hand', hand.x, hand.y, {
      anchorX: HAND_SPRITE.tipX / HAND_SPRITE.width,
      anchorY: HAND_SPRITE.tipY / HAND_SPRITE.height,
    });
    ctx.restore();
  }

  private drawDoors(frame: number): void {
    const img = this.doorImage;
    if (!img || !img.complete || img.naturalWidth === 0) return;
    const ctx = this.ctx;
    ctx.save();
    // Edge doors are half outside the play area
    ctx.beginPath();
    ctx.rect(0, 0, PLAY_WIDTH, PLAY_HEIGHT);
    ctx.clip();
    for (const door of this.doors) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.translate(door.x, door.y);
      if (door.vertical) ctx.transform(0, 1, 1, 0, 0, 0); // Swap axes: the sprite is symmetric
      ctx.drawImage(
        img, 0, frame * DOOR_THICKNESS, DOOR_LENGTH, DOOR_THICKNESS,
        -DOOR_LENGTH / 2, -DOOR_THICKNESS / 2, DOOR_LENGTH, DOOR_THICKNESS
      );
    }
    ctx.restore();
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
      this.drawTracer(x, y);
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

  // Tracer: a single white pixel (black on a light level, where white would not show)
  private drawTracer(x: number, y: number): void {
    this.ctx.fillStyle = this.lightBackground ? '#000' : '#fff';
    this.ctx.fillRect(x, y, 1, 1);
  }

  // Draw an explosion animation
  private drawExplosion(exp: Explosion): void {
    if (!this.spriteAtlas?.isLoaded()) return;

    const frameNum = String(exp.frame + 1).padStart(2, '0');
    const frameName = `explosion_${frameNum}`;

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

  // A head is a solid white pixel — the pixel the player is on — with a faint glow that
  // twinkles like a star: the four pixels beside it, fainter corners, and now and then a
  // glint one pixel further out. Two waves out of step (and different for each player)
  // keep it irregular. Not an obstacle. On a light level the glow is dark instead, so
  // that the white pixel shows on it.
  private drawPlayerHead(x: number, y: number, slot: number): void {
    const ctx = this.ctx;
    const t = performance.now() / 1000;
    const a = 0.5 + 0.5 * Math.sin(t * 5.3 + slot * 2.1);
    const b = 0.5 + 0.5 * Math.sin(t * 3.1 + slot * 3.7);
    const boost = this.lightBackground ? 1.6 : 1;
    const rgb = this.lightBackground ? '0, 0, 0' : '255, 255, 255';
    const beside = (0.2 + 0.25 * a) * boost;
    const corner = (0.04 + 0.1 * b) * boost;
    const glint = Math.max(0, a * b - 0.6) * 0.8 * boost;

    ctx.fillStyle = `rgba(${rgb}, ${beside.toFixed(3)})`;
    ctx.fillRect(x - 1, y, 1, 1);
    ctx.fillRect(x + 1, y, 1, 1);
    ctx.fillRect(x, y - 1, 1, 1);
    ctx.fillRect(x, y + 1, 1, 1);
    ctx.fillStyle = `rgba(${rgb}, ${corner.toFixed(3)})`;
    ctx.fillRect(x - 1, y - 1, 1, 1);
    ctx.fillRect(x + 1, y - 1, 1, 1);
    ctx.fillRect(x - 1, y + 1, 1, 1);
    ctx.fillRect(x + 1, y + 1, 1, 1);
    if (glint > 0) {
      ctx.fillStyle = `rgba(${rgb}, ${glint.toFixed(3)})`;
      ctx.fillRect(x - 2, y, 1, 1);
      ctx.fillRect(x + 2, y, 1, 1);
      ctx.fillRect(x, y - 2, 1, 1);
      ctx.fillRect(x, y + 2, 1, 1);
    }
    ctx.fillStyle = '#fff';
    ctx.fillRect(x, y, PLAYER_HEAD_SIZE, PLAYER_HEAD_SIZE);
  }

  // The status panel changes about once a second (the timers), so it is kept on its own
  // canvas and only redrawn when what it shows changes.
  private renderStatusPanel(playerStates: TronPlayerState[], gameMode: GameMode): void {
    const key = this.statusPanelKey(playerStates, gameMode);
    if (key !== this.sidebarKey) {
      this.sidebarKey = key;
      this.sidebarCtx.clearRect(0, 0, STATUS_WIDTH, CANVAS_HEIGHT);
      this.drawStatusPanel(this.sidebarCtx, playerStates, gameMode);
    }
    this.ctx.drawImage(this.sidebarCanvas, PLAY_WIDTH, 0);
  }

  // Everything the status panel shows, as a string
  private statusPanelKey(playerStates: TronPlayerState[], gameMode: GameMode): string {
    let key = `${this.spriteAtlas?.isLoaded() ? 1 : 0}${gameMode}`;
    for (let i = 0; i < 4; i++) {
      const slotIndex = i as SlotIndex;
      const state = playerStates.find(p => p.slotIndex === slotIndex);
      if (!state || !this.players.some(p => p.slotIndex === slotIndex)) {
        key += '|-';
        continue;
      }
      key += `|${state.alive ? 1 : 0}${this.ridiculousDeathSlots.has(slotIndex) ? 'r' : ''}`;
      const effect = state.activeEffects?.[0];
      if (effect) key += `,${effect.sprite}:${Math.ceil(effect.remainingFrames / TICK_RATE)}`;
      const weapon = state.equippedWeapon;
      if (weapon) {
        key += `,${weapon.sprite}:${weapon.remainingFrames !== undefined ? Math.ceil(weapon.remainingFrames / TICK_RATE) : weapon.ammo}`;
      }
    }
    return key;
  }

  private drawStatusPanel(ctx: CanvasRenderingContext2D, playerStates: TronPlayerState[], gameMode: GameMode): void {
    const panelX = 0;
    const slotHeight = CANVAS_HEIGHT / 4;

    // Draw sidebar background sprite (50x600, covers all 4 slots)
    if (this.spriteAtlas?.isLoaded()) {
      this.spriteAtlas.draw(
        ctx,
        // Team colours in team mode (design/teams.md)
        gameMode === 'team' ? 'sidebar_team' : 'sidebar',
        panelX + STATUS_WIDTH / 2,
        CANVAS_HEIGHT / 2
      );
    }

    for (let i = 0; i < 4; i++) {
      const y = i * slotHeight;
      const slotIndex = i as SlotIndex;
      const player = this.players.find(p => p.slotIndex === slotIndex);
      const playerState = playerStates.find(p => p.slotIndex === slotIndex);

      // The panel of a dead player, or of a slot nobody plays in, is grey
      const desaturation = player && playerState?.alive ? 0 : 1;
      if (desaturation > 0) {
        ctx.save();
        ctx.globalCompositeOperation = 'saturation';
        ctx.globalAlpha = desaturation;
        ctx.fillStyle = '#808080';
        ctx.fillRect(panelX, y, STATUS_WIDTH, slotHeight);
        ctx.restore();
      }

      if (player && playerState) {
        const centerX = panelX + STATUS_WIDTH / 2;

        // Check if ridiculous death should be shown (overrides other displays)
        if (this.ridiculousDeathSlots.has(slotIndex) && this.spriteAtlas?.isLoaded()) {
          // Draw ridiculous death sprite covering the slot (50x150)
          this.spriteAtlas.draw(
            ctx,
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
              ctx,
              effect.sprite + '_sidebar',
              centerX,
              y + slotHeight * 0.25
            );
            // Draw remaining seconds below icon in black
            const remainingSecs = Math.ceil(effect.remainingFrames / TICK_RATE);
            ctx.fillStyle = '#000';
            ctx.font = 'bold 14px monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText(`${remainingSecs}s`, centerX, y + slotHeight * 0.25 + 22);
          }
        }

        // Draw equipped weapon icon and ammo (bottom half)
        if (hasWeapon && playerState.equippedWeapon && this.spriteAtlas?.isLoaded()) {
          // Draw weapon sidebar icon (uses _sidebar sprite)
          this.spriteAtlas.draw(
            ctx,
            playerState.equippedWeapon.sprite + '_sidebar',
            centerX,
            y + slotHeight * 0.75
          );
          // Draw ammo/time below icon in black
          const { ammo, remainingFrames } = playerState.equippedWeapon;
          if (remainingFrames !== undefined) {
            // Time-based weapon: show seconds
            ctx.fillStyle = '#000';
            ctx.font = 'bold 14px monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText(`${Math.ceil(remainingFrames / TICK_RATE)}s`, centerX, y + slotHeight * 0.75 + 22);
          } else if (ammo !== undefined && ammo > 1) {
            // Shot-based weapon: show ammo count (skip single-use)
            ctx.fillStyle = '#000';
            ctx.font = 'bold 14px monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText(String(ammo), centerX, y + slotHeight * 0.75 + 22);
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

  private drawWaitingReadyOverlay(match: TronMatchState, roundWinner: SlotIndex | 'draw' | null): void {
    // Lighter overlay
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    this.ctx.fillRect(0, 0, PLAY_WIDTH, CANVAS_HEIGHT);

    // Title - show round number
    this.ctx.fillStyle = '#0ff';
    this.ctx.font = 'bold 36px monospace';
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'middle';
    const title = match.currentRound > 1 ? `ROUND ${match.currentRound}` : 'GET READY';
    const team = match.gameMode === 'team';
    // In team mode the team scores are the headline, and the table moves down
    const shift = team ? 35 : 0;
    this.ctx.fillText(title, PLAY_WIDTH / 2, CANVAS_HEIGHT / 2 - 100 - shift);
    const teamScores = [0, 1].map(t =>
      this.players.reduce((sum, p) => sum + (p.slotIndex % 2 === t ? match.scores[p.slotIndex] || 0 : 0), 0));
    if (team) this.drawTeamScores(teamScores, roundWinner, CANVAS_HEIGHT / 2 - 45 - shift);

    // Column positions - more room for nicknames
    const winsX = PLAY_WIDTH / 2 - 200;
    const mrX = PLAY_WIDTH / 2 - 160;
    const nicknameX = PLAY_WIDTH / 2 - 120;
    const statusX = PLAY_WIDTH / 2 + 140;
    const maxNicknameWidth = 240; // More width for nicknames

    // Headers
    this.ctx.fillStyle = '#888';
    this.ctx.font = 'bold 14px monospace';
    this.ctx.textBaseline = 'alphabetic';
    const headerY = CANVAS_HEIGHT / 2 - 55 + shift;
    this.ctx.textAlign = 'right';
    this.ctx.fillText('Wins', winsX, headerY);
    this.ctx.fillText('MR', mrX, headerY);
    this.ctx.textAlign = 'left';
    this.ctx.fillText('Player', nicknameX, headerY);

    // Player scores and ready status
    const startY = CANVAS_HEIGHT / 2 - 30 + shift;

    // Determine winner for emoji display (in team mode, winning team members get trophy)
    const isWinner = (slotIndex: SlotIndex): boolean => {
      if (roundWinner === null || roundWinner === 'draw') return false;
      if (match.gameMode === 'team') {
        return slotIndex % 2 === roundWinner % 2;
      }
      return slotIndex === roundWinner;
    };

    // Sort players by score (descending), then by ridiculous deaths (ascending) to break ties
    // In team mode: grouped by team, the leading team first
    const sortedPlayers = [...this.players].sort((a, b) => {
      if (team && a.slotIndex % 2 !== b.slotIndex % 2) {
        const lead = teamScores[b.slotIndex % 2]! - teamScores[a.slotIndex % 2]!;
        return lead !== 0 ? lead : (a.slotIndex % 2) - (b.slotIndex % 2);
      }
      const scoreA = match.scores[a.slotIndex] || 0;
      const scoreB = match.scores[b.slotIndex] || 0;
      if (scoreB !== scoreA) return scoreB - scoreA;
      // Fewer ridiculous deaths is better
      const mrA = match.ridiculousDeath?.[a.slotIndex] || 0;
      const mrB = match.ridiculousDeath?.[b.slotIndex] || 0;
      return mrA - mrB;
    });

    sortedPlayers.forEach((player, i) => {
      const isReady = match.playersReady.includes(player.slotIndex);
      const score = match.scores[player.slotIndex] || 0;
      const mr = match.ridiculousDeath?.[player.slotIndex] || 0;
      const y = startY + i * 35;
      const won = isWinner(player.slotIndex);

      // Wins (score)
      this.ctx.fillStyle = '#ff0';
      this.ctx.font = 'bold 20px monospace';
      this.ctx.textAlign = 'right';
      this.ctx.fillText(String(score), winsX, y);

      // MR count
      this.ctx.fillStyle = mr > 0 ? '#f44' : '#666';
      this.ctx.fillText(String(mr), mrX, y);

      // Nickname with win/lose emoji (truncated with ellipsis if too long)
      this.ctx.fillStyle = player.color;
      this.ctx.font = '20px monospace';
      this.ctx.textAlign = 'left';

      // Add emoji prefix if there was a round result
      const emoji = roundWinner !== null ? (won ? '🏆 ' : '💀 ') : '';
      let nickname = emoji + player.nickname;
      while (this.ctx.measureText(nickname).width > maxNicknameWidth && nickname.length > emoji.length + 3) {
        nickname = nickname.slice(0, -1);
      }
      if (nickname !== emoji + player.nickname) {
        nickname = nickname.slice(0, -2) + '…';
      }
      this.ctx.fillText(nickname, nicknameX, y);

      // How the player died this round and who did it, under the name itself (the
      // emoji in front of it is not the same width everywhere)
      const death = this.deathCauses.get(player.slotIndex);
      if (death && roundWinner !== null) {
        const killer = death.by === undefined ? null
          : this.players.find(p => p.slotIndex === death.by)?.nickname ?? null;
        const label = describeDeath(death.cause, killer, death.by === player.slotIndex, death.by === NO_OWNER);
        const indent = this.ctx.measureText(emoji).width;
        this.ctx.fillStyle = '#777';
        this.ctx.font = '11px monospace';
        this.ctx.fillText(label, nicknameX + indent, y + 13);
        this.ctx.font = '20px monospace';
      }

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

  // The headline between rounds of a team game: PURPLE 5 : 3 BROWN
  private drawTeamScores(scores: number[], roundWinner: SlotIndex | 'draw' | null, y: number): void {
    const centerX = PLAY_WIDTH / 2;
    const won = (t: number): boolean => roundWinner !== null && roundWinner !== 'draw' && roundWinner % 2 === t;
    this.ctx.save();
    this.ctx.textBaseline = 'middle';
    this.ctx.font = 'bold 40px monospace';
    this.ctx.textAlign = 'center';
    this.ctx.fillStyle = '#888';
    this.ctx.fillText(':', centerX, y - 3);

    const sides = [
      { t: 0, align: 'right' as const, dir: -1 },
      { t: 1, align: 'left' as const, dir: 1 },
    ];
    for (const { t, align, dir } of sides) {
      const color = getSlotColor('team', t as SlotIndex);
      this.ctx.textAlign = align;
      this.ctx.shadowColor = color;
      this.ctx.shadowBlur = 12;
      this.ctx.fillStyle = '#fff';
      this.ctx.font = 'bold 44px monospace';
      this.ctx.fillText(String(scores[t] ?? 0), centerX + dir * 24, y);
      this.ctx.shadowBlur = 0;
      this.ctx.fillStyle = color;
      this.ctx.font = 'bold 22px monospace';
      const name = getSlotColorName('team', t as SlotIndex).toUpperCase();
      const label = won(t) ? (dir < 0 ? `🏆 ${name}` : `${name} 🏆`) : name;
      this.ctx.fillText(label, centerX + dir * 90, y);
    }
    this.ctx.restore();
  }

  // Clean up
  destroy(): void {
    window.removeEventListener('resize', this.resizeHandler);
    this.canvas.remove();
  }
}
