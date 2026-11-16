# Spectators

People who are in a room without a seat: they watch the game, can be told how to join by
looking at anybody's screen, and can ask to play from the next round.

Related: [networking.md](./networking.md) (rooms, lobby state, netcode, snapshots),
[teams.md](./teams.md).

## Goals

1. **The join code is visible during the game**, outside the 750×600 play field, so that
   bystanders can join from what they see on somebody's screen. Network games only.
2. **Anyone who opens the room link is let in.** With a free seat in the lobby they are
   seated (as before); when the seats are taken, or a game is running, they **spectate**:
   they get the arena so far and then the live game, with no controls.
3. **A spectator costs the host little**, because the host may be a phone.
4. **The number of spectators is shown** between rounds and next to the join code.
5. **A spectator can ask to play and enters at the start of the next round** — never in the
   middle of one. A player can also step down and watch. "The start of a round" includes
   its countdown: while nobody has moved, seats still change hands.

## What was already there

Before this feature a newcomer during a game already became a seat-less guest with a
snapshot (`GuestSession` with no slot), and the lobby already listed users without a seat
as spectators. What was missing: any way to learn the room code from the game screen, a
spectator view (phones still showed the steering zone), any way into the game short of the
host sending everybody back to the lobby, a bound on what spectators cost, and the count.

## Join code on the game screen

A DOM element (not drawn on the canvas). Only the **room code** is shown while playing;
the QR code appears when the code is clicked or tapped, and goes with the next click. It
is closed whenever a game screen opens (not remembered): a QR code in view during play
was distracting.

- **Desktop**: in the header row above the canvas: `JOIN red-bear-moon · 👁 2`. A click
  opens a pop-over under it with the QR code of the link and the address of the game
  (where the code can be typed: *Network game → Join*). It covers the top of the arena
  while it is open.
- **Phone (landscape)**: the canvas is 4:3 and centred, which leaves a margin on each side.
  The right margin shows, under the top buttons, the room code and `👁 n`; if the margin
  is too narrow, the code in small type on one line at the top centre. A tap opens the QR
  in the middle of the screen; a tap on it closes it.
- Only in network games (`GameScreenOptions.room` present).

`👁 n` is the number of users in the room without a seat.

## Roles and how they change

| Situation | Result |
|-----------|--------|
| Join in the lobby, a seat is free | Seated (unchanged) |
| Join in the lobby, seats taken | Spectator; listed in the lobby; can chat; takes a seat when one frees up (click JOIN) |
| Join while a game is running | Spectator of that game, with a snapshot. **Not** queued to play automatically: an idle newcomer in a seat would hold up the ready-up of every following round |
| Spectator presses **PLAY NEXT ROUND** | Queued. Seated at the next round start if there is room (rules below), otherwise stays first in the queue: "waiting for a seat" |
| Player presses **WATCH** (step down) | Keeps playing the current round, is a spectator from the next |
| Player leaves the room deliberately | Says goodbye to the host; the seat is given up at the next round |
| Player disconnects / reloads | Seat kept for their return (unchanged) |
| Room goes back to the lobby | Everybody goes with it. Users who want a seat (`want ≠ null`) get free seats as usual, queued spectators first. Bots are not displaced in the lobby (the host put them there), but a request to play stays valid: if the next game starts with a bot, the queued spectator replaces it at the second round |

### When seats change

When a round starts, and **during its countdown**: if the plan changes while the
countdown runs (somebody pressed READY out of habit and then WATCH, or asks to play just
as the round begins), the round is set up again with the new players and the countdown
starts over. Once the round is being played nothing changes until it is over. A game that
starts with a bot and somebody queued therefore replaces the bot in its first countdown.

### Seating rules at a round start (`planNextRound`)

Applied by the host when a round is about to start, in this order:

1. Seats of players who stepped down or said goodbye become free.
2. Queued spectators, first come first served, each take: a **free seat**; otherwise the
   seat of a **bot** (humans replace bots); otherwise they keep waiting. Nobody ever
   displaces a human. At most 4 play.
3. If the game would fall below its minimum (4 in team mode, 2 in free-for-all), free seats
   are filled with `normal` bots, so a team game stays 2 vs 2 when somebody leaves.

Seat numbers decide colours and, in team mode, the team (slots 0/2 vs 1/3): a newcomer gets
the team of the seat that was free or held by the replaced bot, so teams stay balanced by
construction.

### Scores

- Free-for-all: whoever takes a seat **starts at 0 wins and 0 MR**, also when replacing a
  bot. Everyone else keeps their score.
- Team mode: the seat's wins belong to the team score ([teams.md](./teams.md)), so the
  newcomer **inherits the wins of the seat** (the team does not lose points because a bot
  was replaced); MR starts at 0.
- Players who leave take their score with them (it is no longer shown).

### Ready-up

The next round starts when every player **who stays for it** is ready. Players leaving at
the round boundary are not waited for; players arriving are not asked (they asked to play).
If nobody stays (everybody was replaced), the round starts when the 1 s ready lock ends.

### Alternatives considered

- *Seat newcomers automatically during a game.* Simplest for people who want to play, but a
  bystander who only scanned the code to watch would block the ready-up. One tap is cheap.
- *Add the newcomer when the round ends (so they appear in the table and must ready up)*
  instead of when the next starts. More ceremony, and one more person who can stall.
- *Round-robin when the queue is longer than the free seats* ("winner stays"). Would need a
  rule for who leaves; left out. The queue just waits; players can step down.
- *Start newcomers with the lowest current score* instead of 0. Not faithful to anything.
- *Let a queued human displace the lowest-scoring human.* Rejected: hostile.

## State and protocol

### Lobby state (Trystero synchronised state, see networking.md)

```ts
interface Profile {            // per user, written by that user
  name: string;
  want: number | null;         // seat wanted in the lobby; null = spectate / step down
  joinNext?: boolean;          // asks for a seat at the next round of the running game
}
interface SharedRoom {         // written by the host only
  ...
  queue: string[];             // userIds waiting for a seat, in the order they asked
  watchers: string[];          // admitted users without a seat, in order of arrival (capped)
}
```

- `slots` keeps meaning "who is seated **in the game being played**". During a game the
  host changes it only at a round start, together with the simulation.
- `reconcile` (host, any change of profiles) maintains `queue` and `watchers`. In the lobby
  it seats people as before (queued users first).
- `planNextRound(room, profiles, departed)` is a pure function giving the seats of the next
  round. The host pushes its result to the simulation whenever it changes; **any client**
  can evaluate it to show "Ana joins next round" / "waiting for a seat".
- `bye` action: a guest that leaves deliberately tells the host (`left`), so its seat is
  not kept for a return that will not happen.
- `APP_ID` becomes `teratron/v3`: older builds cannot read the new frames.

### Roster in the game stream

The room state and the game stream travel separately, so the stream itself says who plays:

```ts
// TronGameStateData.roster — sent when it changes, once a second, and in snapshots
type RosterEntry = [slot: number, nickname: string, color: string, owner: string, bot?: BotDifficulty];
// owner: userId of the human in the seat, 'ai' for a bot; bot: its difficulty (side-panel icon)
```

- `TronGameState.setNextPlayers(players)` stores the next roster; `initRound` applies it:
  creates/removes players, resets scores as above, bumps `rosterVersion`.
- `HostSession` then rebuilds what depends on it (local slots, bots, input queues, acks:
  a new occupant must not inherit the previous one's input sequence), tells the room
  (`onRosterApplied` → `slots` is written, stream targets recomputed) and puts the roster
  in the frame of that tick — the same frame that carries `roundStarted`.
- Guests take **their role from the roster** (`owner === selfId`), not from the room state:
  a client becomes a player, or stops being one, exactly on the frame where the simulation
  does. `GameSession.onRoster(players)` tells the game screen, which swaps controls and
  the spectator banner without rebuilding the renderer.
- The host accepts inputs for a slot only from the roster owner of that slot.

### Spectator stream: what a spectator costs

Trystero is a full mesh: every user holds a WebRTC connection to every other user. A
spectator therefore adds one (idle) connection to every player and one busy connection to
the host. To keep the host's share small:

1. **Reduced rate.** Players get one frame per tick (70 Hz) as before, sent only to roster
   owners. Spectators get one message every `SPECTATOR_SEND_EVERY` = 3 ticks (≈ 23 Hz):
   the full state of the last tick plus `earlier`: the **one-shot events** of the ticks in
   between, each with its tick number, in order. Events are never merged across ticks —
   "pixel cleared, then drawn" and "drawn, then cleared" must stay distinguishable — the
   guest replays them one tick at a time. Slow-changing parts (`match`, `items`, `portals`,
   `roster`) have their own change tracking for this stream.
2. **Encoded once** for all spectators, and not at all when there are none.
3. **No inputs, no acks/pongs** from or for spectators.
4. **Cap**: `MAX_WATCHERS` = 6 users without a seat per room (lobby and game alike; 10
   users in total). `watchers` lists who is admitted; a client that is neither seated nor
   admitted a few seconds after reaching the room leaves with "The room is full".
5. Between messages the spectator's view **extrapolates** living players (same dead
   reckoning as guests use for remote players, up to 2 ticks), so motion stays smooth.

Switching streams happens only at a roster change, i.e. on a round start: the host first
flushes the pending spectator batch, then applies the new targets, so a client changing
role sees every tick exactly once. Guests also drop any frame whose tick they already have.

#### Measured

`tests/e2e/spectators.e2e.mjs`, real Chrome instances on one machine, direct connections,
free-for-all with a guest and a bot, first seconds of a round. Bytes are what
`RTCPeerConnection.getStats()` reports as sent on each of the host's connections, so they
include Trystero's framing and DTLS/SCTP overhead:

| | Host sends |
|---|---|
| to a player | ≈ 30 KB/s (payload 22–24 KB/s, 70 messages/s) |
| to a spectator | ≈ 11 KB/s (payload 9 KB/s, 23 messages/s): **36 % of a player** |
| 1 player, 0 spectators | ≈ 30 KB/s in total |
| 1 player, 3 spectators | ≈ 63 KB/s in total |
| worst case allowed: 3 players + 6 spectators | ≈ 155 KB/s (≈ 1.2 Mbit/s) |

In the headless simulation (`tests/spectators.test.ts`, 45 s of three bots with weapons on
*bricks*) the reduced stream is 43 % of the full one: 522 bytes every 3 ticks against
401 bytes every tick. The state of the last tick is the bulk of a message (players ≈ 125
bytes, projectiles, satellites); the events of a skipped tick cost ≈ 30–60 bytes.

The reduced stream is serialised once more per 3 ticks on top of the players' stream
(≈ +33 % of the encoding work, independent of the number of spectators), and only while
somebody watches. Not measured: CPU and battery on a real phone that hosts, and the cost of
the extra idle connections on the other phones.

**With the simulation in a Web Worker** (the default for a host, design/local-and-ai.md)
the page only relays: the worker produces both streams and posts them to the page, which
hands them to the room. Three things cross the other way or need care:

- the worker cannot ask the room whether anybody watches, so the page tells it whenever
  that changes — and always before asking it for a snapshot, so that the reduced stream
  carries every tick after the snapshot of a newcomer;
- the next round's players are posted to the worker (`nextPlayers`), and when a round
  starts with them the worker posts `roster` **after** the frames of the round before and
  **before** the first state of the new one, which is the order the page needs to change
  who gets which stream and who steers;
- the page forgets which inputs it already sent, since it only posts changes and the
  seats have new occupants.

Alternatives: full-rate stream for spectators (simplest; ~3× the bytes and encodes shared
with players); relaying through a guest (complex, guests are phones too); Trystero's
`scale` plug-in (`maxDirectPeers`, partial mesh) to cut the idle connections — worth a look
if rooms with many phones prove unstable; Trystero's `maxUsers` room option, which refuses
connections beyond a total at the transport level (the cap here is enforced by the
application: a refused client connects, learns it is not admitted and leaves by itself;
the host never sends it the stream); a lower cap.

## Screens

- **Spectator view**: the same game screen without input. Desktop: under the canvas,
  `SPECTATING` and a **PLAY NEXT ROUND** button (then "You play from the next round" /
  "Waiting for a free seat (#2)" with CANCEL). Phone: no steering zone, action button or
  steering-mode button; the banner and button sit in the left margin.
- **Players** get a small **WATCH** button (header on desktop, top row on phones) to step
  down; it turns into "Watching from next round · UNDO". On the **round summary** the
  same choice is offered in words, **👁 WATCH THE NEXT ROUND** (under the canvas on
  desktop, in the left margin on phones): that is when one decides to stop.
- **Round summary** (canvas): under the instructions, `👁 3 watching`, and
  `Ana joins next round` / `Ben is waiting for a seat` / `Cleo leaves` when applicable.
- **Lobby**: spectators are listed (already), with a count in the heading
  (`Spectators (2/6)`) and a "wants to play" mark for queued ones. Chat works for
  spectators in the lobby as for anyone. There is no chat during a game (not added here).

## Resilience

| Event | Behaviour |
|-------|-----------|
| Spectator reloads | Same `userId`: admitted again, new snapshot. A pending "play next round" request is remembered (`sessionStorage`) and re-published |
| Spectator-turned-player reloads | Has a seat like any player: seat kept, snapshot, resumes |
| Host reloads during a game | As before: the simulation is lost, everybody (spectators included) returns to the lobby |
| Host leaves | As before: everybody is sent to the menu |
| Queued spectator leaves | Dropped from the queue |
| A player quits (BACK TO MENU) | `bye` → seat freed at the next round; in team mode a bot fills in. Before, the round summary waited for them for ever |
| More than 6 spectators | The 7th is told the room is full |

## Validation

- `tests/room.test.ts`: queue order, cap, `planNextRound` (free seat before bot, bot
  replaced, nobody displaces a human, team backfill, step-down, goodbye), lobby seating of
  queued users, game config owners.
- `tests/spectators.test.ts`, simulation: roster applied only at a round start; scores
  (FFA reset, team inherit); ready-up ignores leavers; nobody stays → ready lock only.
- `tests/spectators.test.ts`, simulated network (`tests/netsim.ts`): a watcher on the
  reduced stream ends with exactly the host's trail grid (no event lost, duplicated or
  reordered), also when joining mid-round with a snapshot; nothing is produced when nobody
  watches; extrapolation removes the 2-of-3 stalls; a watcher promoted at a round start
  predicts exactly like a guest and, demoted again, still has the host's arena; bytes of
  both streams.
- `tests/e2e/spectators.e2e.mjs` (`npm run test:e2e`, or `npm run test:e2e:spectators`):
  five real browsers, one of them a phone-sized touch device — join mid-game as spectator,
  positions and arena match, join badge and QR off the canvas, counts, ask to play, the
  request surviving a reload, seated at the next round at 0, steers, step down, the phone
  taking the seat and getting touch controls, queueing, back to lobby, chat, a second game,
  the host stepping down and returning, a player quitting, host reload, and the host's
  bytes out with 0 and 3 spectators. `E2E_CAP=1` adds seven more browsers to check that the
  7th spectator is refused. `E2E_SHOTS=dir` saves the screenshots.
- Not covered by e2e: team mode (rules are unit-tested), and anything across real
  networks or on real phones. The e2e runs with the host's simulation in the worker; the
  in-thread path (`?worker=0`) is covered by the unit tests only.
- Screenshots in `design/research/spectators/` (taken before the QR code became
  on-demand: the ones showing it beside the canvas are out of date).
