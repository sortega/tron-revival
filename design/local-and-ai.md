# Local Play, Game Sessions and AI Players

This document specifies local (same-keyboard) games, the session abstraction that lets the
game screen run without a network, and computer-controlled players.

Related: [architecture.md](./architecture.md), [networking.md](./networking.md),
[old-tron-design.md](./old-tron-design.md), [bots-human.md](./bots-human.md) (reaction
time, motor imprecision and aim error of bots).

## Goals

- Play on one machine with 1–4 humans sharing a keyboard, as in the original.
- Fill any slot with an AI player, in local **and** network games.
- The simulation runs headless (Node) so that rules, bots and netcode can be validated by
  automated tests without a browser or a human.

## Layering

```
┌──────────────────────────────────────────────────────────────┐
│ TronGame (screen)   DOM layout, InputManager, TronRenderer,  │
│                     sound, level image loading, ticker       │
└───────────────┬──────────────────────────────────────────────┘
                │ GameSession interface
     ┌──────────┴───────────┐
     ▼                      ▼
┌──────────────┐     ┌───────────────┐
│ HostSession  │     │ GuestSession  │   src/game/session/
│ authoritative│     │ network guest │
│ sim + bots   │     │ (prediction)  │
└──────┬───────┘     └───────┬───────┘
       │ optional            │
       ▼ GameConnection      ▼ GameConnection
┌──────────────────────────────────────┐
│ TronGameState, TronPlayer, PixelGrid │   pure simulation: no DOM, no audio,
│ ItemLauncher, bots                   │   seedable RNG
└──────────────────────────────────────┘
```

Rules:

- Nothing below `TronGame` touches the DOM, audio, timers or `Math.random()`.
- A **local game is a `HostSession` without a connection**. There is no separate local code
  path for the rules.
- The screen never looks at `isHost`; it only talks to the `GameSession`.

### `GameSession`

```ts
interface GameSession {
  /** Advance one simulation tick with the inputs of this machine's human players. */
  step(localInputs: ReadonlyMap<SlotIndex, TronInput>): void;
  /** Called exactly once per simulated frame, in order, with its one-shot events
      (trail growth, cleared pixels, sounds, round start...). */
  onFrame: ((frame: TronGameStateData) => void) | null;
  /** What to draw right now; null until a guest has received its first state. */
  getViewState(): { round: TronRoundState; match: TronMatchState } | null;
  /** Level obstacles for the level being played (ignored by guests). */
  setLevelObstacles(levelIndex: number, obstacles: PixelGrid): void;
  /** Lag and bitrate, when networked. */
  getNetworkStats(): NetworkStats | null;
  /** The session cannot continue (e.g. host left). */
  onEnded: ((reason: string) => void) | null;
  destroy(): void;
}
```

### Ticking

The simulation uses a fixed timestep of 1/70 s (`TICK_RATE`). `TronGame` owns a `Ticker`
that calls `session.step()` the right number of times and then renders once.

- Visible tab: driven by `requestAnimationFrame` with a time accumulator.
- Hidden tab: `requestAnimationFrame` stops. A **network host** must keep simulating or the
  game freezes for every guest, so the ticker falls back to a timer running in a Web Worker
  (worker timers are not throttled in background tabs). Local games simply pause.
- Catch-up is capped (10 steps per wake-up); beyond that the clock is resynchronised rather
  than fast-forwarding.

### Simulation in a Web Worker

The authoritative session (`HostSession`: simulation, bots and, for a network game, the
encoding of states for the guests) runs in a **Web Worker** by default, for local games
and for the host of a network game (`WorkerHostSession`, `createHostSession`). The worker
ticks on its own clock and posts every frame to the page; the page forwards the inputs
that changed and draws. A slow tick (bots) can then no longer delay a display frame.

- **Network host**: the room (WebRTC) stays on the page. The page relays guest inputs to
  the worker and broadcasts the encoded states the worker hands back. A snapshot for a
  player joining mid-game is requested from the worker and answered asynchronously.
- **Hidden tab**: a local game pauses the worker; a network game keeps it running (worker
  timers are not throttled, and its messages still wake the page to broadcast).
- **The local player's input** reaches the simulation one message later than before
  (frames arrive 0.2-0.6 ms after they were simulated in the benchmarks).
- **Fallback**: with `?worker=0`, or if the worker cannot be created or fails before its
  first frame, the same `HostSession` runs on the page's thread as before. A worker that
  fails mid-game ends the game.
- Guests do not use a worker (`GuestSession` runs on the page).
- `window.__teratron.inWorker()` tells which it is; `?perf=1` shows the worker's timings
  as `w.step` / `w.bots` / `w.sim` and the frame delay as `workerLag`.

## Player control types

Every player in a `GameConfig` declares how it is controlled *from this machine's point of
view*:

```ts
type PlayerControl =
  | { type: 'local'; scheme: ControlScheme }   // human on this machine
  | { type: 'remote' }                          // someone else's input (network)
  | { type: 'ai'; difficulty: BotDifficulty };  // bot, run by the authoritative session

type ControlScheme = 'solo' | 'arrows' | 'wasd' | 'ijkl' | 'numpad';
type BotDifficulty = 'easy' | 'normal' | 'hard';
```

On a guest, bots run by the host appear as `remote`.

## Local input

Controls are relative: turn left, turn right, action (ready / fire).

| Scheme | Left | Right | Action | Notes |
|--------|------|-------|--------|-------|
| `solo` | ← or A | → or D | Space, ↑ or W | Only human on this machine (network games, 1 human + bots) |
| `arrows` | ← | → | ↑ | |
| `wasd` | A | D | W | |
| `ijkl` | J | L | I | |
| `numpad` | Numpad 4 | Numpad 6 | Numpad 8 | |

The original bindings (Z/X/Ctrl, Insert, Delete/Enter…) are not reused: Ctrl-combinations
and navigation keys collide with browser shortcuts. All schemes follow the same shape —
*left, right, "up" = action* — so they are easy to explain.

On touch devices the on-screen steering ([touch-controls.md](./touch-controls.md)) and the
action button drive the first local human. A local game on
a touch device therefore supports one human (plus bots) unless a keyboard is attached.

`InputManager` owns all key listeners and returns `Map<SlotIndex, TronInput>` each tick.

## Local game setup screen

Main menu → **LOCAL GAME** opens a setup screen:

- Four slot rows (slot colours as in network games). Each slot is one of
  `Off` · `Human` (+ control scheme) · `AI Easy` · `AI Normal` · `AI Hard`.
- Game mode: FFA (≥ 2 active slots) or Teams (all 4 slots active).
- Levels: every level in turn, one level, or **a chosen few** played in turn (in the order
  of the level list). The picker is one chip per level plus ALL: with all on, tapping a
  level means "only this one"; after that a tap adds or removes a level (the last one
  stays). The same picker is in the network lobby, for the host. The choice is the
  `levelMode` string: `'cycle'`, a level id, or ids separated by commas
  (`src/game/levelMode.ts`).
- START (disabled until the mode's player count is met) and BACK.
- The last configuration is remembered in `localStorage`.
- Default: slot 0 Human (`solo`), slot 1 AI Normal, others Off.
- With exactly one human the scheme is forced to `solo`; with several, each human gets a
  distinct scheme.
- All-AI games are allowed (attract mode; also handy for testing).

## AI players

> The planner described here sees the world and presses the keys through a humanisation
> layer (delayed perception, clumsy key presses, aim error, confusion under Control
> Reversal): see [bots-human.md](./bots-human.md).

Bots are **input generators**: each tick the authoritative session asks every bot for a
`TronInput` and feeds it to the simulation exactly like a human's input. Bots get no
privileged powers (same turn rate, same weapons, same rules) and read only what a human
could see on screen: the collision grid, players, items, projectiles, portals, bodyguards.

```ts
class BotController {
  constructor(slot: SlotIndex, difficulty: BotDifficulty, rng: Rng);
  decide(game: TronGameState): TronInput;
}
```

### Steering: trajectory rollouts

Turning is rate-limited (4°/tick → turning circle of ≈14 px radius), so a bot cannot just
look at the pixel in front of it. Each decision it evaluates a small set of candidate
manoeuvres:

> steer `s ∈ {left, straight, right}` for `k` ticks, then go straight

with several values of `k` (≈ 45°, 90° and 180° turns). Each candidate is simulated
pixel-by-pixel against the collision grid — including arena wrap-around and the same
diagonal "squeeze" rule the real collision uses — until it hits something or reaches the
lookahead distance. The score of a candidate is:

```
score = free distance along the path                 (survival)
      + openness at the end of the path              (avoid dead ends: short ray fan)
      + goal bonus if the path heads to the target   (items / enemies)
      − danger penalty for passing near hazards      (enemy heads, bodyguards, bombs)
      + small bonus for keeping the current steering (stability, less jitter)
```

The bot applies the first steering value of the best candidate. A `safetyMargin` (also
check pixels 1–2 px to each side of the path) keeps bots from threading 1-pixel gaps.
(In the code this is the corridor and wall-hugging penalty governed by `clearanceSteps`.
A lateral margin proper, `sideMargin`, and extra room around enemy heads, `headMargin`,
are set by the human layer: [bots-human.md](./bots-human.md).)

Portals: a rollout that enters a portal continues from the exit, as the real rule does.

### Goals

When the best path is comfortably long, the bot picks a target and adds the goal bonus:

- Nearest useful item (wrap-aware distance). Bots avoid *Control Reversal* and automatic
  *Slow*, and treat mystery items as mildly attractive.
- Otherwise, on `hard`, a point ahead of the nearest enemy (cut them off).

### Weapons

| Weapon | Use |
|--------|-----|
| Glock, Shotgun | Pulse the action button when an enemy is inside a narrow cone ahead, or when boxed in (shoot a way out) |
| Rifle, Uzi | Hold while an enemy is in the cone, or when boxed in (tracers erase trails) |
| Bomb | Fire only with a long clear path ahead (blast radius would kill the bot) and an enemy roughly ahead |
| Lock Borders | Fire shortly after pickup when away from the borders |
| Turbo | Hold on long clear straights (`hard` only) |
| Slow | Hold while any enemy is alive |

### Match-ups

`normal` and `hard` bots know which weapon beats which, and how satellites change things
([projectiles.md](./projectiles.md), [bodyguards.md](./bodyguards.md)). `easy` bots do not.
Everything they use is on screen: who holds what is shown in the side panel.

For every enemy the bot takes a **stance** (`src/game/ai/matchups.ts`), the first rule
that applies:

| Situation | Stance |
|-----------|--------|
| The enemy has satellites and I hold the H-bomb (the only thing that destroys them) | seek |
| The enemy has one satellite and I hold the shotgun (sustained fire gets past it) | neutral |
| The enemy has satellites, anything else | avoid |
| I have satellites, the enemy has none and no H-bomb | seek (the satellites do the killing) |
| The enemy holds the H-bomb and I hold a tracer weapon (which can set it off at a distance) | neutral |
| The enemy holds the H-bomb, otherwise | avoid |
| I hold the H-bomb | seek |
| My gun beats theirs: Uzi or shotgun against Glock (tracers stop bullets), shotgun or rifle against Uzi, rifle against shotgun (range) | seek |
| Their gun beats mine (the same pairs reversed) | avoid |
| I hold a gun and the enemy holds none | seek |
| The enemy holds a gun and I hold none | avoid |
| Otherwise (same gun, Glock against rifle, nobody armed) | neutral |

What the stance does:

- **Seek**: with no item to fetch, the bot heads for the nearest enemy it has the
  advantage over. `normal` bots only go after such enemies; `hard` bots also hunt neutral
  ones, as before. Nobody hunts an enemy they should avoid.
- **Avoid**: with no item to fetch and such an enemy within 180 px, the bot's goal is a
  point directly away from it.
- **Lines of fire**: the cone in front of every enemy holding a gun or the H-bomb counts
  like the fire zone of a level gun, making paths through it less attractive — twice as
  much when the stance is *avoid*. Cones: Glock 300 px ± 7°, rifle 400 px ± 6°, shotgun
  260 px ± 9°, Uzi 60 px ± 32°, H-bomb 220 px ± 12°.
- **Firing**: a bot does not waste shots that cannot work. It never fires the Glock at a
  guarded enemy (the bullet would bounce back), nor the rifle or Uzi; the shotgun only at
  an enemy with a single satellite. The target is the nearest enemy worth shooting at.
- **Shooting things down**: with the Uzi, shotgun or rifle, a bot fires at an enemy bullet
  coming its way, and at an H-bomb coming its way while it is still more than 75 px off.

### Round flow

During `waiting_ready` a bot presses action once (after a short delay) if it is not marked
ready. Under *Control Reversal*, the planner on its own compensates by inverting its
output after a fixed delay (`reverseReactionTicks`); with the human layer — the default —
it never learns about the reversal and the bot's hands have to relearn the controls
([bots-human.md](./bots-human.md)).

### Difficulty

| | easy | normal | hard |
|-|------|--------|------|
| Lookahead (px) | 60 | 130 | 220 |
| Re-plan every (ticks) | 6 | 3 | 1 |
| Safety margin (px) | 0 | 1 | 1 |
| Random steering mistakes | yes | rare | no |
| Seeks items | sometimes | yes | yes |
| Uses weapons | boxed-in only | yes | yes, + turbo |
| Avoids enemy heads / bodyguards | no | yes | yes |
| Hunts enemies | no | when it has the advantage | yes, except when at a disadvantage |
| Knows the weapon and satellite match-ups | no | yes | yes |

### Bots in network games

- Lobby slots gain a `kind: 'human' | 'ai'` field. The host can add an AI to any open slot
  and remove it again; AI slots use the pseudo peer id `ai:<slot>` and a generated name.
- Bots run inside the host's `HostSession`; guests need no changes (a bot is just another
  remote player).
- A host alone with bots can start a game (useful to test the network path solo).

## Automated gameplay validation

Because sessions and bots are headless and seeded, CI can play the game:

- **Rule tests** (`tests/rules.test.ts`): scripted situations.
- **Fuzz** : random inputs on real levels; no exceptions, invariants hold, deterministic.
- **Bot matches** (`tests/bots.test.ts`): many seeded rounds per level, asserting
  - every round terminates,
  - bots survive far longer than a player driving straight / steering randomly,
  - bots almost never die in the first seconds on any level,
  - `hard` beats `easy` in a clear majority of rounds.
  These numbers are the regression baseline for bot quality.
- **Session tests**: a `HostSession` and `GuestSession` wired through a simulated link (see
  networking.md) to validate netcode.
- `npm run sim` prints a table of bot statistics per level for tuning.
