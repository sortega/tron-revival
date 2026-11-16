// Draws the robot heads that mark bots in the side panel (design/local-and-ai.md):
// sprites-source/bot_{easy,normal,hard}.png, 24x24. Run `npm run sprites` afterwards.
//
//   node scripts/make-bot-icons.mjs

import { writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const SIZE = 24;
const BLACK = [0, 0, 0];
const WHITE = [255, 255, 255];

// Per difficulty: the light of the eyes and the antenna, and the face
const LOOKS = {
  easy: { light: [60, 220, 60], glow: [190, 255, 190] },
  normal: { light: [255, 200, 0], glow: [255, 245, 170] },
  hard: { light: [255, 30, 30], glow: [255, 170, 150] },
};

function draw(kind) {
  const { light, glow } = LOOKS[kind];
  const png = new PNG({ width: SIZE, height: SIZE });
  const set = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
    const i = (y * SIZE + x) * 4;
    png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255;
  };
  const rect = (x0, y0, x1, y1, c) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, c);
  };
  // Brushed metal like the H-bomb icon: lighter at the top left, a little grain
  const metal = (x, y) => {
    const grain = ((x * 7 + y * 13) % 5) * 5;
    const v = Math.round(215 - (y - 5) * 6 - Math.max(0, x - 12) * 3 - grain);
    return [v, v, Math.min(255, v + 6)];
  };

  // Antenna
  rect(11, 2, 12, 5, [90, 90, 96]);
  rect(10, 0, 13, 2, BLACK);
  rect(11, 0, 12, 1, light);
  if (kind === 'hard') {
    // Horns instead of a friendly bulb on its own
    for (let k = 0; k < 4; k++) { set(3 + k, 2 + k, BLACK); set(4 + k, 2 + k, [120, 120, 126]); }
    for (let k = 0; k < 4; k++) { set(20 - k, 2 + k, BLACK); set(19 - k, 2 + k, [120, 120, 126]); }
  }

  // Ears
  rect(0, 10, 2, 15, BLACK);
  rect(1, 11, 2, 14, [110, 110, 118]);
  rect(21, 10, 23, 15, BLACK);
  rect(21, 11, 22, 14, [80, 80, 88]);

  // Head: outline with cut corners, then the metal
  rect(3, 5, 20, 22, BLACK);
  rect(2, 6, 21, 21, BLACK);
  for (let y = 6; y <= 21; y++) for (let x = 3; x <= 20; x++) set(x, y, metal(x, y));
  for (const [x, y] of [[3, 6], [20, 6], [3, 21], [20, 21]]) set(x, y, BLACK);
  rect(4, 6, 19, 6, [240, 240, 248]);   // Shine along the top

  // Eyes
  if (kind === 'easy') {
    for (const x0 of [6, 14]) {
      rect(x0, 9, x0 + 3, 14, BLACK);
      rect(x0 - 1, 10, x0 + 4, 13, BLACK);
      rect(x0, 10, x0 + 3, 13, light);
      rect(x0 + 1, 10, x0 + 1, 11, glow);
    }
  } else if (kind === 'normal') {
    for (const x0 of [5, 14]) {
      rect(x0, 10, x0 + 4, 13, BLACK);
      rect(x0 + 1, 11, x0 + 3, 12, light);
      set(x0 + 1, 11, glow);
    }
  } else {
    // Slanted: high at the outside, low towards the nose
    for (const side of [0, 1]) {
      for (let k = 0; k < 6; k++) {
        const x = side === 0 ? 5 + k : 18 - k;
        const top = 9 + Math.floor(k / 2);
        rect(x, top - 1, x, 14, BLACK);
        if (k > 0 && k < 5) rect(x, top + 1, x, 13, light);
      }
      set(side === 0 ? 7 : 16, 12, glow);
    }
  }

  // Mouth
  if (kind === 'easy') {
    rect(7, 18, 16, 18, BLACK);
    set(6, 17, BLACK); set(17, 17, BLACK);
  } else if (kind === 'normal') {
    rect(6, 16, 17, 19, BLACK);
    rect(7, 17, 16, 18, [60, 60, 66]);
    for (let x = 8; x <= 16; x += 2) rect(x, 17, x, 18, [200, 200, 208]);
  } else {
    rect(5, 16, 18, 20, BLACK);
    rect(6, 17, 17, 19, WHITE);
    for (let x = 6; x <= 17; x++) {
      const phase = (x - 6) % 4;            // Teeth: a zigzag between the jaws
      set(x, phase < 2 ? 17 + phase : 21 - phase, BLACK);
    }
  }
  return PNG.sync.write(png);
}

for (const kind of Object.keys(LOOKS)) {
  writeFileSync(`sprites-source/bot_${kind}.png`, draw(kind));
  console.log(`sprites-source/bot_${kind}.png`);
}
