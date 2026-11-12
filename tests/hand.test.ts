import { describe, expect, it } from 'vitest';
import { HAND_HOME, HAND_SPEED, createHand, stepHand, underHand } from '../src/game/hand';
import { LEVEL_DEFINITIONS } from '../src/types/game';
import { createRng } from '../src/game/rng';
import { serializeState, deserializeState } from '../src/network/serialization';
import { loadLevelGrid, makeGame, place, skipCountdown } from './helpers';

const DEF = LEVEL_DEFINITIONS.find(l => l.id === 'dentistry')!.hand!;

describe('dentist hand', () => {
  it('has the 30 targets of the original map', () => {
    expect(DEF.targets.length).toBe(30);
    expect(DEF.targets[0]).toEqual({ x: 59, y: 20 });
    expect(DEF.targets[29]).toEqual({ x: 227, y: 151 });
  });

  it('rests off-screen, then travels to teeth and drills them', () => {
    const rng = createRng(3);
    const hand = createHand();
    expect(hand).toMatchObject(HAND_HOME);
    let drilled = 0;
    let moved = 0;
    const visited = new Set<number>();
    let prev = { x: hand.x, y: hand.y };
    for (let t = 0; t < 20000; t++) {
      const drilling = stepHand(hand, DEF, rng);
      const step = Math.hypot(hand.x - prev.x, hand.y - prev.y);
      if (drilling) {
        drilled++;
        visited.add(hand.target);
        const target = DEF.targets[hand.target - 1]!;
        // Close to the tooth: aim jitter (±20 horizontally) plus drilling jitter
        expect(Math.abs(hand.x - target.x)).toBeLessThanOrEqual(20 + 8);
        expect(Math.abs(hand.y - target.y)).toBeLessThanOrEqual(8);
        expect(step).toBeLessThanOrEqual(Math.hypot(3, 3) + 0.001);
      } else {
        expect(step).toBeLessThanOrEqual(HAND_SPEED + 1);
        if (step > 0) moved++;
      }
      if (t < 100) expect(hand).toMatchObject(HAND_HOME); // Initial rest
      prev = { x: hand.x, y: hand.y };
    }
    expect(drilled).toBeGreaterThan(2000);
    expect(moved).toBeGreaterThan(1000);
    expect(visited.size).toBeGreaterThan(15);
  });

  it('knows what it covers', () => {
    const hand = { x: 300, y: 200 };
    expect(underHand(hand, 300, 200)).toBe(true);
    expect(underHand(hand, 299 + 199, 183 + 249)).toBe(true);
    expect(underHand(hand, 298, 200)).toBe(false);
    expect(underHand(hand, 300, 182)).toBe(false);
  });

  it('erases pixels under the drill, never kills, and only exists on its level', () => {
    const game = makeGame(2, 5, { level: 'dentistry' });
    const level = loadLevelGrid('dentistry');
    game.setLevelObstacles(level);
    skipCountdown(game);
    let erased = 0;
    let drillLoops = 0;
    let seen = false;
    const deaths: string[] = [];
    for (let t = 0; t < 6000; t++) {
      // Park both players in the open
      place(game, 0, 150, 300, 0);
      place(game, 1, 500, 100, 0);
      game.items.length = 0;
      game.tick(new Map());
      const frame = game.serialize();
      for (const d of frame.deaths ?? []) deaths.push(d.cause);
      for (const area of frame.clearedAreas ?? []) {
        expect(area.w).toBe(1);
        expect(game.pixels.has(area.x, area.y)).toBe(false);
        if (level.has(area.x, area.y)) erased++;
      }
      drillLoops += frame.soundEvents.filter(s => s.sound === 'drill' && s.loop).length;
      if (frame.round.hand) seen = true;
      if (t === 0) {
        const wire = deserializeState(serializeState(frame));
        expect(wire.round.hand).toEqual(frame.round.hand);
      }
    }
    expect(seen).toBe(true);
    expect(deaths).toEqual([]);
    expect(erased).toBeGreaterThan(20);
    expect(drillLoops).toBeGreaterThan(2);

    const blank = makeGame(2, 5);
    skipCountdown(blank);
    blank.tick(new Map());
    expect(blank.serialize().round.hand).toBeUndefined();
  });

  it('freezes when the round ends', () => {
    const game = makeGame(2, 5, { level: 'dentistry' });
    game.setLevelObstacles(loadLevelGrid('dentistry'));
    skipCountdown(game);
    for (let t = 0; t < 400; t++) {
      place(game, 0, 150, 300, 0);
      place(game, 1, 500, 100, 0);
      game.tick(new Map());
      game.serialize();
    }
    game.players[1]!.kill();
    game.tick(new Map());
    const before = game.serialize().round.hand;
    expect(before).toBeDefined();
    for (let t = 0; t < 200; t++) game.tick(new Map());
    expect(game.serialize().round.hand).toEqual(before);
  });
});
