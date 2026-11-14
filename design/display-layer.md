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
  because it only ever existed as a function of that trail. Tests (`tests/display.test.ts`)
  check that after any sequence of adds and clears the picture equals the one derived from
  scratch, and that fed with the frame events of a real 90-second bot match (weapons,
  rounds, erasers) the display bitmap equals the collision bitmap cell for cell.
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
a long diagonal does not re-derive its whole bounding box. More than 256 rectangles in a
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

Selectable at run time (see "Trying it"). All of them leave collisions alone. The default
is `shade=auto&head=ring&fx=tracer`; `shade=off&head=glow&fx=` is the picture as it was
(`CLASSIC_DISPLAY` in `src/game/display/settings.ts`).

A 2× backing store shown on fewer device pixels than it has (a desktop window on a DPR 1
monitor: 765 CSS px for 1200 backing pixels) is scaled down by the browser with smoothing
(`image-rendering: auto`); nearest-neighbour would drop sub-pixels at random. Shown at
≥ 0.9 device pixels per backing pixel it stays `pixelated`, as the 1× picture always is.

| `shade=` | Scale | What is drawn around a trail |
|----------|-------|------------------------------|
| `off` | 1× | nothing — the classic picture, pixel-identical to before this work |
| `glow` | 1× | (a) a blurred, low-alpha copy of the trail layer underneath (`ctx.filter = blur`, re-blurred every frame; four offset copies where `filter` is missing, i.e. Safari) |
| `fringe` | 1× | (b) the 4 neighbours of each trail pixel in the player's colour at 40 % alpha — a full pixel of shade per side |
| `half` | 2× | (c) half-pixel fringe in the player's colour at 55 % alpha |
| `outline` | 2× | (d) half-pixel **dark** fringe (black, 75 % alpha) — invisible on black, a contrast edge on any other background |
| `auto` | 2× | **default.** Half-pixel fringe in a darkened player colour (55 % of the colour, 90 % alpha) — a dim halo; on a level marked `lightBackground` it becomes the dark edge of `outline` |
| `crisp` | 2× | no fringe; only the benefits of 2× (control for the comparison) |

Head marker (`head=`):

| `head=` | |
|---------|--|
| `glow` | the previous look: white pixel with a 10 px blurred glow (`shadowBlur`) |
| `ring` | **default.** White pixel with a **one-pixel shade around it**: the 8 neighbours in the player's colour (3×3). On a `lightBackground` level it gets the dark edge of `box` (at 1×, where there is no sub-pixel for a thin edge: a dark 3×3 with the centre in the player's colour) |
| `box` | `ring` plus a one-sub-pixel dark outline around the 3×3 block (a full pixel at 1×: heavy) |
| `dot` | bare white pixel (control) |

Extras (`fx=` comma-separated; "same idea applied to other things"):

| `fx=` | |
|-------|--|
| `shadow` | walls cast a half-pixel drop shadow down-right (derived, level layer) |
| `tracer` | **default.** Tracers (single white pixels) get a one-pixel halo: dim white, dark on a `lightBackground` level |
| `fade` | an erased rectangle flashes and fades over 12 frames instead of vanishing |
| `pattern` | the fringe of each slot has a different rhythm (solid, dashed, dotted, long-dash) so trails can be told apart without colour |

## Levels with a background

`LevelDefinition` gains an optional `backgroundFile`: an image drawn under everything and
**never read for collisions** (plus `lightBackground: true` when shade and markers need a
dark edge to show on it). Walls still come from `imageFile` (non-black = wall), whose
black pixels are now transparent on screen (the level layer is derived from the cells, not
blitted from the image). Erasing works by clearing cells, so the background shows through
a blown-up wall — nothing is "painted black" any more.

New levels:

| id | Name | Background | Walls |
|----|------|-----------|-------|
| `blueprint` | Blueprint | dark navy (`#0a1830`-ish) with a faint 50 px drafting grid | pale-blue floor-plan walls with door gaps |
| `paper` | Paper | cream squared paper (`#d9d3bd`), `lightBackground` — the deliberately hard case | ink-blue rings with an opening, and a rule |

They are generated by `scripts/build-research-levels.ts` (`npm run levels:research`).
Start corners and the centre are kept clear like in the original maps.

What assumed black, and what was done:

| Assumption | Where | Now |
|------------|-------|-----|
| Level image is the picture | `levelCanvas.drawImage(image)` | level layer derived from cells; background separate |
| Erase = transparent over black fill | `clearRect` / `clearLine` | unchanged idea; the fill is the background image |
| Lit-pixel count in e2e | `network.e2e.mjs` | counts over the whole backing store whatever its scale; the test level is `blank` |
| White head / white tracer | `drawPlayerHead`, `drawProjectile` | on a `lightBackground` level the `ring` head and the `tracer` halo are dark-edged |
| Item sprites with a white box | sprite atlas | untouched; they look pasted on Paper (cosmetic) |
| Door sprites have black recesses | `doors.png` | only on `portals`, whose background is black; left as is |
| Countdown / summary overlays | 50 % black veil | fine on any background |
| White flash, side panel | opaque | unaffected |

Contrast numbers are in the results section.

## Trying it

- URL parameters, on any game URL: `?shade=half&head=ring&fx=shadow,tracer` (`fx=` for
  none, `fx=all` for all). A choice made with the keys is remembered in `localStorage`
  (`teratron-display`); the URL wins over it.
- Keys during a game: **1** cycles the shade variant, **2** the head marker, **3** toggles
  all extras; the new setting is shown for a second in the top-right corner. Switching
  re-derives the picture in place, mid-round.
- `window.__teratronDisplay` for scripts: `set(spec)`, `get()`, `perf()` (ms per
  `render()`), `sync(true)` (make `render()` wait for rasterisation), `rederive()`,
  `testCard(x, y)`, `layers()`.
- `node tools/display-lab.mjs shots | perf | perf-sw | identity` regenerates everything in
  [research/display-shading/](./research/display-shading/).

## Results

Measured and photographed in headless Chrome (macOS) with `tools/display-lab.mjs`; **not
yet seen on a real phone**.

### What it looks like

Comparison sheets (`sheet-<what>-<level>-<device>.png`) show a fixed test card — the four
colours, two trails one pixel apart, a crossing, a hole erased through them, four heads and
two tracers — next to a wall, on `bricks` (black), `blueprint` and `paper`, on three
"devices": `desktop` (765 CSS px tall, DPR 1), `retina` (same, DPR 2) and `phone` (390 CSS
px tall, DPR 3). `full-<level>-<device>-<shade>.jpg` are whole screens of a live game.

- **`off`** on the phone: trails are 2 device pixels wide where the 1.95× scale rounds up
  and 1 where it rounds down, so the same trail changes thickness along its length. Blue on
  navy and anything bright on Paper is hard to find.
- **`glow`** (a): the least retro of the lot (soft neon), smears into neighbouring trails so
  two trails one pixel apart read as one band, and it is by far the most expensive. Out.
- **`fringe`** (b, 1×): triples the apparent width (3 logical px). Very visible, but two
  parallel trails with a free pixel between them look fused although you can drive between
  them: the shade hides a gap that the rules say is there. Usable only as the fallback for
  devices that cannot afford 2×.
- **`half`** (c): the owner's "half-pixel shade". Core exactly on the collision pixel,
  apparent width 2 logical px, a one-pixel gap between trails stays visibly open (it is
  shaded from both sides but darker than a trail). On black it is good; on Paper the
  translucent fringe adds nothing (green on cream stays 1.1 : 1).
- **`outline`** (d): nothing on black by construction; on Paper it is what makes yellow
  and green readable at all.
- **`auto`**: `half` with a more solid, darker fringe on dark backgrounds — reads as "the
  same Teratron, drawn with a slightly bolder pen" — and `outline` on a light level. The
  only variant that is right on all three levels.
- **`crisp`** (2×, no fringe): on the phone already evens out the trail thickness; shows that
  part of the gain is resolution alone; the shade adds the width.
- On a DPR 1 desktop the 2× variants are smoothed down by the browser: the shade becomes
  an anti-aliased edge, bricks and sprites get slightly soft. Acceptable, but this is the
  screen that needed help least.
- **Head**: the old glow is practically invisible at phone size (a white pixel with a faint
  halo) and costs a blur per head. `ring` — the owner's "one pixel shade around the head" —
  is a solid 3×3 dot in the player's colour with a white centre: unmistakable, cheaper, and
  it says whose head it is. `box` is too heavy on black; its edge is used only on light
  levels.

### Contrast

WCAG contrast ratio of a trail's colour against the background (1 = invisible, 21 = white
on black; 3 is the usual minimum for graphics):

| Colour | black | Blueprint centre `#0a1a34` | Blueprint grid line `#142c52` | Paper `#d9d3bd` | Paper line `#bac6cd` |
|---|---:|---:|---:|---:|---:|
| red `#ff4444` | 6.2 | 5.1 | 4.1 | 2.3 | 2.0 |
| green `#44ff44` | 15.6 | 12.9 | 10.3 | **1.1** | 1.3 |
| blue `#4444ff` | 3.5 | 2.9 | **2.3** | 4.0 | 3.4 |
| yellow `#ffff44` | 19.6 | 16.2 | 13.0 | **1.4** | 1.6 |
| team purple `#aa00aa` | 3.3 | 2.7 | **2.2** | 4.3 | 3.7 |
| team brown `#aa6600` | 4.6 | 3.8 | 3.0 | 3.0 | 2.6 |
| white (head, tracer) | 21.0 | 17.4 | 13.9 | **1.5** | 1.7 |

- Blueprint costs every colour about 20 % of its contrast; blue and team purple, already
  the weakest on black (3.5 and 3.3), drop under 3. They stay findable because of the
  shade's extra width, not because of its colour (the dim fringe of blue is 1.4 : 1
  against navy). **If dark-blue backgrounds become a thing, the blue player colour should
  be lightened** (e.g. `#6a6aff`: 4.2 : 1 on the Blueprint centre, 5.1 on black); that is a palette
  decision, left alone here.
- Paper is unplayable without a dark edge: green 1.1, yellow 1.4, the white head 1.5. With
  the `outline`/`auto` edge (black at 75 % over the paper: 8.2 : 1 against the paper;
  against the core it surrounds 11.5 for yellow, 9.2 green, 3.6 red, 2.1 blue) every
  trail is found by its edge and identified by its core — blue and red, the two that were
  readable on paper anyway, are the ones whose core stands out least from the edge. Walls: ink `#1e2a6e` on paper 8.7, pale blue `#96bee6` on Blueprint 8.9.

### Cost

Four local players on `bricks` and `blueprint`, 8 s each, 60 Hz. Two things are measured
because Canvas 2D defers the real work: with a GPU canvas `render()` only records commands
(the JS time is what the main thread pays; rasterisation happens on the GPU, which Chrome's
CPU throttle does not slow down), so the same runs were repeated with Canvas 2D rasterised
on the CPU and `render()` made to wait for it — the worst case, a phone without canvas
acceleration. "Phone ×6" is the 844×390 DPR 3 viewport with CDP CPU throttling ×6.
Average ms per frame (p95 in brackets):

| Settings | GPU canvas, desktop | GPU canvas, phone ×6 | Software canvas, desktop | Software canvas, phone ×6 | Frames > 25 ms (software, phone ×6) | Full re-derive, desktop / phone ×6 |
|---|---:|---:|---:|---:|---:|---:|
| `off` / ring | 0.16 (0.5) | 0.28 (1.1) | 0.58 (1.4) | 2.9 (3.9) | 0.0 % | 8 / 36 ms |
| `glow` / ring | 0.23 (0.7) | 0.42 (1.4) | 3.98 (5.5) | **20.6 (22.8)** | **34.8 %** | 7 / 36 ms |
| `fringe` / ring | 0.18 (0.6) | 0.38 (1.4) | 0.85 (2.8) | 2.9 (4.0) | 0.0 % | 6 / 37 ms |
| `half` / ring | 0.17 (0.5) | 0.40 (1.5) | 2.41 (4.1) | 10.6 (12.1) | 0.0 % | 10 / 55 ms |
| `outline` / ring | 0.20 (0.6) | 0.41 (1.5) | 2.16 (2.8) | 11.4 (14.0) | 0.2 % | 9 / 53 ms |
| `auto` / ring | 0.09 (0.2) | 0.51 (1.6) | 1.95 (2.4) | 11.6 (16.6) | 1.1 % | 9 / 56 ms |
| `crisp` / ring | 0.16 (0.6) | 0.42 (1.5) | 1.98 (2.2) | 11.0 (12.9) | 0.2 % | 9 / 51 ms |
| `off` / glow head (the old picture) | 0.15 (0.5) | 0.28 (1.3) | 0.57 (0.7) | 4.6 (9.8) | 0.1 % | 6 / 35 ms |
| `auto` / ring / all four extras | 0.09 (0.2) | 0.29 (1.3) | 1.91 (2.2) | 11.2 (13.1) | 0.4 % | 8 / 54 ms |

Raw numbers: `perf.json` (GPU canvas) and `perf-sw.json`. Reading them:

- **The shade itself is free.** Deriving and uploading the dirty cells is lost in the
  noise: `fringe` costs the same as `off`, `half`/`outline`/`auto` the same as `crisp`.
  A tick re-derives at most 16 cells per player.
- **What costs is resolution.** 2× means four times the pixels in the three full-arena
  blits (background, level layer, trail layer): on a GPU canvas nothing measurable, on a
  software canvas 2.9 → 11 ms per frame at ×6 throttle. That fits a 16.7 ms frame, but it
  is two thirds of it before the simulation and three bots run. This is the risk of
  making a 2× variant the default.
- `glow` re-blurs the whole trail layer every frame: 20 ms and a third of the frames lost
  in the worst case. Rejected on cost as well as looks.
- The old head glow (`shadowBlur`) costs 1.7 ms per frame for four heads in the worst
  case; `ring` is four `fillRect`s.
- **Full re-derive** (round start, Eraser, switching variant) rebuilds both layers from
  the cells: 6–10 ms on a desktop, 35 ms (1×) to 55 ms (2×) at ×6 throttle. At round start
  it hides in the countdown; an Eraser mid-round is a 2–3 frame hitch on a slow phone,
  where the old code did one `drawImage`. Fixable (keep a pre-derived copy of the pristine
  level layer and blit it) if it shows on a real device.
- The measurements of the GPU-canvas columns were taken one commit before the background
  image was cached at display scale; that only affects levels with a background and only
  the software columns, which were measured after.

### Extras: which are worth it

| Extra | Verdict |
|-------|---------|
| `tracer` | **Keep, on by default.** A tracer was one white pixel — invisible on a phone, and invisible on Paper. The halo makes Uzi/rifle fire readable for nothing. |
| `shadow` | Cheap and correct (derived, erased with the wall), but it does nothing on black and on Blueprint; on Paper it gives walls a little weight. Cosmetic; off by default. Worth revisiting if more levels get backgrounds. |
| `fade` | Implemented (erased rectangles flash white and fade over 12 frames) but **not judged**: it only exists in motion, the stills do not show it and nobody has watched it yet. Its cost is in the "all four extras" row. Off by default; the owner should look at it with a bomb or the Uzi. |
| `pattern` | **Drop.** A different rhythm per slot in a half-pixel fringe is far too subtle to tell players apart, and in the full-pixel `fringe` it just looks noisy. Telling trails apart without colour needs a different idea (the head `ring` already helps: it is where you look). |

### Recommendation

Default **`shade=auto`, `head=ring`, `fx=tracer`** (this is what the branch does;
`DEFAULT_DISPLAY` in `src/game/display/settings.ts`). It is the owner's request taken
literally — half a pixel of shade around the trail, one pixel around the head, neither of
them an obstacle — it is the only variant that works on black, on a dark background and
on a light one, it keeps the picture recognisably Teratron (hard pixels, no blur), and on
an accelerated canvas it costs nothing.

Before merging it as the default it needs **ten minutes on a real phone**: F / double-tap
shows the frame rate; if a mid-range phone cannot hold 60 fps at 2×, make `fringe` (or
`off`) the default on touch devices and keep `auto` for the rest — or pick the scale from
a short frame-time probe at game start. Merging with `CLASSIC_DISPLAY` as the default is
the zero-risk alternative: the display layer, the backgrounds and the switches come along
and nothing changes on screen until the constant is flipped (Paper is then only playable
with `?shade=auto` or `outline`).

Merge: the display layer (`src/game/display/`), the renderer change, `backgroundFile` /
`lightBackground`, Blueprint. Decide after seeing them: Paper (a light level is a taste
question; it is also where item sprites look pasted on), `fade`, `shadow`. Leave out:
`glow`, `pattern`, and once a default is chosen the losing variants and the 1/2/3 keys.

### Known limits

- Not tested on real hardware or in Safari/Firefox (the `glow` variant has a fallback for
  Safari's missing `ctx.filter`; everything else is plain `putImageData` / `drawImage`).
- A guest's provisional (predicted) trail pixels are drawn every frame with the same
  fringe, but as plain rectangles: for the few ticks until the host confirms them the
  fringe is not clipped by a neighbouring wall or trail.
- In an arena snapshot (rejoin) lock-border pixels have the player's colour and are taken
  for trail: they get a fringe and follow the Colour Blindness tint until the next round.
- The fringe does not wrap around the arena edges (a trail on column 0 has no shade on
  column 749).
- The shade makes a trail *look* wider than it is; with `half`/`auto` the overhang is half
  a pixel per side, so what looks like a near miss is a miss. With `fringe` it is a full
  pixel, which is why it is not recommended.
- Door sprites (Portals) have black recesses; fine there because that level is black.
- Memory: at 2× the two layers, the tint scratch and the main canvas are 1500–1600 × 1200
  each (about 7 MB apiece as RGBA).
