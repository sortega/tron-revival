# Human-like Bots

Bots used to perceive the exact game state every tick and steer with perfect precision.
This document specifies a **humanisation layer** that makes them play like people of
different skill: they react late, press keys clumsily, miss shots, and get confused when
their controls change.

Related: [local-and-ai.md](./local-and-ai.md) (the planner, profiles, match-ups).

## Goals

- Reaction time: bots act on a delayed, selectively attended view of the world. Surprises
  (an item appears, somebody fires, somebody picks up a gun) take longer than following
  something already being watched.
- Motor imprecision: no tick-perfect turns, no 1-tick taps; key presses have a minimum
  length and jittered timing, so turns over- and undershoot.
- Aim uncertainty: the heading at which a bot fires is off by an error that grows with
  distance, with how fast the target sweeps across, and with the bot's own turning. Bots
  hesitate before pulling the trigger and tap at a human rate.
- Changed controls: under *Control Reversal* bots steer the wrong way, wobble,
  over-correct and adapt gradually; they are briefly confused again when it ends.
- Skill levels differ: `hard` is a good human (≈160 ms), `easy` a slow, clumsy one.
- Everything stays deterministic for a seed, and cheap (a phone hosts the game).

Non-goals: changing what the planner wants to do (goals, match-ups, rollouts). The layer
only changes what the planner *sees* and how its decisions *reach the keys*.

## Architecture

```
            TronGameState (truth)
                   │
        ┌──────────▼──────────┐
        │ Perception          │  src/game/ai/perception.ts
        │ delayed, attended,  │  builds a "perceived world": a view object that
        │ noisy view          │  inherits from the real game and overrides what
        └──────────┬──────────┘  the bot is wrong about
                   │ perceived TronGameState
        ┌──────────▼──────────┐
        │ BotController       │  the existing planner, unchanged
        │ (planner)           │
        └──────────┬──────────┘
                   │ intended { steer, action }
        ┌──────────▼──────────┐
        │ Motor               │  src/game/ai/motor.ts
        │ key presses, lag,   │  turns intentions into key presses
        │ control confusion   │
        └──────────┬──────────┘
                   │ TronInput
```

`HumanBot` (`src/game/ai/HumanBot.ts`) wires the three together and has the same shape as
`BotController` (`slot`, `decide(game)`), so sessions and the test harness use it as a
drop-in. `createBot(slot, difficulty, rng)` is the factory.

The planner is **not modified**. The perceived world is created with
`Object.create(game)`, and perceived players with `Object.create(player)`: anything the
layer does not override (collision grid, portals, doors, own position…) reads through to
the truth, so the planner can be optimised or rewritten independently as long as it keeps
reading the world through `TronGameState` / `TronPlayer` properties.

### Strength

Every `HumanProfile` is scaled by a single **strength** `s`:

- `s = 0`: the layer is bypassed; the bot is exactly the old perfect `BotController`.
- `s = 1`: the profile as specified below (the default).
- in between / above: delays, jitter and angular errors scale linearly with `s`;
  probabilities scale and are clamped to 1.

`BOT_HUMANISATION` in `humanProfiles.ts` is the global default; `createBot` and
`HostSessionOptions.botHumanisation` take an override. In the browser,
`?human=<number>` in the URL sets it for the session (e.g. `?human=0` to compare with
the old bots).

## Perception

Ticks below are simulation ticks (70 per second, 14.3 ms each).

### What is delayed, and what is not

| Thing | Model |
|-------|-------|
| Own position and heading | Exact. People do not see themselves late: they predict the result of their own key presses (the errors of that prediction are modelled in the motor layer). |
| Walls and trails | Exact (current grid). A copy of a 750×600 grid per bot is unaffordable, and most of what a bot reacts to in the grid has been there for a while. The part that *is* new — the last few pixels behind an enemy head — is covered by the head model below. |
| Enemy heads | **Tracked**: the bot sees where the enemy was `trackDelay` ticks ago and extrapolates in a straight line at the speed seen then. An enemy that turns is therefore misplaced until the delay has passed. |
| Unattended enemies | A bot follows only its `attention` nearest enemies continuously. The others are **glanced** at every `glance` ticks; between glances they are extrapolated from the last glance (for at most 30 ticks, then they stay where they were last thought to be). |
| Enemy weapon | A change (pick-up, running out) is noticed after a `surprise` delay. Stances and lines of fire use the perceived weapon. |
| Items | A new item is invisible for a `surprise` delay. An item that disappears is still believed to be there for `trackDelay` ticks. Items present when the round starts are known (there is a countdown to look at them). |
| Projectiles | Invisible for a `surprise` delay after being fired, then exact. |
| Own effects | Exact, except *Control Reversal*, which is hidden from the planner and handled by the motor layer. |
| Satellites, doors, level guns | Exact. |

`surprise` is a range; each event draws its own delay uniformly from it.

### Aim error

On top of the delay, each enemy's perceived position is rotated around the bot by an
**aim error** `e` (degrees), a slowly varying random process (first-order
autoregressive, correlation time ≈ 0.4 s, refreshed every 4 ticks) with standard
deviation

```
σ = aimSigma × (1 + dist / 300) × (1 + 1.5 × |bearing rate|) × (1 + 0.6 × turning)
```

- `dist`: distance to the enemy in pixels (σ doubles at 300 px);
- `bearing rate`: how fast the direction to the enemy changes, in degrees per tick
  (a target crossing at 1 px/tick at 100 px is ≈ 0.57°/tick → σ × 1.9);
- `turning`: fraction of the last 20 ticks the bot itself spent steering.

The planner aims and fires at the perceived position, so the heading of a shot is off by
the planner's own firing cone (unchanged) plus `e` plus the tracking lag. Because `e` is
correlated in time, a burst goes wide together and then drifts back, as a person's does.
At point-blank range the error in pixels is negligible, so collision avoidance is barely
affected.

### Tunnel vision

When the free distance straight ahead drops below `panicDist`, the bot **panics**: it
stops glancing at unattended enemies and does not notice new items or shots (their
timers do not run) until it is out of trouble. Panic also affects the motor layer.

## Motor

### Steering keys

The planner outputs an intended steer (−1, 0, +1) each tick. A person turns that into
key presses:

- **Lag**: each *change* of intention reaches the key `steerLag` ticks later (drawn per
  change). A change that is withdrawn before it lands never happens.
- **Minimum press**: once pressed, a key stays down at least `minPress` ticks (a tap
  cannot be shorter than ≈ 45–70 ms → 12–20° of turn); once released it stays up at
  least 1 tick.
- **Panic over-steer**: when panicking, releases are `panicOversteer` ticks later —
  people hold the turn too long when a wall is close.

Late releases overshoot, the planner (which sees the true heading) asks for a correction,
and the correction is itself a clumsy tap: paths wobble slightly instead of being ruler
straight, more so for `easy`. Speed effects need no special case: lag is in *time*, so
under Turbo the same lag is twice as many pixels, and under Slow half.

### Changed controls (Control Reversal)

The planner never learns about the reversal (the perceived self has no `reverse`
effect); it keeps asking for "left". Which key that means is the motor's problem:

1. **Not noticed yet**: for `reverse.notice` ticks after the effect starts, every press
   uses the old mapping → the bike turns the wrong way.
2. **Knows, but the habit is strong**: afterwards each new press *slips* (uses the old
   mapping) with probability `p(t) = slip × exp(−t / adapt)`, `t` being the time since
   noticing. Panic multiplies `p` by 1.5 (capped at 1).
3. **Catching a slip**: a wrong-way press is noticed `reverse.catch` ticks later and
   flipped. The player then **over-corrects**: the corrected press is held
   `overCorrect × (ticks spent going the wrong way)` ticks longer than intended.
4. **After-effect**: when the reversal ends the same thing happens in the other
   direction, shorter: notice × 0.5, `slip × 0.5`, `adapt × 0.3`.

A key that is already down when the effect starts or ends stays down: the bike suddenly
turns the other way until the bot notices.

### Disorientation

When a bot's own position jumps (the *Swap* item, or a portal), it needs time to find
itself again: the keys are frozen in their current state and it does not fire for
`disorient` ticks (half of that for a portal, which is at least expected).

### Trigger

- **Hesitation**: when the planner starts wanting to fire, the first press comes
  `fireHesitation` ticks later (drawn per engagement).
- **Tap rate**: single-shot weapons (Glock, shotgun, H-bomb, Lock Borders) are tapped
  every `tapPeriod` ticks (drawn per tap), each press lasting 3 ticks, instead of the
  planner's metronomic 8.
- **Hold weapons** (rifle, Uzi, Turbo, Slow): pressed after the hesitation, released
  `steerLag + 2` ticks after the planner stops wanting to fire.
- Ready-up between rounds is passed through untouched.

## Parameters per profile

Ranges are uniform, in ticks unless noted (1 tick = 14.3 ms).

| | easy | normal | hard |
|-|------|--------|------|
| `trackDelay` (tracked enemies) | 24 (340 ms) | 15 (215 ms) | 11 (160 ms) |
| `surprise` (new item, shot, weapon change) | 35–55 (500–790 ms) | 22–32 (315–460 ms) | 16–22 (230–315 ms) |
| `attention` (enemies tracked continuously) | 1 | 2 | 3 |
| `glance` (unattended enemies) | 50–90 | 35–60 | — |
| `aimSigma` (degrees) | 4 | 2.2 | 1.2 |
| `fireHesitation` | 18–40 | 10–20 | 6–12 |
| `tapPeriod` | 13–20 | 10–13 | 8–10 |
| `steerLag` | 1–4 | 0–2 | 0–1 |
| `minPress` | 5 | 4 | 3 |
| `panicDist` (px) | 28 | 20 | 14 |
| `panicOversteer` | 0–4 | 0–2 | 0–1 |
| `reverse.notice` | 40–70 | 22–34 | 14–20 |
| `reverse.slip` (probability right after noticing) | 0.9 | 0.75 | 0.5 |
| `reverse.adapt` (time constant) | 420 (6 s) | 150 (2.1 s) | 50 (0.7 s) |
| `reverse.catch` | 16–28 | 10–16 | 7–11 |
| `reverse.overCorrect` | 1.0 | 0.6 | 0.3 |
| `disorient` | 30–50 | 18–28 | 10–16 |

(Control Reversal lasts 700 ticks: `hard` is fluent after about two seconds, `normal`
makes mistakes for most of the first half, `easy` slips on a quarter of its presses even
at the end.)

The planner's profile (`BotProfile`: lookahead, re-plan interval, mistakes…) is
unchanged, except that `reverseReactionTicks` is no longer used when the layer is active.

## Determinism

- The layer never calls `Math.random()`. `HumanBot` derives two streams from the bot's
  seeded RNG at construction (one for perception, one for the motor layer), so adding a
  draw in one layer does not shift the other, and bots do not perturb each other.
- All state (ring buffers, timers, error processes) lives in the `HumanBot` instance
  and is reset between rounds.
- Gaussian noise comes from the seeded stream (Box–Muller).

`tests/bots.test.ts` keeps asserting that a match is reproducible from its seed.

## Cost

The layer adds per bot and tick: one ring-buffer write per enemy, a scan of the item and
projectile lists, a handful of comparisons, and (every 4th tick) one Gaussian per enemy.
No grid access, no allocation in steady state (view objects are reused). Measured
numbers are in the results section.

## What is not modelled

- Late perception of *trail* pixels (see the table above).
- Colour blindness after a Swap (bots still know which bike is theirs once the
  disorientation is over).
- Fatigue, tilt, learning between rounds.
- Dodging projectiles (the planner does not do it yet either; see TODO.md).

## Validation

Unit tests (`tests/bot-human.test.ts`) pin each mechanism:

- no reaction to a new item / a turning enemy before the delay;
- the aim error has the specified standard deviation and grows with distance;
- steering changes are never faster than `minPress` and lag within `steerLag`;
- Control Reversal produces wrong-way steering at onset, recovery afterwards, a smaller
  disturbance at the end, and `hard` adapts faster than `easy`;
- trigger hesitation and tap rate;
- strength 0 reproduces the old bot input-for-input; a seed reproduces a match.

Match statistics (`npm run sim:human`, see results below) check that the ordering
easy < normal < hard holds, that `normal` still beats `straight` on every level, and
that bots do not die in the opening seconds.

## Results

(Filled in from `npm run sim:human`; see the end of this document.)
