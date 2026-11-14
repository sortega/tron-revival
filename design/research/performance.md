# Performance research

Branch `research/performance`, November 2026. Raw outputs of the runs quoted here are in
[`performance-data/`](./performance-data/).

## Summary

- **The game was already cheap, with three real problems.** A tick has a budget of 14.3 ms
  (70 ticks/s). On a desktop-class core the simulation costs 2–7 µs per tick and rendering
  0.3 ms per display frame. What was not cheap:
  1. **Bots**, the only thing that scales with a slow CPU: 3 hard bots 0.34 ms per tick,
     and **3.2 ms per tick on the level with doors (Portals), p99 10 ms** on a fast core,
     i.e. over budget on a phone.
  2. **Projectile bookkeeping was quadratic**: four Uzis cost 0.33 ms per tick in the
     simulation and, on the emulated low-end phone, dropped the display to 50 fps (tracer
     paths erased pixel by pixel on two canvases, 366 KB/s on the wire).
  3. **Garbage**: the Portals bots allocated 11 MB per tick; overlapping H-bombs 7 MB per
     tick with 25–36 ms GC pauses on the emulated phones.
- **All three are fixed in plain TypeScript**, with the simulation bit-identical (proved
  by a fingerprint of seeded matches) and the picture pixel-identical: bots ×1.5 (×9 on
  Portals), heavy weapon scenes ×3–×6, renderer −25 % (−45 to −60 % with many tracers), Uzi
  bandwidth halved. On the emulated low-end phone the two scenes that dropped frames
  (50 and 40 fps) now hold 60.
- **WebGL, WebAssembly and `ImageData` are not worth it**: once the Canvas renderer stops
  redrawing the status panel, WebGL saves 0.02 ms per frame; WASM is 1.3× faster on the
  bot rollout kernel and 2× on line walks, on code that now takes well under 0.1 ms per
  tick, and its `sin`/`cos` are not bit-compatible with JavaScript's.
- **A Web Worker for simulation + bots works** (prototype behind `?worker=1`) and takes
  the main thread from 2–4 ms to 0.2 ms per frame. It is the right tool *if* real phones
  still show bot spikes; the emulation cannot tell (CPU throttling does not reach
  workers), so it stays a flag.
- Everything "mobile" below is **emulation in desktop Chrome**, not a phone. See
  [what still needs a real device](#what-still-needs-a-real-device).

## Method

All commands run from the repository root; nothing needs to be installed globally.

| Command | What it measures |
|---|---|
| `npm run bench:sim` | A real `HostSession` in Node: µs per tick per phase (bots, sim, serialize, net, and a guest's decode / predict) for 18 scenarios; GC pauses; bytes allocated per tick; wire bytes. `--only=<text>`, `--ticks=`, `--json=`. |
| `npm run bench:fingerprint` | Hashes of seeded matches (5 bot matches, 5 scripted weapon scenes): `state` (everything simulated, every tick, plus the final grid), `frames` (with one-shot events), `wire` (every packet). Compare with `scripts/bench/fingerprint.baseline.json`. |
| `npm run bench:browser` | The production build in headless Chrome (playwright-core, system Chrome): per-phase ms, display fps, slow frames, dropped ticks, GC from a Chrome trace, per-thread CPU share, JS heap, bundle size. `--profiles=desktop,mobile-4x,mobile-6x`, `--only=`, `--seconds=`, `--query=worker=1`, `--hz=120`, `--headed`, `--json=`. |
| `npm run bench:render` | Renderer alternatives on synthetic scenes: Canvas 2D (the game's renderer), `ImageData`, WebGL2 prototype. Also hashes the canvas, to prove a renderer change is pixel-identical. |
| `npm run bench:wasm` | TypeScript vs AssemblyScript on the hot loops, boundary cost, determinism. |
| `node scripts/bench/compare.mjs a.json b.json` | Markdown table of two result files. |
| `NODE_FLAGS="--cpu-prof --cpu-prof-dir=/tmp/p" npm run bench:sim -- --only=…` then `node scripts/bench/top-functions.mjs /tmp/p/*.cpuprofile` | Self time per function. |

The phase timers live in `src/game/perf.ts` and are called from `HostSession`,
`GuestSession`, `Ticker` and `TronGame`. They are off by default (one null check per
call). `?perf=1` turns them on in the browser, exposes `window.__teratron.perf()` and
shows a small on-screen readout (mean / worst ms per phase over the last second, ticks
per second, dropped ticks) — the tool for checking a real phone.

### The profiles, and how far to trust them

| Profile | Viewport | DPR | CPU |
|---|---|---|---|
| `desktop` | 1280×800 | 1 | unthrottled |
| `mobile-4x` | 844×390, touch | 3 | CDP `Emulation.setCPUThrottlingRate` 4 |
| `mobile-6x` | 740×360, touch | 2 | rate 6 |

Machine: Apple M1 Max, macOS, Node 26, Chrome headless. WebGL reports ANGLE on Metal;
Canvas 2D is assumed to be rasterised on the GPU too (the GPU process' load follows the
amount of drawing), as it would be on a phone.

Caveats that matter when reading the numbers:

- **It is emulation.** Throttling slows the page's main thread only. The GPU, the GPU
  process, memory bandwidth, thermal throttling and Safari's engine are not emulated.
  As a rough guide (my estimate, not a measurement) an M1 performance core slowed 4× is a
  low/mid-range Android phone and 6× a low-end one.
- **Workers are not throttled**, so the worker prototype's own cost on a phone is unknown.
- **The unthrottled browser numbers are inflated.** A page that is busy 5–15 % of the time
  runs at a fraction of the speed of the same code in a tight loop: in the `desktop`
  profile 4 hard bots cost 0.9–1.6 ms per tick against 0.2 ms in Node, and *less* at 4×
  throttling than unthrottled. This is consistent with macOS parking a lightly loaded
  thread on efficiency cores at low frequency (the throttler keeps the thread busy, which
  moves it to a performance core). So: **Node numbers = a fast core flat out; `mobile-6x`
  ≈ Node × 6; `desktop` rows are an upper bound** for a desktop, and are mostly useful for
  before/after.
- `performance.now()` in the page has 0.1 ms resolution: phases under 0.1 ms are only
  meaningful as means.
- Bot matches in the browser use `Math.random`, so two runs do not play the same match;
  differences under ~20 % between browser runs are noise. The Node scenarios are seeded.
- Guest-side cost was measured in Node only (decode + prediction); an in-browser guest
  needs two browsers through the signalling relays and was left out.

## Where the time went (baseline, commit `9dcb2b6`)

Node, µs per tick, whole host tick = bots + sim + serialize (+ wire encoding):

| Scenario | mean | p95 | p99 | notes |
|---|---|---|---|---|
| 2 players, no bots | 4 | 9 | 22 | sim 2, serialize 1.3 |
| 4 players, no bots | 7 | 15 | 41 | |
| 1 easy / normal / hard bot | 9 / 40 / 74 | 48 / 243 / 354 | 69 / 378 / 455 | |
| 3 easy / normal / hard bots | 26 / 174 / 340 | 68 / 585 / 691 | 151 / 785 / 997 | bots are 97 % of it |
| 3 hard bots, Warzone | 407 | 1148 | 1312 | fire-zone checks |
| **3 hard bots, Portals** | **3179** | **7734** | **9985** | door tests; 11 MB allocated per tick |
| 4 Uzis firing | 332 | 347 | 388 | all in `tickProjectiles` |
| rifles + shotguns | 129 | 221 | 263 | |
| 12 satellites + rifles | 81 | 255 | 271 | |
| H-bombs, many in flight¹ | 902 | 1024 | 1075 | 7 MB allocated per tick |
| network host, 3 hard bots | 359 | 705 | 1002 | wire encode 15, 386 B/tick (26 KB/s) |
| network host, 4 Uzis | 412 | 433 | 504 | wire encode 82, **5358 B/tick (366 KB/s)** |
| guest: decode + predict | 3.5 | | | 29 with 4 Uzis |

¹ The scene keeps firing bombs; the game hands out one bomb per pick-up, so at most four
can fly. It is a stress test, not a realistic load.

In the browser (production build, 20 s per run), per display frame at `mobile-6x`:

| Scenario | step (per tick) mean / p99 | of which bots | events + render | frame mean / p99 | fps | slow frames |
|---|---|---|---|---|---|---|
| 2 easy bots | 0.15 / 1.4 | 0.05 | 0.31 | 0.48 / 2.0 | 59.9 | 0 |
| 4 hard bots, level cycle | 2.04 / 7.3 | 1.84 | 0.39 | 2.77 / 8.5 | 59.7 | 2 |
| 4 hard bots, Portals | 4.42 / **14.6** | 4.18 | 0.52 | 5.65 / 15.6 | 59.9 | 1 |
| 4 Uzis | 3.81 / 5.4 | 0 | **4.11** | 7.14 / 20.7 | **49.6** | **161** |
| H-bombs¹ | 3.90 / 7.4 | 0 | 1.1 | 7.55 / 46.0 | **40.0** (15 ticks dropped) | **107** |

Reading: without bots or a firefight the game uses 3 % of a slow core. Bots are 90 % of a
tick whenever there are any. Rendering is small and flat (0.2–0.5 ms of JavaScript per
frame; the GPU process stays at 2–9 % of a core) *except* when tracers erase lines.
JS heap: 7–16 MB in every scenario. GC: 1–4 ms per second with bots, 8–50 ms per second
in the heavy scenes, with pauses of 25–36 ms.

## What was implemented

Each is one commit; the simulation commits leave `npm run bench:fingerprint` unchanged.

| Commit | Change | Risk |
|---|---|---|
| `perf: benchmark harness` | Phase timers, the three benchmarks, the fingerprint. | none (off by default) |
| `perf(bots): cheaper rollouts, same decisions` | Rollouts read the grid's typed array directly; door frames worked out once per step and only inside a door's bounding box (`doorZones`); checkpoints share the path's cell list; flood fill on the raw coarse grid; the "clear ahead" rollout skipped when the bot has no weapon. | exact: `state`, `frames` and `wire` hashes identical |
| `perf(sim): projectiles without the quadratic bookkeeping` | Removed-id `Set` instead of array scans; bullet-vs-bullet loop no longer runs for tracers; bombs only searched for when one flies; distance reject before the bomb box test; line walks without a callback per pixel; `TronPlayer.trail` (written, never read, one object per pixel per round) removed. | exact: all hashes identical |
| `perf(sim): only report cleared lines and areas that erased something` | A tracer through empty space no longer produces a `clearedLines` event (nor empty `clearedAreas`). | `state` hash identical; events and wire shrink. Netcode tests that rebuild the arena from events still match the host exactly |
| `perf(grid): take the modulo only for pixels outside the arena` | `wrap()` fast path. | exact |
| `perf(render): cache the status panel, erase tracer paths in one fill` | Status panel on its own canvas, redrawn when its content key changes (≈ once a second); all tracer lines of a frame erased with one `destination-out` fill per canvas. | pixel-identical (canvas hash of three scenes, incl. a dead player's grey panel) |
| `perf(render): do not redraw display frames in which nothing changed` | A `dirty` flag in `TronGame`: on a 90/120 Hz screen the frames between two ticks are skipped. No effect at 60 Hz. | low; effect not measurable here (see below) |
| `perf: on-screen readout of the phase timers with ?perf=1` | For phones. | none (flag) |

### Results

Node, µs per tick (`performance-data/sim-before.json` → `sim-after.json`):

| Scenario | before (mean / p95 / p99) | after | speed-up | KB allocated per tick |
|---|---|---|---|---|
| 2 players, no bots | 4.0 / 8.5 / 22 | 3.7 / 9.0 / 20 | ×1.1 | 11 → 12 |
| 1 easy bot | 8.5 / 48 / 69 | 5.5 / 31 / 51 | ×1.6 | 33 → 17 |
| 3 easy bots | 26 / 68 / 151 | 23 / 64 / 122 | ×1.1 | 58 → 53 |
| 3 normal bots | 174 / 585 / 785 | 118 / 408 / 562 | ×1.5 | 101 → 88 |
| 3 hard bots | 340 / 691 / 997 | 220 / 458 / 639 | ×1.5 | 169 → 137 |
| 4 hard bots | 310 / 714 / 809 | 198 / 472 / 535 | ×1.6 | 151 → 121 |
| 3 hard bots, Portals | 3179 / 7734 / 9985 | 343 / 960 / 1869 | **×9.3** | 11072 → 334 |
| 3 hard bots, Warzone | 407 / 1148 / 1312 | 263 / 755 / 861 | ×1.5 | 213 → 153 |
| 4 Uzis | 332 / 347 / 388 | 70 / 74 / 92 | **×4.8** | 121 → 89 |
| rifles + shotguns | 129 / 221 / 263 | 42 / 62 / 71 | ×3.0 | 70 → 48 |
| H-bombs¹ | 902 / 1024 / 1075 | 154 / 194 / 207 | **×5.9** | 7312 → 19 |
| 12 satellites + rifles | 81 / 255 / 271 | 22 / 51 / 55 | ×3.7 | 75 → 61 |
| network host, 3 hard bots | 359 / 705 / 1002 | 234 / 471 / 656 | ×1.5 | 182 → 151 |
| network host, 4 Uzis | 412 / 433 / 504 | 108 / 114 / 143 | ×3.8 | 251 → 175 |

Wire with 4 Uzis: 5358 → 2606 B/tick (366 → 178 KB/s); encode 82 → 38 µs, guest decode
29 → 11 µs. The unit test suite (which plays bot matches) went from 85 s to 49 s.

Browser, ms (`performance-data/browser-before.json` → `browser-after.json`):

| Profile | Scenario | step, before (mean / p95 / p99) | step, after | frame, before | frame, after | fps | slow frames | GC ms/s |
|---|---|---|---|---|---|---|---|---|
| desktop | 2 easy bots | 0.23 / 0.70 / 1.10 | 0.21 / 0.60 / 1.00 | 0.53 / 1.20 / 1.70 | 0.45 / 1.00 / 1.60 | 59.8 → 59.8 | 0 → 0 | 0.6 → 0.6 |
| desktop | 4 hard bots | 1.77 / 3.90 / 5.20 | 0.91 / 3.70 / 4.40 | 2.27 / 4.90 / 5.80 | 1.24 / 4.10 / 4.80 | 59.8 → 59.9 | 0 → 0 | 1.8 → 1.2 |
| desktop | 4 hard bots, Portals | 1.70 / 6.40 / 7.90 | 1.46 / 3.80 / 4.50 | 2.17 / 7.10 / 8.30 | 1.90 / 4.50 / 5.50 | 59.9 → 59.9 | 0 → 1 | 1.0 → 1.3 |
| desktop | 4 Uzis | 0.97 / 1.40 / 2.50 | 0.41 / 0.80 / 1.00 | 1.52 / 2.90 / 3.90 | 0.70 / 1.40 / 1.70 | 59.9 → 59.8 | 0 → 0 | 0.5 → 1.0 |
| desktop | H-bombs¹ | 1.42 / 3.10 / 3.80 | 0.32 / 0.60 / 0.90 | 1.91 / 4.20 / 5.80 | 0.59 / 1.30 / 1.80 | 59.9 → 59.9 | 0 → 0 | 13.3 → ? |
| mobile-4x | 2 easy bots | 0.18 / 0.70 / 1.00 | 0.19 / 0.80 / 1.20 | 0.46 / 1.10 / 1.30 | 0.44 / 1.10 / 1.60 | 59.9 → 59.9 | 0 → 0 | 0.8 → 1.0 |
| mobile-4x | 4 hard bots | 1.31 / 2.60 / 3.10 | 1.37 / 3.00 / 3.50 | 1.80 / 3.50 / 4.30 | 1.87 / 3.70 / 4.90 | 59.8 → 59.9 | 1 → 0 | 2.4 → 2.9 |
| mobile-4x | 4 hard bots, Portals | 4.15 / 9.40 / 12.20 | 1.74 / 4.90 / 5.60 | 5.20 / 11.20 / 13.20 | 2.34 / 5.40 / 6.20 | 59.9 → 59.9 | 0 → 0 | 2.9 → 2.4 |
| mobile-4x | 4 Uzis | 2.59 / 3.10 / 3.40 | 0.73 / 1.40 / 1.60 | 4.11 / 7.00 / 7.50 | 1.16 / 1.90 / 2.30 | 59.9 → 59.8 | 0 → 13² | 1.5 → ? |
| mobile-4x | H-bombs¹ | 2.57 / 4.70 / 5.40 | 0.55 / 1.20 / 1.50 | 3.51 / 7.20 / 9.40 | 1.20 / 2.10 / 2.80 | 59.8 → 59.9 | 2 → 1 | 29.4 → 5.1 |
| mobile-6x | 2 easy bots | 0.15 / 0.80 / 1.40 | 0.25 / 1.00 / 1.50 | 0.48 / 1.40 / 2.00 | 0.60 / 1.60 / 2.10 | 59.9 → 59.8 | 0 → 0 | 0.9 → 1.1 |
| mobile-6x | 4 hard bots | 2.04 / 5.40 / 7.30 | 1.72 / 5.00 / 6.60 | 2.77 / 6.60 / 8.50 | 2.40 / 6.00 / 8.20 | 59.7 → 59.7 | 2 → 2 | 3.4 → 3.4 |
| mobile-6x | 4 hard bots, Portals | 4.42 / 11.50 / 14.60 | 3.29 / 8.10 / 10.00 | 5.65 / 12.80 / 15.60 | 4.28 / 9.10 / 11.30 | 59.9 → 59.9 | 1 → 0 | 4.1 → 4.7 |
| mobile-6x | 4 Uzis | 3.81 / 4.80 / 5.40 | 0.57 / 1.50 / 1.80 | 7.14 / 12.50 / 20.70 | 1.08 / 2.00 / 2.50 | **49.6 → 59.9** | **161 → 0** | 7.8 → 1.8 |
| mobile-6x | H-bombs¹ | 3.90 / 6.40 / 7.40 | 0.71 / 1.70 / 2.20 | 7.55 / 32.30 / 46.00 | 1.68 / 3.00 / 4.00 | **40.0 → 59.7** | **107 → 3** | 50.5 → 8.1 |

"step" is one simulation tick, "frame" one whole `requestAnimationFrame` callback (one or
two ticks plus rendering). Dropped ticks (the Ticker giving up on catching up): 15 in the
baseline H-bomb run at `mobile-6x` (68.9 ticks/s), none in any other run before, and none
at all after. `?`: the Chrome trace of that run could not be parsed.
² 13 frames of 25–33 ms in that one run while the frame callback itself stayed under
2.3 ms (p99) and GC could not be read: unexplained, did not reproduce at `mobile-6x`;
treat as noise until seen again.

The bot rows in the browser improve less than in Node because the matches differ from run
to run (unseeded) and because part of every 20 s window is the pause between rounds; the
seeded Node rows are the like-for-like comparison.

**After the changes the worst case that remains is four hard bots on Portals on the
slowest profile: 3.3 ms per tick on average, 10 ms at p99, 15 ms worst, of which 92 % is
bots.** That is inside the budget but without much room, and it is the first thing to
look at on a real low-end phone.

## Alternatives evaluated

### Canvas 2D (kept) vs `ImageData` vs WebGL2

`npm run bench:render`, main-thread ms per display frame (applying a frame's events +
drawing), mean; 600 frames per run. "Canvas before/after" is the game's renderer before
and after the renderer commit.

| Profile | Scene | Canvas before | Canvas after | `ImageData` | WebGL2 prototype |
|---|---|---|---|---|---|
| desktop | typical (4 players, items, portals) | 0.32 | 0.24 | 0.43 | 0.19 |
| desktop | heavy (160 tracers erasing lines, explosions, 12 satellites) | 1.79 | 1.01 | 0.67 | 0.51 |
| desktop | colour-blindness tint | 0.37 | 0.31 | 0.37 | 0.20 |
| mobile-4x | typical | 0.23 | 0.19 | 0.38 | 0.18 |
| mobile-4x | heavy | 2.68 | 1.08 | 0.71 | 0.42 |
| mobile-6x | typical | 0.31 | 0.22 | 0.48 | 0.20 |
| mobile-6x | heavy | 3.98 | 1.57 | 1.06 | 0.62 |

No variant produced a slow frame in any run. The GPU process' CPU share was the same
within noise for all three: 2–4 % at the phone viewports and 9–16 % at the desktop one
(the one exception: the old Canvas renderer in the heavy scene, 10 % at the phone
viewports, 4 % after the batched erase).
Two more data points from switching parts of the Canvas renderer off: the status panel
was a third of the typical frame (0.32 → 0.21 ms without it), and the head glow
(`shadowBlur` on a single pixel) costs nothing measurable (0.31 vs 0.32).

- **Canvas 2D — keep.** The canvas is 800×600 whatever the screen, three layer blits and
  a few dozen sprites per frame; Chrome rasterises it on the GPU. After caching the
  status panel there is nothing left that is drawn every frame without need.
- **`ImageData` (CPU frame buffer + `putImageData`) — don't.** Slower in the normal case:
  1.8 MB uploaded every frame. It only wins when hundreds of pixels are erased per frame,
  and the batched erase took most of that away.
- **WebGL2 — don't.** The prototype (`scripts/bench/pages/WebGLArena.ts`: arena as a
  texture mirrored from a CPU buffer with dirty-row uploads, batched sprite / glow /
  tracer quads, sidebar on a cached 2D canvas) is the fastest, but against the Canvas
  renderer as it is now the gain is **0.02–0.05 ms per frame in normal play and 0.5–1 ms
  in a firefight nobody can sustain**, out of a 16.7 ms frame. The price would be a
  second renderer of ~900 lines: text and overlays (countdown, round summary, team
  scores) need a 2D layer anyway, plus context-loss handling, plus the colour-blindness
  tint and the 'saturation' panels as shaders. WebGL would become interesting only if the
  arena grew much larger or gained per-pixel effects (glow on trails, CRT filters).
- **Dirty rectangles — not applicable.** With a GPU canvas the cost is per draw call, not
  per pixel; the full-frame blits are the cheap part.

### WebAssembly (AssemblyScript prototype)

`npm run bench:wasm`: the same loops in TypeScript and in AssemblyScript (`-O3`), on a
realistic arena (a level plus 18 000 trail pixels). Node 26 / V8, best of five.

| Kernel | TypeScript | WASM | WASM / TS |
|---|---|---|---|
| Bot plan: 9 rollouts with clearance sampling | 16.7 µs | 12.8 µs (one call per plan); 12.7 µs (one call per rollout) | 0.77 |
| — with `sin`/`cos` imported from JS | | 13.0 µs | 0.78 |
| `firstHitOnLine`, 12 and 100 px lines | 399 ns → **163 ns** with the `wrap` fast path found here | 77 ns | 0.47 |
| `has()` per pixel, called from JS | 6.3 ns | 4.0 ns | 0.64 |
| Blast: 121 `clearRect` strips | 30 µs | 16 µs | 0.55 |
| TypeScript loops over a typed-array view of the WASM memory | same speed as over their own array | | 1.00 |

- **Boundary cost**: not measurable at these granularities (a call per rollout, per line,
  even per pixel is still faster than TypeScript). Sharing the grid costs nothing: the
  WASM memory can simply *be* `PixelGrid.cells`.
- **Determinism**: AssemblyScript's `sin`/`cos` differ from V8's in the last bit for
  2.8 % of random headings (and for 1 of the 90 multiples of 4°). Guests predict movement
  in JavaScript with `movement.ts`; a host simulating in WASM would disagree with them in
  the last bits unless the module imports JS trig (3 % slower) or guests run the same
  module. Bots are host-only, so for them it would only change seeded test results.
  (Side note: JS engines are not required to agree with each other on `Math.sin` either;
  the wire already rounds positions to 1/1000 px and the host is authoritative.)
- **Verdict — don't.** 1.3× on rollouts and 2× on line walks, applied to code that after
  the TypeScript fixes costs 0.07 ms (4 Uzis) to 0.2 ms (4 hard bots) per tick on a fast
  core. It would add a compile step, a second language, a second copy of the rules that
  must stay bit-identical with `movement.ts`, and 6 kB. Only V8 was measured (Safari's
  engine was not).

### Web Worker for simulation and bots (prototype, `?worker=1`)

`WorkerHostSession` implements `GameSession` for local games: the worker runs the normal
`HostSession` on its own fixed-timestep clock and posts each frame (structured clone);
the page forwards inputs that changed and draws. `performance-data/browser-worker.txt`;
compared with the in-thread numbers after all the optimisations above:

| Profile | Scenario | main thread per frame, in-thread (mean / p99) | with the worker | frame age on arrival (mean / p99) |
|---|---|---|---|---|
| desktop | 4 hard bots | 1.24 / 4.80 ms | 0.15 / 0.50 ms | 0.19 / 0.5 ms |
| desktop | 4 hard bots, Portals | 1.90 / 5.50 | 0.16 / 0.60 | 0.25 / 0.6 |
| mobile-4x | 4 hard bots, Portals | 2.34 / 6.20 | 0.16 / 1.10 | 0.49 / 1.2 |
| mobile-6x | 4 hard bots | 2.40 / 8.20 | 0.18 / 1.50 | 0.57 / 1.6 |
| mobile-6x | 4 hard bots, Portals | 4.28 / 11.30 | 0.20 / 1.70 | 0.61 / 1.8 |

70 ticks/s held and no tick dropped in all runs; three runs had a single frame that
arrived 15–48 ms late. Handling a frame message costs the page ~0.03 ms; the structured
clone itself is outside the timers, but the main thread as a whole was 4–7 % busy with the
worker against 14–32 % without.

- What it buys: display frames no longer wait for a slow tick, and on a multi-core phone
  the bots get a core of their own. What it does **not** buy is throughput: the tick costs
  the same, somewhere else.
- What the emulation cannot say: CDP throttling does not slow workers, so the worker rows
  ran at full speed. Whether a low-end phone's second core is fast enough (big.LITTLE
  phones may put the worker on a little core) needs a device.
- What a production version would still need: network hosting (the WebRTC transport lives
  on the page, so packets and guest inputs would be relayed through `postMessage`),
  background behaviour for hosts (today the page's Ticker keeps a hidden host alive with a
  worker *timer*; a worker *simulation* would make that simpler), and a fallback if the
  worker fails to start.
- Input latency: an input is applied at the worker's next tick instead of the page's next
  frame; the measured hop is 0.2–0.6 ms each way, on top of at most one tick, as before.
- **Verdict — merge later, if a real device asks for it.** The flag is harmless when off
  (the worker chunk, 74 kB / 23 kB gzip, is only fetched with the flag). Moving only the
  bots (the simulation staying on the page) was considered and rejected: the bots need
  the whole collision grid every tick, so they would need their own mirror of it and
  their answers would arrive a tick late, for no gain over moving both.

### OffscreenCanvas (not prototyped)

Rendering from a worker would take `events` + `render` off the main thread: 0.2–0.4 ms
per frame at `mobile-6x` after the fixes (1.1 ms in the worst firefight), in exchange for
cloning every frame to the worker (as the worker prototype does in the other
direction: cheap, but up to 1.8 ms of latency at p99), a renderer rewritten without `document`, `Image` or the DOM fonts, and no
support before Safari 16.4. With the simulation already in a worker there would be
nothing left on the main thread to protect. **Don't.**

### Smaller things

- **Skipping unchanged display frames** (implemented, optional). With a 120 Hz timer in
  place of the compositor (`--hz=120`), redraws fall from 119.7 to 69.8 per second; the
  main-thread saving is inside the noise (a redraw is ~0.15 ms). The point is GPU work
  and battery on 90/120 Hz phones, which this harness cannot measure.
- **Bot planning budget** (not implemented). The remaining bot cost is spiky: p99 is 3×
  the mean because several bots plan in the same tick. Capping the plans per tick (the
  others keep steering as they were for one more tick; emergencies exempt) would cut the
  p99 roughly in half for 3–4 hard bots, deterministically. It changes bot behaviour
  slightly, so it needs the bot quality tests re-run with it; worth doing only if a real
  phone shows the spikes. A worker makes it unnecessary.
- **Bundle**: 383.4 kB (124.8 kB gzip) before, 388.6 kB (126.7 kB) after (worker session,
  timers, readout), plus the 74 kB worker chunk that is only fetched with the flag.
  Networking (Trystero, Nostr crypto, lobby) is ~214 kB of it and is loaded even for a
  local game; loading it on demand would cut the first download roughly in half. Start-up
  time, not frame time: left for another branch.
- **Uzi bandwidth**: still 178 KB/s with four Uzis firing at once (45 KB/s each), nearly
  all of it the tracers themselves, 10 numbers each, 70 times a second. They live two
  ticks; guests could draw them from the shooter's state instead. A wire-format change:
  left for the networking work.
- **The head glow is invisible**: `shadowBlur = 10` under a 1×1 white pixel leaves almost
  nothing on screen (compare the screenshots of the Canvas and WebGL variants). It costs
  nothing; whether heads should glow visibly is a design question, noted here only
  because the benchmark made it obvious.

## Recommendation

| Alternative | Verdict | Why |
|---|---|---|
| TypeScript: bots, projectiles, grid, event pruning | **Merge** | Exact (fingerprint), large gains exactly where a phone hurts, tests untouched and faster. |
| TypeScript: status panel cache, batched line erase | **Merge** | Pixel-identical, −25 % to −60 % render cost. |
| Benchmark harness + `?perf=1` readout | **Merge** | Off by default; needed for the device checks below and for any future claim about speed. |
| Skip unchanged display frames | **Optional** | Low risk, but its benefit (fast screens) is unverified here. |
| Web Worker for sim + bots (`?worker=1`) | **Merge later** (keep the flag or drop the commit) | Works and frees the main thread, but unneeded on the numbers so far, not wired to network games, and unmeasured on a phone. |
| WebGL renderer | **Don't** | ≤ 0.05 ms per frame in normal play for a second renderer to maintain. |
| `ImageData` frame buffer | **Don't** | Slower in normal play. |
| WebAssembly | **Don't** | 1.3–2× on loops that are no longer a problem; toolchain, duplicated rules, trig not bit-compatible. |
| OffscreenCanvas | **Don't** | Nothing left to gain; not prototyped. |
| Bot planning budget | **Later, if needed** | Changes bot behaviour; only matters if a real phone shows spikes. |

The prototypes live apart from the game: `scripts/bench/pages/` (WebGL, `ImageData`),
`scripts/bench/wasm/` (AssemblyScript; the only reason for the `assemblyscript`
devDependency), `src/game/session/WorkerHostSession.ts` + `session/worker/` (worker;
one line in `LocalSetup.ts` picks it up). Each is its own commit and can be dropped
without touching the rest.

## What still needs a real device

Use `npm run dev` on the LAN and open the game on the phone with `?perf=1` (local games
work over plain HTTP). The readout in the corner shows mean / worst ms per phase over the
last second and the dropped ticks.

1. **Low-end Android phone, local game, you + 3 hard AI on Portals** (the worst case
   left). Pass: `step` worst stays under ~14 ms, dropped ticks stay 0, the FPS overlay
   (double tap) stays at 70. If not: try `?perf=1&worker=1` and compare `frame` / `w.step`
   — that is the evidence for or against finishing the worker.
2. **The same phone hosting a network game** with 3 hard bots and a guest: the `step` row
   then includes wire encoding; watch the guest for stutter.
3. **A firefight** (several Uzis / rifles at once) on the phone: 60 fps, no long pauses.
4. **iPhone / Safari**: nothing here ran on JavaScriptCore or WebKit's canvas. Same three
   checks; plus `?worker=1` (module workers need Safari 15+).
5. **A 120 Hz phone**: that the game looks the same with the redraw skipping, and whether
   it stays cooler / lasts longer (the commit can be reverted on its own to compare).
6. **Heat**: ten minutes of 4 hard bots; phones throttle, the emulation does not.
