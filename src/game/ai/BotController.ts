// BotController - computer-controlled player.
// Produces a TronInput per tick from what is visible on screen; it has no powers a
// human lacks. See design/local-and-ai.md.

import type { SlotIndex } from '../../types/lobby';
import type { BotDifficulty, GameItem, TeleportPortal, TronInput } from '../../types/game';
import { ITEM_COLLISION_RADIUS, PORTAL_OUTER_RADIUS, PORTAL_RADIUS } from '../../types/game';
import { PLAY_HEIGHT, PLAY_WIDTH } from '../constants';
import { COARSE_CELL, COARSE_COLS, COARSE_ROWS } from '../PixelGrid';
import type { PixelGrid } from '../PixelGrid';
import type { Rng } from '../rng';
import type { TronGameState } from '../TronGameState';
import type { TronPlayer } from '../TronPlayer';
import { anyDoorSolidAt, doorFrame, doorZones } from '../doors';
import type { DoorDefinition } from '../doors';
import { inFireZone } from '../guns';
import type { GunDefinition } from '../guns';
import { LEVELS } from '../../types/game';
import { firesTracers, lineOfFire, stance, worthFiringAt } from './matchups';
import type { Fighter, Stance } from './matchups';
import { TerritorySense } from './territorySense';
import type { TerritoryUse } from './territorySense';

const TURN_DEG = 4;                  // Degrees per step at full lock (matches TronPlayer)
const DEG = Math.PI / 180;
/** Keep this far from an enemy that has satellites (their area of action plus a margin). */
const GUARDED_RADIUS = 56;
const FIRE_ZONE_STEPS = 80;          // How far ahead bots mind the level guns' fire zones
const DOOR_MARGIN_TICKS = 25;        // Doors must stay open this long after we pass
const FLEE_RANGE = 180;              // Run from an enemy we should avoid when it is this close
const FLEE_DISTANCE = 150;           // ...towards a point this far away, directly opposite

export interface BotProfile {
  lookahead: number;        // Max rollout length in pixels
  replanTicks: number;      // Re-evaluate steering every N ticks
  clearanceSteps: number;   // How far along a path the bot checks for room to turn (0 = never)
  areaAware: boolean;       // Avoids manoeuvres that end in an enclosed pocket
  escapes: boolean;         // Plans a second turn to get out of a blocked path
  mistakeChance: number;    // Chance per plan of steering randomly
  itemInterest: number;     // Probability of caring about an item when choosing a goal
  weapons: 'panic' | 'full';
  avoidsHazards: boolean;   // Enemy heads and bodyguards
  hunts: boolean;           // Chases enemies when there is nothing better to do
  usesTurbo: boolean;
  knowsMatchups: boolean;   // Seeks, avoids and holds fire according to weapons and satellites
  reverseReactionTicks: number; // Ticks needed to adapt to Control Reversal
  /** Keep this many pixels between the path and anything solid (design/bots-human.md); default 0. */
  sideMargin?: number;
  /** Extra room (px) given to enemy heads, whose position is not known exactly; default 0. */
  headMargin?: number;
  territory: TerritoryUse | null; // How it reads the territory map (design/bots-territory.md)
}

export const BOT_PROFILES: Record<BotDifficulty, BotProfile> = {
  easy: {
    lookahead: 60, replanTicks: 6, clearanceSteps: 0, areaAware: false, escapes: false, mistakeChance: 0.04, itemInterest: 0.4,
    weapons: 'panic', avoidsHazards: false, hunts: false, usesTurbo: false, knowsMatchups: false, reverseReactionTicks: 25,
    territory: null,
  },
  normal: {
    lookahead: 130, replanTicks: 3, clearanceSteps: 60, areaAware: true, escapes: true, mistakeChance: 0.003, itemInterest: 1,
    weapons: 'full', avoidsHazards: true, hunts: false, usesTurbo: false, knowsMatchups: true, reverseReactionTicks: 6,
    territory: { roomCap: 400, foeWeight: 1, fills: false, riskWeight: 0, racesForItems: true, intercepts: false, expands: false },
  },
  hard: {
    lookahead: 180, replanTicks: 2, clearanceSteps: 110, areaAware: true, escapes: true, mistakeChance: 0, itemInterest: 1,
    weapons: 'full', avoidsHazards: true, hunts: true, usesTurbo: true, knowsMatchups: true, reverseReactionTicks: 0,
    territory: { roomCap: 1400, foeWeight: 1, fills: true, riskWeight: 0, racesForItems: true, intercepts: true, expands: false },
  },
};

// Candidate manoeuvres: steer for `turnSteps` steps, then go straight
const TURN_STEPS = [3, 8, 22, 45]; // ≈ 12°, 32°, 88°, 180°
const CANDIDATES: { steer: number; turnSteps: number }[] = [
  { steer: 0, turnSteps: 0 },
  ...TURN_STEPS.flatMap(turnSteps => [{ steer: -1, turnSteps }, { steer: 1, turnSteps }]),
];

const ESCAPE_ROOM = 24;               // Start the second turn this many steps before an obstacle
const ESCAPE_TURNS = [22, 45];       // ≈ 90° and 180°
const ESCAPE_STEERS = [-1, 1];
const CHECKPOINT_EVERY = 8;
const COARSE_SHIFT = Math.log2(COARSE_CELL);
const PORTAL_RADIUS_SQ = PORTAL_RADIUS * PORTAL_RADIUS;
const GOAL_SAFE_DIST = 90;           // A path must be at least this long to chase a goal on it
const SIDE_RANGE = 31;                // Lateral room needed for a U-turn (turn diameter ≈ 29px)
const SIDE_SAMPLES = [2, 4, 7, 10, 13, 17, 21, 25, 29];
const AREA_CAP = 400;                 // Flood-fill limit in coarse cells (≈ 160×160 px): "plenty of room"
const AREA_PROBE = 12;                // Where, ahead of a path's end, the flood fill starts
const AREA_PROBE_OFFSETS = [0, -50, 50, -100, 100];
const NEIGHBOUR_DX = [1, -1, 0, 0];
const NEIGHBOUR_DY = [0, 0, 1, -1];
const PROBE_STEP = 50;               // Where along a path progress towards the goal is measured
const OPENNESS_RAYS = [-70, -35, 0, 35, 70];
const OPENNESS_RANGE = 40;
const BAD_ITEMS = new Set(['reverse', 'automatic_slow']);
const MARGIN_FROM = 3;               // `sideMargin` is minded between these steps of a path:
const MARGIN_STEPS = 40;             // what is nearer cannot be helped, what is further will be re-planned
const MARGIN_PENALTY = 6;            // Cost of each step that passes too close...
const MARGIN_SHARE = 12;             // ...for up to 1/12 of the lookahead: a tight path still beats a much shorter one

interface Hazard {
  x: number;
  y: number;
  vx: number;   // px per step
  vy: number;
  radius: number;
  maxStep: number; // Only relevant for the first N steps
}

// The cone in front of an armed enemy
interface LineOfFire {
  x: number;
  y: number;
  direction: number;  // Degrees
  range: number;
  halfAngle: number;
  weight: number;     // Penalty per sampled step inside it
}

// An enemy as the bot sees it
interface EnemyView {
  player: TronPlayer;
  dx: number;         // Shortest way to it (the arena wraps)
  dy: number;
  dist: number;
  fighter: Fighter;
  stance: Stance;
}

// Everything a rollout needs to know about the world, gathered once per decision
interface PlanContext {
  pixels: PixelGrid;
  me: TronPlayer;
  hazards: Hazard[];
  ignoreSteps: number;     // Steps during which trails cannot hurt us (shield)
  crossingSteps: number;   // Steps during which our own colour is passable (crossing)
  badItems: GameItem[];
  portals: readonly TeleportPortal[];
  doors: readonly DoorDefinition[] | null;  // Automatic doors of the level, if any
  doorZone: Uint8Array | null;              // Where a door can be at all (see doorZones)
  doorTick: number;
  guns: readonly GunDefinition[] | null;    // Level guns whose fire zones are best avoided
  linesOfFire: LineOfFire[];                // Armed enemies' cones, likewise
}

// A point along a simulated path from which a rollout can (re)start
interface PathState {
  x: number;
  y: number;
  dir: number;
  step: number;
  portalCooldown: number;
  cells: number[] | null;  // Coarse cells visited so far: the first `cellCount` of these
  cellCount: number;
}

interface Rollout {
  dist: number;      // Steps travelled before hitting something (or lookahead)
  narrow: number;    // Penalty for stretches without room to turn away (corridors, wall-hugging)
  probeX: number;    // Position at PROBE_STEP (or the last position)
  probeY: number;
  endX: number;
  endY: number;
  endDir: number;
  badItem: boolean;  // Path picks up an item the bot does not want
  cells: number[];   // Coarse cells the path goes through, in order
}

function wrapX(x: number): number {
  return ((x % PLAY_WIDTH) + PLAY_WIDTH) % PLAY_WIDTH;
}

function wrapY(y: number): number {
  return ((y % PLAY_HEIGHT) + PLAY_HEIGHT) % PLAY_HEIGHT;
}

/** Shortest signed delta on a wrapping axis. */
function wrapDelta(d: number, size: number): number {
  if (d > size / 2) return d - size;
  if (d < -size / 2) return d + size;
  return d;
}

function wrappedDist(x1: number, y1: number, x2: number, y2: number): number {
  return Math.hypot(wrapDelta(x2 - x1, PLAY_WIDTH), wrapDelta(y2 - y1, PLAY_HEIGHT));
}

/** Smallest signed angle (degrees) from heading `from` to heading `to`. */
function angleDiff(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

export class BotController {
  readonly slot: SlotIndex;
  readonly profile: BotProfile;
  private readonly rng: Rng;

  private tick = 0;
  private steer = 0;
  private ticksSincePlan = Infinity;
  private reverseTicks = 0;      // How long Control Reversal has been active
  private weaponHeldTicks = 0;   // How long the current weapon has been carried
  private lastWeapon: string | null = null;
  private goalItemId: number | null = null;
  private enemies: EnemyView[] = [];  // Refreshed every decision
  private readonly scores: number[] = [];  // Of the candidates of the current plan
  /** How this bot reads the territory map; null if its profile does not. */
  readonly sense: TerritorySense | null;

  // Scratch buffers for flood fills
  private floodGen = 0;
  private readonly floodMark = new Uint32Array(COARSE_COLS * COARSE_ROWS);
  private readonly floodQueue = new Int32Array(AREA_CAP + 8);

  /** Set to an array to collect a per-candidate breakdown of each plan (debugging). */
  trace: string[] | null = null;

  /** What the last plan was heading for, for tests and tuning. */
  goalKind: 'item' | 'seek' | 'flee' | 'expand' | null = null;

  /** Details of the last plan, for tests and tuning. */
  debug = { score: 0, dist: 0, steer: 0, turnSteps: 0, straightFree: 0 };

  constructor(slot: SlotIndex, difficulty: BotDifficulty | BotProfile, rng: Rng = Math.random) {
    this.slot = slot;
    this.profile = typeof difficulty === 'string' ? BOT_PROFILES[difficulty] : difficulty;
    this.rng = rng;
    this.sense = this.profile.territory ? new TerritorySense(this.profile.territory) : null;
  }

  decide(game: TronGameState): TronInput {
    this.tick++;
    const me = game.players.find(p => p.slotIndex === this.slot);
    if (!me) return { steer: 0, action: false };

    if (game.phase === 'waiting_ready') {
      this.resetRound();
      // Ready toggles on a rising edge: tap now and then until we are marked ready
      const ready = game.playersReady.has(this.slot);
      return { steer: 0, action: !ready && this.tick % 20 === 0 };
    }
    if (game.phase !== 'playing' || !me.alive) {
      // (the countdown is the time to build the territory map: nothing else is going on)
      if (game.phase === 'countdown') this.sense?.begin(game, this.slot, me.activeEffects);
      this.resetRound();
      return { steer: 0, action: false };
    }

    const x = me.x / 1000;
    const y = me.y / 1000;
    this.enemies = this.lookAround(game, me, x, y);
    this.sense?.begin(game, this.slot, me.activeEffects);
    const ctx = this.makeContext(game, me);
    const start: PathState = { x, y, dir: me.direction, step: 0, portalCooldown: 0, cells: null, cellCount: 0 };

    // Emergency: something right ahead on the current course -> plan now
    const ahead = this.rollout(ctx, start, this.steer, 2, 16);
    this.ticksSincePlan++;
    let straightFree: number | null = null;
    if (this.ticksSincePlan >= this.profile.replanTicks || ahead.dist < 16) {
      straightFree = this.plan(game, ctx, start);
      this.ticksSincePlan = 0;
    }
    // (only weapons care how far it is clear ahead)
    if (straightFree === null) {
      straightFree = me.equippedWeapon ? this.rollout(ctx, start, 0, 0, this.profile.lookahead).dist : 0;
    }

    const action = this.decideAction(game, me, x, y, straightFree);

    // Control Reversal flips the steering inside the simulation; compensate once
    // the bot has "noticed"
    let steer = this.steer;
    if (me.hasEffect('reverse')) {
      this.reverseTicks++;
      if (this.reverseTicks > this.profile.reverseReactionTicks) steer = -steer;
    } else {
      this.reverseTicks = 0;
    }

    return { steer, action };
  }

  private resetRound(): void {
    this.steer = 0;
    this.ticksSincePlan = Infinity;
    this.reverseTicks = 0;
    this.weaponHeldTicks = 0;
    this.lastWeapon = null;
    this.goalItemId = null;
  }

  // === Steering ===

  private makeContext(game: TronGameState, me: TronPlayer): PlanContext {
    const shield = me.activeEffects.find(e => e.sprite === 'shield');
    const crossing = me.activeEffects.find(e => e.sprite === 'crossing');
    const doors = LEVELS[game.currentLevelIndex]?.doors ?? null;
    return {
      pixels: game.pixels,
      me,
      hazards: this.profile.avoidsHazards ? this.collectHazards(game, me) : [],
      // Steps during which trails cannot hurt us, leaving a safety buffer
      ignoreSteps: shield ? Math.max(0, shield.remainingFrames - 30) : 0,
      crossingSteps: crossing ? Math.max(0, crossing.remainingFrames - 30) : 0,
      badItems: game.items.filter(i => i.active && !i.mystery && BAD_ITEMS.has(i.sprite)),
      portals: game.portals,
      doors,
      doorZone: doors ? doorZones(doors, PLAY_WIDTH, PLAY_HEIGHT) : null,
      doorTick: game.doorTick,
      guns: this.profile.avoidsHazards ? LEVELS[game.currentLevelIndex]?.guns ?? null : null,
      linesOfFire: this.linesOfFire(),
    };
  }

  // The enemies, with what each carries and how to treat it (design/local-and-ai.md)
  private lookAround(game: TronGameState, me: TronPlayer, x: number, y: number): EnemyView[] {
    const satellites = new Map<number, number>();
    for (const bg of game.getBodyguards()) satellites.set(bg.ownerSlot, (satellites.get(bg.ownerSlot) ?? 0) + 1);
    const mine: Fighter = { weapon: me.equippedWeapon?.sprite ?? null, satellites: satellites.get(me.slotIndex) ?? 0 };
    const team = game.gameMode === 'team';
    const enemies: EnemyView[] = [];
    for (const p of game.players) {
      if (!p.alive || p.slotIndex === me.slotIndex) continue;
      if (team && p.slotIndex % 2 === me.slotIndex % 2) continue;
      const dx = wrapDelta(p.x / 1000 - x, PLAY_WIDTH);
      const dy = wrapDelta(p.y / 1000 - y, PLAY_HEIGHT);
      const fighter: Fighter = { weapon: p.equippedWeapon?.sprite ?? null, satellites: satellites.get(p.slotIndex) ?? 0 };
      enemies.push({
        player: p, dx, dy, dist: Math.hypot(dx, dy), fighter,
        stance: this.profile.knowsMatchups ? stance(mine, fighter) : 'neutral',
      });
    }
    return enemies.sort((a, b) => a.dist - b.dist);
  }

  private linesOfFire(): LineOfFire[] {
    if (!this.profile.knowsMatchups) return [];
    const lines: LineOfFire[] = [];
    for (const enemy of this.enemies) {
      const cone = lineOfFire(enemy.fighter.weapon);
      if (!cone) continue;
      lines.push({
        x: enemy.player.x / 1000, y: enemy.player.y / 1000, direction: enemy.player.direction,
        ...cone, weight: enemy.stance === 'avoid' ? 4 : 2,
      });
    }
    return lines;
  }

  /** Choose `this.steer`. Returns the free distance straight ahead. */
  private plan(game: TronGameState, ctx: PlanContext, start: PathState): number {
    const { profile } = this;
    const goal = this.chooseGoal(game, ctx.me, start.x, start.y);
    const goalDist = goal ? wrappedDist(start.x, start.y, goal.x, goal.y) : 0;
    const checkpoints: PathState[] = [];

    let best = -Infinity;
    let bestSteer = 0;
    let straightFree = 0;
    this.scores.length = 0;

    for (const cand of CANDIDATES) {
      checkpoints.length = 0;
      const r = this.rollout(ctx, start, cand.steer, cand.turnSteps, profile.lookahead, Infinity, 0, 0, checkpoints);
      if (cand.steer === 0) straightFree = r.dist;

      // If this manoeuvre runs into something, see whether a second turn shortly
      // before the obstacle gets out of it. A path that needs a precise second turn
      // is worth a bit less than one that is simply clear.
      // (Only when the second turn starts later: "turn right now" is already covered
      // by the plain candidates, and must not be credited to this one.)
      let dist = r.dist;
      let end = r;
      const turnAt = r.dist - ESCAPE_ROOM;
      if (profile.escapes && r.dist < profile.lookahead && turnAt >= cand.turnSteps + 6) {
        // Resume from the last checkpoint before the second turn
        let resume = start;
        for (const cp of checkpoints) {
          if (cp.step <= turnAt) resume = cp; else break;
        }
        for (const steer2 of ESCAPE_STEERS) {
          for (const steps2 of ESCAPE_TURNS) {
            const r2 = this.rollout(ctx, resume, cand.steer, cand.turnSteps, profile.lookahead, turnAt, steer2, steps2);
            const d2 = r.dist + (r2.dist - r.dist) * 0.85;
            if (r2.dist > r.dist && d2 > dist) {
              dist = d2;
              end = r2;
            }
          }
        }
      }

      let score = dist - r.narrow * 0.5;
      if (end.dist >= profile.lookahead) {
        // Survived the whole lookahead: prefer ending somewhere open
        score += this.openness(ctx.pixels, end.endX, end.endY, end.endDir) * 0.6;
      }
      // How much room is left once this path has been driven (its own trail included)?
      if (profile.areaAware && ctx.ignoreSteps === 0) {
        if (this.sense) {
          // ...counting who gets to it first (design/bots-territory.md)
          const worth = this.sense.judge(ctx.pixels, end.cells, end.endX, end.endY, end.endDir, end.dist);
          score += worth.bonus - (1 - worth.room) * profile.lookahead;
          this.trace?.push(`${cand.steer}/${cand.turnSteps}: room=${worth.room.toFixed(2)} bonus=${worth.bonus.toFixed(0)}`);
        } else {
          const area = this.freeAreaAfter(ctx.pixels, end);
          score -= (1 - area / AREA_CAP) * profile.lookahead;
        }
      }
      if (r.badItem) score -= 40;
      // Goals only matter on paths that are safe well beyond the goal itself
      if (goal && r.dist >= Math.min(profile.lookahead, GOAL_SAFE_DIST)) {
        // Progress towards the goal after PROBE_STEP steps
        score += (goalDist - wrappedDist(r.probeX, r.probeY, goal.x, goal.y)) * 0.8;
      }
      // Stability: keep doing what we were doing; mild preference for straight
      if (cand.steer === this.steer) score += 2;
      if (cand.steer === 0) score += 1;
      // Gentle manoeuvres first among equals
      score -= cand.turnSteps * 0.02;

      this.trace?.push(`${cand.steer}/${cand.turnSteps}: dist=${r.dist} best=${dist.toFixed(0)} narrow=${r.narrow} end=${end.endX.toFixed(0)},${end.endY.toFixed(0)} score=${score.toFixed(1)}`);
      if (score > best) {
        best = score;
        bestSteer = cand.steer;
        this.debug = { score, dist, steer: cand.steer, turnSteps: cand.turnSteps, straightFree: 0 };
      }
      this.scores.push(score);
    }
    // The best path's room may have to be counted further (design/bots-territory.md)
    if (this.sense) {
      const pick = CANDIDATES[this.sense.review(this.scores, profile.lookahead)]!;
      bestSteer = pick.steer;
      this.trace?.push(`pick ${pick.steer}/${pick.turnSteps} scores ${this.scores.map(s => s.toFixed(0)).join(' ')}`);
    }

    if (profile.mistakeChance > 0 && this.rng() < profile.mistakeChance) {
      bestSteer = Math.floor(this.rng() * 3) - 1;
    }
    this.steer = bestSteer;
    this.debug.straightFree = straightFree;
    return straightFree;
  }

  /**
   * Simulate driving from `start`: steer for `turnSteps` steps (counted from step 0),
   * then straight, until a collision or `maxSteps`. Optionally a second turn of
   * `turn2Steps` steps begins after step `turn2At`. Mirrors the real movement and
   * collision rules. With `checkpoints`, the state is saved every CHECKPOINT_EVERY
   * steps so that variations of the path can resume from the middle (`start.step`).
   */
  private rollout(
    ctx: PlanContext, start: PathState,
    steer: number, turnSteps: number, maxSteps: number,
    turn2At = Infinity, steer2 = 0, turn2Steps = 0,
    checkpoints: PathState[] | null = null
  ): Rollout {
    const { pixels, hazards, ignoreSteps, crossingSteps, badItems, portals, doors, doorZone, doorTick, guns, linesOfFire } = ctx;
    const grid = pixels.cells;
    // Our own colour in the grid, while it is passable (crossing)
    const ownColor = crossingSteps > 0 ? pixels.paletteIndexOf(ctx.me.color) : -1;
    const clearanceSteps = this.profile.clearanceSteps;
    const sideMargin = this.profile.sideMargin ?? 0;
    const maxTight = Math.round(this.profile.lookahead / MARGIN_SHARE);
    let { x, y, dir } = start;
    let portalCooldown = start.portalCooldown;
    let px = Math.floor(x);
    let py = Math.floor(y);
    let narrow = 0;
    let tight = 0;
    let probeX = x;
    let probeY = y;
    let badItem = false;
    const cells: number[] = start.cells ? start.cells.slice(0, start.cellCount) : [];
    let lastCell = cells.length > 0 ? cells[cells.length - 1]! : -1;
    let step = start.step;
    let cos = Math.cos(dir * DEG);
    let sin = Math.sin(dir * DEG);

    // A door pixel counts if it is solid when we get there or shortly after (we may be
    // slower than one step per tick, and should not cut it fine). The door frames are
    // worked out once per step, and only for pixels where a door can be at all.
    let framesOfStep = -1;
    let frameNow = 0;
    let frameSoon = 0;
    const doorBlocked = (bx: number, by: number): boolean => {
      if (doors === null) return false;
      if (bx >= 0 && by >= 0 && bx < PLAY_WIDTH && by < PLAY_HEIGHT && doorZone![by * PLAY_WIDTH + bx] === 0) return false;
      if (framesOfStep !== step) {
        framesOfStep = step;
        frameNow = doorFrame(doorTick + step);
        frameSoon = doorFrame(doorTick + step + DOOR_MARGIN_TICKS);
      }
      return anyDoorSolidAt(doors, frameNow, bx, by) ||
        (frameSoon !== frameNow && anyDoorSolidAt(doors, frameSoon, bx, by));
    };

    const blocked = (bx: number, by: number): boolean => {
      if (doors !== null && doorBlocked(bx, by)) return true;
      if (bx < 0 || by < 0 || bx >= PLAY_WIDTH || by >= PLAY_HEIGHT) return false;
      const value = grid[by * PLAY_WIDTH + bx]!;
      if (value === 0) return false;
      return !(step < crossingSteps && value === ownColor);
    };

    for (step = start.step + 1; step <= maxSteps; step++) {
      let turning = 0;
      if (step <= turnSteps) turning = steer;
      else if (step > turn2At && step <= turn2At + turn2Steps) turning = steer2;
      if (turning !== 0) {
        dir = (dir + turning * TURN_DEG + 360) % 360;
        cos = Math.cos(dir * DEG);
        sin = Math.sin(dir * DEG);
      }
      x += cos;
      y += sin;
      if (x < 0) x += PLAY_WIDTH; else if (x >= PLAY_WIDTH) x -= PLAY_WIDTH;
      if (y < 0) y += PLAY_HEIGHT; else if (y >= PLAY_HEIGHT) y -= PLAY_HEIGHT;
      const nx = Math.floor(x);
      const ny = Math.floor(y);

      if (nx !== px || ny !== py) {
        if (step <= ignoreSteps && doorBlocked(nx, ny)) break; // No shield against doors
        if (step > ignoreSteps) {
          if (blocked(nx, ny)) break;
          const dx = nx - px;
          const dy = ny - py;
          // Diagonal step: the two pixels we squeeze between also count
          if (dx !== 0 && dy !== 0 && Math.abs(dx) === 1 && Math.abs(dy) === 1 &&
              (blocked(px + dx, py) || blocked(px, py + dy))) break;

          // Imprecise hands: a path that brushes past something is a bad path
          if (sideMargin > 0 && tight < maxTight && step > MARGIN_FROM && step <= MARGIN_STEPS) {
            const ox = -sin * sideMargin;
            const oy = cos * sideMargin;
            if (blocked(wrapX(Math.floor(x + ox)), wrapY(Math.floor(y + oy))) ||
                blocked(wrapX(Math.floor(x - ox)), wrapY(Math.floor(y - oy)))) {
              narrow += MARGIN_PENALTY;
              tight++;
            }
          }

          // Room to turn around, sampled every few steps. Where neither side has
          // room for a U-turn we are in a corridor: fine to pass through, deadly if
          // it turns out to be a dead end, so long corridors cost a lot.
          if (step > 4 && step <= clearanceSteps && step % 4 === 0) {
            const left = this.sideClearance(blocked, nx, ny, sin, -cos);
            const right = this.sideClearance(blocked, nx, ny, -sin, cos);
            if (left < SIDE_RANGE && right < SIDE_RANGE) narrow += 6;
            else if (Math.min(left, right) <= 4) narrow += 1;
          }
        }
        px = nx;
        py = ny;
        const cell = (ny >> COARSE_SHIFT) * COARSE_COLS + (nx >> COARSE_SHIFT);
        if (cell !== lastCell) {
          cells.push(cell);
          lastCell = cell;
        }
      }

      // Moving hazards (enemy heads, bodyguards)
      let hit = false;
      for (const h of hazards) {
        if (step > h.maxStep) continue;
        const hx = h.x + h.vx * step;
        const hy = h.y + h.vy * step;
        if (Math.abs(wrapDelta(hx - x, PLAY_WIDTH)) < h.radius && Math.abs(wrapDelta(hy - y, PLAY_HEIGHT)) < h.radius) {
          hit = true;
          break;
        }
      }
      if (hit) break;

      // Loitering in front of a level gun is asking for it
      if (guns !== null && step <= FIRE_ZONE_STEPS && step % 2 === 0) {
        for (const gun of guns) {
          if (inFireZone(gun, x, y)) narrow += 2;
        }
      }
      // ...and so is loitering in front of an armed enemy
      if (linesOfFire.length > 0 && step <= FIRE_ZONE_STEPS && step % 2 === 0) {
        for (const line of linesOfFire) {
          const dx = wrapDelta(x - line.x, PLAY_WIDTH);
          const dy = wrapDelta(y - line.y, PLAY_HEIGHT);
          if (dx * dx + dy * dy > line.range * line.range) continue;
          if (Math.abs(angleDiff(line.direction, Math.atan2(dy, dx) / DEG)) <= line.halfAngle) narrow += line.weight;
        }
      }

      // Unwanted items on the way
      if (step <= 60 && !badItem) {
        for (const item of badItems) {
          if (Math.abs(item.x - x) < ITEM_COLLISION_RADIUS && Math.abs(item.y - y) < ITEM_COLLISION_RADIUS) {
            badItem = true;
          }
        }
      }

      // Portals teleport to the other end, keeping the heading
      if (portalCooldown > 0) {
        portalCooldown--;
      } else {
        for (const portal of portals) {
          let exitX = -1;
          let exitY = 0;
          if ((nx - portal.x1) ** 2 + (ny - portal.y1) ** 2 < PORTAL_RADIUS_SQ) {
            exitX = portal.x2; exitY = portal.y2;
          } else if ((nx - portal.x2) ** 2 + (ny - portal.y2) ** 2 < PORTAL_RADIUS_SQ) {
            exitX = portal.x1; exitY = portal.y1;
          }
          if (exitX >= 0) {
            x = wrapX(exitX + cos * PORTAL_OUTER_RADIUS);
            y = wrapY(exitY + sin * PORTAL_OUTER_RADIUS);
            px = Math.floor(x);
            py = Math.floor(y);
            portalCooldown = 35;
            break;
          }
        }
      }

      if (step === PROBE_STEP) {
        probeX = x;
        probeY = y;
      }
      if (checkpoints && step % CHECKPOINT_EVERY === 0) {
        // (`cells` keeps growing: the checkpoint is its first `cellCount` entries)
        checkpoints.push({ x, y, dir, step, portalCooldown, cells, cellCount: cells.length });
      }
    }

    const dist = step - 1;
    if (dist < PROBE_STEP) {
      probeX = x;
      probeY = y;
    }
    return { dist, narrow, probeX, probeY, endX: x, endY: y, endDir: dir, badItem, cells };
  }

  /**
   * Coarse cells reachable from the end of a path (capped at AREA_CAP), treating the
   * path itself as a wall - driving it will leave a trail there.
   */
  private freeAreaAfter(pixels: PixelGrid, r: Rollout): number {
    const gen = ++this.floodGen;
    const mark = this.floodMark;
    for (const cell of r.cells) mark[cell] = gen;

    // Start a little ahead of the path's end; if that is blocked try both diagonals
    const coarse = pixels.coarse;
    const queue = this.floodQueue;
    let tail = 0;
    for (let i = 0; i < AREA_PROBE_OFFSETS.length; i++) {
      const rad = (r.endDir + AREA_PROBE_OFFSETS[i]!) * DEG;
      const col = Math.floor(wrapX(r.endX + Math.cos(rad) * AREA_PROBE) / COARSE_CELL);
      const row = Math.floor(wrapY(r.endY + Math.sin(rad) * AREA_PROBE) / COARSE_CELL);
      const cell = row * COARSE_COLS + col;
      if (mark[cell] !== gen && coarse[cell] === 0) {
        mark[cell] = gen;
        queue[tail++] = cell;
      }
    }

    let head = 0;
    while (head < tail && tail < AREA_CAP) {
      const cell = queue[head++]!;
      const col = cell % COARSE_COLS;
      const row = (cell - col) / COARSE_COLS;
      for (let n = 0; n < 4; n++) {
        // Neighbours wrap around the arena
        let nc = col + NEIGHBOUR_DX[n]!;
        if (nc < 0) nc += COARSE_COLS; else if (nc >= COARSE_COLS) nc -= COARSE_COLS;
        let nr = row + NEIGHBOUR_DY[n]!;
        if (nr < 0) nr += COARSE_ROWS; else if (nr >= COARSE_ROWS) nr -= COARSE_ROWS;
        const next = nr * COARSE_COLS + nc;
        if (mark[next] === gen || coarse[next] !== 0) continue;
        mark[next] = gen;
        queue[tail++] = next;
        if (tail >= AREA_CAP) break;
      }
    }
    return Math.min(tail, AREA_CAP);
  }

  /** Free distance (px, up to SIDE_RANGE) from a pixel towards a perpendicular direction. */
  private sideClearance(
    blocked: (x: number, y: number) => boolean, x: number, y: number, dx: number, dy: number
  ): number {
    for (let i = 0; i < SIDE_SAMPLES.length; i++) {
      const d = SIDE_SAMPLES[i]!;
      // (x, y) is inside the arena and d is small: one step of wrapping is enough
      let sx = Math.round(x + dx * d);
      if (sx < 0) sx += PLAY_WIDTH; else if (sx >= PLAY_WIDTH) sx -= PLAY_WIDTH;
      let sy = Math.round(y + dy * d);
      if (sy < 0) sy += PLAY_HEIGHT; else if (sy >= PLAY_HEIGHT) sy -= PLAY_HEIGHT;
      if (blocked(sx, sy)) return d;
    }
    return SIDE_RANGE;
  }

  /** Average free distance of a fan of short rays: how open is the space around a point. */
  private openness(pixels: PixelGrid, x: number, y: number, dir: number): number {
    let total = 0;
    for (const offset of OPENNESS_RAYS) {
      const rad = (dir + offset) * DEG;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      let d = 2;
      for (; d < OPENNESS_RANGE; d += 2) {
        if (pixels.hasWrapped(Math.floor(x + cos * d), Math.floor(y + sin * d))) break;
      }
      total += d;
    }
    return total / OPENNESS_RAYS.length;
  }

  private collectHazards(game: TronGameState, me: TronPlayer): Hazard[] {
    const hazards: Hazard[] = [];
    for (const p of game.players) {
      if (!p.alive || p.slotIndex === this.slot) continue;
      const rad = p.direction * DEG;
      hazards.push({ x: p.x / 1000, y: p.y / 1000, vx: Math.cos(rad), vy: Math.sin(rad), radius: 4 + (this.profile.headMargin ?? 0), maxStep: 45 });
    }
    // Satellites attack anyone inside their owner's area of action (design/bodyguards.md):
    // the whole area is deadly, and it travels with the owner
    const guarded = new Set<number>();
    for (const bg of game.getBodyguards()) {
      if (bg.ownerSlot === me.slotIndex) continue;
      if (game.gameMode === 'team' && bg.ownerSlot % 2 === me.slotIndex % 2) continue;
      guarded.add(bg.ownerSlot);
    }
    for (const p of game.players) {
      if (!p.alive || !guarded.has(p.slotIndex)) continue;
      const rad = p.direction * DEG;
      hazards.push({ x: p.x / 1000, y: p.y / 1000, vx: Math.cos(rad), vy: Math.sin(rad), radius: GUARDED_RADIUS, maxStep: 45 });
    }
    return hazards;
  }

  // === Goals ===

  private chooseGoal(game: TronGameState, me: TronPlayer, x: number, y: number): { x: number; y: number } | null {
    // Stick with the current item while it exists
    let target: GameItem | null = null;
    if (this.goalItemId !== null) {
      target = game.items.find(i => i.id === this.goalItemId && i.active) ?? null;
      if (!target) this.goalItemId = null;
    }

    if (!target) {
      let bestDist = 260; // Don't cross the whole arena for an item
      for (const item of game.items) {
        if (!item.active) continue;
        if (!item.mystery && BAD_ITEMS.has(item.sprite)) continue;
        // Keep the weapon we have unless it is nearly spent
        if (!item.mystery && item.category === 'weapon' && me.equippedWeapon && this.weaponHeldTicks < 600) continue;
        if (this.sense && !this.sense.itemWorth(item.x, item.y)) continue;
        const d = wrappedDist(x, y, item.x, item.y);
        if (d < bestDist) {
          bestDist = d;
          target = item;
        }
      }
      if (target && this.rng() > this.profile.itemInterest) target = null;
      this.goalItemId = target?.id ?? null;
    }

    this.goalKind = null;
    if (target) {
      this.goalKind = 'item';
      // Aim at the nearest wrapped image of the item
      return {
        x: x + wrapDelta(target.x - x, PLAY_WIDTH),
        y: y + wrapDelta(target.y - y, PLAY_HEIGHT),
      };
    }

    // Keep away from an enemy that has the upper hand
    const threat = this.enemies.find(e => e.stance === 'avoid');
    if (threat && threat.dist < FLEE_RANGE && threat.dist > 0) {
      this.goalKind = 'flee';
      return {
        x: x - (threat.dx / threat.dist) * FLEE_DISTANCE,
        y: y - (threat.dy / threat.dist) * FLEE_DISTANCE,
      };
    }

    // Go after one we have the upper hand over; hunters also go after the rest
    const prey = this.enemies.find(e => e.stance === 'seek' || (this.profile.hunts && e.stance === 'neutral'));
    if (prey && !this.sense?.filling) {
      this.goalKind = 'seek';
      // With a gun: face the enemy. Without: aim ahead of them to cut them off.
      const lead = me.equippedWeapon ? 0 : 45;
      const rad = prey.player.direction * DEG;
      if (lead > 0 && this.sense?.use.intercepts) {
        // ...where we get ahead of them, if anywhere
        const cut = this.sense.intercept(prey.player.slotIndex, x + prey.dx, y + prey.dy, prey.player.direction);
        if (cut) return cut;
        this.goalKind = null;
        return this.expansion(x, y);
      }
      return {
        x: x + prey.dx + Math.cos(rad) * lead,
        y: y + prey.dy + Math.sin(rad) * lead,
      };
    }
    return this.expansion(x, y);
  }

  // Nothing to fetch, nobody to chase or run from: take territory (design/bots-territory.md)
  private expansion(x: number, y: number): { x: number; y: number } | null {
    const border = this.sense?.use.expands && !this.sense.filling ? this.sense.frontier() : null;
    if (!border) return null;
    this.goalKind = 'expand';
    return { x: x + wrapDelta(border.x - x, PLAY_WIDTH), y: y + wrapDelta(border.y - y, PLAY_HEIGHT) };
  }

  // Is an enemy bullet, or an H-bomb still far enough to set off safely, coming at us
  // from inside the cone ahead?
  private incomingShot(game: TronGameState, me: TronPlayer, x: number, y: number, halfAngle: number, range: number): boolean {
    for (const proj of game.getProjectiles()) {
      if (proj.type === 'tracer' || proj.ownerSlot === me.slotIndex) continue;
      const dx = wrapDelta(proj.x / 1000 - x, PLAY_WIDTH);
      const dy = wrapDelta(proj.y / 1000 - y, PLAY_HEIGHT);
      const dist = Math.hypot(dx, dy);
      if (dist > range || (proj.type === 'bomb' && dist < 75)) continue;
      if (Math.abs(angleDiff(me.direction, Math.atan2(dy, dx) / DEG)) > halfAngle) continue;
      // Heading our way?
      if (Math.abs(angleDiff(proj.direction, Math.atan2(-dy, -dx) / DEG)) <= 25) return true;
    }
    return false;
  }

  // === Weapons ===

  private decideAction(game: TronGameState, me: TronPlayer, x: number, y: number, straightFree: number): boolean {
    const weapon = me.equippedWeapon;
    if (!weapon) {
      this.lastWeapon = null;
      this.weaponHeldTicks = 0;
      return false;
    }
    if (weapon.sprite !== this.lastWeapon) {
      this.lastWeapon = weapon.sprite;
      this.weaponHeldTicks = 0;
    }
    this.weaponHeldTicks++;

    // The nearest enemy it makes sense to shoot at with this weapon
    const knows = this.profile.knowsMatchups;
    const enemy = this.enemies.find(e => !knows || worthFiringAt(weapon.sprite, e.fighter)) ?? null;
    // Tracers shoot down bullets and bombs coming our way
    const shootDown = (halfAngle: number, range: number): boolean =>
      knows && firesTracers(weapon.sprite) && this.incomingShot(game, me, x, y, halfAngle, range);
    const bearing = enemy ? Math.abs(angleDiff(me.direction, Math.atan2(enemy.dy, enemy.dx) / DEG)) : 180;
    const inCone = (halfAngle: number, range: number): boolean =>
      enemy !== null && bearing <= halfAngle && enemy.dist <= range;

    // Boxed in: shoot a way out (not point-blank: explosions kill at close range)
    const boxedIn = straightFree < 35 && straightFree > 12;
    const full = this.profile.weapons === 'full';
    const pulse = this.tick % 8 < 4; // Rising edge every 8 ticks for single-shot weapons

    switch (weapon.sprite) {
      case 'glock':
        return ((full && inCone(6, 300)) || boxedIn) && pulse;
      case 'shotgun':
        return ((full && inCone(8, 220)) || boxedIn || shootDown(8, 240)) && pulse;
      case 'rifle':
        return (full && inCone(5, 350)) || straightFree < 35 || shootDown(5, 350);
      case 'uzi':
        // (it only reaches 50 px)
        return (full && inCone(28, 70)) || straightFree < 35 || shootDown(28, 55);
      case 'bomb':
        // The blast kills within 50px: only with a long clear path ahead
        if (straightFree < 110) return false;
        return full && (inCone(20, 400) && enemy!.dist > 100 || this.weaponHeldTicks > 700) && pulse;
      case 'lock_borders': {
        const awayFromBorders = x > 30 && x < PLAY_WIDTH - 30 && y > 30 && y < PLAY_HEIGHT - 30;
        return this.weaponHeldTicks > 70 && awayFromBorders && pulse;
      }
      case 'turbo':
        return this.profile.usesTurbo && straightFree >= this.profile.lookahead;
      case 'slow':
        return full && this.enemies.length > 0;
      default:
        return false;
    }
  }
}
