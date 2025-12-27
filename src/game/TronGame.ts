// TronGame - Main game screen integrating all components

import type { Screen, ScreenManager } from '../screens/ScreenManager';
import type { GameConnection } from '../network/GameConnection';
import type { GameConfig, TronInput, TronGameStateData, TrailSegment } from '../types/game';
import type { SlotIndex } from '../types/lobby';
import { TronGameState } from './TronGameState';
import { TronRenderer } from './TronRenderer';
import { TronInputHandler } from './TronInput';

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
  private readonly TARGET_FRAME_TIME = 1000 / 60; // 60fps

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
    // Create container HTML
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
          <button id="backBtn" style="
            padding: 0.5rem 1rem;
            font-family: monospace;
            cursor: pointer;
            background: #200;
            color: #f44;
            border: 1px solid #f44;
          ">BACK TO MENU</button>
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
          <div>LEFT/RIGHT: Turn | SPACE: Ready</div>
        </div>
      </div>
    `;

    // Initialize renderer
    const canvasContainer = document.getElementById('gameCanvas')!;
    this.renderer = new TronRenderer(canvasContainer, this.config.players);

    // Initialize input handler
    this.inputHandler = new TronInputHandler('arrows');

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

    // Start game loop
    this.lastFrameTime = performance.now();
    this.startGameLoop();
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
