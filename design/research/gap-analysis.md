# Gap analysis: original Teratron vs the rewrite

Part of [ideas.md](./ideas.md). Research document, not a spec: nothing here is approved for
implementation.

**Status (16 November 2026).** Written against `9dcb2b6`; the code has moved since. Already
done or changed: the item cap is gone (G2); the shield no longer stops tracers or saves from
another head, and passes closed doors (G4, see `design/architecture.md`); tracers act where
they land (`design/projectiles.md`); spectators, the mobile lobby and the countdown sign that
shows your player (part of A1) are in. File and line references are those of `9dcb2b6`.

**Sources.** Original: `old-tron/TRON.PRG` (Div2, CP850, header dated 09/08/01; line numbers
below are lines of that file), the loose art in `old-tron/media/MAP/` and the sounds in
`old-tron/media/`. Rewrite: branch `revival-2026` at `9dcb2b6`.

**Caveat on provenance.** `TRON.PRG` is not necessarily the last version of the game: the
compiled files in `old-tron/compiled/` are dated 2003, and the rewrite ships things that are
not in the 2001 source (the "Muerte ridícula" panel, the colour-blindness sprites). Where the
rewrite differs from the PRG I cannot tell from the repository alone whether it follows a
later original or is a new decision, except where a design doc says so
(`design/bodyguards.md:3-4` states satellites are new). The owner will know.

Legend for the last column: **Restore** (bring back), **Option** (offer as a rule option,
see idea D1 in ideas.md), **Keep** (the rewrite's change is better), **Owner** (taste call).

## 1. Rules and numbers

| # | Original (evidence) | Rewrite (evidence) | Verdict |
|---|---------------------|--------------------|---------|
| G1 | **Weapon weights are not uniform, and the H-missile is the most common weapon, not a rare one.** `ItemLauncher`, PRG 457-481: `(i-400)/4` runs 0..124; Tiros 0-19 (16 %), Fusil 20-34 (12 %), Ametralladora 35-54 (16 %), Cerrar bordes 55-64 (8 %), Escopeta 65-79 (12 %), Velocidad 80-99 (16 %), `default` 100-124 → Misil H (**20 %**). `design/old-tron-design.md` ("Remainder (default case - rare!)") reads the switch as if it ran 0..99; that is a mistake in the doc. | Uniform pick among 8 weapons, 12.5 % each (`src/game/ItemLauncher.ts:77`). Per spawned item: H-bomb 7.5 % (original ≈ 10.7 % counting the mystery item), Lock Borders 7.5 % (original ≈ 4.7 %). | **Option** ("Classic" table), and fix the doc. More bombs and fewer border locks is a different, more explosive game. |
| G2 | **No cap on items on the field.** Six at round start, then one more every 200-800 frames for as long as the round lasts (PRG 451-534). A long round fills the arena with pickups. | Capped at 6 active (`ItemLauncher.ts:42`, `MAX_ITEMS_ON_FIELD` in `src/types/game.ts:361`): with 6 on the field nothing new appears until one is taken. Items also keep 80 px away from players (`ItemLauncher.ts:114`); the original drops them anywhere. | **Option** (item frequency: classic uncapped / capped). The cap makes long rounds *less* chaotic, the opposite of the original's escalation. |
| G3 | **The mystery item is its own 10 % class, and half of them are duds.** PRG 483-486 and 922-925: class -1 gets graph 124, then `clase=rand(1,2); tipo=rand(1,7)`. Class 1 is a random weapon; class 2 matches no `case` at pickup (PRG 940-986), so the item is consumed and nothing happens. Probably an off-by-one (`rand(0,1)` intended), but it is what shipped in this source. A mystery item is never an automatic item. | Any item (automatic or weapon) has a 10 % chance of being disguised (`ItemLauncher.ts:87`); never a dud. | **Owner.** The rewrite's version is arguably better (a mystery Control Reversal is funnier than a dud). A "fiasco" outcome with a sad trombone would be in the spirit; a silent dud is just confusing. |
| G4 | **Shield only protects against pixels.** `Chungo` returns 0 with a shield (PRG 865), but the head-to-head test is outside the shield check (PRG 790), tracers kill unconditionally (PRG 1230-1232), so do bullets (PRG 1313-1314), bombs (PRG 1376-1377) and the bands (PRG 349-353). | Shield also saves from crossings (`TronGameState.ts:559-563`) and tracers (`design/projectiles.md:30`); bullets, bombs and doors kill regardless. | **Keep** (documented, tested, bots know it). Mention in the item legend (idea A3) because it is not guessable. |
| G5 | Items take two Glock hits: `vivo=100` (PRG 919), each bullet explosion takes 50 (PRG 1321). | `ITEM_HP = 40` (`ItemLauncher.ts:11`). Not checked what each weapon deals. | Keep unless play-testing says otherwise. |
| G6 | Cambiazo **rotates** positions among the living (PRG 1480-1510): predictable if you know the order. | Random permutation, plus a 10 % chance of the colour-blindness gag (`TronGameState.ts:1916-1930`). | **Keep** (more chaos, same idea). |
| G7 | Round starts immediately after `inicio.wav` (PRG 234-238): no countdown. | 3 s countdown (`TronGameState.ts:55`). | **Keep** (needed for phones and networks). |
| G8 | `CONST Escudados=0` (PRG 12, used at 753): a compile-time switch to start everybody with a shield. A rules mutator the author already wanted. | Not present. | **Option** (D1, and the basis of the beginners' handicap D2). |
| G9 | One point to the round winner, nothing on a draw; play until somebody answers "n" (PRG 244-252, 619-625). There is no match length. | Same: endless rounds, no match end (`tickWaitingReady`, `TronGameState.ts:1652-1687`). `TODO.md` lists "Match length setting" under Later. | See idea C1: an optional match length is the single biggest structural addition. |

## 2. Feedback: sound and picture

| # | Original | Rewrite | Verdict |
|---|----------|---------|---------|
| G10 | **Every death has an explosion on the spot and a scream.** `Puf()` + `sound(uah)` (PRG 806-808); `_Puf` plays the 39 explosion frames at size 20 (PRG 853-861), mirrored across the edges (PRG 815-851). | Deaths queue `laughs` or `panico` (`TronGameState.ts:317-329`) but push no explosion: `explosions.push` only exists in `projectileImpact` and `blast` (`TronGameState.ts:1530, 1575`). A player who hits a wall simply stops; on a busy screen you cannot see where or that it happened. `UAH.WAV` has no obvious counterpart in `public/assets/sounds/` (I could not listen; `laughs.mp3` may or may not be derived from it). | **Restore** (idea B1). Cheap, and the biggest readability gap. |
| G11 | Explosion pitch varies per shot: `sound(explosion,256,rand(270,330))` (PRG 1304). The team game plays the start jingle at half volume (PRG 279). | `HTMLAudioElement.cloneNode()` at fixed volume 0.5, no pitch or pan (`src/game/SoundManager.ts:97-109`). | **Restore** with a Web Audio sound manager (idea B2). |
| G12 | Splash picture, then a 3.8 MB intro animation (`Intro.fli`, PRG 52-64), a picture behind the menu (`put_screen(fotos,1)`, PRG 96) and three bitmap fonts (PRG 73-75). `old-tron/media/MAP/splash.bmp` is a Counter-Strike box-art parody. | Black page, cyan monospace glow, two buttons (`src/screens/MainMenu.ts`; `img/desktop-1b-menu-network.png`). Looks like a generic "neon Tron" page, not like this game. | **Restore the tone, not the assets**: the splash is third-party art and cannot be shipped. See idea A2 (attract mode as the new intro). |
| G13 | No music at all (the sound list at PRG 36 and 77-92 is complete: 16 effects). | None. | Keep it that way (don't-do list). |

## 3. Texts, names and jokes

| # | Original | Rewrite | Verdict |
|---|----------|---------|---------|
| G14 | Everything is Spanish: "1. Jugar(2)" … "6. Puerta" for Exit (PRG 97-103), "PUNTUACIONES", "Ganador:", "Empate", "¿Otra? (y/n)" (PRG 608-619), players are " Rojo ", " Verde ", " Azul ", " Amarillo " (PRG 14), teams "Violetas" / "Marrones" (PRG 639-641). | English UI; the only Spanish left is baked into art: the "Muerte ridícula" sidebar panel (`sprites-source/static/ridiculous_death.png`, visible in `img/desktop-5-roundend.png`) and the bus level's captions. | **Restore** as a language option, Spanish default for Spanish browsers (idea K1). |
| G15 | Quitting mid-round exits to DOS printing **"Rajados..."** ("Chickens...", PRG 241, 282). | "BACK TO MENU" button, no comment. | **Restore** as the message everyone else sees when somebody leaves a game (idea B3). |
| G16 | Level art is clip-art collage with in-jokes: the bus level carries "No puede ser", "Te estás riendo", "Estarás contento", "Me he cagado cuando he vajado" (`old-tron/media/MAP/Vicente.bmp`; kept in `public/assets/levels/bus.png`, see `img/phone-4-playing.png`); source files are named after people (`Vicente.bmp`, `JAMES.PCX`). | Levels kept. No way to add your own. | The *practice* (levels made of your group's jokes) is the thing to restore: idea E3. |
| G17 | Comments and identifiers are jokes too: `Chungo`, `Ondia`, `Calvario`, `Parasito`, `Duende`, "Ordenamos para evitar coñas" (PRG 888), the portal sound is a toilet flush (`wc.wav`, PRG 562). | Neutral names (`teleport`, `Control Reversal`). | Use the original names in the Spanish locale and item legend (K1, A3). |

## 4. Menus, flow and controls

| # | Original | Rewrite | Verdict |
|---|----------|---------|---------|
| G18 | Results are one screen and **one key**: "¿Otra? (y/n)" (PRG 619-625). Anyone at the keyboard continues. | Every human must press action to become ready (`TronGameState.ts:1678`); one distracted phone stalls the room. | **Keep** the ready-up for networks, but add a host override / auto-start timer (part of idea C1). |
| G19 | An unfinished **Opciones** screen (menu entry commented out, PRG 102 and 119-121): choose the starting map with a 37 % thumbnail (PRG 151-189), saved to `opciones.dat` (PRG 203-220). | A `<select>` of level names without previews (`LocalSetup.ts:82`, `NetworkLobby.ts:241`); settings remembered in `localStorage`. | Finish what the original started: idea D1 (rules) and E4 (level thumbnails). |
| G20 | Player 4 can steer with the **mouse** (relative movement, left button fires; PRG 758-761, 1118): four people around one PC needed a fourth device. | Five keyboard schemes (`src/types/game.ts:5`); no mouse, no gamepad (grep for `gamepad` in `src/`: nothing). | The modern equivalent is gamepads (F4) and phones as controllers (F3). |
| G21 | One screen, one room, everybody looking at the same picture. | Each network player looks at their own device. | Not a loss, but the couch mode can be offered again: idea F3. |

## 5. Things that look missing but are not

- Level hazards (Mano, Guerra, Bandas; PRG 310-440) are implemented (`design/level-hazards.md`).
- Portals teleport projectiles (PRG 570-589; `TronGameState.ts:951-957`).
- Per-player effect timers and ammo in the side panel (PRG 1021-1069, 1086-1113; `TronRenderer.ts:700-735`).
- The 8 maps and their order (PRG 10-11, 264; `LEVEL_DEFINITIONS`, `src/types/game.ts:242-275`).
- `Teleitem.bmp`, `Torpedoitem.bmp` and `ofensivoitem.bmp` in `old-tron/media/MAP/` are
  byte-identical blank templates (checked with `cmp`), so they are evidence of *planned* items
  by name only, not lost art.

## 6. Additions of the rewrite (for completeness)

Satellites, the Slow weapon, colour-blindness gag, mega-bomb white flash, death causes with
"who did it", ridiculous-death counter, bots, rooms, touch. All compatible with the original's
tone; the ridiculous-death counter is the best of them and deserves more stage (idea C1).
