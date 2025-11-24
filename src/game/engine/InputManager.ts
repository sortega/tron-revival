/**
 * Input Manager
 * Handles keyboard and mouse inputs
 */

export interface KeyBindings {
  left: string;
  right: string;
  fire: string;
}

export class InputManager {
  private keys = new Map<string, boolean>();
  private keyBindings: KeyBindings[];

  constructor() {
    // Default key bindings for 4 players
    this.keyBindings = [
      { left: 'KeyZ', right: 'KeyX', fire: 'ControlLeft' }, // Player 0 (Red)
      { left: 'ArrowLeft', right: 'ArrowRight', fire: 'AltRight' }, // Player 1 (Green)
      { left: 'KeyL', right: 'Semicolon', fire: 'KeyK' }, // Player 2
      { left: 'Delete', right: 'Enter', fire: 'NumpadAdd' }, // Player 3
    ];

    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    window.addEventListener('keydown', (e) => {
      this.keys.set(e.code, true);
      // Prevent default for game keys
      if (this.isGameKey(e.code)) {
        e.preventDefault();
      }
    });

    window.addEventListener('keyup', (e) => {
      this.keys.set(e.code, false);
    });

    // Clear all keys when window loses focus
    window.addEventListener('blur', () => {
      this.keys.clear();
    });
  }

  /**
   * Check if a key is currently pressed
   */
  isKeyDown(code: string): boolean {
    return this.keys.get(code) ?? false;
  }

  /**
   * Get key states for a player
   */
  getPlayerInput(playerNum: number): {
    left: boolean;
    right: boolean;
    fire: boolean;
  } {
    const bindings = this.keyBindings[playerNum];
    if (!bindings) {
      return { left: false, right: false, fire: false };
    }

    return {
      left: this.isKeyDown(bindings.left),
      right: this.isKeyDown(bindings.right),
      fire: this.isKeyDown(bindings.fire),
    };
  }

  /**
   * Check if a key is used by any player
   */
  private isGameKey(code: string): boolean {
    for (const binding of this.keyBindings) {
      if (
        code === binding.left ||
        code === binding.right ||
        code === binding.fire
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Clean up event listeners
   */
  destroy(): void {
    // Event listeners would be removed here
    // For now, they persist for the game session
  }
}
