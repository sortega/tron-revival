// SpriteAtlas - Loads sprite sheet and JSON atlas metadata

export interface FrameData {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface AtlasFrame {
  frame: { x: number; y: number; w: number; h: number };
  rotated: boolean;
  trimmed: boolean;
  spriteSourceSize: { x: number; y: number; w: number; h: number };
  sourceSize: { w: number; h: number };
}

interface AtlasJson {
  frames: Record<string, AtlasFrame>;
  meta: {
    image: string;
    size: { w: number; h: number };
    scale: string;
  };
}

export class SpriteAtlas {
  private image: HTMLImageElement | null = null;
  private frames: Map<string, FrameData> = new Map();
  private loaded = false;

  async load(atlasPath: string): Promise<void> {
    // Fetch the JSON atlas
    const response = await fetch(atlasPath);
    if (!response.ok) {
      throw new Error(`Failed to load atlas: ${atlasPath}`);
    }

    const atlasData: AtlasJson = await response.json();

    // Parse frames
    for (const [name, frameInfo] of Object.entries(atlasData.frames)) {
      this.frames.set(name, {
        x: frameInfo.frame.x,
        y: frameInfo.frame.y,
        width: frameInfo.frame.w,
        height: frameInfo.frame.h,
      });
    }

    // Load the image
    const imagePath = atlasPath.replace(/\.json$/, '.png');
    this.image = new Image();

    await new Promise<void>((resolve, reject) => {
      this.image!.onload = () => resolve();
      this.image!.onerror = () => reject(new Error(`Failed to load sprite image: ${imagePath}`));
      this.image!.src = imagePath;
    });

    this.loaded = true;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  getFrame(name: string): FrameData | undefined {
    return this.frames.get(name);
  }

  getFrameNames(): string[] {
    return Array.from(this.frames.keys());
  }

  getImage(): HTMLImageElement | null {
    return this.image;
  }

  draw(
    ctx: CanvasRenderingContext2D,
    frameName: string,
    x: number,
    y: number,
    options?: {
      rotation?: number;      // Radians
      scale?: number;
      anchorX?: number;       // 0-1, where 0.5 is center
      anchorY?: number;       // 0-1, where 0.5 is center
    }
  ): void {
    if (!this.image || !this.loaded) return;

    const frame = this.frames.get(frameName);
    if (!frame) {
      console.warn(`Frame not found: ${frameName}`);
      return;
    }

    const { rotation = 0, scale = 1, anchorX = 0.5, anchorY = 0.5 } = options || {};

    const width = frame.width * scale;
    const height = frame.height * scale;
    const offsetX = width * anchorX;
    const offsetY = height * anchorY;

    ctx.save();
    ctx.translate(x, y);

    if (rotation !== 0) {
      ctx.rotate(rotation);
    }

    ctx.drawImage(
      this.image,
      frame.x,
      frame.y,
      frame.width,
      frame.height,
      -offsetX,
      -offsetY,
      width,
      height
    );

    ctx.restore();
  }

  // Draw sprite with wrap-around at screen edges
  // If sprite is near an edge, it will be drawn on the opposite side too
  drawWrapped(
    ctx: CanvasRenderingContext2D,
    frameName: string,
    x: number,
    y: number,
    screenWidth: number,
    screenHeight: number,
    options?: {
      rotation?: number;
      scale?: number;
      anchorX?: number;
      anchorY?: number;
    }
  ): void {
    if (!this.image || !this.loaded) return;

    const frame = this.frames.get(frameName);
    if (!frame) return;

    const { scale = 1, anchorX = 0.5, anchorY = 0.5 } = options || {};
    const halfWidth = (frame.width * scale) * anchorX;
    const halfHeight = (frame.height * scale) * anchorY;

    // Calculate all positions where sprite should be drawn
    const positions: { x: number; y: number }[] = [{ x, y }];

    // Check horizontal wrap
    const nearLeft = x - halfWidth < 0;
    const nearRight = x + halfWidth > screenWidth;

    // Check vertical wrap
    const nearTop = y - halfHeight < 0;
    const nearBottom = y + halfHeight > screenHeight;

    // Add wrapped positions
    if (nearLeft) {
      positions.push({ x: x + screenWidth, y });
    }
    if (nearRight) {
      positions.push({ x: x - screenWidth, y });
    }
    if (nearTop) {
      positions.push({ x, y: y + screenHeight });
    }
    if (nearBottom) {
      positions.push({ x, y: y - screenHeight });
    }

    // Corner cases - need diagonal wraps too
    if (nearLeft && nearTop) {
      positions.push({ x: x + screenWidth, y: y + screenHeight });
    }
    if (nearLeft && nearBottom) {
      positions.push({ x: x + screenWidth, y: y - screenHeight });
    }
    if (nearRight && nearTop) {
      positions.push({ x: x - screenWidth, y: y + screenHeight });
    }
    if (nearRight && nearBottom) {
      positions.push({ x: x - screenWidth, y: y - screenHeight });
    }

    // Draw at all positions
    for (const pos of positions) {
      this.draw(ctx, frameName, pos.x, pos.y, options);
    }
  }
}
