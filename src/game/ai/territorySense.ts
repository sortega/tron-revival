// TerritorySense - how one bot reads the shared TerritoryMap: how much room a planned
// path leaves it (counting who gets there first), what the path costs in risk, whether
// to fill its region methodically, and which items and enemies are worth going for.
// Kept out of BotController so the planner itself stays small. See design/bots-territory.md.

import { PLAY_HEIGHT, PLAY_WIDTH } from '../constants';
import { COARSE_CELL } from '../PixelGrid';
import {
  cellOf, NEIGHBOURS, speedOf, T_CELLS, T_COLS, TIME_PER_CELL, UNREACHED, territoryOf,
} from './territory';
import type { TerritoryGame, TerritoryMap } from './territory';

/** How a bot profile uses the territory map. */
export interface TerritoryUse {
  /**
   * Room that counts as plenty, in cells. 400 (160 × 160 px) is what the bots without
   * the map use; more lets a bot tell a chamber from the rest of the arena, at the cost
   * of a longer count for the path it is about to choose.
   */
  roomCap: number;
  /**
   * How much a cell that an enemy reaches first counts as room, 0..1 (1 = all free space
   * counts the same).
   */
  foeWeight: number;
  /** Fill the own region methodically once no enemy can reach it. */
  fills: boolean;
  /** Cost of the map's crash risk along a path (0 = ignored). */
  riskWeight: number;
  /** Leaves alone the items an enemy gets to first, or that it cannot get to. */
  racesForItems: boolean;
  /** Hunts by heading for where it gets ahead of the prey, and only if there is such a place. */
  intercepts: boolean;
  /** With nothing else to do, heads for the border between its territory and an enemy's. */
  expands: boolean;
}

/** Room that every path is counted up to, in cells (as in the bots without the map). */
export const AREA_CAP = 400;
const AREA_PROBE = 12;                // Where, ahead of a path's end, the count starts
const AREA_PROBE_OFFSETS = [0, -50, 50, -100, 100];
const DEG = Math.PI / 180;
const SKIP = 3;                       // Path cells next to the bot's own fresh trail
const ITEM_LEAD = 3 * TIME_PER_CELL;  // An enemy this much nearer to an item gets it
const INTERCEPT_LEAD = 2 * TIME_PER_CELL; // Be this much ahead of the prey where we cut in
const INTERCEPT_MIN = 4;              // Cells ahead of the prey where cutting in starts...
const INTERCEPT_MAX = 36;             // ...and stops being considered

const FRONTIER_WIDTH = 2 * TIME_PER_CELL;  // How close a race for a cell must be for it to be the border
const FRONTIER_MIN = 6;               // Cells away, at least, where the border is worth heading for...
const FRONTIER_MAX = 60;              // ...and at most
const FRONTIER_CLEARANCE = 3;         // ...and how open it must be there

/** Weights of the judgement. Exported so that experiments can vary them. */
export const TUNING = {
  hugBonus: 8,       // Per path cell right next to a wall or trail, while filling
  hugNear: 0.4,      // ...and this fraction of it for cells one further out
  thinFill: 0.3,     // What a cell right next to an obstacle counts as room while filling
  thicken: 2,        // The path blocks the way back this many cells to each side (0-2): no room to turn around there
  thickenTail: 5,    // ...except beside its last cells, where the count starts
  deepPasses: 2,     // Paths per plan whose room is counted beyond AREA_CAP
};

/** What a path is worth besides its length. */
export interface PathWorth {
  room: number;    // 0..1: how much room it ends in (1 = plenty)
  bonus: number;   // Points to add to the score
}

// A judged path, kept in case its room has to be counted further (see `review`)
interface Judged {
  pixels: { cells: Uint16Array; coarse: Uint16Array } | null;
  cells: readonly number[];
  endX: number;
  endY: number;
  endDir: number;
  steps: number;
  capped: boolean;   // The count stopped at AREA_CAP: there may or may not be more
  hug: number;       // Wall-following bonus it was given for having all that room
}

export class TerritorySense {
  /** The map of the current decision. */
  map: TerritoryMap | null = null;
  /** No enemy can reach the space this bot is in: nothing left to do but outlast them. */
  filling = false;

  private slot = 0;
  private step = TIME_PER_CELL;        // Our time per cell
  private gen = 0;
  private readonly mark = new Uint32Array(T_CELLS);
  private readonly queue = new Int32Array(T_CELLS + 8);
  private readonly worth: PathWorth = { room: 1, bonus: 0 };
  private readonly judged: Judged[] = [];
  private judgedCount = 0;
  private frontierVersion = -1;
  private frontierMap: TerritoryMap | null = null;
  private frontierCell = -1;

  constructor(readonly use: TerritoryUse) {}

  /** Call once per decision, before anything else. */
  begin(game: TerritoryGame, slot: number, effects: readonly { sprite: string }[]): void {
    const map = territoryOf(game);
    this.map = map;
    this.slot = slot;
    this.step = TIME_PER_CELL / speedOf(effects);
    this.filling = this.use.fills && map.present[slot] === 1 && map.shared[slot] === 0 && map.reach[slot]! > 0;
    this.judgedCount = 0;
  }

  // All the room the bot has, less a path (while filling, cells right next to an
  // obstacle count for less: see `count`)
  private mine(pathCells: number): number {
    const map = this.map!;
    const thin = this.filling ? TUNING.thinFill : 1;
    return Math.max(0, map.roomy[this.slot]! * (1 - thin) + map.reach[this.slot]! * thin - pathCells);
  }

  // What counts as plenty for a path: the cap, or all the bot has if that is less
  private plenty(pathCells: number): number {
    return Math.max(AREA_CAP, Math.min(this.use.roomCap, this.mine(pathCells)));
  }

  /**
   * Judge a simulated path: the coarse cells it goes through (in order), where and how
   * it ends, and how many steps it takes. `pixels` is the live collision grid.
   * The room is counted up to AREA_CAP cells; a path with at least that much is taken
   * to have plenty until `review` looks further.
   */
  judge(
    pixels: { cells: Uint16Array; coarse: Uint16Array }, cells: readonly number[],
    endX: number, endY: number, endDir: number, steps: number
  ): PathWorth {
    const map = this.map!;
    const { mark, worth } = this;
    const clearance = map.clearance;
    const plenty = this.plenty(cells.length);

    // Remember it for `review`
    let record = this.judged[this.judgedCount];
    if (!record) this.judged[this.judgedCount] = record = { pixels: null, cells, endX: 0, endY: 0, endDir: 0, steps: 0, capped: false, hug: 0 };
    this.judgedCount++;
    record.pixels = pixels;
    record.cells = cells;
    record.endX = endX;
    record.endY = endY;
    record.endDir = endDir;
    record.steps = steps;
    record.capped = false;

    // A path that keeps clear of every obstacle, and of itself, cuts nothing off: the
    // whole region stays within reach, and there is nothing to count
    const foeWeight = this.filling ? 1 : this.use.foeWeight;
    let touches = foeWeight < 1;
    if (!touches) {
      const gen = ++this.gen;
      const near = TUNING.thicken + 1;
      for (let i = 0; i < cells.length && !touches; i++) {
        const cell = cells[i]!;
        if (i >= SKIP) {
          if (clearance[cell]! <= near || mark[cell] === gen) {
            touches = true;
          } else if (i >= 8) {
            const a = cells[i - 1]!;
            const b = cells[i - 2]!;
            const c = cells[i - 3]!;
            for (let n = cell * 4, end = n + 4; n < end; n++) {
              const beside = NEIGHBOURS[n]!;
              if (mark[beside] === gen && beside !== a && beside !== b && beside !== c) touches = true;
            }
          }
        }
        mark[cell] = gen;
      }
    }

    if (!touches) {
      worth.room = Math.min(1, this.mine(cells.length) / plenty);
    } else {
      const room = this.count(record, AREA_CAP);
      if (room >= AREA_CAP) {
        record.capped = plenty > AREA_CAP;
        worth.room = 1;
      } else {
        worth.room = room / plenty;
      }
    }
    // (following a wall into a pocket is worth nothing: the bonus goes with the room)
    record.hug = this.filling ? this.hug(cells) : 0;
    worth.bonus = record.hug * worth.room - this.risk(cells);
    return worth;
  }

  /**
   * After all the paths of a plan have been judged and scored (`scores`, in the order
   * they were judged): look further into the room of the best one where its count
   * stopped at AREA_CAP, correct its score, and so on for the next best, a couple of
   * times. Returns the index of the path to take. `weight` is what a path without any
   * room loses (the planner's lookahead).
   */
  review(scores: number[], weight: number): number {
    let best = 0;
    for (let i = 1; i < scores.length; i++) if (scores[i]! > scores[best]!) best = i;
    if (scores.length !== this.judgedCount) return best;
    for (let pass = 0; pass < TUNING.deepPasses; pass++) {
      const record = this.judged[best]!;
      if (!record.capped) break;
      record.capped = false;
      const plenty = this.plenty(record.cells.length);
      const room = this.count(record, plenty);
      scores[best] = scores[best]! - (1 - Math.min(1, room / plenty)) * (weight + record.hug);
      best = 0;
      for (let i = 1; i < scores.length; i++) if (scores[i]! > scores[best]!) best = i;
    }
    return best;
  }

  // Room left once a path has been driven, counted up to `limit`
  private count(path: Judged, limit: number): number {
    const map = this.map!;
    const { mark, queue } = this;
    const { cells, endX, endY, endDir } = path;
    const gen = ++this.gen;
    // The path is a wall, and so are the cells beside it, except near its end
    for (let i = 0; i < cells.length; i++) mark[cells[i]!] = gen;
    if (TUNING.thicken > 0) {
      const wide = TUNING.thicken > 1;
      for (let i = cells.length - 1 - TUNING.thickenTail; i >= 0; i--) {
        for (let n = cells[i]! * 4, end = n + 4; n < end; n++) {
          const beside = NEIGHBOURS[n]!;
          mark[beside] = gen;
          if (wide) {
            const m = beside * 4;
            mark[NEIGHBOURS[m]!] = gen;
            mark[NEIGHBOURS[m + 1]!] = gen;
            mark[NEIGHBOURS[m + 2]!] = gen;
            mark[NEIGHBOURS[m + 3]!] = gen;
          }
        }
      }
    }

    const coarse = path.pixels!.coarse;
    const grid = path.pixels!.cells;
    const foe = map.foeTime[this.slot]!;
    const blocked = map.blocked;
    const clearance = map.clearance;
    const thin = this.filling ? TUNING.thinFill : 1;
    // Cells an enemy gets to first count for less, so more of them are needed
    const foeWeight = this.filling ? 1 : this.use.foeWeight;
    const budget = (foeWeight >= 1 ? limit : foeWeight <= 0 ? limit * 4 : Math.min(limit * 4, Math.ceil(limit / foeWeight))) * (thin < 1 ? 1.5 : 1);

    // Start a little ahead of the path's end; if that is blocked try to the sides
    let tail = 0;
    for (let i = 0; i < AREA_PROBE_OFFSETS.length; i++) {
      const rad = (endDir + AREA_PROBE_OFFSETS[i]!) * DEG;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const cell = cellOf(endX + cos * AREA_PROBE, endY + sin * AREA_PROBE);
      if (mark[cell] !== gen && coarse[cell] === 0 && blocked[cell] === 0) {
        // (only if nothing lies between: the room behind a wall is not ours)
        let clear = true;
        let lastX = Math.floor(endX);
        let lastY = Math.floor(endY);
        for (let k = 1; k < AREA_PROBE && clear; k++) {
          let px = Math.floor(endX + cos * k);
          if (px < 0) px += PLAY_WIDTH; else if (px >= PLAY_WIDTH) px -= PLAY_WIDTH;
          let py = Math.floor(endY + sin * k);
          if (py < 0) py += PLAY_HEIGHT; else if (py >= PLAY_HEIGHT) py -= PLAY_HEIGHT;
          // (a diagonal step must not slip between two pixels of a slanted trail)
          clear = grid[py * PLAY_WIDTH + px] === 0 &&
            (px === lastX || py === lastY || (grid[lastY * PLAY_WIDTH + px] === 0 && grid[py * PLAY_WIDTH + lastX] === 0));
          lastX = px;
          lastY = py;
        }
        if (!clear) continue;
        mark[cell] = gen;
        queue[tail++] = cell;
      }
    }

    // Breadth-first, a layer at a time: the layer tells when we could be there
    let room = 0;
    let head = 0;
    let arrival = (path.steps / COARSE_CELL + 1) * this.step;
    const link = map.link;
    while (head < tail && room < limit && tail < budget) {
      const layerEnd = tail;
      for (; head < layerEnd; head++) {
        const cell = queue[head]!;
        room += (foeWeight < 1 && foe[cell]! <= arrival ? foeWeight : 1) * (clearance[cell] === 1 ? thin : 1);
        for (let n = cell * 4, end = n + 4; n < end; n++) {
          const next = NEIGHBOURS[n]!;
          if (mark[next] === gen || coarse[next] !== 0 || blocked[next] !== 0) continue;
          mark[next] = gen;
          queue[tail++] = next;
        }
        const far = link[cell]!;
        if (far >= 0 && mark[far] !== gen && coarse[far] === 0 && blocked[far] === 0) {
          mark[far] = gen;
          queue[tail++] = far;
        }
      }
      arrival += this.step;
    }
    // (the cells still queued when the count stopped are room as well)
    if (head < tail && room < limit) room += (tail - head) * (foeWeight < 1 ? foeWeight : 1) * thin;
    return Math.min(limit, room);
  }

  // The crash risk of the cells of a path, as a cost
  private risk(cells: readonly number[]): number {
    if (this.use.riskWeight <= 0) return 0;
    const risk = this.map!.risk;
    let total = 0;
    for (let i = SKIP; i < cells.length; i++) total += risk[cells[i]!]!;
    return total * this.use.riskWeight;
  }

  // While filling: a bonus for running along the walls, so that no space is wasted
  // between them and our trail
  private hug(cells: readonly number[]): number {
    const clearance = this.map!.clearance;
    let hug = 0;
    for (let i = SKIP; i < cells.length; i++) {
      const c = clearance[cells[i]!]!;
      if (c === 1) hug += 1; else if (c === 2) hug += TUNING.hugNear;
    }
    return hug * TUNING.hugBonus;
  }

  /** Is an item at (x, y) worth going for: can we get there, and before an enemy does? */
  itemWorth(x: number, y: number): boolean {
    const map = this.map;
    if (!map || !this.use.racesForItems || map.present[this.slot] === 0) return true;
    const cell = this.nearestFree(map, cellOf(x, y));
    const mine = map.time[this.slot]![cell]!;
    if (mine === UNREACHED) return false;
    return mine <= map.foeTime[this.slot]![cell]! + ITEM_LEAD;
  }

  /**
   * Where to head to cut off the player in `preySlot`, at (x, y) heading `direction`:
   * the nearest point on its course that we reach clearly before it does. Null if there
   * is none (it is ahead of us everywhere: chasing it would be driving into its territory).
   */
  intercept(preySlot: number, x: number, y: number, direction: number): { x: number; y: number } | null {
    const map = this.map;
    if (!map || map.present[this.slot] === 0 || map.present[preySlot] === 0) return null;
    const mine = map.time[this.slot]!;
    const theirs = map.time[preySlot]!;
    const cos = Math.cos(direction * DEG);
    const sin = Math.sin(direction * DEG);
    for (let k = 1; k <= INTERCEPT_MAX; k++) {
      const px = x + cos * k * COARSE_CELL;
      const py = y + sin * k * COARSE_CELL;
      const cell = cellOf(px, py);
      if (map.blocked[cell] === 1) {
        if (k <= 2) continue;   // Its own head and fresh trail
        return null;
      }
      if (k < INTERCEPT_MIN) continue;
      const m = mine[cell]!;
      if (m !== UNREACHED && m + INTERCEPT_LEAD <= theirs[cell]!) return { x: px, y: py };
    }
    return null;
  }

  /**
   * The nearest open point of the border between this bot's territory and an enemy's
   * (where both get at about the same time), not right next to the bot: heading there,
   * and then on to the next such point, walls the territory off. Null if there is none
   * in range. Worked out once per refresh of the map.
   */
  frontier(): { x: number; y: number } | null {
    const map = this.map;
    if (!map || map.present[this.slot] === 0) return null;
    if (map.version !== this.frontierVersion || map !== this.frontierMap) {
      this.frontierVersion = map.version;
      this.frontierMap = map;
      const mine = map.time[this.slot]!;
      const foe = map.foeTime[this.slot]!;
      const clearance = map.clearance;
      const nearest = FRONTIER_MIN * this.step;
      let best = FRONTIER_MAX * this.step + 1;
      let cell = -1;
      for (let i = 0; i < T_CELLS; i++) {
        const m = mine[i]!;
        if (m >= best || m < nearest || clearance[i]! < FRONTIER_CLEARANCE) continue;
        const d = foe[i]! - m;
        if (d > FRONTIER_WIDTH || d < -FRONTIER_WIDTH) continue;   // (UNREACHED is far off either way)
        best = m;
        cell = i;
      }
      this.frontierCell = cell;
    }
    const cell = this.frontierCell;
    if (cell < 0) return null;
    return { x: (cell % T_COLS + 0.5) * COARSE_CELL, y: (Math.floor(cell / T_COLS) + 0.5) * COARSE_CELL };
  }

  // Items sit on free cells, but a trail may pass through the same cell: look around
  private nearestFree(map: TerritoryMap, cell: number): number {
    if (map.blocked[cell] === 0) return cell;
    for (let n = cell * 4, end = n + 4; n < end; n++) {
      if (map.blocked[NEIGHBOURS[n]!] === 0) return NEIGHBOURS[n]!;
    }
    return cell;
  }
}
