// AnimatedSprite - Sprite with frame animation support

import type { SpriteAtlas } from './SpriteAtlas';
import { Sprite } from './Sprite';

export class AnimatedSprite extends Sprite {
  frames: string[];           // Frame names in animation sequence
  frameIndex = 0;
  frameRate = 12;             // Frames per second
  loop = true;
  playing = false;
  onComplete?: () => void;    // Callback when non-looping animation ends

  private elapsed = 0;        // Time since last frame change

  constructor(atlas: SpriteAtlas, frames: string[]) {
    super(atlas, frames[0] || '');
    this.frames = frames;
  }

  play(): void {
    this.playing = true;
    this.frameIndex = 0;
    this.elapsed = 0;
    this.updateFrameName();
  }

  stop(): void {
    this.playing = false;
  }

  pause(): void {
    this.playing = false;
  }

  resume(): void {
    this.playing = true;
  }

  reset(): void {
    this.frameIndex = 0;
    this.elapsed = 0;
    this.playing = false;
    this.updateFrameName();
  }

  // Call this each frame with delta time in seconds
  update(deltaTime: number): void {
    if (!this.playing || this.frames.length === 0) return;

    this.elapsed += deltaTime;
    const frameDuration = 1 / this.frameRate;

    while (this.elapsed >= frameDuration) {
      this.elapsed -= frameDuration;
      this.frameIndex++;

      if (this.frameIndex >= this.frames.length) {
        if (this.loop) {
          this.frameIndex = 0;
        } else {
          this.frameIndex = this.frames.length - 1;
          this.playing = false;
          this.onComplete?.();
          break;
        }
      }
    }

    this.updateFrameName();
  }

  private updateFrameName(): void {
    const frame = this.frames[this.frameIndex];
    if (frame) {
      this.frameName = frame;
    }
  }

  // Get current frame index (0-based)
  getCurrentFrame(): number {
    return this.frameIndex;
  }

  // Get total frame count
  getFrameCount(): number {
    return this.frames.length;
  }

  // Check if animation has finished (for non-looping)
  isFinished(): boolean {
    return !this.loop && !this.playing && this.frameIndex >= this.frames.length - 1;
  }
}
