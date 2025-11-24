/**
 * Main Game Class
 * Orchestrates the game loop, players, and rendering
 */

import { GameLoop } from './engine/GameLoop';
import { InputManager } from './engine/InputManager';
import { CollisionDetector } from './engine/CollisionDetector';
import { Player } from './entities/Player';
import { Renderer } from '../render/Renderer';
import { AudioManager } from '../audio/AudioManager';
import { RoundManager } from './managers/RoundManager';
import { PLAYER_COLORS, SPAWN_POSITIONS, TRAIL_HEAD_COLOR } from '../constants';

export class Game {
  private gameLoop: GameLoop;
  private inputManager: InputManager;
  private collisionDetector: CollisionDetector;
  private renderer: Renderer;
  private audioManager: AudioManager;
  private roundManager: RoundManager;
  private players: Player[] = [];
  private running = false;

  // Trail management
  private trailHeads: Map<number, { x: number; y: number } | null> = new Map();

  constructor(container: HTMLElement, numPlayers: number = 2) {
    // Initialize renderer
    this.renderer = new Renderer(container);

    // Initialize managers
    this.inputManager = new InputManager();
    this.collisionDetector = new CollisionDetector(this.renderer);
    this.audioManager = new AudioManager();
    this.roundManager = new RoundManager();

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

    // Get starting positions from configuration
    const positions = SPAWN_POSITIONS[numPlayers] || SPAWN_POSITIONS[4]!;

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

    // Play initial round sound
    this.audioManager.play('inicio');

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
    if (this.roundManager.getState() === 'waiting_for_ready') {
      // Handle ready-up system
      const allReady = this.roundManager.handleReadyInput(
        this.players,
        (playerNum) => this.inputManager.getPlayerInput(playerNum)
      );

      if (allReady) {
        this.startNewRound();
      }
      return;
    }

    // Update player inputs
    for (const player of this.players) {
      if (!player.alive) continue;

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

    // Track collision details for round end
    const collisionDetails = new Map<number, boolean>();

    // Check for player-to-player path crossings FIRST
    for (let i = 0; i < this.players.length; i++) {
      for (let j = i + 1; j < this.players.length; j++) {
        const player1 = this.players[i];
        const player2 = this.players[j];
        const oldPos1 = oldPositions[i];
        const oldPos2 = oldPositions[j];

        if (player1 && player2 && oldPos1 && oldPos2) {
          const crossed = this.collisionDetector.checkPlayersCrossing(
            player1,
            oldPos1.x,
            oldPos1.y,
            player2,
            oldPos2.x,
            oldPos2.y
          );

          if (crossed) {
            // Both players die when they cross paths
            player1.alive = false;
            player2.alive = false;
            this.trailHeads.delete(player1.num);
            this.trailHeads.delete(player2.num);
            console.log(`💥 ${player1.name} and ${player2.name} crossed paths!`);
          }
        }
      }
    }

    // Check collisions and draw trails
    for (let i = 0; i < this.players.length; i++) {
      const player = this.players[i];
      if (!player) continue;

      if (player.alive) {
        // Check for collisions at NEW position BEFORE drawing trail
        const collisionResult = this.collisionDetector.checkPlayerCollision(player);

        const oldPos = oldPositions[i];
        let diagonalCollision = false;

        if (oldPos) {
          diagonalCollision = this.collisionDetector.checkDiagonalCollision(
            player,
            oldPos.x,
            oldPos.y
          );
        }

        if (collisionResult.collision || diagonalCollision) {
          player.alive = false;

          // Clear trail head tracking for dead player
          this.trailHeads.delete(player.num);

          // Track if player died on own color
          collisionDetails.set(player.num, collisionResult.ownColor);

          // Log crash
          if (collisionResult.ownColor) {
            console.log(`💥 ${player.name} crashed on their own trail! (Muerte Ridícula)`);
          } else {
            console.log(`💥 ${player.name} crashed!`);
          }
        } else {
          // Only draw trail if still alive and actually moved
          if (oldPos && (oldPos.x !== player.x || oldPos.y !== player.y)) {
            // Get previous trail head position
            const prevHead = this.trailHeads.get(player.num);

            // If there's a previous white head, convert it to colored
            if (prevHead) {
              this.renderer.drawTrailPixel(prevHead.x, prevHead.y, player.color);
            }

            // Draw new white pixel at old position
            this.renderer.drawTrailPixel(oldPos.x, oldPos.y, TRAIL_HEAD_COLOR);

            // Update trail head tracking
            this.trailHeads.set(player.num, { x: oldPos.x, y: oldPos.y });
          }
        }
      }
    }

    // Check win condition
    const alivePlayers = this.players.filter((p) => p.alive);
    if (alivePlayers.length <= 1) {
      this.roundManager.endRound(alivePlayers, collisionDetails);
    }
  }

  /**
   * Start a new round
   */
  private startNewRound(): void {
    this.roundManager.startNewRound();

    // Play round start sound
    this.audioManager.play('inicio');

    // Clear trails and trail head tracking
    this.renderer.clearTrails();
    this.trailHeads.clear();

    // Reset players to starting positions
    const positions = SPAWN_POSITIONS[this.players.length] || SPAWN_POSITIONS[4]!;

    for (let i = 0; i < this.players.length; i++) {
      const player = this.players[i];
      const pos = positions[i];
      if (!player || !pos) continue;

      player.reset(pos);
    }
  }

  /**
   * Render game state
   */
  private render(): void {
    this.renderer.render(
      this.players,
      this.roundManager.getScores(),
      this.roundManager.getMuertesRidiculas(),
      this.roundManager.getState(),
      this.roundManager.getPlayersReady(),
      this.roundManager.getLastWinner()
    );
  }

  /**
   * Get the current round state (for external access)
   */
  getRoundState() {
    return this.roundManager.getState();
  }
}
