// HumanBot - a bot that plays like a person: the planner (BotController) sees the world
// through a delayed, imperfect perception and reaches the keys through clumsy hands.
// See design/bots-human.md.

import type { SlotIndex } from '../../types/lobby';
import type { BotDifficulty, TronInput } from '../../types/game';
import { PORTAL_OUTER_RADIUS } from '../../types/game';
import { PLAY_HEIGHT, PLAY_WIDTH } from '../constants';
import { createRng } from '../rng';
import type { Rng } from '../rng';
import type { TronGameState } from '../TronGameState';
import { BotController, BOT_PROFILES } from './BotController';
import type { BotProfile } from './BotController';
import { defaultHumanisation, drawTicks, HUMAN_PROFILES, scaleProfile } from './humanProfiles';
import type { HumanProfile } from './humanProfiles';
import { Motor } from './motor';
import { Perception } from './perception';

const JUMP = 8;               // Moving further than this in a tick is a teleport (px)
const TURNING_MEMORY = 20;    // "Have I been turning lately" looks this far back (ticks)

export interface HumanBotOptions {
  /** Planner profile, when it is not the difficulty's own. */
  planner?: BotProfile;
  /** Human profile, when it is not the difficulty's own. */
  human?: HumanProfile;
  /** 0 = the planner alone (perfect perception and hands), 1 = the human profile as specified. */
  strength?: number;
}

function wrapDelta(d: number, size: number): number {
  if (d > size / 2) return d - size;
  if (d < -size / 2) return d + size;
  return d;
}

export class HumanBot {
  readonly slot: SlotIndex;
  readonly planner: BotController;
  /** Null when the humanisation is switched off (strength 0). */
  readonly human: HumanProfile | null;
  readonly perception: Perception | null;
  readonly motor: Motor | null;
  private readonly rng: Rng;

  private playing = false;
  private lastX = 0;
  private lastY = 0;
  private turning = 0;          // Fraction of the recent past spent steering
  /** Is the bot in a panic (something right ahead)? For tests and tuning. */
  panic = false;

  constructor(slot: SlotIndex, difficulty: BotDifficulty, rng: Rng = Math.random, options: HumanBotOptions = {}) {
    this.slot = slot;
    const strength = options.strength ?? defaultHumanisation();
    if (strength > 0) {
      // Separate streams: a draw more in one layer does not shift the others
      const perceptionRng = createRng(Math.floor(rng() * 0x100000000));
      const motorRng = createRng(Math.floor(rng() * 0x100000000));
      this.human = scaleProfile(options.human ?? HUMAN_PROFILES[difficulty], strength);
      this.perception = new Perception(slot, this.human, perceptionRng);
      this.motor = new Motor(this.human, motorRng);
    } else {
      this.human = null;
      this.perception = null;
      this.motor = null;
    }
    this.rng = rng;
    const plan = options.planner ?? BOT_PROFILES[difficulty];
    // The planner knows whose hands will carry out its plans
    // ...and how often its eyes go over the whole arena
    const territory = plan.territory && this.human
      ? { ...plan.territory, refreshTicks: plan.territory.refreshTicks ?? this.human.arenaGlance }
      : plan.territory;
    this.planner = new BotController(slot, this.human ? { ...plan, territory, sideMargin: this.human.sideMargin, headMargin: this.human.headMargin } : plan, rng);
  }

  decide(game: TronGameState): TronInput {
    const { human, perception, motor } = this;
    if (!human || !perception || !motor) return this.planner.decide(game);

    const me = game.players.find(p => p.slotIndex === this.slot);
    if (!me || game.phase !== 'playing' || !me.alive) {
      if (this.playing) {
        this.playing = false;
        perception.reset();
        motor.reset();
        this.turning = 0;
        this.panic = false;
      }
      return this.planner.decide(game);
    }

    const x = me.x / 1000;
    const y = me.y / 1000;
    if (!this.playing) {
      this.playing = true;
    } else {
      // Swapped or teleported: where am I?
      const moved = Math.hypot(wrapDelta(x - this.lastX, PLAY_WIDTH), wrapDelta(y - this.lastY, PLAY_HEIGHT));
      if (moved > JUMP) {
        const viaPortal = game.portals.some(p =>
          Math.hypot(x - p.x1, y - p.y1) < PORTAL_OUTER_RADIUS + JUMP ||
          Math.hypot(x - p.x2, y - p.y2) < PORTAL_OUTER_RADIUS + JUMP);
        const ticks = drawTicks(human.disorient, this.rng);
        motor.freeze(viaPortal ? Math.round(ticks / 2) : ticks);
      }
      // (the planner has planned at least once by now)
      this.panic = this.planner.debug.straightFree < human.panicDist;
    }
    this.lastX = x;
    this.lastY = y;

    const world = perception.perceive(game, me, this.panic, this.turning);
    const want = this.planner.decide(world);
    const steer = motor.steer(want.steer, me.hasEffect('reverse'), this.panic);
    const action = motor.trigger(want.action, me.equippedWeapon?.sprite ?? null, this.panic);
    this.turning += ((steer !== 0 ? 1 : 0) - this.turning) / TURNING_MEMORY;
    return { steer, action };
  }
}

/** The bot for a difficulty, as used by game sessions. */
export function createBot(slot: SlotIndex, difficulty: BotDifficulty, rng: Rng = Math.random, strength?: number): HumanBot {
  return new HumanBot(slot, difficulty, rng, strength === undefined ? {} : { strength });
}
