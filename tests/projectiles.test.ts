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
