# Teratron Revival — Backlog

Local backlog, created from the November 2026 code review. Items are grouped into
iterations; each iteration ends with a commit. Design docs in `design/` are updated
*before* the code for each feature (see CLAUDE.md).

Legend: `[ ]` todo · `[~]` in progress · `[x]` done · **P0** broken / blocks play ·
**P1** important · **P2** nice to have

---

## Review findings (reference)

### Bugs

| # | Sev | Where | Problem |
|---|-----|-------|---------|
| B1 | P0 | `TronGameState.initRound` | `pixelOwners.clear()` wipes level obstacles and they are only re-added when the level *index changes*. With a fixed level, players can drive through walls from round 2 on. |
| B2 | P0 | `LobbyConnection` | Host identifies itself as `host-<nanoid>`, not its Trystero peer id, so the guest's `onPeerLeave` check never matches: **guests never notice the host leaving** (game just freezes). `host_disconnected` is declared but never sent. |
| B3 | P0 | `LobbyConnection` ICE config | TURN uses the public `openrelayproject` static credentials, which Metered retired. With no working TURN, any pair behind symmetric NAT / CGNAT (mobile, many ISPs) cannot connect. This is the "does not work across networks" problem. |
| B4 | P1 | `TronGame` guest path | Only the *latest* received state is kept per frame. If two states arrive between frames (normal with jitter) the older one's `soundEvents`, `borderSegments` and `eraserUsed` are dropped → missing sounds, missing border pixels, trails that should have been erased. |
| B5 | P1 | `TronGame` guest path | No client-side prediction: every steering input is visible only after a full round trip (plus head-of-line blocking on the reliable channel). At 280°/s turn rate, 100 ms of lag is 28° of overshoot. Main cause of "hard to control". |
| B6 | P1 | `TronGameState.tickPlaying` | Diagonal-crossing check uses the raw prev→current segment. When a player wraps around an edge that segment spans the whole arena and can "intersect" someone else's move → random deaths. |
| B7 | P1 | `TronGameState.clearPixelPath/tracerExpire` | Tracers delete pixels from `levelObstacles` (the "pristine" copy used by Eraser), and bullets/bombs don't. After an Eraser the renderer restores the full level image but collisions use the damaged copy → invisible holes / visible-but-passable walls. Also cleared level pixels are never cleared on the level canvas, only on the trail canvas. |
| B8 | P1 | `TronGame` loop | Simulation runs inside `requestAnimationFrame`. When the host tab is hidden the game freezes for everybody; at <70 fps displays the 5-step cap slows the game down. |
| B9 | P1 | `NetworkLobby`, `MainMenu` | Nicknames and chat are interpolated into `innerHTML` unescaped → HTML/script injection from any peer. |
| B10 | P1 | `TronGame.broadcastState` | A single `latestPingTimestamp` is echoed to all guests, so with 2+ guests the lag readout is someone else's ping. |
| B11 | P2 | `TronGameState.endRound` | Simulation calls `getSoundManager()` directly (audio side effect inside game logic; breaks headless use). |
| B12 | P2 | `LobbyConnection` | Guests broadcast lobby messages and inputs to *all* peers (mesh), and guests accept `lobby_state`/`game_start` from any peer, not just the host. |
| B13 | P2 | `LobbyConnection.handlePeerJoin` | Lobby state is sent after a fixed 500 ms `setTimeout`; guest "announce" depends on it. Racy. |
| B14 | P2 | `ScreenManager.showMainMenu`, `disconnect` | `history.pushState` on every menu visit pollutes browser history. |
| B15 | P2 | `LobbyConnection` | A peer joining mid-game is auto-assigned a lobby slot; `game_in_progress` rejection is never used. |
| B16 | P2 | `TronGame` round reset | Trails are cleared with a `countdown > 2.9` heuristic (7 frames) instead of an explicit round-start event. |
| B17 | P2 | `TronInput.isTouchDevice` | Touch-screen laptops get the mobile layout. |
| B18 | P2 | `vite.config.ts` | Reads `.certs/*.pem` unconditionally → `vite build` fails on any machine without mkcert certs (CI, contributors). |

### Tech debt

- **T1** No tests, no lint, no CI. `eslint-disable` comments exist but ESLint is not installed.
- **T2** `TronGameState` is a 2100-line class mixing rules, weapons, bodyguards, portals, serialization.
  (`design/refactoring-proposal-effects-weapons.md` exists but was never executed.)
- **T3** Collision map is `Map<"x,y", color>`: string allocation per lookup; a bomb does 14 400 string
  deletes, mega-bomb 57 600. Uzi pushes one `clearedAreas` entry *per pixel* (hundreds/frame on the wire).
- **T4** Simulation uses `Math.random()` directly → not reproducible, not testable.
- **T5** Dead code: `PlaceholderGame.ts`, legacy `gameState` channel, `GameInput`/`PlayerPosition`
  protocol, `GameConnection.onGameState` format sniffing (`{positions: state} as unknown`).
- **T6** `TronGame` mixes DOM layout (500 lines of inline HTML/CSS), loop, netcode and stats.
- **T7** Full state (all projectiles, items, portals, nicknames, colours) is sent 70×/s over a
  reliable ordered channel. No deltas, no rate limiting.
- **T8** Frame-rate constant 70 is hard-coded in many places (`1/70`, `/ 70`).
- **T9** `architecture.md` is out of date (PeerJS, Nostr, 60 Hz, prediction that doesn't exist).
- **T10** No way back to the lobby after a match; `alert()` used for errors.

### Dependencies

| Package | Current | Latest | Plan |
|---------|---------|--------|------|
| trystero | 0.21.8 | 0.27.0 | Upgrade. 0.27 is split into `@trystero-p2p/*` strategy packages. Evaluate in iteration 6. |
| vite | 6.4.1 | 8.x | Upgrade (dev-only; several advisories in the 6.x tree). |
| typescript | 5.6.3 | 7.x | Upgrade to latest 5.x/6.x first; 7 (native compiler) once Vite/Vitest tooling is confirmed OK. |
| nanoid | 5.1.6 | 6.x | **Remove** — `crypto.randomUUID()` / `getRandomValues` is enough. |
| nipplejs | 0.10.2 | 1.0.x | Upgrade (check API changes) or replace with ~60 lines of pointer-event code. |
| unique-names-generator | 4.7.1 | 4.7.1 | Keep (or inline a short word list; it ships large dictionaries). |
| gh-pages | 6.3.0 | — | Replace with a GitHub Actions Pages deploy (iteration 7). |
| free-tex-packer-core | 0.3.5 | 0.3.9 | Bump; source of most `npm audit` noise (dev-only). |
| *(new)* vitest | — | — | Unit + headless gameplay tests. |

`npm audit`: 31 advisories (7 critical), all in dev tooling trees (vite, gh-pages, tex packer).

---

## Iteration 1 — Testable simulation + correctness  ✅

Goal: the game rules run headless and deterministically, with tests guarding them.

- [x] Add Vitest; `npm test` script
- [x] Seedable RNG injected into `TronGameState` / `ItemLauncher` (T4)
- [x] Remove audio side effect from the simulation (B11)
- [x] Fix level obstacles lost after round 1 (B1) + test
- [x] Fix wrap-around false "crossing" kills (B6) + test
- [x] Level damage consistent between sim, eraser and renderer (B7): one collision grid is the
      truth, all weapons can damage level pixels (and the renderer now shows it), Eraser and a
      new round restore the pristine level
- [x] Replace `Map<string,string>` collision map with a typed-array `PixelGrid` (T3)
- [x] Tracer paths were never cleared on screen (radius-0 areas were a no-op in the renderer);
      now sent as line segments (`clearedLines`) instead of one entry per pixel
- [x] Colour-blindness effect no longer resurrects erased trails / permanently recolours them
- [x] Explicit `roundStarted` event instead of the countdown heuristic (B16)
- [x] Guest applies events of every received state (B4)
- [x] Delete dead code: placeholder game, legacy channel/protocol (T5)
- [x] `vite.config.ts`: HTTPS certs optional (B18)
- [x] Headless fuzz test: random inputs on real levels, invariants hold, deterministic per seed

## Iteration 2 — Local mode  ✅

Design: `design/local-and-ai.md`

- [x] Design doc: local play, input sources, session abstraction, AI
- [x] `GameSession` abstraction (`HostSession` / `GuestSession`); `TronGame` is now only a view
- [x] `InputManager` with per-player keyboard schemes (solo / arrows / wasd / ijkl / numpad)
- [x] Local setup screen (slots, mode, level; remembered in localStorage)
- [x] "LOCAL GAME" enabled in the main menu
- [x] Fixed-timestep `Ticker`; network host keeps simulating in a hidden tab via worker timer (B8)
- [x] Escape peer-supplied strings in lobby/menu (B9); errors shown in the menu instead of `alert()`
- [x] Touch layout only when the primary pointer is coarse (B17); no history pollution (B14)
- [x] Stuck keys after window blur

## Iteration 3 — AI players  ✅

Design: `design/local-and-ai.md`

- [x] `BotController`: trajectory rollouts with the real movement/collision rules, a second
      "escape" turn, corridor (U-turn room) and enclosed-area (coarse flood fill) awareness,
      moving hazards, item goals, weapon use, auto-ready, Control Reversal compensation
- [x] Difficulty levels (easy / normal / hard)
- [x] Bots in local games (setup screen)
- [x] Bots in network games (host-run; `+ AI` on open lobby slots)
- [x] Death causes recorded by the simulation (`deaths` events; logged to the console)
- [x] **Automated gameplay validation**: `tests/sim.ts` headless match runner; `tests/bots.test.ts`
      regression thresholds; `npm run sim` prints a per-level tuning table
- [ ] Bots: dodge projectiles and bomb blast areas
- [ ] Bots: most remaining deaths are "own trail" in self-made pockets; a Voronoi-style
      territory estimate would help more than longer lookahead
- [ ] Bots cost ~0.35 ms (normal) / ~0.6 ms (hard) per tick each; fine for 3 bots on desktop,
      check low-end phones hosting

## Iteration 4 — Netcode: make it controllable  ✅

Design: `design/networking.md` (Input Handling, Prediction and Reconciliation)

- [x] Sequence-numbered inputs, per-player input queue on host, ack in state
- [x] Client-side prediction + reconciliation for the local player (B5), sharing the host's
      movement code (`movement.ts`): speed factors, Control Reversal, wrap, portals
- [x] Provisional (predicted) trail rendering
- [x] Dead reckoning for remote players
- [x] Per-guest ping echo, immune to clock offset and host hold time (B10)
- [x] Slim wire format (T7): ~20 KB/s per guest instead of 70+
- [x] Headless netcode rig (`tests/netsim.ts`): prediction is exact on steady links from
      0 to 250 ms, bounded under jitter and clock drift; arena reconstruction is bit-exact
- [x] `?lag=<ms>&jitter=<ms>` artificial latency for manual / browser testing
- [ ] Smooth the 1-tick corrections under heavy jitter (currently snaps)
- [ ] Guest-side jitter buffer for remote entities if real-world jitter looks bad
- [ ] Unreliable/unordered channel for state (needs transport support) to avoid
      head-of-line blocking on lossy links

## Iteration 5 — P2P that works across networks  ✅ (one manual step left)

Design: `design/networking.md` (rewritten)

- [x] Evaluate & document options (signaling, TURN providers, relay fallback)
- [x] Upgrade Trystero 0.21 → 0.27 (Nostr relays; guests now appear in ~0.5 s instead of 10–30 s)
- [x] Configurable TURN: static credentials or a credentials endpoint (`.env.example`,
      `tools/cloudflare-turn-worker.js`) (B3)
- [x] Stable per-tab identity; seats/host/inputs keyed by verified `userId` (B2)
- [x] Lobby on synchronised state: host reconciles profiles into seats; no join handshake or
      timers (B13); only the host can write the room; state accepted only from the host (B12)
- [x] Host loss detected (25 s grace for reloads); immediate goodbye when the host leaves (B2)
- [x] Mid-game joiners spectate with a snapshot instead of corrupting the lobby (B15)
- [x] Lobby diagnostics: RTT and direct/relay per player; TURN-missing warning; error notices
- [x] `?relay=1` forces TURN-only
- [x] `npm run test:e2e`: two headless Chromes through the real signaling relays;
      `E2E_RELAY=1` runs it with everything forced through a local TURN server
- [ ] **Manual: provision a TURN service and set the env vars for the deployed build**
      (Cloudflare Realtime TURN recommended; see networking.md). Until then players behind
      carrier-grade NAT still cannot connect, and the lobby says so.
- [ ] Verify on real devices across networks (phone on mobile data ↔ laptop on Wi-Fi)
- [ ] Optional alternative signaling strategy (MQTT / own relay) if Nostr relays are blocked
      on some network
- [x] In-game "Connection to the host lost — waiting…" banner when a guest has heard nothing
      from the host for 1.5 s

## Iteration 6 — Tooling & dependencies  ✅

- [x] Vite 6 → 8, Vitest 5, TypeScript 5.6 → 6.0 (TS 7's native compiler works for `tsc` but
      breaks the TypeScript language-server plugin, so it is not used yet)
- [x] Trystero 0.27; nanoid removed; bundle 557 kB → 369 kB
- [x] ESLint (typescript-eslint) + `npm run lint`
- [x] GitHub Actions CI: lint, typecheck, tests, build
- [x] Rewrote `architecture.md`; README updated (T9)
- [ ] nipplejs 0.10 → 1.0 (API changed; needs testing on a real touch device) or replace it
      with a small pointer-event joystick
- [ ] Remaining `npm audit` findings are dev-only: `free-tex-packer-core` (sprite build
      script) and `node-turn` (local TURN server used by the e2e test)
- [ ] Deploy from CI (GitHub Pages action) with the TURN settings as repository secrets
- [ ] Run `npm run test:e2e` in CI (needs Chrome and outbound WebSocket/UDP)

## Room & session robustness (requested)  ✅

- [x] Rejoin after a page reload: room code stays in the URL, identity in `sessionStorage`;
      a reloaded guest gets its seat back and resumes the running game from a snapshot
      (trails, level damage, scores)
- [x] Host reload: the host comes back as host; a game in progress is lost and the room
      returns to the lobby
- [x] Back to lobby from a game without creating a new room (host's LOBBY button)
- [x] Share the room as a QR code
- [ ] Host migration, so a host reload/drop does not end the game in progress
- [ ] Keep scores across "back to lobby" (optional setting)

## Gameplay fidelity (requested)

- [x] Satellites (bodyguards) freeze when the round ends
- [x] Projectiles freeze when the round ends
- [x] Sidebar: grey panel for dead players (who lose their weapon and effects) and for
      slots that are not playing; team colours in team mode (`sidebar_team`)
- [x] Team mode: the Slow weapon does not slow team-mates
- [x] Team mode: every survivor scores, team score = sum, shown as the headline between
      rounds (`design/teams.md`)
- [x] Round summary shows how each player died and who did it (`DeathEvent.by`), aligned
      under the name
- [x] Level 8 ("Portals"): automatic doors, as in the original (geometry, placement and
      timing taken from `TRON.FPG` / `TRON.PRG`); they kill on contact even through a shield,
      gate the wrap-around, and bots time their crossings. See `design/level-hazards.md`
- [x] Level 7 ("Warzone"): the tank and the cannon fire shell bursts at random, as in the
      original; bots keep out of the line of fire
- [x] Level 6 ("Dentistry"): the dentist's hand wanders around drilling teeth; as in the
      original it does not kill, it hides the arena beneath it and erases pixels
- [ ] Items can spawn hidden under a closed door (faithful, but maybe not fun)

## Touch controls (requested)

Audit and design: `design/touch-controls.md`.

- [x] Audit of the stick (tiny, `^2.5` curve, slower than keys; latency is not the cause)
- [x] Four steering modes selectable in-game (🕹 button): BUTTONS, POINT, SWIPE, STICK
- [x] Phone-emulation browser test (`npm run test:e2e:touch`)
- [x] 1 s lock on "ready" after a round ends
- [ ] **Play-test on a real phone**, pick a winner, tune it, remove the losers (and nipplejs
      with the old stick)
- [ ] Trails are 1 px wide and hard to see on a phone screen

## Projectile collisions (reported)  ✅

Rules: `design/projectiles.md`.

- [x] A shot crossing an arena edge swept the whole row/column that tick and hit anyone on
      it, usually its own shooter ("died of his own bullet")
- [x] H-bomb collides as its 12×18 body: no more flying through a player; explodes when
      its nose touches a wall
- [x] Glock bullets explode when they cross a tracer (Uzi/rifle fire shoots them down)
- [x] Tracers kill within the 3×3 pixels around a head, as in the original (was 1×1):
      and the rifle bursts every 15 ticks instead of 20 (8.5 s of fire): sustained rifle
      fire kills 77 % of right-angle crossings instead of 37 %
- [x] A tracer meeting a player head-on was swallowed by the trail right behind the head
- [x] A single tracer or bullet crossing a flying H-bomb sets it off (whole-path test)
- [x] A tracer hitting something on the tick it wraps erased a line across the whole arena
- [x] H-bomb blast is a circle (cleared area, players, items, satellites)
- [x] Satellites (`design/bodyguards.md`): intercept shots on their course instead of
      chasing them, attack players who enter their area; 10 px/tick; tracers cannot harm
      them and Glock bullets bounce back; only an H-bomb destroys them

## Open reports

- [ ] **Laptop vs phone: both players died at the first instant of round 1.** Not reproduced with
      two headless browsers on one machine. Deaths now carry a cause and are logged to the
      console (`[game] X died: <cause> at x,y`) to pin it down next time. Need to know which
      device hosted, which browser, and whether it was the dev server or the deployed build.
- [ ] Warzone / Portals levels contain nearly-black (e.g. `#010101`) pixels that are invisible
      but solid; decide whether to clean the images or use a brightness threshold

## Later / ideas

- [ ] Match length setting
- [ ] Split `TronGameState` into systems (weapons, bodyguards, portals) (T2)
- [ ] Extract game HTML/CSS out of `TronGame` (T6)
- [ ] Host migration
- [ ] Gamepad support
- [ ] Spectator-friendly late join (full trail snapshot)
