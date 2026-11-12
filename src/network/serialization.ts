// Network serialization of game state: MessagePack plus compact (positional)
// encodings for the parts that dominate the size of a frame.

import { encode, decode } from '@msgpack/msgpack';
import type {
  ActiveEffect, EquippedWeapon, GameItem, Projectile, ProjectileType, TrailSegment,
  TronGameStateData, TronMatchState, TronPlayerState, TronRoundState,
} from '../types/game';
import type { SlotIndex } from '../types/lobby';

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

interface PackedGameState extends Omit<TronGameStateData, 'newTrailSegments' | 'round' | 'borderSegments' | 'match'> {
  match?: TronMatchState;
  round: PackedRound;
  newTrailSegments: PackedTrail[];
  borderSegments?: { color: string; segments: number[] }[];
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
    ...state,
    round: {
      ...state.round,
      players: state.round.players.map(packPlayer),
      projectiles: packProjectiles(state.round.projectiles),
      // Inactive items are of no interest to guests
      items: state.round.items?.filter(i => i.active).map(packItem),
    },
    newTrailSegments: state.newTrailSegments.map(t => ({
      slotIndex: t.slotIndex,
      segments: packTrails(t.segments),
    })),
    borderSegments: state.borderSegments?.map(b => ({ color: b.color, segments: packTrails(b.segments) })),
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
  return {
    ...packed,
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
    newTrailSegments: packed.newTrailSegments.map(t => ({
      slotIndex: t.slotIndex as SlotIndex,
      segments: unpackTrails(t.segments),
    })),
    borderSegments: packed.borderSegments?.map(b => ({ color: b.color, segments: unpackTrails(b.segments) })),
  };
}
