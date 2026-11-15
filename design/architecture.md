# Teratron Web - Architecture

High-level architecture of the web revival of Teratron. Detailed designs:

- [old-tron-design.md](./old-tron-design.md) — the original game (the reference for gameplay)
- [local-and-ai.md](./local-and-ai.md) — sessions, local play, AI players, automated validation
- [networking.md](./networking.md) — connectivity, rooms and lobby, netcode, resilience
- [level-hazards.md](./level-hazards.md) — per-level hazards: automatic doors, shell bursts, the dentist's hand
- [projectiles.md](./projectiles.md) — what bullets, tracers and bombs hit, and how
- [bodyguards.md](./bodyguards.md) — satellites: what they block, attack and how they wear out
- [teams.md](./teams.md) — team mode: scoring and how it is shown
- [spectators.md](./spectators.md) — watching a game, the join code on the game screen, joining from the next round
- [touch-controls.md](./touch-controls.md) — steering on phones
- [display-layer.md](./display-layer.md) — the display bitmap, kept apart from the collision
  bitmap: trail shade, head markers, levels with a background
- [refactoring-proposal-effects-weapons.md](./refactoring-proposal-effects-weapons.md) — pending
  proposal to split weapons/effects out of the simulation class

## Principles

1. **Faithful gameplay**: mechanics follow the original (70 ticks/s, 750×600 arena, pixel
   collisions, same items and weapons).
2. **One simulation, many front ends**: the rules run identically in a local game, on a
   network host, and headless in tests.
3. **Static hosting only**: no game server. Multiplayer is peer-to-peer with host authority.
4. **Simplicity**: vanilla TypeScript + Canvas 2D, a handful of small dependencies.

## Technology

| Concern | Choice |
|---------|--------|
| Language / build | TypeScript (strict), Vite |
| Rendering | Canvas 2D: level + trail layers derived from a display bitmap, composited every frame |
| Multiplayer transport | Trystero (WebRTC data channels, Nostr signaling), optional TURN |
| Wire format | MessagePack with compact positional encodings |
| Touch input | Own touch handling with selectable steering modes ([touch-controls.md](./touch-controls.md)); nipplejs only for the legacy stick |
| Tests | Vitest (headless simulation, bots, simulated network), Playwright-driven Chrome for e2e |

## Layers

```
screens/            MainMenu · LocalSetup · NetworkLobby          (DOM)
game/TronGame       game screen: layout, InputManager, TronRenderer, sound, Ticker
        │  GameSession interface
game/session/       HostSession (authoritative; local games + network host, runs bots)
                    GuestSession (prediction, dead reckoning, snapshots)
        │  HostTransport / GuestTransport
network/            RoomConnection (Trystero) · roomLogic (pure lobby rules)
                    serialization · ice (TURN config) · LaggedTransport (debug)
game/               TronGameState · TronPlayer · movement · PixelGrid · ItemLauncher
game/ai/            BotController
```

Rules of the layering:

- `game/` (except `TronGame`, `TronRenderer`, `SoundManager`, `Ticker`, `input/InputManager`)
  has no DOM, audio, timers or `Math.random()`; randomness comes from an injected seedable
  RNG. This is what makes headless, reproducible tests possible.
- The game screen only knows the `GameSession` interface.
- Network code never contains game rules; `roomLogic.ts` contains lobby rules without any
  networking, so it is unit-testable.

## Simulation

- Fixed timestep: `TICK_RATE = 70`. `Ticker` drives `session.step()` from
  `requestAnimationFrame` with an accumulator; a network host keeps ticking in a hidden tab
  through a Web Worker timer.
- `TronGameState.tick(inputs)` advances one tick; `serialize()` returns the frame: the state
  to draw plus **one-shot events** (new trail pixels, cleared pixels, sounds, deaths, round
  start…). Events must be applied exactly once, in order — the session's `onFrame` callback
  guarantees that for hosts and guests alike.
- Collision map: `PixelGrid`, a typed array of palette indices (plus coarse 8 px occupancy
  used by bots). The pristine level is kept separately and restored at round start and by
  the Eraser item; weapons damage the live grid, and the renderer shows the damage.
- Movement rules shared between host and guest prediction live in `movement.ts`.
- Round flow: `countdown` → `playing` → `waiting_ready` (everyone presses action to toggle
  "ready"; the next round starts when all are). In network games the players can change at
  that point ([spectators.md](./spectators.md)). Action presses are ignored for the first
  `READY_LOCK_TICKS` (70 ticks = 1 s) of `waiting_ready`, so a shot fired as the round
  ends is not taken as "ready". A button held through the lock must be released and
  pressed again.

## Rendering

What is drawn is not the collision map. `ArenaDisplay` (`src/game/display/`) keeps a
**display bitmap** — colour and kind (trail / level) per cell — fed by the same one-shot
events, and derives from it two off-screen layers, level and trails, including any shade
around them (a pure function of the neighbouring cells, so erasing leaves no ghosts).
`TronRenderer` composites background, level layer and trail layer with portals, items,
projectiles, explosions, bodyguards, heads, the sidebar and overlays each display frame.
Provisional (predicted) trail pixels are drawn on top every frame without being stored.
A level may have a display-only background image. Variants, costs and the reasoning are in
[display-layer.md](./display-layer.md).

The sidebar is a third off-screen canvas, redrawn only when what it shows changes (about
once a second, for the timers). Measurements and the renderer alternatives that were tried
(WebGL, `ImageData`) are in [research/performance.md](./research/performance.md).

The sidebar has one panel per slot, showing the player's active effect and weapon with the
time or ammunition left. A player who dies **loses the weapon and effects** (in the
simulation, not just on screen) and the panel turns grey, like the panel of a slot nobody
plays in. In team mode the panels use the team colours ([teams.md](./teams.md)).

Every death goes off with a small **explosion** where the player was (the original's
`Puf()`): the same animation as a bullet impact, but it clears and kills nothing, and it
plays to the end even when the death ended the round.

The round summary lists, under each dead player's name, how they died and **who did it**.
Every death is a one-shot event `{slotIndex, cause, x, y, by?}`; `by` is the slot of the
player responsible, which can be the victim:

| Cause | `by` | Shown as |
|-------|------|----------|
| `tracer` | whoever fired it (`-1` for a level gun) | *shot by Ana* · *shot by their own bullet* · *shot by the level* |
| `bullet` | whoever fired the Glock bullet — after bouncing off a satellite, the satellite's owner | *blown up by Ana* · *blown up by their own bullet* |
| `bomb` | whoever launched the H-bomb, also when someone else set it off (none when two bombs collide) | *bombed by Ana* · *bombed by their own bomb* |
| `bodyguard` | the satellite's owner | *killed by Ana's satellite* |
| `trail` | the owner of the trail, in free-for-all (team-mates share a colour) | *crashed into Ana's trail* |
| `crossing` | the other player | *head-on collision with Ana* |
| `own-trail`, `level`, `door` | — | *crashed into their own trail*, … |

**What the Shield does.** It takes its player through trails, scenery and closed doors
(`design/level-hazards.md`), and that is all. It does not stop tracers, bullets, bombs or
satellites, and it does not go through the head of another player: two heads that come
to be on the same pixel, or that cross on diagonals, both die (`crossing`, by the other),
shielded or not. (The pixel a head is on is not in the collision grid yet, so without this
rule heads would pass through each other and die on the trail behind, which a Shield
ignores.) In the original the Shield meant complete invincibility but for doors.

### Levels

A level is one 750×600 PNG: it is drawn as the background, and every pixel of it that is
not pure black is an obstacle of that colour. The obstacle grid is **decoded from the
file** (`src/game/png.ts`, a small decoder using `DecompressionStream`), not read back
from a canvas: browsers may alter canvas read-backs (Safari adds noise as a fingerprinting
protection), and a single off-black pixel is a wall. Reading from a canvas remains only as
a fallback when the file cannot be decoded. With `?perf=1` the readout shows how many
pixels the canvas read-back would have got wrong on this device. `tests/png.test.ts`
checks the decoder against `pngjs` on every level.

## Multiplayer in one paragraph

The host simulates; guests send sequence-numbered inputs and receive a compact state every
tick. Guests predict their own player by replaying unacknowledged inputs on top of the
latest host state, and extrapolate the others, so steering is immediate at any latency.
Rooms use Trystero's synchronised state; identities are stable per tab, so reloads rejoin.
See [networking.md](./networking.md).

## Testing strategy

| Level | What | Where |
|-------|------|-------|
| Rules | Scripted situations, seeded fuzz on real levels, determinism | `tests/rules.test.ts` |
| Bots | Seeded bot-vs-bot matches with quality thresholds | `tests/bots.test.ts`, `npm run sim` |
| Netcode | Host+guest over a simulated link (latency, jitter, drift) | `tests/netcode.test.ts` |
| Lobby | Seat reconciliation, authority, game config, queue and next-round seating | `tests/room.test.ts` |
| Spectators | Reduced stream, seats changing hands at a round start | `tests/spectators.test.ts`, `tests/e2e/spectators.e2e.mjs` |
| End to end | Two headless Chromes through real signaling (and TURN) | `npm run test:e2e` |

## Deployment

`npm run build` produces static files (`dist/`); `npm run deploy` publishes them to GitHub
Pages. TURN credentials are provided at build time through environment variables (see
networking.md and `.env.example`).
