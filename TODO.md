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

## Iteration 1 — Testable simulation + correctness  ⟵ current

Goal: the game rules run headless and deterministically, with tests guarding them.

- [ ] Add Vitest; `npm test` script
- [ ] Seedable RNG injected into `TronGameState` / `ItemLauncher` (T4)
- [ ] Remove audio side effect from the simulation (B11)
- [ ] Fix level obstacles lost after round 1 (B1) + test
- [ ] Fix wrap-around false "crossing" kills (B6) + test
- [ ] Make level damage consistent between sim, eraser and renderer (B7)
- [ ] Replace `Map<string,string>` collision map with a typed-array `PixelGrid` (T3)
- [ ] Explicit round-start event instead of the countdown heuristic (B16)
- [ ] Delete dead code (T5)
- [ ] `vite.config.ts`: HTTPS certs optional (B18)
- [ ] Headless smoke test: random inputs for N rounds, invariants hold, no exceptions

## Iteration 2 — Local mode

Design: `design/local-and-ai.md`

- [ ] Design doc: local play, input sources, session abstraction
- [ ] `GameSession` abstraction so `TronGame` does not depend on a network connection
- [ ] Per-player keyboard maps (original bindings adapted to modern keyboards)
- [ ] Local setup screen: per slot Human (keys) / AI / Off, mode, level
- [ ] Enable "LOCAL GAME" in the main menu
- [ ] Fixed-timestep simulation decoupled from rAF (B8)

## Iteration 3 — AI players

Design: `design/local-and-ai.md`

- [ ] Bot controller producing `TronInput` from game state (wall avoidance via ray casts,
      space-seeking, item pickup, weapon use, auto-ready)
- [ ] Difficulty levels
- [ ] Bots in local games
- [ ] Bots in network games (host-run; lobby slot type `ai`)
- [ ] **Automated gameplay validation**: headless bot-vs-bot matches across all levels asserting
      survival-time and round-completion metrics; regression baseline for bot quality

## Iteration 4 — Netcode: make it controllable

Design: update `design/networking.md` (prediction & reconciliation section)

- [ ] Sequence-numbered inputs, per-player input queue on host, ack in state
- [ ] Client-side prediction + reconciliation for the local player (B5)
- [ ] Provisional (predicted) local trail rendering
- [ ] Dead reckoning for remote players (extrapolate by measured one-way delay)
- [ ] Guest processes events from *every* state, not only the latest (B4)
- [ ] Per-guest ping echo (B10)
- [ ] Slim the wire format: static player data out of per-tick state, compact projectiles,
      run-length cleared areas (T7)
- [ ] Headless netcode test rig: host + guest sims joined by a simulated link
      (latency / jitter), asserting prediction error bounds

## Iteration 5 — P2P that works across networks

Design: update `design/networking.md` (connectivity section)

- [ ] Evaluate & document options (signaling strategy, TURN providers, relay fallback)
- [ ] Upgrade Trystero; redundant signaling
- [ ] Configurable TURN (env-provided static creds or credentials endpoint) (B3)
- [ ] Use real peer ids; detect host loss; send `host_disconnected` on leave (B2)
- [ ] Target messages to the host; ignore host-only messages from non-hosts (B12)
- [ ] Handshake instead of the 500 ms timer (B13); reject mid-game joins (B15)
- [ ] Connection diagnostics in the lobby (signaling state, ICE candidate type: direct/relay, RTT)
- [ ] `?relay=1` debug switch forcing TURN-only, so the cross-network path can be tested on one machine
- [ ] Escape all peer-supplied strings (B9)

## Iteration 6 — Tooling & dependencies

- [ ] Bump vite, typescript, nipplejs, tex packer; drop nanoid
- [ ] ESLint (typescript-eslint) + `npm run lint`
- [ ] GitHub Actions: typecheck + test + build on PR; Pages deploy on main
- [ ] Refresh `architecture.md` and README (T9)

## Later / ideas

- [ ] Return-to-lobby after a match, match length setting (T10)
- [ ] Split `TronGameState` into systems (weapons, bodyguards, portals) (T2)
- [ ] Extract game HTML/CSS out of `TronGame` (T6)
- [ ] Host migration
- [ ] Gamepad support
- [ ] Spectator-friendly late join (full trail snapshot)
- [ ] Touch-laptop detection (B17), history handling (B14)
