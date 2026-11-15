// InputManager - keyboard and touch input for all human players on this machine

import type { SlotIndex } from '../../types/lobby';
import type { ControlScheme, TronInput } from '../../types/game';

import { CONTROL_SCHEMES } from './controlSchemes';
import { TouchControls } from './TouchControls';

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
  private touch: TouchControls | null = null;
  private touchHeading: (() => number | null) | null = null;

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
      if (slot === this.touchSlot && this.touch) {
        const touchSteer = this.touch.getSteer(this.touchHeading?.() ?? null);
        if (steer === 0) steer = touchSteer;
        action = action || this.touch.getAction();
      }
      inputs.set(slot, { steer, action });
    }
    return inputs;
  }

  /**
   * Attach on-screen steering and an action button to one player. `heading` returns the
   * player's current direction (null when there is nothing to steer).
   */
  initTouchControls(
    slot: SlotIndex,
    steerZone: HTMLElement,
    actionButton: HTMLElement,
    modeButton: HTMLElement | null,
    heading: () => number | null,
  ): void {
    this.touchSlot = slot;
    this.touchHeading = heading;
    this.touch = new TouchControls(steerZone, actionButton, modeButton);
  }

  /** What the on-screen action button does right now (see TouchControls.showAction). */
  showTouchAction(label: string, enabled: boolean): void {
    this.touch?.showAction(label, enabled);
  }

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

    this.touch?.cleanup();
    this.touch = null;
  }
}
