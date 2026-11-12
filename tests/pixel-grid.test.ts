import { describe, expect, it } from 'vitest';
import { PixelGrid } from '../src/game/PixelGrid';
import { PLAY_WIDTH, PLAY_HEIGHT } from '../src/game/constants';

describe('PixelGrid', () => {
  it('stores and retrieves colours', () => {
    const g = new PixelGrid();
    expect(g.has(3, 4)).toBe(false);
    g.set(3, 4, '#ff0000');
    g.set(5, 6, '#00ff00');
    expect(g.get(3, 4)).toBe('#ff0000');
    expect(g.get(5, 6)).toBe('#00ff00');
    g.delete(3, 4);
    expect(g.get(3, 4)).toBeNull();
    expect(g.count()).toBe(1);
  });

  it('treats out-of-bounds as empty and ignores writes there', () => {
    const g = new PixelGrid();
    g.set(-1, 0, '#fff');
    g.set(PLAY_WIDTH, 0, '#fff');
    expect(g.count()).toBe(0);
    expect(g.has(-1, 0)).toBe(false);
    expect(g.has(0, PLAY_HEIGHT)).toBe(false);
  });

  it('clears rectangles that wrap around the edges', () => {
    const g = new PixelGrid();
    g.set(0, 0, '#fff');
    g.set(PLAY_WIDTH - 1, PLAY_HEIGHT - 1, '#fff');
    g.set(10, 10, '#fff');
    g.clearRect(PLAY_WIDTH - 2, PLAY_HEIGHT - 2, 4, 4);
    expect(g.has(0, 0)).toBe(false);
    expect(g.has(PLAY_WIDTH - 1, PLAY_HEIGHT - 1)).toBe(false);
    expect(g.has(10, 10)).toBe(true);
  });

  it('finds the first hit on a line and clears lines, with wrapping', () => {
    const g = new PixelGrid();
    g.set(2, 5, '#fff');
    g.set(8, 5, '#fff');
    expect(g.firstHitOnLine(0, 5, 20, 5)).toEqual({ x: 2, y: 5 });
    expect(g.firstHitOnLine(PLAY_WIDTH - 3, 5, PLAY_WIDTH + 10, 5)).toEqual({ x: 2, y: 5 });
    g.clearLine(0, 5, 5, 5);
    expect(g.firstHitOnLine(0, 5, 20, 5)).toEqual({ x: 8, y: 5 });
    expect(g.firstHitOnLine(0, 6, 20, 6)).toBeNull();
  });

  it('keeps coarse occupancy in sync', () => {
    const g = new PixelGrid();
    expect(g.coarseFree(0, 0)).toBe(true);
    g.set(3, 3, '#fff');
    g.set(4, 4, '#fff');
    g.set(3, 3, '#f00'); // Overwrite: still one pixel
    expect(g.coarseFree(0, 0)).toBe(false);
    expect(g.coarseFree(1, 0)).toBe(true);
    g.delete(3, 3);
    expect(g.coarseFree(0, 0)).toBe(false);
    g.clearRect(0, 0, 8, 8);
    expect(g.coarseFree(0, 0)).toBe(true);
    // Wraps
    g.set(PLAY_WIDTH - 1, PLAY_HEIGHT - 1, '#fff');
    expect(g.coarseFree(-1, -1)).toBe(false);
    const copy = new PixelGrid();
    copy.copyFrom(g);
    g.clear();
    expect(copy.coarseFree(-1, -1)).toBe(false);
    expect(g.coarseFree(-1, -1)).toBe(true);
  });

  it('copies independently', () => {
    const a = new PixelGrid();
    a.set(1, 1, '#abc');
    const b = new PixelGrid();
    b.copyFrom(a);
    a.delete(1, 1);
    expect(b.get(1, 1)).toBe('#abc');
  });
});
