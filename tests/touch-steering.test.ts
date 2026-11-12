import { describe, expect, it } from 'vitest';
import { TURN_SPEED } from '../src/game/TronPlayer';
import { angleDiff, classicSteer, steerTowards } from '../src/game/input/touchSteering';

/** Turn like the simulation does: `steps` pixel-steps per tick, each turning steer × TURN_SPEED. */
function turn(heading: number, target: number, ticks: number, steps: number): number[] {
  const path: number[] = [];
  for (let i = 0; i < ticks; i++) {
    const steer = steerTowards(heading, target);
    for (let s = 0; s < steps; s++) heading = (heading + steer * TURN_SPEED + 360) % 360;
    path.push(heading);
  }
  return path;
}

describe('touch steering', () => {
  it('measures the shortest signed angle', () => {
    expect(angleDiff(0, 90)).toBe(90);
    expect(angleDiff(90, 0)).toBe(-90);
    expect(angleDiff(350, 10)).toBe(20);
    expect(angleDiff(10, 350)).toBe(-20);
    expect(angleDiff(0, 180)).toBe(180);
    expect(angleDiff(720 + 45, -315)).toBe(0);
  });

  it('turns at full lock when far from the target, the short way round', () => {
    expect(steerTowards(0, 90)).toBe(1);
    expect(steerTowards(0, 270)).toBe(-1);
    expect(steerTowards(350, 20)).toBe(1);
    expect(steerTowards(90, 90)).toBe(0);
  });

  it('reaches the target as fast as a key and settles without overshoot', () => {
    for (const steps of [1, 2, 3, 4, 5]) {
      for (const [from, to] of [[0, 90], [10, 300], [200, 20], [359, 1]] as const) {
        const total = Math.abs(angleDiff(from, to));
        const path = turn(from, to, 80, steps);
        const side = Math.sign(angleDiff(from, to));
        let worstOvershoot = 0;
        for (const h of path) worstOvershoot = Math.max(worstOvershoot, -side * angleDiff(h, to));
        // No overshoot up to 3 steps per tick; a damped one beyond that
        const allowed = steps <= 3 ? 0.01 : TURN_SPEED * steps * 0.5;
        expect(worstOvershoot, `${from}→${to} at ${steps} steps`).toBeLessThan(allowed);
        expect(Math.abs(angleDiff(path[path.length - 1]!, to))).toBeLessThan(0.01);
        // Within 2° of the target no more than a few ticks later than full lock would take
        const arrival = path.findIndex(h => Math.abs(angleDiff(h, to)) < 2);
        expect(arrival).toBeLessThanOrEqual(Math.ceil(total / (TURN_SPEED * steps)) + 6);
      }
    }
  });

  it('keeps the classic curve', () => {
    expect(classicSteer(0)).toBe(0);
    expect(classicSteer(45)).toBe(1);
    expect(classicSteer(-90)).toBe(-1);
    expect(classicSteer(22.5)).toBeCloseTo(0.5 ** 2.5, 6);
    expect(classicSteer(-22.5)).toBeCloseTo(-(0.5 ** 2.5), 6);
  });
});
