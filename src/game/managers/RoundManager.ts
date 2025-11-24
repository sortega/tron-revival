/**
 * Round Manager
 * Handles round lifecycle, scoring, and ready-up system
 */

import type { Player } from '../entities/Player';

export type RoundState = 'playing' | 'waiting_for_ready';

export class RoundManager {
  private state: RoundState = 'playing';
  private scores: Map<number, number> = new Map(); // playerNum -> wins
  private muertesRidiculas: Map<number, number> = new Map(); // playerNum -> ridiculous deaths
  private playersReady: Set<number> = new Set();
  private lastWinner: Player | null = null;
  private lastFireState: Map<number, boolean> = new Map();

  /**
   * Get current round state
   */
  getState(): RoundState {
    return this.state;
  }

  /**
   * Get scores for all players
   */
  getScores(): Map<number, number> {
    return this.scores;
  }

  /**
   * Get muertes ridículas for all players
   */
  getMuertesRidiculas(): Map<number, number> {
    return this.muertesRidiculas;
  }

  /**
   * Get players who are ready
   */
  getPlayersReady(): Set<number> {
    return this.playersReady;
  }

  /**
   * Get last round winner
   */
  getLastWinner(): Player | null {
    return this.lastWinner;
  }

  /**
   * Handle ready-up input from players
   * Returns true if all players are ready
   */
  handleReadyInput(players: Player[], getInput: (playerNum: number) => { fire: boolean }): boolean {
    if (this.state !== 'waiting_for_ready') return false;

    // Check for ready inputs (toggle on fire press)
    for (const player of players) {
      const input = getInput(player.num);
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

    // Check if all players ready
    return this.playersReady.size === players.length;
  }

  /**
   * End the current round and update scores
   */
  endRound(alivePlayers: Player[], diedOnOwnColor: Map<number, boolean>): void {
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

    // Track muertes ridículas
    for (const [playerNum, ownColor] of diedOnOwnColor) {
      if (ownColor) {
        const currentMR = this.muertesRidiculas.get(playerNum) ?? 0;
        this.muertesRidiculas.set(playerNum, currentMR + 1);
      }
    }

    this.state = 'waiting_for_ready';
    this.playersReady.clear();
    this.lastFireState.clear();
  }

  /**
   * Start a new round
   */
  startNewRound(): void {
    console.log('🎮 Starting new round...');
    this.state = 'playing';
    this.playersReady.clear();
  }

  /**
   * Record a muerte ridícula for a player
   */
  recordMuerteRidicula(playerNum: number): void {
    const currentMR = this.muertesRidiculas.get(playerNum) ?? 0;
    this.muertesRidiculas.set(playerNum, currentMR + 1);
  }
}
