// TronInput - Keyboard and touch input handler for Tron game

import nipplejs from 'nipplejs';
import type { TronInput as TronInputState } from '../types/game';

interface KeyMap {
  left: string;
  right: string;
  action: string;
}

// Default key mappings
const KEY_MAPS = {
  // Primary: Arrow keys + Space
  arrows: { left: 'ArrowLeft', right: 'ArrowRight', action: 'Space' },
  // Alternative: A/D + W
  wasd: { left: 'KeyA', right: 'KeyD', action: 'KeyW' },
};

// Detect if device has touch capability
export function isTouchDevice(): boolean {
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

export class TronInputHandler {
  private keys: TronInputState = { left: false, right: false, action: false };
  private keyMap: KeyMap;

  // Touch controls
  private joystick: nipplejs.JoystickManager | null = null;
  private actionButton: HTMLElement | null = null;

  constructor(keyMapName: 'arrows' | 'wasd' = 'arrows') {
    this.keyMap = KEY_MAPS[keyMapName];

    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
  }

  // Initialize touch controls - call this with container elements
  initTouchControls(joystickZone: HTMLElement, actionButtonEl: HTMLElement): void {
    this.actionButton = actionButtonEl;

    // Create joystick
    this.joystick = nipplejs.create({
      zone: joystickZone,
      mode: 'static',
      position: { left: '50%', top: '50%' },
      color: '#0ff',
      size: 90,
      restOpacity: 0.7,
      lockX: true, // Only horizontal movement for left/right
    });

    // Handle joystick direction
    this.joystick.on('move', (_evt, data) => {
      if (data.direction) {
        // Horizontal direction only (lockX is set)
        const angle = data.angle.degree;
        // Left: 135-225, Right: -45 to 45 (or 315-360, 0-45)
        if (angle > 90 && angle < 270) {
          this.keys.left = true;
          this.keys.right = false;
        } else {
          this.keys.left = false;
          this.keys.right = true;
        }
      }
    });

    this.joystick.on('end', () => {
      this.keys.left = false;
      this.keys.right = false;
    });

    // Handle action button
    actionButtonEl.addEventListener('touchstart', this.handleActionStart, { passive: false });
    actionButtonEl.addEventListener('touchend', this.handleActionEnd);
    actionButtonEl.addEventListener('touchcancel', this.handleActionEnd);
  }

  private handleActionStart = (e: TouchEvent): void => {
    e.preventDefault();
    this.keys.action = true;
    if (this.actionButton) {
      this.actionButton.style.transform = 'scale(0.9)';
      this.actionButton.style.opacity = '1';
    }
  };

  private handleActionEnd = (): void => {
    this.keys.action = false;
    if (this.actionButton) {
      this.actionButton.style.transform = 'scale(1)';
      this.actionButton.style.opacity = '0.7';
    }
  };

  private handleKeyDown = (e: KeyboardEvent): void => {
    let handled = false;

    if (e.code === this.keyMap.left) {
      this.keys.left = true;
      handled = true;
    }
    if (e.code === this.keyMap.right) {
      this.keys.right = true;
      handled = true;
    }
    if (e.code === this.keyMap.action) {
      this.keys.action = true;
      handled = true;
    }

    // Prevent default for game keys to avoid scrolling etc.
    if (handled) {
      e.preventDefault();
    }
  };

  private handleKeyUp = (e: KeyboardEvent): void => {
    if (e.code === this.keyMap.left) {
      this.keys.left = false;
    }
    if (e.code === this.keyMap.right) {
      this.keys.right = false;
    }
    if (e.code === this.keyMap.action) {
      this.keys.action = false;
    }
  };

  // Get current input state
  getInput(): TronInputState {
    return { ...this.keys };
  }

  // Clean up event listeners
  cleanup(): void {
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);

    // Cleanup touch controls
    if (this.joystick) {
      this.joystick.destroy();
      this.joystick = null;
    }

    if (this.actionButton) {
      this.actionButton.removeEventListener('touchstart', this.handleActionStart);
      this.actionButton.removeEventListener('touchend', this.handleActionEnd);
      this.actionButton.removeEventListener('touchcancel', this.handleActionEnd);
      this.actionButton = null;
    }
  }
}
