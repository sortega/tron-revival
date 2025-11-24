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
import { PLAYER_COLORS, SPAWN_POSITIONS, TRAIL_HEAD_COLOR } from '../constants';

type RoundState = 'playing' | 'waiting_for_ready';

export class Game {
  private gameLoop: GameLoop;
  private inputManager: InputManager;
  private collisionDetector: CollisionDetector;
  private renderer: Renderer;
  private audioManager: AudioManager;
  private players: Player[] = [];
  private running = false;

  // Round management
  private roundState: RoundState = 'playing';
  private scores: Map<number, number> = new Map(); // playerNum -> wins
  private muertesRidiculas: Map<number, number> = new Map(); // playerNum -> ridiculous deaths
  private playersReady: Set<number> = new Set(); // playerNums that are ready
  private lastWinner: Player | null = null; // Winner of last round (null = draw)
  private lastFireState: Map<number, boolean> = new Map(); // Track fire button state for toggle
  private trailHeads: Map<number, { x: number; y: number } | null> = new Map(); // Track trail head positions

  constructor(container: HTMLElement, numPlayers: number = 2) {
    // Initialize renderer
    this.renderer = new Renderer(container);

    // Initialize managers
    this.inputManager = new InputManager();
    this.collisionDetector = new CollisionDetector(this.renderer);
    this.audioManager = new AudioManager();

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
    if (this.roundState === 'waiting_for_ready') {
      // Check for ready inputs (toggle on fire press)
      for (const player of this.players) {
        const input = this.inputManager.getPlayerInput(player.num);
        const wasPressed = this.lastFireState.get(player.num) ?? false;

        // Detect fire button press (rising edge)
        if (input.fire && !wasPressed) {
          if (this.playersReady.has(player.num)) {
            this.playersReady.delete(player.num);
            console.log(`✗ ${player.name} is not ready`);
          } else {
            this.playersReady.add(player.num);
            console.log(`✓ ${player.name} is ready`);
          }
        }

        this.lastFireState.set(player.num, input.fire);
      }

      // Start next round if all players ready
      if (this.playersReady.size === this.players.length) {
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

          // Track muerte ridícula if player died on their own color
          if (collisionResult.ownColor) {
            const currentMR = this.muertesRidiculas.get(player.num) ?? 0;
            this.muertesRidiculas.set(player.num, currentMR + 1);
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
      this.endRound(alivePlayers);
    }
  }

  /**
   * End the current round and update scores
   */
  private endRound(alivePlayers: Player[]): void {
    if (alivePlayers.length === 1) {
      const winner = alivePlayers[0]!;
      this.lastWinner = winner;
      const currentScore = this.scores.get(winner.num) ?? 0;
      this.scores.set(winner.num, currentScore + 1);
      console.log(`🏆 ${winner.name} wins! Score: ${currentScore + 1}`);
    } else {
      this.lastWinner = null;
      console.log(`🤝 Draw!`);
    }

    this.roundState = 'waiting_for_ready';
    this.playersReady.clear();
    this.lastFireState.clear();
  }

  /**
   * Start a new round
   */
  private startNewRound(): void {
    console.log('🎮 Starting new round...');

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

    this.roundState = 'playing';
    this.playersReady.clear();
  }

  /**
   * Render game state
   */
  private render(): void {
    this.renderer.render(
      this.players,
      this.scores,
      this.muertesRidiculas,
      this.roundState,
      this.playersReady,
      this.lastWinner
    );
  }

  /**
   * Get the current round state (for external access)
   */
  getRoundState(): RoundState {
    return this.roundState;
  }
}
