// TronInput - Keyboard input handler for Tron game

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

export class TronInputHandler {
  private keys: TronInputState = { left: false, right: false, action: false };
  private keyMap: KeyMap;

  constructor(keyMapName: 'arrows' | 'wasd' = 'arrows') {
    this.keyMap = KEY_MAPS[keyMapName];

    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
  }

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
  }
}
