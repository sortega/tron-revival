// How trails are drawn (design/display-layer.md). There is one look, not a choice: the
// hard one-pixel trail, softened by semi-transparent pixels of its colour around it that
// are not obstacles. Being transparent they mix with whatever is behind them, so the same
// look works on every background.

import type { ShadeStyle } from './shade';

export const SOFT: ShadeStyle = {
  scale: 1,
  bands: [{ width: 1, dim: 1, alpha: 255 }],
  // Per trail pixel touching a free pixel side by side / at a corner, and the most it gets
  soft: { orthogonal: 0.12, diagonal: 0.03, max: 0.3 },
};
