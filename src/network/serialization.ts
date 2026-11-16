// Network serialization of game state: MessagePack plus compact (positional)
// encodings for the parts that dominate the size of a frame.

import { encode, decode } from '@msgpack/msgpack';
import type {
  ActiveEffect, EquippedWeapon, FrameEvents, GameItem, GamePlayer, Projectile, ProjectileType, RosterEntry, TrailSegment,
  TronGameStateData, TronMatchState, TronPlayerState, TronRoundState,
} from '../types/game';
import type { SlotIndex } from '../types/lobby';
import { botOf } from '../types/game';
import type { BotDifficulty } from '../types/game';
import type { SmoothLinesData } from '../game/display/SmoothLines';

/** Static player data that is not repeated in every frame. */
export interface PlayerIdentity {
  slotIndex: SlotIndex;
  color: string;
  nickname: string;
}

type PackedPlayer = [
  slot: number, x: number, y: number, direction: number, alive: boolean,
  weapon: EquippedWeapon | null, effects: ActiveEffect[],
  speed: number, moveCounter: number, tpCooldown: number, steer: number, action: boolean,
];

type PackedItem = [id: number, sprite: string, isWeapon: boolean, x: number, y: number, active: boolean, hp: number, mystery: boolean];

interface PackedTrail {
  slotIndex: number;
  segments: number[];  // [x1, y1, x2, y2, ...]
}

interface PackedRound extends Omit<TronRoundState, 'players' | 'projectiles' | 'items' | 'portals'> {
  players: PackedPlayer[];
  projectiles: number[];  // PROJECTILE_FIELDS numbers per projectile
  items?: PackedItem[];
  portals?: TronRoundState['portals'];
}

interface PackedEvents extends Omit<FrameEvents, 'newTrailSegments' | 'borderSegments'> {
  newTrailSegments: PackedTrail[];
  borderSegments?: { color: string; segments: number[] }[];
}

interface PackedGameState extends Omit<TronGameStateData, 'newTrailSegments' | 'round' | 'borderSegments' | 'match' | 'earlier'> {
  match?: TronMatchState;
  round: PackedRound;
  newTrailSegments: PackedTrail[];
  borderSegments?: { color: string; segments: number[] }[];
  earlier?: PackedEarlier[];
}

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

function packEvents<T extends FrameEvents>(events: T): Omit<T, 'newTrailSegments' | 'borderSegments'> & Pick<PackedEvents, 'newTrailSegments' | 'borderSegments'> {
  return {
    ...events,
    newTrailSegments: events.newTrailSegments.map(t => ({ slotIndex: t.slotIndex, segments: packTrails(t.segments) })),
    borderSegments: events.borderSegments?.map(b => ({ color: b.color, segments: packTrails(b.segments) })),
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
const PROJECTILE_FIELDS = 10;
const NONE = -1; // Marks an absent optional number

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

function packProjectiles(projectiles: Projectile[]): number[] {
  const out: number[] = [];
  for (const p of projectiles) {
    out.push(
      p.id, Math.round(p.x), Math.round(p.y),
      // Directions and speeds only need a fraction of a unit of precision
      Math.round(p.direction * 100), p.ownerSlot, Math.round(p.speed),
      PROJECTILE_TYPES.indexOf(p.type),
      p.remainingFrames ?? NONE, p.ownerCooldown ?? NONE, p.hp ?? NONE
    );
  }
  return out;
}

function unpackProjectiles(packed: number[]): Projectile[] {
  const projectiles: Projectile[] = [];
  for (let i = 0; i + PROJECTILE_FIELDS <= packed.length; i += PROJECTILE_FIELDS) {
    const proj: Projectile = {
      id: packed[i]!,
      x: packed[i + 1]!,
      y: packed[i + 2]!,
      direction: packed[i + 3]! / 100,
      ownerSlot: packed[i + 4]! as SlotIndex,
      speed: packed[i + 5]!,
      type: PROJECTILE_TYPES[packed[i + 6]!] ?? 'tracer',
    };
    if (packed[i + 7] !== NONE) proj.remainingFrames = packed[i + 7]!;
    if (packed[i + 8] !== NONE) proj.ownerCooldown = packed[i + 8]!;
    if (packed[i + 9] !== NONE) proj.hp = packed[i + 9]!;
    projectiles.push(proj);
  }
  return projectiles;
}

function packPlayer(p: TronPlayerState): PackedPlayer {
  // Positions are rounded to 1/1000 px (integers encode far smaller than floats);
  // headings stay exact because guests replay movement from them
  return [
    p.slotIndex, Math.round(p.x), Math.round(p.y), p.direction, p.alive, p.equippedWeapon, p.activeEffects,
    p.speed, p.moveCounter, p.tpCooldown, p.steer, p.action,
  ];
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
  round: Omit<TronRoundState, 'items' | 'portals'> & Partial<Pick<TronRoundState, 'items' | 'portals'>>;
};

/** Serialize game state to a compact MessagePack binary. */
export function serializeState(state: WireState): Uint8Array {
  const packed = {
    ...packEvents(state),
    earlier: state.earlier?.map(packEarlier),
    round: {
      ...state.round,
      players: state.round.players.map(packPlayer),
      projectiles: packProjectiles(state.round.projectiles),
      // Inactive items are of no interest to guests
      items: state.round.items?.filter(i => i.active).map(packItem),
    },
  };
  return encode(packed, { ignoreUndefined: true });
}

/**
 * Deserialize a state produced by `serializeState`. `players` supplies the static
 * data (colour, nickname) that is not sent with every frame, and `previous` the
 * slow-changing parts when this frame left them out.
 */
export function deserializeState(
  data: Uint8Array, players: readonly PlayerIdentity[] = [], previous: TronGameStateData | null = null
): TronGameStateData {
  const packed = decode(data) as PackedGameState;
  // A frame that announces a roster is read with it
  if (Array.isArray(packed.roster)) players = rosterIdentities(packed.roster);
  const events = unpackEvents(packed);
  return {
    ...packed,
    newTrailSegments: events.newTrailSegments,
    borderSegments: events.borderSegments,
    earlier: Array.isArray(packed.earlier)
      ? packed.earlier.map(unpackEarlier).filter((e): e is FrameEvents => e !== null) : undefined,
    round: {
      ...packed.round,
      players: packed.round.players.map((p): TronPlayerState => {
        const identity = players.find(i => i.slotIndex === p[0]);
        return {
          slotIndex: p[0] as SlotIndex,
          x: p[1], y: p[2], direction: p[3], alive: p[4],
          color: identity?.color ?? '#ffffff',
          nickname: identity?.nickname ?? '',
          equippedWeapon: p[5], activeEffects: p[6] ?? [],
          speed: p[7], moveCounter: p[8], tpCooldown: p[9], steer: p[10], action: p[11],
        };
      }),
      projectiles: unpackProjectiles(packed.round.projectiles ?? []),
      items: packed.round.items?.map((i): GameItem => ({
        id: i[0], sprite: i[1], category: i[2] ? 'weapon' : 'automatic',
        x: i[3], y: i[4], active: i[5], hp: i[6], ...(i[7] && { mystery: true }),
      })) ?? previous?.round.items ?? [],
      portals: packed.round.portals ?? previous?.round.portals ?? [],
    },
    match: packed.match ?? previous?.match ?? EMPTY_MATCH,
  };
}
