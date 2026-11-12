# Team Mode

Two teams of two: **Purple** (slots 0 and 2) and **Brown** (slots 1 and 3), as the
original's *Violetas* and *Marrones*. Team-mates share a trail colour.

## Rounds and score

- A round ends when one team has nobody left (or both, a draw).
- **Every player still standing at that moment scores one win.** A team that finishes the
  round with both members alive therefore earns 2, with one member alive 1. Members who
  died during the round score nothing, even if their team won. A draw scores nothing.
- **The team score is the sum of its members' wins**, and it is the score that matters.
  This is the original's rule (`ptos[i]++` for every survivor; *Violetas* =
  `ptos[0]+ptos[2]`, *Marrones* = `ptos[1]+ptos[3]`).
- Individual wins and ridiculous deaths (MR) are still counted and shown per player.

No extra state is needed: `TronMatchState.scores` holds the individual wins and the team
score is derived from it wherever it is shown.

## Display

- **Between rounds** the team scores are the headline — `PURPLE 5 : 3 BROWN`, each in its
  team colour, with the trophy next to the team that won the round. Below it the usual
  table (wins, MR, name, how they died, ready) lists the players grouped by team, the
  leading team first.
- **Side panel**: in team mode the panel behind the four player slots uses the team
  colours (purple, brown, purple, brown — `sidebar_team` in the sprite atlas) instead of
  the free-for-all red/green/blue/yellow. The image is derived from the free-for-all one
  with `scripts/make-team-sidebar.mjs`, keeping its textures. Dead and empty slots are
  grey as in free-for-all.

## Other team rules

- Friendly fire is on: trails, shots and blasts hurt team-mates like anyone else.
- The *Slow* weapon, which slows the other players while its trigger is held, does not
  slow team-mates. (No weapon speeds other players up; Turbo only affects its user.)
- Satellites spare team-mates ([bodyguards.md](./bodyguards.md)).
- Bots do not hunt team-mates ([local-and-ai.md](./local-and-ai.md)).

## Validation

`tests/rules.test.ts`: a team that wins with both members alive scores 2, with one alive 1
(and only the survivor gets the win); a draw scores nothing. The Slow weapon slows the other
team and not a team-mate.
