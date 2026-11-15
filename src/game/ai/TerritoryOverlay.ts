// Debug overlay: the territory map drawn over the arena in the real game.
// `?botdebug=1` (or =territory), `=risk`, `=clearance`; the B key cycles the layers.
// Only where the simulation runs (local games and the host). See design/bots-territory.md.

import { COARSE_CELL } from '../PixelGrid';
import { TerritoryMap, worldOf } from './territory';
import type { TerritoryGame } from './territory';
import { paintTerritory, TERRITORY_LAYERS, VIEW_COLS, VIEW_ROWS } from './territoryView';
import type { TerritoryLayer } from './territoryView';

const REFRESH_FRAMES = 4;

type OverlayGame = Omit<TerritoryGame, 'players'> & {
  players: readonly (TerritoryGame['players'][number] & { color: string })[];
};

export class TerritoryOverlay {
  // Its own map: looking must not disturb the one the bots share
  private readonly map = new TerritoryMap();
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly image: ImageData;
  private layer: TerritoryLayer;
  private frame = 0;
  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key === 'b' || e.key === 'B') {
      this.layer = TERRITORY_LAYERS[(TERRITORY_LAYERS.indexOf(this.layer) + 1) % TERRITORY_LAYERS.length]!;
      this.frame = 0;
    }
  };

  /** The overlay asked for by the page's URL, if any. */
  static fromUrl(search: string): TerritoryOverlay | null {
    const value = new URLSearchParams(search).get('botdebug');
    if (value === null || value === '0') return null;
    return new TerritoryOverlay((TERRITORY_LAYERS as readonly string[]).includes(value) ? value as TerritoryLayer : 'territory');
  }

  constructor(layer: TerritoryLayer) {
    this.layer = layer;
    this.canvas = document.createElement('canvas');
    this.canvas.width = VIEW_COLS;
    this.canvas.height = VIEW_ROWS;
    this.ctx = this.canvas.getContext('2d')!;
    this.image = this.ctx.createImageData(VIEW_COLS, VIEW_ROWS);
    window.addEventListener('keydown', this.onKey);
  }

  /** Draw over the play area of `target` (whose origin is the arena's). */
  draw(target: CanvasRenderingContext2D, game: OverlayGame): void {
    if (this.frame++ % REFRESH_FRAMES === 0) {
      this.map.rebuild(worldOf(game));
      paintTerritory(this.map, this.layer, game.players.map(p => p.color), this.image.data);
      this.ctx.putImageData(this.image, 0, 0);
    }
    const smoothing = target.imageSmoothingEnabled;
    target.imageSmoothingEnabled = false;
    target.drawImage(this.canvas, 0, 0, VIEW_COLS * COARSE_CELL, VIEW_ROWS * COARSE_CELL);
    target.imageSmoothingEnabled = smoothing;

    // Cells each player reaches first / can reach at all
    target.save();
    target.font = '10px monospace';
    target.textBaseline = 'top';
    target.textAlign = 'left';
    target.fillStyle = 'rgba(0, 0, 0, 0.6)';
    target.fillRect(2, 2, 190, 13 + game.players.length * 11);
    let y = 4;
    target.fillStyle = '#fff';
    target.fillText(`bot map: ${this.layer} (B: next layer)`, 4, y);
    for (const p of game.players) {
      y += 11;
      if (!p.alive) continue;
      target.fillStyle = p.color;
      const s = p.slotIndex;
      target.fillText(
        `own ${this.map.area[s]}  reach ${this.map.reach[s]}${this.map.shared[s] === 0 ? '  (alone)' : ''}`, 4, y);
    }
    target.restore();
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKey);
  }
}
