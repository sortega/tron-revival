// Network serialization of game state: MessagePack plus compact (positional)
// encodings for the parts that dominate the size of a frame.

import { encode, decode } from '@msgpack/msgpack';
import type {
  ActiveEffect, Bodyguard, ClearedRect, EquippedWeapon, Explosion, FrameEvents, GameItem, GamePlayer, Projectile, ProjectileType,
  RosterEntry, RoundPhase, TrailSegment, TronGameStateData, TronMatchState, TronPlayerState, TronRoundState,
} from '../types/game';
import type { SlotIndex } from '../types/lobby';
import { botOf, NO_OWNER } from '../types/game';
import type { BotDifficulty } from '../types/game';
import type { SmoothLinesData } from '../game/display/SmoothLines';

/** Static player data that is not repeated in every frame. */
export interface PlayerIdentity {
  slotIndex: SlotIndex;
  color: string;
  nickname: string;
}

// weapon: [sprite, ammo, remainingFrames] (NONE = absent); effects: [sprite, remainingFrames, ...]
type PackedPlayer = [
  slot: number, x: number, y: number, direction: number, alive: boolean,
  weapon: [string, number, number] | null, effects: (string | number)[],
  speed: number, moveCounter: number, tpCooldown: number, steer: number, action: boolean,
];

type PackedItem = [id: number, sprite: string, isWeapon: boolean, x: number, y: number, active: boolean, hp: number, mystery: boolean];

interface PackedTrail {
  slotIndex: number;
  segments: number[];  // [x1, y1, x2, y2, ...]
}

interface PackedEvents extends Omit<FrameEvents, 'newTrailSegments' | 'borderSegments'> {
  newTrailSegments: PackedTrail[];
  borderSegments?: { color: string; segments: number[] }[];
}

// What a frame has now and then, by name. Everything it has on every tick is in the
// positional part of the message (`PackedGameState`).
interface PackedExtras {
  match?: TronMatchState;
  items?: PackedItem[];
  portals?: TronRoundState['portals'];
  portalFrames?: number[];
  hand?: TronRoundState['hand'];
  speedUp?: number;          // 1 = offered, 2 = on
  soundEvents?: FrameEvents['soundEvents'];
  borderSegments?: { color: string; segments: number[] }[];
  eraserUsed?: boolean;
  ridiculousDeathSlots?: SlotIndex[];
  clearedAreas?: number[];   // [x, y, w, h, ...]
  clearedLines?: number[];
  roundStarted?: boolean;
  deaths?: FrameEvents['deaths'];
  colorBlindnessFrames?: number;
  whiteFlashFrames?: number;
  roster?: RosterEntry[];
  earlier?: PackedEarlier[];
}

// A frame on the wire (design/networking.md, "Wire format"): no field names for what
// every frame has, and bytes rather than numbers for what there is most of
type PackedGameState = [
  tick: number,              // NONE = absent
  phase: number,             // Index into PHASES
  countdown: number,
  roundWinner: number,       // Slot, NONE = nobody yet, DRAW
  doorTick: number,
  players: PackedPlayer[],
  trails: Uint8Array,        // packTrailBytes
  projectiles: Uint8Array,   // packProjectiles
  explosions: Uint8Array,    // packExplosions
  bodyguards: number[],      // [x, y, owner, ...] in pixels
  pongs: TronGameStateData['pongs'] | null,
  acks: TronGameStateData['acks'] | null,
  extras?: PackedExtras,
];

const PHASES: RoundPhase[] = ['countdown', 'playing', 'waiting_ready'];
const DRAW = -2;

// Events of a skipped tick, as compact as they get: most ticks only have trail pixels.
// trails: [slot, pixelCount, x, y, x, y, ..., slot, pixelCount, ...]
type PackedEarlier = [tick: number, trails: number[], rest?: Partial<PackedEvents>];

function packEarlier(events: FrameEvents): PackedEarlier {
  const trails: number[] = [];
  for (const { slotIndex, segments } of events.newTrailSegments) {
    trails.push(slotIndex, segments.length);
    for (const seg of segments) trails.push(seg.x, seg.y);
  }
  const rest: Partial<PackedEvents> = {};
  let hasRest = false;
  const keep = <K extends keyof PackedEvents>(key: K, value: PackedEvents[K] | undefined, present: boolean): void => {
    if (!present) return;
    rest[key] = value;
    hasRest = true;
  };
  keep('borderSegments', events.borderSegments?.map(b => ({ color: b.color, segments: packTrails(b.segments) })), !!events.borderSegments?.length);
  keep('soundEvents', events.soundEvents, events.soundEvents.length > 0);
  keep('eraserUsed', true, !!events.eraserUsed);
  keep('ridiculousDeathSlots', events.ridiculousDeathSlots, !!events.ridiculousDeathSlots?.length);
  keep('clearedAreas', events.clearedAreas, !!events.clearedAreas?.length);
  keep('clearedLines', events.clearedLines, !!events.clearedLines?.length);
  keep('roundStarted', true, !!events.roundStarted);
  keep('deaths', events.deaths, !!events.deaths?.length);
  return hasRest ? [events.tick ?? -1, trails, rest] : [events.tick ?? -1, trails];
}

function unpackEarlier(packed: PackedEarlier): FrameEvents | null {
  if (!Array.isArray(packed) || typeof packed[0] !== 'number' || !Array.isArray(packed[1])) return null;
  const [tick, trails, rest] = packed;
  const newTrailSegments: PackedTrail[] = [];
  for (let i = 0; i + 1 < trails.length;) {
    const count = Math.max(0, trails[i + 1]!);
    newTrailSegments.push({ slotIndex: trails[i]!, segments: trails.slice(i + 2, i + 2 + count * 2) });
    i += 2 + count * 2;
  }
  return { ...unpackEvents({ soundEvents: [], ...rest, newTrailSegments }), tick };
}

type RosterIdentity = PlayerIdentity & { owner: string; bot?: BotDifficulty };

/** The roster as it travels in the game stream (design/spectators.md). */
export function toRoster(players: readonly GamePlayer[]): RosterEntry[] {
  return players.map((p): RosterEntry => {
    const bot = botOf(p);
    return bot ? [p.slotIndex, p.nickname, p.color, p.owner ?? '', bot] : [p.slotIndex, p.nickname, p.color, p.owner ?? ''];
  });
}

/** Tolerant of malformed entries: anything unusable is dropped. */
export function rosterIdentities(roster: readonly RosterEntry[]): RosterIdentity[] {
  const result: RosterIdentity[] = [];
  for (const entry of roster) {
    if (!Array.isArray(entry)) continue;
    const [slot, nickname, color, owner, bot] = entry;
    if (typeof slot !== 'number' || slot < 0 || slot > 3 || !Number.isInteger(slot)) continue;
    result.push({
      slotIndex: slot as SlotIndex,
      nickname: typeof nickname === 'string' ? nickname : '',
      color: typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? color : '#ffffff',
      owner: typeof owner === 'string' ? owner : '',
      ...((bot === 'easy' || bot === 'normal' || bot === 'hard') && { bot }),
    });
  }
  return result;
}

/** The one-shot events of a frame, without its state. */
export function eventsOf(frame: FrameEvents): FrameEvents {
  return {
    tick: frame.tick,
    newTrailSegments: frame.newTrailSegments,
    borderSegments: frame.borderSegments,
    soundEvents: frame.soundEvents,
    eraserUsed: frame.eraserUsed,
    ridiculousDeathSlots: frame.ridiculousDeathSlots,
    clearedAreas: frame.clearedAreas,
    clearedLines: frame.clearedLines,
    roundStarted: frame.roundStarted,
    deaths: frame.deaths,
    roster: frame.roster,
  };
}

function unpackEvents(packed: PackedEvents): FrameEvents {
  return {
    ...packed,
    newTrailSegments: (packed.newTrailSegments ?? []).map(t => ({
      slotIndex: t.slotIndex as SlotIndex,
      segments: unpackTrails(t.segments),
    })),
    borderSegments: packed.borderSegments?.map(b => ({ color: b.color, segments: unpackTrails(b.segments) })),
    soundEvents: packed.soundEvents ?? [],
  };
}

const EMPTY_MATCH: TronMatchState = {
  scores: {}, currentRound: 1, currentLevelIndex: 0, playersReady: [], gameMode: 'ffa', levelMode: 'cycle', ridiculousDeath: {},
};

const PROJECTILE_TYPES: ProjectileType[] = ['bullet', 'tracer', 'bomb'];
const TRACER = PROJECTILE_TYPES.indexOf('tracer');
const NONE = -1; // Marks an absent optional number

// A pixel of the arena (750 x 600: 10 bits each way) and 4 more bits, in 3 bytes
function putPixel(out: number[], x: number, y: number, extra = 0): void {
  out.push(x & 0xff, ((x >> 8) & 0x03) | ((y & 0x3f) << 2), ((y >> 6) & 0x0f) | ((extra & 0x0f) << 4));
}
const pixelX = (b: Uint8Array, i: number): number => b[i]! | ((b[i + 1]! & 0x03) << 8);
const pixelY = (b: Uint8Array, i: number): number => (b[i + 1]! >> 2) | ((b[i + 2]! & 0x0f) << 6);
const pixelExtra = (b: Uint8Array, i: number): number => b[i + 2]! >> 4;
// Positions of things that fly may be a little outside the arena: bring them in
const wrap = (v: number, size: number): number => ((Math.floor(v) % size) + size) % size;

// Pack trail segments as flat arrays [x1, y1, x2, y2, ...]
function packTrails(segments: TrailSegment[]): number[] {
  const packed: number[] = [];
  for (const seg of segments) {
    packed.push(seg.x, seg.y);
  }
  return packed;
}

function unpackTrails(packed: number[]): TrailSegment[] {
  const segments: TrailSegment[] = [];
  for (let i = 0; i + 1 < packed.length; i += 2) {
    segments.push({ x: packed[i]!, y: packed[i + 1]! });
  }
  return segments;
}

// The new trail pixels of a tick: [slot, count, count x pixel] per player. A player with
// more than 255 goes on in a second group (a group of 255 is always followed by one of
// the same slot, even if empty).
function packTrailBytes(trails: FrameEvents['newTrailSegments']): Uint8Array {
  const out: number[] = [];
  for (const { slotIndex, segments } of trails) {
    let from = 0;
    let count: number;
    do {
      count = Math.min(255, segments.length - from);
      out.push(slotIndex, count);
      for (let i = from; i < from + count; i++) putPixel(out, segments[i]!.x, segments[i]!.y);
      from += count;
    } while (count === 255);
  }
  return Uint8Array.from(out);
}

function unpackTrailBytes(bytes: Uint8Array): FrameEvents['newTrailSegments'] {
  const trails: FrameEvents['newTrailSegments'] = [];
  let continued = false;
  for (let i = 0; i + 1 < bytes.length;) {
    const slotIndex = bytes[i]! as SlotIndex;
    const count = bytes[i + 1]!;
    i += 2;
    const last = trails[trails.length - 1];
    const segments = continued && last?.slotIndex === slotIndex ? last.segments : [];
    if (segments !== last?.segments) trails.push({ slotIndex, segments });
    for (let k = 0; k < count && i + 2 < bytes.length; k++, i += 3) segments.push({ x: pixelX(bytes, i), y: pixelY(bytes, i) });
    continued = count === 255;
  }
  return trails;
}

// Guests only draw projectiles (they are "shown as received", design/networking.md):
// the pixel and the type, plus the heading for those drawn as a sprite. 3 bytes for a
// tracer, 4 for a bullet or a bomb.
function packProjectiles(projectiles: Projectile[]): Uint8Array {
  const out: number[] = [];
  for (const p of projectiles) {
    const type = Math.max(0, PROJECTILE_TYPES.indexOf(p.type));
    putPixel(out, wrap(p.x / 1000, 1024), wrap(p.y / 1000, 1024), type);
    if (type !== TRACER) out.push(Math.round((wrap(p.direction, 360) * 256) / 360) & 0xff);
  }
  return Uint8Array.from(out);
}

// What does not travel is made up: the id is the position in the list, nobody owns it
function unpackProjectiles(bytes: Uint8Array): Projectile[] {
  const projectiles: Projectile[] = [];
  for (let i = 0; i + 2 < bytes.length;) {
    const type = pixelExtra(bytes, i);
    const proj: Projectile = {
      id: projectiles.length,
      x: pixelX(bytes, i) * 1000,
      y: pixelY(bytes, i) * 1000,
      direction: 0,
      ownerSlot: NO_OWNER,
      speed: 0,
      type: PROJECTILE_TYPES[type] ?? 'tracer',
    };
    i += 3;
    if (type !== TRACER) proj.direction = ((bytes[i++] ?? 0) * 360) / 256;
    projectiles.push(proj);
  }
  return projectiles;
}

// Explosions: pixel, frame of the animation, scale in tenths (0 = the default). 5 bytes.
function packExplosions(explosions: Explosion[]): Uint8Array {
  const out: number[] = [];
  for (const e of explosions) {
    putPixel(out, wrap(e.x, 1024), wrap(e.y, 1024));
    out.push(e.frame & 0xff, e.scale === undefined ? 0 : Math.min(255, Math.max(1, Math.round(e.scale * 10))));
  }
  return Uint8Array.from(out);
}

function unpackExplosions(bytes: Uint8Array): Explosion[] {
  const explosions: Explosion[] = [];
  for (let i = 0; i + 4 < bytes.length; i += 5) {
    const scale = bytes[i + 4]!;
    explosions.push({
      id: explosions.length, x: pixelX(bytes, i), y: pixelY(bytes, i), frame: bytes[i + 3]!,
      ...(scale > 0 && { scale: scale / 10 }),
    });
  }
  return explosions;
}

// Satellites are only drawn too: where, and whose
function packBodyguards(bodyguards: Bodyguard[]): number[] {
  const out: number[] = [];
  for (const b of bodyguards) out.push(Math.floor(b.x / 1000), Math.floor(b.y / 1000), b.ownerSlot);
  return out;
}

function unpackBodyguards(packed: number[]): Bodyguard[] {
  const bodyguards: Bodyguard[] = [];
  for (let i = 0; i + 2 < packed.length; i += 3) {
    bodyguards.push({ id: bodyguards.length, x: packed[i]! * 1000, y: packed[i + 1]! * 1000, ownerSlot: packed[i + 2]! as SlotIndex, phaseOffset: 0 });
  }
  return bodyguards;
}

function packAreas(areas: ClearedRect[]): number[] {
  const out: number[] = [];
  for (const r of areas) out.push(r.x, r.y, r.w, r.h);
  return out;
}

function unpackAreas(packed: number[]): ClearedRect[] {
  const areas: ClearedRect[] = [];
  for (let i = 0; i + 3 < packed.length; i += 4) areas.push({ x: packed[i]!, y: packed[i + 1]!, w: packed[i + 2]!, h: packed[i + 3]! });
  return areas;
}

function packPlayer(p: TronPlayerState): PackedPlayer {
  // Positions are rounded to 1/1000 px (integers encode far smaller than floats);
  // headings stay exact because guests replay movement from them
  const weapon = p.equippedWeapon;
  const effects: (string | number)[] = [];
  for (const e of p.activeEffects ?? []) effects.push(e.sprite, e.remainingFrames);
  return [
    p.slotIndex, Math.round(p.x), Math.round(p.y), p.direction, p.alive,
    weapon ? [weapon.sprite, weapon.ammo ?? NONE, weapon.remainingFrames ?? NONE] : null, effects,
    p.speed, p.moveCounter, p.tpCooldown, p.steer, p.action,
  ];
}

function unpackWeapon(packed: PackedPlayer[5]): EquippedWeapon | null {
  if (!Array.isArray(packed)) return null;
  const weapon: EquippedWeapon = { sprite: String(packed[0]) };
  if (packed[1] !== NONE) weapon.ammo = packed[1];
  if (packed[2] !== NONE) weapon.remainingFrames = packed[2];
  return weapon;
}

function unpackEffects(packed: PackedPlayer[6]): ActiveEffect[] {
  const effects: ActiveEffect[] = [];
  for (let i = 0; Array.isArray(packed) && i + 1 < packed.length; i += 2) {
    effects.push({ sprite: String(packed[i]), remainingFrames: Number(packed[i + 1]) });
  }
  return effects;
}

function packItem(i: GameItem): PackedItem {
  return [i.id, i.sprite, i.category === 'weapon', i.x, i.y, i.active, i.hp, i.mystery === true];
}

/** Full picture of a game in progress, for clients that join late. */
export interface Snapshot {
  tick: number;          // Host tick the snapshot was taken on
  palette: string[];     // Collision grid colours
  runs: number[];        // Run-length encoded grid: [paletteIndex, count, ...]
  state: Uint8Array;     // Full serialized frame for that tick
  /** Translucent part of the trails (display only; design/display-layer.md). */
  smoothLines?: SmoothLinesData;
}

export function encodeSnapshot(snapshot: Snapshot): Uint8Array {
  return encode(snapshot);
}

/** Returns null if the data is not a usable snapshot. */
export function decodeSnapshot(data: Uint8Array): Snapshot | null {
  try {
    const raw = decode(data) as Partial<Snapshot> | null;
    if (!raw || typeof raw.tick !== 'number' || !Array.isArray(raw.palette) || !Array.isArray(raw.runs) ||
        !(raw.state instanceof Uint8Array)) return null;
    return raw as Snapshot;
  } catch {
    return null;
  }
}

/**
 * A state as sent over the network: slow-changing parts may be left out, in which
 * case the receiver keeps the last value it got.
 */
export type WireState = Omit<TronGameStateData, 'match' | 'round'> & {
  match?: TronGameStateData['match'];
  round: Omit<TronRoundState, 'items' | 'portals'> & Partial<Pick<TronRoundState, 'items' | 'portals'>> & {
    /** Sent without `portals`: only their animation frames, which is all that changed. */
    portalFrames?: number[];
  };
};

/** Portals without what changes all the time, to tell whether they must be sent again. */
export function portalsKey(portals: TronRoundState['portals']): unknown {
  return portals.map(p => [p.id, p.x1, p.y1, p.x2, p.y2]);
}

/** Serialize game state to a compact MessagePack binary. */
export function serializeState(state: WireState): Uint8Array {
  const { round } = state;
  const extras: PackedExtras = {};
  let hasExtras = false;
  const extra = <K extends keyof PackedExtras>(key: K, value: PackedExtras[K] | undefined, present = value !== undefined): void => {
    if (!present) return;
    extras[key] = value;
    hasExtras = true;
  };
  extra('match', state.match);
  // Inactive items are of no interest to guests
  extra('items', round.items?.filter(i => i.active).map(packItem));
  extra('portals', round.portals);
  extra('portalFrames', round.portalFrames);
  extra('hand', round.hand);
  extra('speedUp', round.speedUp === 'on' ? 2 : 1, round.speedUp !== undefined);
  extra('soundEvents', state.soundEvents, state.soundEvents.length > 0);
  extra('borderSegments', state.borderSegments?.map(b => ({ color: b.color, segments: packTrails(b.segments) })), !!state.borderSegments?.length);
  extra('eraserUsed', true, !!state.eraserUsed);
  extra('ridiculousDeathSlots', state.ridiculousDeathSlots, !!state.ridiculousDeathSlots?.length);
  extra('clearedAreas', state.clearedAreas && packAreas(state.clearedAreas), !!state.clearedAreas?.length);
  extra('clearedLines', state.clearedLines, !!state.clearedLines?.length);
  extra('roundStarted', true, !!state.roundStarted);
  extra('deaths', state.deaths, !!state.deaths?.length);
  extra('colorBlindnessFrames', state.colorBlindnessFrames, !!state.colorBlindnessFrames);
  extra('whiteFlashFrames', state.whiteFlashFrames, !!state.whiteFlashFrames);
  extra('roster', state.roster);
  extra('earlier', state.earlier?.map(packEarlier), !!state.earlier?.length);

  const packed: PackedGameState = [
    state.tick ?? NONE,
    Math.max(0, PHASES.indexOf(round.phase)),
    round.countdown,
    round.roundWinner === null ? NONE : round.roundWinner === 'draw' ? DRAW : round.roundWinner,
    round.doorTick,
    round.players.map(packPlayer),
    packTrailBytes(state.newTrailSegments),
    packProjectiles(round.projectiles),
    packExplosions(round.explosions),
    packBodyguards(round.bodyguards),
    state.pongs ?? null,
    state.acks ?? null,
  ];
  if (hasExtras) packed.push(extras);
  return encode(packed, { ignoreUndefined: true });
}

/**
 * Deserialize a state produced by `serializeState`. `players` supplies the static
 * data (colour, nickname) that is not sent with every frame, and `previous` the
 * slow-changing parts when this frame left them out.
 *
 * Projectiles, explosions and satellites come back with what is needed to draw them
 * and nothing else (design/networking.md, "Wire format").
 */
export function deserializeState(
  data: Uint8Array, players: readonly PlayerIdentity[] = [], previous: TronGameStateData | null = null
): TronGameStateData {
  const packed = decode(data) as PackedGameState;
  if (!Array.isArray(packed)) throw new Error('not a game state');
  const extras: PackedExtras = packed[12] ?? {};
  // A frame that announces a roster is read with it
  if (Array.isArray(extras.roster)) players = rosterIdentities(extras.roster);
  const winner = packed[3];
  const bytes = (value: unknown): Uint8Array => (value instanceof Uint8Array ? value : new Uint8Array(0));
  let portals = extras.portals ?? previous?.round.portals ?? [];
  if (!extras.portals && Array.isArray(extras.portalFrames)) {
    const frames = extras.portalFrames;
    portals = portals.map((p, i) => (typeof frames[i] === 'number' ? { ...p, animFrame: frames[i] } : p));
  }
  return {
    ...(packed[0] !== NONE && { tick: packed[0] }),
    newTrailSegments: unpackTrailBytes(bytes(packed[6])),
    soundEvents: extras.soundEvents ?? [],
    borderSegments: extras.borderSegments?.map(b => ({ color: b.color, segments: unpackTrails(b.segments) })),
    eraserUsed: extras.eraserUsed,
    ridiculousDeathSlots: extras.ridiculousDeathSlots,
    clearedAreas: extras.clearedAreas && unpackAreas(extras.clearedAreas),
    clearedLines: extras.clearedLines,
    roundStarted: extras.roundStarted,
    deaths: extras.deaths,
    colorBlindnessFrames: extras.colorBlindnessFrames,
    whiteFlashFrames: extras.whiteFlashFrames,
    roster: extras.roster,
    ...(packed[10] && { pongs: packed[10] }),
    ...(packed[11] && { acks: packed[11] }),
    earlier: Array.isArray(extras.earlier)
      ? extras.earlier.map(unpackEarlier).filter((e): e is FrameEvents => e !== null) : undefined,
    round: {
      phase: PHASES[packed[1]] ?? 'countdown',
      countdown: packed[2],
      roundWinner: winner === NONE ? null : winner === DRAW ? 'draw' : (winner as SlotIndex),
      doorTick: packed[4],
      players: (packed[5] ?? []).map((p): TronPlayerState => {
        const identity = players.find(i => i.slotIndex === p[0]);
        return {
          slotIndex: p[0] as SlotIndex,
          x: p[1], y: p[2], direction: p[3], alive: p[4],
          color: identity?.color ?? '#ffffff',
          nickname: identity?.nickname ?? '',
          equippedWeapon: unpackWeapon(p[5]), activeEffects: unpackEffects(p[6]),
          speed: p[7], moveCounter: p[8], tpCooldown: p[9], steer: p[10], action: p[11],
        };
      }),
      projectiles: unpackProjectiles(bytes(packed[7])),
      explosions: unpackExplosions(bytes(packed[8])),
      bodyguards: unpackBodyguards(packed[9] ?? []),
      items: extras.items?.map((i): GameItem => ({
        id: i[0], sprite: i[1], category: i[2] ? 'weapon' : 'automatic',
        x: i[3], y: i[4], active: i[5], hp: i[6], ...(i[7] && { mystery: true }),
      })) ?? previous?.round.items ?? [],
      portals,
      ...(extras.hand && { hand: extras.hand }),
      ...(extras.speedUp && { speedUp: extras.speedUp === 2 ? 'on' as const : 'offered' as const }),
    },
    match: extras.match ?? previous?.match ?? EMPTY_MATCH,
  };
}
