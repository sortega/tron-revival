// Display settings: how trails are shaded, how big the halo of a head is, which extras
// are on (design/display-layer.md). Pure; reading the URL / localStorage and measuring the
// screen are left to the caller.

import type { FringeBand, ShadeStyle } from './shade';

/**
 * off   the collision pixels and nothing else
 * thin  half a logical pixel of dim colour on each side (2× layers): for big screens
 * bold  a full logical pixel on each side: the trail reads three pixels wide
 * wide  two logical pixels on each side, fading out
 * auto  bold where a logical pixel is small on screen (phones), thin elsewhere
 */
export const SHADE_VARIANTS = ['auto', 'off', 'thin', 'bold', 'wide'] as const;
export type ShadeVariant = typeof SHADE_VARIANTS[number];

/**
 * The head is always a solid white pixel; this is the white, transparent halo around it.
 * ring  one pixel around it
 * soft  two pixels, fading out
 * wide  three pixels, fading out
 * auto  soft where a logical pixel is small on screen, ring elsewhere
 */
export const HEAD_VARIANTS = ['auto', 'ring', 'soft', 'wide'] as const;
export type HeadVariant = typeof HEAD_VARIANTS[number];

/**
 * tracer  tracers leave a short fading streak
 * boost   the dark trail colours (blue, purple) are drawn lighter
 * shadow  walls cast a small shadow
 * fade    erased areas flash and fade
 */
export const FX = ['tracer', 'boost', 'shadow', 'fade'] as const;
export type Fx = typeof FX[number];

export interface DisplaySettings {
  shade: ShadeVariant;
  head: HeadVariant;
  fx: Fx[];
}

/** What the settings are applied to. */
export interface DisplayEnv {
  /** CSS pixels per logical pixel: how big the arena is on screen (0.65 on a phone). */
  cssPerLogical: number;
  /** The level's background is light: shade and halo must be dark to show on it. */
  lightBackground: boolean;
}

/** A logical pixel smaller than this many CSS pixels is "small": phones, small windows. */
export const SMALL_BELOW = 1;

/** What a player gets without asking for anything (design/display-layer.md, Recommendation). */
export const DEFAULT_DISPLAY: DisplaySettings = { shade: 'auto', head: 'auto', fx: ['tracer', 'boost'] };

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
 * Settings from a query string (`shade=bold&head=soft&fx=tracer,boost`), on top of stored
 * ones (the same format), on top of the defaults. Unknown values are ignored.
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

/** The variants `auto` stands for on this screen. */
export function resolveDisplay(
  settings: DisplaySettings, env: DisplayEnv,
): { shade: Exclude<ShadeVariant, 'auto'>; head: Exclude<HeadVariant, 'auto'> } {
  const small = env.cssPerLogical < SMALL_BELOW;
  return {
    shade: settings.shade === 'auto' ? (small ? 'bold' : 'thin') : settings.shade,
    head: settings.head === 'auto' ? (small ? 'soft' : 'ring') : settings.head,
  };
}

// Fringe bands per variant: on a dark background a dimmer version of the trail colour;
// on a light one a much darker version (or black, where the fringe is too thin to have a hue)
const BANDS: Record<'thin' | 'bold' | 'wide', { scale: number; dark: FringeBand[]; light: FringeBand[] }> = {
  thin: {
    scale: 2,
    dark: [{ width: 1, dim: 0.55, alpha: 230 }],
    light: [{ width: 1, dim: 0, alpha: 190 }],
  },
  bold: {
    scale: 1,
    dark: [{ width: 1, dim: 0.7, alpha: 240 }],
    light: [{ width: 1, dim: 0.4, alpha: 255 }],
  },
  wide: {
    scale: 1,
    dark: [{ width: 1, dim: 0.7, alpha: 240 }, { width: 1, dim: 0.7, alpha: 105 }],
    light: [{ width: 1, dim: 0.4, alpha: 255 }, { width: 1, dim: 0.4, alpha: 90 }],
  },
};

/** How the display bitmap is drawn for these settings on this screen and level. */
export function styleFor(settings: DisplaySettings, env: DisplayEnv): ShadeStyle {
  const { shade } = resolveDisplay(settings, env);
  const wallShadow = settings.fx.includes('shadow');
  if (shade === 'off') return { scale: 1, bands: [], boost: false, wallShadow };
  const variant = BANDS[shade];
  return {
    scale: variant.scale,
    bands: env.lightBackground ? variant.light : variant.dark,
    // Lighter blue is harder, not easier, to see on a light background
    boost: settings.fx.includes('boost') && !env.lightBackground,
    wallShadow,
  };
}

/** Halo of a head: squares of half-width 1, 2, ... pixels around it, each at this opacity. */
export function haloFor(head: Exclude<HeadVariant, 'auto'>): readonly number[] {
  switch (head) {
    case 'ring': return [0.5];
    case 'soft': return [0.42, 0.22];
    case 'wide': return [0.4, 0.24, 0.12];
  }
}
