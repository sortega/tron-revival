# Projectile Collisions

How bullets, tracers and H-bombs decide what they hit. The weapons themselves are described
in [old-tron-design.md](./old-tron-design.md); this document covers the collision rules of
the rewrite, in `TronGameState.tickProjectiles`.

## Common rules

Every tick a projectile moves from its previous position to a new one. In this order:

1. **Portals** teleport it.
2. **Solid pixels** (trails, scenery) on the path stop it: a bullet or bomb explodes there, a
   tracer erases the path up to that point and dies.
3. **Players**: an alive player whose head is close enough to the path is hit. The owner is
   immune for the first 10 ticks so a shot does not hit its own shooter on the way out.
4. **Items**, then **other projectiles**.

The arena wraps around, and so does every one of these tests: the path is always the short
segment actually travelled. On the tick a projectile crosses an edge, the segment continues
past the edge and targets are compared at their position **and** at their wrapped-around
position. (A bug until Nov 2026: the segment was drawn from the old position to the
*wrapped* new one, across the whole arena, so a shot leaving through an edge hit anyone on
that row or column — typically its own shooter.)

| Projectile | Speed (px/tick) | Hits a player within | Effect on the player |
|------------|-----------------|----------------------|----------------------|
| Bullet (Glock) | 5 × speed factor | 6 px of the path | Explosion: kills everyone within 6 px, shield or not |
| Tracer (Rifle, Uzi, Shotgun, level guns) | 5–50 | 1 px of the path | Kills that player (a shield protects) |
| H-bomb | 2 | its body, see below | Blast: kills everyone within 50 px |

## Bullets against tracers

A Glock bullet that crosses a tracer — rifle, Uzi, shotgun pellet or level gun — **explodes
there**, like on any obstacle: tracer fire shoots bullets down. The tracer flies on. This is
the original's behaviour, where a tracer is a lit pixel on the background and a bullet
explodes on any lit pixel it touches.

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
- A single fast tracer whose path crosses a bomb sets it off; one passing beside it does
  nothing; rifle fire sets off an oncoming bomb in mid-flight, far from the shooter.
- The blast erases a disc: pixels 57 px away diagonally go, pixels in the corners of the
  old square stay; an item 64 px away is destroyed, one 78 px away is not.
- A bullet fired into Uzi fire from 8 directions and 3 distances never reaches the Uzi's
  owner; one meeting a rifle tracer head-on explodes half-way; a shooter's own tracers do
  not set off their bullet.
- Rifle fire sets off an oncoming bomb in mid-flight, far from the shooter; a single tracer through
  its body takes exactly 10 points and disappears.
