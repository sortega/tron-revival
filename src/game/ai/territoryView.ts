// Pictures of the territory map, one RGBA pixel per coarse cell, for the debug overlay
// (`?botdebug=...`) and the snapshot script. See design/bots-territory.md.

import { T_CELLS, T_COLS, T_ROWS, UNREACHED } from './territory';
import type { TerritoryMap } from './territory';

export type TerritoryLayer = 'territory' | 'risk' | 'clearance';
export const TERRITORY_LAYERS: readonly TerritoryLayer[] = ['territory', 'risk', 'clearance'];

export const VIEW_COLS = T_COLS;
export const VIEW_ROWS = T_ROWS;

function rgb(color: string): [number, number, number] {
  const v = parseInt(color.replace('#', ''), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/**
 * Paint a layer of the map into `out` (VIEW_COLS × VIEW_ROWS RGBA, row by row).
 *   territory  each cell in the colour of the player that gets there first; white where
 *              it is a tie, grey where nobody can get; stronger the nearer the owner is
 *   risk       red where it is easy to crash (tight spots, closing doors, level guns)
 *   clearance  blue, brighter the further from any obstacle
 * `colors` are the players' colours by slot.
 */
export function paintTerritory(
  map: TerritoryMap, layer: TerritoryLayer, colors: readonly (string | undefined)[], out: Uint8ClampedArray
): void {
  const slots = colors.map(c => c ? rgb(c) : null);
  for (let cell = 0; cell < T_CELLS; cell++) {
    const o = cell * 4;
    let r = 0, g = 0, b = 0, a = 0;
    if (map.blocked[cell] !== 0) {
      // Obstacles stay as they are
    } else if (layer === 'risk') {
      const risk = map.risk[cell]!;
      if (risk > 0) {
        r = 255; g = 40; b = 40;
        a = Math.min(200, 30 + risk * 20);
      }
    } else if (layer === 'clearance') {
      const c = map.clearance[cell]!;
      r = 60; g = 140; b = 255;
      a = Math.min(190, c * 16);
    } else {
      let best = UNREACHED;
      let owner = -1;
      for (let s = 0; s < slots.length; s++) {
        if (map.present[s] === 0) continue;
        const t = map.time[s]![cell]!;
        if (t < best) { best = t; owner = s; } else if (t === best && t !== UNREACHED) owner = -2;
      }
      if (owner === -1) {
        r = g = b = 128; a = 110;
      } else if (owner === -2) {
        r = g = b = 255; a = 120;
      } else {
        [r, g, b] = slots[owner] ?? [255, 255, 255];
        a = Math.max(50, 150 - best);
      }
    }
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = a;
  }
}
