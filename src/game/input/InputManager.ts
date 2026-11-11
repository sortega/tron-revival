// InputManager - keyboard and touch input for all human players on this machine

import nipplejs from 'nipplejs';
import type { SlotIndex } from '../../types/lobby';
import type { ControlScheme, TronInput } from '../../types/game';

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

// True when the primary input is touch (phones, tablets). Touch-screen laptops
// report a fine primary pointer and get the desktop layout.
export function isTouchDevice(): boolean {
  if (typeof window.matchMedia === 'function') {
    return window.matchMedia('(pointer: coarse)').matches;
  }
  return 'ontouchstart' in window;
}

// Detect iOS (fullscreen API not supported)
export function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export interface InputBinding {
  slot: SlotIndex;
  scheme: ControlScheme;
}

export class InputManager {
  private readonly bindings: InputBinding[];
  private readonly gameKeys = new Set<string>();
  private readonly pressed = new Set<string>();

  // Touch controls (drive one slot)
  private touchSlot: SlotIndex | null = null;
  private touchSteer = 0;
  private touchAction = false;
  private joystick: nipplejs.JoystickManager | null = null;
  private actionButton: HTMLElement | null = null;

  constructor(bindings: InputBinding[]) {
    this.bindings = bindings;
    for (const { scheme } of bindings) {
      const keys = CONTROL_SCHEMES[scheme];
      for (const code of [...keys.left, ...keys.right, ...keys.action]) this.gameKeys.add(code);
    }
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleBlur);
  }

  /** Current input of every local human player. */
  getInputs(): Map<SlotIndex, TronInput> {
    const inputs = new Map<SlotIndex, TronInput>();
    for (const { slot, scheme } of this.bindings) {
      const keys = CONTROL_SCHEMES[scheme];
      const left = keys.left.some(k => this.pressed.has(k));
      const right = keys.right.some(k => this.pressed.has(k));
      let steer = left === right ? 0 : left ? -1 : 1;
      let action = keys.action.some(k => this.pressed.has(k));
      if (slot === this.touchSlot) {
        if (steer === 0) steer = this.touchSteer;
        action = action || this.touchAction;
      }
      inputs.set(slot, { steer, action });
    }
    return inputs;
  }

  /** Attach an on-screen joystick and action button to one player. */
  initTouchControls(slot: SlotIndex, joystickZone: HTMLElement, actionButtonEl: HTMLElement): void {
    this.touchSlot = slot;
    this.actionButton = actionButtonEl;

    this.joystick = nipplejs.create({
      zone: joystickZone,
      mode: 'static',
      position: { left: '50%', top: '50%' },
      color: '#0ff',
      size: 90,
      restOpacity: 0.7,
      lockX: true, // Only horizontal movement for left/right
    });

    // Proportional steering based on the joystick's X position
    this.joystick.on('move', (_evt, data) => {
      const distance = data.distance ?? 0;
      const angle = data.angle?.degree ?? 0;
      const xComponent = Math.cos((angle * Math.PI) / 180);  // -1 (left) to 1 (right)
      const linearSteer = xComponent * Math.min(distance / 45, 1);
      // Power curve for finer control near the centre
      this.touchSteer = Math.sign(linearSteer) * Math.pow(Math.abs(linearSteer), 2.5);
    });
    this.joystick.on('end', () => {
      this.touchSteer = 0;
    });

    actionButtonEl.addEventListener('touchstart', this.handleActionStart, { passive: false });
    actionButtonEl.addEventListener('touchend', this.handleActionEnd);
    actionButtonEl.addEventListener('touchcancel', this.handleActionEnd);
  }

  private handleActionStart = (e: TouchEvent): void => {
    e.preventDefault();
    this.touchAction = true;
    if (this.actionButton) {
      this.actionButton.style.transform = 'scale(0.9)';
      this.actionButton.style.opacity = '1';
    }
  };

  private handleActionEnd = (): void => {
    this.touchAction = false;
    if (this.actionButton) {
      this.actionButton.style.transform = 'scale(1)';
      this.actionButton.style.opacity = '0.7';
    }
  };

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (!this.gameKeys.has(e.code)) return;
    // Don't steal keys while typing in a form field
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;
    this.pressed.add(e.code);
    e.preventDefault(); // Avoid scrolling etc.
  };

  private handleKeyUp = (e: KeyboardEvent): void => {
    this.pressed.delete(e.code);
  };

  // Keys released while the window is unfocused never produce keyup
  private handleBlur = (): void => {
    this.pressed.clear();
  };

  cleanup(): void {
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleBlur);

    this.joystick?.destroy();
    this.joystick = null;

    if (this.actionButton) {
      this.actionButton.removeEventListener('touchstart', this.handleActionStart);
      this.actionButton.removeEventListener('touchend', this.handleActionEnd);
      this.actionButton.removeEventListener('touchcancel', this.handleActionEnd);
      this.actionButton = null;
    }
  }
}
