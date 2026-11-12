# Touch Controls

How a phone or tablet steers. Status: **experiment** — four steering modes are selectable
in-game so they can be compared on real devices; the losers will be removed.

Related: [local-and-ai.md](./local-and-ai.md) (who gets the touch controls),
[networking.md](./networking.md) (prediction).

## Audit of the original touch control (mode `classic`)

What made it hard to control, from reading `InputManager`:

| Finding | Detail |
|---------|--------|
| Latency is **not** the cause | Guests predict their own player (`GuestSession`, on by default): the head turns on the same tick as the input, with or without network lag. Local and host games have no lag at all. |
| The stick is tiny | A fixed 90 px stick (45 px of travel, about 7 mm) in the bottom-left corner. |
| The response curve is very non-linear | `steer = (travel/45)^2.5`. Half travel gives 18 % of the turn rate, 80 % travel gives 57 %; the last 9 px go from 57 % to 100 %. Small corrections are sluggish and a sharp turn needs the thumb exactly on the rim. |
| Touch turns slower than a keyboard | A key is always full rate (280°/s). The stick only reaches that at full travel. |
| No reference point | The stick is static: a thumb that lands off-centre steers immediately, and without tactile feedback the thumb drifts. |

## Steering modes

All modes produce the same `TronInput.steer` in [-1, 1] that the simulation already
understands (turn of `steer × 4°` per pixel-step), so nothing changes in the simulation,
the wire format, prediction or bots.

The steering area is the **left half of the screen** below the top buttons; the action
button stays at the bottom right.

| Mode | Label | How it works |
|------|-------|--------------|
| `buttons` | BUTTONS | Binary, the same as a keyboard. Two large pads, ◀ and ▶, at the bottom left. A touch anywhere in the steering area counts by which side of the pads' centre line it is on, so the thumb can slide between them without lifting. Both sides at once = straight. |
| `heading` | POINT | "Point where you want to go". Touch anywhere in the steering area: that point becomes the centre of a stick. Drag the thumb away from it: the direction of the drag **on screen** is the direction the player turns to, at full rate, and then holds. Within 14 px of the centre nothing changes. If the thumb moves more than 50 px away the centre follows it, so reversing never needs a long drag. Releasing = straight on. |
| `swipe` | SWIPE | A trackball. Dragging horizontally turns the player by an angle proportional to the distance dragged (1.2° per px: 75 px = a right angle), at full rate. The turn completes even if the finger is lifted, so a quick flick is an exact turn. Vertical movement is ignored. |
| `classic` | STICK | The original proportional stick, kept as the baseline for comparison. |

Default: `buttons` (the only mode known to be as good as a keyboard) until testing picks a
winner.

### Selecting a mode

A button in the top bar of the mobile layout shows the current mode and cycles to the next
when tapped. The choice is stored in `localStorage['teratron-touch-mode']`. It can be
changed in the middle of a game.

### Turning towards a heading (`heading`, `swipe`)

Both modes keep a **target heading** and derive `steer` from the player's current heading
on every tick:

```
diff  = shortest signed angle from current to target      (-180°, 180°]
steer = clamp(diff / (TURN_SPEED × 3), -1, 1)
```

Far from the target this is full lock, like a key. The divisor is 3 turn-steps instead of 1
because a player can take several pixel-steps per tick (Turbo, speed-ups), each of which
turns: with a divisor of 1 the heading would overshoot and oscillate. With 3 there is no
overshoot at up to 3 steps per tick, and only a quickly damped one at 4–5.

The current heading comes from `session.getViewState()`, which for a network guest is the
**predicted** player, so the loop is not delayed by the network.

`swipe` keeps its target within ±170° of the current heading so the shortest way round
never flips.

Under *Control Reversal* the simulation negates `steer` as for any other input. With a
target heading that means the player turns to the **opposite** of where the thumb points —
a consistent "everything is backwards", and still controllable.

## Implementation

- `src/game/input/touchSteering.ts` — pure functions (`steerTowards`, `classicSteer`,
  `angleDiff`), unit-tested.
- `src/game/input/TouchControls.ts` — DOM and touch handling for the four modes; exposes
  `getSteer(currentHeading)` and `getAction()`.
- `InputManager` delegates to it for the touch slot; `TronGame` provides the heading.

## Validation

- Unit tests: `steerTowards` converges without overshoot for 1–5 pixel-steps per tick and
  takes the shortest way round; the classic curve is unchanged.
- Browser test (`tests/e2e/touch.e2e.mjs`, phone emulation with synthetic touches): in
  every mode a touch gesture turns the player the expected way and by the expected amount.
- Feel can only be judged by hand on a real phone.
