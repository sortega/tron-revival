// How trails are drawn (design/display-layer.md). There is one look, not a choice: the
// hard one-pixel trail, softened by semi-transparent pixels around it that are not
// obstacles. Only the level's background changes it: on a light level the soft colour
// would not show, so the trail gets a dark edge instead.

import type { ShadeStyle } from './shade';

/** On a dark background: the trail's own colour around it, the more the more trail touches the pixel. */
const SOFT: ShadeStyle = {
  scale: 1,
  bands: [{ width: 1, dim: 1, alpha: 255 }],
  soft: { orthogonal: 0.22, diagonal: 0.07, max: 0.5 },
};

/** On a light background: an opaque edge in a much darker version of the trail colour. */
const DARK_EDGE: ShadeStyle = {
  scale: 1,
  bands: [{ width: 1, dim: 0.4, alpha: 255 }],
};

export function styleFor(lightBackground: boolean): ShadeStyle {
  return lightBackground ? DARK_EDGE : SOFT;
}
