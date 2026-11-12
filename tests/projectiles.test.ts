import { describe, expect, it } from 'vitest';
import { PixelGrid } from '../src/game/PixelGrid';
import { createRng } from '../src/game/rng';
import { PLAY_WIDTH } from '../src/game/constants';
import { inputs, makeGame, place, skipCountdown } from './helpers';

function arena(seed = 1, grid = new PixelGrid()): ReturnType<typeof makeGame> {
  const g = makeGame(2, seed);
  g.setLevelObstacles(grid);
  skipCountdown(g);
  g.items.length = 0;
  g.portals.length = 0;
  return g;
}

/** Player 0 fires once on the first tick; returns the deaths as "slot:cause". */
function fireAndWatch(g: ReturnType<typeof makeGame>, weapon: string, ticks: number): string[] {
  g.players[0]!.equipWeapon(weapon, 50);
  const deaths: string[] = [];
  for (let i = 0; i < ticks && g.phase === 'playing'; i++) {
    g.tick(inputs({ action: i === 0 }, {}));
    g.items.length = 0;
    for (const d of g.serialize().deaths ?? []) deaths.push(`${d.slotIndex}:${d.cause}`);
  }
  return deaths;
}

describe('projectiles and the arena edges', () => {
  // The shot leaves through the right edge on the shooter's own row. It used to sweep
  // the whole row on that tick and kill the shooter.
  for (const [weapon, ticks] of [['glock', 60], ['rifle', 60], ['bomb', 110]] as const) {
    it(`a ${weapon} shot crossing an edge hits nobody on its row`, () => {
      const g = arena();
      place(g, 0, 600, 300, 0);    // shooter heading right, 150 px from the edge
      place(g, 1, 300, 303, 180);  // bystander on (almost) the same row, heading away
      expect(fireAndWatch(g, weapon, ticks)).toEqual([]);
    });
  }

  it('a bullet still hits a player just across the edge', () => {
    const g = arena();
    place(g, 0, PLAY_WIDTH - 40, 300, 0);
    // Crossing the bullet's row just beyond the edge when it arrives
    place(g, 1, 3, 306, 270);
    expect(fireAndWatch(g, 'glock', 12)).toEqual(['1:bullet']);
  });
});

describe('tracers and the arena edges', () => {
  it('a tracer that hits something just across an edge only erases its own path', () => {
    const grid = new PixelGrid();
    // A wall along the top edge, which a tracer leaving through the bottom edge hits on
    // the very tick it wraps; and markers half-way up the arena on the column it flies along
    for (let x = 300; x <= 450; x++) for (let y = 0; y <= 5; y++) grid.set(x, y, '#fff');
    for (let x = 365; x <= 385; x++) grid.set(x, 300, '#888');
    const g = arena(1, grid);
    place(g, 0, 375, 560, 90);    // heading down, 40 px from the bottom edge
    place(g, 1, 100, 100, 180);
    g.players[0]!.equipWeapon('rifle', 200);
    for (let i = 0; i < 40; i++) {
      g.tick(inputs({ action: true }, {}));
      g.items.length = 0;
      g.serialize();
    }
    const pixels = (g as unknown as { pixels: PixelGrid }).pixels;
    // The wall was hit (so tracers did wrap)...
    let wallLeft = 0;
    for (let x = 365; x <= 385; x++) for (let y = 0; y <= 5; y++) if (pixels.has(x, y)) wallLeft++;
    expect(wallLeft).toBeLessThan(21 * 6);
    // ...and nothing was erased half-way up the arena
    for (let x = 365; x <= 385; x++) expect(pixels.has(x, 300), `marker at x=${x}`).toBe(true);
  });
});

describe('H-bomb body', () => {
  it('never flies through a player', () => {
    // Bombs fired to pass close to a moving player, from all sides
    const rng = createRng(5);
    let closeCalls = 0;
    for (let n = 0; n < 1500; n++) {
      const g = arena(n + 1);
      const targetDir = rng() * 360;
      const targetSteer = n % 3 === 0 ? 0 : rng() * 2 - 1;
      place(g, 1, 375, 300, targetDir);
      const dist = 50 + rng() * 110;
      const from = rng() * Math.PI * 2;
      const sx = 375 + Math.cos(from) * dist;
      const sy = 300 + Math.sin(from) * dist;
      const lead = (dist / 2) * (0.6 + rng() * 0.6);  // the bomb does 2 px/tick, the player 1
      const tx = 375 + Math.cos((targetDir * Math.PI) / 180) * lead;
      const ty = 300 + Math.sin((targetDir * Math.PI) / 180) * lead;
      const aim = (Math.atan2(ty - sy, tx - sx) * 180) / Math.PI + (rng() * 2 - 1) * 4;
      place(g, 0, sx, sy, (aim + 360) % 360);
      g.players[0]!.equipWeapon('bomb', 1);

      for (let i = 0; i < 160 && g.phase === 'playing'; i++) {
        g.tick(inputs({ action: i === 0 }, { steer: targetSteer }));
        g.items.length = 0;
        g.serialize();
        const bomb = g.getProjectiles().find(p => p.type === 'bomb');
        const target = g.players[1]!;
        if (!bomb || !target.alive) break;
        // Still flying: the player's head must be outside the 12x18 body
        const dx = target.getScreenX() - Math.floor(bomb.x / 1000);
        const dy = target.getScreenY() - Math.floor(bomb.y / 1000);
        const rad = (bomb.direction * Math.PI) / 180;
        const along = dx * Math.cos(rad) + dy * Math.sin(rad);
        const across = -dx * Math.sin(rad) + dy * Math.cos(rad);
        const inside = Math.abs(along) <= 9 && Math.abs(across) <= 6;
        expect(inside, `run ${n} tick ${i}: along ${along.toFixed(1)}, across ${across.toFixed(1)}`).toBe(false);
        if (Math.hypot(dx, dy) < 20) closeCalls++;
      }
    }
    // The scenario does produce near misses (otherwise this test proves nothing)
    expect(closeCalls).toBeGreaterThan(50);
  });

  it('explodes when its nose reaches a wall', () => {
    const grid = new PixelGrid();
    for (let y = 250; y < 350; y++) grid.set(500, y, '#fff');
    const g = arena(1, grid);
    place(g, 0, 300, 300, 0);
    place(g, 1, 100, 100, 180);
    g.players[0]!.equipWeapon('bomb', 1);
    let lastX = 0;
    for (let i = 0; i < 200; i++) {
      g.tick(inputs({ action: i === 0 }, {}));
      g.items.length = 0;
      g.serialize();
      const bomb = g.getProjectiles().find(p => p.type === 'bomb');
      if (!bomb) break;
      lastX = bomb.x / 1000;
    }
    expect(g.getProjectiles().length).toBe(0);
    // Its centre was still about a nose-length short of the wall
    expect(lastX).toBeGreaterThan(484);
    expect(lastX).toBeLessThan(492);
  });
});

describe('bullets against tracers', () => {
  /** Player 1 holds the trigger of `weapon`; player 0 fires one Glock bullet at it. */
  function duel(weapon: string, from: number, dist: number, seed: number): { deaths: string[]; explodedAt: number } {
    const g = arena(seed);
    place(g, 1, 375, 300, (from * 180) / Math.PI);                      // facing the shooter
    place(g, 0, 375 + Math.cos(from) * dist, 300 + Math.sin(from) * dist, ((from * 180) / Math.PI + 180) % 360);
    if (weapon === 'uzi') g.players[1]!.equipWeapon('uzi', undefined, 700);
    else g.players[1]!.equipWeapon(weapon, 200);
    g.players[0]!.equipWeapon('glock', 20);
    const deaths: string[] = [];
    let explodedAt = -1;
    for (let i = 0; i < 60 && g.phase === 'playing'; i++) {
      g.tick(inputs({ action: i === 0 }, { action: true }));
      g.items.length = 0;
      const bullet = g.getProjectiles().find(p => p.type === 'bullet');
      const target = g.players[1]!;
      if (bullet) explodedAt = Math.hypot(bullet.x / 1000 - target.x / 1000, bullet.y / 1000 - target.y / 1000);
      for (const d of g.serialize().deaths ?? []) deaths.push(`${d.slotIndex}:${d.cause}`);
    }
    return { deaths, explodedAt };
  }

  it('a bullet flying into Uzi fire explodes before it gets there', () => {
    let runs = 0;
    for (let k = 0; k < 8; k++) {
      for (const dist of [120, 200, 280]) {
        const { deaths, explodedAt } = duel('uzi', (k * Math.PI) / 4 + 0.1, dist, k + 1);
        runs++;
        expect(deaths, `direction ${k}, ${dist} px`).not.toContain('1:bullet');
        // Last seen well away from the Uzi's owner
        expect(explodedAt, `direction ${k}, ${dist} px`).toBeGreaterThan(20);
      }
    }
    expect(runs).toBe(24);
  });

  it('a bullet meeting a rifle tracer head-on explodes there', () => {
    const { deaths, explodedAt } = duel('rifle', 0, 300, 1);
    expect(deaths).not.toContain('1:bullet');
    // Both do 5 px/tick, so they meet about half-way
    expect(explodedAt).toBeGreaterThan(100);
    expect(explodedAt).toBeLessThan(200);
  });

  it('a bullet does not explode on its own shooter\'s tracers', () => {
    const g = arena();
    place(g, 0, 200, 300, 0);
    place(g, 1, 600, 100, 180);
    const shooter = g.players[0]!;
    shooter.equipWeapon('glock', 20);
    g.tick(inputs({ action: true }, {}));
    // Switch to the Uzi and spray along the bullet's line
    shooter.equipWeapon('uzi', undefined, 700);
    let flew = 0;
    for (let i = 0; i < 30; i++) {
      g.tick(inputs({ action: true }, {}));
      g.items.length = 0;
      g.serialize();
      if (g.getProjectiles().some(p => p.type === 'bullet')) flew++;
    }
    expect(flew).toBe(30);
  });
});

describe('weapon match-ups', () => {
  /** How far from the muzzle the shots of a weapon get in open space. */
  function reach(weapon: string): number {
    const g = arena();
    place(g, 0, 100, 300, 0);
    place(g, 1, 100, 500, 0);
    if (weapon === 'uzi') g.players[0]!.equipWeapon('uzi', undefined, 700);
    else g.players[0]!.equipWeapon(weapon, 200);
    let far = 0;
    for (let i = 0; i < 140; i++) {
      g.tick(inputs({ action: i < 3 }, {}));
      g.items.length = 0;
      g.serialize();
      const shooter = g.players[0]!;
      for (const p of g.getProjectiles()) far = Math.max(far, (p.x - shooter.x) / 1000);
    }
    return far;
  }

  it('Uzi is outranged by the shotgun, and the shotgun by the rifle', () => {
    const uzi = reach('uzi');
    const shotgun = reach('shotgun');
    const rifle = reach('rifle');
    expect(uzi).toBeGreaterThan(25);
    expect(uzi).toBeLessThanOrEqual(55);
    expect(shotgun).toBeGreaterThan(200);
    expect(shotgun).toBeLessThanOrEqual(310);
    expect(rifle).toBeGreaterThan(450);
  });

  it('shotgun fire stops a Glock bullet', () => {
    for (let k = 0; k < 8; k++) {
      const from = (k * Math.PI) / 4 + 0.1;
      const g = arena(k + 1);
      place(g, 1, 375, 300, (from * 180) / Math.PI);
      place(g, 0, 375 + Math.cos(from) * 220, 300 + Math.sin(from) * 220, ((from * 180) / Math.PI + 180) % 360);
      g.players[1]!.equipWeapon('shotgun', 20);
      g.players[0]!.equipWeapon('glock', 20);
      const deaths: string[] = [];
      for (let i = 0; i < 50 && g.phase === 'playing'; i++) {
        // The bullet is fired first; the shotgun answers
        g.tick(inputs({ action: i === 0 }, { action: i === 4 }));
        g.items.length = 0;
        for (const d of g.serialize().deaths ?? []) deaths.push(`${d.slotIndex}:${d.cause}`);
      }
      expect(deaths, `direction ${k}`).not.toContain('1:bullet');
    }
  });

  it('a rifle tracer must touch the target, a Glock bullet only has to come close', () => {
    // Both fired along a line passing 4 px beside a player crossing ahead
    const outcome = (weapon: string): string[] => {
      const g = arena();
      place(g, 0, 200, 300, 0);
      // 104 px ahead, 4 px off the line, moving along it so the offset stays
      place(g, 1, 304, 304, 0);
      return fireAndWatch(g, weapon, 60);
    };
    expect(outcome('glock')).toContain('1:bullet');
    expect(outcome('rifle')).toEqual([]);
  });
});

describe('shooting down an H-bomb', () => {
  /** Player 0 launches a bomb to the right and gets well clear of it. */
  function bombInFlight(): { g: ReturnType<typeof arena>; bomb: () => { x: number; y: number } | undefined } {
    const g = arena();
    place(g, 0, 200, 300, 0);
    place(g, 1, 600, 500, 180);
    g.players[0]!.equipWeapon('bomb', 1);
    g.tick(inputs({ action: true }, {}));
    g.items.length = 0;
    // The bomb does 2 px/tick and the bomber 1: let it get out of its own blast radius
    for (let i = 0; i < 80; i++) g.tick(inputs({}, {}));
    g.serialize();
    return { g, bomb: () => g.getProjectiles().find(p => p.type === 'bomb') };
  }
  /** A level-gun style tracer at 40 px/tick, going up, starting 20 px below (x, y). */
  function tracerBelow(g: ReturnType<typeof arena>, x: number, y: number): void {
    (g.getProjectiles() as unknown as Record<string, unknown>[]).push({
      id: 9999, x, y: y + 20_000, direction: 270, ownerSlot: -1,
      speed: 40_000, type: 'tracer', remainingFrames: 10, ownerCooldown: 0,
    });
  }
  const blasts = (g: ReturnType<typeof arena>): number =>
    g.serialize().round.explosions.filter(e => (e.scale ?? 1) > 1 && e.frame === 0).length;

  it('a single fast tracer through its body sets it off', () => {
    const { g, bomb } = bombInFlight();
    const b = bomb()!;
    // Its end positions are 20 px either side of the bomb: only the path crosses it
    tracerBelow(g, b.x + 2000, b.y);
    g.tick(inputs({}, {}));
    expect(bomb()).toBeUndefined();
    expect(blasts(g)).toBe(1);
    expect(g.getProjectiles().some(p => p.id === 9999)).toBe(false);
    // The bomber was far enough away
    expect(g.players[0]!.alive).toBe(true);
  });

  it('a tracer passing beside it does nothing', () => {
    const { g, bomb } = bombInFlight();
    const b = bomb()!;
    tracerBelow(g, b.x + 30_000, b.y);
    g.tick(inputs({}, {}));
    expect(bomb()).toBeDefined();
    expect(blasts(g)).toBe(0);
    expect(g.getProjectiles().some(p => p.id === 9999)).toBe(true);
  });

  it('rifle fire sets off an oncoming bomb before it arrives', () => {
    const g = arena();
    place(g, 0, 150, 300, 0);     // bomber, heading right
    place(g, 1, 600, 300, 180);   // rifle, facing the bomb
    g.players[0]!.equipWeapon('bomb', 1);
    g.players[1]!.equipWeapon('rifle', 200);
    const seen: number[] = [];
    for (let i = 0; i < 90 && g.phase === 'playing'; i++) {
      g.tick(inputs({ action: i === 0 }, { action: true }));
      g.items.length = 0;
      const frame = g.serialize();
      for (const e of frame.round.explosions) {
        if ((e.scale ?? 1) > 1 && e.frame === 0) seen.push(Math.abs(e.x - g.players[1]!.x / 1000));
      }
    }
    // It blew up in mid-flight, far from the rifle
    expect(seen.length).toBe(1);
    expect(seen[0]).toBeGreaterThan(100);
    expect(g.getProjectiles().some(p => p.type === 'bomb')).toBe(false);
    expect(g.players[1]!.alive).toBe(true);
  });
});

describe('H-bomb blast', () => {
  /** Detonate a bomb on a wall at x = 400 and return the game right after. */
  function detonate(setup: (g: ReturnType<typeof arena>) => void): { g: ReturnType<typeof arena>; x: number; y: number } {
    const grid = new PixelGrid();
    for (let y = 290; y <= 310; y++) grid.set(400, y, '#fff');
    // Something to erase all around
    for (let y = 200; y <= 400; y += 2) for (let x = 300; x <= 500; x += 2) if (x !== 400) grid.set(x, y, '#888');
    const g = arena(1, grid);
    // The bomber comes along a corridor cleared in the filler
    for (let x = 150; x < 400; x++) for (let y = 292; y <= 308; y++) (g as unknown as { pixels: PixelGrid }).pixels.delete(x, y);
    place(g, 0, 200, 300, 0);
    place(g, 1, 700, 550, 180);
    setup(g);
    g.players[0]!.equipWeapon('bomb', 1);
    let at = { x: 0, y: 0 };
    for (let i = 0; i < 200; i++) {
      g.tick(inputs({ action: i === 0 }, {}));
      const blast = g.serialize().round.explosions.find(e => (e.scale ?? 1) > 1);
      if (blast) {
        at = { x: blast.x, y: blast.y };
        break;
      }
    }
    return { g, ...at };
  }

  it('clears a disc of 60 px, not a square', () => {
    const { g, x, y } = detonate(() => {});
    const pixels = (g as unknown as { pixels: PixelGrid }).pixels;
    expect(x).toBe(400);
    // Inside the disc: gone. In the corners of the old 120 px square: still there.
    expect(pixels.has(x + 40, y + 40)).toBe(false);          // 56.6 px away
    expect(pixels.has(x - 58, y)).toBe(false);
    expect(pixels.has(x + 50, y + 50)).toBe(true);           // 70.7 px away
    expect(pixels.has(x - 56, y - 56)).toBe(true);
    expect(pixels.has(x + 62, y)).toBe(true);
  });

  it('kills players and destroys items within a circle', () => {
    const { g } = detonate(game => {
      // 45 px away diagonally would be inside the old 50 px square (32, 32 offsets
      // are), 40/40 is 56.6 px away: outside the circle but inside the old square
      game.items.push({ id: 1, sprite: 'glock', category: 'weapon', x: 400 + 45, y: 300 + 45, active: true, hp: 40 }); // 63.6 px: inside 70
      game.items.push({ id: 2, sprite: 'glock', category: 'weapon', x: 400 + 55, y: 300 + 55, active: true, hp: 40 }); // 77.8 px: outside, old square would take it
    });
    expect(g.items.find(i => i.id === 1)!.active).toBe(false);
    expect(g.items.find(i => i.id === 2)!.active).toBe(true);
  });
});
