import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PNG } from 'pngjs';
import { decodePng } from '../src/game/png';
import { PixelGrid } from '../src/game/PixelGrid';
import { PLAY_HEIGHT, PLAY_WIDTH } from '../src/game/constants';
import { LEVEL_DEFINITIONS } from '../src/types/game';

const DIR = 'public/assets/levels';

describe('PNG decoder', () => {
  it('reads every image in the levels folder exactly as the reference decoder does', async () => {
    const files = readdirSync(DIR).filter(f => f.endsWith('.png'));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const bytes = readFileSync(`${DIR}/${file}`);
      const reference = PNG.sync.read(bytes);
      const decoded = await decodePng(new Uint8Array(bytes));
      expect([decoded.width, decoded.height], file).toEqual([reference.width, reference.height]);
      let different = 0;
      for (let i = 0; i < reference.data.length; i += 4) {
        const transparent = reference.data[i + 3] === 0;
        for (let c = 0; c < 4; c++) {
          const expected = transparent ? 0 : reference.data[i + c];
          if (decoded.rgba[i + c] !== expected) different++;
        }
      }
      expect(different, file).toBe(0);
    }
  });

  it('gives every level the obstacles the simulation tests use', async () => {
    for (const level of LEVEL_DEFINITIONS) {
      const bytes = readFileSync(`${DIR}/${level.imageFile}`);
      const decoded = await decodePng(new Uint8Array(bytes));
      expect([decoded.width, decoded.height], level.id).toEqual([PLAY_WIDTH, PLAY_HEIGHT]);
      const grid = PixelGrid.fromRgba(decoded.rgba);
      const reference = PixelGrid.fromRgba(PNG.sync.read(bytes).data);
      expect(grid.toRuns(), level.id).toEqual(reference.toRuns());
    }
    // The blank level has no obstacles at all
    const blank = await decodePng(new Uint8Array(readFileSync(`${DIR}/blank.png`)));
    expect(PixelGrid.fromRgba(blank.rgba).count()).toBe(0);
  });

  it('rejects what is not a PNG', async () => {
    await expect(decodePng(new Uint8Array([1, 2, 3]))).rejects.toThrow();
  });
});
