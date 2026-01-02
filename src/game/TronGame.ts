// TronGame - Main game screen integrating all components

import type { Screen, ScreenManager } from '../screens/ScreenManager';
import type { GameConnection } from '../network/GameConnection';
import type { GameConfig, TronInput, TronGameStateData, TrailSegment, SoundEvent, RoundPhase } from '../types/game';
import { LEVELS } from '../types/game';
import type { SlotIndex } from '../types/lobby';
import { TronGameState } from './TronGameState';
import { TronRenderer } from './TronRenderer';
import { TronInputHandler, isTouchDevice, isIOS } from './TronInput';
import { getSoundManager, type SoundName } from './SoundManager';

export class TronGame implements Screen {
  private container: HTMLElement;
  private screenManager: ScreenManager;
  private config: GameConfig;
  private connection: GameConnection;

  private renderer: TronRenderer | null = null;
  private inputHandler: TronInputHandler | null = null;
  private gameState: TronGameState | null = null;
  private animationId: number | null = null;

  // Host stores inputs from all players
  private playerInputs: Map<SlotIndex, TronInput> = new Map();

  // Guest receives state from host
  private receivedState: TronGameStateData | null = null;

  // Guest accumulates trail segments between frames to avoid losing any
  private pendingTrailSegments: Map<SlotIndex, TrailSegment[]> = new Map();

  // Guest accumulates ridiculous death events between frames
  private pendingRidiculousDeaths: Set<SlotIndex> = new Set();

  // Last time we processed a frame (for consistent timing)
  private lastFrameTime: number = 0;
  private readonly TARGET_FRAME_TIME = 1000 / 70; // 70fps

  // FPS tracking for debug display (circular buffer)
  private frameTimes: number[] = new Array(70).fill(0);
  private frameTimeIndex: number = 0;
  private frameCount: number = 0;
  private lastFpsUpdate: number = 0;
  private currentFps: number = 70;
  private showFps: boolean = localStorage.getItem('showFps') === 'true';
  private fpsKeyHandler: ((e: KeyboardEvent) => void) | null = null;

  // Track loaded level to detect changes
  private loadedLevelIndex: number = -1;

  // Track previous round phase to detect transitions and stop sound loops
  private previousPhase: RoundPhase | null = null;
  private levelLoading: boolean = false;

  constructor(
    container: HTMLElement,
    screenManager: ScreenManager,
    config: GameConfig,
    connection: GameConnection
  ) {
    this.container = container;
    this.screenManager = screenManager;
    this.config = config;
    this.connection = connection;
  }

  render(): void {
    const isTouch = isTouchDevice();

    if (isTouch) {
      this.renderMobileLayout();
    } else {
      this.renderDesktopLayout();
    }

    // Initialize input handler
    this.inputHandler = new TronInputHandler('arrows');

    // Setup touch controls if on mobile
    if (isTouch) {
      const joystickZone = document.getElementById('joystickZone');
      const actionButton = document.getElementById('actionButton');
      if (joystickZone && actionButton) {
        this.inputHandler.initTouchControls(joystickZone, actionButton);
      }
    }

    // Setup network handlers
    this.setupNetworkHandlers();

    // Initialize game state
    if (this.config.isHost) {
      // Host creates authoritative game state
      this.gameState = new TronGameState(this.config.players, this.config.gameMode, this.config.levelMode);
    } else {
      // Guest creates local state for rendering (updated from network)
      this.gameState = new TronGameState(this.config.players, this.config.gameMode, this.config.levelMode);
    }

    // Event listeners
    document.getElementById('backBtn')?.addEventListener('click', () => {
      this.cleanup();
      this.screenManager.showMainMenu();
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
      if (e.key === 'f' || e.key === 'F') {
        this.showFps = !this.showFps;
        localStorage.setItem('showFps', this.showFps ? 'true' : 'false');
      }
    };
    document.addEventListener('keydown', this.fpsKeyHandler);

    // Start game loop
    this.lastFrameTime = performance.now();
    this.startGameLoop();
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
          <div>LEFT/RIGHT: Turn | SPACE: Ready/Fire</div>
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
        .control-zone-left {
          left: 5px;
          bottom: 5px;
        }
        .control-zone-right {
          right: 5px;
          bottom: 5px;
        }
        .joystick-zone {
          width: 100px;
          height: 100px;
          position: relative;
          background: rgba(0, 255, 255, 0.15);
          border-radius: 50%;
          border: 2px solid rgba(0, 255, 255, 0.4);
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
          <!-- Left: Joystick -->
          <div class="control-zone control-zone-left">
            <div id="joystickZone" class="joystick-zone"></div>
          </div>

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

  private setupNetworkHandlers(): void {
    if (this.config.isHost) {
      // Host receives input from guests
      this.connection.setCallbacks({
        onPlayerInput: (slotIndex, input) => {
          this.playerInputs.set(slotIndex, input as TronInput);
        },
      });
    } else {
      // Guest receives state from host
      this.connection.setCallbacks({
        onTronState: (state) => {
          this.receivedState = state;

          // Accumulate trail segments to avoid losing any between frames
          for (const { slotIndex, segments } of state.newTrailSegments) {
            const existing = this.pendingTrailSegments.get(slotIndex) || [];
            existing.push(...segments);
            this.pendingTrailSegments.set(slotIndex, existing);
          }

          // Accumulate ridiculous death events to avoid losing any between frames
          if (state.ridiculousDeathSlots) {
            for (const slot of state.ridiculousDeathSlots) {
              this.pendingRidiculousDeaths.add(slot);
            }
          }
        },
        onHostDisconnected: () => {
          getSoundManager().stopAllLoops();  // Stop any lingering sound loops
          alert('Host disconnected');
          this.cleanup();
          this.screenManager.showMainMenu();
        },
      });
    }
  }

  private startGameLoop(): void {
    const loop = (currentTime: number): void => {
      // Calculate delta time
      let deltaTime = currentTime - this.lastFrameTime;

      // Process multiple frames if needed (decouples game logic from display refresh)
      // Cap at 5 frames per RAF to prevent spiral of death when tab is backgrounded
      let framesProcessed = 0;
      const maxFramesPerRaf = 5;

      while (deltaTime >= this.TARGET_FRAME_TIME && framesProcessed < maxFramesPerRaf) {
        this.lastFrameTime += this.TARGET_FRAME_TIME;
        deltaTime -= this.TARGET_FRAME_TIME;
        this.processFrame();
        framesProcessed++;
      }

      // If we hit the cap, reset timing to prevent accumulating debt
      if (framesProcessed >= maxFramesPerRaf) {
        this.lastFrameTime = currentTime;
      }

      this.animationId = requestAnimationFrame(loop);
    };

    this.animationId = requestAnimationFrame(loop);
  }

  private processFrame(): void {
    if (!this.inputHandler || !this.renderer || !this.gameState) return;

    // Track FPS using circular buffer (O(1) per frame)
    const now = performance.now();
    this.frameTimes[this.frameTimeIndex] = now;
    this.frameTimeIndex = (this.frameTimeIndex + 1) % 70;
    if (this.frameCount < 70) this.frameCount++;

    // Update FPS display every 500ms
    if (now - this.lastFpsUpdate > 500 && this.frameCount >= 2) {
      // Find oldest and newest times in circular buffer
      const oldestIndex = this.frameCount < 70 ? 0 : this.frameTimeIndex;
      const newestIndex = (this.frameTimeIndex + 69) % 70;
      const elapsed = this.frameTimes[newestIndex]! - this.frameTimes[oldestIndex]!;
      if (elapsed > 0) {
        this.currentFps = Math.round((this.frameCount - 1) * 1000 / elapsed);
      }
      this.lastFpsUpdate = now;
    }

    // Check if level needs to be loaded (for both host and guest)
    const currentLevelIndex = this.gameState.currentLevelIndex;
    if (currentLevelIndex !== this.loadedLevelIndex && !this.levelLoading) {
      this.loadLevel(currentLevelIndex);
    }

    // Get local input
    const myInput = this.inputHandler.getInput();
    const mySlot = this.connection.getMySlotIndex();

    if (this.config.isHost) {
      // Host: Process all inputs and update state

      // Store local player's input
      if (mySlot !== null) {
        this.playerInputs.set(mySlot, myInput);
      }

      // Tick game state with all inputs
      this.gameState.tick(this.playerInputs);

      // Get serialized state
      const stateData = this.gameState.serialize();

      // Add new trail segments to renderer
      for (const { slotIndex, segments } of stateData.newTrailSegments) {
        this.renderer.addTrailSegments(slotIndex, segments);
      }

      // Add border segments to renderer (lock borders effect)
      if (stateData.borderSegments) {
        for (const { color, segments } of stateData.borderSegments) {
          this.renderer.addBorderSegments(color, segments);
        }
      }

      // Clear areas from bullet impacts
      if (stateData.clearedAreas) {
        for (const { x, y, radius } of stateData.clearedAreas) {
          this.renderer.clearArea(x, y, radius);
        }
      }

      // Handle eraser - restore level and clear trails
      if (stateData.eraserUsed) {
        this.renderer.restoreLevel();
      }

      // Handle ridiculous death events
      if (stateData.ridiculousDeathSlots) {
        for (const slot of stateData.ridiculousDeathSlots) {
          this.renderer.triggerRidiculousDeath(slot);
        }
      }

      // Update color blindness state
      this.renderer.updateColorBlindness(stateData.colorBlindnessFrames ?? 0);

      // Play sounds locally
      this.playSoundEvents(stateData.soundEvents);

      // Broadcast state to guests
      this.broadcastState(stateData);

      // Render
      this.renderer.render(stateData.round, stateData.match, this.showFps ? this.currentFps : undefined);
    } else {
      // Guest: Send input to host and render received state

      // Send input to host
      this.connection.sendInput(myInput);

      // If we have received state, update and render
      if (this.receivedState) {
        // Update local game state from network
        this.gameState.updateFromState(this.receivedState);

        // Stop all sound loops on phase transitions to round_end or countdown
        // This ensures loops don't persist due to missed network messages
        const currentPhase = this.receivedState.round.phase;
        if (this.previousPhase !== currentPhase) {
          if (currentPhase === 'round_end' || currentPhase === 'countdown') {
            getSoundManager().stopAllLoops();
          }
          this.previousPhase = currentPhase;
        }

        // Add all pending trail segments to renderer (accumulated between frames)
        for (const [slotIndex, segments] of this.pendingTrailSegments) {
          if (segments.length > 0) {
            this.renderer.addTrailSegments(slotIndex, segments);
          }
        }
        // Clear pending segments after processing
        this.pendingTrailSegments.clear();

        // Add border segments to renderer (lock borders effect)
        if (this.receivedState.borderSegments) {
          for (const { color, segments } of this.receivedState.borderSegments) {
            this.renderer.addBorderSegments(color, segments);
          }
          // Clear after drawing to prevent replay
          this.receivedState.borderSegments = undefined;
        }

        // Clear areas from bullet impacts
        if (this.receivedState.clearedAreas) {
          for (const { x, y, radius } of this.receivedState.clearedAreas) {
            this.renderer.clearArea(x, y, radius);
          }
          this.receivedState.clearedAreas = undefined;
        }

        // Handle eraser - restore level and clear trails
        if (this.receivedState.eraserUsed) {
          this.renderer.restoreLevel();
          this.pendingTrailSegments.clear();
          this.receivedState.eraserUsed = undefined;
        }

        // Handle ridiculous death events (from accumulated set)
        for (const slot of this.pendingRidiculousDeaths) {
          this.renderer.triggerRidiculousDeath(slot);
        }
        this.pendingRidiculousDeaths.clear();

        // Update color blindness state
        this.renderer.updateColorBlindness(this.receivedState.colorBlindnessFrames ?? 0);

        // Play sounds from received state (clear after playing to prevent replay)
        if (this.receivedState.soundEvents && this.receivedState.soundEvents.length > 0) {
          this.playSoundEvents(this.receivedState.soundEvents);
          this.receivedState.soundEvents = [];
        }

        // Render
        this.renderer.render(this.receivedState.round, this.receivedState.match, this.showFps ? this.currentFps : undefined);
      } else {
        // Render initial state while waiting for first update
        const stateData = this.gameState.serialize();
        this.renderer.render(stateData.round, stateData.match, this.showFps ? this.currentFps : undefined);
      }
    }

    // Clear trails if round was reset
    if (this.gameState.phase === 'countdown' && this.gameState.countdown > 2.9) {
      this.renderer.clearTrails();
      this.pendingTrailSegments.clear();
    }
  }

  private broadcastState(state: TronGameStateData): void {
    // Broadcast full Tron state to all guests
    this.connection.broadcastTronState(state);
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
    if (!this.renderer || !this.gameState) return;

    const level = LEVELS[levelIndex];
    if (!level) return;

    this.levelLoading = true;

    this.renderer.loadLevel(level).then((obstacles) => {
      // Only host adds obstacles to game state (guests just render the background)
      if (this.config.isHost && this.gameState) {
        this.gameState.setLevelObstacles(obstacles);
      }
      this.loadedLevelIndex = levelIndex;
      this.levelLoading = false;
    }).catch((error) => {
      console.error('Failed to load level:', error);
      this.levelLoading = false;
    });
  }

  cleanup(): void {
    // Stop all sound loops
    getSoundManager().stopAllLoops();

    // Stop game loop
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }

    // Cleanup FPS key handler
    if (this.fpsKeyHandler) {
      document.removeEventListener('keydown', this.fpsKeyHandler);
      this.fpsKeyHandler = null;
    }

    // Cleanup input handler
    this.inputHandler?.cleanup();
    this.inputHandler = null;

    // Cleanup renderer
    this.renderer?.destroy();
    this.renderer = null;

    // Disconnect
    this.connection.disconnect();
  }
}
