// build-research-levels.ts - Generates the levels that have a display-only background
// (design/display-layer.md): for each one a wall image (black = free, as in every level)
// and a background image that is never read for collisions.
//
//   npm run levels:research

import * as fs from 'fs';
import { PNG } from 'pngjs';

const W = 750;
const H = 600;
const OUT = 'public/assets/levels';

type Rgb = [number, number, number];

class Canvas {
  readonly png = new PNG({ width: W, height: H });

  constructor(fill: (x: number, y: number) => Rgb) {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) this.set(x, y, fill(x, y));
  }

  set(x: number, y: number, [r, g, b]: Rgb): void {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    this.png.data[i] = r;
    this.png.data[i + 1] = g;
    this.png.data[i + 2] = b;
    this.png.data[i + 3] = 255;
  }

  rect(x: number, y: number, w: number, h: number, c: Rgb): void {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.set(xx, yy, c);
  }

  ring(cx: number, cy: number, radius: number, thickness: number, c: Rgb, gapAt?: number): void {
    for (let y = cy - radius - 1; y <= cy + radius + 1; y++) {
      for (let x = cx - radius - 1; x <= cx + radius + 1; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d > radius || d <= radius - thickness) continue;
        if (gapAt !== undefined) {
          // A 50° opening centred on `gapAt` (degrees, 0 = east, clockwise on screen)
          const angle = (Math.atan2(y - cy, x - cx) * 180 / Math.PI + 360) % 360;
          const off = Math.abs(((angle - gapAt + 540) % 360) - 180);
          if (off < 25) continue;
        }
        this.set(x, y, c);
      }
    }
  }

  save(name: string): void {
    fs.writeFileSync(`${OUT}/${name}`, PNG.sync.write(this.png));
    console.log(`  ${OUT}/${name}`);
  }
}

const BLACK: Rgb = [0, 0, 0];

// Small deterministic noise, so the backgrounds are not flat (and the build is reproducible)
function noise(x: number, y: number): number {
  let n = (x * 374761393 + y * 668265263) | 0;
  n = (n ^ (n >>> 13)) * 1274126177 | 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function blueprint(): void {
  // Background: navy drafting paper, slightly lighter towards the centre, with a grid
  const bg = new Canvas((x, y) => {
    const dx = (x - W / 2) / (W / 2);
    const dy = (y - H / 2) / (H / 2);
    const lift = 1 - 0.35 * Math.min(1, dx * dx + dy * dy);
    let r = 10 * lift, g = 26 * lift, b = 52 * lift;
    if (x % 50 === 0 || y % 50 === 0) { r += 10; g += 18; b += 30; }
    else if (x % 10 === 0 || y % 10 === 0) { r += 3; g += 6; b += 10; }
    const n = (noise(x >> 2, y >> 2) - 0.5) * 4;   // 4×4 grain: compresses far better than per-pixel
    return [Math.round(r + n), Math.round(g + n), Math.round(b + n)];
  });
  bg.save('blueprint-bg.png');

  // Walls: a floor plan drawn in pale blue, 2 px thick, with door gaps
  const ink: Rgb = [150, 190, 230];
  const walls = new Canvas(() => BLACK);
  // Central room with open corners and a door in the middle of each side
  walls.rect(285, 250, 2, 35, ink); walls.rect(285, 315, 2, 35, ink);
  walls.rect(463, 250, 2, 35, ink); walls.rect(463, 315, 2, 35, ink);
  walls.rect(325, 210, 35, 2, ink); walls.rect(390, 210, 35, 2, ink);
  walls.rect(325, 388, 35, 2, ink); walls.rect(390, 388, 35, 2, ink);
  // Outer partitions
  walls.rect(300, 100, 150, 2, ink);
  walls.rect(300, 498, 150, 2, ink);
  walls.rect(130, 240, 2, 120, ink);
  walls.rect(618, 240, 2, 120, ink);
  // Columns
  for (const [cx, cy] of [[220, 150], [530, 150], [220, 450], [530, 450]] as const) {
    walls.rect(cx - 4, cy - 4, 8, 8, ink);
  }
  walls.save('blueprint.png');
}

function paper(): void {
  // Background: cream squared paper. The deliberately hard case for bright trails.
  const bg = new Canvas((x, y) => {
    let r = 217, g = 211, b = 189;
    if (x % 25 === 0 || y % 25 === 0) { r = 186; g = 198; b = 205; }
    const n = (noise(x >> 2, y >> 2) - 0.5) * 6;
    return [Math.round(r + n), Math.round(g + n), Math.round(b + n)];
  });
  bg.save('paper-bg.png');

  // Walls: ink doodles — rings with an opening, and two rules
  const ink: Rgb = [30, 42, 110];
  const walls = new Canvas(() => BLACK);
  walls.ring(200, 300, 45, 2, ink, 180);
  walls.ring(550, 300, 45, 2, ink, 0);
  walls.ring(375, 140, 40, 2, ink, 270);
  walls.ring(375, 460, 40, 2, ink, 90);
  walls.rect(330, 299, 90, 2, ink);
  walls.save('paper.png');
}

console.log('Building research levels...');
blueprint();
paper();
