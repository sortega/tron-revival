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
