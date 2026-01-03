# Proposal: Extract Systems from TronGameState

**Status**: Proposed

## Problem

`TronGameState.ts` has grown to ~1900 lines, making it harder to maintain and understand.

## Proposed Solution

Extract the three major systems into separate modules:

1. **ProjectileSystem** (~300-400 lines)
2. **BodyguardSystem** (~200 lines)
3. **EffectsSystem** (~200 lines)

### ProjectileSystem

Handles all projectile-related logic:

- Projectile movement and physics
- Collision detection (players, trails, borders, bodyguards)
- Portal teleportation for projectiles
- Bresenham line tracing for fast projectiles
- Explosion creation and propagation
- Tracer bullet rendering state

```typescript
interface ProjectileSystem {
  tick(dt: number, ctx: GameStateContext): ProjectileTickResult;
  createProjectile(params: ProjectileParams): Projectile;
  createExplosion(x: number, y: number, radius: number): void;
}

interface ProjectileTickResult {
  kills: Kill[];
  sounds: SoundEvent[];
  explosions: Explosion[];
}
```

### BodyguardSystem

Handles bodyguard AI and behavior:

- Bodyguard spawning
- Orbit movement around owner
- Target acquisition (nearest enemy)
- Chase and attack behavior
- Collision with projectiles (deflection)
- Collision with players (kills)

```typescript
interface BodyguardSystem {
  tick(dt: number, ctx: GameStateContext): BodyguardTickResult;
  spawn(ownerSlot: SlotIndex): Bodyguard;
}

interface BodyguardTickResult {
  kills: Kill[];
  sounds: SoundEvent[];
  deflectedProjectiles: string[]; // projectile IDs
}
```

### EffectsSystem

Handles item pickup effects and weapon firing:

- Effect activation (Shield, Crossing, Eraser, Swap, etc.)
- Weapon state management
- Weapon firing logic
- Duration tracking for timed effects
- Speed factor calculation

```typescript
interface EffectsSystem {
  activateEffect(player: TronPlayer, sprite: string): EffectResult;
  tickWeapons(dt: number, inputs: Map<SlotIndex, TronInput>): WeaponTickResult;
  getSpeedFactor(): number;
}
```

## File Structure

```
src/game/
  systems/
    ProjectileSystem.ts
    BodyguardSystem.ts
    EffectsSystem.ts
    types.ts              # Shared types (Kill, SoundEvent, etc.)
    index.ts
  TronGameState.ts        # Orchestrates systems, owns state
```

## State Ownership

TronGameState remains the single source of truth for all game state. Systems receive a context object with the state they need and return results that TronGameState applies.

```typescript
interface GameStateContext {
  // Read-only access
  readonly players: readonly TronPlayer[];
  readonly playWidth: number;
  readonly playHeight: number;
  readonly level: Level;

  // Mutable state passed to systems
  projectiles: Projectile[];
  bodyguards: Bodyguard[];
  pixelOwners: Map<string, string>;
}
```

## Expected Reduction

| System | Lines Extracted |
|--------|----------------|
| ProjectileSystem | ~350 |
| BodyguardSystem | ~200 |
| EffectsSystem | ~200 |
| **Total** | **~750** |

This would reduce TronGameState from ~1900 to ~1150 lines.

## Implementation Order

1. **ProjectileSystem first** - Most isolated, clearest boundaries
2. **BodyguardSystem second** - Depends on projectile collision detection
3. **EffectsSystem last** - Most interconnected with player state

## Challenges

- **Projectile-bodyguard interaction**: Bodyguards deflect projectiles, need shared collision detection
- **Explosion chains**: Explosions can trigger more explosions, need careful state management
- **Speed factor**: Calculated from multiple sources (weapons, effects), touches many systems
