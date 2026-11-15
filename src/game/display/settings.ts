// How trails are drawn (design/display-layer.md). There is one look, not a choice: the
// hard one-pixel trail and, over it, the smooth line of the path the player really
// followed (ArenaDisplay.addPath). The derivation adds nothing of its own around trails.

import type { ShadeStyle } from './shade';

export const SOFT: ShadeStyle = { scale: 1, bands: [] };
