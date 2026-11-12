# Bodyguards (satellites)

The *Bodyguard* item gives the player who picks it up a satellite. Satellites are an
addition of the rewrite (the original game has none). A player can collect several.

Related: [projectiles.md](./projectiles.md), [local-and-ai.md](./local-and-ai.md) (bots).

## Behaviour

A satellite protects an **area of action**: the circle of 50 px around its owner. With
nothing to do it orbits the owner at 30 px, one turn every 2 s; several satellites of one
owner spread evenly around the orbit.

Every `playing` tick each satellite gets a job, in this order of priority:

1. **Block a projectile.** A *threat* is any projectile not fired by the owner (level guns
   included) whose course over the next 6 ticks passes through the area, judged relative
   to the owner as it moves. Threats that would pass within 10 px of the owner come first,
   then the most urgent (fewest ticks until inside). Each is given to the free satellite
   that can deal with it best. A satellite does not chase the projectile's current
   position: it goes to a point on its **future course**, on the way in. Of the points it
   can reach in time it takes the one nearest the owner, but not nearer than 12 px (a
   bullet explodes and would still hurt). Standing close to the owner, in the line of
   fire, covers a whole spread of shots at once. If it cannot reach any point in time it
   goes for the one it gets closest to.
2. **Attack an intruder.** An alive enemy player whose head is inside the area is attacked
   by every satellite without a projectile to block: they fly straight at the nearest one.
   In team mode team-mates are neither attacked nor harmed.
3. **Orbit.**

A satellite moves at up to 10 px per tick and never leaves the area of action (targets are
clamped to it). Satellites freeze when the round ends and disappear with their owner.

## Contact

- **Projectiles.** A satellite stops any threat that passes within 5 px of it — tested
  against the whole path the projectile travels in the tick and against the path the
  satellite itself travels, so fast tracers cannot jump over it. Along a projectile's path
  whatever comes first counts: a satellite behind the victim does not save them.
  - A **tracer** (rifle, Uzi, shotgun pellet, level gun) disappears. The satellite is not
    harmed.
  - A **Glock bullet bounces straight back** the way it came, from the point of contact,
    and from then on belongs to the satellite's owner: the owner's satellites let it
    through, and whoever it kills was killed by the owner. Fired from a distance by a
    player who keeps driving down the line of fire, it comes back and kills the shooter.
  - An **H-bomb** explodes there.
- **Players.** An enemy whose head comes within 5 px of a satellite (or of the path it
  travelled in the tick) dies, shield or not, with death cause `bodyguard`.

## Overwhelming a satellite

A satellite cannot be damaged by gunfire: **only an H-bomb blast destroys it** (every
satellite within 50 px of the blast goes).

What beats a satellite is **volume and speed of fire**. At 10 px per tick it cannot always
get from the far side of its orbit into the line of fire before fast pellets arrive, and
while it deals with one blast the next one comes. Shotgun blasts from 95 px, one every 4
ticks, over 24 directions and orbit positions:

| Blasts in a row | 1 satellite | 2 satellites | 3 satellites |
|-----------------|-------------|--------------|--------------|
| 1 | owner dies 8/24 | 2/24 | 1/24 |
| 6 | 24/24 | 6/24 | 1/24 |

A single Glock bullet (bounced back) or a rifle burst is stopped in every set-up of the
tests.

## Bots

Bots that avoid hazards (`normal`, `hard`) treat an enemy's whole area of action as deadly
while that enemy has satellites, instead of only the satellites themselves.

## Validation

`tests/bodyguards.test.ts`:

- A rifle burst fired at the owner from 12 directions is stopped wherever on the orbit the
  satellite happened to be; a Glock bullet is bounced back and kills its shooter.
- An enemy driving into the area is killed by the satellite before reaching the owner; one
  passing outside it is left alone; a team-mate is not harmed.
- Shotgun: one blast is stopped more often than not; six in a row overwhelm a lone
  satellite without destroying it; three satellites hold out.
- With two satellites and two simultaneous threats, each takes one.
