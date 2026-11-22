# Teratron Revival — Backlog

What is left to do. Finished work is not listed here once it is described in `design/`
(and it is all in the git history); a ticked item is one that is done but written down
nowhere else. Design docs are updated *before* the code for each feature (see CLAUDE.md).

Legend: `[ ]` todo · `[x]` done, not documented elsewhere · **bold** = needs the owner or
a real device

---

## Needs a real device or the owner

- [ ] **Provision a TURN service and set the env vars for the deployed build** (Cloudflare
      Realtime TURN recommended; see `design/networking.md`). Until then players behind
      carrier-grade NAT cannot connect, and the lobby says so
- [x] **Verify across networks** (phone on mobile data ↔ laptop on Wi-Fi)
- [ ] **Touch controls on a real phone**: pick a winner among BUTTONS, POINT and STICK,
      tune it, remove the losers (and nipplejs with the old stick)
- [ ] **Display on the iPhone**: tune the opacities in `display/settings.ts` and the
      twinkle in `TronRenderer.drawPlayerHead`
- [x] **Menu, local set-up and lobby on the iPhone** (`design/screen-layout.md`; checked
      only in headless Chrome at phone sizes): both orientations in Safari — nothing cut
      off beside the notch or under the tool bars, no zoom when a field gets the focus,
      the keyboard stays open while chat messages arrive and after SEND, the chat field
      stays above the keyboard, the sticky START button sits right above Safari's bottom
      bar, the small QR code scans (a tap enlarges it)
- [ ] **Performance on real phones** (list at the end of `design/research/performance.md`):
      low-end Android hosting 3 hard bots on Portals, a firefight, iOS Safari, a 120 Hz
      screen, heat. If bot spikes show inside the worker: cap the bot plans per tick
- [ ] **Play against the bots**: wall-hugging endgames and no chasing from behind may feel
      different since the territory map; `easy` is weaker than before the human-like layer
      (78 % against 69 % dead within 20 s when left alone) — lower its strength?
- [x] **Laptop vs phone: both players died at the first instant of round 1.** Not
      reproduced with two headless browsers. Deaths are logged to the console
      (`[game] X died: <cause> at x,y`); need to know which device hosted, which browser,
      and whether it was the dev server or the deployed build

## Gameplay

- [x] Items can spawn hidden under a closed door (faithful, but maybe not fun). It's fine. It's also a bonus for the shield item.
- [ ] **Swept tracers** (`TRACER_SWEEPS`, `design/projectiles.md`): an experiment, switched
      on. Keep or drop; meanwhile three tests fail ("Uzi fire goes over a thin wall",
      "sustained fire gets past a lone satellite", "a watcher rebuilds exactly the host
      arena")
- [ ] **Satellites crossing the screen** kill whatever is on their way and turn round
      mid-arena (`design/bodyguards.md`, "the orbiting bug, on purpose"): keep, make the
      crossing harmless, or take the short way through the edge
- [ ] Match length setting
- [ ] Keep scores across "back to lobby" (optional setting)
- [ ] Gamepad support

## Bots

Design: `design/local-and-ai.md`, `design/bots-territory.md`, `design/bots-human.md`.

- [ ] Dodge projectiles and bomb blast areas (enemy heads are hazards in the rollouts;
      shots in flight are not). `hard` now knows which bomb is coming for it
      (`bombThreat`) but only acts on it with a gun in hand: unarmed, or once the bomb
      is too near to shoot, it does nothing (30 of 168 die in the staged attack of
      `HUMAN_REPORT=bombs`)
- [x] `normal` keeps the old bomb rule: it fires at a bomb, or through one, from as near
      as 75 px (`defusesBombs` is hard-only so far)
- [ ] Shooting items an enemy gets to first (`deniesItems`, hard): no gain in 1280 rounds,
      and it fails more often than it works (68 items destroyed, 111 taken all the same).
      Keep it, make it choosier (only weapons and shields? only when the enemy is weak
      without it?) or drop it. The Uzi and the H-bomb are not used for it
- [ ] Lines of fire are judged as if tracers still swept their path (they act only where
      they land now)
- [ ] Endgame: a real space-filling planner (finish a side chamber before sealing it;
      handle wedges between non-parallel passes) instead of the wall-hugging bonus
- [ ] Mid-game: tell which side of a cut is bigger beyond 400 cells without paying for
      large flood fills on every candidate
- [ ] Risk map: enemy lines of fire and satellites per cell (for goal choice); today they
      are only in the rollouts
- [ ] The room a bot counts at the end of its own path ignores its Shield / Crossing (the
      map's reach does not)
- [ ] Tight places: `normal` threads gaps half as often as before the human-like layer,
      `hard` does not, and both spend more time squeezed; look at replays before tuning
- [x] Late perception of trail pixels (bots see every new trail pixel at once, on the
      territory map too)
- [ ] Human-like bots build their own map on the first tick of a round (2–3 ms once):
      build it during the countdown instead
- [ ] Under colour blindness a bot still knows who is who among the *others* (which
      bike holds which weapon); only finding its own bike is modelled
- [ ] Watch a Swap under colour blindness in a real game: `easy` is lost for 1–3.6 s
      (a quarter of them die within 3 s); too much, or just right?
- [ ] Bots that know they see late could also *lead* their shots at enemies (they lead
      the ones at H-bombs); today the aim error only ever hurts
- [ ] Setting in the local set-up screen for the human-like strength (now only `?human=`)

## Networking

Design: `design/networking.md`.

- [ ] Host migration, so that a host reload or drop does not end the game in progress
- [ ] Smooth the 1-tick corrections under heavy jitter (they snap)
- [ ] Guest-side jitter buffer for remote entities if real-world jitter looks bad
- [ ] Unreliable / unordered channel for state (needs transport support) to avoid
      head-of-line blocking on lossy links
- [ ] Optional alternative signaling (MQTT / own relay) if Nostr relays are blocked somewhere
- [ ] Uzi tracers are still 45 KB/s per firing player on the wire
- [ ] `clearedLines` frame events are no longer emitted by anything: remove them from the
      protocol and the renderer
- [ ] A worker that dies in the middle of a game loses the smooth lines; the worker
      fallback path and a worker failing mid-game are untested

## Display

Design: `design/display-layer.md`.

- [ ] Remove what the derivation no longer needs (several bands, 2× layers) and the
      `lightBackground` flag, which no level uses since Paper was removed
- [ ] Lock-border pixels in a rejoin snapshot are taken for trails (same colour as the player)
- [ ] Smooth lines of two colours running side by side can over-saturate slightly
- [ ] If tablets / ≥ 3 device px per logical px matter: a 2× `bold` with a two-step fringe
- [ ] When the scenario changes, items and players are replaced first rather than at the same time

## Code and tooling

- [ ] The game screen is not part of the phone layout pass: its results / round summary
      and menus were not checked at phone sizes in both orientations
- [ ] Lobby on a phone: the players panel is still rebuilt on every room change (a tap
      that straddles one is lost); a share button using `navigator.share` next to the
      copy buttons; chat is a scroll away from the seats when upright
- [ ] Split `TronGameState` into systems (weapons, bodyguards, portals)
- [ ] Extract the game's HTML / CSS out of `TronGame`
- [x] nipplejs 0.10 → 1.0 (API changed; needs a real touch device) or replace it with a
      small pointer-event joystick
- [ ] Deploy from CI (GitHub Pages action, instead of `gh-pages`) with the TURN settings
      as repository secrets
- [ ] Run `npm run test:e2e` in CI (needs Chrome and outbound WebSocket / UDP)
- [ ] Load the networking code on demand (it is about half of the bundle)
- [ ] Remaining `npm audit` findings are dev-only: `free-tex-packer-core` (sprite build
      script) and `node-turn` (local TURN server of the e2e test)

## Spectators

Design: `design/spectators.md`. Merged from `research/spectators`; not yet tried on real
devices.

- [ ] **Try it with real phones**: joining by QR from somebody's screen, asking to play,
      stepping down; what a spectator costs a phone that hosts (CPU, battery) was not
      measured
- [ ] Bandwidth, if it matters again (`design/networking.md`, "Considered and not done"):
      a state every second tick; players as differences; tracers from a seed if swept
      tracers are dropped. The stream to a player is 6–11 KB/s in a normal game, measured
      in Node only (`npm run bench:net`), not in real browsers since the new format
- [ ] Team mode with seat changes is unit-tested only
- [ ] Trystero's `scale` plug-in or `maxUsers` if rooms with many phones prove unstable

## Ideas not yet decided

- [ ] `design/research/ideas.md` and `gap-analysis.md`: proposals ranked by value for
      effort; nothing in them is approved. Pick what to specify next.
