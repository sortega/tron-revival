// Derive the team-mode sidebar from the free-for-all one: same textures, team colours.
//   node scripts/make-team-sidebar.mjs && npm run sprites
// Slots 0 and 2 are the purple team, slots 1 and 3 the brown team (src/types/lobby.ts).

import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const TEAM_COLORS = [[0xaa, 0x00, 0xaa], [0xaa, 0x66, 0x00]];
const SLOT_HEIGHT = 150;

const png = PNG.sync.read(readFileSync('sprites-source/sidebar.png'));
const { width, height, data } = png;
const brightness = (i) => Math.max(data[i], data[i + 1], data[i + 2]);

for (let slot = 0; slot < height / SLOT_HEIGHT; slot++) {
  const [r, g, b] = TEAM_COLORS[slot % 2];
  const peak = Math.max(r, g, b);
  for (let y = slot * SLOT_HEIGHT; y < (slot + 1) * SLOT_HEIGHT; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      // Keep the texture (each pixel's brightness), swap the hue
      const level = brightness(i) / peak;
      data[i] = Math.min(255, Math.round(r * level));
      data[i + 1] = Math.min(255, Math.round(g * level));
      data[i + 2] = Math.min(255, Math.round(b * level));
    }
  }
}

writeFileSync('sprites-source/sidebar_team.png', PNG.sync.write(png));
console.log(`sprites-source/sidebar_team.png (${width}x${height})`);
