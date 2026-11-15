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
only changes what the planner *sees* and how its decisions *reach the keys* — with one
exception, the side margin below: a planner that knows its hands are imprecise must stop
planning hair's-breadth passes.

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

The planner's logic is **not modified** (one optional profile field was added, see
*Side margin*). The perceived world is created with
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
  cannot be shorter than ≈ 45–60 ms → 12–16° of turn); once released it stays up at
  least 1 tick.
- **Panic over-steer**: when panicking, releases are `panicOversteer` ticks later —
  people hold the turn too long when a wall is close.

Late releases overshoot, the planner (which sees the true heading) asks for a correction,
and the correction is itself a clumsy tap: paths wobble slightly instead of being ruler
straight, more so for `easy`. Speed effects need no special case: lag is in *time*, so
under Turbo the same lag is twice as many pixels, and under Slow half.

### Side margin

The planner checks its candidate paths pixel by pixel and is happy to pass one pixel
away from a wall, or to stop a turn on the exact tick that leaves it skimming a trail.
With perfect keys that works; with a release that comes two ticks late (8° more turn)
it is a crash — measured: bots died in the first second of a round by over-turning into
a wall the plan cleared by a pixel.

People know their hands and leave room. So the planner gets one more profile field,
`BotProfile.sideMargin` (pixels, default 0 = old behaviour), set by `HumanBot` from the
human profile. In a rollout, every step between the 4th and the 40th that has something
solid within `sideMargin` pixels on either side adds a penalty (the same weight as a
step in a corridor), for at most a twelfth of the lookahead (5 steps for `easy`, 11 for
`normal`, 15 for `hard`). It is a penalty, not a wall, and a bounded one: a gap can
still be threaded when there is nothing better, and a tight path beats one that crashes
much earlier. (Unbounded, the penalty can outweigh a whole path of `easy`, whose plans
are only 60 px long: crashing would score better than squeezing.) Nearer than 4 steps
nothing can be done about it any more; further than 40 the path will have been
re-planned.

For the same reason the bot gives enemy heads more room: `BotProfile.headMargin` is
added to the 4 px radius of the "enemy head" hazard. The bot knows its picture of an
enemy is `trackDelay` old; in that time the enemy can have turned up to 60° and be half
a dozen pixels from where it is believed to be. Measured before this margin: bots racing
an enemy for the same item were cut off and died a few seconds into the round.

These are the only changes inside `BotController` (a dozen lines in the rollout loop,
one in `collectHazards`, both inactive at 0). How far the side margin goes towards "no
superhuman threading of gaps" is measured under *Results → Steering*: clearly for
`normal`, not for `hard`.

### Changed controls (Control Reversal)

The planner never learns about the reversal (the perceived self has no `reverse`
effect); it keeps asking for "left". Which key that means is the motor's problem:

1. **Not noticed yet**: until the bot notices, every press uses the old mapping → the
   bike turns the wrong way. It notices `reverse.notice` ticks after the effect starts
   (it saw what it picked up) or, if it steers before that, when it catches its first
   wrong-way turn (see 3).
2. **Knows, but the habit is strong**: afterwards each new press *slips* (uses the old
   mapping) with probability `p(t) = slip × exp(−t / adapt)`, `t` being the time since
   noticing. Panic multiplies `p` by 1.5 (capped at 1). For 60 ticks after catching a
   slip the player is on guard and `p` is a quarter of that.
3. **Catching a slip**: a wrong-way press is noticed `reverse.catch` ticks later (the
   bike is visibly turning the other way) and flipped. The player then
   **over-corrects**: the corrected press is held
   `overCorrect × (ticks spent going the wrong way)` ticks longer than intended. A press
   released before it is caught is not corrected at all — short taps under reversal
   simply go the wrong way.
4. **After-effect**: when the reversal ends the same thing happens in the other
   direction, shorter: notice × 0.5, `slip × 0.5`, `adapt × 0.3`.

A key that is already down when the effect starts or ends stays down: the bike suddenly
turns the other way until the bot notices.

### Disorientation

When a bot's own position jumps (the *Swap* item, or a portal), it needs time to find
itself again: for `disorient` ticks (half of that for a portal, which is at least
expected) it does not react to anything and does not fire. A steering key that was down
stays down for a startled moment (5 ticks) and is then let go.

### Trigger

- **Hesitation**: when the planner starts wanting to fire, the first press comes
  `fireHesitation` ticks later (drawn per engagement; wanting to fire again within 15
  ticks is the same engagement and needs no new hesitation).
- **Commitment**: that first shot goes out even if the chance has passed in the
  meantime (up to 24 ticks ago) — people shoot where the target *was*. Later shots of
  the engagement are only fired while the planner still wants them. Only guns are
  committed to (Glock, shotgun, rifle, Uzi), and not in a panic: an H-bomb, or a Glock
  bullet into a wall at arm's length, kills the shooter.
- **Tap rate**: single-shot weapons (Glock, shotgun, H-bomb, Lock Borders) are tapped
  every `tapPeriod` ticks (drawn per tap), each press lasting 3 ticks, instead of the
  planner's metronomic 8.
- **Hold weapons** (rifle, Uzi, Turbo, Slow): pressed after the hesitation for at least
  6 ticks, released `steerLag + 2` ticks after the planner stops wanting to fire.
- Ready-up between rounds is passed through untouched.

## Parameters per profile

Ranges are uniform, in ticks unless noted (1 tick = 14.3 ms).

| | easy | normal | hard |
|-|------|--------|------|
| `trackDelay` (tracked enemies) | 24 (340 ms) | 15 (215 ms) | 11 (160 ms) |
| `surprise` (new item, shot, weapon change) | 35–55 (500–790 ms) | 22–32 (315–460 ms) | 16–22 (230–315 ms) |
| `attention` (enemies tracked continuously) | 1 | 2 | 3 |
| `glance` (unattended enemies) | 50–90 | 35–60 | — |
| `aimSigma` (degrees) | 4 | 2 | 1.2 |
| `fireHesitation` | 14–30 | 7–14 | 4–9 |
| `tapPeriod` | 13–20 | 10–13 | 8–10 |
| `steerLag` | 0–2 | 0–2 | 0–1 |
| `minPress` | 4 | 4 | 3 |
| `sideMargin` (px, planner) | 2 | 2 | 1 |
| `headMargin` (px, planner; `easy` does not mind heads at all) | 10 | 7 | 5 |
| `panicDist` (px) | 28 | 20 | 14 |
| `panicOversteer` | 0–1 | 0–1 | 0–1 |
| `reverse.notice` | 40–70 | 22–34 | 14–20 |
| `reverse.slip` (probability right after noticing) | 0.8 | 0.75 | 0.5 |
| `reverse.adapt` (time constant) | 300 (4.3 s) | 150 (2.1 s) | 50 (0.7 s) |
| `reverse.catch` | 12–20 | 10–16 | 7–11 |
| `reverse.overCorrect` | 0.6 | 0.6 | 0.3 |
| `disorient` | 30–50 | 18–28 | 10–16 |

(Control Reversal lasts 700 ticks: `hard` is fluent after about two seconds, `normal`
makes mistakes for most of the first half, `easy` still slips now and then at the end.)

The motor figures of `easy` and `normal` are deliberately close. `easy` is already
clumsy at the wheel through its planner (60 px lookahead, a decision every 6 ticks,
random mistakes); with slower hands on top (lag 1–4, presses of 5 ticks) 52 % of the
`easy` bots were dead 12 s into a round, against 28 % before. What sets `easy` apart in
this layer is how late it notices things, how badly it aims and how long reversed
controls confuse it.

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

## Trying it

- **Live**: `npm run dev`, open the page, *LOCAL GAME*, set the slots to AI (all four
  for an attract-mode game, or keep one human) and START. Add `?human=0` to the URL for
  the old perfect bots, `?human=0.5` for half the imperfection, `?human=2` for double.
  Things to look for: slightly wavy lines instead of ruler-straight ones, no single-tick
  taps, shots that go behind a crossing target, and a bot that picks up Control Reversal
  (the item with the two opposed arrows) zig-zagging for a few seconds.
- **Pictures**: `npm run bots:trace` writes `out/bot-trace.html`: old and human bots in
  the same seeded situations — heading and key presses through a Control Reversal, key
  presses in ordinary driving, trails of whole rounds.
- **Numbers**: `npm run sim:human` prints the tables below (about an hour on one core;
  `HUMAN_REPORT=range,reversal npm run sim:human` runs only some sections, `ROUNDS=0.5`
  halves the sample).
- **In the real app, headless**: `npm run test:e2e:bots` plays an all-AI local game in
  headless Chrome (`E2E_SHOTS=out` saves screenshots, `E2E_QUERY=human=0` the old bots).

## Validation

Unit tests (`tests/bot-human.test.ts`) pin each mechanism:

- no reaction to a new item / a turning enemy before the delay;
- the aim error has the specified standard deviation and grows with distance;
- steering changes are never faster than `minPress` and lag within `steerLag`;
- Control Reversal produces wrong-way steering at onset, recovery afterwards, a smaller
  disturbance at the end, and `hard` adapts faster than `easy`;
- trigger hesitation and tap rate;
- strength 0 reproduces the old bot input-for-input; a seed reproduces a match.

- the planner threads a 3-pixel gap on its own and refuses it with the side margin.

Match statistics (`npm run sim:human`, see results below) check that the ordering
easy < normal < hard holds, that `normal` still beats `straight` on every level, and
that bots do not die in the opening seconds.

`tests/bots.test.ts` (the regression thresholds of local-and-ai.md) is unchanged except
for one thing: the early-death check now plays three seeds instead of one, with the same
5 % ceiling. A seed lays the items out the same way on every level, so one unlucky race
for an item used to be counted once per level.

## Results

Measured with `npm run sim:human` on the final parameters. "Old" is the planner alone
(strength 0, identical to the bots before this layer); "human" is strength 1. Everything
is seeded, so the "old" columns reproduce exactly.

A warning about noise first: rounds of this game have a very long tail. Medians of a
few dozen rounds swing by tens of seconds from one set of seeds to the next, and win
rates over 30 rounds by ±9 points. The tables below use 80 rounds per duel and shares
rather than medians; smaller differences than about 10 points mean nothing.

### Order of the profiles

Duels, 80 rounds per cell, both seatings; win rate of the first (the rest are losses,
draws and time-outs):

| Level | Match-up | Old | Human |
|-------|----------|-----|-------|
| blank | hard vs easy | 81 % | 70 % |
| blank | hard vs normal | 50 % | 59 % |
| blank | normal vs easy | 83 % | 78 % |
| bricks | hard vs easy | 86 % | 80 % |
| bricks | hard vs normal | 51 % | 56 % |
| bricks | normal vs easy | 80 % | 76 % |
| selva | hard vs easy | 70 % | 70 % |
| selva | hard vs normal | 60 % | 59 % |
| selva | normal vs easy | 75 % | 71 % |

easy < normal < hard holds on all three levels. (Hard against normal was a coin toss
before, on blank and bricks; it is now a little clearer.)

4-player free-for-all on blank (easy, normal, hard, hard), 80 rounds: old 4 / 35 / 30 /
29 % of the wins, median round 24 s; human 9 / 34 / 30 / 26 %, median round 39 s.

Human against old, same profile, blank, 80 rounds: easy wins 31 % (loses 69 %), normal
35 % (63 %), hard 45 % (55 %). That is the price of being human.

`normal` against a player driving straight, 20 rounds per level: old 100 % everywhere;
human 100 % on six levels and 95 % on bricks and dentistry (one round lost on each).

### Not dying stupidly

Deaths in the first 3 s (calm normal against calm hard, 40 rounds on each of the 8
levels): old 4 of 640 bots (0.6 %), human 8 of 640 (1.3 %). The remaining early deaths
are of the kind "two bots race for the same item and one is cut off".

Left alone (calm mirror matches cut at 45 s, 48 bots per cell): share dead within 20 s,
all 8 levels pooled (384 bots per cell):

| | Old | Human |
|-|-----|-------|
| easy | 69 % | 78 % |
| normal | 39 % | 44 % |
| hard | 38 % | 37 % |

Per level the numbers scatter widely (hard on blank: 54 % old, 42 % human; easy on
blank: 33 % old, 67 % human). `easy` is the one that pays most: its planner was tuned to
be as weak as is fun with perfect hands.

### Control Reversal

A calm bot is given the effect 2 s into the round; deaths during the 10 s it lasts, out
of the rounds in which the bot was alive when it started (bricks and blank). "None" is
the same rounds without the effect:

| | Old: none | Old: reversed | Human: none | Human: reversed |
|-|-----------|---------------|-------------|-----------------|
| easy | 14/47 | 16/45 | 18/48 | 36/48 |
| normal | 6/47 | 5/47 | 6/48 | 20/48 |
| hard | 3/47 | 3/47 | 7/48 | 10/47 |

The old bots did not care about the item at all. Now it kills `easy` three times out of
four, `normal` four times out of ten and `hard` hardly more often than usual.

### Weapons

Shooting range: an armed bot and an unarmed target wandering 120–260 px away (40–90 px
for the Uzi) in an empty arena, 8 s, 150 trials. Error = angle between the heading and
the direction to the target when the trigger is pulled.

| Weapon | Bot | Shots per trial | Error: median | Error: 90th pct. | Kills per trial |
|--------|-----|-----------------|---------------|------------------|-----------------|
| Glock | old normal | 4.3 | 3.6° | 5.5° | 0.18 |
| Glock | human normal | 7.8 | 8.9° | 18.6° | 0.09 |
| Glock | old hard | 5.1 | 4.5° | 5.8° | 0.18 |
| Glock | human hard | 5.6 | 6.7° | 10.4° | 0.11 |
| Shotgun | old normal | 2.2 | 5.2° | 7.6° | 0.69 |
| Shotgun | human normal | 7.6 | 10.4° | 19.0° | 0.40 |
| Shotgun | old hard | 3.2 | 5.9° | 7.5° | 0.60 |
| Shotgun | human hard | 5.3 | 8.2° | 11.8° | 0.41 |
| Rifle (ticks of fire) | old normal | 20.8 | 2.9° | 4.6° | 0.02 |
| Rifle | human normal | 57.7 | 8.3° | 18.2° | 0.01 |
| Rifle | old hard | 20.4 | 3.3° | 4.8° | 0.07 |
| Rifle | human hard | 31.4 | 6.1° | 10.0° | 0.00 |
| Uzi (ticks of fire) | old normal | 255 | 6.4° | 12.4° | 0.37 |
| Uzi | human normal | 285 | 7.8° | 15.3° | 0.29 |
| Uzi | old hard | 262 | 5.5° | 11.1° | 0.37 |
| Uzi | human hard | 260 | 6.0° | 12.5° | 0.35 |

The first shot comes 0.2–0.3 s after the engagement starts instead of 0.1 s. Guns that
need precision (Glock, shotgun) kill about half as often; the Uzi, which sprays a wide
cone at short range, hardly changes. `normal` wastes noticeably more ammunition than
`hard`.

In real play (4-player free-for-alls of one profile on blank and bricks, about two
bot-hours per row) the bots pull the trigger much less often than before — the old ones
fired the instant anything crossed their cone — and kill about as often with what they
fire:

| Bot | Glock: pulls / kills | Shotgun | Rifle: ticks / kills | Uzi: ticks / kills |
|-----|----------------------|---------|----------------------|--------------------|
| old normal | 370 / 12 | 335 / 22 | 5869 / 8 | 5562 / 12 |
| human normal | 142 / 5 | 56 / 5 | 4269 / 20 | 3320 / 15 |
| old hard | 454 / 15 | 215 / 22 | 4852 / 12 | 4620 / 15 |
| human hard | 99 / 4 | 71 / 7 | 4546 / 11 | 4853 / 20 |

(Kill counts this small are noisy; read them as "same order of magnitude".)

### Steering

Same free-for-alls:

| Bot | Key changes per second | Time spent turning | Gaps threaded per minute | Squeezed (ticks per minute) |
|-----|------------------------|--------------------|--------------------------|-----------------------------|
| old normal | 4.7 | 36 % | 0.81 | 6.9 |
| human normal | 5.6 | 47 % | 0.46 | 11.3 |
| old hard | 6.4 | 34 % | 0.87 | 11.3 |
| human hard | 5.7 | 40 % | 1.43 | 14.6 |

"Squeezed" = something solid within 2 px on both sides at once (and still alive 15 ticks
later); "gap threaded" = squeezed for at most 6 ticks, coming from the open. `normal`
threads gaps about half as often as before. `hard` does not — more often, if anything —
and a 2 px margin instead of 1 did not change that (1.6 per minute), so its gaps are
not planned squeezes; they probably are the holes it shoots into trails, which this
measure cannot tell apart. Both spend more time in tight places than the old bots:
imprecise driving leaves less room. See *Open points*.

In the planner's own terms the margin works (unit test): a 3 px gap in a wall is driven
through at margin 0 and 1 and refused at margin 2; a 1 px gap is refused at margin 1.

### Strength dial

`hard` at strength `s` against the old `normal` bot, blank and bricks, 80 rounds:

| s | wins | loses |
|---|------|-------|
| 0 | 53 % | 48 % |
| 0.5 | 57 % | 43 % |
| 1 | 39 % | 61 % |
| 1.5 | 38 % | 63 % |
| 2 | 33 % | 66 % |

Half strength costs nothing measurable; the default costs about 15 points against a
perfect opponent. (Left alone on blank, the share dead within 20 s shows no trend with
`s`: 54, 50, 42, 50, 42 % of 48 bots.)

### Cost

Time of one decision per bot (Node 26 on an arm64 Mac; duels on blank and bricks; a
phone will be several times slower across the board):

| | Old | Human | |
|-|-----|-------|-|
| easy | 0.021 ms | 0.038 ms | +0.017 ms |
| normal | 0.355 ms | 0.385 ms | +8 % |
| hard | 0.602 ms | 0.610 ms | +1 % |

The layer itself costs under 0.02 ms per bot and tick; the rest of the difference for
`normal` is the side-margin check in the rollouts (two more pixel look-ups on some of the
first 40 steps of a path). Nothing to worry about next to the planner; the planner's own
cost (TODO.md) is unchanged.

### Regression tests

The statistics behind the assertions of `tests/bots.test.ts`, for the old bots and the
human ones:

| Assertion | Old | Human |
|-----------|-----|-------|
| early deaths ≤ 5 % (one seed, as before) | 1/64 | 3/64 |
| early deaths ≤ 5 % (three seeds, as now) | 1/144 | 3/144 |
| round between two calm normals ≥ 20 s: blank / bricks | 22.3 s / 37.0 s | 27.0 s / 47.3 s |
| hard beats easy > 60 % (28 rounds) | 23/28 | 20/28 |
| the same over six seeds | 64/84 (76 %) | 61/84 (73 %) |
| normal beats straight ≥ 4/5 on every level | 5/5 everywhere | 5/5, dentistry 4/5 |

Everything passes with the original thresholds. The early-death check was changed to
three seeds anyway: with one seed the human bots sit at 3/64 = 4.7 %, one unlucky race
away from the 5 % ceiling.

## Open points

- **Trail pixels are seen at once.** The reaction-time model covers heads, items, shots
  and weapons, not the grid. A wall that appears (a door, a trail drawn across the path
  by an enemy the bot was not watching) is reacted to on the next plan.
- **Tight places.** The side margin makes the planner refuse narrow gaps, but in play the
  human bots still spend more time squeezed than the old ones, and `hard` threads more
  gaps, not fewer. Needs a look at where those moments come from (replays) before more
  tuning.
- **Aim only ever gets worse.** A good player who knows the target is moving leads the
  shot. The bots extrapolate where the enemy *is*, not where the bullet will meet it —
  as before, but it shows more now that their timing is human.
- **easy** is weaker than it was (78 % against 69 % dead within 20 s when left alone,
  31 % of the wins against its old self). If it turns out too weak to be fun, lower
  the strength for easy only, or relax its planner a little (its 6-tick re-plan interval
  was itself a crude reaction time).
- **Noise in the regression tests.** `hard beats easy` runs 28 rounds against a 60 %
  floor with a true rate near 73 %; it will fail by chance one day (it would have for
  the old bots too, a little later). More rounds cost test time.
