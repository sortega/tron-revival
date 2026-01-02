// SoundManager - Handles game audio

// Sounds used for item pickup
export const PICKUP_SOUNDS = ['item_pickup', 'shield', 'turbo', 'slow', 'reset', 'teleport'] as const;
export type PickupSound = typeof PICKUP_SOUNDS[number];

// Sounds used when weapons are fired
export const USE_SOUNDS = ['glock', 'rifle', 'shotgun', 'uzi', 'bomb', 'explosion', 'alarm', 'slow', 'turbo'] as const;
export type UseSound = typeof USE_SOUNDS[number];

// All sound names
const SOUND_NAMES = [
  'round_start', 'laughs', 'teleport', 'drill', 'panico',
  ...PICKUP_SOUNDS,
  ...USE_SOUNDS,
] as const;
export type SoundName = typeof SOUND_NAMES[number];

const SOUND_FILES: Record<SoundName, string> = {
  round_start: 'round_start.mp3',
  laughs: 'laughs.mp3',
  teleport: 'teleport.mp3',
  panico: 'panico.mp3',
  item_pickup: 'item_pickup.mp3',
  shield: 'shield.mp3',
  turbo: 'turbo.mp3',
  slow: 'slow.mp3',
  reset: 'reset.mp3',
  glock: 'glock.mp3',
  rifle: 'rifle.mp3',
  shotgun: 'shotgun.mp3',
  uzi: 'uzi.mp3',
  drill: 'drill.mp3',
  bomb: 'bomb.mp3',
  explosion: 'explosion.mp3',
  alarm: 'alarm.mp3',
};

const MUTED_STORAGE_KEY = 'teratron-muted';

export class SoundManager {
  private sounds: Map<SoundName, HTMLAudioElement> = new Map();
  private loadedCount = 0;
  private totalCount = Object.keys(SOUND_FILES).length;
  private loopingSounds: Map<string, HTMLAudioElement> = new Map();
  private preloadPromise: Promise<void>;
  private muted: boolean = false;

  constructor() {
    // Load mute preference from localStorage
    this.muted = localStorage.getItem(MUTED_STORAGE_KEY) === 'true';
    this.preloadPromise = this.preloadSounds();
  }

  private preloadSounds(): Promise<void> {
    const basePath = `${import.meta.env.BASE_URL}assets/sounds/`;
    const loadPromises: Promise<void>[] = [];

    for (const [name, file] of Object.entries(SOUND_FILES)) {
      const audio = new Audio();
      audio.preload = 'auto';

      const loadPromise = new Promise<void>((resolve) => {
        audio.addEventListener('canplaythrough', () => {
          this.loadedCount++;
          resolve();
        }, { once: true });

        audio.addEventListener('error', () => {
          console.warn(`Failed to load sound: ${name}`);
          this.loadedCount++;
          resolve(); // Still resolve to not block other sounds
        }, { once: true });
      });

      // Set src after adding listeners to ensure events fire
      audio.src = basePath + file;
      this.sounds.set(name as SoundName, audio);
      loadPromises.push(loadPromise);
    }

    return Promise.all(loadPromises).then(() => {
      console.log(`[SoundManager] Loaded ${this.loadedCount}/${this.totalCount} sounds`);
    });
  }

  // Wait for all sounds to load
  async waitForLoad(): Promise<void> {
    await this.preloadPromise;
  }

  isLoaded(): boolean {
    return this.loadedCount >= this.totalCount;
  }

  play(name: SoundName): void {
    if (this.muted) return;

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
    // Don't restart if already playing
    if (this.loopingSounds.has(key)) return;
    if (this.muted) return;

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

  // Toggle mute state
  toggleMute(): boolean {
    this.muted = !this.muted;
    localStorage.setItem(MUTED_STORAGE_KEY, String(this.muted));
    if (this.muted) {
      // Stop all currently playing loops when muting
      this.stopAllLoops();
    }
    return this.muted;
  }

  // Check if muted
  isMuted(): boolean {
    return this.muted;
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

// Initialize sound manager early to start preloading
export function initSoundManager(): SoundManager {
  return getSoundManager();
}
