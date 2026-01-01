// TronGame - Main game screen integrating all components

import type { Screen, ScreenManager } from '../screens/ScreenManager';
import type { GameConnection } from '../network/GameConnection';
import type { GameConfig, TronInput, TronGameStateData, TrailSegment, SoundEvent } from '../types/game';
import { LEVELS } from '../types/game';
import type { SlotIndex } from '../types/lobby';
import { TronGameState } from './TronGameState';
import { TronRenderer } from './TronRenderer';
import { TronInputHandler, isTouchDevice } from './TronInput';
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

  // Last time we processed a frame (for consistent timing)
  private lastFrameTime: number = 0;
  private readonly TARGET_FRAME_TIME = 1000 / 70; // 70fps

  // Track loaded level to detect changes
  private loadedLevelIndex: number = -1;
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
      this.gameState = new TronGameState(this.config.players, this.config.gameMode);
    } else {
      // Guest creates local state for rendering (updated from network)
      this.gameState = new TronGameState(this.config.players, this.config.gameMode);
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
        .fullscreen-button {
          position: absolute;
          top: 5px;
          right: 5px;
          padding: 6px 10px;
          font-family: monospace;
          font-size: 0.7rem;
          background: rgba(0, 32, 32, 0.7);
          color: #0ff;
          border: 1px solid #0ff;
          border-radius: 4px;
          z-index: 100;
          cursor: pointer;
        }
        .mute-button {
          position: absolute;
          top: 5px;
          right: 45px;
          padding: 6px 10px;
          font-family: monospace;
          font-size: 0.7rem;
          background: rgba(0, 32, 32, 0.7);
          color: #0ff;
          border: 1px solid #0ff;
          border-radius: 4px;
          z-index: 100;
          cursor: pointer;
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
          <button id="muteBtn" class="mute-button">${soundManager.isMuted() ? '🔇' : '🔊'}</button>
          <button id="fullscreenBtn" class="fullscreen-button">⛶</button>
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
        },
        onHostDisconnected: () => {
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
      const deltaTime = currentTime - this.lastFrameTime;

      // Only process frame if enough time has passed
      if (deltaTime >= this.TARGET_FRAME_TIME) {
        this.lastFrameTime = currentTime - (deltaTime % this.TARGET_FRAME_TIME);
        this.processFrame();
      }

      this.animationId = requestAnimationFrame(loop);
    };

    this.animationId = requestAnimationFrame(loop);
  }

  private processFrame(): void {
    if (!this.inputHandler || !this.renderer || !this.gameState) return;

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

      // Play sounds locally
      this.playSoundEvents(stateData.soundEvents);

      // Broadcast state to guests
      this.broadcastState(stateData);

      // Render
      this.renderer.render(stateData.round, stateData.match);
    } else {
      // Guest: Send input to host and render received state

      // Send input to host
      this.connection.sendInput(myInput);

      // If we have received state, update and render
      if (this.receivedState) {
        // Update local game state from network
        this.gameState.updateFromState(this.receivedState);

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

        // Play sounds from received state (clear after playing to prevent replay)
        if (this.receivedState.soundEvents && this.receivedState.soundEvents.length > 0) {
          this.playSoundEvents(this.receivedState.soundEvents);
          this.receivedState.soundEvents = [];
        }

        // Render
        this.renderer.render(this.receivedState.round, this.receivedState.match);
      } else {
        // Render initial state while waiting for first update
        const stateData = this.gameState.serialize();
        this.renderer.render(stateData.round, stateData.match);
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
    // Stop game loop
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
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
