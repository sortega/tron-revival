// SoundManager - Handles game audio

// Sounds used for item pickup
export const PICKUP_SOUNDS = ['item_pickup', 'shield', 'turbo', 'slow', 'reset'] as const;
export type PickupSound = typeof PICKUP_SOUNDS[number];

// Sounds used when weapons are fired
export const USE_SOUNDS = ['glock', 'rifle', 'shotgun', 'uzi', 'bomb', 'alarm'] as const;
export type UseSound = typeof USE_SOUNDS[number];

// All sound names
const SOUND_NAMES = [
  'round_start', 'laughs', 'teleport',
  ...PICKUP_SOUNDS,
  ...USE_SOUNDS,
] as const;
export type SoundName = typeof SOUND_NAMES[number];

const SOUND_FILES: Record<SoundName, string> = {
  round_start: 'round_start.mp3',
  laughs: 'laughs.mp3',
  teleport: 'teleport.mp3',
  item_pickup: 'item_pickup.mp3',
  shield: 'shield.mp3',
  turbo: 'turbo.mp3',
  slow: 'slow.mp3',
  reset: 'reset.mp3',
  glock: 'glock.mp3',
  rifle: 'rifle.mp3',
  shotgun: 'shotgun.mp3',
  uzi: 'uzi.mp3',
  bomb: 'bomb.mp3',
  alarm: 'alarm.mp3',
};

export class SoundManager {
  private sounds: Map<SoundName, HTMLAudioElement> = new Map();
  private loaded = false;
  private loopingSounds: Map<string, HTMLAudioElement> = new Map();

  constructor() {
    this.preloadSounds();
  }

  private preloadSounds(): void {
    const basePath = `${import.meta.env.BASE_URL}assets/sounds/`;

    for (const [name, file] of Object.entries(SOUND_FILES)) {
      const audio = new Audio(basePath + file);
      audio.preload = 'auto';
      this.sounds.set(name as SoundName, audio);
    }

    this.loaded = true;
  }

  play(name: SoundName): void {
    if (!this.loaded) return;

    const audio = this.sounds.get(name);
    if (audio) {
      // Clone the audio to allow overlapping sounds
      const clone = audio.cloneNode() as HTMLAudioElement;
      clone.volume = 0.5;
      clone.play().catch(() => {
        // Ignore autoplay errors (browser may block until user interaction)
      });
    }
  }

  // Start a looping sound with a unique key (e.g., player slot)
  playLoop(name: SoundName, key: string): void {
    if (!this.loaded) return;

    // Don't restart if already playing
    if (this.loopingSounds.has(key)) return;

    const audio = this.sounds.get(name);
    if (audio) {
      const clone = audio.cloneNode() as HTMLAudioElement;
      clone.volume = 0.5;
      clone.loop = true;
      clone.play().catch(() => {});
      this.loopingSounds.set(key, clone);
    }
  }

  // Stop a looping sound by key
  stopLoop(key: string): void {
    const audio = this.loopingSounds.get(key);
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
      this.loopingSounds.delete(key);
    }
  }

  // Stop all looping sounds (e.g., on round end)
  stopAllLoops(): void {
    for (const audio of this.loopingSounds.values()) {
      audio.pause();
      audio.currentTime = 0;
    }
    this.loopingSounds.clear();
  }
}

// Singleton instance
let instance: SoundManager | null = null;

export function getSoundManager(): SoundManager {
  if (!instance) {
    instance = new SoundManager();
  }
  return instance;
}
