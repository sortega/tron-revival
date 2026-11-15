# Display Layer: what you see is not what you hit

Research line `research/display-shading`. Screenshots and measurements:
[research/display-shading/](./research/display-shading/).

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

Mutations mark dirty rectangles (cell coordinates, grown by as many cells as a change can
reach: twice the fringe, because of the gap rule below). Before compositing, each dirty rectangle is re-derived into a small
`ImageData` and written to both layers with `putImageData`. A normal tick dirties a
block of a few cells per player (at most 36 with `bold`, 100 with `wide`); a bomb dirties one 122×122 block; a tracer line is processed in strips so
a long diagonal does not re-derive its whole bounding box. More than 256 rectangles in a
frame collapse into their bounding box.

### Display scale

The main canvas backing store is `800·S × 600·S` with a `scale(S, S)` transform, so the rest
of the renderer keeps drawing in logical coordinates. Only `thin` uses `S = 2` (its fringe
is half a logical pixel, which needs sub-pixels); everything else is `S = 1`, the same
backing store the game always had, scaled up by the browser without smoothing.

The fringe is described by **bands** from the trail outwards — width in sub-pixels, how
much of the trail's colour, how opaque — and a sub-pixel of an empty cell gets the band its
distance to the nearest trail cell falls in (Chebyshev distance, so corners are square;
orthogonal neighbours win over diagonal ones when colours differ).

### Gaps stay open

The shade makes a trail look wider than the obstacle it is, so it must never make a gap
you can drive through look closed. Rule, part of the derivation: **a free cell with trail
on both sides of it — left and right, or above and below — no further apart than two
fringes gets no shade at all.** Two trails with one free pixel between them are drawn as
two lines with a clean, unshaded pixel between them (and shade on their outer sides only);
whatever the distance between two trails, at least one cell of the gap is exactly as it
would be without shade. Tested for gaps of 1 to 6 pixels, both directions, every variant.

## Why the first round of variants made no difference on a phone

The owner tried the first seven variants on an iPhone and could not tell the trail options
apart. The numbers say why:

- iPhone in landscape: the arena is about 390 CSS px tall for 600 logical px, at DPR 3.
  **One logical pixel = 0.65 CSS px = 1.95 device pixels = 0.108 mm** (460 ppi). At 30 cm
  that is 1.2 minutes of arc — right at the limit of what an eye resolves.
- The recommended variant (`auto`, also `half`/`outline`) added **half a logical pixel** of
  fringe per side: **one device pixel, 0.054 mm, 0.6 minutes of arc** — below what the eye
  resolves — in a colour with about a quarter of the trail's luminance. All it can do is
  add ~24 % to the light coming from the line. It was designed on test cards enlarged 6×,
  where half a pixel is a clearly visible border; at the size it really has it is nothing.
- The 2× backing store (1200 px) was then squeezed into 1170 device pixels without
  smoothing, which drops one row in forty: here and there the one-pixel fringe was not
  even drawn.
- Three of the seven (`half`, `outline`, `auto`) differed only in the colour of that one
  device pixel, `crisp` had none, and `outline` is black on black. Only `fringe` and
  `glow` changed anything measurable, and nothing on the phone said which one was showing
  (the switches were keyboard keys).

**Does any variant draw the one-pixel line itself with shading?** No, neither then nor
now. In every variant the collision pixel is drawn as a hard, fully opaque block of the
player's colour, exactly where the obstacle is, and whatever is added goes *beside* it.
None renders the line with partial coverage (anti-aliasing), and none spreads a pixel's
light over its neighbours instead of keeping it solid. (The nearest thing to it is an
accident: on a DPR 1 desktop the browser smooths the 2× picture of `thin` down, which
blurs the core a little.) That is deliberate — the solid core is the only part of the
picture that says where you crash — but it also means visibility has to come from the
width and brightness of what surrounds the core, and half a pixel of dim colour is not
enough of either.

What it takes, in device pixels on that phone (luminance relative to the core's own):

| | Shade per side | Line width | Light from the line |
|---|---|---|---|
| `off` | — | 1.95 device px · 0.11 mm · 1.2′ | 100 % |
| `thin` (the old `auto`) | 0.98 px at 24 % | 3.9 px · 0.21 mm · 2.4′ | 124 % |
| `bold` | 1.95 px at 43 % | 5.9 px · 0.32 mm · 3.7′ | 186 % |
| `wide` | 1.95 px at 43 % + 1.95 px at 19 % | 9.8 px · 0.54 mm · 6.2′ | 224 % |

`phone-whole-<level>.png` shows the four at the size they have in the hand: `off` and
`thin` cannot be told apart, `bold` and `wide` can from each other and from `off`.

## Variants

Selectable at run time (see "Trying it"). All of them leave collisions alone.

Trail shade, `shade=`:

| | Layers | Around a trail |
|---|---|---|
| `off` | 1× | nothing: the collision pixels (and no `boost`) — the picture as it always was |
| `thin` | 2× | half a logical pixel per side, 55 % of the trail's colour. Subtle; for screens where a logical pixel is big |
| `bold` | 1× | **one logical pixel per side**, 70 % of the colour: the trail reads three pixels wide with a bright core |
| `wide` | 1× | two logical pixels per side, the second fainter: five pixels wide, a glow |
| `auto` | | **default**: `bold` when a logical pixel is smaller than one CSS pixel (phones, small windows), `thin` otherwise |

On a level marked `lightBackground` the shade is dark instead: 40 % of the trail's colour,
opaque (black for `thin`, whose fringe is too thin to carry a hue).

Head, `head=`. The head is always **a solid white pixel — the logical pixel the player is
on — with a white, transparent halo around it** (the owner's specification). The halo is
never an obstacle; it is drawn with a few `fillRect`s, no `shadowBlur`. The variants only
differ in how far the halo reaches:

| | Halo |
|---|---|
| `ring` | one pixel around the head (3×3) at 50 % white |
| `soft` | two pixels, fading: 55 % next to the head, 22 % outside (corners cut) |
| `wide` | three pixels, fading: 60 %, 33 %, 12 % |
| `auto` | **default**: `soft` when a logical pixel is smaller than one CSS pixel, `ring` otherwise |

On a `lightBackground` level white on cream is 1.5 : 1, so there **the halo is dark**
(the same shapes in black, half as strong again) and the white pixel sits in the middle of
it: the same head, inverted halo. `phone-heads-paper.png` shows it.

The colour of a head is no longer shown at the head itself; it is the colour of the trail
it is drawing.

Extras, `fx=` (comma-separated, `fx=` for none, `fx=all`):

| | |
|---|---|
| `tracer` | **default.** A tracer is a white pixel; this adds a three-pixel fading streak behind it, so it is seen and is not taken for a head (which has a halo all around). Black on a light level |
| `boost` | **default.** Blue and team purple, the two colours with luminance under 0.15, are drawn 30 % lighter (`#4444ff` → `#7c7cff`, `#aa00aa` → `#c44dc4`). Display only; not on light levels, where lighter is worse; not with `shade=off` |
| `shadow` | walls cast a small shadow down-right |
| `fade` | an erased rectangle flashes and fades over 12 frames |

`auto` follows the screen: it is re-evaluated when the window is resized or the phone is
turned.

A 2× backing store shown on fewer device pixels than it has (a desktop window on a DPR 1
monitor: 765 CSS px for 1200 backing pixels) is scaled down by the browser with smoothing
(`image-rendering: auto`); nearest-neighbour would drop sub-pixels at random. Shown at
≥ 0.9 device pixels per backing pixel it stays `pixelated`, as the 1× picture always is.

## Levels with a background

`LevelDefinition` gains an optional `backgroundFile`: an image drawn under everything and
**never read for collisions** (plus `lightBackground: true` when shade and markers need a
dark edge to show on it). Walls still come from `imageFile` (non-black = wall; decoded from the PNG file, never
read back from a canvas — see architecture.md, Levels), whose
black pixels are now transparent on screen (the level layer is derived from the cells, not
blitted from the image). Erasing works by clearing cells, so the background shows through
a blown-up wall — nothing is "painted black" any more.

New levels:

| id | Name | Background | Walls |
|----|------|-----------|-------|
| `blueprint` | Blueprint | dark navy (`#0a1830`-ish) with a faint 50 px drafting grid | pale-blue floor-plan walls with door gaps |
| `paper` | Paper | cream squared paper (`#d9d3bd`), `lightBackground` — the deliberately hard case: there shade, halo and tracers are dark | ink-blue rings with an opening, and a rule |

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

Contrast numbers are in the results section.

## Trying it

- URL parameters, on any game URL: `?shade=bold&head=soft&fx=tracer,boost` (`fx=` for
  none, `fx=all` for all). The URL wins over a remembered choice.
- **`?displaydebug=1`** puts three chips at the right edge of the screen, outside the arena
  on a phone: *trail*, *head*, *fx*. Tapping one cycles it; the chip says what is showing
  (`auto→bold` = `auto`, which on this screen is `bold`). The choice is remembered in
  `localStorage` (`teratron-display`) for later visits without the parameter.
- Keys during a game: **1** cycles the trail shade, **2** the head halo, **3** the extras;
  the new setting is shown for a second in the top-right corner of the arena.
- `window.__teratronDisplay` for scripts: `set(spec)`, `get()`, `perf()` (ms per
  `render()`), `sync(true)` (make `render()` wait for rasterisation), `rederive()`,
  `testCard(x, y)`, `layers()`.
- `node tools/display-lab.mjs shots | perf | perf-sw | check | identity` regenerates
  everything in [research/display-shading/](./research/display-shading/).

Candidates to compare (append to the game URL):

| What | Query |
|---|---|
| Recommended default (phone: bold + soft; desktop: thin + ring) | `?displaydebug=1` |
| No shade (before) | `?displaydebug=1&shade=off` |
| Thin | `?displaydebug=1&shade=thin` |
| Bold | `?displaydebug=1&shade=bold` |
| Wide | `?displaydebug=1&shade=wide` |
| Bold, smallest halo | `?displaydebug=1&shade=bold&head=ring` |
| Bold, biggest halo | `?displaydebug=1&shade=bold&head=wide` |
| Bold without the lighter blue / purple | `?displaydebug=1&shade=bold&fx=tracer` |

## Results

Measured and photographed in headless Chrome (macOS) with `tools/display-lab.mjs`. The
first round was tried by the owner on an iPhone; **this second round has not been on a
real phone yet.**

### Pictures

All in [research/display-shading/](./research/display-shading/). The phone is an 844×390
viewport at DPR 3 (an iPhone in landscape; Safari's own bars make the real arena a little
smaller still).

| File | What it shows |
|---|---|
| `phone-whole-<level>.png` | **Start here.** The whole phone screen for `off`, `thin`, `bold`, `wide`, reduced so that at 100 % on a ~110 ppi monitor it is the size it has in the hand |
| `phone-device-pixels-<level>.png` | The test card, one picture pixel per device pixel (nothing enlarged), and the same enlarged 4× |
| `phone-gaps-<level>.png` | Pairs of trails 1, 2 and 3 free pixels apart, per variant: the gap rule |
| `phone-heads-<level>.png` | `head=ring`, `soft`, `wide`, with the tracers' streak |
| `phone-fx-<level>.png` | Extras: `boost` (blue, purple), `tracer`, `shadow` |
| `desktop-<level>.png`, `retina-<level>.png` | The same card at 1.27 and 2.55 device px per logical px |
| `phone-portals-default-with-chips.png` | A whole phone screen with the `?displaydebug=1` chips |

`<level>` is `bricks` (black), `blueprint` (dark navy) or `paper` (light).

What they show:

- **At physical size `off` and `thin` are the same picture.** This is what the owner saw.
- **`bold` is the first step that is plainly different**: every trail is visibly heavier,
  and the blue and purple ones, which in `off` are the first to get lost, are found at a
  glance (that is `boost` as much as the shade).
- **`wide` is heavier again** and starts to look like a glow rather than a line; where
  several trails run together it becomes a coloured mass. It is the upper bound, not a
  recommendation.
- **Gaps**: with the gap rule a one-pixel and a two-pixel gap are a clean dark line
  between two shaded trails in every variant; without it (the first attempt at `bold`)
  the shade filled them and two trails one pixel apart read as one thick band. What
  remains true: a gap of one logical pixel is 0.11 mm on that phone, shade or no shade —
  it can be seen that the trails are two, not whether a head fits between them.
- **Heads**: the white pixel with `ring` is small on a phone (the whole thing is 6 device
  pixels, 0.3 mm); `soft` (10 px, 0.5 mm) is the first that stands out from a tangle of trails in the pictures;
  `wide` (14 px, 0.8 mm) is unmistakable and starts to hide what is next to the head.
- **Paper**: the dark halo with the white pixel in it reads well; a white halo there is
  invisible. Trails need `bold` (dark edge in the trail's own hue): `thin`'s black
  half-pixel is, again, one device pixel.
- **Desktop**: at 1.27 device px per logical px (DPR 1) `thin` is smoothed by the browser
  into a soft edge; `bold` is crisp and clearly heavier than a desktop needs. At 2.55
  (retina) `thin` is a clean hairline border.

### Contrast

WCAG contrast ratio against the background (1 = invisible, 21 = white on black; 3 is the
usual minimum for graphics):

| Trail colour | black | Blueprint `#0a1a34` | Paper `#d9d3bd` | Paper, `bold` edge (40 % of the colour) |
|---|---:|---:|---:|---:|
| red `#ff4444` | 6.2 | 5.1 | 2.3 | 8.1 |
| green `#44ff44` | 15.6 | 12.9 | **1.1** | 4.7 |
| blue `#4444ff` | **3.5** | **2.9** | 4.0 | 10.0 |
| blue with `boost` `#7c7cff` | 6.2 | 5.1 | — | — |
| yellow `#ffff44` | 19.6 | 16.2 | **1.4** | 4.0 |
| team purple `#aa00aa` | **3.3** | **2.7** | 4.3 | 10.5 |
| purple with `boost` `#c44dc4` | 5.2 | 4.3 | — | — |
| team brown `#aa6600` | 4.6 | 3.8 | 3.0 | 9.0 |
| white (head, tracer) | 21.0 | 17.4 | **1.5** | white pixel on its dark halo 12; the halo on the paper 8 |

`boost` brings blue level with red and purple close to brown; nothing is under 4 on black
or under 3.8 on Blueprint any more. The panel in the sidebar and the names in the round
summary keep the original colours.

### Cost

Four local players on `bricks` and `blueprint`, 8 s each, 60 Hz; average ms per frame in
`render()` (p95 in brackets). With a GPU canvas `render()` only records commands, so the
runs were repeated with Canvas 2D rasterised on the CPU and `render()` made to wait for it:
the worst case, a phone without canvas acceleration. "Phone ×6" is the 844×390 DPR 3
viewport with CDP CPU throttling ×6.

| Settings (shade / head / fx) | GPU canvas, desktop | GPU canvas, phone ×6 | Software canvas, desktop | Software canvas, phone ×6 | Frames > 25 ms (GPU / software, phone ×6) |
|---|---:|---:|---:|---:|---:|
| `off` / ring | 0.23 (0.5) | 0.15 (1.1) | 1.12 (2.7) | 2.66 (3.8) | 0.0 % / 0.1 % |
| `thin` / ring | 0.31 (0.7) | 0.20 (0.9) | 2.26 (2.7) | **10.53 (12.6)** | 0.0 % / 0.0 % |
| `bold` / ring | 0.28 (0.7) | 0.23 (1.0) | 1.12 (2.7) | 2.96 (4.1) | 0.1 % / 0.2 % |
| `wide` / ring | 0.40 (1.0) | 0.57 (1.8) | 1.23 (2.8) | 3.26 (4.5) | 0.2 % / 0.0 % |
| `bold` / soft | 0.27 (0.6) | 0.22 (1.0) | 1.10 (2.5) | 2.86 (3.9) | 0.0 % / 0.1 % |
| `bold` / wide | 0.26 (0.6) | 0.24 (1.1) | 1.13 (3.0) | 2.98 (3.8) | 0.1 % / 0.0 % |
| `bold` / soft / tracer, boost (the phone default) | 0.28 (0.6) | 0.19 (0.9) | 1.11 (2.8) | 3.02 (4.0) | 0.0 % / 0.1 % |
| `wide` / wide / all four extras | 0.44 (1.0) | 0.55 (1.6) | 1.21 (3.0) | 3.37 (4.6) | 0.0 % / 0.0 % |

Raw numbers: `perf.json` (GPU canvas) and `perf-sw.json`.

- **`bold` costs what `off` costs** (3.0 against 2.7 ms in the worst case; the same within
  noise on a GPU canvas). It is a 1× picture: the same backing store and the same three
  blits as the game always had, plus deriving a few more cells per tick.
- **`thin` is the expensive one** — 2× layers are four times the pixels: 10.5 ms of a
  16.7 ms frame in the software worst case. `auto` only picks it where a logical pixel is
  at least one CSS pixel, which in practice means desktops and tablets, not phones.
- `wide` derives a bigger neighbourhood (0.3 ms more on the throttled main thread).
- The halo is a handful of `fillRect`s per head whatever its size. The old `shadowBlur`
  glow (1.7 ms for four heads in the worst case) is gone.
- **Full re-derive** (switching variant, a rejoin snapshot, rotating the phone under
  `auto`) with trails on screen: 5–9 ms on a desktop; 30 ms (`off`), 34 ms (`bold`), 40 ms
  (`wide`), 51 ms (`thin`) at ×6 throttle. A new round or an Eraser re-derives an arena
  without trails, which is cheaper still. (The `rederive` field in the JSON files was
  measured before the search was restricted to cells near a trail and is several times
  higher; these are from `display-lab.mjs check`.)

### Device-resolution rendering: looked at, not built

Sizing the backing store to the device (CSS size × DPR) so that the fringe can be measured
in device pixels was considered and left out:

- What it buys is choosing the fringe width for the screen. `auto` already does that, in
  logical pixels, and on the phone one logical pixel *is* the natural step (1.95 device px).
  The remaining gain is exact pixel alignment — at most one device pixel, 0.05 mm.
- What it costs is the three full-arena blits at device size (1.8 megapixels on that
  phone) for every non-`off` variant: the same fill as `thin`, i.e. 10–11 ms instead of
  3 ms in the software worst case, on exactly the devices with least to spare.
- It makes every logical coordinate fractional (1.95×), so the solid white head pixel and
  every sprite would need snapping to stay hard-edged.

If phones with ≥ 3 device px per logical px become the norm (tablets already are), a 2×
`bold` with a two-step fringe becomes worth having; the band model already supports it.

### Extras: which are worth it

| Extra | Verdict |
|-------|---------|
| `boost` | **Keep, on by default.** The cheapest fix of all for the two colours that get lost. Display only. If the owner would rather keep the exact palette, `fx=tracer` drops it. |
| `tracer` | **Keep, on by default.** A streak rather than a halo, now that a halo means "head". |
| `shadow` | Only visible on Paper. Off by default. |
| `fade` | Implemented; still not judged — it only exists in motion and nobody has watched it. Off by default. |

### Recommendation

**Default `shade=auto`, `head=auto`, `fx=tracer,boost`** (`DEFAULT_DISPLAY` in
`src/game/display/settings.ts`), which means:

| Screen | Trail | Head | Why |
|---|---|---|---|
| Phone, small window (a logical pixel under 1 CSS px) | **`bold`** | **`soft`** | The first shade that is visible at 0.11 mm per pixel; costs nothing over `off`; gaps stay open by rule. `soft` is the smallest halo that stands out from the trails |
| Desktop, tablet (a logical pixel of 1 CSS px or more) | **`thin`** | **`ring`** | Trails are already 1.3–2.5 device pixels of an arm's-length screen; half a pixel of edge and a one-pixel halo are enough, and the picture stays the classic one |

If the owner finds `bold` too heavy on the phone the step down is `thin` (which is to say
none); if not heavy enough, `wide`. On a desktop `bold` is one tap away and is a matter of
taste (it is also cheaper than `thin` on a DPR 1 screen, where `thin` is slightly blurred).

Merge: the display layer, the renderer change, `backgroundFile` / `lightBackground`,
Blueprint. Decide after seeing them: Paper, `fade`, `shadow`. Once a default is confirmed:
remove the variants that lost, the 1/2/3 keys and the chips.

### Known limits

- Not tested on real hardware or in Safari/Firefox in this round. Everything is plain
  `putImageData` / `drawImage` / `fillRect`; the chips are ordinary buttons.
- `bold` makes a trail look three pixels wide while the obstacle is one: passing a trail
  at a distance of one pixel looks like touching its shade. That is the price of being
  visible; the core stays exactly on the obstacle and gaps between trails are kept clear.
- The gap rule looks along rows and columns. Two trails that only approach each other
  diagonally are not treated as a gap (their shade meets at a corner); two parallel
  diagonal trails are, because they also face each other along rows.
- A guest's provisional (predicted) trail pixels are drawn every frame with the same
  shade as plain squares: for the few ticks until the host confirms them it is not
  clipped by walls or other trails and ignores the gap rule.
- In an arena snapshot (rejoin) lock-border pixels have the player's colour and are taken
  for trail until the next round.
- The shade does not wrap around the arena edges.
- A head's halo is white whatever the player; two heads meeting are told apart by their
  trails only.
- Door sprites (Portals) have black recesses; fine there because that level is black.
- Item sprites with a white box look pasted on Paper.
