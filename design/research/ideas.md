# Ideas: improving Teratron Revival without losing Teratron

Research document (November 2026, base `revival-2026` @ `9dcb2b6`). It proposes; it does not
specify. Per `CLAUDE.md`, anything green-lit here still needs its own design doc in `design/`
before code.

**Status (16 November 2026).** Written against `9dcb2b6`; the code has moved since. Already
done or changed: the item cap is gone (G2); the shield no longer stops tracers or saves from
another head, and passes closed doors (G4, see `design/architecture.md`); tracers act where
they land (`design/projectiles.md`); spectators, the mobile lobby and the countdown sign that
shows your player (part of A1) are in. File and line references are those of `9dcb2b6`.

Companion: [gap-analysis.md](./gap-analysis.md) (original vs rewrite, with line references;
rows are cited below as G1…G21). Screenshots of the current build are in [`img/`](./img/).

**Not covered here** because other research branches own them: performance; human-like bots;
territory-aware bots; spectators, join code on the game screen and joining next round; trail
and head shading and non-black level backgrounds; touch steering modes. Where an idea touches
one of them it says so under *Depends*.

**How to read the effort column.** S = up to a day, M = a few days, L = a week or more, for
someone who knows the code. These are my estimates from reading the code, not measurements.

---

## 1. The spirit of the original

Teratron was written by a teenager for his friends, to be played four at a keyboard. Reading
`TRON.PRG` with that in mind, six properties define it, and each idea below is tested against
them.

1. **One room, one picture.** Up to four people looking at the same 750×600 arena and at
   each other. The fun is social and happens between the players, not on the screen.
2. **Chaos you can blame on someone.** Items are frequent, strong and unfair: four of the
   seven automatic items hurt whoever takes them or upset everybody at once (Control Reversal,
   Slow, Swap, Eraser; PRG 950-979), the most common weapon is a bomb with a 50 px kill radius (G1), and the field
   fills up as the round goes on (G2). Balance was never a goal; stories were.
3. **Pixels are the rules.** A trail is the pixels it painted. Weapons erase pixels, the
   dentist's drill erases pixels, the eraser restores the picture. What you see is exactly
   what kills you.
4. **Dying is the joke.** Scream and explosion on every death, a toilet flush for the
   portals, "Rajados..." when you quit, levels made of clip-art and private jokes, a death
   category called "ridícula".
5. **Seconds, not minutes.** No countdown, no match, no menus worth the name: a round, a
   score table, "¿Otra? (y/n)".
6. **Home-made.** Spanish, misspelt in places, obviously made by one of the people playing.

The filter: an idea fits if it makes the room louder, the chaos more legible or the next
round sooner, and does not make the game fairer, slower, more solitary or more polished than
the people playing it. The rewrite's own additions (ridiculous-death counter, "who did it"
on the summary, satellites) pass this test, which is a good sign that the filter is right.

What a purist would say about this whole document: the original had none of this and was
fun. True, but the original also had its four players within arm's reach, which did the work
that half of these ideas try to do for people on separate phones.

---

## 2. Gap analysis (summary)

Full table in [gap-analysis.md](./gap-analysis.md). The findings that matter most:

- **Deaths lost their explosion and scream** (G10). The original marks every death on the
  spot; the rewrite only plays a sound. Restore.
- **The item table changed character** (G1-G3). Original: H-missile is the most common
  weapon (20 % of weapons; `old-tron-design.md` wrongly calls it rare), items are uncapped and
  pile up, mystery items are half duds. Rewrite: uniform weights, at most 6 on the field.
  Offer the original table as "Classic".
- **The language and the jokes are gone from the UI** (G14-G17). Restore as a locale.
- **There is still no match**, as in the original (G9), but the original had one key to
  continue and the rewrite needs every player to ready up (G18).
- **The author had started an options screen and a "start shielded" switch** (G8, G19).
- **Player 4 had a mouse** (G20): the original already cared about getting a fourth person
  onto one machine.

---

## 3. Ideas

Each entry: what and why · spirit (and the purist's objection) · effort and where · risks ·
dependencies · how to validate without a human.

### A. Onboarding and the first minute

#### A1. "That one is you": start markers during the countdown

- **What / why.** During the countdown every player is a single pixel
  (`img/desktop-3-countdown.png`: the four heads are nearly invisible). Draw, for the 3 s of
  countdown only, a ring in the player's colour around each start position with the nickname
  and a short heading arrow; the local player's ring is larger and says "TÚ / YOU". On a
  shared keyboard, also the key hint (`←/→`). The first death of every newcomer is currently
  "I didn't know which one I was".
- **Spirit.** Legibility, no rule change; disappears when play starts so the arena stays
  pure pixels. Purist: the original had nothing; you learnt your corner (it was always the
  same corner, PRG 692-750, and it still is).
- **Effort.** S. `TronRenderer` countdown overlay (`TronRenderer.ts:~750`), needs the local
  slots from `TronGame`.
- **Risks.** Clutter with 4 rings on a phone; keep them thin.
- **Depends.** Head shading branch (it makes heads visible *during* play; this is only the
  countdown). Should use the same colours.
- **Headless check.** Playwright screenshot at countdown; assert non-black pixels in a 40 px
  box around each start position (currently ~1).

#### A2. Attract mode and a one-tap first game

- **What / why.** The menu is a black page with two buttons (`img/desktop-1b-menu-network.png`)
  and "LOCAL GAME" leads to a form. Replace the original's intro animation (G12) with what
  the project can already do for free: a bot match running behind the menu (a `HostSession`
  with four bots and no input, dimmed), and make the top button **JUGAR / PLAY** = you + 3
  normal bots on a random level, no form. "Local game" and "Network game" remain below.
- **Spirit.** Seconds-not-minutes; the attract mode shows trails, explosions and items before
  the player reads a word. Purist: none really; the original opened with an animation too.
- **Effort.** M. `MainMenu.ts`, reuse `TronGame`'s renderer/session wiring (currently tied to
  the game screen DOM; extraction overlaps tech-debt T6 in `TODO.md`).
- **Risks.** CPU on phones while idle (run it at reduced tick budget or pause when hidden);
  bot cost per tick is known (`TODO.md` iteration 3).
- **Depends.** Performance branch (renderer cost), human-like bots (they will look better).
- **Headless check.** Menu page: `__teratron.view()` advances; time-to-first-playing-tick from
  page load under 5 s with one click.

#### A3. Item legend and pickup call-outs

- **What / why.** Item icons are cryptic (a STOP sign, two arrows, a cage; see
  `img/desktop-4-playing.png`) and several rules are not guessable: shield does not stop
  bullets (G4), Control Reversal is a trap. Two parts: (a) when *you* pick something up, its
  name appears for 1.5 s over your sidebar panel ("¡CONTROLES TRASTORNADOS!"); (b) a one-page
  legend (sprite, name, one line) reachable from the lobby, the local setup and the pause /
  round summary.
- **Spirit.** The original taught items by friends shouting what they were; remote players
  have nobody to shout. Names should be the original's (G17). Purist: discovering that the
  STOP sign slows *you* is part of the fun. Answer: call-outs appear after pickup, so the
  trap still works once.
- **Effort.** S-M. Names exist in `AUTOMATIC_ITEMS` / `WEAPON_ITEMS` (`src/types/game.ts:334-357`);
  pickup is already a sound event per frame; add a `pickups` one-shot event or derive it from
  `equippedWeapon` / `activeEffects` changes in `TronGame.applyFrame`. Legend is DOM.
- **Risks.** Text on a 50 px sidebar: use the play area edge next to the panel.
- **Depends.** K1 for the Spanish names.
- **Headless check.** Sim test: a pickup produces exactly one call-out event for the right
  slot; Playwright screenshot of the legend.

### B. Game feel

#### B1. Give deaths back their explosion and scream

- **What / why.** G10: the original runs `Puf()` and `uah.wav` on every death; the rewrite
  only queues a sound. Add a small explosion at the death position (the same 39-frame
  animation at scale 0.2, mirrored across edges as `Puf` does) and a brief ring in the dead
  player's colour, and bring `UAH.WAV` back as the normal death sound. Today a normal death plays
  `laughs` and a ridiculous one `panico` (`TronGameState.ts:321-328`); whether `uah` replaces
  `laughs` or joins it is for the owner's ear.
- **Spirit.** Straight restoration. No objection.
- **Effort.** S. `killPlayerWithSound` (`TronGameState.ts:318`) pushes an `Explosion`
  (already serialised and rendered); convert `old-tron/media/UAH.WAV` to mp3.
- **Risks.** The explosion sprite briefly hides trail pixels near the crash; scale 0.2 is
  what the original used.
- **Depends.** None.
- **Headless check.** `tests/rules.test.ts`: a wall crash yields a frame with one explosion
  at the death coordinates and a `uah` sound event.

#### B2. Web Audio sound manager

- **What / why.** `SoundManager` clones an `<audio>` element per play at fixed volume
  (`SoundManager.ts:97-109`): no pitch variation (the original had it, G11), no panning, no
  per-sound levels, noticeable latency on phones, and Uzi/rifle fire allocates elements
  continuously. Decode once into `AudioBuffer`s; per play: `playbackRate` ±8 %, stereo pan
  from the event's x position, per-sound gain, a limiter so four Uzis do not clip. Sound
  events then need an optional position (`SoundEvent` in `src/types/game.ts:145`).
- **Spirit.** Louder, funnier room. Panning also tells you *where* something exploded on a
  phone speaker pair or headphones. Purist: none.
- **Effort.** M. `SoundManager.ts` rewrite, `queueSound` call sites gain an optional `x`,
  wire format gets one optional number per sound event (`serialization.ts`).
- **Risks.** iOS audio unlock on first touch (must resume the context in a gesture);
  loops (`playLoop`) need care.
- **Depends.** None. Enables B3, C4.
- **Headless check.** Unit test with a fake `AudioContext`: N plays create N sources, loops
  stop on round end, pan = f(x). Wire test: sound event round-trips with position.

#### B3. Announcer lines and a kill feed in the original's voice

- **What / why.** The simulation already knows who killed whom and how (`DeathEvent.by`), but
  it is only shown after the round. Show one line for 2 s in the strip under the arena (where
  the key hint is now) as it happens: "Verde se ha comido su propia raya", "Ana ha bombardeado
  a Luis", and the big ones as a centre caption: **MUERTE RIDÍCULA**, **EMPATE**,
  **RAJADOS…** when a player leaves mid-game (G15). Text only; no voice acting.
- **Spirit.** This is the commentary the four friends at the keyboard provided themselves.
  Purist: text over the arena. Keep the feed outside the play area; centre captions only
  when the round is already over or for under a second.
- **Effort.** S-M. `deathLabels.ts` gains a present-tense variant; `TronGame.applyFrame`
  feeds a small DOM element. The "left the game" event needs the room layer
  (`RoomConnection`) to tell the game screen.
- **Risks.** Phones have no strip under the arena (`img/phone-4-playing.png`); use the free
  column beside the sidebar there.
- **Depends.** K1 (strings); spectators branch (they are the main readers of a feed).
- **Headless check.** Unit test of label generation for every `DeathCause` × self/other/level
  in both languages; Playwright: feed element contains the victim's name after a scripted death.

#### B4. Shake and hit-stop, render-only

- **What / why.** An H-bomb clears 120 px of arena with no more emphasis than a Glock hit.
  Add, in the renderer only: 6-frame screen shake proportional to blast scale, and a 150 ms
  freeze-frame on the kill that ends the round (the simulation has already stopped at that
  point; the renderer just delays the summary overlay).
- **Spirit.** Makes the chaos land. Purist: shake blurs the pixels that are the rules; so
  shake only the *presentation transform* of the whole canvas, never the simulation, cap it
  at 3 px, and disable it under `prefers-reduced-motion` and in G2's reduced-flash mode.
- **Effort.** S. `TronRenderer` composite step, driven by the `explosions` scale it already
  receives.
- **Risks.** Motion sickness on phones; hence the cap and the switch.
- **Depends.** Performance branch if the compositor changes.
- **Headless check.** Renderer unit test: shake offset is zero when reduced motion is set and
  decays to zero within N frames.

### C. Party and social

#### C1. A match: first to N, podium with awards, "¿Otra?"

- **What / why.** There is no end (G9): rounds follow each other until people drift away,
  which on separate devices means the session ends with someone silently closing a tab.
  Optional match length (first to 3 / 5 / 10 wins, or endless as today). At the end, a
  podium screen: final order, then awards computed from data the match already has:
  *Rey del ridículo* (most own-trail deaths, `ridiculousDeath` in `TronMatchState`),
  *Pistolero* (most kills by `by`), *Kamikaze* (most self-kills by own weapon), *Pacifista*
  (won rounds without a kill), *Víctima favorita* ("Ana killed Luis 4 times"). Then
  **¿OTRA? / REMATCH** (same seats, scores reset) and **LOBBY**. Also: the host can start
  the next round after 10 s even if someone is not ready (G18). Deeper sketch in §5.
- **Spirit.** The awards turn "dying is the joke" into the closing ceremony; nobody remembers
  who won, everybody remembers who was Rey del ridículo. Purist: the original had no match.
  Keep *endless* available and make it the local default.
- **Effort.** M. `TronGameState` (match phase, stats), `types/game.ts`, `serialization.ts`,
  `TronRenderer` (podium), lobby/local setup (setting).
- **Risks.** Team mode awards need care (team-mates share a colour, `trail` deaths have no
  `by` there).
- **Depends.** Spectators / join-next-round branch (a late joiner mid-match: score 0, or wait
  for the rematch; that branch should decide, this idea only needs a hook).
- **Headless check.** Seeded bot matches (`tests/sim.ts`) end exactly when a score reaches N;
  award computation is a pure function of the death log; guest view equals host view at the
  podium (`tests/netcode.test.ts` rig).

#### C2. Shareable result card

- **What / why.** At the podium, a "share" button renders a PNG: the final arena of the last
  round (the trails are a nice picture in themselves), names, scores, the awards and the room
  link. `navigator.share({files})` on phones, download on desktop. The group chat is where
  the next session gets organised.
- **Spirit.** The modern "look at this" over someone's shoulder. Purist: none, it is outside
  the game.
- **Effort.** S (after C1). One off-screen canvas from the renderer's existing layers.
- **Risks.** Web Share with files is not available everywhere; fall back to download.
- **Depends.** C1.
- **Headless check.** Playwright: the generated blob decodes as PNG of the expected size and
  contains non-black pixels in the arena area.

#### C3. Honks for the dead and between rounds

- **What / why.** A dead player has nothing to do until the round ends, and remote players
  cannot laugh at each other. Let the action button, while dead or in the summary lock, send a
  rate-limited "honk": the sender's sidebar panel flashes and a sound plays for everyone
  (panel order: laugh, scream, "¡Rajado!", applause; cycle by repeated presses, max one per
  1.5 s). No free text during play.
- **Spirit.** Restores the noise of the room. Purist: sound spam. Rate limit, mute switch,
  and the host can turn it off in the rules.
- **Effort.** M. A tiny reliable message on the room channel (not part of the simulation, so
  no determinism impact), `TronGame` + `SoundManager`.
- **Risks.** Action while dead currently does nothing, but in `waiting_ready` it means
  "ready": only honk during the 1 s ready lock and while the round is still running.
- **Depends.** Spectators branch (spectators would want this too; they should share the
  message type). B2 for decent mixing.
- **Headless check.** `tests/room.test.ts`: honk from a seat is relayed, rate-limited and
  ignored from non-seats; two-browser e2e asserts the panel flash class.

#### C4. Names in local games; scores always visible

- **What / why.** Local players are called "Red" and "Green Bot"
  (`src/game/localSetup.ts:58`); the sidebar shows no name and no score, so mid-round nobody
  knows the standing (`img/desktop-4-playing.png`). Add a name field per local slot
  (remembered), default names from the locale (Rojo, Verde…), and draw the score as a small
  number at the top of each sidebar panel.
- **Spirit.** Purist: the original panel had no score either (it had only timers and ammo).
  It is 12 px of text, and the summary screen stays the place for the full table.
- **Effort.** S. `LocalSetup.ts`, `localSetup.ts`, `TronRenderer` sidebar (~line 700).
- **Risks.** The panel art is busy; needs an outline font.
- **Depends.** Shading branch if it restyles the sidebar.
- **Headless check.** Local setup round-trip test (names persist); screenshot diff of the panel.

### D. Modes and rule options

#### D1. "Opciones": a rule set, with Classic as a preset

- **What / why.** Finish the screen the original left commented out (G19). One `RuleSet`
  object in `GameConfig` with a handful of switches, each backed by something the original
  did or wanted: **Item table** Classic (G1-G3: original weights, uncapped, spawn anywhere) /
  Revival (today's); **Item frequency** none / normal / lluvia (×3); **Start shielded** off /
  5 s / 30 s (G8, `Escudados`); **Match length** (C1); **Sudden death** (D3). Presets:
  *Clásico*, *Revival*, *Caos*. Sketch in §5.
- **Spirit.** Options are a risk to "seconds, not minutes"; so presets first, switches behind
  "more", and the host's last choice is remembered. Purist: the purist finally gets a
  Classic button.
- **Effort.** M. `types/game.ts` (`GameConfig`), `ItemLauncher.ts`, `TronGameState`
  constructor, `roomLogic.ts` / `LobbyState`, both setup screens, bots unaffected.
- **Risks.** Every switch doubles the test matrix; keep it to five and make the simulation
  take the rule set as data so the fuzz test can sample it.
- **Depends.** None hard. Territory-aware bots may want to know item density.
- **Headless check.** Statistical test: over 20 000 seeded spawns the Classic table is within
  1 % of 16/12/16/20/8/12/16; fuzz invariants (`tests/rules.test.ts`) hold for each preset;
  `npm run sim` table per preset shows round length and deaths by cause.

#### D2. Beginner's handicap: "novato"

- **What / why.** A newcomer against three regulars dies in the first five seconds, every
  round. A per-seat flag gives that player a start shield of 10 s (the `Escudados` mechanic
  per player) and shows a small "L" plate on their panel. Optionally automatic: whoever is
  last by 3+ points gets it.
- **Spirit.** Uses an original item, visible to everybody, and the L plate is itself a joke.
  Purist: unfair. Yes; items are too.
- **Effort.** S on top of D1. Seat flag in lobby/local setup, `initRound` applies the effect.
- **Risks.** A shielded player wins every head-on crossing (only the unshielded one dies,
  `TronGameState.ts:559-563`) and can use the 10 s to ram people. Tune the duration with the
  sim.
- **Depends.** D1.
- **Headless check.** Sim: an easy bot with the flag against three hard bots; its win rate
  should rise toward, not above, 25 %.

#### D3. Sudden death that uses the original's own weapon

- **What / why.** With wrap-around, an Eraser and cautious players (or two good bots) a round
  can drag. After a configurable time (default 90 s) the arena itself fires **Cerrar bordes**
  in white with the alarm, and item frequency triples. No shrinking walls, no new mechanic.
- **Spirit.** Escalation is how the original behaved anyway (uncapped items, G2). Purist:
  rounds had no clock. Off in Classic.
- **Effort.** S-M. `TronGameState.tickPlaying` timer; border lock with `NO_OWNER` (the
  projectile owner constant already exists for the level's guns).
- **Risks.** An Eraser removes the lock (as in the original); re-fire after 20 s.
- **Depends.** D1. I have not measured how long rounds actually last; `npm run sim` reports
  it and should be consulted before deciding the default.
- **Headless check.** Sim: 99th percentile round length with and without; test that the lock
  starts at the configured tick and bots do not all die on it.

#### D4. "Rey de la pista": rotation for more than four people

- **What / why.** A party has six people and four seats. Winner stays, the round's first
  dead swaps with the next person waiting, automatically. This is how more-than-4 was always
  solved at one keyboard.
- **Spirit.** Exactly the couch protocol. Purist: none.
- **Effort.** M. Lobby logic only (`roomLogic.ts`: a queue of waiting profiles, swap between
  rounds), plus the game accepting a seat's controller changing between rounds.
- **Risks.** Scores: per person, not per seat; colour changes when you return to a different
  seat.
- **Depends.** **Hard dependency on the spectators / join-next-round branch**, which builds
  the mechanism for people in a room without a seat. Do not start before it lands.
- **Headless check.** `tests/room.test.ts`: with 6 profiles and rotation on, after each round
  the first dead leaves and the head of the queue sits; nobody waits more than N rounds.

#### D5. Teams without four humans

- **What / why.** Team mode needs all four slots filled (`canStartGame`,
  `src/types/lobby.ts:114-121`). Add "fill with bots" as one button, and allow 2 humans to
  choose "together against the bots".
- **Spirit.** Co-op against the machine is a new flavour, but teams are original (G14).
- **Effort.** S. Lobby and local setup; bots already exist in both.
- **Risks.** Bots as team-mates must not shoot their partner (worth a sim check; the Slow
  weapon already spares team-mates).
- **Depends.** Bot branches (quality of the partner).
- **Headless check.** Sim of 2 hard bots vs 2 hard bots in team mode: count team-kills.

### E. Items and levels in the original's style

#### E1. Classic item table

Covered by D1 (the *Clásico* preset) and G1-G3. Listed separately because it can be done
alone in an afternoon as a constant in `ItemLauncher.ts`, before any options UI exists, and
play-tested with `?items=classic`.

#### E2. Two new items with a pedigree: Torpedo and Tele

- **What / why.** The original art folder has blank item templates named `Torpedoitem`,
  `Teleitem` and `ofensivoitem` (gap analysis §5): planned, never made. Proposals that keep
  the house style (strong, simple, can backfire):
  - **Torpedo** (weapon, 1 shot): a slow missile (2 px/tick like the H-bomb) that *you* steer
    with your left/right keys while your own vehicle keeps going straight. Blast as a Glock
    bullet. Ten seconds of fuel. You will drive into a wall while aiming; that is the item.
  - **Tele** (automatic): the next trail or wall you would hit, you pass through once (a
    one-use, 3 s Crossing+Shield that announces itself with the flush sound). Simpler than a
    targeted teleport and reads instantly.
- **Spirit.** Torpedo is a ridiculous-death generator. Purist: new items are not Teratron.
  They would be off in Classic, and satellites already set the precedent.
- **Effort.** M each. `TronGameState` (weapon handling, projectile with owner-steer),
  `movement.ts` and guest prediction (the owner's steering stops affecting the vehicle:
  prediction must know), sprites, sidebar icons, bots (ignore the Torpedo at first).
- **Risks.** Torpedo touches client-side prediction: highest technical risk in this list.
  Balance unknown.
- **Depends.** D1 (to switch them off). Human-like / territory bots would need to learn them.
- **Headless check.** Rules tests per item; netcode rig: prediction error stays zero while a
  torpedo is being steered at 150 ms.

#### E3. Bring your own level (a PNG)

- **What / why.** The original's levels are collages of clip-art and in-jokes about the
  author's friends (G16). The mechanism to restore is *making levels about your own group*.
  The level format is already "a 750×600 image whose non-black pixels are solid"
  (`LEVEL_DEFINITIONS`, `src/types/game.ts:242`). Let the host drop or pick an image in the
  lobby: it is scaled/cropped to 750×600, shown as a preview with the start corners marked,
  and sent to guests. A level stays in that browser's storage under a name.
- **Spirit.** The most "home-made" idea here. Purist: none; the purist drew levels in
  Deluxe Paint.
- **Effort.** M-L. Image import + quantisation (photos are almost entirely non-black: needs
  a threshold slider and a "keep only the N brightest shapes" helper), transfer to guests
  (a reduced-palette PNG of a mostly-black image is tens of kB; photos are not), snapshot for
  late joiners, hazards not supported.
- **Risks.** Photos make unplayable levels (everything solid); start corners must be forced
  clear. Private rooms only, so moderation is not a concern.
- **Depends.** **Non-black backgrounds branch** defines what a level image means (which
  pixels are solid when the background is not black). This idea should wait for that
  definition and reuse it.
- **Headless check.** Unit: import of a synthetic image yields the expected `PixelGrid`,
  start corners cleared; netcode rig: guest grid equals host grid after transfer; fuzz
  invariants on a few imported levels.

#### E4. Level picker with thumbnails and "al azar"

- **What / why.** G19: the original previewed the map. Replace the name dropdown with a strip
  of 8 thumbnails (plus "ciclo" and "al azar"), each with its hazard icon (drill, tank, doors).
- **Spirit.** Finishing the original's screen. **Effort.** S (`LocalSetup.ts`,
  `NetworkLobby.ts`; images already in `public/assets/levels/`). **Risks.** Width on phones.
  **Depends.** E3 would add entries here. **Headless check.** Screenshot; selecting a
  thumbnail sets `levelMode`.

### F. Mobile and devices

#### F1. Phone basics: wake lock, haptics, fullscreen nudge

- **What / why.** Nothing in `src/` uses `navigator.wakeLock` or `navigator.vibrate` (grep).
  A phone dims and locks during the summary if you do not touch it. Add: wake lock while a
  game screen is open; a 30 ms buzz on pickup and 200 ms on your own death (Android only;
  iOS Safari has no Vibration API, so nothing happens there); a one-time "tap for fullscreen"
  hint, since the browser chrome takes a fifth of a landscape phone.
- **Spirit.** Invisible plumbing. **Effort.** S (`TronGame.ts`). **Risks.** Wake lock must be
  re-acquired on `visibilitychange`. **Depends.** Touch-modes branch owns the control layout;
  this does not touch it.
- **Headless check.** Playwright with a stubbed `navigator.wakeLock` / `vibrate`: called on
  game start / on own `deaths` event, released on leaving.

#### F2. Installable and offline (PWA)

- **What / why.** Static hosting plus hashed assets make this nearly free: a manifest
  (name, icons, `display: fullscreen`, `orientation: landscape`) and a small service worker
  caching the build. Installed, the game opens without browser chrome in landscape and plays
  local/bot games offline (train, plane).
- **Spirit.** A game you *have*, like the folder with `TRON.EXE`. **Effort.** S-M
  (`index.html`, `vite.config.ts`, a hand-written worker or `vite-plugin-pwa`).
- **Risks.** Stale clients. The room id already includes a protocol version
  (`RoomConnection.ts:17`), so an old install cannot corrupt a room, but it would silently
  land in a different, empty room: show "update available, reload" when the worker finds a
  new build.
- **Depends.** None.
- **Headless check.** Playwright: load, go offline (`context.setOffline(true)`), reload,
  start a local game.

#### F3. Phones as controllers for a shared screen

- **What / why.** The original was one screen (G21) and solved "fourth player has no keys"
  with a mouse (G20). Today's version: the laptop or TV shows the arena; each phone joins the
  room by QR in **controller mode**: no arena, just the steering control, the action button,
  the player's own sidebar panel (weapon, ammo, effect timer) and vibration. Everyone looks
  at the same big picture again. Sketch in §5.
- **Spirit.** The closest thing to the original experience this project can offer, and it
  is mostly a *subset* of what already exists (a guest that renders less). Purist: none.
- **Effort.** M. A guest that sends inputs but skips arena rendering and prediction display;
  host screen in "TV" layout; lobby toggle "this device is the screen". Input latency is one
  way only (the player watches the host's screen), so it is better than normal guest play.
- **Risks.** Steering without looking at your thumbs needs the BUTTONS mode with big targets
  and haptic edges; the host device must not sleep (F1); on a LAN without internet, signaling
  still needs the Nostr relays (`design/networking.md`).
- **Depends.** Touch-modes branch (which mode survives); spectators branch (the host "screen"
  with no seat of its own is a spectator that hosts: coordinate on that concept).
- **Headless check.** Two-browser e2e as in `tests/e2e/network.e2e.mjs`: the controller page
  has no arena canvas, its touches move the host's player, its panel shows the picked weapon.

#### F4. Gamepads

- **What / why.** Already in `TODO.md` (Later). The mouse of 2026: four pads on one laptop
  or a TV. Stick or d-pad/shoulders to turn (proportional steering already exists:
  `TronInput.steer` is -1..1), any face button for action, rumble on death.
- **Spirit.** Couch play. **Effort.** S-M (`src/game/input/InputManager`, a `gamepad:N`
  control scheme in `ControlScheme`, local setup "press a button to join").
- **Risks.** Gamepad API needs polling and a first button press; analog steering makes
  gamepad players turn more precisely than keyboard players (as touch already does).
- **Depends.** None.
- **Headless check.** Unit test of the mapping with a fake `navigator.getGamepads()`.

### G. Accessibility

#### G1. Colour-blind-safe palette and shapes

- **What / why.** FFA is red vs green (`FFA_COLORS`, `src/types/lobby.ts:10-15`), the classic
  unreadable pair; teams are purple vs brown. Offer an alternative palette (for instance
  orange / sky blue / white / magenta) as a per-device setting. Colours are render-side
  (`PixelGrid` stores palette indices), so two players in the same room can see different
  palettes.
- **Spirit.** Purist: Rojo, Verde, Azul, Amarillo *are* the players' names. Keep the names
  and the default.
- **Effort.** S-M. `TronRenderer` trail painting by slot instead of by colour string; the
  colour string travels in `TronPlayerState.color` today, so the mapping needs a look.
- **Risks.** The colour-blindness *gag* effect (colour cycling after a Swap) is a joke about
  exactly this; keep it, it scrambles any palette equally.
- **Depends.** **Shading branch** is redoing how trails and heads are drawn; this must be a
  parameter of that work, not a parallel change.
- **Headless check.** Palette pairs pass a simulated deuteranopia/protanopia distance
  threshold (pure function test); screenshot with the alternative palette.

#### G2. Reduced flashing

- **What / why.** The mega-bomb white flash lasts 308 ticks, 4.4 s (`WHITE_FLASH_DURATION`,
  `TronGameState.ts:232`), and the colour-blindness gag cycles colours for 4 s. There is no
  `prefers-reduced-motion` handling in `src/` (grep). Add a setting (default from the media
  query): flash becomes a 150 ms fade to 30 % white, colour cycling becomes a single swap,
  no shake (B4).
- **Spirit.** Render-only. **Effort.** S (`TronRenderer.ts:260-270`, `166`, `233`).
- **Risks.** The white flash also hides the arena on purpose; reduced mode keeps a dim veil.
- **Depends.** Shading branch (same file). **Headless check.** Renderer test: with the flag,
  peak overlay alpha ≤ 0.3.

### H. Network robustness

#### H1. A dropped player becomes a bot until they return

- **What / why.** Seats already survive reloads by `userId` (`TODO.md`, Room & session
  robustness). While the owner is away, their vehicle goes straight into a wall and they must
  be waited for at ready-up. Instead: after 2 s without inputs from a seat, the host runs a
  normal bot for it (panel shows a robot icon); when the player returns they take over at the
  next tick.
- **Spirit.** The friend who takes your keys while you answer the door. **Effort.** S-M
  (`HostSession`: bots and remote seats already coexist; switch a seat's controller at
  runtime; ready-up counts the bot as ready).
- **Risks.** Short network hiccups must not trigger it (threshold; input queue already tracks
  acks). The returning guest's prediction must resync (snapshot path exists).
- **Depends.** Human-like bots branch (the stand-in should not play better than its owner).
- **Headless check.** `tests/netsim.ts`: cut a guest's link for 5 s; its player keeps
  steering and survives longer than the no-input baseline; link returns, control returns
  within N ticks, no divergence.

#### H2. Host handover at round boundaries (cheap host migration)

- **What / why.** Full host migration is in `TODO.md` and is large (mid-round authoritative
  state transfer). 90 % of the value for a fraction of the cost: every guest already holds
  the match state (scores, round, level). When the host disappears (25 s grace today), the
  lowest surviving seat becomes host, the *current round is void* and a new round starts with
  the scores intact. The host's own seat becomes a bot (H1) or is vacated.
- **Spirit.** "The owner of the PC went home; we carry on at mine." **Effort.** M-L
  (`RoomConnection`: who may write room state is currently "only the host", so election
  needs a rule every peer computes identically; `GuestSession` → `HostSession` promotion).
- **Risks.** Split brain if two guests both think they are the successor (deterministic rule:
  lowest seat index among peers that still see each other, plus the room-state write as the
  tie-breaker). Trystero room state ownership needs study; I did not verify how hard
  transferring write authority is.
- **Depends.** Spectators branch (peer lists); C1 (match state to carry).
- **Headless check.** Extend `tests/netsim.ts` with three sessions; kill the host; assert one
  and only one new host, same scores, round restarts. Then the two-browser e2e with a third.

### I. Bots

#### I1. Bots with names and manners

- **What / why.** Bots are "Green Bot" at one of three difficulties. A thin layer on top of
  the existing difficulty table (`design/local-and-ai.md`, Difficulty): four named characters
  that differ in the *existing* knobs (hunts enemies / seeks items / uses weapons) and in
  which honk they send (C3) when they kill or die: one that grabs every item including the
  bad ones, one that only hunts, one coward that survives, one that fires the moment it has
  a weapon. Names in the house style; whether to use the names found in the original files
  (G16) is for the owner, since they are real friends' names.
- **Spirit.** A party filler should have a character you can hate. Purist: the original had
  no bots at all.
- **Effort.** S-M. Presets over `BotController` parameters; naming in `roomLogic.ts:109` and
  `localSetup.ts:58`.
- **Risks.** Presets that are simply worse bots.
- **Depends.** **Human-like bots and territory-aware bots branches own bot behaviour.** This
  idea is only naming, presets and taunts, and should be built on whatever knobs those
  branches end up exposing.
- **Headless check.** `npm run sim` per character: measurable differences in items taken,
  shots fired, kills, survival time.

### J. Coming back, without accounts

#### J1. "La libreta": a local hall of fame and rivalries

- **What / why.** Scores die with the tab. Keep, in `localStorage` on each device, a record
  per finished match (date, room code, names, scores, awards). Show in the lobby: "Última
  vez: Ana 5, Luis 3 (hace 6 días)" for people whose nickname you have played against, and a
  small page of records: longest winning streak, most ridiculous deaths in a match.
- **Spirit.** The paper score sheet stuck to the monitor. No server, no identity beyond the
  nickname people type. **Effort.** S-M after C1. **Risks.** Nicknames are not identities
  (two Anas); accept it, this is a notebook, not a ranking. Each device has its own copy.
- **Depends.** C1 (needs matches to record).
- **Headless check.** Unit test of the record store (append, cap at N entries, corrupt JSON
  tolerated).

#### J2. A room of your own: choose the room code

- **What / why.** Codes are random (`generateRoomCode`, `src/network/roomCode.ts`), so every
  session needs a new link. Let the creator type a code ("los-del-instituto"); the link and
  an installed shortcut (F2) then always lead to the group's room.
- **Spirit.** A regular table at the bar. **Effort.** S (`MainMenu.ts`; `normalizeRoomCode`
  already sanitises). **Risks.** Guessable codes let strangers in: show who is in the room
  (already the case) and let the host kick; say so next to the field. Two people "creating"
  the same code at once: whoever is second should join, not host; I did not check how
  `RoomConnection` resolves two hosts in one room, and this must be checked first.
- **Depends.** Spectators branch (uninvited visitors land as spectators).
- **Headless check.** `tests/room.test.ts` for the double-create case; e2e join by typed code.

### K. Language

#### K1. Spanish first, with the original's words

- **What / why.** G14-G17. A string table with `es` and `en`, chosen from
  `navigator.language` with a toggle on the menu. Spanish uses the original's vocabulary:
  Jugar, Puerta (leave), PUNTUACIONES, Ganador, Empate, ¿Otra?, Rajados…, Rojo/Verde/Azul/
  Amarillo, Violetas/Marrones, and the item names Cruces, Escudo, Borrador, Cambiazo,
  Controles trastornados. Death labels get proper Spanish with attitude ("se ha comido su
  propia raya").
- **Spirit.** Home-made and Spanish is property 6. Purist: would make Spanish the only
  language. English stays for the people the link gets shared with.
- **Effort.** S-M. Strings are inline in `MainMenu.ts`, `LocalSetup.ts`, `NetworkLobby.ts`,
  `TronRenderer.ts` (summary, lines 776-886), `deathLabels.ts`, `roomLogic.ts:109`. No
  library needed: one object per language and a `t()` function.
- **Risks.** Bot and colour names travel as nicknames in the room state in the host's
  language; either accept it (it is charming) or send a key.
- **Depends.** A3, B3, C1 all add strings; do K1 first or pay twice.
- **Headless check.** Test that both tables have the same keys; Playwright with
  `locale: 'es-ES'` asserts "PUNTUACIONES" on the summary.

---

## 4. Ranking

### Top 10 by value for effort

1. **B1 + A1: readable deaths and starts (S).** Two small renderer/simulation changes fix the
   two moments a newcomer is most lost: "which one am I?" and "what just happened to me?".
   One of them is a plain regression from the original (G10). Nothing else here buys as much
   per hour.
2. **C1: match, podium, awards, ¿Otra? (M).** Gives a session an ending and a punchline, and
   puts the rewrite's best original idea (the ridiculous-death counter) on stage. Everything
   in "coming back" (C2, J1) hangs from it.
3. **D1 with E1: Opciones and the Classic preset (M; E1 alone is S).** Settles the fidelity
   question (G1-G3) by letting both tables exist, finishes a screen the original started, and
   becomes the home for match length, handicap and sudden death.
4. **F3: phones as controllers (M).** The only idea that restores property 1, the shared
   picture, and it reuses the netcode instead of extending it. Ranked below the first three
   only because it depends on which touch mode survives and on the spectators work.
5. **K1: Spanish with the original's words (S-M).** Cheap, makes the game recognisably
   itself, and is cheaper now than after A3/B3/C1 add fifty more strings.
6. **F1 + F2: phone basics and PWA (S + S-M).** A dimming screen and browser chrome are the
   kind of friction that ends phone sessions; both fixes are small and invisible.
7. **A3 + B3: call-outs, legend and kill feed (S-M).** Replaces the friends shouting next to
   you. Needs K1 to be worth reading.
8. **H1: absent player becomes a bot (S-M).** Turns the most common network failure in a
   party (someone's phone locked, someone went for a drink) from "everybody waits" into a
   joke.
9. **B2: Web Audio (M).** Sound is half of the original's humour and the current manager
   cannot vary, place or mix it. Pure engineering, low risk, and the base for B1's scream and
   C3's honks to sound right.
10. **A2: attract mode and one-tap play (M).** First impressions; the menu currently says
    nothing about what the game is. Lower because it leans on a refactor (T6) and on the
    performance work.

Next in line: E3 (bring your own level; high spirit value, waits for the backgrounds branch),
F4 (gamepads), C3 (honks), J1 (libreta), D2/D3, E4, G1/G2 (should ride along with the shading
work), H2, D4, I1, E2, C2, C4, D5, J2.

### Quick wins this week

All S, independent, no protocol redesign:

- B1 death explosion and `uah` (one function).
- A1 start rings during the countdown.
- E1 Classic item table behind a constant or `?items=classic`, and correct the "rare"
  H-missile note in `design/old-tron-design.md`.
- F1 wake lock and vibration.
- G2 shorten and soften the 4.4 s white flash under `prefers-reduced-motion`.
- C4 names for local players and a score digit on each panel.
- E4 level thumbnails.
- A legend for the summary's unexplained **MR** column header
  (`TronRenderer.ts:795`): write "Muertes ridículas" or use the skull-with-hat icon.

### Don't do

| Tempting idea | Why not |
|---------------|---------|
| More than 4 simultaneous players | The sidebar, colours, corners, team split and item density are all built on four (PRG 14, 692-750). Six trails on 750×600 with H-bombs is noise, and every guest costs the host upstream. D4 (rotation) serves the six-person party better. |
| Accounts, global ranking, public matchmaking | Needs a server and moderation, and replaces "my friends" with strangers. The game's balance (property 2) is hostile to ranked play by design. J1/J2 give the continuity without it. |
| Balancing the items (removing self-debuffs, nerfing the bomb, equalising weapons) | Unfairness is the content. Offer tables (D1), do not converge on a "fair" one. |
| In-game music | The original had none (G13) and the effects are the soundtrack; on phones it also fights with people talking. |
| Neon glow, thick anti-aliased trails, particles on trails | Breaks property 3: what you see must be what kills you. Any thickening for phone visibility belongs to the shading branch and must stay pixel-honest. |
| Skins, unlocks, XP, daily quests | Retention mechanics for a solitary player; nobody at a party cares, and it is exactly the polish that makes it stop looking home-made. |
| Free-text chat during play | Nobody can type while steering; it moves attention off the arena. Honks (C3) cover it; the lobby keeps its chat. |
| Voice chat | Large WebRTC and permission surface for something every group already has (a call, or being in the same room). |
| Kill-cam / full replays | Feasible in principle (deterministic simulation with seeded RNG), but the summary already says who did it, and a replay delays the next round (property 5). Revisit only as "save last round as GIF" for sharing. |
| Shrinking arena / battle-royale circle | A foreign mechanic. D3 gets the same effect with the original's own border lock. |
| 90° grid turning "like real Tron" | Teratron's free-angle steering and diagonal pixel rules (`Ondia`, PRG 884-903) are its handling. |
| A tutorial level | Longer than a round. A1 + A3 teach in place. |
| Shipping the original splash and intro | The splash is a Counter-Strike parody built on third-party art (G12), and the FLI is 3.8 MB. Keep them in `old-tron/` as history. |
| A dedicated game server "to fix lag" | Contradicts principle 3 of `design/architecture.md`; prediction already makes steering immediate. TURN provisioning (open item in `TODO.md`) is the real connectivity fix. |

---

## 5. Deeper sketches for the top 3 (and the controller mode)

### 5.1 Readable deaths and starts (B1 + A1)

**Rules / UX.**
- On any death: explosion animation at the death pixel, scale 0.2, 39 frames (as PRG
  853-861), drawn also at the wrapped positions when within 20 px of an edge (PRG 815-851);
  sound `uah` unless the death is ridiculous (`panico` as today). The existing `laughs` moves
  to "someone else died ridiculously" or is dropped; owner's call, I could not listen to the
  files.
- Countdown: per player a 24 px ring in their colour, nickname above, a 12 px heading tick.
  Local human seats: ring 36 px, label "TÚ" (or the key hint when several humans share the
  machine). Rings fade out during the last 0.5 s. Nothing is drawn once `phase === 'playing'`.

**Data / protocol.** None for A1 (positions, names and local slots are already known to the
renderer). B1 reuses `Explosion {id, x, y, frame, scale}` (`src/types/game.ts:80-86`), which
is already serialised each tick, and adds `'uah'` to `SOUND_NAMES`. The wire format does not
change shape. Bump nothing.

**Where.** `TronGameState.killPlayerWithSound` (line 318) and the two direct `p.kill()` sites
in the crossing check (lines 562-563) → one helper that kills, records, explodes and queues
the sound. `TronRenderer` countdown overlay. `public/assets/sounds/uah.mp3` from
`old-tron/media/UAH.WAV`.

**Test plan.**
1. `tests/rules.test.ts`: scripted wall crash → the frame's `round.explosions` has one entry
   at `deaths[0].x/y`; `soundEvents` contains `uah`; own-trail crash → `panico`, still one
   explosion.
2. Crash at x < 20: renderer draws the explosion twice (unit test on the draw-list helper).
3. `tests/netcode.test.ts`: guest sees the same explosion id once (no duplicates from
   reconciliation).
4. Playwright (desktop and 844×390): screenshot at countdown t = 1.5 s; count coloured pixels
   within 40 px of each start corner > threshold; at first playing tick the count drops back.
5. `npm run sim`: bot results unchanged (the change is cosmetic; any difference is a bug).

**Open question.** Bots read explosions? If `BotController` treats explosions as hazards, a
death explosion would repel bots from corpses; check before merging (I did not).

### 5.2 Match, podium and awards (C1)

**Rules.**
- `matchLength: number | null` (wins needed; `null` = endless, the original's behaviour and
  the default for local games; network default 5).
- FFA: the match ends when a player reaches N at the end of a round. Team mode: when a team's
  summed score reaches N (`design/teams.md` scoring; with two survivors a team gains 2, so N
  is "points", and the setting should say so).
- Draw rounds score nothing, as today; a match cannot end on a draw.
- New round phase `match_over` after the last round's normal summary has been shown for 3 s:
  podium (order by score, ties by fewer ridiculous deaths, because that is funnier than by
  seat), then up to four awards, one line each, revealed one per second.
- Awards (pure function of the match's death log and round winners; only awarded when the
  count is ≥ 2, at most one per player, priority in this order): Rey del ridículo, Víctima
  favorita (pair), Pistolero, Kamikaze, Pacifista, Intocable (fewest deaths).
- From `match_over`: any player's action = vote for **¿Otra?**; rematch starts when all
  humans voted or the host presses START; host also has **LOBBY**. Scores reset, seats stay.
- Independently of matches: in `waiting_ready`, after 10 s the host's action starts the round
  even if somebody is not ready (G18).

**Data model.**
```ts
// GameConfig (types/game.ts:21)
matchLength: number | null;

// TronMatchState (types/game.ts:134) additions
matchLength: number | null;
stats: Partial<Record<SlotIndex, {
  kills: number; selfKills: number; deaths: number;
  killedBy: Partial<Record<SlotIndex, number>>;   // for Víctima favorita
  cleanWins: number;                               // rounds won with 0 kills
}>>;
matchWinner?: SlotIndex | 'purple' | 'brown';     // set in match_over

// RoundPhase (types/game.ts:116)
'countdown' | 'playing' | 'waiting_ready' | 'match_over'
```
Stats are accumulated by the host in `recordDeath` (line 310) and travel in the match state,
which is already sent with every frame and in snapshots; that is 4 small objects, but to keep
the per-tick payload flat they should only be serialised when they change (the slim wire
format in `serialization.ts` already treats match data positionally; add a "stats changed"
one-shot like `deaths`). Awards are computed by each client from `stats`, so no strings cross
the wire and K1 applies locally.

**Protocol impact.** New phase value and new fields → bump the protocol version in the room
id (`RoomConnection.ts:17`) so old builds do not meet new ones. Late joiners/reloaders get
`stats` through the existing snapshot path.

**UX flow.** Lobby / local setup: "Partida a: 3 · 5 · 10 · ∞". In game: the sidebar score
digit (C4) shows progress; when someone is one win away, the countdown caption reads "PUNTO
DE PARTIDO" (cheap drama). Podium replaces "GET READY"; the share button (C2) and the
libreta write (J1) hook in here.

**Test plan.**
1. Unit: `computeAwards(stats, scores)` table tests, including ties and team mode.
2. `tests/rules.test.ts`: scripted rounds to N → phase `match_over`, no further `initRound`
   until rematch; rematch zeroes scores and stats and keeps seats; endless never ends.
3. `tests/sim.ts`: 200 seeded bot matches at N = 5 finish; report rounds per match and how
   often each award is given (an award that is given < 5 % or > 80 % of matches needs retuning).
4. `tests/netcode.test.ts`: guest's match view (scores, stats, phase) equals the host's at
   every round boundary, also after a mid-match snapshot.
5. Playwright: podium screenshot on both viewports; with `locale: 'es-ES'` the awards are in
   Spanish (after K1).
6. `tests/room.test.ts`: host override after the ready timeout.

**Open questions for the owner.** Does a rematch rotate seats/colours (the corner is an
advantage on some levels)? Should the network default be 5 or endless?

### 5.3 Opciones: rule set with a Classic preset (D1 + E1)

**Rules.**
```ts
interface RuleSet {
  itemTable: 'classic' | 'revival';
  itemRate: 'none' | 'normal' | 'rain';      // spawn interval ×∞ / ×1 / ×⅓
  startShield: 0 | 5 | 30;                   // seconds, everybody (G8)
  matchLength: number | null;                // C1
  suddenDeath: number | null;                // seconds until the arena locks (D3)
}
```
- `classic` item table = PRG 451-534 exactly: 40 % automatic (uniform over the 7 originals;
  satellites excluded), 50 % weapon with weights 16/12/16/20/8/12/16 (Glock, Rifle, Uzi,
  Bomb, Lock, Shotgun, Turbo; no Slow weapon), 10 % mystery; **no cap** on items on the
  field; spawn anywhere within the 20 px margin, also next to players. The mystery item:
  owner's call between "random weapon" and the faithful "half are duds" (G3); my suggestion
  is a dud with a sound, so the joke is audible.
- `revival` = today's behaviour, unchanged, so existing bot thresholds stay valid.
- Presets: **Clásico** (classic, normal, 0, ∞, off), **Revival** (revival, normal, 0, 5,
  90 s), **Caos** (classic, rain, 5, 5, 60 s).

**Where.** `ItemLauncher` takes a table object instead of module constants
(`ItemLauncher.ts:8-11, 67-87`; `MAX_ITEMS_ON_FIELD` becomes a field that is `Infinity` in
classic). `GameConfig.rules` (`types/game.ts:21`), passed to `TronGameState`'s constructor.
Lobby: `LobbyState.rules` next to `gameMode`/`levelMode` (`types/lobby.ts:71`), editable by
the host only like the other settings; `roomLogic.ts` builds the config. Local setup stores
it with the rest. UI: three preset buttons and a "más…" disclosure with the five switches.

**Protocol impact.** `rules` is part of the lobby's synchronised state and of `game_start`'s
config; guests need it only for display (the host simulates), except `matchLength`, which
they read from the match state anyway. Protocol version bump.

**Performance note.** Uncapped items means more sprites and a longer `items` array per tick
on the wire. At one spawn per ~7 s a 3-minute round reaches ~30 items; the slim format sends
items every tick, so measure bytes/s in the netcode rig and, if needed, send items as
add/remove events. This is the one place this idea touches the performance branch.

**Test plan.**
1. Unit, seeded: 20 000 classic spawns → class shares within 1 % of 40/50/10 and weapon
   shares within 1 % of 16/12/16/20/8/12/16; no `bodyguard_item` or `slow` weapon in classic.
2. Unit: classic has no cap (after 5 000 ticks without pickups there are > 6 items); revival
   still caps at 6 (regression).
3. Fuzz (`tests/rules.test.ts`) runs once per preset; invariants hold; determinism per seed
   per preset.
4. `npm run sim` per preset: round length, deaths by cause, items picked. Expect classic to
   show more bomb deaths; that is the point, but if median round length falls under ~10 s
   the owner should know before choosing defaults.
5. `tests/room.test.ts`: only the host can change rules; a guest's lobby view shows them;
   config built from the lobby carries them.
6. Netcode rig: bytes/s with 30 items on the field.
7. Playwright: preset buttons on both viewports; choice persists across reload.

### 5.4 Bonus sketch: controller mode (F3)

**Flow.** Host opens the game on the big screen, creates a room, ticks "esta pantalla es la
tele" (the host then has no seat unless it also picks a keyboard scheme). Phones scan the QR;
the join page, on a touch device joining a "tele" room, offers **MANDO** (default) or
**pantalla completa** (today's guest view). In MANDO the phone shows: colour and name, the
steering control, the action button, the weapon/effect panel with ammo and timers, a big
"LISTO" state between rounds, and buzzes on pickup/death.

**Protocol.** Inputs unchanged (`TronInputMessage`). State: the controller ignores everything
except its own `TronPlayerState` and the phase; as an optimisation the host can send
controllers a reduced frame (own player, phase, scores) at 10 Hz instead of 70, which also
removes most of the phone's battery and bandwidth cost. No prediction is needed because the
player is not looking at the phone.

**Latency budget.** Touch → host is one WebRTC hop; on a LAN that is a few milliseconds plus
up to one 14 ms tick. That is better than a normal guest's perceived latency without
prediction and comparable to a wireless gamepad. To be measured, not assumed: the e2e rig can
timestamp touch dispatch and the host's applied input.

**Test plan.** Two-browser e2e (host desktop viewport, controller phone viewport): no arena
canvas on the controller; synthetic touches change the host player's heading within 3 ticks;
picking up a weapon on the host shows its sprite on the controller; `?lag=100` still
steerable. Unit: reduced frame encoding round-trips.

---

## 6. What was checked and what is opinion

**Checked by reading.** All of `old-tron/TRON.PRG`; the design docs' structure and the parts
cited; `src/types/game.ts`, `src/types/lobby.ts`, `ItemLauncher.ts`, `SoundManager.ts`,
`deathLabels.ts`, `MainMenu.ts`, and targeted parts of `TronGameState.ts`, `TronRenderer.ts`,
`roomCode.ts`, `localSetup.ts`; `TODO.md`. Greps for wake lock, vibration, gamepad, manifest,
service worker, reduced motion, i18n (all absent).

**Checked by running.** `npm ci`, then headless Chrome via playwright-core against the Vite
dev server: main menu, local setup, countdown, mid-round, round summary and host lobby at
1366×768 and at 844×390 touch; no page errors. Screenshots in `img/`. Original art viewed by
converting BMPs (`splash`, `Inédito`, `Vicente`, `INICIO`, some item sprites).

**Not checked.** I did not listen to any sound, play the intro FLI, run the original, play
on a real phone, or run the unit tests / `npm run sim` for this document. Round-length claims
(D3), bot behaviour around explosions (5.1), award frequencies (5.2), item payload size
(5.3), Trystero's ability to hand over room authority (H2) and the double-create case (J2)
are flagged where they appear and need measuring or reading before a decision.

**Opinion.** The spirit statement, every ranking, all effort estimates, the "don't do" list,
and the proposed designs of new things (awards, Torpedo/Tele, honks, bot characters).
