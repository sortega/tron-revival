// Display settings: which shade variant, head marker and extras are on
// (design/display-layer.md). Pure; reading the URL / localStorage is left to the caller.

import type { ShadeStyle } from './shade';

export const SHADE_VARIANTS = ['off', 'glow', 'fringe', 'half', 'outline', 'auto', 'crisp'] as const;
export type ShadeVariant = typeof SHADE_VARIANTS[number];

export const HEAD_VARIANTS = ['glow', 'ring', 'box', 'dot'] as const;
export type HeadVariant = typeof HEAD_VARIANTS[number];

export const FX = ['shadow', 'tracer', 'fade', 'pattern'] as const;
export type Fx = typeof FX[number];

export interface DisplaySettings {
  shade: ShadeVariant;
  head: HeadVariant;
  fx: Fx[];
}

/** What a player gets without asking for anything (design/display-layer.md, Recommendation). */
export const DEFAULT_DISPLAY: DisplaySettings = { shade: 'auto', head: 'ring', fx: ['tracer'] };

/** The picture as it was before the display layer existed. */
export const CLASSIC_DISPLAY: DisplaySettings = { shade: 'off', head: 'glow', fx: [] };

export const DISPLAY_STORAGE_KEY = 'teratron-display';

function oneOf<T extends string>(list: readonly T[], value: string | null | undefined): T | null {
  return value != null && (list as readonly string[]).includes(value) ? value as T : null;
}

function parseFx(value: string | null | undefined): Fx[] | null {
  if (value == null) return null;
  if (value === 'all') return [...FX];
  return value.split(',').map(v => oneOf(FX, v.trim())).filter((v): v is Fx => v !== null);
}

/**
 * Settings from a query string (`shade=half&head=ring&fx=shadow,tracer`), on top of
 * stored ones (the same format), on top of the defaults.
 */
export function parseDisplaySettings(query: string, stored?: string | null): DisplaySettings {
  const settings: DisplaySettings = { ...DEFAULT_DISPLAY, fx: [...DEFAULT_DISPLAY.fx] };
  for (const source of [stored ?? '', query]) {
    const params = new URLSearchParams(source);
    settings.shade = oneOf(SHADE_VARIANTS, params.get('shade')) ?? settings.shade;
    settings.head = oneOf(HEAD_VARIANTS, params.get('head')) ?? settings.head;
    settings.fx = parseFx(params.get('fx')) ?? settings.fx;
  }
  return settings;
}

export function formatDisplaySettings(s: DisplaySettings): string {
  return `shade=${s.shade}&head=${s.head}&fx=${s.fx.join(',')}`;
}

export function nextOf<T>(list: readonly T[], current: T): T {
  return list[(list.indexOf(current) + 1) % list.length]!;
}

/**
 * How the display bitmap is drawn for these settings. `lightBackground`: the level's
 * background is light, which is where `auto` switches to a dark edge.
 */
export function styleFor(settings: DisplaySettings, lightBackground = false): ShadeStyle {
  const style: ShadeStyle = {
    scale: 1, fringe: 'none', fringeWidth: 1, fringeAlpha: 0, fringeDim: 1,
    diagonal: false,
    wallShadow: settings.fx.includes('shadow'),
    pattern: settings.fx.includes('pattern'),
  };
  switch (settings.shade) {
    case 'off':
    case 'glow':
      break;
    case 'fringe':
      Object.assign(style, { fringe: 'color', fringeAlpha: 102 });
      break;
    case 'half':
      Object.assign(style, { scale: 2, fringe: 'color', fringeAlpha: 140, diagonal: true });
      break;
    case 'outline':
      Object.assign(style, { scale: 2, fringe: 'dark', fringeAlpha: 190, diagonal: true });
      break;
    case 'auto':
      if (lightBackground) Object.assign(style, { scale: 2, fringe: 'dark', fringeAlpha: 190, diagonal: true });
      else Object.assign(style, { scale: 2, fringe: 'dim', fringeAlpha: 230, fringeDim: 0.55, diagonal: true });
      break;
    case 'crisp':
      style.scale = 2;
      break;
  }
  return style;
}
