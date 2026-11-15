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
reach: one cell, for the smooth line). Before compositing, each dirty rectangle is re-derived into a small
`ImageData` and written to both layers with `putImageData`. A normal tick dirties a
block of a few cells per player (at most 36); a bomb dirties one 122×122 block; a tracer line is processed in strips so
a long diagonal does not re-derive its whole bounding box. More than 256 rectangles in a
frame collapse into their bounding box.

## The look

There is **one look, not a setting**. (Two rounds of selectable variants — fringes of half,
one and two pixels in dimmed colours, halo sizes, extras — were tried on a phone by the
owner and dropped: none was liked, and the options were hard to tell apart.)

### Trails: a hard pixel line, and the smooth line over it

Two lines are drawn for every trail:

1. **The hard line**: the fully opaque pixels of the player's colour, exactly where the
   obstacles are (the pixels the player's position fell in).
2. **The smooth line**, over it: the path the player really followed — positions have
   fractions of a pixel — as a one-pixel-wide line whose colour is **shared out among the
   pixels it crosses in proportion to how much of each it covers**. A path through the
   middle of its pixels covers only them and adds nothing; a path 0.3 of a pixel off
   centre puts 30 % of the colour on the neighbouring pixel; a slanted path fills the
   steps of its staircase. It never reaches further than one pixel from the hard line.

The smooth line is **not an obstacle**. It only shows on free pixels (never over a wall or
another trail), where, being transparent, it mixes with whatever background is behind it.
It is erased together with the hard pixels next to it (one pixel around anything erased),
so nothing is left behind.

**Gaps stay open.** A free pixel with something (trail or wall) on two opposite sides of
it — left and right, above and below, or on two opposite corners — shows no smooth line,
whatever is stored for it: a gap one can drive through must look open. The rule is applied
when drawing, so the line comes back if one side is erased. The price: inside a corridor
one pixel wide the trails look hard, as in the original.

### Stored with the trails, as transparency

The smooth lines are data, not a drawing: per cell an opacity (0–255) and a colour
(`SmoothLines`, `src/game/display/SmoothLines.ts`; pure, no DOM). They are the translucent
part of the stored trails, next to the opaque part that is the collision bitmap.

- **Merging.** Along one trail (one colour) a cell keeps the most it was ever covered. The
  line of another colour is added as one translucent layer over another
  (`a + b − a·b`), and the cell takes the colour of the stronger of the two.
- **Who keeps them.** Every view, inside its display bitmap; and the **host**, next to the
  simulation (`SmoothLineKeeper` in `HostSession`, only when hosting a network game), fed
  from the very frames it sends. Both follow the players from frame to frame
  (`PathTracker`) and apply the same erasing events in the same order, with positions
  rounded as they travel on the wire (thousandths of a pixel) — so host and guests hold
  the same lines, bit for bit (tested against a real match and through a late join).
- **Joining late.** The snapshot of a game in progress carries them (`smoothLines`:
  a palette and runs of covered cells, two bytes per cell), so someone who joins or
  rejoins sees the trails as everybody else does.
- **Arena edges.** A stretch that goes through an edge is drawn as its two halves, one on
  each side. Other jumps (portal, swap: further than 8 px in a frame) draw nothing.

How it is fed: once per simulated frame while playing, the stretch each living player
moved since the frame before (`TronRenderer.addPaths` → `ArenaDisplay.addPath`). The line
is sampled four times per pixel; at each sample the 1×1 square centred on the point is
split among the up to four cells it overlaps.

Limits: a guest draws from the host's states, so its own player's smooth line (like its
hard trail) trails its predicted head by the network delay; where two players of
different colours run side by side the shared pixels can end a little more opaque than
one layer over another, because each frame's stretch is a layer of its own; if the
simulation worker dies mid-game the replacement host starts without the lines so far.

Tried before and dropped: selectable fringes of half, one and two pixels in dimmed colours
(two rounds), then a shade computed from the neighbouring pixels at two strengths — it
thickened the line instead of following the path.

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

New level:

| id | Name | Background | Walls |
|----|------|-----------|-------|
| `blueprint` | Blueprint | dark navy (`#0a1830`-ish) with a faint 50 px drafting grid | pale-blue floor-plan walls with door gaps |

A second one, **Paper** (cream squared paper, the deliberately hard case of a light
background), was tried and removed: bright trails have too little contrast on it (table
below) and item sprites looked pasted on. The `lightBackground` flag of a level, which
makes the heads' glow and the tracers dark, is still supported; no level uses it.

It is generated by `scripts/build-research-levels.ts` (`npm run levels:research`).
Start corners and the centre are kept clear like in the original maps.

What assumed black, and what was done:

| Assumption | Where | Now |
|------------|-------|-----|
| Level image is the picture | `levelCanvas.drawImage(image)` | level layer derived from cells; background separate |
| Erase = transparent over black fill | `clearRect` / `clearLine` | unchanged idea; the fill is the background image |
| Lit-pixel count in e2e | `network.e2e.mjs` | counts over the whole backing store whatever its scale; the test level is `blank` |
| White head / white tracer | `drawPlayerHead`, `drawProjectile` | on a `lightBackground` level the head's halo is dark (the pixel stays white) and tracers are black |
| Item sprites with a white box | sprite atlas | untouched; they would look pasted on a light level |
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
- In an arena snapshot (rejoin) lock-border pixels have the player's colour and are taken
  for trail until the next round.
- A head's glow is white whatever the player; two heads meeting are told apart by their
  trails only.
- Door sprites (Portals) have black recesses; fine there because that level is black.
- The derivation still supports things the game no longer uses (fringe bands around
  trails with a rule that keeps gaps open, a 2× backing store); they are covered by no
  test any more and can go.
