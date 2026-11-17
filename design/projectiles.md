# Projectile Collisions

How bullets, tracers and H-bombs decide what they hit. The weapons themselves are described
in [old-tron-design.md](./old-tron-design.md); this document covers the collision rules of
the rewrite, in `TronGameState.tickProjectiles`.

## Common rules

Every tick a projectile moves from its previous position to a new one. **Bullets and
bombs** are tested along the whole path they travel, in this order:

1. **Portals** teleport it.
2. **Solid pixels** (trails, scenery) on the path stop it: it explodes there.
3. **Players**: an alive player whose head is close enough to the path is hit. The owner is
   immune for the first 10 ticks so a shot does not hit its own shooter on the way out.
4. **Items**, then **other projectiles**.

**Tracers** work as in the original, where a tracer was a lit pixel that jumped: see
"Tracers act where they land" below.

The arena wraps around, and so does every one of these tests: the path is always the short
segment actually travelled. On the tick a projectile crosses an edge, the segment continues
past the edge and targets are compared at their position **and** at their wrapped-around
position. (A bug until Nov 2026: the segment was drawn from the old position to the
*wrapped* new one, across the whole arena, so a shot leaving through an edge hit anyone on
that row or column — typically its own shooter.)

| Projectile | Speed (px/tick) | Hits a player within | Effect on the player |
|------------|-----------------|----------------------|----------------------|
| Bullet (Glock) | 5 × speed factor | 6 px of the path | Explosion: kills everyone within 6 px, shield or not |
| Tracer (Rifle, Uzi, Shotgun, level guns) | 5–50 | 1 px on both axes of **where it lands** (the 3 × 3 pixels around the head) | Kills that player, shield or not |
| H-bomb | 2 | its body, see below | Blast: kills everyone within 50 px |

## Tracers act where they land

In the original (`PROCESS Traya`) a tracer is a point that jumps `speed` pixels per frame
and lights the pixel it lands on. The rewrite swept the whole path until Nov 2026, which
made every gun far deadlier than the original and let the first trail in the way absorb
all the fire. Now, each tick, a tracer:

1. jumps `speed` pixels (portals teleport it);
2. **on the way**, anywhere on the path: is stopped by a satellite, sets off a flying
   bomb, damages an item (these three tests are still swept, see below);
3. **where it lands**: kills every head within the 3 × 3 pixels around that pixel (not its
   owner in the first 10 ticks), and is *spent* if the pixel is solid, if it killed, or
   if its lifetime is over;
4. a spent tracer stays lit where it is for one more tick and then goes, **erasing the
   3 × 3 pixels around it**.

What follows from it:

- **Trails a tracer jumps over are untouched.** Guns fire through thin walls: a 1 px trail
  stops about 5 % of shotgun pellets and 3 % of Uzi tracers.
- **The Uzi eats trails**: 20 tracers a tick, each ending 10–50 px away in a ±30° cone and
  taking a 3 × 3 hole with it, whatever lies in between.
- **A rifle burst opens a 3 px hole** in a thin wall wherever it stands: fired while
  driving straight, its five tracers land on five different pixels of the line, so exactly
  one of them lands on the wall and the other four fly on.
- **Much less lethal per tracer.** A model of a stationary head (not the simulation):

  | | Landing points | Swept (until Nov 2026) |
  |---|---|---|
  | Shotgun blast kills at 60 / 100 / 200 px | 77 / 55 / 18 % | 100 / 100 / 74 % |
  | Uzi, one tick, head at 15 / 25 / 45 px | 25 / 16 / 9 % | 99 / 81 / 19 % |

- In the original the lit pixel was also solid for a frame. That is not modelled: the
  3 × 3 test where it lands covers it.

Kept swept on purpose, so that the match-ups below hold and satellites protect: bullets
against tracers (path against path), satellites against tracers (anything passing within
5 px), tracers against flying bombs and items.

### Swept tracers (experiment, 16 November 2026, not committed)

Playing with landing-point tracers, the rifle frustrates: a burst often jumps over the
trail right in front of the shooter, who then crashes into a trail "that should have been
destroyed". Under test, switched by `TRACER_SWEEPS` in `TronGameState`:

- A tracer checks its whole path each tick. It stops at the **first** solid pixel or head
  on it, kills that head, and is spent there: it stays lit a tick and then takes the 3x3
  pixels around that point. Nothing is jumped over.
- Everything else is as above (satellites, bombs and items on the path; Uzi range).

Consequences seen in the tests: a rifle burst now always opens the first wall it meets (the
five tracers of a burst hit the same spot, so one burst opens one 3 px hole per wall and
the next burst goes through it to the next wall); the Uzi no longer reaches over a thin
wall, it eats the nearest surface instead (73 px in four ticks where it ate more than 150
behind the wall); shotgun fire gets past a lone satellite a little more often (21 of the
sample against the limit of 18). The rate of kills on players crossing a rifle's line
stays within the 20–45 % of the test.

If kept: adjust the two tests that fail ("Uzi fire goes over a thin wall", "sustained fire
gets past a lone satellite"), rename the section above and let the bots know.

## Weapon match-ups

The firearms keep the original's rock-paper-scissors, which follows from four numbers
taken from `PROCESS Weapon` / `Traya` / `Disparo`:

| Weapon | Shots | Speed (px/tick) | Reach | Hits a player within |
|--------|-------|-----------------|-------|----------------------|
| Glock | 1 bullet per press, 20 | 5 | until it hits something | 6 px (explosion) |
| Rifle (AK-47) | bursts of 5 tracers, dead straight, 200 (11 s) | 5 | 600 px | 3 × 3 px where it lands |
| Shotgun | 30 pellets per press, ±5°, 20 blasts | 10–30 | 100–300 px | 3 × 3 px where it lands |
| Uzi | 20 tracers per tick while held, ±30°, 10 s | 10–50 for 1 tick | 10–50 px | 3 × 3 px where it lands |

- **Uzi beats Glock**: its cloud of tracers sets off incoming bullets (below). It loses to
  the shotgun and the rifle, which kill from far outside its 50 px.
- **Shotgun beats Glock** the same way, and is outranged by the rifle.
- **Rifle** has the longest reach but must pass within a pixel of the target; a Glock
  bullet only has to pass within 6 px, so the Glock is the easier one to aim.

### The rifle's line of fire

Held down, the rifle fires a burst of 5 tracers on consecutive ticks, **every 20 ticks**,
for about 11 s (200 rounds), as in the original. Each tracer does 5 px per tick and kills
only where it lands, so the line is dangerous but far from a wall. Players crossing an
established line of fire, in the simulation:

| Crossing | Killed |
|----------|--------|
| At a right angle | 30 % |
| At 20° (spends longer near the line) | 55 % |
| At a right angle with Turbo | 19 % |

Other cadences were measured and not taken (right angle / 20° / Turbo / how long 200
rounds last): every 15 ticks 41 / 78 / 25 %, 8.6 s; every 15 ticks with a shot every other
tick 66 / 84 / 24 %, 8.6 s; every 12 ticks with a shot every other tick 86 / 96 / 32 %,
6.9 s. Until Nov 2026 the rifle swept its path and fired every 15 ticks: 83 %.

## Bullets against tracers

A Glock bullet that crosses a tracer — rifle, Uzi, shotgun pellet or level gun — **explodes
there**, like on any obstacle: tracer fire shoots bullets down. The tracer flies on. In the
original a bullet explodes on any lit pixel it touches, and a tracer is one; here the
bullet's path is tested against the whole jump of the tracer, which is more reliable than
the original and is what keeps Uzi and shotgun fire a defence against the Glock.

- The test is between the two paths travelled in the tick (closer than 3 px), not between
  end positions, so fast Uzi tracers cannot jump over a bullet. Along the bullet's path the
  first thing met counts: a player, a satellite or a tracer.
- Tracers of the bullet's own shooter do not set it off.
- Tracers do not collide with each other (a shotgun spread would destroy itself), and two
  bullets that meet destroy each other in one explosion.

An H-bomb is as touchy as in the original: **a single tracer or bullet that crosses its
body sets it off**, where it is and with its normal blast — so shooting a bomb down is
only safe from a distance. The shot is used up. As everywhere else, the test is the shot's
whole path in the tick against the bomb's 12 × 18 body, and the first thing on the path
counts. (In the original a bullet, being a sprite, did not interact with a bomb; here it
sets it off like a tracer.)

## H-bomb

The bomb is drawn as a 12 × 18 px missile and collides as one: a box 18 px long and 12 px
wide, centred on its position and oriented along its heading. (The original tested the
sprite's pixels against the players' and 20 control points on its outline against the
background.)

- **Solid pixels**: the bomb explodes as soon as its **nose** touches one — the 12 px wide
  band from its previous centre to 9 px ahead of its new centre is tested.
- **Players**: the bomb explodes when an alive player's head is inside the box grown by
  2 px on every side (the head is not a point). This covers a bomb passing just in front of
  a player, who then drives into its side or tail.
- **Items**: within 15 px of the path, as for any projectile.
- **Other bombs**: box against box; two bombs make a mega explosion.

### Blast

The blast is centred on the pixel or player that was hit, and it is **round** (the original
used squares):

| | Radius |
|---|---|
| Trails and scenery erased | 60 px |
| Players killed (shield or not), satellites destroyed | 50 px |
| Items destroyed | 70 px |

Distances wrap around the arena edges. Two bombs that collide make one blast with all three
radii doubled. The erased disc reaches guests and the renderer as a stack of horizontal
strips in `clearedAreas`.

Cleared lines and areas are one-shot events for the renderer and for guests. They are only
emitted when at least one pixel was actually erased, so shots through empty space cost
neither drawing nor bandwidth (an Uzi used to send 20 no-op lines per tick).

## Validation

`tests/projectiles.test.ts`:

- A bullet, a rifle tracer and a bomb fired towards an edge cross it without hitting the
  shooter or a bystander; a bullet still hits a player waiting just across the edge.
- Random bomb fly-bys: the bomb never survives a tick in which a player's head is inside
  its body.
- A bomb flown at a wall explodes when its nose reaches the wall, not its centre.
- The blast erases a disc: pixels 57 px away diagonally go, pixels in the corners of the
  old square stay; an item 64 px away is destroyed, one 78 px away is not.
- A bullet fired into Uzi fire from 8 directions and 3 distances never reaches the Uzi's
  owner; one meeting a rifle tracer head-on explodes half-way; a shooter's own tracers do
  not set off their bullet.
- The rifle's line of fire kills between 20 % and 45 % of right-angle crossings and 200
  rounds last 785 ticks; a tracer
  kills a head 1 px beside its path and misses one 2 px beside it.
- A rifle burst leaves a 3 px hole in a thin wall at any of five distances and flies on;
  Uzi fire leaves a wall 5 px ahead alone and eats what lies in its cone.
- Match-ups: Uzi reach ≤ 55 px < shotgun ≤ 310 px < rifle; shotgun fire stops a bullet
  from 8 directions; a shot passing 4 px beside a player kills with the Glock and misses
  with the rifle.
- A single fast tracer whose path crosses a bomb sets it off; one passing beside it does
  nothing; rifle fire sets off an oncoming bomb in mid-flight, far from the shooter.
- The blast erases a disc: pixels 57 px away diagonally go, pixels in the corners of the
  old square stay; an item 64 px away is destroyed, one 78 px away is not.
- A bullet fired into Uzi fire from 8 directions and 3 distances never reaches the Uzi's
  owner; one meeting a rifle tracer head-on explodes half-way; a shooter's own tracers do
  not set off their bullet.
- Rifle fire sets off an oncoming bomb in mid-flight, far from the shooter; a single tracer through
  its body takes exactly 10 points and disappears.
