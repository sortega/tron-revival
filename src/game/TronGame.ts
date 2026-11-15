// TronGame - Game screen: layout, input, rendering, sound.
// All game logic lives behind the GameSession it is given.

import type { GameScreenOptions, Screen, ScreenManager } from '../screens/ScreenManager';
import type { GameConfig, TronGameStateData, SoundEvent, RoundPhase } from '../types/game';
import type { SlotIndex } from '../types/lobby';
import { LEVELS } from '../types/game';
import { TICK_RATE } from './constants';
import { TronRenderer } from './TronRenderer';
import { InputManager, isTouchDevice, isIOS } from './input/InputManager';
import { CONTROL_SCHEMES } from './input/controlSchemes';
import type { InputBinding } from './input/InputManager';
import { getSoundManager, type SoundName } from './SoundManager';
import { Ticker } from './Ticker';
import type { GameSession } from './session/GameSession';
import { HOST_SILENCE_MS } from './session/GameSession';
import { escapeHtml } from '../util/html';
import { perfCounter, perfDump, perfEnable, perfEnd, perfSince, perfStart } from './perf';
import type { PerfSummary } from './perf';
import { TerritoryOverlay } from './ai/TerritoryOverlay';
import type { TronGameState } from './TronGameState';

export class TronGame implements Screen {
  private container: HTMLElement;
  private screenManager: ScreenManager;
  private config: GameConfig;
  private session: GameSession;
  private options: GameScreenOptions;

  private renderer: TronRenderer | null = null;
  private input: InputManager | null = null;
  private ticker: Ticker | null = null;

  // Steps-per-second tracking for the debug display
  private stepTimes: number[] = [];
  private currentFps: number = TICK_RATE;
  private lastFpsUpdate: number = 0;
  private showFps: boolean = localStorage.getItem('showFps') === 'true';
  private fpsKeyHandler: ((e: KeyboardEvent) => void) | null = null;

  // `?perf=1`: on-screen readout of the phase timers, for devices without a console
  private perfHud: HTMLElement | null = null;
  private perfHudTimer: ReturnType<typeof setInterval> | null = null;

  // Double-tap detection for mobile FPS toggle
  private lastTapTime: number = 0;

  // `?botdebug=...`: the bots' territory map over the arena
  private botDebug: TerritoryOverlay | null = TerritoryOverlay.fromUrl(location.search);

  // Track loaded level to detect changes
  private loadedLevelIndex: number = -1;
  private levelLoading: boolean = false;

  // Something that is drawn changed since the last display frame. The simulation ticks
  // 70 times a second; on a 90 or 120 Hz screen the frames in between would redraw the
  // very same picture.
  private dirty = true;

  // Track previous round phase to detect transitions and stop sound loops
  private previousPhase: RoundPhase | null = null;

  constructor(
    container: HTMLElement,
    screenManager: ScreenManager,
    config: GameConfig,
    session: GameSession,
    options: GameScreenOptions = {}
  ) {
    this.options = options;
    this.container = container;
    this.screenManager = screenManager;
    this.config = config;
    this.session = session;
  }

  private localBindings(): InputBinding[] {
    const bindings: InputBinding[] = [];
    for (const player of this.config.players) {
      if (player.control.type === 'local') {
        bindings.push({ slot: player.slotIndex, scheme: player.control.scheme });
      }
    }
    return bindings;
  }

  // Direction of a player that can be steered right now (for heading-based touch modes)
  private steerableHeading(slot: SlotIndex): number | null {
    const view = this.session.getViewState();
    if (!view || view.round.phase !== 'playing') return null;
    const player = view.round.players.find(p => p.slotIndex === slot);
    return player?.alive ? player.direction : null;
  }

  // One line per local human describing their keys
  private controlsHint(): string {
    const humans = this.config.players.filter(p => p.control.type === 'local');
    if (humans.length === 0) return '<div>Spectating</div>';
    return humans.map(p => {
      const scheme = p.control.type === 'local' ? CONTROL_SCHEMES[p.control.scheme] : null;
      const name = humans.length > 1 ? `<span style="color: ${p.color};">${escapeHtml(p.nickname)}</span>: ` : '';
      return `<div>${name}${scheme?.label ?? ''}</div>`;
    }).join('');
  }

  render(): void {
    const isTouch = isTouchDevice();

    if (isTouch) {
      this.renderMobileLayout();
    } else {
      this.renderDesktopLayout();
    }

    const bindings = this.localBindings();
    this.input = new InputManager(bindings);

    // Touch controls drive the first local human
    if (isTouch && bindings[0]) {
      const steerZone = document.getElementById('steerZone');
      const actionButton = document.getElementById('actionButton');
      if (steerZone && actionButton) {
        const slot = bindings[0].slot;
        this.input.initTouchControls(
          slot, steerZone, actionButton, document.getElementById('touchModeBtn'),
          () => this.steerableHeading(slot),
        );
      }
    }

    this.session.onFrame = (frame) => this.applyFrameEvents(frame);
    this.session.onSnapshot = (arena, smoothLines) => this.renderer?.paintArena(arena, smoothLines);
    this.session.onEnded = (reason) => {
      this.screenManager.showMainMenu(reason);
    };

    document.getElementById('backBtn')?.addEventListener('click', () => {
      this.options.onLeave?.();
      this.screenManager.showMainMenu();
    });
    document.getElementById('lobbyBtn')?.addEventListener('click', () => {
      this.options.onBackToLobby?.();
    });

    // Mute button
    document.getElementById('muteBtn')?.addEventListener('click', () => {
      const sound = getSoundManager();
      const isMuted = sound.toggleMute();
      const btn = document.getElementById('muteBtn');
      if (btn) {
        // Update button text based on device
        if (isTouchDevice()) {
          btn.textContent = isMuted ? '🔇' : '🔊';
        } else {
          btn.textContent = isMuted ? '🔇 MUTED' : '🔊 SOUND';
        }
      }
    });

    // Fullscreen button (mobile only)
    document.getElementById('fullscreenBtn')?.addEventListener('click', () => {
      // On iOS, show instructions popup instead
      if (isIOS()) {
        const popup = document.getElementById('iosPopup');
        if (popup) popup.style.display = 'flex';
        return;
      }

      const elem = document.documentElement;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const doc = document as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const el = elem as any;

      // Check if already in fullscreen
      const isFullscreen = doc.fullscreenElement || doc.webkitFullscreenElement || doc.mozFullScreenElement;

      if (isFullscreen) {
        // Exit fullscreen
        if (doc.exitFullscreen) {
          doc.exitFullscreen();
        } else if (doc.webkitExitFullscreen) {
          doc.webkitExitFullscreen();
        } else if (doc.mozCancelFullScreen) {
          doc.mozCancelFullScreen();
        }
      } else {
        // Enter fullscreen
        if (el.requestFullscreen) {
          el.requestFullscreen();
        } else if (el.webkitRequestFullscreen) {
          el.webkitRequestFullscreen();
        } else if (el.mozRequestFullScreen) {
          el.mozRequestFullScreen();
        }
      }
    });

    // iOS popup close button
    document.getElementById('iosPopupClose')?.addEventListener('click', () => {
      const popup = document.getElementById('iosPopup');
      if (popup) popup.style.display = 'none';
    });

    // Close iOS popup when clicking outside
    document.getElementById('iosPopup')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) {
        (e.currentTarget as HTMLElement).style.display = 'none';
      }
    });

    // FPS toggle with 'f' key
    this.fpsKeyHandler = (e: KeyboardEvent) => {
      if (e.code === 'KeyF') {
        this.showFps = !this.showFps;
        this.dirty = true;
        localStorage.setItem('showFps', this.showFps ? 'true' : 'false');
      }
    };
    document.addEventListener('keydown', this.fpsKeyHandler);

    // Double-tap on game canvas to toggle FPS on mobile
    if (isTouch) {
      const gameCanvas = document.getElementById('gameCanvas');
      gameCanvas?.addEventListener('touchend', (e) => {
        const now = Date.now();
        if (now - this.lastTapTime < 300) {
          this.showFps = !this.showFps;
          this.dirty = true;
          localStorage.setItem('showFps', this.showFps ? 'true' : 'false');
          e.preventDefault();
        }
        this.lastTapTime = now;
      });
    }

    // `?perf=1`: record phase timings for the benchmark harness
    // (design/research/performance.md)
    const perf = new URLSearchParams(location.search).has('perf');
    if (perf) {
      if (this.renderer) this.renderer.checkCanvasReadback = true;
      perfEnable();
      this.showPerfHud();
    }

    // Debug / end-to-end test hook
    (window as unknown as { __teratron?: unknown }).__teratron = {
      config: this.config,
      view: () => this.session.getViewState(),
      stats: () => this.session.getNetworkStats(),
      /** True if the simulation runs in a Web Worker */
      inWorker: () => (this.session as { inWorker?: boolean }).inWorker === true,
      ...(perf && { perf: perfDump, session: this.session }),
    };

    this.ticker = new Ticker(
      () => this.step(),
      () => this.draw(),
      { runInBackground: this.session.runsInBackground }
    );
    this.ticker.start();
  }

  private renderDesktopLayout(): void {
    const soundManager = getSoundManager();
    this.container.innerHTML = `
      <div style="
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 1rem;
        min-height: 100vh;
      ">
        <div style="
          display: flex;
          justify-content: space-between;
          align-items: center;
          width: 800px;
          max-width: 100%;
          margin-bottom: 1rem;
        ">
          <h2 style="color: #0ff; margin: 0; text-shadow: 0 0 10px #0ff;">TERATRON</h2>
          <div style="display: flex; gap: 0.5rem;">
            <button id="muteBtn" style="
              padding: 0.5rem 1rem;
              font-family: monospace;
              cursor: pointer;
              background: #002;
              color: #0ff;
              border: 1px solid #0ff;
            ">${soundManager.isMuted() ? '🔇 MUTED' : '🔊 SOUND'}</button>
            ${this.options.onBackToLobby ? `<button id="lobbyBtn" title="Send everyone back to the lobby" style="
              padding: 0.5rem 1rem;
              font-family: monospace;
              cursor: pointer;
              background: #220;
              color: #fc4;
              border: 1px solid #fc4;
            ">LOBBY</button>` : ''}
            <button id="backBtn" style="
              padding: 0.5rem 1rem;
              font-family: monospace;
              cursor: pointer;
              background: #200;
              color: #f44;
              border: 1px solid #f44;
            ">BACK TO MENU</button>
          </div>
        </div>

        <div id="gameCanvas" style="
          display: flex;
          justify-content: center;
        "></div>

        <div style="
          color: #888;
          margin-top: 1rem;
          text-align: center;
        ">
          ${this.controlsHint()}
        </div>
      </div>
    `;

    // Initialize renderer (desktop mode)
    const canvasContainer = document.getElementById('gameCanvas')!;
    this.renderer = new TronRenderer(canvasContainer, this.config.players, false);
  }

  private renderMobileLayout(): void {
    const soundManager = getSoundManager();
    // Force landscape orientation hint
    this.container.innerHTML = `
      <style>
        .mobile-game-container {
          position: fixed;
          top: 0;
          left: 0;
          width: 100vw;
          height: 100vh;
          height: 100dvh; /* Dynamic viewport height for mobile */
          display: flex;
          align-items: center;
          justify-content: center;
          background: #000;
          touch-action: none;
          user-select: none;
          -webkit-user-select: none;
          overflow: hidden;
        }
        .mobile-game-layout {
          position: relative;
          width: 100%;
          height: 100%;
        }
        .control-zone {
          position: absolute;
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 10;
        }
        .control-zone-right {
          right: 5px;
          bottom: 5px;
        }
        .steer-zone {
          position: absolute;
          left: 0;
          top: 44px;
          bottom: 0;
          width: 50%;
          z-index: 10;
          touch-action: none;
        }
        .steer-hint {
          position: absolute;
          left: 12px;
          bottom: 8px;
          color: rgba(0, 255, 255, 0.45);
          font-family: monospace;
          font-size: 0.65rem;
          pointer-events: none;
        }
        .steer-pads {
          position: absolute;
          left: 8px;
          bottom: 8px;
          display: flex;
          gap: 10px;
          pointer-events: none;
        }
        .steer-pad {
          width: 84px;
          height: 84px;
          border-radius: 14px;
          background: rgba(0, 255, 255, 0.12);
          border: 2px solid rgba(0, 255, 255, 0.4);
          color: rgba(0, 255, 255, 0.8);
          font-size: 1.8rem;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .steer-pad.active {
          background: rgba(0, 255, 255, 0.4);
          border-color: #0ff;
        }
        .steer-stick {
          position: absolute;
          border-radius: 50%;
          background: rgba(0, 255, 255, 0.1);
          border: 2px solid rgba(0, 255, 255, 0.4);
          pointer-events: none;
        }
        .steer-knob {
          position: absolute;
          left: calc(50% - 18px);
          top: calc(50% - 18px);
          width: 36px;
          height: 36px;
          border-radius: 50%;
          background: rgba(0, 255, 255, 0.5);
        }
        .joystick-zone {
          position: absolute;
          left: 5px;
          bottom: 5px;
          width: 100px;
          height: 100px;
          background: rgba(0, 255, 255, 0.15);
          border-radius: 50%;
          border: 2px solid rgba(0, 255, 255, 0.4);
        }
        .touch-mode-button {
          position: absolute;
          top: 5px;
          height: 32px;
          padding: 0 8px;
          font-family: monospace;
          font-size: 0.7rem;
          background: rgba(0, 32, 32, 0.7);
          color: #0ff;
          border: 1px solid #0ff;
          border-radius: 4px;
          z-index: 100;
          cursor: pointer;
        }
        .action-button {
          width: 60px;
          height: 60px;
          border-radius: 50%;
          background: rgba(0, 255, 0, 0.25);
          border: 3px solid rgba(0, 255, 0, 0.6);
          display: flex;
          align-items: center;
          justify-content: center;
          color: #0f0;
          font-family: monospace;
          font-size: 0.6rem;
          font-weight: bold;
          text-shadow: 0 0 5px #0f0;
          opacity: 0.8;
          transition: transform 0.1s, opacity 0.1s;
        }
        .canvas-container {
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .canvas-container canvas {
          max-width: 100%;
          max-height: 100%;
          object-fit: contain;
        }
        .back-button-mobile {
          position: absolute;
          top: 5px;
          left: 5px;
          padding: 6px 10px;
          font-family: monospace;
          font-size: 0.7rem;
          background: rgba(32, 0, 0, 0.7);
          color: #f44;
          border: 1px solid #f44;
          border-radius: 4px;
          z-index: 100;
          cursor: pointer;
        }
        .top-button {
          position: absolute;
          top: 5px;
          padding: 6px;
          width: 32px;
          height: 32px;
          font-family: monospace;
          font-size: 1rem;
          line-height: 1;
          background: rgba(0, 32, 32, 0.7);
          color: #0ff;
          border: 1px solid #0ff;
          border-radius: 4px;
          z-index: 100;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .fullscreen-button {
          right: 5px;
        }
        .mute-button {
          right: 42px;
        }
        .ios-popup {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.85);
          z-index: 1000;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .ios-popup-content {
          background: #111;
          border: 2px solid #0ff;
          border-radius: 12px;
          padding: 1.5rem;
          max-width: 300px;
          text-align: left;
          position: relative;
          color: #fff;
          font-family: monospace;
        }
        .ios-popup-content h3 {
          color: #0ff;
          margin: 0 0 1rem 0;
          text-align: center;
        }
        .ios-popup-content p {
          margin: 0.5rem 0;
        }
        .ios-popup-content ol {
          margin: 1rem 0;
          padding-left: 1.5rem;
        }
        .ios-popup-content li {
          margin: 0.5rem 0;
        }
        .ios-popup-close {
          position: absolute;
          top: 8px;
          right: 8px;
          background: none;
          border: none;
          color: #888;
          font-size: 1.2rem;
          cursor: pointer;
          padding: 4px 8px;
        }
        /* Portrait orientation warning */
        @media (orientation: portrait) {
          .rotate-hint {
            display: flex !important;
          }
          .mobile-game-layout {
            display: none !important;
          }
        }
        @media (orientation: landscape) {
          .rotate-hint {
            display: none !important;
          }
        }
        .rotate-hint {
          display: none;
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: #000;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          color: #0ff;
          font-family: monospace;
          text-align: center;
          padding: 2rem;
          z-index: 200;
        }
        .rotate-icon {
          font-size: 4rem;
          margin-bottom: 1rem;
          animation: rotate-phone 2s ease-in-out infinite;
        }
        @keyframes rotate-phone {
          0%, 100% { transform: rotate(0deg); }
          50% { transform: rotate(90deg); }
        }
      </style>

      <div class="mobile-game-container">
        <!-- Rotate hint for portrait mode -->
        <div class="rotate-hint">
          <div class="rotate-icon">📱</div>
          <div style="font-size: 1.2rem; margin-bottom: 0.5rem;">Rotate your device</div>
          <div style="color: #888;">Play in landscape mode</div>
        </div>

        <!-- Game layout -->
        <div class="mobile-game-layout">
          <!-- Top buttons -->
          <button id="backBtn" class="back-button-mobile">✕</button>
          ${this.options.onBackToLobby ? '<button id="lobbyBtn" class="back-button-mobile" style="left: 42px; color: #fc4; border-color: #fc4;" title="Back to lobby">⌂</button>' : ''}
          <button id="touchModeBtn" class="touch-mode-button" style="left: ${this.options.onBackToLobby ? 84 : 47}px;" title="Steering mode"></button>
          <button id="muteBtn" class="top-button mute-button">${soundManager.isMuted() ? '🔇' : '🔊'}</button>
          <button id="fullscreenBtn" class="top-button fullscreen-button">⛶</button>

          <!-- iOS home screen popup -->
          <div id="iosPopup" class="ios-popup" style="display: none;">
            <div class="ios-popup-content">
              <button id="iosPopupClose" class="ios-popup-close">✕</button>
              <h3>Add to Home Screen</h3>
              <p>For fullscreen experience on iOS:</p>
              <ol>
                <li>Tap the <strong>Share</strong> button <span style="font-size: 1.2em;">⬆️</span></li>
                <li>Scroll down and tap <strong>"Add to Home Screen"</strong></li>
                <li>Tap <strong>Add</strong></li>
              </ol>
              <p style="color: #888; font-size: 0.8em;">Then open from your home screen</p>
            </div>
          </div>
          <!-- Full-screen Canvas -->
          <div id="gameCanvas" class="canvas-container"></div>

          <!-- Overlaid controls -->
          <!-- Left half: steering (built by TouchControls for the selected mode) -->
          <div id="steerZone" class="steer-zone"></div>

          <!-- Right: Action button -->
          <div class="control-zone control-zone-right">
            <div id="actionButton" class="action-button">ACTION</div>
          </div>
        </div>
      </div>
    `;

    // Initialize renderer (mobile fullscreen mode)
    const canvasContainer = document.getElementById('gameCanvas')!;
    this.renderer = new TronRenderer(canvasContainer, this.config.players, true);
  }

  // One simulation tick
  private step(): void {
    if (!this.input) return;
    const t0 = perfStart();
    this.session.step(this.input.getInputs());
    perfEnd('step', t0);
    this.dirty = true;

    // Track steps per second (should stay at TICK_RATE)
    const now = performance.now();
    this.stepTimes.push(now);
    while (this.stepTimes.length > 0 && this.stepTimes[0]! < now - 1000) this.stepTimes.shift();
    if (now - this.lastFpsUpdate > 500) {
      this.currentFps = this.stepTimes.length;
      this.lastFpsUpdate = now;
    }
  }

  // One display frame
  private draw(): void {
    if (!this.renderer) return;
    const view = this.session.getViewState();
    if (!view) {
      this.renderer.renderMessage('Waiting for host...');
      return;
    }

    // Load the level image when the level changes
    const levelIndex = view.match.currentLevelIndex;
    if (levelIndex !== this.loadedLevelIndex && !this.levelLoading) {
      this.loadLevel(levelIndex);
    }

    // Nothing new since the last display frame: what is on the canvas is still right
    if (!this.dirty) return;
    this.dirty = false;

    const stats = this.session.getNetworkStats() ?? undefined;
    const t0 = perfStart();
    this.renderer.render(
      view.round, view.match, this.showFps ? this.currentFps : undefined,
      this.showFps ? stats : undefined, view.overlayTrails
    );
    perfEnd('render', t0);
    // `?botdebug=1`: what the bots know of the arena (design/bots-territory.md)
    const game = (this.session as { game?: TronGameState }).game;
    if (this.botDebug && game && view.round.phase === 'playing') this.botDebug.draw(this.renderer.context, game);
    const silentMs = stats?.silentMs ?? 0;
    if (silentMs > HOST_SILENCE_MS) {
      this.renderer.renderNotice('Connection to the host lost', `waiting… ${Math.floor(silentMs / 1000)}s`);
    }
  }

  // Apply the one-shot events carried by a simulation frame (trail growth, cleared
  // pixels, sounds...) to the renderer and the sound manager. Must be called exactly
  // once per simulated frame, in order.
  private applyFrameEvents(state: TronGameStateData): void {
    const renderer = this.renderer;
    if (!renderer) return;
    this.dirty = true;

    if (state.roundStarted) {
      renderer.clearTrails();
    }
    // Eraser wipes everything drawn so far; segments in the same frame come after it
    if (state.eraserUsed) {
      renderer.restoreLevel();
    }
    for (const { slotIndex, segments } of state.newTrailSegments) {
      renderer.addTrailSegments(slotIndex, segments);
    }
    if (state.round.phase === 'playing') renderer.addPaths(state.round.players);
    if (state.borderSegments) {
      for (const { color, segments } of state.borderSegments) {
        renderer.addBorderSegments(color, segments);
      }
    }
    if (state.clearedLines) renderer.clearLines(state.clearedLines);
    if (state.clearedAreas) {
      for (const { x, y, w, h } of state.clearedAreas) {
        renderer.clearRect(x, y, w, h);
      }
    }
    if (state.deaths) {
      for (const d of state.deaths) {
        const name = this.config.players.find(p => p.slotIndex === d.slotIndex)?.nickname ?? d.slotIndex;
        console.info(`[game] ${name} died: ${d.cause}${d.by !== undefined ? ` by slot ${d.by}` : ''} at ${d.x},${d.y}`);
        renderer.recordDeath(d.slotIndex, d.cause, d.by);
      }
    }
    if (state.ridiculousDeathSlots) {
      for (const slot of state.ridiculousDeathSlots) {
        renderer.triggerRidiculousDeath(slot);
      }
    }
    renderer.updateColorBlindness(state.colorBlindnessFrames ?? 0);
    renderer.updateWhiteFlash(state.whiteFlashFrames ?? 0);

    // Stop sound loops whenever a round ends or restarts, so that a loop cannot
    // outlive the round that started it
    const phase = state.round.phase;
    if (this.previousPhase !== phase) {
      if (phase === 'waiting_ready' || phase === 'countdown') {
        getSoundManager().stopAllLoops();
      }
      this.previousPhase = phase;
    }

    this.playSoundEvents(state.soundEvents);
  }

  private playSoundEvents(events: SoundEvent[]): void {
    const sound = getSoundManager();
    for (const event of events) {
      if (event.stopLoop) {
        sound.stopLoop(event.stopLoop);
      } else if (event.loop && event.loopKey) {
        sound.playLoop(event.sound as SoundName, event.loopKey);
      } else if (event.sound) {
        sound.play(event.sound as SoundName);
      }
    }
  }

  private loadLevel(levelIndex: number): void {
    if (!this.renderer) return;

    const level = LEVELS[levelIndex];
    if (!level) return;

    this.levelLoading = true;

    this.renderer.loadLevel(level).then((obstacles) => {
      this.session.setLevelObstacles(levelIndex, obstacles);
      this.loadedLevelIndex = levelIndex;
      this.levelLoading = false;
      this.dirty = true;
    }).catch((error) => {
      console.error('Failed to load level:', error);
      this.levelLoading = false;
    });
  }

  // Once a second: ticks per second and, per phase, mean / worst milliseconds of the
  // last second (design/research/performance.md)
  private showPerfHud(): void {
    const hud = document.createElement('pre');
    hud.style.cssText = 'position:fixed;right:4px;bottom:4px;margin:0;padding:3px 5px;z-index:1000;' +
      'font:10px/1.25 monospace;color:#0f0;background:rgba(0,0,0,0.65);pointer-events:none;';
    document.body.appendChild(hud);
    this.perfHud = hud;
    const cursor = new Map<string, number>();
    // With `?worker=1` the simulation's timers are in the worker
    const worker = this.session as { inWorker?: boolean; workerSummary?: () => Promise<{ summary: PerfSummary; droppedTicks: number }> };
    const row = (name: string, s: PerfSummary[string] | undefined, rate = false): string =>
      s ? `${name.padEnd(11)} ${s.mean.toFixed(2).padStart(6)} ${s.worst.toFixed(1).padStart(6)}${rate ? `  ${s.n}/s` : ''}\n` : '';
    this.perfHudTimer = setInterval(() => {
      const main = perfSince(cursor);
      void ((worker.inWorker ? worker.workerSummary?.() : null) ?? Promise.resolve(null)).then((remote) => {
        const sim = remote?.summary ?? main;
        let text = 'ms            mean  worst\n';
        text += row(remote ? 'w.step' : 'step', sim.step, true);
        for (const phase of ['bots', 'sim', 'serialize']) text += row(remote ? `w.${phase}` : phase, sim[phase]);
        for (const phase of ['events', 'render', 'frame', 'workerLag']) text += row(phase, main[phase]);
        text += `dropped ticks: ${remote ? remote.droppedTicks : perfCounter('droppedTicks')}`;
        const off = this.renderer?.canvasReadbackDifference;
        if (off !== null && off !== undefined) text += `\ncanvas read-back off by ${off} px`;
        hud.textContent = text;
      });
    }, 1000);
  }

  cleanup(): void {
    getSoundManager().stopAllLoops();

    if (this.perfHudTimer !== null) clearInterval(this.perfHudTimer);
    this.perfHudTimer = null;
    this.perfHud?.remove();
    this.perfHud = null;

    this.ticker?.stop();
    this.ticker = null;

    if (this.fpsKeyHandler) {
      document.removeEventListener('keydown', this.fpsKeyHandler);
      this.fpsKeyHandler = null;
    }

    this.input?.cleanup();
    this.input = null;

    this.renderer?.destroy();
    this.renderer = null;
    this.botDebug?.destroy();
    this.botDebug = null;

    this.session.onFrame = null;
    this.session.onSnapshot = null;
    this.session.onEnded = null;
    this.session.destroy();
  }
}
