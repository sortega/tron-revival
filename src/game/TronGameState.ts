// TronGameState - Host-authoritative game state manager

import type { SlotIndex, GameMode } from '../types/lobby';
import type {
  TronRoundState,
  TronMatchState,
  TronGameStateData,
  TronInput,
  TrailSegment,
  RoundPhase,
} from '../types/game';
import type { GamePlayer } from '../types/game';
import { TronPlayer, getStartingPosition } from './TronPlayer';

const COUNTDOWN_SECONDS = 3;

// Helper: Check if two line segments intersect (for diagonal collision detection)
// Uses cross product method to detect if segments AB and CD intersect
function segmentsIntersect(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number
): boolean {
  // Direction vectors
  const abx = bx - ax, aby = by - ay;
  const cdx = dx - cx, cdy = dy - cy;
  const acx = cx - ax, acy = cy - ay;

  // Cross products
  const denom = abx * cdy - aby * cdx;

  // Parallel lines (including same line)
  if (denom === 0) return false;

  const t = (acx * cdy - acy * cdx) / denom;
  const u = (acx * aby - acy * abx) / denom;

  // Check if intersection point is within both segments (exclusive of endpoints)
  // Use small epsilon to avoid floating point issues at exact endpoints
  const eps = 0.001;
  return t > eps && t < 1 - eps && u > eps && u < 1 - eps;
}

export class TronGameState {
  // Players
  players: TronPlayer[] = [];

  // Round state
  phase: RoundPhase = 'countdown';
  countdown: number = COUNTDOWN_SECONDS;
  roundWinner: SlotIndex | 'draw' | null = null;

  // Match state
  scores: Map<SlotIndex, number> = new Map();
  currentRound: number = 1;
  playersReady: Set<SlotIndex> = new Set();
  gameMode: GameMode;

  // Trail collision tracking
  occupiedPixels: Set<string> = new Set();

  // New trail segments this frame (for network efficiency)
  private frameTrailSegments: Map<SlotIndex, TrailSegment[]> = new Map();

  // Track previous action state for one-shot ready detection
  private prevActionState: Map<SlotIndex, boolean> = new Map();

  // Player configs for restarting rounds
  private playerConfigs: GamePlayer[];

  constructor(playerConfigs: GamePlayer[], gameMode: GameMode) {
    this.playerConfigs = playerConfigs;
    this.gameMode = gameMode;

    // Initialize scores
    for (const config of playerConfigs) {
      this.scores.set(config.slotIndex, 0);
    }

    // Initialize players for first round
    this.initRound();
  }

  // Initialize/reset for a new round
  initRound(): void {
    this.phase = 'countdown';
    this.countdown = COUNTDOWN_SECONDS;
    this.roundWinner = null;
    this.occupiedPixels.clear();
    this.frameTrailSegments.clear();
    this.playersReady.clear();
    this.prevActionState.clear();

    const playerCount = this.playerConfigs.length;

    // Create or reset players
    if (this.players.length === 0) {
      // First time - create players
      this.playerConfigs.forEach((config, index) => {
        const startPos = getStartingPosition(index, playerCount);
        const player = new TronPlayer(
          config.slotIndex,
          startPos.x,
          startPos.y,
          startPos.direction,
          config.color,
          config.nickname
        );
        this.players.push(player);
      });
    } else {
      // Reset existing players
      this.players.forEach((player, index) => {
        const startPos = getStartingPosition(index, playerCount);
        player.reset(startPos.x, startPos.y, startPos.direction);
      });
    }
  }

  // Process one game tick (called at ~60fps by host)
  tick(inputs: Map<SlotIndex, TronInput>): void {
    // Clear frame trail segments
    this.frameTrailSegments.clear();

    switch (this.phase) {
      case 'countdown':
        this.tickCountdown();
        break;

      case 'playing':
        this.tickPlaying(inputs);
        break;

      case 'round_end':
        // Process ready signals during round_end (same as waiting_ready)
        this.tickWaitingReady(inputs);
        break;

      case 'waiting_ready':
        this.tickWaitingReady(inputs);
        break;
    }
  }

  private tickCountdown(): void {
    this.countdown -= 1 / 60; // Assuming 60fps

    if (this.countdown <= 0) {
      this.countdown = 0;
      this.phase = 'playing';
    }
  }

  private tickPlaying(inputs: Map<SlotIndex, TronInput>): void {
    // First, update all players and collect new trail segments
    const newSegmentsByPlayer: Map<SlotIndex, TrailSegment[]> = new Map();

    for (const player of this.players) {
      if (!player.alive) continue;

      const input = inputs.get(player.slotIndex) || { left: false, right: false, action: false };
      const newSegments = player.update(input);
      newSegmentsByPlayer.set(player.slotIndex, newSegments);
    }

    // Check collisions BEFORE adding new trail pixels
    // This allows players to collide with existing trails
    const dyingPlayers: Set<TronPlayer> = new Set();

    for (const player of this.players) {
      if (!player.alive) continue;

      if (player.checkCollision(this.occupiedPixels)) {
        dyingPlayers.add(player);
      }
    }

    // Check for diagonal crossings between players this frame
    // Two players moving diagonally can pass through each other if we only check pixels
    const alivePlayers = this.players.filter(p => p.alive);
    for (let i = 0; i < alivePlayers.length; i++) {
      const p1 = alivePlayers[i];
      if (!p1 || p1.prevScreenX < 0) continue;

      for (let j = i + 1; j < alivePlayers.length; j++) {
        const p2 = alivePlayers[j];
        if (!p2 || p2.prevScreenX < 0) continue;

        // Check if movement segments intersect
        if (segmentsIntersect(
          p1.prevScreenX, p1.prevScreenY, p1.getScreenX(), p1.getScreenY(),
          p2.prevScreenX, p2.prevScreenY, p2.getScreenX(), p2.getScreenY()
        )) {
          // Both players die on diagonal collision
          dyingPlayers.add(p1);
          dyingPlayers.add(p2);
        }
      }
    }

    // Now add new trail pixels to occupied set
    for (const player of this.players) {
      if (!player.alive) continue;

      const segments = newSegmentsByPlayer.get(player.slotIndex) || [];
      for (const seg of segments) {
        this.occupiedPixels.add(`${seg.x},${seg.y}`);
      }

      // Store for network transmission
      if (segments.length > 0) {
        this.frameTrailSegments.set(player.slotIndex, segments);
      }
    }

    // Kill players that collided
    for (const player of dyingPlayers) {
      player.kill();
    }

    // Check win condition
    this.checkRoundEnd();
  }

  private tickWaitingReady(inputs: Map<SlotIndex, TronInput>): void {
    // Check for action key presses (one-shot: only on rising edge)
    for (const [slotIndex, input] of inputs) {
      const wasPressed = this.prevActionState.get(slotIndex) || false;
      const isPressed = input.action;

      // Toggle ready on rising edge (key just pressed)
      if (isPressed && !wasPressed) {
        if (this.playersReady.has(slotIndex)) {
          this.playersReady.delete(slotIndex);
        } else {
          this.playersReady.add(slotIndex);
        }
      }

      // Update previous state
      this.prevActionState.set(slotIndex, isPressed);
    }

    // Check if all players are ready
    if (this.playersReady.size >= this.players.length) {
      this.currentRound++;
      this.initRound();
    }
  }

  private checkRoundEnd(): void {
    const alivePlayers = this.players.filter(p => p.alive);

    if (this.gameMode === 'ffa') {
      // FFA: Last player standing wins
      if (alivePlayers.length <= 1) {
        this.endRound(alivePlayers);
      }
    } else {
      // Team mode: Check if either team is eliminated
      const team1Alive = alivePlayers.some(p => p.slotIndex % 2 === 0); // Slots 0, 2
      const team2Alive = alivePlayers.some(p => p.slotIndex % 2 === 1); // Slots 1, 3

      if (!team1Alive || !team2Alive) {
        this.endRound(alivePlayers);
      }
    }
  }

  private endRound(alivePlayers: TronPlayer[]): void {
    this.phase = 'round_end';

    const winner = alivePlayers[0];
    if (!winner) {
      // Draw - no points (no alive players)
      this.roundWinner = 'draw';
    } else if (this.gameMode === 'ffa') {
      // FFA: Winner is the last alive player
      this.roundWinner = winner.slotIndex;
      this.scores.set(winner.slotIndex, (this.scores.get(winner.slotIndex) || 0) + 1);
    } else {
      // Team mode: Winning team members all get a point
      const winningTeam = winner.slotIndex % 2; // 0 for team 1, 1 for team 2
      this.roundWinner = winner.slotIndex; // Representative winner

      // Award points to all team members
      for (const player of this.players) {
        if (player.slotIndex % 2 === winningTeam) {
          this.scores.set(player.slotIndex, (this.scores.get(player.slotIndex) || 0) + 1);
        }
      }
    }

    // Transition to waiting after a brief delay
    // In the actual implementation, this happens after some frames
    // Note: Don't clear playersReady here - players can signal ready during round_end
    // and their status should be preserved. playersReady is cleared in initRound().
    setTimeout(() => {
      if (this.phase === 'round_end') {
        this.phase = 'waiting_ready';
      }
    }, 2000);
  }

  // Serialize for network transmission
  serialize(): TronGameStateData {
    const roundState: TronRoundState = {
      phase: this.phase,
      players: this.players.map(p => p.serialize()),
      countdown: this.countdown,
      roundWinner: this.roundWinner,
    };

    const matchState: TronMatchState = {
      scores: Object.fromEntries(this.scores),
      currentRound: this.currentRound,
      playersReady: Array.from(this.playersReady),
      gameMode: this.gameMode,
    };

    const newTrailSegments = Array.from(this.frameTrailSegments.entries()).map(
      ([slotIndex, segments]) => ({ slotIndex, segments })
    );

    return {
      round: roundState,
      match: matchState,
      newTrailSegments,
    };
  }

  // Update from network state (for guests)
  updateFromState(state: TronGameStateData): void {
    // Update round state
    this.phase = state.round.phase;
    this.countdown = state.round.countdown;
    this.roundWinner = state.round.roundWinner;

    // Update player states
    for (const playerState of state.round.players) {
      const player = this.players.find(p => p.slotIndex === playerState.slotIndex);
      if (player) {
        player.updateFromState(playerState);
      }
    }

    // Update match state
    this.currentRound = state.match.currentRound;
    this.gameMode = state.match.gameMode;
    this.playersReady = new Set(state.match.playersReady as SlotIndex[]);

    for (const [slot, score] of Object.entries(state.match.scores)) {
      this.scores.set(Number(slot) as SlotIndex, score);
    }

    // Add new trail segments
    for (const { slotIndex, segments } of state.newTrailSegments) {
      const player = this.players.find(p => p.slotIndex === slotIndex);
      if (player) {
        for (const seg of segments) {
          player.trail.push(seg);
          this.occupiedPixels.add(`${seg.x},${seg.y}`);
        }
      }
    }
  }
}
