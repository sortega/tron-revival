# Display Layer: what you see is not what you hit

Research line `research/display-shading`. Screenshots and measurements:
[research/display-shading/](./research/display-shading/).

Related: [architecture.md](./architecture.md) (Rendering), [old-tron-design.md](./old-tron-design.md),
[level-hazards.md](./level-hazards.md).

## Problem

The arena is 750×600 logical pixels and trails are one pixel wide, as in the original. On a
phone the arena is about 390 CSS pixels tall, so a trail is 0.65 CSS px wide (1.3–2 device
pixels): hard to see, and the single white pixel of the head is harder still. The original
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
  because it only ever existed as a function of that trail. A unit test checks that after
  any sequence of adds and clears the picture equals the one derived from scratch.
- **Guests and rejoining guests get it for free**: the shade is derived from whatever cells
  they have, however they got them.
- **Switching the variant at run time** re-derives the whole picture from the same cells.

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

Mutations mark dirty rectangles (cell coordinates, grown by one cell so the neighbours'
shade is re-derived). Before compositing, each dirty rectangle is re-derived into a small
`ImageData` and written to both layers with `putImageData`. A normal tick dirties a 3×3
block per player; a bomb dirties one 122×122 block; a tracer line is processed in strips so
a long diagonal does not re-derive its whole bounding box. More than 48 rectangles in a
frame collapse into their bounding box.

### Display scale and "half a pixel"

The main canvas backing store is `800·S × 600·S` with a `scale(S, S)` transform, so the rest
of the renderer keeps drawing in logical coordinates. With `S = 2` one logical pixel is a
2×2 block and the fringe can be **one sub-pixel = half a logical pixel** wide: a trail
becomes a 2-sub-pixel core with a 1-sub-pixel fringe on each side — it reads as a line
twice as wide (4 sub-pixels = 2 logical pixels overall) whose core is exactly the
collision pixel. `S = 2` also matches phone screens better: 1200 backing pixels for ~1170
device pixels (390 CSS px at DPR 3) instead of 600 stretched 1.95×.

The fringe geometry is general in `S` and the fringe width `f` (sub-pixels, `f ≤ S`): a
sub-pixel of an empty cell is fringe if it is within `f` sub-pixels of a neighbouring trail
cell. Orthogonal neighbours win over diagonal ones when colours differ.

## Variants

Selectable at run time (see "Trying it"). All of them leave collisions alone.

| `shade=` | Scale | What is drawn around a trail |
|----------|-------|------------------------------|
| `off` | 1× | nothing — the classic picture, pixel-identical to before this work |
| `glow` | 1× | (a) a blurred, low-alpha copy of the trail layer underneath (`ctx.filter = blur`, re-blurred every frame; four offset copies where `filter` is missing, i.e. Safari) |
| `fringe` | 1× | (b) the 4 neighbours of each trail pixel in the player's colour at 40 % alpha — a full pixel of shade per side |
| `half` | 2× | (c) half-pixel fringe in the player's colour at 55 % alpha |
| `outline` | 2× | (d) half-pixel **dark** fringe (black, 75 % alpha) — invisible on black, a contrast edge on any other background |
| `auto` | 2× | half-pixel fringe in a darkened player colour (55 % of the colour, 90 % alpha): a dim halo on black *and* a dark edge on light backgrounds |
| `crisp` | 2× | no fringe; only the benefits of 2× (control for the comparison) |

Head marker (`head=`):

| `head=` | |
|---------|--|
| `glow` | the previous look: white pixel with a 10 px blurred glow (`shadowBlur`) |
| `ring` | white pixel with a **one-pixel shade around it**: the 8 neighbours in the player's colour (3×3) |
| `box` | `ring` plus a one-sub-pixel dark outline around the 3×3 block, for light backgrounds |
| `dot` | bare white pixel (control) |

Extras (`fx=` comma-separated; "same idea applied to other things"):

| `fx=` | |
|-------|--|
| `shadow` | walls cast a half-pixel drop shadow down-right (derived, level layer) |
| `tracer` | tracers (single white pixels) get a one-pixel dim halo, same shape as the head ring |
| `fade` | an erased rectangle flashes and fades over 12 frames instead of vanishing |
| `pattern` | the fringe of each slot has a different rhythm (solid, dashed, dotted, long-dash) so trails can be told apart without colour |

## Levels with a background

`LevelDefinition` gains an optional `backgroundFile`: an image drawn under everything and
**never read for collisions**. Walls still come from `imageFile` (non-black = wall), whose
black pixels are now transparent on screen (the level layer is derived from the cells, not
blitted from the image). Erasing works by clearing cells, so the background shows through
a blown-up wall — nothing is "painted black" any more.

New levels:

| id | Name | Background | Walls |
|----|------|-----------|-------|
| `blueprint` | Blueprint | dark navy (`#0a1830`-ish) with a faint 50 px drafting grid | pale-blue floor-plan walls with door gaps |
| `paper` | Paper | cream squared paper (`#d8d2bc`-ish) — the deliberately hard case | ink-blue scribbled boxes |

They are generated by `scripts/build-research-levels.ts` (`npm run levels:research`).
Start corners and the centre are kept clear like in the original maps.

What assumed black, and what was done:

| Assumption | Where | Now |
|------------|-------|-----|
| Level image is the picture | `levelCanvas.drawImage(image)` | level layer derived from cells; background separate |
| Erase = transparent over black fill | `clearRect` / `clearLine` | unchanged idea; the fill is the background image |
| Lit-pixel count in e2e | `network.e2e.mjs` | counts over the whole backing store whatever its scale; the test level is `blank` |
| White head / white tracer | `drawPlayerHead`, `drawProjectile` | `ring`/`box` head and `tracer` fx carry their own contrast |
| Door sprites have black recesses | `doors.png` | only on `portals`, whose background is black; left as is |
| Countdown / summary overlays | 50 % black veil | fine on any background |
| White flash, side panel | opaque | unaffected |

Contrast numbers are in the results section.

## Trying it

- URL parameters, on any game URL: `?shade=half&head=ring&fx=shadow,tracer`. They are also
  remembered in `localStorage` (`teratron-display`), so a phone keeps the choice.
- Keys during a game: **G** cycles the shade variant, **H** the head marker, **J** toggles
  all extras; the name of the new setting is shown for a second in the corner.
- `window.__teratron.display(spec)` and `window.__teratron.perf()` (ms per `draw()`) for
  scripts.

## Results

See the end of this document (filled in from the measurements and screenshots).
