---
name: sprites
description: Guide for adding and using sprites in the Teratron sprite sheet system. Use when adding new images, creating animations, or drawing sprites in the game.
---

# Sprite Sheet System

This project uses a compiled sprite atlas for efficient rendering. Individual PNG files are packed into a single sprite sheet with JSON metadata.

## Directory Structure

```
sprites-source/           # Source PNGs (add new sprites here)
public/assets/sprites/    # Compiled output (auto-generated)
src/game/spriteHash.ts    # Hash constant (auto-generated)
src/sprites/SpriteAtlas.ts # Sprite loading and drawing class
```

## Adding New Sprites

### 1. Add PNG to sprites-source/

Place your PNG file in `sprites-source/`. The filename (without extension) becomes the sprite name.

```
sprites-source/my_sprite.png     -> sprite name: "my_sprite"
sprites-source/explosion_01.png  -> sprite name: "explosion_01"
```

### 2. Compile the sprite sheet

```bash
npm run sprites
```

This:
- Packs all PNGs into `public/assets/sprites/items.<hash>.png`
- Generates JSON atlas `public/assets/sprites/items.<hash>.json`
- Updates `src/game/spriteHash.ts` with new hash
- Removes old hashed files automatically

### 3. Commit all generated files

After running `npm run sprites`, commit:
- The new source PNG in `sprites-source/`
- Updated files in `public/assets/sprites/`
- Updated `src/game/spriteHash.ts`

## Naming Conventions

| Pattern | Use Case | Example |
|---------|----------|---------|
| `name.png` | Single sprite | `eraser.png` |
| `name_01.png` to `name_NN.png` | Animation frames | `portal_01.png` to `portal_30.png` |
| `name_sidebar.png` | Sidebar display variant | `turbo_sidebar.png` |

## Using Sprites in Code

### Load the atlas (done once in TronRenderer)

```typescript
import { SpriteAtlas } from '../sprites';
import { SPRITE_HASH } from './spriteHash';

this.spriteAtlas = new SpriteAtlas();
await this.spriteAtlas.load(`${import.meta.env.BASE_URL}assets/sprites/items.${SPRITE_HASH}.json`);
```

### Draw a sprite (centered at x, y)

```typescript
if (this.spriteAtlas?.isLoaded()) {
  this.spriteAtlas.draw(ctx, 'my_sprite', x, y);
}
```

### Draw with options

```typescript
this.spriteAtlas.draw(ctx, 'my_sprite', x, y, {
  rotation: Math.PI / 4,  // Radians
  scale: 2,               // 2x size
  anchorX: 0.5,           // 0-1, horizontal anchor (0.5 = center)
  anchorY: 0.5,           // 0-1, vertical anchor (0.5 = center)
});
```

### Draw with wrap-around (for sprites near screen edges)

```typescript
this.spriteAtlas.drawWrapped(ctx, 'portal_01', x, y, PLAY_WIDTH, PLAY_HEIGHT);
```

### Animation example

```typescript
// Cycle through frames
const frameNum = String(animFrame + 1).padStart(2, '0');
const frameName = `explosion_${frameNum}`;  // "explosion_01", "explosion_02", etc.
this.spriteAtlas.draw(ctx, frameName, x, y);
```

## Common Sprite Types

### Items (pickups)
- Round sprites for automatic items: `eraser.png`, `automatic_slow.png`
- Square sprites for weapons: `glock.png`, `turbo.png`
- Each needs a `_sidebar` variant for the status panel

### UI Elements
- `sidebar.png` - The 50x600 status panel background
- `ridiculous_death.png` - Shown in sidebar on ridiculous death

### Animations
- `portal_01.png` to `portal_30.png` - Teleport portal animation
- `explosion_01.png` to `explosion_39.png` - Explosion effect

## Importing from Legacy Game

The original TRON.PRG sprites use black (#000000) as the background color. When importing:

1. Extract the sprite from `old-tron/compiled/extracted/static/`
2. Replace black pixels with transparency using ImageMagick:
   ```bash
   magick input.png -transparent black output.png
   ```
3. Place in `sprites-source/` and run `npm run sprites`

## Tips

- Use transparency for non-rectangular sprites
- Keep sprites reasonably sized (the atlas is 1024x1024 max)
- Test with `npm run dev` after adding sprites
- The sprite hash ensures cache busting on updates
