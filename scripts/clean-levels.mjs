// Clean the level images of pixels that are solid but cannot be seen.
//
//   npm run levels:clean
//
// A level PNG is both the picture and the obstacles: every pixel that is not pure black
// is solid (design/architecture.md, "Levels"). The original maps carry fringes of
// nearly-black pixels around their walls (anti-aliasing, shadows), which kill without
// being visible. This turns into pure black every pixel darker than DARK that touches
// free space, directly or through other such pixels. Dark pixels shut inside a wall stay:
// a wall must not get pin-holes. Running it again changes nothing.

import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

/** A pixel whose brightest channel is below this cannot be told from black. */
export const DARK = 32;
const LEVELS = ['bricks', 'bus', 'dentistry', 'pop-culture', 'portals', 'selva', 'warzone', 'blueprint'];
const DIR = new URL('../public/assets/levels/', import.meta.url);

/** How many pixels of an RGBA image would be cleaned; with `apply`, cleans them. */
export function cleanDarkPixels(data, width, height, apply = true) {
  const brightness = (p) => (data[p * 4 + 3] === 0 ? 0 : Math.max(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]));
  const seen = new Uint8Array(width * height);
  const stack = [];
  for (let p = 0; p < width * height; p++) {
    if (brightness(p) === 0) {
      seen[p] = 1;
      stack.push(p);
    }
  }
  let cleaned = 0;
  // From the free pixels, through dark ones (the arena wraps around its edges)
  while (stack.length > 0) {
    const p = stack.pop();
    const x = p % width;
    const y = (p - x) / width;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const q = ((y + dy + height) % height) * width + ((x + dx + width) % width);
      if (seen[q]) continue;
      const b = brightness(q);
      if (b >= DARK) continue;
      seen[q] = 1;
      stack.push(q);
      cleaned++;
      if (apply) {
        data[q * 4] = data[q * 4 + 1] = data[q * 4 + 2] = 0;
        data[q * 4 + 3] = 255;
      }
    }
  }
  return cleaned;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const level of LEVELS) {
    const file = new URL(`${level}.png`, DIR);
    const png = PNG.sync.read(readFileSync(file));
    const cleaned = cleanDarkPixels(png.data, png.width, png.height);
    // (no pixel of a level is transparent: written as plain RGB, which is a third smaller)
    if (cleaned > 0) writeFileSync(file, PNG.sync.write(png, { colorType: 2, inputHasAlpha: true, deflateLevel: 9 }));
    console.log(`${level.padEnd(12)} ${cleaned} pixels cleaned`);
  }
}
