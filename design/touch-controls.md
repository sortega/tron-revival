# Touch Controls

How a phone or tablet steers. Status: **experiment** — three steering modes are selectable
in-game so they can be compared on real devices; the losers will be removed (`swipe`, a
trackball-like fourth mode, already was).

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

### Where the controls sit

The canvas (4:3) is centred on a wider screen, which leaves a margin on each side: 162 px
on a 844 × 390 phone. The controls live in that margin and are sized by it, so that they
do not cover the arena:

| Control | Size |
|---------|------|
| Steering pads (`buttons`) | Two side by side, each `(margin − 18) / 2` wide, between 52 and 84 px; 84 px high |
| Stick (`classic`) | `margin − 10` across, between 72 and 100 px. A smaller stick has less travel; the same share of it gives the same steer |
| Action button | `margin − 12` wide, between 60 and 84 px; 84 px high |
| Top buttons | Leave ✕ and lobby on the first row at the left, the steering mode button below them; sound and full screen at the right |

Below the minimum (a screen close to 4:3, such as a tablet, has no margin at all) the
controls keep their minimum size and overlap the arena by what is missing. The margin is
measured when the game starts and whenever the window is resized or rotated
(`--side` on the layout element).

A touch counts anywhere in the steering area, whatever the size of what is drawn.

### The action button

It looks like the steering pads (same shape, colours and pressed state) and says what a
press does now:

| When | Label |
|------|-------|
| Playing, alive | `ACTION` |
| Between rounds, not ready yet | `READY` |
| Between rounds, ready | `NOT READY` (a press takes it back) |
| Countdown, or dead while the round goes on | `ACTION`, dimmed |

| Mode | Label | How it works |
|------|-------|--------------|
| `buttons` | BUTTONS | Binary, the same as a keyboard. Two large pads, ◀ and ▶, at the bottom left. A touch anywhere in the steering area counts by which side of the pads' centre line it is on, so the thumb can slide between them without lifting. Both sides at once = straight. |
| `heading` | POINT | "Point where you want to go". Touch anywhere in the steering area: that point becomes the centre of a stick. Drag the thumb away from it: the direction of the drag **on screen** is the direction the player turns to, at full rate, and then holds. Within 14 px of the centre nothing changes. If the thumb moves more than 50 px away the centre follows it, so reversing never needs a long drag. Releasing = straight on. |
| `classic` | STICK | The original proportional stick, kept as the baseline for comparison. |

Default: `buttons` (the only mode known to be as good as a keyboard) until testing picks a
winner.

### Selecting a mode

A button in the top bar of the mobile layout shows the current mode and cycles to the next
when tapped. The choice is stored in `localStorage['teratron-touch-mode']`. It can be
changed in the middle of a game.

### Turning towards a heading (`heading`)

The mode keeps a **target heading** and derives `steer` from the player's current heading
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

Under *Control Reversal* the simulation negates `steer` as for any other input. With a
target heading that means the player turns to the **opposite** of where the thumb points —
a consistent "everything is backwards", and still controllable.

## Implementation

- `src/game/input/touchSteering.ts` — pure functions (`steerTowards`, `classicSteer`,
  `angleDiff`), unit-tested.
- `src/game/input/TouchControls.ts` — DOM and touch handling for the three modes; exposes
  `getSteer(currentHeading)`, `getAction()` and `showAction(label, enabled)`.
- `InputManager` delegates to it for the touch slot; `TronGame` provides the heading.

## Validation

- Unit tests: `steerTowards` converges without overshoot for 1–5 pixel-steps per tick and
  takes the shortest way round; the classic curve is unchanged.
- Browser test (`tests/e2e/touch.e2e.mjs`, phone emulation with synthetic touches): in
  every mode a touch gesture turns the player the expected way and by the expected amount;
  on a phone-sized screen every control is beside the arena, and the stick shrinks to its
  minimum on a 4:3 screen; the action button's label follows the round.
- Feel can only be judged by hand on a real phone.
