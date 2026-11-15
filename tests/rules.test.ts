import { describe, expect, it } from 'vitest';
import { PixelGrid } from '../src/game/PixelGrid';
import { serializeState, deserializeState } from '../src/network/serialization';
import { createRng } from '../src/game/rng';
import { PLAY_WIDTH, PLAY_HEIGHT, READY_LOCK_TICKS } from '../src/game/constants';
import type { SlotIndex } from '../src/types/lobby';
import type { TronInput } from '../src/types/game';
import { inputs, loadLevelGrid, makeGame, place, skipCountdown } from './helpers';
import { describeDeath } from '../src/game/deathLabels';
import { describeLevels, normalizeLevelMode, toggleLevel } from '../src/game/levelMode';
import { LEVEL_DEFINITIONS } from '../src/types/game';

function wallLevel(): PixelGrid {
  const level = new PixelGrid();
  for (let y = 0; y < PLAY_HEIGHT; y++) level.set(400, y, '#808080');
  return level;
}

/** End the current round by killing everybody but player 0, then ready up. */
function finishRoundAndReady(game: ReturnType<typeof makeGame>): void {
  for (const p of game.players.slice(1)) p.kill();
  game.tick(new Map());
  game.serialize();
  expect(game.phase).toBe('waiting_ready');
  for (let i = 0; i < READY_LOCK_TICKS; i++) game.tick(new Map());
  const press = inputs(...game.players.map(() => ({ action: true })));
  game.tick(press);
  game.serialize();
}

describe('round lifecycle', () => {
  it('ignores action presses in the first second after a round ends', () => {
    const game = makeGame(2);
    skipCountdown(game);
    game.players[1]!.kill();
    game.tick(new Map());
    expect(game.phase).toBe('waiting_ready');
    const press = inputs({ action: true }, { action: true });
    const release = inputs({}, {});
    // Taps during the lock do nothing
    for (let i = 0; i < READY_LOCK_TICKS - 1; i++) game.tick(i % 2 === 0 ? press : release);
    game.tick(press);
    expect(game.playersReady.size).toBe(0);
    // A button held through the lock does not count either
    game.tick(press);
    game.tick(press);
    expect(game.phase).toBe('waiting_ready');
    // Released and pressed again: ready
    game.tick(release);
    game.tick(press);
    expect(game.phase).toBe('countdown');
  });

  it('counts down, plays and awards the round to the survivor', () => {
    const game = makeGame(2);
    expect(game.phase).toBe('countdown');
    skipCountdown(game);
    expect(game.phase).toBe('playing');
    game.players[1]!.kill();
    game.tick(new Map());
    expect(game.phase).toBe('waiting_ready');
    expect(game.roundWinner).toBe(0);
    expect(game.scores.get(0)).toBe(1);
  });

  it('freezes projectiles and bodyguards when the round ends', () => {
    const game = makeGame(2);
    skipCountdown(game);
    const p = game.players[0]!;
    // Give player 0 a bodyguard and a rifle, and fire a few tracers
    game.items.length = 0;
    game.items.push({ id: 900, sprite: 'bodyguard_item', category: 'automatic', x: p.getScreenX() + 6, y: p.getScreenY() + 6, active: true, hp: 40 });
    for (let i = 0; i < 12; i++) game.tick(new Map());
    p.equipWeapon('rifle', 200);
    for (let i = 0; i < 4; i++) game.tick(inputs({ action: true }));
    expect(game.getBodyguards().length).toBe(1);
    expect(game.getProjectiles().length).toBeGreaterThan(0);

    game.players[1]!.kill();
    game.tick(new Map());
    expect(game.phase).toBe('waiting_ready');
    const snapshot = JSON.stringify([game.getProjectiles(), game.getBodyguards()]);
    for (let i = 0; i < 50; i++) game.tick(new Map());
    expect(JSON.stringify([game.getProjectiles(), game.getBodyguards()])).toBe(snapshot);
  });

  it('flags the start of every round for the renderer', () => {
    const game = makeGame(2);
    expect(game.serialize().roundStarted).toBe(true);
    expect(game.serialize().roundStarted).toBeUndefined();
    skipCountdown(game);
    finishRoundAndReady(game);
    expect(game.phase).toBe('countdown');
    expect(game.currentRound).toBe(2);
  });

  it('keeps level obstacles on later rounds of the same level (B1)', () => {
    const game = makeGame(2);
    game.setLevelObstacles(wallLevel());
    skipCountdown(game);
    expect(game.pixels.has(400, 300)).toBe(true);
    finishRoundAndReady(game);
    expect(game.currentRound).toBe(2);
    expect(game.pixels.has(400, 300)).toBe(true);
    // ...and trails from the previous round are gone
    expect(game.pixels.count()).toBe(PLAY_HEIGHT);
  });
});

describe('who did it', () => {
  /** Deaths of a short run as "victim:cause:by". */
  function deathsOf(game: ReturnType<typeof makeGame>, ticks: number, press: (tick: number) => Partial<TronInput>[]): string[] {
    const out: string[] = [];
    for (let i = 0; i < ticks && game.phase === 'playing'; i++) {
      game.tick(inputs(...press(i)));
      game.items.length = 0;
      for (const d of game.serialize().deaths ?? []) out.push(`${d.slotIndex}:${d.cause}:${d.by ?? '-'}`);
    }
    return out;
  }
  const open = (players = 2, mode: 'ffa' | 'team' = 'ffa'): ReturnType<typeof makeGame> => {
    const game = makeGame(players, 1, { mode });
    game.setLevelObstacles(new PixelGrid());
    skipCountdown(game);
    game.items.length = 0;
    game.portals.length = 0;
    game.players.forEach((_, i) => place(game, i, 60, 480 + i * 30, 0));
    return game;
  };

  it('names the shooter of a tracer and of a bullet', () => {
    for (const [weapon, cause] of [['rifle', 'tracer'], ['glock', 'bullet']] as const) {
      const game = open();
      place(game, 0, 200, 300, 0);
      place(game, 1, 320, 300, 180);     // coming the other way
      game.players[0]!.equipWeapon(weapon, 200);
      // (a whole rifle burst: one tracer alone lands every 5 px and may jump over a head)
      expect(deathsOf(game, 60, i => [{ action: i < 5 }, {}])).toContain(`1:${cause}:0`);
    }
  });

  it('says so when players blow themselves up', () => {
    const grid = new PixelGrid();
    for (let y = 280; y < 320; y++) grid.set(206, y, '#fff');
    const game = open();
    game.setLevelObstacles(grid);
    place(game, 0, 200, 300, 0);
    game.players[0]!.equipWeapon('glock', 20);
    expect(deathsOf(game, 5, () => [{ action: true }, {}])).toEqual(['0:bullet:0']);
  });

  it('names the bomber for everyone caught in the blast', () => {
    const grid = new PixelGrid();
    for (let y = 250; y < 350; y++) grid.set(330, y, '#fff');
    const game = open(3);
    game.setLevelObstacles(grid);
    place(game, 0, 200, 300, 0);
    place(game, 1, 350, 260, 90);      // behind the wall the bomb hits, when it hits
    game.players[0]!.equipWeapon('bomb', 1);
    const deaths = deathsOf(game, 70, i => [{ action: i === 0 }, {}, {}]);
    expect(deaths).toContain('1:bomb:0');
  });

  it('names the owner of a trail in free-for-all only', () => {
    const crash = (mode: 'ffa' | 'team'): string[] => {
      const game = open(mode === 'team' ? 4 : 2, mode);
      place(game, 0, 200, 300, 0);       // lays a trail to the right
      for (let i = 0; i < 30; i++) game.tick(new Map());
      place(game, 1, 215, 280, 90);      // drives down into it
      return deathsOf(game, 40, () => []);
    };
    expect(crash('ffa')).toEqual(['1:trail:0']);
    expect(crash('team')).toEqual(['1:trail:-']);
  });

  it('describes deaths with the killer in them', () => {
    expect(describeDeath('tracer', 'Ana', false, false)).toBe('shot by Ana');
    expect(describeDeath('tracer', 'Me', true, false)).toBe('shot by their own bullet');
    expect(describeDeath('tracer', null, false, true)).toBe('shot by the level');
    expect(describeDeath('bullet', 'Ana', false, false)).toBe('blown up by Ana');
    expect(describeDeath('bullet', 'Me', true, false)).toBe('blown up by their own bullet');
    expect(describeDeath('bomb', 'Ana', false, false)).toBe('bombed by Ana');
    expect(describeDeath('bomb', 'Me', true, false)).toBe('bombed by their own bomb');
    expect(describeDeath('bomb', null, false, false)).toBe('bombed');
    expect(describeDeath('bodyguard', 'Ana', false, false)).toBe("killed by Ana's satellite");
    expect(describeDeath('trail', 'Ana', false, false)).toBe("crashed into Ana's trail");
    expect(describeDeath('trail', null, false, false)).toBe('crashed into a trail');
    expect(describeDeath('crossing', 'Ana', false, false)).toBe('head-on collision with Ana');
    expect(describeDeath('own-trail', null, false, false)).toBe('crashed into their own trail');
  });
});

describe('speed weapons', () => {
  it('in free-for-all the Slow weapon slows everybody else', () => {
    const game = makeGame(3);
    skipCountdown(game);
    game.players[0]!.equipWeapon('slow', undefined, 700);
    game.tick(inputs({ action: true }));
    expect(game.serialize().round.players.map(p => p.speed)).toEqual([1, 0, 0]);
  });
});

describe('death', () => {
  it('takes away the weapon and the effects', () => {
    const game = makeGame(3);
    skipCountdown(game);
    const p = game.players[0]!;
    p.equipWeapon('glock', 20);
    p.activateEffect('shield', 2100);
    expect(game.serialize().round.players[0]!.equippedWeapon).not.toBeNull();
    p.kill();
    game.tick(new Map());
    const state = game.serialize().round.players[0]!;
    expect(state.alive).toBe(false);
    expect(state.equippedWeapon).toBeNull();
    expect(state.activeEffects).toEqual([]);
  });
});

describe('level selection', () => {
  const levelsPlayed = (mode: string, rounds: number): string[] => {
    const game = makeGame(2, 1, { level: mode });
    const played: string[] = [];
    for (let i = 0; i < rounds; i++) {
      played.push(LEVEL_DEFINITIONS[game.currentLevelIndex]!.id);
      skipCountdown(game);
      finishRoundAndReady(game);
    }
    return played;
  };

  it('cycles through every level, stays on a single one, or cycles through a chosen few', () => {
    const all = LEVEL_DEFINITIONS.map(l => l.id);
    expect(levelsPlayed('cycle', all.length + 1)).toEqual([...all, all[0]]);
    expect(levelsPlayed('bus', 3)).toEqual(['bus', 'bus', 'bus']);
    // In the order of the level list, whatever the order they were chosen in
    expect(levelsPlayed('selva,blank,bus', 5)).toEqual(['blank', 'selva', 'bus', 'blank', 'selva']);
    // Unknown ids are ignored; nothing valid means every level
    expect(levelsPlayed('nope,bricks', 2)).toEqual(['bricks', 'bricks']);
    expect(levelsPlayed('nope', 2)).toEqual(all.slice(0, 2));
  });

  it('the picker: a tap on "all" means only that level, then levels are added and removed', () => {
    expect(toggleLevel('cycle', 'bricks')).toBe('bricks');
    expect(toggleLevel('bricks', 'blank')).toBe('blank,bricks');
    expect(toggleLevel('blank,bricks', 'blank')).toBe('bricks');
    expect(toggleLevel('bricks', 'bricks')).toBe('bricks');   // The last one stays
    const allButOne = LEVEL_DEFINITIONS.slice(1).map(l => l.id).join(',');
    expect(toggleLevel(allButOne, LEVEL_DEFINITIONS[0]!.id)).toBe('cycle');
    expect(normalizeLevelMode('bus,nope,blank')).toBe('blank,bus');
    expect(normalizeLevelMode(undefined)).toBe('cycle');
    expect(describeLevels('cycle')).toBe('All levels');
    expect(describeLevels('bus,blank')).toBe('Blank, Bus');
  });
});

describe('death explosion', () => {
  it('every death goes off with a harmless explosion where the player was, also the last one', () => {
    const game = makeGame(3);
    game.setLevelObstacles(wallLevel());
    skipCountdown(game);
    game.items.length = 0;
    place(game, 0, 100, 100, 0);
    place(game, 1, 100, 300, 0);
    place(game, 2, 396, 500, 0); // About to hit the wall at x = 400
    let death: { x: number; y: number } | null = null;
    for (let i = 0; i < 10 && !death; i++) {
      game.tick(new Map());
      game.items.length = 0;
      const frame = game.serialize();
      const d = (frame.deaths ?? [])[0];
      if (d) {
        death = { x: d.x, y: d.y };
        expect(d.slotIndex).toBe(2);
        expect(frame.round.explosions.map(e => [e.x, e.y, e.frame])).toEqual([[d.x, d.y, 1]]);
      }
    }
    expect(death).not.toBeNull();
    // Nothing else is harmed and nothing is erased: the wall is still there
    expect(game.players[0]!.alive && game.players[1]!.alive).toBe(true);
    expect(game.pixels.has(400, death!.y)).toBe(true);

    // The death that ends the round: its explosion still plays to the end
    game.players[1]!.x = 396 * 1000;
    let ended = false;
    for (let i = 0; i < 10 && !ended; i++) {
      game.tick(new Map());
      game.items.length = 0;
      game.serialize();
      ended = game.phase === 'waiting_ready';
    }
    expect(ended).toBe(true);
    let frames = 0;
    while (game.serialize().round.explosions.length > 0 && frames < 100) {
      game.tick(new Map());
      frames++;
    }
    expect(frames).toBeGreaterThan(20);
    expect(frames).toBeLessThan(45);
  });
});

describe('team scoring', () => {
  const team = (): ReturnType<typeof makeGame> => {
    const game = makeGame(4, 1, { mode: 'team' });
    skipCountdown(game);
    return game;
  };
  const scores = (game: ReturnType<typeof makeGame>): number[] => [0, 1, 2, 3].map(s => game.scores.get(s as SlotIndex) ?? 0);

  it('a team finishing with both members alive scores 2', () => {
    const game = team();
    game.players[1]!.kill();
    game.players[3]!.kill();
    game.tick(new Map());
    expect(game.phase).toBe('waiting_ready');
    expect(scores(game)).toEqual([1, 0, 1, 0]);
  });

  it('only the survivor scores when a team-mate died on the way', () => {
    const game = team();
    game.players[0]!.kill();
    game.tick(new Map());
    expect(game.phase).toBe('playing');
    game.players[1]!.kill();
    game.players[3]!.kill();
    game.tick(new Map());
    expect(game.phase).toBe('waiting_ready');
    // Purple (slots 0 and 2) won with one member standing: team score 1
    expect(scores(game)).toEqual([0, 0, 1, 0]);
    expect(game.roundWinner).toBe(2);
  });

  it('the Slow weapon slows the other team, not a team-mate', () => {
    const game = team();
    game.players[0]!.equipWeapon('slow', undefined, 700);
    game.tick(inputs({ action: true }));
    const speeds = game.serialize().round.players.map(p => p.speed);
    // Slots 0 and 2 are team-mates
    expect(speeds).toEqual([1, 0, 1, 0]);
  });

  it('a draw scores nothing', () => {
    const game = team();
    for (const p of game.players) p.kill();
    game.tick(new Map());
    expect(game.phase).toBe('waiting_ready');
    expect(scores(game)).toEqual([0, 0, 0, 0]);
    expect(game.roundWinner).toBe('draw');
  });
});

describe('collisions', () => {
  it('kills a player that drives into a level wall', () => {
    const game = makeGame(2);
    game.setLevelObstacles(wallLevel());
    skipCountdown(game);
    place(game, 0, 390.5, 300.5, 0);
    for (let i = 0; i < 20 && game.players[0]!.alive; i++) game.tick(new Map());
    expect(game.players[0]!.alive).toBe(false);
    expect(game.players[0]!.getScreenX()).toBe(400);
  });

  it('kills a player crossing another trail and counts own-colour deaths as ridiculous', () => {
    const game = makeGame(2);
    skipCountdown(game);
    // Player 1 draws a horizontal line, player 0 drives into it
    place(game, 1, 100.5, 300.5, 0);
    place(game, 0, 120.5, 200.5, 90);
    for (let i = 0; i < 200 && game.players[0]!.alive; i++) game.tick(new Map());
    expect(game.players[0]!.alive).toBe(false);
    expect(game.players[1]!.alive).toBe(true);
    expect(game.ridiculousDeaths.get(0)).toBe(0);

    // A full-lock turn makes a ~29px-diameter circle: the player hits its own trail
    const solo = makeGame(2);
    skipCountdown(solo);
    place(solo, 0, 300.5, 300.5, 0);
    place(solo, 1, 600.5, 100.5, 0);
    for (let i = 0; i < 200 && solo.players[0]!.alive; i++) solo.tick(inputs({ steer: 1 }));
    expect(solo.players[0]!.alive).toBe(false);
    expect(solo.ridiculousDeaths.get(0)).toBe(1);
  });

  it('does not kill players when one of them wraps around an edge (B6)', () => {
    const game = makeGame(2);
    skipCountdown(game);
    // P0 wraps horizontally at y≈299.5; P1 crosses y=299.5 in the middle of the arena.
    // The naive segment (749,299)->(0,300) would intersect P1's move.
    place(game, 0, 749.5, 299.9, 10);
    place(game, 1, 375.5, 299.5, 90);
    game.tick(new Map());
    expect(game.players[0]!.getScreenX()).toBe(0);
    expect(game.players[0]!.alive).toBe(true);
    expect(game.players[1]!.alive).toBe(true);
  });

  it('still kills on a true diagonal crossing', () => {
    const game = makeGame(2);
    skipCountdown(game);
    // Two players crossing the same point on perpendicular diagonals
    place(game, 0, 300.1, 300.1, 45);
    place(game, 1, 301.9, 300.1, 135);
    for (let i = 0; i < 5; i++) game.tick(new Map());
    expect(game.players.some(p => !p.alive)).toBe(true);
  });

  describe('the shield', () => {
    const deaths = (game: ReturnType<typeof makeGame>, ticks: number, press: Partial<TronInput>[] = []): string[] => {
      const out: string[] = [];
      for (let i = 0; i < ticks && game.phase === 'playing'; i++) {
        game.tick(inputs(...(i < 5 ? press : [])));
        game.items.length = 0;
        for (const d of game.serialize().deaths ?? []) out.push(`${d.slotIndex}:${d.cause}:${d.by ?? '-'}`);
      }
      return out;
    };
    const shielded = (walls = new PixelGrid()): ReturnType<typeof makeGame> => {
      const game = makeGame(2);
      game.setLevelObstacles(walls);
      skipCountdown(game);
      game.items.length = 0;
      game.portals.length = 0;
      place(game, 0, 60.5, 500.5, 0);
      place(game, 1, 60.5, 100.5, 0);
      game.players[1]!.activateEffect('shield', 2100);
      return game;
    };

    it('goes through level walls and through trails', () => {
      const game = shielded(wallLevel());
      place(game, 1, 390.5, 300.5, 0);     // Into the wall at x = 400
      place(game, 0, 420.5, 280.5, 90);    // ...and then a trail across the way
      expect(deaths(game, 60)).toEqual([]);
      expect(game.players[1]!.getScreenX()).toBeGreaterThan(430);
    });

    it('does not go through the head of another player', () => {
      // Head-on, whoever gets to move onto the other's head: both die
      for (const gap of [20, 21]) {
        const game = shielded();
        place(game, 0, 300.5, 300.5, 0);
        place(game, 1, 300.5 + gap, 300.5, 180);
        expect(deaths(game, 30).sort(), `${gap} px apart`).toEqual(['0:crossing:1', '1:crossing:0']);
      }
      // The same on crossing diagonals: both
      const diagonal = shielded();
      diagonal.players[0]!.activateEffect('shield', 2100);
      place(diagonal, 0, 300.1, 300.1, 45);
      place(diagonal, 1, 301.9, 300.1, 135);
      expect(deaths(diagonal, 5).sort()).toEqual(['0:crossing:1', '1:crossing:0']);
    });

    it('stops neither tracers nor bullets', () => {
      for (const [weapon, cause] of [['rifle', 'tracer'], ['glock', 'bullet']] as const) {
        const game = shielded();
        place(game, 0, 200, 300, 0);
        place(game, 1, 320, 300, 180);
        game.players[0]!.equipWeapon(weapon, 200);
        expect(deaths(game, 60, [{ action: true }, {}])).toContain(`1:${cause}:0`);
      }
    });
  });

  it('wraps around the arena edges', () => {
    const game = makeGame(2);
    skipCountdown(game);
    place(game, 0, 748.5, 10.5, 0);
    for (let i = 0; i < 5; i++) game.tick(new Map());
    const p = game.players[0]!;
    expect(p.alive).toBe(true);
    expect(p.getScreenX()).toBe(3);
  });
});

describe('level damage', () => {
  it('eraser restores the pristine level and removes trails (B7)', () => {
    const game = makeGame(2);
    game.setLevelObstacles(wallLevel());
    skipCountdown(game);
    for (let i = 0; i < 30; i++) game.tick(new Map());
    // Simulate weapon damage to the wall
    game.pixels.clearRect(395, 295, 10, 10);
    expect(game.pixels.has(400, 300)).toBe(false);
    // Drop an eraser right in front of player 0
    const p = game.players[0]!;
    game.items.length = 0;
    game.items.push({ id: 999, sprite: 'eraser', category: 'automatic', x: p.getScreenX() + 5, y: p.getScreenY() + 5, active: true, hp: 40 });
    let erased = false;
    for (let i = 0; i < 30 && !erased; i++) {
      game.tick(new Map());
      erased = game.serialize().eraserUsed === true;
    }
    expect(erased).toBe(true);
    expect(game.pixels.has(400, 300)).toBe(true);
    expect(game.pixels.count()).toBeLessThan(PLAY_HEIGHT + 10);
  });
});

describe('fuzz', () => {
  // Random inputs on real levels for several rounds: nothing throws, the state always
  // serializes, and invariants hold.
  const levels = ['blank', 'bricks', 'warzone', 'portals'];
  for (const [i, level] of levels.entries()) {
    it(`survives random play on ${level}`, () => {
      const game = makeGame(4, 100 + i, { level });
      game.setLevelObstacles(loadLevelGrid(level));
      const rng = createRng(7 + i);
      const held = new Map<SlotIndex, TronInput>();
      let roundsFinished = 0;
      for (let tick = 0; tick < 30_000 && roundsFinished < 6; tick++) {
        for (const p of game.players) {
          if (rng() < 0.05 || !held.has(p.slotIndex)) {
            held.set(p.slotIndex, { steer: Math.floor(rng() * 3) - 1, action: rng() < 0.5 });
          }
        }
        const before = game.currentRound;
        game.tick(held);
        const state = game.serialize();
        if (game.currentRound !== before) roundsFinished++;
        for (const p of state.round.players) {
          expect(p.x).toBeGreaterThanOrEqual(0);
          expect(p.x).toBeLessThan(PLAY_WIDTH * 1000);
          expect(p.y).toBeGreaterThanOrEqual(0);
          expect(p.y).toBeLessThan(PLAY_HEIGHT * 1000);
        }
        if (tick % 50 === 0) {
          const copy = deserializeState(serializeState(state), state.round.players);
          expect(copy.round.players).toEqual(state.round.players.map(p => ({ ...p, x: Math.round(p.x), y: Math.round(p.y) })));
          expect(copy.round.items).toEqual(state.round.items.filter(i => i.active));
          expect(copy.round.projectiles.length).toBe(state.round.projectiles.length);
          expect(copy.newTrailSegments).toEqual(state.newTrailSegments);
        }
      }
      expect(roundsFinished).toBeGreaterThanOrEqual(3);
    });
  }

  it('is deterministic for a given seed and inputs', () => {
    const run = (): string => {
      const game = makeGame(3, 42);
      game.setLevelObstacles(loadLevelGrid('selva'));
      const rng = createRng(5);
      const held = new Map<SlotIndex, TronInput>();
      const log: unknown[] = [];
      for (let tick = 0; tick < 3000; tick++) {
        for (const p of game.players) {
          if (rng() < 0.05) held.set(p.slotIndex, { steer: Math.floor(rng() * 3) - 1, action: rng() < 0.5 });
        }
        game.tick(held);
        const s = game.serialize();
        if (tick % 100 === 0) log.push(s.round);
      }
      return JSON.stringify(log);
    };
    expect(run()).toBe(run());
  });
});
