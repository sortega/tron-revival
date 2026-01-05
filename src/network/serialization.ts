// Network serialization with MessagePack and trail packing
// Reduces bandwidth by ~60% compared to JSON

import { encode, decode } from '@msgpack/msgpack';
import type { TronGameStateData, TrailSegment } from '../types/game';
import type { SlotIndex } from '../types/lobby';

// Internal type for packed trail data (flat number array instead of object array)
interface PackedTrailData {
  slotIndex: number;
  segments: number[];  // [x1, y1, x2, y2, ...]
}

interface PackedGameState extends Omit<TronGameStateData, 'newTrailSegments'> {
  newTrailSegments: PackedTrailData[];
}

// Pack trail segments as flat arrays [x1, y1, x2, y2, ...]
// Reduces ~20 bytes per segment to ~4 bytes
function packTrails(segments: TrailSegment[]): number[] {
  const packed: number[] = [];
  for (const seg of segments) {
    packed.push(seg.x, seg.y);
  }
  return packed;
}

// Unpack flat array back to TrailSegment objects
function unpackTrails(packed: number[]): TrailSegment[] {
  const segments: TrailSegment[] = [];
  for (let i = 0; i < packed.length; i += 2) {
    segments.push({ x: packed[i]!, y: packed[i + 1]! });
  }
  return segments;
}

/**
 * Serialize game state to MessagePack binary format.
 * Applies trail packing for additional compression.
 */
export function serializeState(state: TronGameStateData): Uint8Array {
  // Pack trail segments before MessagePack encoding
  const packed: PackedGameState = {
    ...state,
    newTrailSegments: state.newTrailSegments.map(t => ({
      slotIndex: t.slotIndex,
      segments: packTrails(t.segments),
    })),
  };
  return encode(packed);
}

/**
 * Deserialize MessagePack binary data back to game state.
 * Unpacks trail segments back to object format.
 */
export function deserializeState(data: Uint8Array): TronGameStateData {
  const packed = decode(data) as PackedGameState;
  return {
    ...packed,
    newTrailSegments: packed.newTrailSegments.map(t => ({
      slotIndex: t.slotIndex as SlotIndex,
      segments: unpackTrails(t.segments),
    })),
  };
}
