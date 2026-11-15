import { describe, expect, it } from 'vitest';
import { PixelGrid } from '../src/game/PixelGrid';
import type { TronInput } from '../src/types/game';
import type { SlotIndex } from '../src/types/lobby';
import { makeGame, place, skipCountdown } from './helpers';

type Game = ReturnType<typeof makeGame>;

const OWNER = 1;
const DIRECTIONS = Array.from({ length: 12 }, (_, i) => (i * Math.PI) / 6 + 0.2);

function arena(players = 2, mode: 'ffa' | 'team' = 'ffa'): Game {
  const g = makeGame(players, 1, { mode });
  g.setLevelObstacles(new PixelGrid());
  skipCountdown(g);
  g.items.length = 0;
  g.portals.length = 0;
  // Everybody out of the way until placed
  g.players.forEach((_, i) => place(g, i, 60 + i * 40, 60, 180));
  return g;
}

function idle(g: Game, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    g.tick(new Map());
    g.items.length = 0;
    g.serialize();
  }
}

/** Put the owner in the middle with satellites, somewhere along their orbit. */
function guardedOwner(g: Game, satellites: number, settle: number): { x: number; y: number } {
  place(g, OWNER, 375, 300, 0);
  for (let i = 0; i < satellites; i++) {
    const p = g.players[OWNER]!;
    g.items.push({ id: 900 + i, sprite: 'bodyguard_item', category: 'automatic', x: p.getScreenX(), y: p.getScreenY(), active: true, hp: 40 });
    g.tick(new Map());
    g.items.length = 0;
    g.serialize();
  }
  idle(g, settle);
  expect(g.getBodyguards().length).toBe(satellites);
  const owner = g.players[OWNER]!;
  return { x: owner.x / 1000, y: owner.y / 1000 };
}

/** Place a shooter `dist` px from the owner, aiming at where a 5 px/tick shot meets it. */
function aimAtOwner(g: Game, slot: number, owner: { x: number; y: number }, from: number, dist: number, weapon: string): void {
  const sx = owner.x + Math.cos(from) * dist;
  const sy = owner.y + Math.sin(from) * dist;
  const aim = (Math.atan2(owner.y - sy, owner.x + dist / 5 - sx) * 180) / Math.PI;
  place(g, slot, sx, sy, (aim + 360) % 360);
  g.players[slot]!.equipWeapon(weapon, 200);
}

/** Run with per-slot action presses; returns deaths as "slot:cause". */
function run(g: Game, ticks: number, press: (slot: number, tick: number) => boolean): string[] {
  const deaths: string[] = [];
  for (let i = 0; i < ticks && g.phase === 'playing'; i++) {
    const map = new Map<SlotIndex, TronInput>();
    g.players.forEach((_, slot) => map.set(slot as SlotIndex, { steer: 0, action: press(slot, i) }));
    g.tick(map);
    g.items.length = 0;
    for (const d of g.serialize().deaths ?? []) deaths.push(`${d.slotIndex}:${d.cause}`);
  }
  return deaths;
}

describe('satellites block projectiles', () => {
  it('stop rifle fire from any side, wherever they are on their orbit, unharmed', () => {
    for (const from of DIRECTIONS) {
      for (const settle of [20, 55, 90, 125]) {
        const g = arena();
        const owner = guardedOwner(g, 1, settle);
        aimAtOwner(g, 0, owner, from, 110, 'rifle');
        const deaths = run(g, 45, (slot, i) => slot === 0 && i < 12);
        expect(deaths.filter(d => d.startsWith(`${OWNER}:`)), `from ${from.toFixed(1)}, settle ${settle}`).toEqual([]);
        expect(g.getBodyguards().length).toBe(1);
      }
    }
  });

  it('bounce a Glock bullet straight back at whoever fired it', () => {
    for (const from of DIRECTIONS) {
      for (const settle of [20, 55, 90, 125]) {
        const g = arena();
        const owner = guardedOwner(g, 1, settle);
        aimAtOwner(g, 0, owner, from, 150, 'glock');
        let returned = false;
        const deaths: string[] = [];
        const killers: (number | undefined)[] = [];
        for (let i = 0; i < 60 && g.phase === 'playing'; i++) {
          g.tick(new Map<SlotIndex, TronInput>([[0, { steer: 0, action: i === 0 }]]));
          g.items.length = 0;
          // After the bounce the bullet belongs to the satellite's owner
          if (g.getProjectiles().some(p => p.type === 'bullet' && p.ownerSlot === OWNER)) returned = true;
          for (const d of g.serialize().deaths ?? []) {
            deaths.push(`${d.slotIndex}:${d.cause}`);
            killers.push(d.by);
          }
        }
        const label = `from ${from.toFixed(1)}, settle ${settle}`;
        expect(returned, label).toBe(true);
        // The shooter kept driving down the line of fire, and so into its own bullet,
        // which now counts as the satellite owner's
        expect(deaths, label).toEqual(['0:bullet']);
        expect(killers, label).toEqual([OWNER]);
        expect(g.getBodyguards().length).toBe(1);
      }
    }
  });

  it('split up when there are two threats', () => {
    const g = arena(3);
    const owner = guardedOwner(g, 2, 40);
    aimAtOwner(g, 0, owner, Math.PI / 2, 150, 'glock');
    aimAtOwner(g, 2, owner, -Math.PI / 2, 150, 'glock');
    const deaths = run(g, 60, (slot, i) => slot !== OWNER && i === 0);
    // Both bullets were bounced back
    expect(deaths.sort()).toEqual(['0:bullet', '2:bullet']);
  });
});

describe('satellites attack intruders', () => {
  it('kill an enemy who drives into the area, before it reaches the owner', () => {
    // On a collision course from ahead of the owner (both do 1 px/tick)
    for (const from of [-1.2, -0.7, -0.2, 0.3, 0.8, 1.2]) {
      const g = arena();
      const owner = guardedOwner(g, 1, 30);
      const sx = owner.x + Math.cos(from) * 120;
      const sy = owner.y + Math.sin(from) * 120;
      let ticks = 60;
      for (let i = 0; i < 8; i++) ticks = Math.hypot(owner.x + ticks - sx, owner.y - sy);
      place(g, 0, sx, sy, ((Math.atan2(owner.y - sy, owner.x + ticks - sx) * 180) / Math.PI + 360) % 360);
      let deathDistance = -1;
      for (let i = 0; i < 150 && g.phase === 'playing'; i++) {
        g.tick(new Map());
        g.items.length = 0;
        const deaths = g.serialize().deaths ?? [];
        if (deaths.length > 0) {
          expect(deaths.map(d => `${d.slotIndex}:${d.cause}`)).toEqual(['0:bodyguard']);
          const a = g.players[0]!;
          const b = g.players[OWNER]!;
          deathDistance = Math.hypot((a.x - b.x) / 1000, (a.y - b.y) / 1000);
          break;
        }
      }
      // Caught soon after crossing the 50 px line
      expect(deathDistance, `from ${from.toFixed(1)}`).toBeGreaterThan(30);
      expect(deathDistance).toBeLessThan(52);
    }
  });

  it('leave alone an enemy who stays outside', () => {
    const g = arena();
    const owner = guardedOwner(g, 2, 30);
    // Parallel course, 70 px to the side
    place(g, 0, owner.x - 40, owner.y + 70, 0);
    expect(run(g, 150, () => false)).toEqual([]);
    for (const bg of g.getBodyguards()) {
      const o = g.players[OWNER]!;
      expect(Math.hypot((bg.x - o.x) / 1000, (bg.y - o.y) / 1000)).toBeLessThan(51);
    }
  });

  it('do not harm team-mates', () => {
    const g = arena(4, 'team');
    const owner = guardedOwner(g, 2, 30);
    // Slot 3 is on the owner's team (slots 1 and 3): drives alongside, well inside the area
    place(g, 3, owner.x - 10, owner.y + 20, 0);
    const deaths = run(g, 100, () => false);
    expect(deaths.filter(d => d.includes('bodyguard'))).toEqual([]);
    expect(g.players[3]!.alive).toBe(true);
  });
});

describe('satellites under shotgun fire', () => {
  /**
   * `blasts` shotgun blasts from 95 px, over all directions: how often the owner dies,
   * and how often a satellite disappears while its owner is still alive (never: tracers
   * cannot harm it).
   */
  function shotgun(satellites: number, blasts: number): { kills: number; cases: number; destroyed: number } {
    let kills = 0;
    let cases = 0;
    let destroyed = 0;
    for (const from of DIRECTIONS) {
      for (const settle of [20, 90]) {
        const g = arena();
        const owner = guardedOwner(g, satellites, settle);
        aimAtOwner(g, 0, owner, from, 95, 'shotgun');
        cases++;
        let lost = false;
        for (let i = 0; i < 40 && g.phase === 'playing'; i++) {
          g.tick(new Map<SlotIndex, TronInput>([[0, { steer: 0, action: i % 4 === 0 && i < blasts * 4 }]]));
          g.items.length = 0;
          const deaths = (g.serialize().deaths ?? []).map(d => `${d.slotIndex}:${d.cause}`);
          if (deaths.includes(`${OWNER}:tracer`)) {
            kills++;
            break;
          }
          if (g.players[OWNER]!.alive && g.getBodyguards().length < satellites) lost = true;
        }
        if (lost) destroyed++;
      }
    }
    return { kills, cases, destroyed };
  }

  it('one blast is stopped more often than not', () => {
    const { kills, cases } = shotgun(1, 1);
    expect(kills).toBeLessThan(cases / 2);
  });

  it('sustained fire overwhelms a lone satellite without destroying it', () => {
    const { kills, cases, destroyed } = shotgun(1, 6);
    expect(kills).toBeGreaterThan(cases * 0.75);
    expect(destroyed).toBe(0);
  });

  it('three satellites hold out', () => {
    const { kills, cases, destroyed } = shotgun(3, 6);
    expect(kills).toBeLessThan(cases / 4);
    expect(destroyed).toBe(0);
  });
});

describe('satellites and the edges of the arena', () => {
  it('fly across the screen to the wrapped position instead of through the edge, as in the original', () => {
    const g = arena();
    guardedOwner(g, 1, 20);
    place(g, OWNER, 700, 300, 0);   // Heading for the right edge
    const owner = g.players[OWNER]!;
    let crossedMiddle = 0;
    let wrapped = false;
    let lastX = owner.getScreenX();
    for (let i = 0; i < 400 && owner.alive; i++) {
      g.tick(new Map());
      g.items.length = 0;
      g.serialize();
      const x = owner.getScreenX();
      if (x < lastX - 700) wrapped = true;
      lastX = x;
      const sat = g.getBodyguards()[0]!;
      const sx = sat.x / 1000;
      // The edge is between them, yet the satellite is in the middle of the screen
      if (wrapped && sx > 200 && sx < 550) crossedMiddle++;
      if (wrapped && x > 120) break;
    }
    expect(wrapped).toBe(true);
    expect(crossedMiddle).toBeGreaterThan(10);
    // And it gets there: back in orbit on the other side
    const sat = g.getBodyguards()[0]!;
    expect(Math.hypot(sat.x / 1000 - owner.getScreenX(), sat.y / 1000 - owner.getScreenY())).toBeLessThan(40);
  });
});
