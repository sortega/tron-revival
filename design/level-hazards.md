# Level Hazards

Three of the original maps have a hazard of their own, started by `ItemLauncher` in
`old-tron/TRON.PRG`:

| Original map | Level here | Hazard | Status |
|--------------|-----------|--------|--------|
| 205 *Inédito* | `dentistry` | The dentist's hand (`PROCESS Mano`) | Implemented |
| 206 *Guerra* | `warzone` | Shell bursts (`PROCESS Guerra`) | Implemented |
| 207 *Puertas* | `portals` | Automatic doors (`PROCESS Bandas` / `Banda`) | Implemented |

Related: [old-tron-design.md](./old-tron-design.md), [local-and-ai.md](./local-and-ai.md),
[networking.md](./networking.md).

## Principles

- Hazards are part of the **pure simulation** (`src/game/`), deterministic and seedable like
  everything else, so they run headless in tests and identically on a network host.
- A level declares its hazards as data in `LEVEL_DEFINITIONS`; the simulation never loads
  images for them. Geometry measured from the original sprites is written down in code.
- Hazards only run during the `playing` phase and freeze when the round ends (the original
  processes loop `while(playing)`).
- Whatever a guest needs to draw a hazard travels in `TronRoundState`.

## Automatic doors (level `portals`)

The level is a walled arena whose border has four gaps, one per edge, plus a gap in a wall
in the middle. Each gap is closed by a sliding double door. Wrap-around is therefore only
possible through an open door.

### Placement

From the control points of map 207 in `TRON.FPG` (points 1–6; point 5 is unset):

| # | Centre (x, y) | Orientation | Where |
|---|---------------|-------------|-------|
| 1 | 384, 0 | horizontal | top edge |
| 2 | 749, 285 | vertical | right edge |
| 3 | 381, 599 | horizontal | bottom edge |
| 4 | 0, 287 | vertical | left edge |
| 6 | 385, 290 | vertical | centre |

In the original, even-numbered doors are rotated 90°. The four edge doors are centred on the
edge, so only half of each is inside the play area; the rest is clipped.

### Geometry

The door sprite (graphs 30–39, `PUERTA*.BMP`) is 120 × 50 px: 120 along the wall, 50 thick.
Its centre is the control point: along the wall it covers `c-60 … c+59`, across `c-25 … c+24`.
In sprite coordinates (`u` along the wall 0–119, `v` across 0–49):

- **Posts**: `u ≤ 25` or `u ≥ 94`, every `v`. Always solid.
- **Leaves**: `v` in 5–44. The left leaf covers `26 ≤ u ≤ L`, the right one `119-L ≤ u ≤ 93`,
  where `L` depends on the animation frame:

  | Frame | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
  |-------|---|---|---|---|---|---|---|---|---|---|
  | `L` | 59 | 58 | 56 | 53 | 48 | 42 | 35 | 32 | 30 | 29 |

  Frame 0 is fully closed, frame 9 fully open (a 60 px opening; 4 px of each leaf remain).
- Everything else (the 5 px recess on both faces between the posts) is free.

A vertical door swaps the axes (`u` along y, `v` along x). The sprites are symmetric, so the
direction of rotation does not matter.

### Timing

All doors share one clock, `doorTick`: the number of `playing` ticks elapsed in the round
(the original passes the same phase 0 to every door). With `m = doorTick mod 460`:

| `m` | State | Frame |
|-----|-------|-------|
| 0–199 | closed | 0 |
| 200–229 | opening | `floor((m-200)·10/30)` |
| 230–429 | open | 9 |
| 430–459 | closing | `9 - floor((m-430)·10/30)` |

At 70 ticks/s: closed 2.9 s, moving 0.4 s, open 2.9 s. Doors start every round closed.

### Rules

- A player whose head is on a solid door pixel dies (death cause `door`). This is checked
  after every pixel-step, with the frame of the current tick.
- As in the original, **a shield does not help**: the door kills regardless.
- Doors are not part of the collision grid. Projectiles, tracers, bombs, satellites and
  items ignore them, and weapons cannot damage them.
- Trails drawn through an open doorway stay in the collision grid. The closed leaves cover
  them on screen, and they are still there when the door opens again (original behaviour:
  the door is a sprite over the background). A doorway can thus get blocked for good until
  somebody shoots it clear.
- Items may spawn under a door, as in the original; they are then hidden while it is closed.

### State and networking

`TronRoundState.doorTick` is the only state. It is reset to 0 by `initRound` and advanced at
the start of every `playing` tick. Guests draw the doors from it and do not predict door
deaths (deaths are always the host's call).

### Rendering

`public/assets/levels/doors.png` is a 120 × 500 strip with the ten original frames stacked
vertically (palette index 0 transparent), generated from `TRON.FPG`. The renderer draws the
current frame of every door above the trails and below items and players; vertical doors are
drawn rotated by 90°. The strip is only loaded for levels that declare doors.

### Bots

Rollouts treat solid door pixels as obstacles, taking time into account: rollout step `s`
is checked against the door frame at tick `doorTick + s` **and** at `doorTick + s + 25`
(a bot may be slower than one pixel per tick, and should not cut it fine). So a bot only
goes through a doorway that is open and will stay open while it crosses, and it does not
linger in one that is about to close.

### Validation

- Rule tests: frame sequence over one cycle; geometry against the table above; a player
  driving into a closed door dies with cause `door`, shield or not; a player crossing an
  open doorway survives and wraps around; doors do not advance outside `playing`.
- Bot matches on `portals`: door deaths stay rare.

## The dentist's hand (level `dentistry`)

A huge hand holding a drill wanders over the arena and drills the teeth. It is a nuisance
rather than a killer: it **never kills** (in the original, touching a player only makes the
sprite translucent), but it hides a 200 × 250 px chunk of the screen and nibbles pixels away.

### Behaviour

A port of `PROCESS Mano`. State: the drill tip `(x, y)` in whole pixels, a target (0 =
resting, or one of the 30 control points of map 205, mostly teeth), the aim point and a
countdown `rest`. It starts resting at home, (800, 600), off-screen at the bottom right, with
`rest = 100`. Every `playing` tick:

1. If `rest ≤ 0`: with probability ½ pick a new target — half of the time "rest", otherwise
   a random control point; otherwise keep the current one. Then `rest = 100`, and if there
   is a target, aim at it with ±20 px of horizontal jitter.
2. Resting: move 6 px towards home; `rest` runs down.
3. With a target, farther than 4 px from the aim: move 6 px towards it (`rest` does not run).
4. Within 4 px of the aim: **drill** — `rest` runs down, the tip jitters ±3 px on each axis,
   and the pixel under the tip is erased from the collision grid (trail or scenery). The
   drill sound loops while drilling.

Differences from the original: movement snaps onto its destination when closer than one
step (the original overshoots and oscillates), and positions are rounded to whole pixels.

### State, networking and rendering

- `TronRoundState.hand` (`{x, y}`, only on this level) is all a guest needs. Erased pixels
  travel as ordinary `clearedAreas`, the drill as an ordinary sound loop (`drill`, key `hand`).
- The sprite (`dentist_hand` in the atlas) is drawn over everything in the play area with
  its control point (1, 17) — the drill tip — at `(x, y)`, clipped to the play area.
- While an alive player's head is under the sprite's bounding box it is drawn translucent
  (the original tested the sprite's pixels and used Div's transparency flag).
- Bots ignore the hand.

### Validation

Tests: the 30 targets; a long run of the state machine (rests first, moves ≤ 6 px per tick,
drills near many different teeth); in the simulation it erases scenery pixels one at a time,
loops the drill sound, kills nobody, exists only on its level and freezes at round end.

## Shell bursts (level `warzone`)

The tank and the cannon painted on the map fire at random.

### Guns

A gun is a pair of control points of map 206 in `TRON.FPG` (muzzle → aim):

| Gun | Muzzle | Aim | Direction (screen degrees, 0° = right, 90° = down) |
|-----|--------|-----|-----|
| Tank | 385, 250 | 413, 243 | ≈ 346° (right, slightly up) |
| Cannon | 623, 264 | 582, 270 | ≈ 172° (left, slightly down) |

### Rules

- On every `playing` tick, with probability 1/201 (the original's `rand(0,200)==1`), one
  gun chosen at random fires a burst, with the explosion sound.
- A burst is exactly a Shotgun blast without an owner: 30 pellets from the muzzle, each
  deviating up to ±5° from the gun's direction, speed 10–30 px/tick, lifetime 10 ticks
  (so they reach 100–300 px). Pellets are ordinary `tracer` projectiles: they kill players
  (death cause `tracer`; a shield protects, as against any tracer), and erase trails and
  scenery along their path.
- Pellets have no owner: `Projectile.ownerSlot` is `NO_OWNER` (-1). Nobody is immune and
  no satellite lets them through.
- Randomness comes from the simulation's seeded RNG, so matches stay deterministic.

### Bots

Bots that avoid hazards (`normal`, `hard`) know the fire zones, as a human who has played
the level does: rollout steps inside a gun's zone (within ±7° of its direction and 220 px
of the muzzle) during the first 80 steps make a path less attractive. They may still cross
when the alternatives are worse.

### Validation

- Rule tests: a burst is 30 ownerless pellets inside the cone; bursts happen at the
  expected rate and only while playing; a player parked in front of a muzzle is killed
  with cause `tracer`; levels without guns never fire.
- Bot matches on `warzone`: deaths by gunfire stay a small share.
