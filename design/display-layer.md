# Display Layer: what you see is not what you hit

Related: [architecture.md](./architecture.md) (Rendering), [old-tron-design.md](./old-tron-design.md),
[level-hazards.md](./level-hazards.md).

## Problem

The arena is 750×600 logical pixels and trails are one pixel wide, as in the original. On a
phone the arena is about 390 CSS pixels tall, so a trail is 0.65 CSS px wide — two device
pixels, a tenth of a millimetre: hard to see, and the single white pixel of the head is
harder still. The original
ran full-screen on a 14" CRT whose pixels bled into each other; a modern panel is much less
forgiving.

Until now the picture of the arena *was* the collision map: one pixel on screen per cell of
`PixelGrid`, and a level image in which every non-black pixel is a wall. That couples three
things that have no reason to be coupled:

- trails cannot be made more visible without making them thicker obstacles;
- a level cannot have a background other than pure black, because any non-black pixel is a wall;
- nothing can be drawn "around" things (shadows, outlines) because there is no "around".

## Model

Two bitmaps:

| | Collision bitmap | Display bitmap |
|---|---|---|
| Where | `PixelGrid` in the simulation (`src/game/PixelGrid.ts`) | `ArenaDisplay` in the view (`src/game/display/`) |
| Resolution | 750×600 | 750×600 cells, drawn at 1× or 2× |
| Holds | occupied / free (+ colour) | per cell: colour and **kind** (`trail`, `level`, empty) |
| Used by | rules, bots, netcode | nothing but the renderer |
| Changed by | the simulation | the same one-shot frame events the renderer already received |

**The collision bitmap and the rules are untouched.** No simulation file changes behaviour;
the wire format does not change. The display bitmap is rebuilt on every client from the
events it already gets (`newTrailSegments`, `borderSegments`, `clearedLines`,
`clearedAreas`, `eraserUsed`, `roundStarted`) and, for a guest joining mid-game, from the
arena snapshot.

Everything else that is drawn on top of a cell — the shade — is **derived**: a pure function
of the display bitmap in the neighbourhood of that cell (`shadeCells()` in
`src/game/display/shade.ts`). Nothing derived is ever stored as state. Consequences:

- **No ghosts.** Erasing a cell (bomb, tracer, eraser, dentist's hand, wrap-around
  rectangles) re-derives the cells around it; the shade of an erased trail cannot survive
  because it only ever existed as a function of that trail. Tests (`tests/display.test.ts`)
  check that after any sequence of adds and clears the picture equals the one derived from
  scratch, and that fed with the frame events of a real 90-second bot match (weapons,
  rounds, erasers) the display bitmap equals the collision bitmap cell for cell.
- **Guests and rejoining guests get it for free**: the shade is derived from whatever cells
  they have, however they got them.
- **A level with another kind of background** (light instead of dark) re-derives the whole picture from the same cells.

### Layers

`ArenaDisplay` produces two canvases at the display scale, composited every frame over the
background, in this order:

1. **background** — black, or the level's display-only background image (see below);
2. **level layer** — `level` cells (walls, lock-border pixels) and their derived drop shadow;
3. **trail layer** — `trail` cells and their derived fringe.

Trails keep a layer of their own because the Colour Blindness item tints all trails (not
the level) with a cycling colour; the tint keeps the fringe's alpha, so the shade follows.
A fringe is only drawn on **empty** cells: it never covers a wall or another trail.

A cell written by `addTrailSegments` is a trail; cells from the level image and
`borderSegments` are level. In an arena snapshot (which carries colours only) a cell is a
trail if its colour is one of the players' colours.

### Updating

Mutations mark dirty rectangles (cell coordinates, grown by as many cells as a change can
reach: twice the fringe, because of the gap rule below). Before compositing, each dirty rectangle is re-derived into a small
`ImageData` and written to both layers with `putImageData`. A normal tick dirties a
block of a few cells per player (at most 36); a bomb dirties one 122×122 block; a tracer line is processed in strips so
a long diagonal does not re-derive its whole bounding box. More than 256 rectangles in a
frame collapse into their bounding box.

### Gaps stay open

The shade makes a trail look wider than the obstacle it is, so it must never make a gap
you can drive through look closed. Rule, part of the derivation: **a free cell with trail
on both sides of it — left and right, or above and below — no further apart than two
fringes gets no shade at all.** Two trails with one free pixel between them are drawn as
two lines with a clean, unshaded pixel between them (and shade on their outer sides only);
whatever the distance between two trails, at least one cell of the gap is exactly as it
would be without shade. Tested for gaps of 1 to 4 pixels, both directions.

## The look

There is **one look, not a setting**. (Two rounds of selectable variants — fringes of half,
one and two pixels in dimmed colours, halo sizes, extras — were tried on a phone by the
owner and dropped: none was liked, and the options were hard to tell apart.)

### Trails: a hard pixel, softened

The trail is the hard, fully opaque pixel of the player's colour, exactly where the
obstacle is. Around it, pixels that are **not obstacles** carry the same colour
semi-transparently, so the line looks softer — closer to an anti-aliased line than to a
thicker one:

- a free pixel gets, for every trail pixel touching it, **12 %** if they are side by side
  and **3 %** if they only touch at a corner, added up, at most **30 %**;
- so the pixel beside a straight line gets 18 % (one side by side, two at corners), while
  the pixel in the notch of a staircase — a slanted trail — touches two trail pixels side
  by side and gets up to 30 %: slanted trails are smoothed more than they are thickened;
- the colour is that of the nearest trail pixel (side by side before corner);
- the shade reaches one pixel and no further, never covers a wall or another trail, and
  obeys the gap rule below.

Being transparent, the shade **mixes with whatever is behind it** — black, the navy of
Blueprint, the cream of Paper — when the trail layer is composited over the background,
so the same values serve every level. (An earlier version gave light levels an opaque
dark edge instead; it looked foreign to the level and was dropped, as was a first, twice
as strong, set of values that read as a thick line.)

Values are in `src/game/display/settings.ts` (`SOFT`). The picture is 1× (800×600 backing
store), as it always was.

Provisional (predicted) trail pixels of a guest are drawn as plain pixels, without shade,
for the few frames until the host confirms them.

### Heads: a white pixel that twinkles

A head is a **solid white pixel**, the pixel the player is on. Around it a faint white
glow twinkles like a star: the four pixels beside it (20–45 % white), the four at its
corners (4–14 %), and now and then a glint on the four pixels one further out, only when
two slow waves peak together. The waves have different periods (about 1.2 s and 2 s) and
a different phase for each player, so heads do not pulse in step. Not an obstacle; a few
`fillRect`s per head. On a light level (`lightBackground`, Paper) the glow is black instead,
so that the white pixel shows on it.

Tracers are a single white pixel (black on a light level), as before.

## Levels with a background

`LevelDefinition` gains an optional `backgroundFile`: an image drawn under everything and
**never read for collisions** (plus `lightBackground: true` when heads and tracers need a
dark edge to show on it). Walls still come from `imageFile` (non-black = wall; decoded from the PNG file, never
read back from a canvas — see architecture.md, Levels), whose
black pixels are now transparent on screen (the level layer is derived from the cells, not
blitted from the image). Erasing works by clearing cells, so the background shows through
a blown-up wall — nothing is "painted black" any more.

New levels:

| id | Name | Background | Walls |
|----|------|-----------|-------|
| `blueprint` | Blueprint | dark navy (`#0a1830`-ish) with a faint 50 px drafting grid | pale-blue floor-plan walls with door gaps |
| `paper` | Paper | cream squared paper (`#d9d3bd`), `lightBackground` — the deliberately hard case: there the glow of the heads and the tracers are dark | ink-blue rings with an opening, and a rule |

They are generated by `scripts/build-research-levels.ts` (`npm run levels:research`).
Start corners and the centre are kept clear like in the original maps.

What assumed black, and what was done:

| Assumption | Where | Now |
|------------|-------|-----|
| Level image is the picture | `levelCanvas.drawImage(image)` | level layer derived from cells; background separate |
| Erase = transparent over black fill | `clearRect` / `clearLine` | unchanged idea; the fill is the background image |
| Lit-pixel count in e2e | `network.e2e.mjs` | counts over the whole backing store whatever its scale; the test level is `blank` |
| White head / white tracer | `drawPlayerHead`, `drawProjectile` | on a `lightBackground` level the head's halo is dark (the pixel stays white) and tracers are black |
| Item sprites with a white box | sprite atlas | untouched; they look pasted on Paper (cosmetic) |
| Door sprites have black recesses | `doors.png` | only on `portals`, whose background is black; left as is |
| Countdown / summary overlays | 50 % black veil | fine on any background |
| White flash, side panel | opaque | unaffected |

## Contrast

WCAG contrast ratio against the background (1 = invisible, 21 = white on black; 3 is the
usual minimum for graphics):

| Trail colour | black | Blueprint `#0a1a34` | Paper `#d9d3bd` | Paper, a dark edge (40 % of the colour; tried and dropped) |
|---|---:|---:|---:|---:|
| red `#ff4444` | 6.2 | 5.1 | 2.3 | 8.1 |
| green `#44ff44` | 15.6 | 12.9 | **1.1** | 4.7 |
| blue `#4444ff` | **3.5** | **2.9** | 4.0 | 10.0 |
| yellow `#ffff44` | 19.6 | 16.2 | **1.4** | 4.0 |
| team purple `#aa00aa` | **3.3** | **2.7** | 4.3 | 10.5 |
| team brown `#aa6600` | 4.6 | 3.8 | 3.0 | 9.0 |
| white (head, tracer) | 21.0 | 17.4 | **1.5** | white pixel on its dark halo 12; the halo on the paper 8 |

Blue and team purple are the weak ones on dark backgrounds.

## Known limits

- Not seen on real hardware by anybody but the owner; nothing measured there.
- The gap rule looks along rows and columns. Two trails that only approach each other
  diagonally are not treated as a gap (their shade meets at a corner).
- In an arena snapshot (rejoin) lock-border pixels have the player's colour and are taken
  for trail until the next round.
- The shade does not wrap around the arena edges.
- A head's glow is white whatever the player; two heads meeting are told apart by their
  trails only.
- Door sprites (Portals) have black recesses; fine there because that level is black.
- Item sprites with a white box look pasted on Paper.
- The derivation still supports things the game no longer uses (several fringe bands, a
  2× backing store); they are covered by no test any more and can go.
