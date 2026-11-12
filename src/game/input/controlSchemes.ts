// Keyboard control schemes (no DOM dependencies)

import type { ControlScheme } from '../../types/game';

export interface SchemeKeys {
  label: string;      // Short human-readable description
  left: string[];     // KeyboardEvent.code values
  right: string[];
  action: string[];
}

export const CONTROL_SCHEMES: Record<ControlScheme, SchemeKeys> = {
  solo: {
    label: '←/→ or A/D to turn · Space, ↑ or W for action',
    left: ['ArrowLeft', 'KeyA'],
    right: ['ArrowRight', 'KeyD'],
    action: ['Space', 'ArrowUp', 'KeyW'],
  },
  arrows: { label: '← → · ↑', left: ['ArrowLeft'], right: ['ArrowRight'], action: ['ArrowUp'] },
  wasd: { label: 'A D · W', left: ['KeyA'], right: ['KeyD'], action: ['KeyW'] },
  ijkl: { label: 'J L · I', left: ['KeyJ'], right: ['KeyL'], action: ['KeyI'] },
  numpad: { label: 'Num4 Num6 · Num8', left: ['Numpad4'], right: ['Numpad6'], action: ['Numpad8'] },
};

/** Schemes that can be combined on one keyboard (everything except `solo`). */
export const SHARED_SCHEMES: ControlScheme[] = ['arrows', 'wasd', 'ijkl', 'numpad'];
