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

A satellite moves at up to 16 px per tick — fast enough to get from the far side of its
orbit into the line of fire before all but the fastest point-blank shotgun pellets — and
never leaves the area of action (targets are clamped to it). Satellites freeze when the round ends and disappear with their owner.

## Contact

- **Projectiles.** A satellite stops any threat that passes within 5 px of it — tested
  against the whole path the projectile travels in the tick and against the path the
  satellite itself travels, so fast tracers cannot jump over it. Along a projectile's path
  whatever comes first counts: a satellite behind the victim does not save them.
  A blocked bullet or tracer just disappears; a blocked H-bomb explodes there.
- **Players.** An enemy whose head comes within 5 px of a satellite (or of the path it
  travelled in the tick) dies, shield or not, with death cause `bodyguard`.

## Wear: satellites can be overwhelmed

A satellite has **300 hit points**. Every projectile it blocks costs the same damage that
projectile does to items: 10 for a tracer (rifle, Uzi, shotgun pellet, level
gun), 50 for a Glock bullet. At 0 it is destroyed with a small explosion.

A shotgun blast is 30 pellets, and a satellite in the line of fire stops roughly half of
them (the rest of the spread goes around it and misses the owner too). Measured from 95 px,
over 24 directions and orbit positions:

| Blasts in a row | 1 satellite | 2 satellites | 3 satellites |
|-----------------|-------------|--------------|--------------|
| 1 | owner dies 2/24 | 0/24 | 0/24 |
| 2 | 14/24 | 2/24 | 0/24 |
| 3 | 24/24 | 12/24 | 0/24 |
| 4 | 24/24 | 24/24 | 15/24 |
| 6 | 24/24 | 24/24 | 24/24 |

Six Glock bullets or a long rifle burst also destroy a satellite. Hit points do not
regenerate. A satellite fades as it wears down (`Bodyguard.hp` travels to guests with the
rest of the round state).

An H-bomb blast destroys every satellite in its kill area outright, as before.

## Bots

Bots that avoid hazards (`normal`, `hard`) treat an enemy's whole area of action as deadly
while that enemy has satellites, instead of only the satellites themselves.

## Validation

`tests/bodyguards.test.ts`:

- A Glock bullet and a rifle burst fired at the owner from several directions are stopped,
  wherever on the orbit the satellite happened to be.
- An enemy driving into the area is killed by the satellite before reaching the owner; one
  passing outside it is left alone; a team-mate is not harmed.
- One shotgun blast rarely kills the owner; repeated blasts destroy the satellite and
  then do; more satellites take more blasts.
- With two satellites and two simultaneous threats, each takes one.
