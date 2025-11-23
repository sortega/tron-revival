/**
 * Main Game Class
 * Orchestrates the game loop, players, and rendering
 */

import { GameLoop } from './engine/GameLoop';
import { InputManager } from './engine/InputManager';
import { CollisionDetector } from './engine/CollisionDetector';
import { Player } from './entities/Player';
import { Renderer } from '../render/Renderer';
import { PLAYER_COLORS } from '../constants';

export class Game {
  private gameLoop: GameLoop;
  private inputManager: InputManager;
  private collisionDetector: CollisionDetector;
  private renderer: Renderer;
  private players: Player[] = [];
  private running = false;

  constructor(container: HTMLElement, numPlayers: number = 2) {
    // Initialize renderer
    this.renderer = new Renderer(container);

    // Initialize managers
    this.inputManager = new InputManager();
    this.collisionDetector = new CollisionDetector(this.renderer);

    // Initialize game loop
    this.gameLoop = new GameLoop(
      (deltaTime) => this.update(deltaTime),
      () => this.render()
    );

    // Create players
    this.createPlayers(numPlayers);
  }

  /**
   * Create players with starting positions
   */
  private createPlayers(numPlayers: number): void {
    const playerNames = ['RED', 'GREEN', 'BLUE', 'YELLOW'];
    const colors = [
      PLAYER_COLORS.RED,
      PLAYER_COLORS.GREEN,
      PLAYER_COLORS.BLUE,
      PLAYER_COLORS.YELLOW,
    ];

    // Starting positions based on player count
    const positions: Array<{ x: number; y: number; dir: number }> = [];

    if (numPlayers === 2) {
      positions.push(
        { x: 50, y: 50, dir: -45000 }, // Top-left, facing SE
        { x: 700, y: 550, dir: 135000 } // Bottom-right, facing NW
      );
    } else if (numPlayers === 3) {
      positions.push(
        { x: 50, y: 50, dir: -45000 }, // Top-left
        { x: 700, y: 50, dir: 225000 }, // Top-right
        { x: 50, y: 550, dir: 45000 } // Bottom-left
      );
    } else {
      // 4 players (default)
      positions.push(
        { x: 50, y: 50, dir: -45000 }, // Top-left
        { x: 700, y: 50, dir: 225000 }, // Top-right
        { x: 50, y: 550, dir: 45000 }, // Bottom-left
        { x: 700, y: 550, dir: 135000 } // Bottom-right
      );
    }

    for (let i = 0; i < numPlayers; i++) {
      const pos = positions[i];
      if (!pos) continue;

      const player = new Player(
        `player-${i}`,
        playerNames[i] ?? `Player ${i}`,
        i,
        colors[i] ?? PLAYER_COLORS.RED,
        pos.x,
        pos.y,
        pos.dir
      );

      this.players.push(player);
    }
  }

  /**
   * Start the game
   */
  start(): void {
    if (this.running) return;

    this.running = true;
    this.gameLoop.start();
    console.log('🎮 Game started!');
  }

  /**
   * Stop the game
   */
  stop(): void {
    this.running = false;
    this.gameLoop.stop();
    console.log('🛑 Game stopped');
  }

  /**
   * Update game state
   */
  private update(_deltaTime: number): void {
    // Update player inputs
    for (const player of this.players) {
      if (!player.vivo) continue;

      const input = this.inputManager.getPlayerInput(player.num);
      player.turningLeft = input.left;
      player.turningRight = input.right;
      player.firing = input.fire;
    }

    // Store old positions for diagonal collision check
    const oldPositions = this.players.map((p) => ({ x: p.x, y: p.y }));

    // Update all players
    for (const player of this.players) {
      player.update();
    }

    // Check collisions and draw trails
    for (let i = 0; i < this.players.length; i++) {
      const player = this.players[i];
      if (!player) continue;

      if (player.vivo) {
        // Check for collisions at NEW position BEFORE drawing trail
        const collision = this.collisionDetector.checkPlayerCollision(player);

        const oldPos = oldPositions[i];
        let diagonalCollision = false;
        if (oldPos) {
          diagonalCollision = this.collisionDetector.checkDiagonalCollision(
            player,
            oldPos.x,
            oldPos.y
          );
        }

        if (collision || diagonalCollision) {
          player.vivo = false;
          console.log(`💥 ${player.name} crashed!`);
        } else {
          // Only draw trail if still alive and actually moved
          if (oldPos && (oldPos.x !== player.x || oldPos.y !== player.y)) {
            this.renderer.drawTrailPixel(oldPos.x, oldPos.y, player.color);
          }
        }
      }
    }

    // Check win condition
    const alivePlayers = this.players.filter((p) => p.vivo);
    if (alivePlayers.length <= 1) {
      if (alivePlayers.length === 1) {
        console.log(`🏆 ${alivePlayers[0]!.name} wins!`);
      } else {
        console.log('🤝 Draw!');
      }
      // Game over - could restart or show results
    }
  }

  /**
   * Render game state
   */
  private render(): void {
    this.renderer.render(this.players);
  }
}
