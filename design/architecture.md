# Teratron Web - Architecture

High-level architecture of the web revival of Teratron. Detailed designs:

- [old-tron-design.md](./old-tron-design.md) — the original game (the reference for gameplay)
- [local-and-ai.md](./local-and-ai.md) — sessions, local play, AI players, automated validation
- [networking.md](./networking.md) — connectivity, rooms and lobby, netcode, resilience
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
| Rendering | Canvas 2D: off-screen level + trail canvases composited every frame |
| Multiplayer transport | Trystero (WebRTC data channels, Nostr signaling), optional TURN |
| Wire format | MessagePack with compact positional encodings |
| Touch input | nipplejs joystick |
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

## Rendering

`TronRenderer` keeps two off-screen canvases — level and trails — and composites them with
portals, items, projectiles, explosions, bodyguards, heads, the sidebar and overlays each
display frame. Trails are persistent pixels; provisional (predicted) trail pixels are drawn
on top every frame without being stored.

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
| Lobby | Seat reconciliation, authority, game config | `tests/room.test.ts` |
| End to end | Two headless Chromes through real signaling (and TURN) | `npm run test:e2e` |

## Deployment

`npm run build` produces static files (`dist/`); `npm run deploy` publishes them to GitHub
Pages. TURN credentials are provided at build time through environment variables (see
networking.md and `.env.example`).
