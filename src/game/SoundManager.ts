// SoundManager - Handles game audio

// Sounds used for item pickup
export const PICKUP_SOUNDS = ['item_pickup', 'shield', 'turbo', 'slow', 'reset', 'teleport'] as const;
export type PickupSound = typeof PICKUP_SOUNDS[number];

// Sounds used when weapons are fired
export const USE_SOUNDS = ['glock', 'rifle', 'shotgun', 'uzi', 'bomb', 'explosion', 'alarm', 'slow', 'turbo'] as const;
export type UseSound = typeof USE_SOUNDS[number];

// All sound names (the list only exists to derive the type)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
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
const VOLUME = 0.5;
/** The same effect is not started again within this time (ms). */
const MIN_REPEAT_MS = 25;
/** Events that let a browser start (or restart) audio. */
const UNLOCK_EVENTS = ['pointerup', 'touchend', 'click', 'keydown'] as const;

// Web Audio, not audio elements: phones refuse or delay elements started outside a touch
// handler. See design/sound.md.
export class SoundManager {
  private readonly context: AudioContext | null;
  private readonly output: GainNode | null = null;
  private readonly buffers = new Map<SoundName, AudioBuffer>();
  private readonly lastStart = new Map<SoundName, number>();
  private readonly loopingSounds = new Map<string, AudioBufferSourceNode>();
  /** Loops asked for before their file was decoded: key -> sound. */
  private readonly pendingLoops = new Map<string, SoundName>();
  private muted: boolean;

  constructor() {
    this.muted = localStorage.getItem(MUTED_STORAGE_KEY) === 'true';
    const Context = typeof AudioContext !== 'undefined' ? AudioContext : null;
    this.context = Context ? new Context() : null;
    if (!this.context) return;
    this.output = this.context.createGain();
    this.output.gain.value = VOLUME;
    this.output.connect(this.context.destination);

    // The iPhone's silent switch should not mute the game (Safari only)
    const session = (navigator as { audioSession?: { type: string } }).audioSession;
    if (session) {
      try { session.type = 'playback'; } catch { /* not supported after all */ }
    }

    // The context starts suspended, and iOS suspends it again after an interruption
    for (const type of UNLOCK_EVENTS) window.addEventListener(type, this.unlock, true);
    document.addEventListener('visibilitychange', this.unlock);
    void this.loadSounds();
  }

  private unlock = (): void => {
    const context = this.context;
    if (!context || document.hidden || context.state === 'running') return;
    context.resume().catch(() => { /* still not allowed: the next gesture tries again */ });
  };

  private async loadSounds(): Promise<void> {
    const context = this.context;
    if (!context) return;
    const basePath = `${import.meta.env.BASE_URL}assets/sounds/`;
    await Promise.all(Object.entries(SOUND_FILES).map(async ([name, file]) => {
      try {
        const response = await fetch(basePath + file);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = await context.decodeAudioData(await response.arrayBuffer());
        this.buffers.set(name as SoundName, buffer);
      } catch (err) {
        console.warn(`Failed to load sound: ${name}`, err);
      }
    }));
    for (const [key, name] of this.pendingLoops) this.startLoop(name, key);
    this.pendingLoops.clear();
  }

  private source(name: SoundName): AudioBufferSourceNode | null {
    const buffer = this.buffers.get(name);
    if (!this.context || !this.output || !buffer) return null;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.output);
    return source;
  }

  play(name: SoundName): void {
    // Not queued while the context is suspended: everything would sound at once later
    if (this.muted || this.context?.state !== 'running') return;
    const now = performance.now();
    if (now - (this.lastStart.get(name) ?? -Infinity) < MIN_REPEAT_MS) return;
    const source = this.source(name);
    if (!source) return;
    this.lastStart.set(name, now);
    source.start();
  }

  // Start a looping sound with a unique key (e.g., player slot)
  playLoop(name: SoundName, key: string): void {
    // Don't restart if already playing
    if (this.muted || this.loopingSounds.has(key)) return;
    if (this.buffers.has(name)) this.startLoop(name, key);
    else this.pendingLoops.set(key, name);
  }

  private startLoop(name: SoundName, key: string): void {
    const source = this.source(name);
    if (!source) return;
    source.loop = true;
    source.start();   // (heard once the context runs)
    this.loopingSounds.set(key, source);
  }

  // Stop a looping sound by key
  stopLoop(key: string): void {
    this.pendingLoops.delete(key);
    const source = this.loopingSounds.get(key);
    if (source) {
      source.stop();
      source.disconnect();
      this.loopingSounds.delete(key);
    }
  }

  // Stop all looping sounds (e.g., on round end)
  stopAllLoops(): void {
    for (const key of [...this.loopingSounds.keys(), ...this.pendingLoops.keys()]) this.stopLoop(key);
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
