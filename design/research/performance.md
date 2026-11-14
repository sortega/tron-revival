# Performance research

Status: **in progress** (branch `research/performance`). This document is filled in as the
work advances; the plan below is the spec the code on the branch follows.

## Question

Where does the time go, on a desktop and on a phone (which is often the host, and then also
runs the bots), and which of these would make the game faster for a reasonable cost?

1. Optimising the existing TypeScript (simulation, bots, wire format, Canvas renderer).
2. A WebGL renderer instead of Canvas 2D.
3. WebAssembly for the hot loops (pixel grid, bot rollouts).
4. Moving the bots and/or the simulation to a Web Worker; OffscreenCanvas.

## Plan

1. **Measure first**, with a harness that stays in the repository:
   - `src/game/perf.ts`: opt-in phase timers (`bots`, `sim`, `serialize`, `events`, `net`,
     `decode`, `predict`, `step`, `render`, `frame`, `rafGap`) called from `HostSession`,
     `GuestSession`, `Ticker` and `TronGame`. Off by default (one null check per call);
     `?perf=1` turns them on in the browser and exposes `window.__teratron.perf()`.
   - `npm run bench:sim`: a real `HostSession` in Node, per-tick cost per phase for
     no bots / 1–3 bots per difficulty / heavy scripted scenes, plus GC pauses,
     allocation rate and wire bytes.
   - `npm run bench:fingerprint`: hash of every frame and every wire packet of seeded
     bot matches. An optimisation that claims to be exact must leave it unchanged.
   - `npm run bench:browser`: the production build in headless Chrome (playwright-core):
     frame, step and render times, display frames per second, dropped ticks, GC pauses and
     per-thread CPU from a Chrome trace, JS heap, bundle size. Desktop, and two emulated
     phones (viewport + device pixel ratio + CDP CPU throttling ×4 and ×6).
2. **Implement the low-risk wins**, one commit each, bit-identical simulation.
3. **Prototype the rest** (WebGL, WASM, worker) in isolation — behind a flag or under
   `scripts/bench/` — far enough to get honest numbers.
4. Recommend per alternative: merge / merge later / don't.
