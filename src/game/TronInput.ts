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

// Detect iOS (fullscreen API not supported)
export function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export class TronInputHandler {
  private steer: number = 0;   // -1 (full left) to 1 (full right)
  private action: boolean = false;
  private keyMap: KeyMap;
  private leftKeyDown: boolean = false;
  private rightKeyDown: boolean = false;

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

    // Handle joystick direction - proportional steering based on X position
    this.joystick.on('move', (_evt, data) => {
      // data.distance is 0-50 (half the joystick size), data.angle.degree is direction
      const distance = data.distance ?? 0;
      const angle = data.angle?.degree ?? 0;

      // Calculate normalized X component (-1 to 1)
      // angle 0 = right, 90 = up, 180 = left, 270 = down
      const radians = (angle * Math.PI) / 180;
      const xComponent = Math.cos(radians);  // -1 (left) to 1 (right)

      // Scale by distance (0-45 -> 0-1)
      const normalizedDistance = Math.min(distance / 45, 1);
      const linearSteer = xComponent * normalizedDistance;

      // Apply power curve for finer control near center (exponent > 1 = softer center)
      // steer = sign(x) * |x|^2.5
      this.steer = Math.sign(linearSteer) * Math.pow(Math.abs(linearSteer), 2.5);
    });

    this.joystick.on('end', () => {
      this.steer = 0;
    });

    // Handle action button
    actionButtonEl.addEventListener('touchstart', this.handleActionStart, { passive: false });
    actionButtonEl.addEventListener('touchend', this.handleActionEnd);
    actionButtonEl.addEventListener('touchcancel', this.handleActionEnd);
  }

  private handleActionStart = (e: TouchEvent): void => {
    e.preventDefault();
    this.action = true;
    if (this.actionButton) {
      this.actionButton.style.transform = 'scale(0.9)';
      this.actionButton.style.opacity = '1';
    }
  };

  private handleActionEnd = (): void => {
    this.action = false;
    if (this.actionButton) {
      this.actionButton.style.transform = 'scale(1)';
      this.actionButton.style.opacity = '0.7';
    }
  };

  private handleKeyDown = (e: KeyboardEvent): void => {
    let handled = false;

    if (e.code === this.keyMap.left) {
      this.leftKeyDown = true;
      handled = true;
    }
    if (e.code === this.keyMap.right) {
      this.rightKeyDown = true;
      handled = true;
    }
    if (e.code === this.keyMap.action) {
      this.action = true;
      handled = true;
    }

    // Update steer from keyboard state
    this.updateSteerFromKeys();

    // Prevent default for game keys to avoid scrolling etc.
    if (handled) {
      e.preventDefault();
    }
  };

  private handleKeyUp = (e: KeyboardEvent): void => {
    if (e.code === this.keyMap.left) {
      this.leftKeyDown = false;
    }
    if (e.code === this.keyMap.right) {
      this.rightKeyDown = false;
    }
    if (e.code === this.keyMap.action) {
      this.action = false;
    }

    // Update steer from keyboard state
    this.updateSteerFromKeys();
  };

  private updateSteerFromKeys(): void {
    // Keyboard gives full steering: -1, 0, or 1
    if (this.leftKeyDown && !this.rightKeyDown) {
      this.steer = -1;
    } else if (this.rightKeyDown && !this.leftKeyDown) {
      this.steer = 1;
    } else {
      this.steer = 0;
    }
  }

  // Get current input state
  getInput(): TronInputState {
    return {
      steer: this.steer,
      action: this.action,
    };
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
