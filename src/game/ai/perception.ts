// Perception - what a bot believes the world looks like: enemies seen late and slightly
// misplaced, events noticed after a reaction time. See design/bots-human.md.
//
// The perceived world is a view object that inherits from the real TronGameState and
// overrides only what the bot is wrong about, so the planner (BotController) can read it
// like the real thing.

import type { EquippedWeapon, GameItem, Projectile } from '../../types/game';
import { PLAY_HEIGHT, PLAY_WIDTH } from '../constants';
import type { Rng } from '../rng';
import type { TronGameState } from '../TronGameState';
import type { TronPlayer } from '../TronPlayer';
import { drawTicks, gaussian } from './humanProfiles';
import type { HumanProfile } from './humanProfiles';

const DEG = Math.PI / 180;
const HISTORY = 64;                 // Ring buffer length (ticks); a power of two
const HISTORY_MASK = HISTORY - 1;
const MAX_DELAY = HISTORY - 8;
const VELOCITY_SPAN = 4;            // Ticks over which an enemy's speed is estimated
const EXTRAPOLATE_MAX = 30;         // An enemy not looked at is assumed to carry on this long
const AIM_EVERY = 4;                // The aim error is refreshed every N ticks
const AIM_CORRELATION = 28;         // ...and wanders with this time constant (ticks)
const AIM_RHO = Math.exp(-AIM_EVERY / AIM_CORRELATION);
const AIM_INNOVATION = Math.sqrt(1 - AIM_RHO * AIM_RHO);
export const AIM_DIST_REF = 300;    // The aim error doubles at this distance (px)
export const AIM_RATE_GAIN = 1.5;   // ...grows this much per degree/tick of bearing rate
export const AIM_TURN_GAIN = 0.6;   // ...and this much when the bot is turning all the time
const AIM_RATE_MAX = 2;             // Bearing rates are capped (point-blank passes)
const PURGE_EVERY = 64;

function wrapDelta(d: number, size: number): number {
  if (d > size / 2) return d - size;
  if (d < -size / 2) return d + size;
  return d;
}

function wrap(v: number, size: number): number {
  return ((v % size) + size) % size;
}

function angleDiff(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

/** Standard deviation (degrees) of the aim error in a given situation. */
export function aimSigma(base: number, dist: number, bearingRate: number, turning: number): number {
  return base * (1 + dist / AIM_DIST_REF)
    * (1 + AIM_RATE_GAIN * Math.min(Math.abs(bearingRate), AIM_RATE_MAX))
    * (1 + AIM_TURN_GAIN * turning);
}

// What the bot knows about one other player
interface Track {
  real: TronPlayer;
  view: TronPlayer;           // Inherits from `real`; x, y, direction, equippedWeapon overridden
  hx: Float64Array;           // True positions (px) and headings of the last HISTORY ticks
  hy: Float64Array;
  hd: Float64Array;
  samples: number;            // How many ticks of history exist
  // Last look: where it was, where it was going, and when that was true
  baseX: number;
  baseY: number;
  baseDir: number;
  vx: number;
  vy: number;
  baseTick: number;
  nextGlance: number;
  dist: number;               // True distance, to decide whom to watch
  // Aim error
  aim: number;                // Degrees
  bearing: number;            // True bearing at the last refresh
  bearingRate: number;        // Degrees per tick
  // Weapon as last noticed
  seenSprite: string | null;
  pendingSprite: string | null;
  weaponAt: number;
  seenWeapon: EquippedWeapon | null;
}

interface Noticed {
  at: number;     // Tick from which the bot is aware of it
  seen: number;   // Last tick it existed
}

export class Perception {
  private readonly slot: number;
  private readonly profile: HumanProfile;
  private readonly delay: number;
  private readonly rng: Rng;

  private tick = 0;
  private started = false;
  private game: TronGameState | null = null;
  private world: TronGameState | null = null;
  private meReal: TronPlayer | null = null;
  private meView: TronPlayer | null = null;
  private readonly tracks = new Map<TronPlayer, Track>();
  private order: Track[] = [];

  private readonly itemNotice = new Map<number, Noticed>();
  private known: GameItem[] = [];                               // Items perceived last tick
  private ghosts: { item: GameItem; until: number }[] = [];     // Gone, but not noticed yet
  private perceivedItems: GameItem[] = [];
  private readonly shotNotice = new Map<number, Noticed>();
  private perceivedShots: Projectile[] = [];

  constructor(slot: number, profile: HumanProfile, rng: Rng) {
    this.slot = slot;
    this.profile = profile;
    this.delay = Math.min(MAX_DELAY, Math.max(0, Math.round(profile.trackDelay)));
    this.rng = rng;
  }

  /** Forget everything (new round). */
  reset(): void {
    if (!this.started) return;
    this.started = false;
    this.tick = 0;
    this.tracks.clear();
    this.order = [];
    this.itemNotice.clear();
    this.known = [];
    this.ghosts = [];
    this.shotNotice.clear();
  }

  /** Where the bot believes a player is (px) and how wrong its aim is; for tests and tuning. */
  perceived(slot: number): { x: number; y: number; direction: number; aimError: number; weapon: string | null } | null {
    for (const t of this.tracks.values()) {
      if (t.real.slotIndex === slot) {
        return { x: t.view.x / 1000, y: t.view.y / 1000, direction: t.view.direction, aimError: t.aim, weapon: t.seenSprite };
      }
    }
    return null;
  }

  /**
   * Take in this tick and return the world as the bot perceives it.
   * `panic`: tunnel vision. `turning`: fraction of the recent past spent steering (0..1).
   */
  perceive(game: TronGameState, me: TronPlayer, panic: boolean, turning: number): TronGameState {
    const first = !this.started;
    this.started = true;
    this.tick++;
    const tick = this.tick;

    if (game !== this.game || !this.world) {
      this.game = game;
      this.world = this.makeWorld(game);
    }
    if (me !== this.meReal || !this.meView) {
      this.meReal = me;
      this.meView = makeSelfView(me);
    }

    // --- Other players
    const mx = me.x / 1000;
    const my = me.y / 1000;
    const players: TronPlayer[] = [];
    const order = this.order;
    order.length = 0;
    for (const p of game.players) {
      if (p === me) {
        players.push(this.meView);
        continue;
      }
      if (!p.alive) {
        players.push(p);
        continue;
      }
      let t = this.tracks.get(p);
      if (!t) {
        t = this.makeTrack(p, tick);
        this.tracks.set(p, t);
      }
      const x = p.x / 1000;
      const y = p.y / 1000;
      const i = tick & HISTORY_MASK;
      t.hx[i] = x;
      t.hy[i] = y;
      t.hd[i] = p.direction;
      if (t.samples < HISTORY) t.samples++;
      t.dist = Math.hypot(wrapDelta(x - mx, PLAY_WIDTH), wrapDelta(y - my, PLAY_HEIGHT));
      order.push(t);
      players.push(t.view);
    }
    // Whom to watch: the nearest ones (insertion sort; at most three)
    for (let i = 1; i < order.length; i++) {
      const t = order[i]!;
      let j = i - 1;
      while (j >= 0 && order[j]!.dist > t.dist) {
        order[j + 1] = order[j]!;
        j--;
      }
      order[j + 1] = t;
    }
    for (let rank = 0; rank < order.length; rank++) {
      const t = order[rank]!;
      const attended = rank < this.profile.attention;
      if (attended) {
        this.look(t, tick);
      } else if (tick >= t.nextGlance && !panic) {
        this.look(t, tick);
        t.nextGlance = tick + drawTicks(this.profile.glance, this.rng);
      }
      this.updateAim(t, mx, my, tick, turning);
      this.updateWeapon(t, tick, panic);
      this.place(t, mx, my, tick);
    }

    // --- Items
    this.perceiveItems(game.items, tick, first, panic);
    // --- Bullets and bombs (tracers are too many and too fast to matter one by one)
    this.perceiveShots(game.getProjectiles(), tick, panic);

    if (tick % PURGE_EVERY === 0) {
      for (const [id, n] of this.itemNotice) if (n.seen !== tick) this.itemNotice.delete(id);
      for (const [id, n] of this.shotNotice) if (n.seen !== tick) this.shotNotice.delete(id);
      for (const [p] of this.tracks) if (!p.alive) this.tracks.delete(p);
    }

    const world = this.world as { players: TronPlayer[]; items: GameItem[] };
    world.players = players;
    world.items = this.perceivedItems;
    return this.world;
  }

  private makeWorld(game: TronGameState): TronGameState {
    const world = Object.create(game) as TronGameState;
    Object.defineProperty(world, 'getProjectiles', { value: () => this.perceivedShots });
    return world;
  }

  private makeTrack(p: TronPlayer, tick: number): Track {
    const view = Object.create(p) as TronPlayer;
    const sprite = p.equippedWeapon?.sprite ?? null;
    const x = p.x / 1000;
    const y = p.y / 1000;
    const rad = p.direction * DEG;
    return {
      real: p, view,
      hx: new Float64Array(HISTORY), hy: new Float64Array(HISTORY), hd: new Float64Array(HISTORY),
      samples: 0,
      baseX: x, baseY: y, baseDir: p.direction, vx: Math.cos(rad), vy: Math.sin(rad), baseTick: tick,
      nextGlance: tick + drawTicks(this.profile.glance, this.rng),
      dist: 0,
      aim: 0, bearing: NaN, bearingRate: 0,
      seenSprite: sprite, pendingSprite: sprite, weaponAt: 0, seenWeapon: p.equippedWeapon,
    };
  }

  // Look at an enemy: what reaches the bot now is `delay` ticks old
  private look(t: Track, tick: number): void {
    const age = Math.min(this.delay, t.samples - 1);
    const i = (tick - age) & HISTORY_MASK;
    t.baseX = t.hx[i]!;
    t.baseY = t.hy[i]!;
    t.baseDir = t.hd[i]!;
    t.baseTick = tick - age;
    // Speed as seen then; straight ahead at normal speed when it cannot be told
    // (no history yet, or the enemy has just wrapped around or teleported)
    const rad = t.baseDir * DEG;
    let vx = Math.cos(rad);
    let vy = Math.sin(rad);
    if (t.samples - 1 >= age + VELOCITY_SPAN) {
      const j = (tick - age - VELOCITY_SPAN) & HISTORY_MASK;
      const dx = (t.baseX - t.hx[j]!) / VELOCITY_SPAN;
      const dy = (t.baseY - t.hy[j]!) / VELOCITY_SPAN;
      if (Math.abs(dx) <= 3 && Math.abs(dy) <= 3) {
        // Keep the heading seen, at the speed measured: no extrapolation of the turn
        const speed = Math.hypot(dx, dy);
        vx *= speed;
        vy *= speed;
      }
    }
    t.vx = vx;
    t.vy = vy;
  }

  private updateAim(t: Track, mx: number, my: number, tick: number, turning: number): void {
    if (tick % AIM_EVERY !== 0) return;
    const i = tick & HISTORY_MASK;
    const bearing = Math.atan2(wrapDelta(t.hy[i]! - my, PLAY_HEIGHT), wrapDelta(t.hx[i]! - mx, PLAY_WIDTH)) / DEG;
    t.bearingRate = Number.isNaN(t.bearing) ? 0 : Math.abs(angleDiff(t.bearing, bearing)) / AIM_EVERY;
    t.bearing = bearing;
    if (this.profile.aimSigma <= 0) return;
    const sigma = aimSigma(this.profile.aimSigma, t.dist, t.bearingRate, turning);
    t.aim = AIM_RHO * t.aim + AIM_INNOVATION * sigma * gaussian(this.rng);
  }

  private updateWeapon(t: Track, tick: number, panic: boolean): void {
    const weapon = t.real.equippedWeapon;
    const sprite = weapon?.sprite ?? null;
    if (sprite === t.seenSprite) {
      t.pendingSprite = sprite;
      t.seenWeapon = weapon;
    } else {
      if (sprite !== t.pendingSprite) {
        t.pendingSprite = sprite;
        t.weaponAt = tick + drawTicks(this.profile.surprise, this.rng);
      } else if (panic) {
        t.weaponAt++;
      }
      if (tick >= t.weaponAt) {
        t.seenSprite = sprite;
        t.seenWeapon = weapon;
      } else if (t.seenSprite === null) {
        t.seenWeapon = null;
      } else if (t.seenWeapon === null || t.seenWeapon.sprite !== t.seenSprite) {
        // Still believed to carry what it carried
        t.seenWeapon = { sprite: t.seenSprite };
      }
    }
    t.view.equippedWeapon = t.seenWeapon;
  }

  // Put the enemy where the bot believes it is now
  private place(t: Track, mx: number, my: number, tick: number): void {
    const ahead = Math.min(tick - t.baseTick, EXTRAPOLATE_MAX);
    let dx = wrapDelta(t.baseX + t.vx * ahead - mx, PLAY_WIDTH);
    let dy = wrapDelta(t.baseY + t.vy * ahead - my, PLAY_HEIGHT);
    if (t.aim !== 0) {
      const rad = t.aim * DEG;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const rx = dx * cos - dy * sin;
      dy = dx * sin + dy * cos;
      dx = rx;
    }
    t.view.x = Math.round(wrap(mx + dx, PLAY_WIDTH) * 1000) % (PLAY_WIDTH * 1000);
    t.view.y = Math.round(wrap(my + dy, PLAY_HEIGHT) * 1000) % (PLAY_HEIGHT * 1000);
    t.view.direction = t.baseDir;
  }

  private perceiveItems(items: readonly GameItem[], tick: number, first: boolean, panic: boolean): void {
    const out: GameItem[] = [];
    for (const item of items) {
      if (!item.active) continue;
      let n = this.itemNotice.get(item.id);
      if (!n) {
        // Items lying there when the round starts were seen during the countdown
        n = { at: first ? tick : tick + drawTicks(this.profile.surprise, this.rng), seen: tick };
        this.itemNotice.set(item.id, n);
      }
      n.seen = tick;
      if (tick >= n.at) out.push(item);
      else if (panic) n.at++;
    }
    // Items that have just gone are still believed to be there for a moment
    for (const item of this.known) {
      const n = this.itemNotice.get(item.id);
      if (n && n.seen === tick) continue;
      if (this.delay > 0) this.ghosts.push({ item: { ...item, active: true }, until: tick + this.delay });
    }
    this.known = out.slice();
    if (this.ghosts.length > 0) {
      this.ghosts = this.ghosts.filter(g => tick < g.until);
      for (const g of this.ghosts) out.push(g.item);
    }
    this.perceivedItems = out;
  }

  private perceiveShots(shots: readonly Projectile[], tick: number, panic: boolean): void {
    const out: Projectile[] = [];
    for (const shot of shots) {
      if (shot.type === 'tracer') continue;
      let n = this.shotNotice.get(shot.id);
      if (!n) {
        const own = shot.ownerSlot === this.slot;
        n = { at: own ? tick : tick + drawTicks(this.profile.surprise, this.rng), seen: tick };
        this.shotNotice.set(shot.id, n);
      }
      n.seen = tick;
      if (tick >= n.at) out.push(shot);
      else if (panic) n.at++;
    }
    this.perceivedShots = out;
  }
}

// The bot itself, as its planner sees it: the truth, minus Control Reversal - which key
// means "left" is the hands' business (motor.ts), not the plan's
function makeSelfView(me: TronPlayer): TronPlayer {
  const view = Object.create(me) as TronPlayer;
  Object.defineProperty(view, 'activeEffects', {
    get: () => {
      const effects = me.activeEffects;
      for (const e of effects) {
        if (e.sprite === 'reverse') return effects.filter(x => x.sprite !== 'reverse');
      }
      return effects;
    },
  });
  return view;
}
