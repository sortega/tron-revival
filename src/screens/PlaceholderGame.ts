// Placeholder game screen - dots that can be moved with arrow keys

import type { Screen, ScreenManager } from './ScreenManager';
import type { GameConnection } from '../network/GameConnection';
import type { GameConfig, Spectator } from '../types/game';
import type { SlotIndex } from '../types/lobby';
import type { PlayerPosition, GameInput } from '../network/protocol';

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;
const DOT_RADIUS = 10;
const MOVE_SPEED = 5;

interface PlayerState {
  slotIndex: SlotIndex;
  x: number;
  y: number;
  color: string;
  nickname: string;
}

export class PlaceholderGame implements Screen {
  private container: HTMLElement;
  private screenManager: ScreenManager;
  private config: GameConfig;
  private connection: GameConnection;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private players: Map<SlotIndex, PlayerState> = new Map();
  private spectators: Spectator[];
  private input: GameInput = { left: false, right: false, up: false, down: false };
  private playerInputs: Map<SlotIndex, GameInput> = new Map(); // Host stores all player inputs
  private animationId: number | null = null;

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
    this.spectators = config.spectators;
  }

  render(): void {
    const spectatorList = this.spectators.length > 0
      ? `<div style="color: #666; margin-top: 0.5rem;">
           Spectators: ${this.spectators.map(s => s.nickname).join(', ')}
         </div>`
      : '';

    this.container.innerHTML = `
      <div style="
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 1rem;
      ">
        <div style="
          display: flex;
          justify-content: space-between;
          align-items: center;
          width: ${CANVAS_WIDTH}px;
          margin-bottom: 1rem;
        ">
          <h2 style="color: #0ff; margin: 0;">GAME IN PROGRESS</h2>
          <button id="backBtn" style="
            padding: 0.5rem 1rem;
            font-family: monospace;
            cursor: pointer;
            background: #200;
            color: #f44;
            border: 1px solid #f44;
          ">BACK TO MENU</button>
        </div>

        <canvas id="gameCanvas" width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}" style="
          background: #000;
          border: 2px solid #333;
        "></canvas>

        <div style="
          color: #888;
          margin-top: 1rem;
          text-align: center;
        ">
          Use arrow keys to move your dot
          ${spectatorList}
        </div>
      </div>
    `;

    this.canvas = document.getElementById('gameCanvas') as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d');

    this.initializePlayers();
    this.setupEventListeners();
    this.setupNetworkHandlers();
    this.startGameLoop();
  }

  private initializePlayers(): void {
    const spawnPositions = [
      { x: 100, y: 100 },
      { x: CANVAS_WIDTH - 100, y: 100 },
      { x: 100, y: CANVAS_HEIGHT - 100 },
      { x: CANVAS_WIDTH - 100, y: CANVAS_HEIGHT - 100 },
    ];

    for (const player of this.config.players) {
      const pos = spawnPositions[player.slotIndex]!;
      this.players.set(player.slotIndex, {
        slotIndex: player.slotIndex,
        x: pos.x,
        y: pos.y,
        color: player.color,
        nickname: player.nickname,
      });
    }
  }

  private setupEventListeners(): void {
    document.getElementById('backBtn')?.addEventListener('click', () => {
      this.cleanup();
      this.screenManager.showMainMenu();
    });

    // Keyboard input
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    let changed = false;
    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault();
        if (!this.input.left) { this.input.left = true; changed = true; }
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (!this.input.right) { this.input.right = true; changed = true; }
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!this.input.up) { this.input.up = true; changed = true; }
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (!this.input.down) { this.input.down = true; changed = true; }
        break;
    }

    if (changed && !this.config.isHost) {
      this.connection.sendInput(this.input);
    }
  };

  private handleKeyUp = (e: KeyboardEvent): void => {
    let changed = false;
    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault();
        if (this.input.left) { this.input.left = false; changed = true; }
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (this.input.right) { this.input.right = false; changed = true; }
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (this.input.up) { this.input.up = false; changed = true; }
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (this.input.down) { this.input.down = false; changed = true; }
        break;
    }

    if (changed && !this.config.isHost) {
      this.connection.sendInput(this.input);
    }
  };

  private setupNetworkHandlers(): void {
    if (this.config.isHost) {
      // Host receives input from guests and stores it for continuous application
      this.connection.setCallbacks({
        onPlayerInput: (slotIndex, input) => {
          // Cast to GameInput - PlaceholderGame only uses legacy input format
          this.playerInputs.set(slotIndex, input as GameInput);
        },
      });
    } else {
      // Guest receives state from host
      console.log('[PlaceholderGame] Setting up guest callbacks');
      this.connection.setCallbacks({
        onGameState: (positions) => {
          console.log('[PlaceholderGame] Guest received game state:', positions.length, 'players');
          for (const pos of positions) {
            const player = this.players.get(pos.slotIndex);
            if (player) {
              player.x = pos.x;
              player.y = pos.y;
            }
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

  private applyInputToPlayer(slotIndex: SlotIndex, input: GameInput): void {
    const player = this.players.get(slotIndex);
    if (!player) return;

    if (input.left) player.x -= MOVE_SPEED;
    if (input.right) player.x += MOVE_SPEED;
    if (input.up) player.y -= MOVE_SPEED;
    if (input.down) player.y += MOVE_SPEED;

    // Clamp to canvas bounds
    player.x = Math.max(DOT_RADIUS, Math.min(CANVAS_WIDTH - DOT_RADIUS, player.x));
    player.y = Math.max(DOT_RADIUS, Math.min(CANVAS_HEIGHT - DOT_RADIUS, player.y));
  }

  private startGameLoop(): void {
    const gameLoop = (): void => {
      if (this.config.isHost) {
        // Host processes their own input locally
        const mySlot = this.connection.getMySlotIndex();
        if (mySlot !== null) {
          this.applyInputToPlayer(mySlot, this.input);
        }

        // Apply stored inputs from all guests
        for (const [slotIndex, input] of this.playerInputs) {
          this.applyInputToPlayer(slotIndex, input);
        }

        // Broadcast state to guests
        const positions: PlayerPosition[] = Array.from(this.players.values()).map(p => ({
          slotIndex: p.slotIndex,
          x: p.x,
          y: p.y,
        }));
        this.connection.broadcastPositions(positions);
      }

      this.render2d();
      this.animationId = requestAnimationFrame(gameLoop);
    };

    this.animationId = requestAnimationFrame(gameLoop);
  }

  private render2d(): void {
    if (!this.ctx) return;

    // Clear canvas
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    // Draw players
    for (const player of this.players.values()) {
      // Draw dot
      this.ctx.beginPath();
      this.ctx.arc(player.x, player.y, DOT_RADIUS, 0, Math.PI * 2);
      this.ctx.fillStyle = player.color;
      this.ctx.fill();

      // Draw glow
      this.ctx.shadowColor = player.color;
      this.ctx.shadowBlur = 15;
      this.ctx.fill();
      this.ctx.shadowBlur = 0;

      // Draw nickname
      this.ctx.fillStyle = '#fff';
      this.ctx.font = '12px monospace';
      this.ctx.textAlign = 'center';
      this.ctx.fillText(player.nickname, player.x, player.y - DOT_RADIUS - 5);
    }
  }

  cleanup(): void {
    // Remove event listeners
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);

    // Stop game loop
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }

    // Disconnect from the room
    this.connection.disconnect();
  }
}
