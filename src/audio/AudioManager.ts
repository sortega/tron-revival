/**
 * Audio Manager
 * Handles game sound effects
 */

export class AudioManager {
  private sounds: Map<string, HTMLAudioElement> = new Map();

  constructor() {
    this.loadSound('inicio', '/sounds/inicio.mp3');
  }

  /**
   * Load a sound file
   */
  private loadSound(name: string, path: string): void {
    const audio = new Audio(path);
    audio.preload = 'auto';
    this.sounds.set(name, audio);
  }

  /**
   * Play a sound
   */
  play(name: string): void {
    const sound = this.sounds.get(name);
    if (!sound) {
      console.warn(`Sound "${name}" not found`);
      return;
    }

    // Reset to beginning and play
    sound.currentTime = 0;
    sound.play().catch((error) => {
      console.warn(`Error playing sound "${name}":`, error);
    });
  }

  /**
   * Stop a sound
   */
  stop(name: string): void {
    const sound = this.sounds.get(name);
    if (sound) {
      sound.pause();
      sound.currentTime = 0;
    }
  }
}
