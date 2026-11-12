import { describe, expect, it } from 'vitest';
import { GUN_BURST_CHANCE, inFireZone } from '../src/game/guns';
import { LEVEL_DEFINITIONS, NO_OWNER } from '../src/types/game';
import { serializeState, deserializeState } from '../src/network/serialization';
import { loadLevelGrid, makeGame, place, skipCountdown } from './helpers';
import { runMatch } from './sim';

const GUNS = LEVEL_DEFINITIONS.find(l => l.id === 'warzone')!.guns!;

function game(level: string, seed = 1): ReturnType<typeof makeGame> {
  const g = makeGame(2, seed, { level });
  g.setLevelObstacles(loadLevelGrid(level));
  skipCountdown(g);
  g.items.length = 0;
  g.portals.length = 0;
  return g;
}

const lastProjectileId = new WeakMap<object, number>();

/** Tick with both players circling harmlessly; returns per-tick new projectile batches. */
function watch(g: ReturnType<typeof makeGame>, ticks: number): { bursts: number; sounds: number; deaths: string[] } {
  let bursts = 0;
  let sounds = 0;
  const deaths: string[] = [];
  for (let i = 0; i < ticks && g.phase === 'playing'; i++) {
    g.tick(new Map());
    g.items.length = 0;
    const lastId = lastProjectileId.get(g) ?? -1;
    const fresh = g.getProjectiles().filter(p => p.id > lastId);
    if (fresh.length > 0) {
      bursts++;
      lastProjectileId.set(g, Math.max(...fresh.map(p => p.id)));
    }
    const frame = g.serialize();
    sounds += frame.soundEvents.filter(s => s.sound === 'explosion').length;
    for (const d of frame.deaths ?? []) deaths.push(`${d.slotIndex}:${d.cause}`);
  }
  return { bursts, sounds, deaths };
}

describe('level guns', () => {
  it('point the way the original control points say', () => {
    expect(GUNS.length).toBe(2);
    expect(GUNS[0]!.direction).toBeGreaterThan(340);   // tank: right, slightly up
    expect(GUNS[0]!.direction).toBeLessThan(350);
    expect(GUNS[1]!.direction).toBeGreaterThan(168);   // cannon: left, slightly down
    expect(GUNS[1]!.direction).toBeLessThan(176);
    expect(inFireZone(GUNS[0]!, 485, 226)).toBe(true);
    expect(inFireZone(GUNS[0]!, 285, 250)).toBe(false);
    expect(inFireZone(GUNS[0]!, 385, 350)).toBe(false);
  });

  it('fire bursts of ownerless pellets inside the cone', () => {
    const g = game('warzone');
    place(g, 0, 100, 100, 0);
    place(g, 1, 100, 500, 0);
    let pellets = g.getProjectiles();
    for (let i = 0; i < 600 && pellets.length === 0; i++) {
      g.tick(new Map());
      pellets = g.getProjectiles();
      place(g, 0, 100, 100, 0);
      place(g, 1, 100, 500, 0);
    }
    // Some pellets end at once on the scenery around the muzzle
    expect(pellets.length).toBeGreaterThan(10);
    expect(pellets.length).toBeLessThanOrEqual(30);
    const gun = GUNS.find(c => pellets.every(p => {
      const diff = Math.abs(((p.direction - c.direction + 540) % 360) - 180);
      return diff <= 5.001;
    }));
    expect(gun).toBeDefined();
    for (const p of pellets) {
      expect(p.ownerSlot).toBe(NO_OWNER);
      expect(p.type).toBe('tracer');
    }
    // Survives the wire
    const state = deserializeState(serializeState(g.serialize()));
    expect(state.round.projectiles.length).toBe(pellets.length);
    expect(state.round.projectiles[0]!.ownerSlot).toBe(NO_OWNER);
  });

  it('fire at about the original rate, with a sound, and only on their level', () => {
    let bursts = 0;
    let sounds = 0;
    let ticks = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const g = game('warzone', seed);
      for (let i = 0; i < 1000; i++) {
        // Keep both players parked out of harm's way
        place(g, 0, 100, 100, 0);
        place(g, 1, 100, 500, 0);
        const w = watch(g, 1);
        bursts += w.bursts;
        sounds += w.sounds;
        ticks++;
      }
    }
    const expected = ticks * GUN_BURST_CHANCE;
    expect(bursts).toBeGreaterThan(expected * 0.6);
    expect(bursts).toBeLessThan(expected * 1.5);
    expect(sounds).toBe(bursts);

    const blank = game('blank');
    let any = 0;
    for (let i = 0; i < 1000; i++) {
      place(blank, 0, 100, 100, 0);
      place(blank, 1, 100, 500, 0);
      any += watch(blank, 1).bursts;
    }
    expect(any).toBe(0);
  });

  it('kill a player in front of the muzzle', () => {
    const g = game('warzone');
    const deaths: string[] = [];
    for (let i = 0; i < 3000 && deaths.length === 0; i++) {
      // Hold player 0 right in front of the tank, facing away from it
      place(g, 0, 425, 240, 346);
      place(g, 1, 100, 500, 0);
      deaths.push(...watch(g, 1).deaths);
    }
    expect(deaths).toEqual(['0:tracer']);
  });

  it('do not fire outside the playing phase', () => {
    const g = game('warzone');
    g.players[1]!.kill();
    g.tick(new Map());
    expect(g.phase).toBe('waiting_ready');
    const before = g.getProjectiles().length;
    for (let i = 0; i < 2000; i++) g.tick(new Map());
    expect(g.getProjectiles().length).toBe(before);
  });
});

describe('bots and guns', () => {
  it('are rarely shot by the level', () => {
    // Calm bots do not use weapons, so every tracer death is the level's doing
    const r = runMatch({ level: 'warzone', drivers: ['calm-normal', 'calm-hard'], rounds: 10, seed: 4, maxRoundSeconds: 45 });
    const causes = r.flatMap(x => x.deathCause).filter(c => c !== null);
    console.log('warzone deaths:', causes.join(', '));
    expect(causes.filter(c => c!.startsWith('tracer')).length).toBeLessThanOrEqual(3);
  }, 120_000);
});
