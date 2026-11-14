// Automatic doors (level "portals"). See design/level-hazards.md.
// Pure functions: geometry and timing measured from the original sprites and source.

export interface DoorDefinition {
  /** Centre of the door. */
  x: number;
  y: number;
  /** A vertical door runs along y; a horizontal one along x. */
  vertical: boolean;
}

export const DOOR_LENGTH = 120;
export const DOOR_THICKNESS = 50;
export const DOOR_FRAME_COUNT = 10;

export const DOOR_CLOSED_TICKS = 200;
export const DOOR_MOVING_TICKS = 30;
export const DOOR_OPEN_TICKS = 200;
export const DOOR_CYCLE_TICKS = DOOR_CLOSED_TICKS + DOOR_OPEN_TICKS + 2 * DOOR_MOVING_TICKS;

const POST_LENGTH = 26;      // u 0..25 and 94..119
const LEAF_MARGIN = 5;       // leaves cover v 5..44
/** Last `u` covered by the left leaf, per frame; the right leaf mirrors it. */
const LEAF_END = [59, 58, 56, 53, 48, 42, 35, 32, 30, 29];

/** Animation frame (0 = closed … 9 = open) for a number of elapsed playing ticks. */
export function doorFrame(doorTick: number): number {
  const m = doorTick % DOOR_CYCLE_TICKS;
  if (m < DOOR_CLOSED_TICKS) return 0;
  const opening = m - DOOR_CLOSED_TICKS;
  if (opening < DOOR_MOVING_TICKS) {
    return Math.floor(opening * DOOR_FRAME_COUNT / DOOR_MOVING_TICKS);
  }
  const closing = opening - DOOR_MOVING_TICKS - DOOR_OPEN_TICKS;
  if (closing < 0) return DOOR_FRAME_COUNT - 1;
  return DOOR_FRAME_COUNT - 1 - Math.floor(closing * DOOR_FRAME_COUNT / DOOR_MOVING_TICKS);
}

/** Is pixel (x, y) a solid part of this door at this animation frame? */
export function doorSolidAt(door: DoorDefinition, frame: number, x: number, y: number): boolean {
  const u = (door.vertical ? y - door.y : x - door.x) + DOOR_LENGTH / 2;
  if (u < 0 || u >= DOOR_LENGTH) return false;
  const v = (door.vertical ? x - door.x : y - door.y) + DOOR_THICKNESS / 2;
  if (v < 0 || v >= DOOR_THICKNESS) return false;
  if (u < POST_LENGTH || u >= DOOR_LENGTH - POST_LENGTH) return true;
  if (v < LEAF_MARGIN || v >= DOOR_THICKNESS - LEAF_MARGIN) return false;
  const leafEnd = LEAF_END[frame]!;
  return u <= leafEnd || u >= DOOR_LENGTH - 1 - leafEnd;
}

export function anyDoorSolidAt(
  doors: readonly DoorDefinition[], frame: number, x: number, y: number
): boolean {
  for (const door of doors) {
    if (doorSolidAt(door, frame, x, y)) return true;
  }
  return false;
}

const zones = new WeakMap<readonly DoorDefinition[], Uint8Array>();

/**
 * Per pixel of a `width`×`height` arena (row by row): 1 if the pixel lies inside the
 * bounding box of some door, i.e. `anyDoorSolidAt` can only be true where this is 1.
 * Computed once per door list. Lets hot loops (bot rollouts) skip the per-door test
 * for almost every pixel.
 */
export function doorZones(doors: readonly DoorDefinition[], width: number, height: number): Uint8Array {
  let zone = zones.get(doors);
  if (!zone) {
    zone = new Uint8Array(width * height);
    for (const door of doors) {
      const halfX = (door.vertical ? DOOR_THICKNESS : DOOR_LENGTH) / 2;
      const halfY = (door.vertical ? DOOR_LENGTH : DOOR_THICKNESS) / 2;
      // One pixel of slack around the box, so its exact edges do not matter
      const x0 = Math.max(0, Math.floor(door.x - halfX) - 1);
      const x1 = Math.min(width - 1, Math.ceil(door.x + halfX) + 1);
      const y0 = Math.max(0, Math.floor(door.y - halfY) - 1);
      const y1 = Math.min(height - 1, Math.ceil(door.y + halfY) + 1);
      for (let y = y0; y <= y1; y++) zone.fill(1, y * width + x0, y * width + x1 + 1);
    }
    zones.set(doors, zone);
  }
  return zone;
}
