import { describe, expect, it } from 'vitest';
import {
  cellOf, REFRESH_PERIOD, TerritoryMap, TIME_PER_CELL, T_CELLS, T_COLS, T_ROWS, UNREACHED,
} from '../src/game/ai/territory';
import type { TerritoryPlayer, TerritoryWorld } from '../src/game/ai/territory';
import { paintTerritory, VIEW_COLS, VIEW_ROWS } from '../src/game/ai/territoryView';
import { PixelGrid } from '../src/game/PixelGrid';
import { PLAY_HEIGHT, PLAY_WIDTH } from '../src/game/constants';
import { DOOR_CLOSED_TICKS, DOOR_MOVING_TICKS } from '../src/game/doors';
import type { DoorDefinition } from '../src/game/doors';

const WALL = '#888888';

function hline(grid: PixelGrid, y: number, x0: number, x1: number): void {
  for (let x = x0; x <= x1; x++) grid.set(x, y, WALL);
}

function vline(grid: PixelGrid, x: number, y0: number, y1: number): void {
  for (let y = y0; y <= y1; y++) grid.set(x, y, WALL);
}

/** A closed rectangle of walls (its outline). */
function box(grid: PixelGrid, x0: number, y0: number, x1: number, y1: number): void {
  hline(grid, y0, x0, x1);
  hline(grid, y1, x0, x1);
  vline(grid, x0, y0, y1);
  vline(grid, x1, y0, y1);
}

/** A frame around the whole arena: no wrap-around. */
function frame(grid: PixelGrid): void {
  box(grid, 0, 0, PLAY_WIDTH - 1, PLAY_HEIGHT - 1);
}

function player(slotIndex: number, x: number, y: number, direction = 0, speed = 1): TerritoryPlayer {
  return { slotIndex, alive: true, x, y, direction, speed };
}

function world(grid: PixelGrid, players: TerritoryPlayer[], extra: Partial<TerritoryWorld> = {}): TerritoryWorld {
  return {
    coarse: grid.coarse, pixels: grid.cells, players, team: false, portals: [],
    doors: null, doorTick: 0, guns: null, ...extra,
  };
}

function build(grid: PixelGrid, players: TerritoryPlayer[], extra: Partial<TerritoryWorld> = {}): TerritoryMap {
  const map = new TerritoryMap();
  map.rebuild(world(grid, players, extra));
  return map;
}

describe('territory map: the arena', () => {
  it('measures clearance and marks corridors as risky', () => {
    const grid = new PixelGrid();
    frame(grid);
    // A corridor two cells wide (walls at y = 200 and y = 224), 400 px long
    hline(grid, 200, 100, 500);
    hline(grid, 224, 100, 500);
    const map = build(grid, [player(0, 600, 400)]);

    const inside = cellOf(300, 212);
    const open = cellOf(600, 400);
    expect(map.blocked[cellOf(300, 200)]).toBe(1);
    expect(map.clearance[cellOf(300, 200)]).toBe(0);
    expect(map.clearance[inside]).toBe(1);
    expect(map.clearance[open]).toBeGreaterThan(5);
    expect(map.risk[inside]).toBeGreaterThan(0);
    expect(map.risk[open]).toBe(0);
    // Next to a single wall is risky too; a cell further out, less
    const beside = cellOf(300, 195);
    expect(map.clearance[beside]).toBe(1);
    expect(map.risk[cellOf(300, 185)]).toBeLessThan(map.risk[beside]!);
    expect(map.risk[cellOf(300, 185)]).toBeGreaterThan(0);
  });

  it('sees obstacles across the arena edges (wrap-around)', () => {
    const grid = new PixelGrid();
    // A wall along the left edge only: the cells at the right edge are next to it
    vline(grid, 2, 0, PLAY_HEIGHT - 1);
    const map = build(grid, [player(0, 400, 300)]);
    expect(map.clearance[cellOf(PLAY_WIDTH - 3, 300)]).toBe(1);
    expect(map.risk[cellOf(PLAY_WIDTH - 3, 300)]).toBeGreaterThan(0);
    expect(map.clearance[cellOf(PLAY_WIDTH - 60, 300)]).toBeGreaterThan(3);
  });

  it('labels a pocket as a region of its own, with its size', () => {
    const grid = new PixelGrid();
    frame(grid);
    // A closed box whose inside is 10 × 5 cells (walls in the cells around it)
    box(grid, 204, 204, 291, 251);
    const map = build(grid, [player(0, 600, 400), player(1, 250, 230)]);

    const pocket = map.region[cellOf(250, 230)]!;
    const outside = map.region[cellOf(600, 400)]!;
    expect(pocket).not.toBe(0);
    expect(pocket).not.toBe(outside);
    expect(map.regionSize[pocket]).toBe(10 * 5);
    expect(map.regionSizeAt(250, 230)).toBe(50);
    expect(map.regionSizeAt(204, 204)).toBe(0);
    // The player inside reaches the pocket (and its own cell) and nothing else
    expect(map.reach[1]).toBe(50);
    expect(map.shared[1]).toBe(0);
    expect(map.shared[0]).toBe(0);
    expect(map.time[0]![cellOf(250, 230)]).toBe(UNREACHED);
  });

  it('a split arena separates the players: each owns its half', () => {
    const grid = new PixelGrid();
    frame(grid);
    vline(grid, 375, 0, PLAY_HEIGHT - 1);
    const map = build(grid, [player(0, 100, 300), player(1, 600, 300, 180)]);
    expect(map.shared[0]).toBe(0);
    expect(map.shared[1]).toBe(0);
    expect(map.area[0]).toBe(map.reach[0]);
    expect(map.area[1]).toBe(map.reach[1]);
    expect(map.reach[0]).toBeGreaterThan(2500);
    expect(map.ownerOf(cellOf(200, 100))).toBe(0);
    expect(map.ownerOf(cellOf(500, 500))).toBe(1);
    // Open a gap in the wall: now they share the space
    for (let y = 280; y < 330; y++) grid.delete(375, y);
    const open = build(grid, [player(0, 100, 300), player(1, 600, 300, 180)]);
    expect(open.shared[0]).toBeGreaterThan(5000);
    expect(open.area[0]).toBeLessThan(open.reach[0]!);
  });

  it('does not leak through a wall that shares the cell of a head', () => {
    const grid = new PixelGrid();
    frame(grid);
    vline(grid, 374, 0, PLAY_HEIGHT - 1);
    // x = 370 is in the wall's own coarse cell (368..375), on the left of the wall
    const map = build(grid, [player(0, 370, 300, 90), player(1, 600, 300, 180)]);
    expect(map.shared[0]).toBe(0);
    expect(map.time[0]![cellOf(390, 300)]).toBe(UNREACHED);
    expect(map.time[0]![cellOf(350, 300)]).not.toBe(UNREACHED);
  });
});

describe('territory map: who gets where first', () => {
  it('splits an empty arena between two players down the middle', () => {
    const grid = new PixelGrid();
    frame(grid);
    const map = build(grid, [player(0, 100, 300, 0), player(1, 650, 300, 180)]);
    expect(map.ownerOf(cellOf(250, 300))).toBe(0);
    expect(map.ownerOf(cellOf(500, 300))).toBe(1);
    expect(Math.abs(map.area[0]! - map.area[1]!)).toBeLessThan(200);
    expect(map.area[0]! + map.area[1]!).toBeLessThanOrEqual(map.reach[0]!);
    // Times grow with distance: 2 units per 8-px cell
    const t = map.time[0]![cellOf(300, 300)]!;
    expect(t).toBeGreaterThanOrEqual(25 * TIME_PER_CELL - 2);
    expect(t).toBeLessThanOrEqual(25 * TIME_PER_CELL + 2);
    expect(map.foeTime[0]![cellOf(300, 300)]).toBe(map.time[1]![cellOf(300, 300)]);
  });

  it('two players racing for a chamber: the nearer one to its door owns it', () => {
    const grid = new PixelGrid();
    frame(grid);
    // A chamber on the right with a door in the middle of its left wall
    vline(grid, 500, 0, 270);
    vline(grid, 500, 330, PLAY_HEIGHT - 1);
    const inside = cellOf(650, 100);
    const near = build(grid, [player(0, 400, 300, 0), player(1, 100, 300, 0)]);
    expect(near.ownerOf(inside)).toBe(0);
    expect(near.area[0]).toBeGreaterThan(near.area[1]!);
    // Turbo makes up for the distance
    const turbo = build(grid, [player(0, 400, 300, 0), player(1, 320, 300, 0, 2)]);
    expect(turbo.ownerOf(inside)).toBe(1);
    // ...and being slowed loses the race from nearer
    const slow = build(grid, [player(0, 400, 300, 0, 0.5), player(1, 100, 300, 0)]);
    expect(slow.ownerOf(inside)).toBe(1);
  });

  it('counts the turn a player needs to go where it is not heading', () => {
    const grid = new PixelGrid();
    frame(grid);
    const map = build(grid, [player(0, 300, 300, 0)]);
    const ahead = map.time[0]![cellOf(340, 300)]!;
    const behind = map.time[0]![cellOf(260, 300)]!;
    const beside = map.time[0]![cellOf(300, 340)]!;
    expect(behind).toBeGreaterThan(ahead);
    expect(beside).toBeGreaterThan(ahead);
    expect(behind).toBeGreaterThanOrEqual(beside);
    // Between two players at the same distance, the one heading there gets it
    const facing = build(grid, [player(0, 200, 300, 0), player(1, 400, 300, 0)]);
    expect(facing.ownerOf(cellOf(300, 300))).toBe(0);
  });

  it('wraps around the arena edges', () => {
    const grid = new PixelGrid();
    const map = build(grid, [player(0, 720, 300, 0), player(1, 375, 300, 0)]);
    // 50 px away through the right edge, not 700 px back across the arena
    expect(map.time[0]![cellOf(20, 300)]).toBeLessThan(10 * TIME_PER_CELL);
    expect(map.ownerOf(cellOf(20, 300))).toBe(0);
    expect(map.time[0]![cellOf(720, 580)]).toBeGreaterThan(map.time[0]![cellOf(720, 20)]! - 20 * TIME_PER_CELL);
  });

  it('goes through portals', () => {
    const grid = new PixelGrid();
    frame(grid);
    const portal = { id: 1, x1: 150, y1: 300, x2: 600, y2: 300, animFrame: 0 };
    const direct = build(grid, [player(0, 100, 300, 0)]);
    const linked = build(grid, [player(0, 100, 300, 0)], { portals: [portal] });
    const target = cellOf(640, 300);
    expect(linked.time[0]![target]).toBeLessThan(direct.time[0]![target]! / 2);
    // A sealed chamber with a portal in it is reachable, and the same region
    box(grid, 520, 220, 700, 380);
    const sealed = build(grid, [player(0, 100, 300, 0)], { portals: [portal] });
    expect(sealed.time[0]![target]).not.toBe(UNREACHED);
    expect(sealed.region[target]).toBe(sealed.region[cellOf(100, 300)]);
    expect(build(grid, [player(0, 100, 300, 0)]).time[0]![target]).toBe(UNREACHED);
  });

  it('closed doors block the way, open ones do not, closing ones are risky', () => {
    const grid = new PixelGrid();
    frame(grid);
    vline(grid, 385, 0, 229);
    vline(grid, 385, 351, PLAY_HEIGHT - 1);
    const doors: DoorDefinition[] = [{ x: 385, y: 290, vertical: true }];
    const players = [player(0, 100, 300, 0)];
    const far = cellOf(600, 300);
    const closed = build(grid, players, { doors, doorTick: 10 });
    expect(closed.time[0]![far]).toBe(UNREACHED);
    const open = build(grid, players, { doors, doorTick: DOOR_CLOSED_TICKS + DOOR_MOVING_TICKS + 10 });
    expect(open.time[0]![far]).not.toBe(UNREACHED);
    expect(open.risk[cellOf(385, 290)]).toBeLessThan(8);
    // 60 ticks before it starts closing: still a way through, but a risky one
    const closing = build(grid, players, { doors, doorTick: DOOR_CLOSED_TICKS + DOOR_MOVING_TICKS + 200 - 60 });
    expect(closing.time[0]![far]).not.toBe(UNREACHED);
    expect(closing.risk[cellOf(385, 290)]).toBeGreaterThanOrEqual(8);
    // About to close: no way through any more
    const shut = build(grid, players, { doors, doorTick: DOOR_CLOSED_TICKS + DOOR_MOVING_TICKS + 200 - 10 });
    expect(shut.time[0]![far]).toBe(UNREACHED);
  });

  it('team-mates are not enemies', () => {
    const grid = new PixelGrid();
    frame(grid);
    const players = [player(0, 100, 300, 0), player(1, 650, 300, 180), player(2, 120, 320, 0), player(3, 640, 320, 180)];
    const ffa = build(grid, players);
    const team = build(grid, players, { team: true });
    const mine = cellOf(160, 320);
    // In a free-for-all the neighbour in slot 2 contests this cell; in teams it is an ally
    expect(ffa.foeTime[0]![mine]).toBe(ffa.time[2]![mine]);
    expect(team.foeTime[0]![mine]).toBe(Math.min(team.time[1]![mine]!, team.time[3]![mine]!));
    expect(team.area[0]).toBeGreaterThan(ffa.area[0]! * 1.5);
    // Dead players do not count at all
    players[1]!.alive = false;
    const after = build(grid, players, { team: true });
    expect(after.present[1]).toBe(0);
    expect(after.foeTime[0]![mine]).toBe(after.time[3]![mine]);
  });
});

describe('territory map: refreshing', () => {
  it('a slice per tick adds up to a full rebuild', () => {
    const grid = new PixelGrid();
    frame(grid);
    const players = [player(0, 100, 300, 0), player(1, 650, 300, 180)];
    const staged = new TerritoryMap();
    const w = world(grid, players);
    staged.update(w, 1);                  // First call: everything at once
    expect(staged.version).toBe(1);
    // The world changes; the map catches up within one period
    vline(grid, 375, 0, PLAY_HEIGHT - 1);
    players[0]!.x = 200;
    for (let tick = 1; tick <= REFRESH_PERIOD * 2; tick++) {
      w.doorTick = tick;
      staged.update(w, 1);
      staged.update(w, 1);                // (a second bot asking on the same tick)
    }
    const fresh = build(grid, players);
    expect(staged.version).toBe(3);
    staged.labelRegions();
    expect(Array.from(staged.blocked)).toEqual(Array.from(fresh.blocked));
    expect(Array.from(staged.time[0]!)).toEqual(Array.from(fresh.time[0]!));
    expect(Array.from(staged.foeTime[1]!)).toEqual(Array.from(fresh.foeTime[1]!));
    expect(staged.shared[0]).toBe(0);
    // A new round (another stamp) or a gap in the ticks rebuilds at once
    for (let y = 0; y < PLAY_HEIGHT; y++) grid.delete(375, y);
    w.doorTick = 0;
    staged.update(w, 2);
    expect(staged.shared[0]).toBeGreaterThan(0);
  });

  it('a slower look at the arena: the same slices further apart, never faster than the default', () => {
    const grid = new PixelGrid();
    frame(grid);
    const players = [player(0, 100, 300, 0), player(1, 650, 300, 180)];
    const versions = (period: number, ticks: number): number => {
      const map = new TerritoryMap();
      const w = world(grid, players);
      map.update(w, 1, period);
      for (let tick = 1; tick <= ticks; tick++) {
        w.doorTick = tick;
        map.update(w, 1, period);
      }
      return map.version - 1;
    };
    expect(versions(12, 72)).toBe(6);
    expect(versions(24, 72)).toBe(3);
    expect(versions(36, 72)).toBe(2);
    expect(versions(6, 72)).toBe(6);    // Not faster than the default
    // What it shows is that old: an obstacle is noticed within a period, not before
    const map = new TerritoryMap();
    const w = world(grid, players);
    map.update(w, 1, 36);
    vline(grid, 375, 0, PLAY_HEIGHT - 1);
    w.doorTick = 1;
    map.update(w, 1, 36);
    expect(map.shared[0]).toBeGreaterThan(0);          // Still thinks the arena is one
    for (let tick = 2; tick <= 72; tick++) {
      w.doorTick = tick;
      map.update(w, 1, 36);
    }
    expect(map.shared[0]).toBe(0);
  });

  it('is deterministic and allocates nothing per refresh', () => {
    const grid = new PixelGrid();
    frame(grid);
    hline(grid, 300, 100, 600);
    const players = [player(0, 100, 100, 45), player(1, 650, 500, 225), player(2, 650, 100, 135)];
    const a = build(grid, players);
    const b = build(grid, players);
    for (let s = 0; s < 3; s++) expect(Array.from(a.time[s]!)).toEqual(Array.from(b.time[s]!));
    const buffer = a.time[0]!;
    a.rebuild(world(grid, players));
    expect(a.time[0]).toBe(buffer);
    expect(a.area[0]! + a.area[1]! + a.area[2]!).toBeLessThanOrEqual(T_CELLS);
  });

  it('paints its layers for the debug overlay', () => {
    const grid = new PixelGrid();
    frame(grid);
    vline(grid, 375, 0, PLAY_HEIGHT - 1);
    const map = build(grid, [player(0, 100, 300, 0), player(1, 600, 300, 180)]);
    const out = new Uint8ClampedArray(VIEW_COLS * VIEW_ROWS * 4);
    paintTerritory(map, 'territory', ['#ff0000', '#00ff00'], out);
    const at = (x: number, y: number): number[] => Array.from(out.slice(cellOf(x, y) * 4, cellOf(x, y) * 4 + 4));
    expect(at(200, 200).slice(0, 3)).toEqual([255, 0, 0]);
    expect(at(500, 200).slice(0, 3)).toEqual([0, 255, 0]);
    expect(at(375, 200)[3]).toBe(0);                      // The wall itself is left alone
    paintTerritory(map, 'risk', ['#ff0000', '#00ff00'], out);
    expect(at(364, 200)[3]).toBeGreaterThan(at(200, 200)[3]!);
    expect(T_COLS * T_ROWS).toBe(VIEW_COLS * VIEW_ROWS);
  });
});
