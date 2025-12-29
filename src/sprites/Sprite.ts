// Sprite - Individual sprite instance for static rendering

import type { SpriteAtlas } from './SpriteAtlas';

export class Sprite {
  atlas: SpriteAtlas;
  frameName: string;
  x = 0;
  y = 0;
  rotation = 0;     // Radians
  scale = 1;
  anchorX = 0.5;    // 0-1, where 0.5 is center
  anchorY = 0.5;    // 0-1, where 0.5 is center
  visible = true;

  constructor(atlas: SpriteAtlas, frameName: string) {
    this.atlas = atlas;
    this.frameName = frameName;
  }

  setPosition(x: number, y: number): void {
    this.x = x;
    this.y = y;
  }

  setRotation(radians: number): void {
    this.rotation = radians;
  }

  setScale(scale: number): void {
    this.scale = scale;
  }

  setAnchor(x: number, y: number): void {
    this.anchorX = x;
    this.anchorY = y;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (!this.visible) return;

    this.atlas.draw(ctx, this.frameName, this.x, this.y, {
      rotation: this.rotation,
      scale: this.scale,
      anchorX: this.anchorX,
      anchorY: this.anchorY,
    });
  }

  // Get the frame dimensions (useful for collision detection)
  getWidth(): number {
    const frame = this.atlas.getFrame(this.frameName);
    return frame ? frame.width * this.scale : 0;
  }

  getHeight(): number {
    const frame = this.atlas.getFrame(this.frameName);
    return frame ? frame.height * this.scale : 0;
  }

  // Draw with wrap-around at screen edges
  drawWrapped(ctx: CanvasRenderingContext2D, screenWidth: number, screenHeight: number): void {
    if (!this.visible) return;

    this.atlas.drawWrapped(ctx, this.frameName, this.x, this.y, screenWidth, screenHeight, {
      rotation: this.rotation,
      scale: this.scale,
      anchorX: this.anchorX,
      anchorY: this.anchorY,
    });
  }
}
