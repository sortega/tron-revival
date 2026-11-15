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
import {
  DISPLAY_STORAGE_KEY, FX, HEAD_VARIANTS, SHADE_VARIANTS,
  formatDisplaySettings, haloFor, nextOf, parseDisplaySettings, resolveDisplay, styleFor,
} from './display/settings';
import type { DisplayEnv, DisplaySettings } from './display/settings';
import { bandColor, cssOf, fringeWidth, packCss, trailColor } from './display/shade';
import type { ShadeStyle } from './display/shade';
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
const FADE_FRAMES = 12;
const TEST_CARD_ROWS = [4, 6, 12, 18, 24, 30];   // Top of each wavy trail of the test card

export class TronRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  // Display bitmap of the arena (trails, walls) and the layers derived from it; kept
  // apart from the collision bitmap (design/display-layer.md)
  private readonly layers: CanvasLayerSink;
  private readonly display: ArenaDisplay;
  private settings: DisplaySettings;
  private style: ShadeStyle;
  // What the settings are applied to: how big the arena is on screen, light level or not
  private env: DisplayEnv = { cssPerLogical: 1, lightBackground: false };
  private halo: readonly number[] = [];   // Opacity of each ring of the heads' halo
  // Core and fringe colours per trail colour in the current style (provisional trails)
  private overlayCss = new Map<string, { core: string; bands: string[] }>();
  private chips: HTMLElement | null = null;   // `?displaydebug=1`: on-screen switches
  /** Called when the picture changed without a simulation step (a setting was switched). */
  onInvalidate: (() => void) | null = null;
  private perfSync = false;
  private scale = 1;  // Backing-store pixels per logical pixel
  private backgroundImage: HTMLImageElement | null = null;  // Display only, never a wall
  private backgroundCanvas: HTMLCanvasElement | null = null;  // The image at the display scale
  private backgroundKey = '';
  private levelHidden = false;  // True while a snapshot stands in for the level image
  private fades: { x: number; y: number; w: number; h: number; frames: number }[] = [];
  private settingsNotice: { text: string; frames: number } | null = null;
  private readonly displayKeyHandler: (e: KeyboardEvent) => void;
  private testCard: { x: number; y: number } | null = null;
  private renderTimes = new Float32Array(600);
  private renderCount = 0;

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

    this.tintCanvas = document.createElement('canvas');
    this.tintCtx = this.tintCanvas.getContext('2d')!;

    this.sidebarCanvas = document.createElement('canvas');
    this.sidebarCanvas.width = STATUS_WIDTH;
    this.sidebarCanvas.height = CANVAS_HEIGHT;
    this.sidebarCtx = this.sidebarCanvas.getContext('2d')!;
    this.sidebarCtx.imageSmoothingEnabled = false;  // Like the main canvas

    let stored: string | null = null;
    try { stored = localStorage.getItem(DISPLAY_STORAGE_KEY); } catch { /* private mode */ }
    this.settings = parseDisplaySettings(window.location.search, stored);
    this.layers = new CanvasLayerSink();
    this.env = this.measureEnv(false);
    this.style = styleFor(this.settings, this.env);
    this.display = new ArenaDisplay(PLAY_WIDTH, PLAY_HEIGHT, this.layers, this.style);
    this.applyDisplaySettings(this.settings, false);

    // A/B switching: 1 = trail shade, 2 = head halo, 3 = extras; with `?displaydebug=1`
    // also on-screen chips, for devices without a keyboard
    this.displayKeyHandler = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === 'Digit1') this.cycleDisplay('shade');
      else if (e.code === 'Digit2') this.cycleDisplay('head');
      else if (e.code === 'Digit3') this.cycleDisplay('fx');
    };
    document.addEventListener('keydown', this.displayKeyHandler);
    if (new URLSearchParams(window.location.search).has('displaydebug')) this.createChips();
    // Debug / measurement hook
    (window as unknown as { __teratronDisplay?: unknown }).__teratronDisplay = {
      get: () => formatDisplaySettings(this.settings),
      set: (spec: string) => this.applyDisplaySettings(parseDisplaySettings(spec, formatDisplaySettings(this.settings)), false),
      testCard: (x: number, y: number) => this.drawTestCard(x, y),
      perf: () => this.renderPerf(),
      resetPerf: () => { this.renderCount = 0; },
      layers: () => ({ level: this.layers.levelCanvas, trail: this.layers.trailCanvas }),
      // Make render() wait for the canvas to be rasterised, so that its time includes it
      sync: (on: boolean) => { this.perfSync = on; },
      // Cost of re-deriving both layers for the whole arena (round start, Eraser), in ms
      rederive: () => {
        const start = performance.now();
        this.display.setStyle(styleFor(this.settings, this.env));
        this.display.flush();
        return performance.now() - start;
      },
    };

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

  // How big a logical pixel is on screen (CSS pixels), and whether the level is light
  private measureEnv(lightBackground: boolean): DisplayEnv {
    const rect = this.canvas.getBoundingClientRect();
    let cssPerLogical = Math.min(rect.width / CANVAS_WIDTH, rect.height / CANVAS_HEIGHT);
    // Not laid out yet: what the canvas will get at most
    if (!(cssPerLogical > 0)) cssPerLogical = Math.min(window.innerWidth / CANVAS_WIDTH, window.innerHeight / CANVAS_HEIGHT);
    return { cssPerLogical, lightBackground };
  }

  private cycleDisplay(what: 'shade' | 'head' | 'fx'): void {
    const s = this.settings;
    if (what === 'shade') this.applyDisplaySettings({ ...s, shade: nextOf(SHADE_VARIANTS, s.shade) });
    else if (what === 'head') this.applyDisplaySettings({ ...s, head: nextOf(HEAD_VARIANTS, s.head) });
    else {
      // Extras: the default pair → none → each of the pair alone → all
      const options: DisplaySettings['fx'][] = [['tracer', 'boost'], [], ['tracer'], ['boost'], [...FX]];
      const current = options.findIndex(o => o.join() === s.fx.join());
      this.applyDisplaySettings({ ...s, fx: options[(current + 1) % options.length]! });
    }
  }

  // Switch trail shade / head halo / extras; the display bitmap is kept and re-derived
  applyDisplaySettings(settings: DisplaySettings, announce = true): void {
    this.settings = settings;
    const style = styleFor(settings, this.env);
    this.style = style;
    this.halo = haloFor(resolveDisplay(settings, this.env).head);
    this.overlayCss.clear();
    this.scale = style.scale;
    if (this.canvas.width !== CANVAS_WIDTH * this.scale) {
      this.canvas.width = CANVAS_WIDTH * this.scale;    // Resets the context state
      this.canvas.height = CANVAS_HEIGHT * this.scale;
      this.tintCanvas.width = PLAY_WIDTH * this.scale;
      this.tintCanvas.height = PLAY_HEIGHT * this.scale;
    }
    this.ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
    this.display.setStyle(style);
    this.updatePixelation();
    this.renderCount = 0;
    this.updateChips();
    this.onInvalidate?.();
    if (announce) {
      this.settingsNotice = { text: this.describeDisplay(), frames: 90 };
      try { localStorage.setItem(DISPLAY_STORAGE_KEY, formatDisplaySettings(settings)); } catch { /* private mode */ }
    }
  }

  // "trail auto→bold  head auto→soft  fx tracer,boost"
  private describeDisplay(): string {
    const s = this.settings;
    const r = resolveDisplay(s, this.env);
    const shown = (asked: string, got: string): string => (asked === got ? asked : `${asked}→${got}`);
    return `trail ${shown(s.shade, r.shade)}  head ${shown(s.head, r.head)}  fx ${s.fx.join(',') || 'none'}`;
  }

  // The screen changed (rotation, window resize, another level): `auto` may now stand for
  // something else, and a 2× picture may need smoothing or not
  private followScreen(): void {
    const env = this.measureEnv(this.env.lightBackground);
    const before = resolveDisplay(this.settings, this.env);
    const after = resolveDisplay(this.settings, env);
    this.env = env;
    if (before.shade !== after.shade || before.head !== after.head) this.applyDisplaySettings(this.settings, false);
    else this.updatePixelation();
  }

  // `?displaydebug=1`: three tappable chips in the corner, outside the arena on a phone
  private createChips(): void {
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;right:6px;top:50%;transform:translateY(-50%);z-index:1000;'
      + 'display:flex;flex-direction:column;gap:6px;align-items:flex-end;touch-action:manipulation;';
    for (const what of ['shade', 'head', 'fx'] as const) {
      const chip = document.createElement('button');
      chip.dataset.display = what;
      chip.style.cssText = 'font:11px monospace;padding:6px 8px;min-width:76px;color:#0ff;background:rgba(0,16,32,0.85);'
        + 'border:1px solid #0ff;border-radius:10px;text-align:left;white-space:pre;';
      const cycle = (e: Event): void => {
        e.preventDefault();
        e.stopPropagation();
        this.cycleDisplay(what);
      };
      chip.addEventListener('click', cycle);
      // Keep the touch away from the game's own controls underneath
      for (const type of ['touchstart', 'touchend', 'pointerdown'] as const) {
        chip.addEventListener(type, e => e.stopPropagation());
      }
      box.appendChild(chip);
    }
    document.body.appendChild(box);
    this.chips = box;
    this.updateChips();
  }

  private updateChips(): void {
    if (!this.chips) return;
    const s = this.settings;
    const r = resolveDisplay(s, this.env);
    const text: Record<string, string> = {
      shade: `trail\n${s.shade === r.shade ? s.shade : `${s.shade}→${r.shade}`}`,
      head: `head\n${s.head === r.head ? s.head : `${s.head}→${r.head}`}`,
      fx: `fx\n${s.fx.join('\n') || 'none'}`,
    };
    for (const chip of Array.from(this.chips.children) as HTMLElement[]) {
      chip.textContent = text[chip.dataset.display ?? ''] ?? '';
    }
  }

  // A 2× backing store shown on fewer device pixels than it has (a desktop window at
  // DPR 1) must be smoothed: nearest-neighbour would drop sub-pixels at random. Shown
  // 1:1 or enlarged it stays pixelated, like the 1× picture always is.
  private updatePixelation(): void {
    let pixelated = true;
    if (this.scale > 1) {
      const devicePerLogical = this.env.cssPerLogical * (window.devicePixelRatio || 1);
      pixelated = devicePerLogical >= this.scale * 0.9;
    }
    const value = pixelated ? 'pixelated' : 'auto';
    if (this.canvas.style.imageRendering !== value) this.canvas.style.imageRendering = value;
  }

  /**
   * Comparison aid (tools/display-lab.mjs): a fixed 76×40 pattern at (ox, oy). Left: wavy
   * trails in the six player colours (red and green one free pixel apart), a crossing and
   * a hole erased through them, with heads. Right: pairs of straight trails with 1, 2 and
   * 3 free pixels between them, a lone head and two tracers. Display only: the collision
   * bitmap knows nothing about it.
   */
  private drawTestCard(ox: number, oy: number): void {
    const colors = [FFA_COLORS[0], FFA_COLORS[1], FFA_COLORS[2], FFA_COLORS[3], TEAM_COLORS.purple, TEAM_COLORS.brown];
    TEST_CARD_ROWS.forEach((row, i) => {
      const points = [];
      for (let x = 0; x < 40; x++) points.push({ x: ox + x, y: oy + row + Math.floor(x / 9) });
      this.display.addTrail(points, colors[i]!);
    });
    const crossing = [];
    for (let i = 0; i < 36; i++) crossing.push({ x: ox + 10 + Math.floor(i / 6), y: oy + 1 + i });
    this.display.addTrail(crossing, colors[0]!);
    this.display.clearRect(ox + 22, oy + 2, 6, 14);
    for (const y of [4, 6, 13, 16, 24, 28]) {
      const points = [];
      for (let x = 48; x < 74; x++) points.push({ x: ox + x, y: oy + y });
      this.display.addTrail(points, colors[1]!);
    }
    this.testCard = { x: ox, y: oy };
    this.onInvalidate?.();
  }

  /** Time spent in render() over the last frames (ms). */
  private renderPerf(): { frames: number; avg: number; p95: number; max: number } {
    const n = Math.min(this.renderCount, this.renderTimes.length);
    if (n === 0) return { frames: 0, avg: 0, p95: 0, max: 0 };
    const sorted = Array.from(this.renderTimes.subarray(0, n)).sort((a, b) => a - b);
    const round = (v: number): number => Math.round(v * 1000) / 1000;
    return {
      frames: this.renderCount,
      avg: round(sorted.reduce((a, b) => a + b, 0) / n),
      p95: round(sorted[Math.floor(n * 0.95)]!),
      max: round(sorted[n - 1]!),
    };
  }

  // Main render function
  render(
    round: TronRoundState, match: TronMatchState, fps?: number, networkStats?: NetworkStats,
    overlayTrails?: { color: string; segments: TrailSegment[] }[]
  ): void {
    const renderStart = performance.now();
    if (this.renderCount % 30 === 0) this.followScreen();

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

    // Erased areas flash and fade
    if (this.fades.length > 0) {
      for (const fade of this.fades) {
        this.ctx.fillStyle = `rgba(255, 255, 255, ${0.3 * fade.frames / FADE_FRAMES})`;
        this.ctx.fillRect(fade.x, fade.y, fade.w, fade.h);
        fade.frames--;
      }
      this.fades = this.fades.filter(f => f.frames > 0);
    }

    // Provisional trails (guest prediction): not part of the trail canvas
    if (overlayTrails) {
      // Same shade as confirmed trail (approximately: it is not clipped by what is around)
      const style = this.style;
      for (const { color, segments } of overlayTrails) {
        let css = this.overlayCss.get(color);
        if (!css) {
          const core = trailColor(style, packCss(color));
          css = { core: cssOf(core), bands: style.bands.map(band => cssOf(bandColor(band, core))) };
          this.overlayCss.set(color, css);
        }
        let reach = fringeWidth(style) / style.scale;
        for (let b = style.bands.length - 1; b >= 0; b--) {
          this.ctx.fillStyle = css.bands[b]!;
          for (const seg of segments) this.ctx.fillRect(seg.x - reach, seg.y - reach, 1 + 2 * reach, 1 + 2 * reach);
          reach -= style.bands[b]!.width / style.scale;
        }
        this.ctx.fillStyle = css.core;
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
          Math.floor(playerState.y / 1000)
        );
      }
    }

    if (this.testCard) {
      const { x, y } = this.testCard;
      for (const row of TEST_CARD_ROWS) this.drawPlayerHead(x + 40, y + row + 4);
      this.drawPlayerHead(x + 54, y + 35);
      this.drawTracer(x + 64, y + 33, 0);
      this.drawTracer(x + 70, y + 37, 135);
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

    // The display setting just selected (keys 1/2/3)
    if (this.settingsNotice) {
      this.ctx.font = '12px monospace';
      this.ctx.textAlign = 'right';
      this.ctx.textBaseline = 'top';
      this.ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
      this.ctx.fillRect(PLAY_WIDTH - 360, 0, 360, 18);
      this.ctx.fillStyle = '#0ff';
      this.ctx.fillText(this.settingsNotice.text, PLAY_WIDTH - 4, 4);
      if (--this.settingsNotice.frames <= 0) this.settingsNotice = null;
    }

    if (this.perfSync) this.ctx.getImageData(0, 0, 1, 1);
    this.renderTimes[this.renderCount++ % this.renderTimes.length] = performance.now() - renderStart;

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

  // Clear all trails and restore level (for new round)
  clearTrails(): void {
    this.ridiculousDeathSlots.clear();
    this.deathCauses.clear();
    this.colorBlindnessFrames = 0;
    this.whiteFlashFrames = 0;
    this.fades = [];
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
    if (this.settings.fx.includes('fade') && this.fades.length < 400) {
      this.fades.push({ x, y, w, h, frames: FADE_FRAMES });
    }
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
  paintArena(arena: PixelGrid): void {
    this.levelHidden = true;
    const trailColors = new Set(this.players.map(p => p.color.toLowerCase()));
    this.display.paintSnapshot(arena, color => trailColors.has(color.toLowerCase()));
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
    if (this.env.lightBackground !== !!level.lightBackground) {
      this.env = this.measureEnv(!!level.lightBackground);
      this.applyDisplaySettings(this.settings, false);
    }
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
    const key = `${image.src}@${this.scale}`;
    if (this.backgroundKey !== key || !this.backgroundCanvas) {
      const canvas = this.backgroundCanvas ?? document.createElement('canvas');
      canvas.width = PLAY_WIDTH * this.scale;
      canvas.height = PLAY_HEIGHT * this.scale;
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
      ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
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
      this.drawTracer(x, y, proj.direction);
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

  // Tracer: a single white pixel; with the `tracer` extra, a short fading streak behind it
  // (unlike a head, which has a halo all around)
  private drawTracer(x: number, y: number, direction: number): void {
    const ctx = this.ctx;
    const light = this.env.lightBackground;
    if (this.settings.fx.includes('tracer')) {
      const rad = (direction * Math.PI) / 180;
      const dx = Math.cos(rad);
      const dy = Math.sin(rad);
      const alphas = light ? [0.8, 0.5, 0.25] : [0.6, 0.35, 0.15];
      for (let i = 0; i < alphas.length; i++) {
        ctx.fillStyle = light ? `rgba(0, 0, 0, ${alphas[i]})` : `rgba(255, 255, 255, ${alphas[i]})`;
        ctx.fillRect(Math.round(x - dx * (i + 1)), Math.round(y - dy * (i + 1)), 1, 1);
      }
    }
    // On a light level white would not show
    ctx.fillStyle = light ? '#000' : '#fff';
    ctx.fillRect(x, y, 1, 1);
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

  // A head is a solid white pixel — the logical pixel the player is on — with a white,
  // transparent halo around it: rings of squares (corners cut from the second on), each
  // adding its opacity. Not an obstacle. On a light level the halo is dark instead, so
  // that the white pixel shows on it.
  private drawPlayerHead(x: number, y: number): void {
    const ctx = this.ctx;
    const light = this.env.lightBackground;
    const halo = this.halo;
    for (let ring = halo.length; ring >= 1; ring--) {
      const alpha = Math.min(0.9, halo[ring - 1]! * (light ? 1.5 : 1));
      ctx.fillStyle = light ? `rgba(0, 0, 0, ${alpha})` : `rgba(255, 255, 255, ${alpha})`;
      if (ring === 1) {
        ctx.fillRect(x - 1, y - 1, 3, 3);
      } else {
        ctx.fillRect(x - ring, y - ring + 1, 2 * ring + 1, 2 * ring - 1);
        ctx.fillRect(x - ring + 1, y - ring, 2 * ring - 1, 1);
        ctx.fillRect(x - ring + 1, y + ring, 2 * ring - 1, 1);
      }
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
    document.removeEventListener('keydown', this.displayKeyHandler);
    this.chips?.remove();
    this.canvas.remove();
  }
}
