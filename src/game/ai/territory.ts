// TerritoryMap - what the bots know about the arena as a whole: which free space each
// player reaches first (Voronoi over the coarse grid), how much room there is around
// every cell, which regions are cut off from which, and where it is easy to crash.
// One map per game, shared by all its bots and refreshed a slice at a time.
// See design/bots-territory.md.

import type { TeleportPortal } from '../../types/game';
import { LEVELS, PORTAL_RADIUS } from '../../types/game';
import { PLAY_HEIGHT, PLAY_WIDTH } from '../constants';
import { COARSE_CELL, COARSE_COLS, COARSE_ROWS } from '../PixelGrid';
import { anyDoorSolidAt, doorFrame, DOOR_FRAME_COUNT, DOOR_LENGTH, DOOR_THICKNESS } from '../doors';
import type { DoorDefinition } from '../doors';
import { inFireZone } from '../guns';
import type { GunDefinition } from '../guns';

export const T_COLS = COARSE_COLS;
export const T_ROWS = COARSE_ROWS;
export const T_CELLS = T_COLS * T_ROWS;
export const MAX_SLOTS = 4;
/** Arrival time of a cell nobody (of those asked about) can reach. */
export const UNREACHED = 0xffff;
/** Arrival times are in these units per coarse cell at normal speed (so turbo = 1). */
export const TIME_PER_CELL = 2;
/** The map is rebuilt over this many ticks, a slice every other tick. */
export const REFRESH_PERIOD = 12;
const SLICES = 2 + MAX_SLOTS;        // The arena, each player, the comparison

const DOOR_SOON_TICKS = 25;       // A door closing this soon is closed for route purposes
const DOOR_RISK_TICKS = 120;      // ...and one closing this soon makes its doorway risky
const CLEARANCE_CAP = 6;
/** Risk of a free cell by its clearance (cells to the nearest obstacle): 1, 2, 3, more. */
const CLEARANCE_RISK = [0, 6, 3, 1];
const DOOR_RISK = 8;
const GUN_RISK = 6;
// Extra cost of the first cell for a player who would have to turn to enter it: ahead,
// to the side, behind (a U-turn takes about 45 px of driving)
const TURN_COST = [0, 2, 5];

/** The four neighbours of every cell (right, left, down, up); the arena wraps. */
export const NEIGHBOURS = new Int32Array(T_CELLS * 4);
for (let row = 0; row < T_ROWS; row++) {
  for (let col = 0; col < T_COLS; col++) {
    const i = (row * T_COLS + col) * 4;
    NEIGHBOURS[i] = row * T_COLS + (col + 1) % T_COLS;
    NEIGHBOURS[i + 1] = row * T_COLS + (col + T_COLS - 1) % T_COLS;
    NEIGHBOURS[i + 2] = ((row + 1) % T_ROWS) * T_COLS + col;
    NEIGHBOURS[i + 3] = ((row + T_ROWS - 1) % T_ROWS) * T_COLS + col;
  }
}

/** Coarse cell of a pixel position (wrapped into the arena). */
export function cellOf(x: number, y: number): number {
  let col = Math.floor(x / COARSE_CELL) % T_COLS;
  if (col < 0) col += T_COLS;
  let row = Math.floor(y / COARSE_CELL) % T_ROWS;
  if (row < 0) row += T_ROWS;
  return row * T_COLS + col;
}

/** What the map reads of a player. */
export interface TerritoryPlayer {
  slotIndex: number;
  alive: boolean;
  x: number;           // Pixels
  y: number;
  direction: number;   // Degrees
  speed: number;       // 1 = normal, 2 = turbo, 0.5 = slowed
}

/** What the map reads of the world. `TronGameState` is adapted to this by `territoryOf`. */
export interface TerritoryWorld {
  coarse: Uint16Array;                      // Occupied pixels per coarse cell
  pixels: Uint16Array | null;               // The collision grid itself (0 = free), row by row
  players: readonly TerritoryPlayer[];
  team: boolean;                            // Slots of the same parity are allies
  portals: readonly TeleportPortal[];
  doors: readonly DoorDefinition[] | null;
  doorTick: number;
  guns: readonly GunDefinition[] | null;
}

// The coarse cells a level's doors can cover and, per animation frame, whether any pixel
// of each (sampled every other pixel) is solid then. Worked out once per door list.
interface DoorCells {
  cells: Int32Array;
  solid: Uint8Array;   // [index in `cells` * DOOR_FRAME_COUNT + frame]
}
const doorCellCache = new WeakMap<readonly DoorDefinition[], DoorCells>();
function doorCells(doors: readonly DoorDefinition[]): DoorCells {
  let entry = doorCellCache.get(doors);
  if (!entry) {
    const found = new Set<number>();
    for (const door of doors) {
      const halfX = (door.vertical ? DOOR_THICKNESS : DOOR_LENGTH) / 2;
      const halfY = (door.vertical ? DOOR_LENGTH : DOOR_THICKNESS) / 2;
      for (let y = Math.max(0, door.y - halfY); y < Math.min(PLAY_HEIGHT, door.y + halfY + COARSE_CELL); y += COARSE_CELL) {
        for (let x = Math.max(0, door.x - halfX); x < Math.min(PLAY_WIDTH, door.x + halfX + COARSE_CELL); x += COARSE_CELL) {
          found.add(cellOf(Math.min(x, PLAY_WIDTH - 1), Math.min(y, PLAY_HEIGHT - 1)));
        }
      }
    }
    const cells = Int32Array.from([...found].sort((a, b) => a - b));
    const solid = new Uint8Array(cells.length * DOOR_FRAME_COUNT);
    cells.forEach((cell, k) => {
      const x0 = (cell % T_COLS) * COARSE_CELL;
      const y0 = Math.floor(cell / T_COLS) * COARSE_CELL;
      for (let frame = 0; frame < DOOR_FRAME_COUNT; frame++) {
        for (let dy = 0; dy < COARSE_CELL && solid[k * DOOR_FRAME_COUNT + frame] === 0; dy += 2) {
          for (let dx = 0; dx < COARSE_CELL; dx += 2) {
            if (anyDoorSolidAt(doors, frame, x0 + dx, y0 + dy)) {
              solid[k * DOOR_FRAME_COUNT + frame] = 1;
              break;
            }
          }
        }
      }
    });
    entry = { cells, solid };
    doorCellCache.set(doors, entry);
  }
  return entry;
}

// The level guns' fire zones as cells, once per gun list
const gunCellCache = new WeakMap<readonly GunDefinition[], Int32Array>();
function gunCells(guns: readonly GunDefinition[]): Int32Array {
  let cells = gunCellCache.get(guns);
  if (!cells) {
    const found: number[] = [];
    for (let cell = 0; cell < T_CELLS; cell++) {
      const x = (cell % T_COLS) * COARSE_CELL + COARSE_CELL / 2;
      const y = Math.floor(cell / T_COLS) * COARSE_CELL + COARSE_CELL / 2;
      if (guns.some(gun => inFireZone(gun, x, y))) found.push(cell);
    }
    cells = Int32Array.from(found);
    gunCellCache.set(guns, cells);
  }
  return cells;
}

export class TerritoryMap {
  /** 1 = the cell holds something solid (trail, scenery, a closed or closing door). */
  readonly blocked = new Uint8Array(T_CELLS);
  /** Cells to the nearest blocked cell (0 = blocked itself), capped. Wrap-aware. */
  readonly clearance = new Uint8Array(T_CELLS);
  /** How easy it is to crash in a cell, whoever you are: tight spots, doorways about to close, level guns. */
  readonly risk = new Uint8Array(T_CELLS);
  /** Label of the connected free region a cell belongs to (0 = blocked). See `labelRegions`. */
  readonly region = new Uint16Array(T_CELLS);
  /** Cells per region label. */
  readonly regionSize = new Int32Array(T_CELLS + 1);
  /** Per slot: when the player can be in each cell (TIME_PER_CELL per cell at normal speed). */
  readonly time: Uint16Array[] = [];
  /** Per slot: when the first enemy of that player can be there. */
  readonly foeTime: Uint16Array[] = [];
  /** Per slot: cells the player can reach at all. */
  readonly reach = new Int32Array(MAX_SLOTS);
  /** Per slot: reachable cells that are not right next to an obstacle (room to drive in). */
  readonly roomy = new Int32Array(MAX_SLOTS);
  /** Per slot: cells the player reaches before every enemy (its Voronoi territory). */
  readonly area = new Int32Array(MAX_SLOTS);
  /** Per slot: cells that both the player and some enemy can reach (0 = separated). */
  readonly shared = new Int32Array(MAX_SLOTS);
  /** Per slot: is the player in the map (alive when its slice was computed)? */
  readonly present = new Uint8Array(MAX_SLOTS);
  /** Where a portal takes you from a cell (-1 = no portal there). */
  readonly link = new Int32Array(T_CELLS).fill(-1);
  /** Counts completed refreshes. */
  version = 0;

  private readonly queue = new Int32Array(T_CELLS + 16);
  private readonly speed = new Float32Array(MAX_SLOTS).fill(1);
  private linked: number[] = [];
  private regionsStale = true;
  private lastTick = -1;
  private period = REFRESH_PERIOD;   // Ticks a whole refresh takes
  private lastStamp: unknown = null;

  constructor() {
    for (let s = 0; s < MAX_SLOTS; s++) {
      this.time.push(new Uint16Array(T_CELLS).fill(UNREACHED));
      this.foeTime.push(new Uint16Array(T_CELLS).fill(UNREACHED));
    }
  }

  /**
   * Bring the map up to date for this tick. Called by every bot every tick; only the
   * first call of a tick does anything, and then only one slice of the work (see
   * REFRESH_PERIOD) unless the map is new or ticks were skipped. `stamp` identifies the
   * round: a different one forces a full rebuild.
   */
  update(world: TerritoryWorld, stamp: unknown = null, period = REFRESH_PERIOD): void {
    const tick = world.doorTick;
    this.period = Math.max(REFRESH_PERIOD, period);
    if (tick === this.lastTick && stamp === this.lastStamp) return;
    const continuous = stamp === this.lastStamp && tick === this.lastTick + 1 && this.version > 0;
    this.lastTick = tick;
    this.lastStamp = stamp;
    if (!continuous) {
      this.rebuild(world);
      return;
    }
    // Slices: the arena, then one player at a time, then the comparison
    // (a slower look at the arena, design/bots-human.md: the same six slices, further apart)
    const gap = Math.round(this.period / SLICES);
    const phase = tick % (gap * SLICES);
    if (phase % gap !== 0) return;
    const slice = phase / gap;
    if (slice === 0) this.scanArena(world);
    else if (slice <= MAX_SLOTS) this.scanPlayer(world, slice - 1);
    else this.compare(world);
  }

  /** Recompute everything now. */
  rebuild(world: TerritoryWorld): void {
    this.scanArena(world);
    for (let s = 0; s < MAX_SLOTS; s++) this.scanPlayer(world, s);
    this.compare(world);
    this.labelRegions();
  }

  // Obstacles, portals, clearance and risk
  private scanArena(world: TerritoryWorld): void {
    const { blocked, clearance, risk, queue, link } = this;
    const coarse = world.coarse;
    for (let i = 0; i < T_CELLS; i++) blocked[i] = coarse[i] === 0 ? 0 : 1;

    risk.fill(0);
    if (world.doors) {
      const { cells, solid } = doorCells(world.doors);
      const now = doorFrame(world.doorTick);
      const soon = doorFrame(world.doorTick + DOOR_SOON_TICKS + this.period);
      const later = doorFrame(world.doorTick + DOOR_RISK_TICKS);
      for (let k = 0; k < cells.length; k++) {
        const at = k * DOOR_FRAME_COUNT;
        if (solid[at + now] === 1 || solid[at + soon] === 1) blocked[cells[k]!] = 1;
        else if (solid[at + later] === 1) risk[cells[k]!] = DOOR_RISK;
      }
    }
    if (world.guns) {
      const cells = gunCells(world.guns);
      for (let k = 0; k < cells.length; k++) risk[cells[k]!] = GUN_RISK;
    }

    for (const cell of this.linked) link[cell] = -1;
    this.linked.length = 0;
    for (const portal of world.portals) {
      this.linkPortal(portal.x1, portal.y1, portal.x2, portal.y2);
      this.linkPortal(portal.x2, portal.y2, portal.x1, portal.y1);
    }

    // Clearance: breadth-first from every blocked cell at once
    let tail = 0;
    for (let i = 0; i < T_CELLS; i++) {
      if (blocked[i] === 1) {
        clearance[i] = 0;
        queue[tail++] = i;
      } else {
        clearance[i] = CLEARANCE_CAP;
      }
    }
    for (let head = 0; head < tail; head++) {
      const cell = queue[head]!;
      const next = clearance[cell]! + 1;
      if (next >= CLEARANCE_CAP) break;
      for (let n = cell * 4, end = n + 4; n < end; n++) {
        const other = NEIGHBOURS[n]!;
        if (clearance[other]! > next) {
          clearance[other] = next;
          queue[tail++] = other;
        }
      }
    }
    for (let i = 0; i < T_CELLS; i++) {
      const c = clearance[i]!;
      if (c > 0 && c < CLEARANCE_RISK.length) risk[i] = risk[i]! + CLEARANCE_RISK[c]!;
    }

    this.regionsStale = true;
  }

  /**
   * Label the connected free regions (`region`, `regionSize`) of the current obstacle
   * snapshot. Not part of the periodic refresh: the bots do not need it (what they can
   * reach is in `time`), tools and tests do. `rebuild` includes it.
   */
  labelRegions(): void {
    if (!this.regionsStale) return;
    this.regionsStale = false;
    const { blocked, region, regionSize, queue, link } = this;
    let tail: number;
    region.fill(0);
    let label = 0;
    for (let i = 0; i < T_CELLS; i++) {
      if (blocked[i] === 1 || region[i] !== 0) continue;
      label++;
      region[i] = label;
      queue[0] = i;
      tail = 1;
      for (let head = 0; head < tail; head++) {
        const cell = queue[head]!;
        for (let n = cell * 4, end = n + 4; n < end; n++) {
          const other = NEIGHBOURS[n]!;
          if (blocked[other] === 0 && region[other] === 0) {
            region[other] = label;
            queue[tail++] = other;
          }
        }
        const far = link[cell]!;
        if (far >= 0 && blocked[far] === 0 && region[far] === 0) {
          region[far] = label;
          queue[tail++] = far;
        }
      }
      regionSize[label] = tail;
    }
    regionSize[0] = 0;
  }

  private linkPortal(x: number, y: number, exitX: number, exitY: number): void {
    const exit = cellOf(exitX, exitY);
    for (let dy = -PORTAL_RADIUS; dy <= PORTAL_RADIUS; dy += COARSE_CELL - 1) {
      for (let dx = -PORTAL_RADIUS; dx <= PORTAL_RADIUS; dx += COARSE_CELL - 1) {
        if (dx * dx + dy * dy >= PORTAL_RADIUS * PORTAL_RADIUS) continue;
        const cell = cellOf(x + dx, y + dy);
        if (this.link[cell] === -1) this.linked.push(cell);
        this.link[cell] = exit;
      }
    }
  }

  // When one player can be where: breadth-first from its head, slower into the cells it
  // would have to turn around for
  private scanPlayer(world: TerritoryWorld, slot: number): void {
    const time = this.time[slot]!;
    const player = world.players.find(p => p.slotIndex === slot);
    time.fill(UNREACHED);
    this.present[slot] = player?.alive ? 1 : 0;
    if (!player?.alive) return;
    const { blocked, queue, link } = this;
    const speed = player.speed >= 2 ? 2 : player.speed <= 0.5 ? 0.5 : 1;
    this.speed[slot] = speed;
    const step = TIME_PER_CELL / speed;   // 1, 2 or 4

    const start = cellOf(player.x, player.y);
    time[start] = 0;
    // The first cells, in order of cost (insertion sort of four)
    const rad = player.direction * Math.PI / 180;
    const ax = Math.cos(rad);
    const ay = Math.sin(rad);
    const seedCell = [0, 0, 0, 0];
    const seedTime = [0, 0, 0, 0];
    for (let n = 0; n < 4; n++) {
      // (right, left, down, up)
      const along = n === 0 ? ax : n === 1 ? -ax : n === 2 ? ay : -ay;
      const cost = step + TURN_COST[along > 0.5 ? 0 : along > -0.5 ? 1 : 2]! * step;
      let k = n;
      while (k > 0 && seedTime[k - 1]! > cost) {
        seedTime[k] = seedTime[k - 1]!;
        seedCell[k] = seedCell[k - 1]!;
        k--;
      }
      seedTime[k] = cost;
      seedCell[k] = this.wayOut(world.pixels, player.x, player.y, n) ? NEIGHBOURS[start * 4 + n]! : start;
    }

    let head = 0;
    let tail = 0;
    let seed = 0;
    for (;;) {
      let cell: number;
      if (seed < 4 && (head === tail || seedTime[seed]! <= time[queue[head]!]!)) {
        cell = seedCell[seed]!;
        const t = seedTime[seed]!;
        seed++;
        if (blocked[cell] === 1 || time[cell]! <= t) continue;
        time[cell] = t;
      } else if (head < tail) {
        cell = queue[head++]!;
      } else {
        break;
      }
      const next = time[cell]! + step;
      for (let n = cell * 4, end = n + 4; n < end; n++) {
        const other = NEIGHBOURS[n]!;
        if (blocked[other] === 0 && time[other]! > next) {
          time[other] = next;
          queue[tail++] = other;
        }
      }
      const far = link[cell]!;
      if (far >= 0 && blocked[far] === 0 && time[far]! > next) {
        time[far] = next;
        queue[tail++] = far;
      }
    }
  }

  // Can the player leave its cell towards neighbour `n` (right, left, down, up) in a
  // straight line? Its cell is usually "blocked" by its own trail, and may hold a wall
  // with the neighbour on the other side of it.
  private wayOut(pixels: Uint16Array | null, x: number, y: number, n: number): boolean {
    if (pixels === null) return true;
    const dx = n === 0 ? 1 : n === 1 ? -1 : 0;
    const dy = n === 2 ? 1 : n === 3 ? -1 : 0;
    let px = Math.floor(x);
    let py = Math.floor(y);
    const col = Math.floor(px / COARSE_CELL);
    const row = Math.floor(py / COARSE_CELL);
    for (let k = 0; k < COARSE_CELL; k++) {
      px += dx;
      py += dy;
      if (Math.floor(px / COARSE_CELL) !== col || Math.floor(py / COARSE_CELL) !== row) return true;
      if (pixels[py * PLAY_WIDTH + px] !== 0) return false;
    }
    return true;
  }

  // Who gets where first
  private compare(world: TerritoryWorld): void {
    const { time, foeTime, present } = this;
    for (let s = 0; s < MAX_SLOTS; s++) {
      const foe = foeTime[s]!;
      this.area[s] = 0;
      this.shared[s] = 0;
      this.reach[s] = 0;
      this.roomy[s] = 0;
      if (present[s] === 0) {
        foe.fill(UNREACHED);
        continue;
      }
      // The (up to three) enemies of this slot
      let a: Uint16Array | null = null;
      let b: Uint16Array | null = null;
      let c: Uint16Array | null = null;
      for (let o = 0; o < MAX_SLOTS; o++) {
        if (o === s || present[o] === 0 || (world.team && o % 2 === s % 2)) continue;
        if (a === null) a = time[o]!; else if (b === null) b = time[o]!; else c = time[o]!;
      }
      const mine = time[s]!;
      let area = 0;
      let shared = 0;
      let reach = 0;
      let roomy = 0;
      const clearance = this.clearance;
      for (let i = 0; i < T_CELLS; i++) {
        let t = UNREACHED;
        if (a !== null) {
          t = a[i]!;
          if (b !== null && b[i]! < t) t = b[i]!;
          if (c !== null && c[i]! < t) t = c[i]!;
        }
        foe[i] = t;
        const m = mine[i]!;
        if (m !== UNREACHED) {
          reach++;
          if (clearance[i]! > 1) roomy++;
          if (m < t) area++;
          if (t !== UNREACHED) shared++;
        }
      }
      this.area[s] = area;
      this.shared[s] = shared;
      this.reach[s] = reach;
      this.roomy[s] = roomy;
    }
    this.version++;
  }

  /** Slot of the player that reaches a cell first; -1 if nobody can or it is a tie. */
  ownerOf(cell: number): number {
    let best = UNREACHED;
    let owner = -1;
    for (let s = 0; s < MAX_SLOTS; s++) {
      const t = this.time[s]![cell]!;
      if (t < best) {
        best = t;
        owner = s;
      } else if (t === best) {
        owner = -1;
      }
    }
    return owner;
  }

  /** Cells of the free region a pixel position is in (0 if it is inside an obstacle). */
  regionSizeAt(x: number, y: number): number {
    this.labelRegions();
    return this.regionSize[this.region[cellOf(x, y)]!]!;
  }
}

/** Speed of a player as far as effects show it (1 = normal). */
export function speedOf(effects: readonly { sprite: string }[]): number {
  let factor = 1;
  for (const e of effects) {
    if (e.sprite === 'automatic_turbo') factor += 1;
    else if (e.sprite === 'automatic_slow') factor -= 1;
  }
  return factor >= 2 ? 2 : factor <= 0 ? 0.5 : 1;
}

/** The game, as far as the map needs it (structural: avoids importing the simulation). */
export interface TerritoryGame {
  pixels: { coarse: Uint16Array; cells: Uint16Array };
  players: readonly { slotIndex: number; alive: boolean; x: number; y: number; direction: number; activeEffects: readonly { sprite: string }[] }[];
  gameMode: string;
  portals: readonly TeleportPortal[];
  currentLevelIndex: number;
  currentRound: number;
  doorTick: number;
}

/** Snapshot of a game in the shape the map reads. Allocates: not for every tick. */
export function worldOf(game: TerritoryGame): TerritoryWorld {
  const level = LEVELS[game.currentLevelIndex];
  return {
    coarse: game.pixels.coarse,
    pixels: game.pixels.cells,
    players: game.players.map(p => ({
      slotIndex: p.slotIndex, alive: p.alive, x: p.x / 1000, y: p.y / 1000,
      direction: p.direction, speed: speedOf(p.activeEffects),
    })),
    team: game.gameMode === 'team',
    portals: game.portals,
    doors: level?.doors ?? null,
    doorTick: game.doorTick,
    guns: level?.guns ?? null,
  };
}

// A live view of a game: the same objects every tick, nothing allocated
class GameWorld implements TerritoryWorld {
  private readonly views: TerritoryPlayer[] = [];
  constructor(private readonly game: TerritoryGame) {}
  get coarse(): Uint16Array { return this.game.pixels.coarse; }
  get pixels(): Uint16Array { return this.game.pixels.cells; }
  get team(): boolean { return this.game.gameMode === 'team'; }
  get portals(): readonly TeleportPortal[] { return this.game.portals; }
  get doors(): readonly DoorDefinition[] | null { return LEVELS[this.game.currentLevelIndex]?.doors ?? null; }
  get guns(): readonly GunDefinition[] | null { return LEVELS[this.game.currentLevelIndex]?.guns ?? null; }
  get doorTick(): number { return this.game.doorTick; }
  get players(): readonly TerritoryPlayer[] {
    const players = this.game.players;
    for (let i = 0; i < players.length; i++) {
      const p = players[i]!;
      const view = this.views[i] ?? (this.views[i] = { slotIndex: 0, alive: false, x: 0, y: 0, direction: 0, speed: 1 });
      view.slotIndex = p.slotIndex;
      view.alive = p.alive;
      view.x = p.x / 1000;
      view.y = p.y / 1000;
      view.direction = p.direction;
      view.speed = speedOf(p.activeEffects);
    }
    this.views.length = players.length;
    return this.views;
  }
}

const maps = new WeakMap<object, { map: TerritoryMap; world: GameWorld }>();

/** The territory map of a game, up to date for the current tick. Shared by its bots. */
export function territoryOf(game: TerritoryGame, period = REFRESH_PERIOD): TerritoryMap {
  let entry = maps.get(game);
  if (!entry) {
    entry = { map: new TerritoryMap(), world: new GameWorld(game) };
    maps.set(game, entry);
  }
  // (rounds restart the door clock, and so do levels)
  entry.map.update(entry.world, game.currentRound * 16 + game.currentLevelIndex, period);
  return entry.map;
}
