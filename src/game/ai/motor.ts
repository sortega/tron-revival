// Motor - how a bot's intentions reach the keys: late, in presses of a minimum length,
// and through a control mapping that the hands have to relearn when it is reversed.
// See design/bots-human.md.

import type { Rng } from '../rng';
import { drawTicks } from './humanProfiles';
import type { HumanProfile } from './humanProfiles';

const HOLD_WEAPONS = new Set(['rifle', 'uzi', 'turbo', 'slow']);
const PLANNER_PULSE = 8;      // The planner taps single-shot weapons every 8 ticks
const COMMIT = 24;            // A shot decided on goes out if the chance passed less than this ago
const MIN_HOLD = 6;           // ...and a hold-weapon is then held at least this long
const SAME_ENGAGEMENT = 15;   // Wanting to fire again this soon is the same engagement
const TAP_TICKS = 3;         // How long a tap keeps the button down
const PANIC_SLIP_FACTOR = 1.5;
const ON_GUARD = 60;          // Right after catching a slip the player is careful...
const ON_GUARD_FACTOR = 0.25; // ...and slips this much less
const AFTER_EFFECT = { notice: 0.5, slip: 0.5, adapt: 0.3 };

export class Motor {
  private readonly profile: HumanProfile;
  private readonly rng: Rng;
  private tick = 0;

  // Steering key
  private target = 0;           // What the planner last asked for
  private committed = 0;        // What the hands are doing about it (in intention space)
  private pending = false;      // A change is on its way to the key
  private changeAt = 0;
  private lastChange = -1000;
  private holdExtra = 0;        // Over-correction: the next release comes this much later
  private key = 0;              // Last output
  private frozenUntil = 0;

  // Control mapping: +1 = the usual one, -1 = reversed
  private reversed = false;     // Is Control Reversal on?
  private mapping = 1;          // The mapping the hands are using for the current press
  private noticed = true;       // Does the bot know the current state of its controls?
  private noticeAt = 0;
  private noticedTick = 0;
  private slipBase = 0;
  private adapt = 1;
  private catchAt = Infinity;   // When the current wrong-way press will be noticed
  private wrongSince = 0;
  private guardUntil = 0;

  // Trigger
  private weapon: string | null = null;
  private lastRaw = -1000;
  private wanting = false;
  private readyAt = 0;
  private nextTap = 0;
  private tapUntil = 0;
  private pressed = false;
  private releaseAt = 0;
  private wantEnded = -1000;
  private owed = false;         // The first shot of the engagement has not gone out yet
  private holdUntil = 0;

  /** Counters for tests and tuning. */
  stats = { presses: 0, slips: 0, wrongTicks: 0, catches: 0 };

  constructor(profile: HumanProfile, rng: Rng) {
    this.profile = profile;
    this.rng = rng;
  }

  /** New round: hands off the keys, controls as usual. */
  reset(): void {
    this.tick = 0;
    this.target = 0;
    this.committed = 0;
    this.pending = false;
    this.lastChange = -1000;
    this.holdExtra = 0;
    this.key = 0;
    this.frozenUntil = 0;
    this.reversed = false;
    this.mapping = 1;
    this.noticed = true;
    this.slipBase = 0;
    this.catchAt = Infinity;
    this.guardUntil = 0;
    this.resetTrigger(null);
  }

  /** Disorientation: the keys stay as they are for `ticks`. */
  freeze(ticks: number): void {
    this.frozenUntil = Math.max(this.frozenUntil, this.tick + ticks);
  }

  get frozen(): boolean {
    return this.tick < this.frozenUntil;
  }

  /**
   * One tick of the steering key. `intended`: what the planner wants (-1, 0, 1) in terms
   * of where the bike should go. `reversed`: Control Reversal is active. Returns the key
   * state (the simulation applies the reversal to it).
   */
  steer(intended: number, reversed: boolean, panic: boolean): number {
    const tick = ++this.tick;
    const { profile, rng } = this;

    // The controls change under the bot's hands
    if (reversed !== this.reversed) {
      this.reversed = reversed;
      const k = reversed ? 1 : AFTER_EFFECT.notice;
      this.noticed = false;
      this.noticeAt = tick + Math.round(drawTicks(profile.reverse.notice, rng) * k);
      this.slipBase = profile.reverse.slip * (reversed ? 1 : AFTER_EFFECT.slip);
      this.adapt = Math.max(1, profile.reverse.adapt * (reversed ? 1 : AFTER_EFFECT.adapt));
      // The hands carry on with the mapping they were using - now the wrong one.
      // With a key down the bike visibly turns the other way: caught like any slip
      this.mapping = reversed ? 1 : -1;
      this.wrongSince = tick;
      this.catchAt = this.committed !== 0 ? tick + drawTicks(profile.reverse.catch, rng) : Infinity;
    }
    const correct = this.reversed ? -1 : 1;
    if (!this.noticed && tick >= this.noticeAt) {
      this.noticed = true;
      this.noticedTick = tick;
    }
    if (this.frozen) return this.key;

    // Catching a wrong-way press: flip it, and hold the correction too long
    if (tick >= this.catchAt) {
      this.catchAt = Infinity;
      this.mapping = correct;
      this.stats.catches++;
      // Seeing the bike turn the wrong way is also how one finds out
      if (!this.noticed) {
        this.noticed = true;
        this.noticedTick = tick;
      }
      this.guardUntil = tick + ON_GUARD;
      this.holdExtra = Math.round(profile.reverse.overCorrect * (tick - this.wrongSince));
    }

    // A change of intention travels to the key
    if (intended !== this.target) {
      this.target = intended;
      if (intended === this.committed) {
        this.pending = false;   // Withdrawn before it landed
      } else if (!this.pending) {
        this.pending = true;
        const releasing = this.committed !== 0;
        let lag = drawTicks(profile.steerLag, rng);
        if (releasing) {
          if (panic) lag += drawTicks(profile.panicOversteer, rng);
          lag += this.holdExtra;
          this.holdExtra = 0;
        }
        this.changeAt = tick + lag;
      }
    }
    if (this.pending && tick >= this.changeAt
        && tick - this.lastChange >= (this.committed !== 0 ? profile.minPress : 1)) {
      this.pending = false;
      this.committed = this.target;
      this.lastChange = tick;
      if (this.committed !== 0) this.press(tick, correct, panic);
      else this.catchAt = Infinity;   // Let go before noticing: nothing to flip
    }

    if (this.committed !== 0 && this.mapping !== correct) this.stats.wrongTicks++;
    this.key = this.committed * this.mapping;
    return this.key;
  }

  // A new press: which key do the hands go for?
  private press(tick: number, correct: number, panic: boolean): void {
    this.stats.presses++;
    this.catchAt = Infinity;
    if (!this.noticed) {
      // Does not know yet: the old mapping
      this.wrongSince = tick;
      this.mapping = -correct;
      this.catchAt = tick + drawTicks(this.profile.reverse.catch, this.rng);
      return;
    }
    let slip = false;
    if (this.slipBase > 0) {
      let p = this.slipBase * Math.exp(-(tick - this.noticedTick) / this.adapt);
      if (panic) p *= PANIC_SLIP_FACTOR;
      if (tick < this.guardUntil) p *= ON_GUARD_FACTOR;
      if (p < 0.01) this.slipBase = 0;   // Adapted: no more draws
      else slip = this.rng() < p;
    }
    if (slip) {
      this.stats.slips++;
      this.mapping = -correct;
      this.wrongSince = tick;
      this.catchAt = tick + drawTicks(this.profile.reverse.catch, this.rng);
    } else {
      this.mapping = correct;
    }
  }

  private resetTrigger(weapon: string | null): void {
    this.weapon = weapon;
    this.lastRaw = -1000;
    this.wanting = false;
    this.pressed = false;
    this.tapUntil = 0;
    this.releaseAt = 0;
    this.wantEnded = -1000;
    this.owed = false;
    this.holdUntil = 0;
  }

  /**
   * One tick of the action button during play. `raw`: the planner's button state.
   * Call after `steer` (which advances the clock).
   */
  trigger(raw: boolean, weapon: string | null): boolean {
    const tick = this.tick;
    const { profile, rng } = this;
    if (weapon !== this.weapon) this.resetTrigger(weapon);
    if (weapon === null) return false;

    const hold = HOLD_WEAPONS.has(weapon);
    if (raw) this.lastRaw = tick;
    const want = hold ? raw : tick - this.lastRaw < PLANNER_PULSE;
    if (want && !this.wanting) {
      this.wanting = true;
      if (tick - this.wantEnded > SAME_ENGAGEMENT) {
        // A new engagement: the decision takes a moment, and is then carried out
        this.readyAt = tick + drawTicks(profile.fireHesitation, rng);
        this.owed = true;
      } else {
        this.readyAt = tick;
      }
      this.nextTap = Math.max(this.nextTap, this.readyAt);
    } else if (!want && this.wanting) {
      this.wanting = false;
      this.wantEnded = tick;
      this.releaseAt = tick + drawTicks(profile.steerLag, rng) + 2;
    }
    // The first shot of an engagement goes out even if the chance has just passed
    if (this.owed && !this.wanting && tick - this.lastRaw >= COMMIT) this.owed = false;
    if (this.frozen) return false;
    const due = tick >= this.readyAt && (this.wanting || this.owed);

    if (hold) {
      if (due && this.owed) {
        this.owed = false;
        this.holdUntil = tick + MIN_HOLD;
      }
      this.pressed = (this.wanting && tick >= this.readyAt) || tick < this.holdUntil
        || (this.pressed && !this.wanting && tick < this.releaseAt);
      return this.pressed;
    }
    if (due && tick >= this.nextTap) {
      this.owed = false;
      this.tapUntil = tick + TAP_TICKS;
      this.nextTap = tick + Math.max(TAP_TICKS + 1, drawTicks(profile.tapPeriod, rng));
    }
    return tick < this.tapUntil;
  }
}
