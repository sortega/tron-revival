# Networking Design

Multiplayer for Teratron Web: peer-to-peer over WebRTC with one player's browser acting as
the authoritative host. No game server; static hosting only.

Related: [architecture.md](./architecture.md), [local-and-ai.md](./local-and-ai.md),
[spectators.md](./spectators.md) (users without a seat, mid-game seating, the reduced stream).

## Contents

1. [Overview](#overview)
2. [Connectivity: what it takes to work across networks](#connectivity-what-it-takes-to-work-across-networks)
3. [Rooms](#rooms)
4. [Lobby](#lobby)
5. [Game phase](#game-phase)
6. [Netcode: Prediction and Reconciliation](#netcode-prediction-and-reconciliation)
7. [Resilience: reloads, late joins, host loss](#resilience-reloads-late-joins-host-loss)
8. [Diagnostics and testing](#diagnostics-and-testing)
9. [Security](#security)

## Overview

- **Host authority.** The player who creates the room runs the simulation (`HostSession`).
  Guests send inputs and receive state (`GuestSession`). Bots run on the host.
- **Transport.** [Trystero](https://github.com/dmotz/trystero) 0.27: WebRTC data channels
  (reliable, ordered) with serverless signaling over public Nostr relays.
- **Identity.** Every browser tab has a persistent, cryptographically verified `userId`
  (ECDSA key kept in `sessionStorage`). Slots, host role and inputs are tied to `userId`,
  never to the transient WebRTC peer id. This is what makes reload/rejoin possible.
- **State.** Lobby data lives in Trystero's synchronised state primitives, so late joiners
  get it from whoever is in the room without bespoke handshakes.

```
            public Nostr relays (signaling only: encrypted offers/answers)
                          ▲            ▲
                          │            │
   STUN / TURN ──►  ┌─────┴────┐  ┌────┴─────┐
   (NAT traversal)  │   Host   │◄─┤  Guest   │   WebRTC data channel
                    │ sim+bots │─►│ predict  │   inputs ► / ◄ state
                    └──────────┘  └──────────┘
```

## Connectivity: what it takes to work across networks

A WebRTC connection needs three things, and the game must be robust in all three:

| Step | What | Failure looks like | What we do |
|------|------|--------------------|------------|
| Signaling | Peers find each other and exchange encrypted offers | "Connecting…" forever for everyone | Trystero's default strategy uses ~20 public Nostr relays with redundancy; a `relay-failed` error is shown in the lobby |
| STUN | Each peer learns its public address; works for most home routers | — | Built in (Google + Cloudflare STUN) |
| TURN | Relays packets when direct hole punching is impossible | Works on the same Wi-Fi, fails between e.g. a phone on 4G/5G (carrier-grade NAT) and a laptop | **Must be configured** (below). Without it roughly 10–15 % of pairs cannot connect |

The previous implementation relied on the public `openrelay.metered.ca` credentials, which no
longer work, so any pair needing TURN silently failed. That is the root cause of "does not
work across networks".

### TURN configuration

TURN costs bandwidth, so there is no dependable anonymous service; a free tier with an
account is needed. Options evaluated:

| Option | Cost | Setup | Notes |
|--------|------|-------|-------|
| **Cloudflare Realtime TURN** | 1 000 GB/month free | Cloudflare account + a ~20-line Worker that mints short-lived credentials | Recommended. Global anycast, credentials not exposed |
| **Metered.ca** | 500 MB–20 GB/month free | Account; REST endpoint returns ICE servers given an API key | Easiest; the API key is visible in the client (quota can be abused) |
| Self-hosted coturn | VPS (~$5/month) | Run coturn, open UDP ports | Full control |
| WebSocket relay fallback (e.g. PartyKit / Durable Objects) | Free tiers | Custom server code | Not P2P; only worth it if TURN proves insufficient |

The client supports any of them through build-time environment variables (`.env.local`,
see `.env.example`):

```
# Either static credentials...
VITE_TURN_URLS=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp
VITE_TURN_USERNAME=user
VITE_TURN_CREDENTIAL=secret
# ...or an endpoint returning a JSON array of RTCIceServer objects
# (Cloudflare Worker, Metered credentials URL)
VITE_ICE_SERVERS_URL=https://example.workers.dev/ice
```

`src/network/ice.ts` resolves these (fetching the URL when given, with a timeout and a
fallback to STUN-only) before joining a room. If no TURN is configured the lobby says so,
and a failed peer connection reports whether TURN was available
(`peer-connect-failed`, `turnConfigured`).

`?relay=1` forces `iceTransportPolicy: 'relay'`, so the TURN path can be verified with two
tabs on one machine — if the game connects with `?relay=1` on both sides, it will connect
across any pair of networks that can reach the TURN server.

### Why keep WebRTC P2P instead of a relay server?

Latency (direct path), zero running cost and no server code to operate. With TURN configured
the remaining failure modes are networks that block UDP *and* TCP/TLS to the TURN server,
which also block most online games.

## Rooms

- Room codes are three short words (`red-bear-moon`); the shareable link is
  `…/?room=red-bear-moon`. The lobby shows the code, copy buttons and a **QR code** of the
  link for phones (a tap on it makes it bigger).
- The room code stays in the URL while the player is in the room, so **a reload rejoins the
  same room** with the same identity. It is removed when the player leaves deliberately.
- `appId` includes a protocol version (`teratron/v3`) so incompatible builds never meet.
- Rooms are open to anyone with the code. Extra players are spectators
  ([spectators.md](./spectators.md)).

## Lobby

How the lobby is laid out on a desktop and on a phone held either way, and which parts of
it are rebuilt when the room changes: [screen-layout.md](./screen-layout.md).

### Shared state

Two Trystero state primitives hold everything:

```ts
// room.makeUserState('profile') — one per user, writable only by that user
interface Profile {
  name: string;
  want: number | null;   // desired slot (0-3), -1 = any free slot, null = spectate
}

// room.makeState('room') — one per room, written only by the host
interface SharedRoom {
  hostId: string;                       // userId of the host
  gameMode: 'ffa' | 'team';
  levelMode: string;                    // 'cycle', a level id, or ids separated by commas
  slots: (SlotEntry | null)[];          // 4 entries
  phase: 'lobby' | 'game';
  gameId: number;                       // incremented on every game start
  queue: string[];                      // spectators.md: waiting for a seat in the running game
  watchers: string[];                   // spectators.md: admitted users without a seat
}
interface SlotEntry { userId?: string; ai?: BotDifficulty; name: string; }
```

- A `validate` hook rejects writes to `room` from anyone but `hostId` (the first writer
  becomes host), so a guest cannot seat itself or start the game.
- Guests *request* seats by changing their own profile; the host **reconciles** profiles into
  slots (same code path for the host's own seat). There are no request/response lobby
  messages and no join handshake: a newcomer receives `room` and all profiles automatically.
- Seats belong to a `userId`. While a game is running a seat is kept even if its owner
  disconnects, so they can come back; in the lobby, seats of absent users are freed.
  During a game seats change only when a round starts ([spectators.md](./spectators.md)).
- Chat is an ephemeral broadcast action (not stored; late joiners don't see history).
- Bots: the host fills a slot with `{ ai: difficulty, name }`.

### Starting and ending games

- Host sets `phase: 'game'` (and bumps `gameId`). Every client that observes the change
  builds the same `GameConfig` from `slots` and opens the game screen.
- **Back to lobby**: the host sets `phase: 'lobby'`; everyone returns to the lobby of the
  same room, where settings and seats can be changed before starting again.

## Game phase

Three actions on the same room:

| Action | Direction | Payload |
|--------|-----------|---------|
| `i` | guest → host (targeted) | `TronInputMessage` |
| `s` | host → players of the round | compact binary game state, one per tick |
| `s` | host → everybody else in the room | the same, one message per 3 ticks carrying the events of the ticks in between ([spectators.md](./spectators.md)) |
| `sync` (request) | guest → host | reply: full snapshot, for joining a game in progress |

Inputs are mapped to slots by the sender's verified `userId` — it must own a slot in the
round being played (the roster, which can differ from `slots` only for an instant at a
round start); state is accepted only from `hostId`.

## Netcode: Prediction and Reconciliation

Guests must not wait a network round trip to see their own steering: at 280°/s a 100 ms
round trip is 28° of overshoot, which makes the game feel uncontrollable. The netcode
therefore uses client-side prediction with server (host) reconciliation.

### Wire messages

```typescript
// Guest → host, one per guest simulation tick (70 Hz)
interface TronInputMessage {
  seq: number;     // Monotonic sequence number
  steer: number;   // -1..1
  action: boolean;
  t: number;       // Guest clock in ms, echoed back for RTT measurement
}

// Host → guests: the game state plus
interface TronGameStateData {
  // ...
  acks?: Record<SlotIndex, number>;   // Last input seq consumed for each remote slot
  pongs?: Record<SlotIndex, number>;  // Echo of `t`, advanced by the time it waited on the host
}
```

Player states on the wire also carry what a guest needs to reproduce movement exactly:
`speedFactor`, `moveFrameCounter`, `teleportCooldown` and the `steer` applied on that tick.

### Host: input queue

- Each remote slot has a FIFO of received inputs. Every host tick consumes **one** input per
  slot, so that each guest tick maps to exactly one host tick.
- Queue empty (jitter, guest stalled): the last input is held for that tick; nothing is acked.
- Queue longer than `MAX_INPUT_QUEUE` (4): the oldest entries are skipped (and acked) to bound
  the added latency when a guest runs slightly fast or delivers a burst.
- Inputs are sanitised (`steer` clamped to [-1, 1], `action` coerced to boolean).

### Guest: prediction

The guest keeps `pending`: every input it has sent that the host has not acked yet.

Every guest tick:
1. Sample local input, assign `seq`, send it, append it to `pending`.
2. Advance the *predicted* local player one tick with that input, using the same movement
   code as the host (`TronPlayer` movement, speed factor, Control Reversal, arena wrap,
   portals).

Every received state:
1. Drop `pending` entries with `seq <= acks[mySlot]`.
2. Reset the predicted player to the authoritative player state from the host.
3. Replay all remaining `pending` inputs on top of it.

The view shows the predicted local player instead of the (older) authoritative one. Because
the host consumes exactly the inputs the guest predicted with, the prediction is exact
whenever nothing unpredictable happened; when it was not (held input, Swap item, speed change
caused by another player's Slow weapon, death) step 2 snaps the player to the truth.

Guests never predict collisions or death: the host decides. A predicted player can therefore
appear to drive a few pixels into a wall before the host's verdict arrives.

### Predicted trail

The authoritative trail (drawn permanently on the trail canvas) ends where the host last saw
the player, a few pixels behind the predicted head. The pixels travelled while replaying
`pending` are exposed as a *provisional trail* and drawn every frame on top of the trail
canvas without being stored, so the trail visually reaches the head.

### Dead reckoning for remote players

Remote players arrive `lag` old. The local player is shown ahead of the host (by the inputs
in flight), so to show a mutually consistent picture the guest extrapolates every other
living player forward by the same number of ticks (`pending.length`, capped at
`MAX_EXTRAPOLATION_TICKS` = 12 ≈ 170 ms), assuming it keeps its last known `steer`. The
extrapolated segment is drawn as a provisional trail too. When the next state arrives the
extrapolation restarts from the new authoritative position, so errors never accumulate.

Everything else (projectiles, items, portals, explosions, scores) is shown as received:
projectile impacts are decided in host time, and an extrapolated bullet would appear to fly
through obstacles before vanishing.

### One-shot events

Trail growth, cleared pixels, sounds, round start, etc. are attached to the state of the
tick they happened on. The guest applies the events of **every** state as it arrives (several
may arrive between two rendered frames) and only uses the latest state for drawing.

### Latency measurement

`pongs[slot] = t + (time the input waited on the host)`, so `RTT = guestNow - pong` is
independent of clock offsets and of host frame timing. The debug overlay (key `F`) shows the
median one-way lag, bitrate, and the number of predicted ticks.

### Wire format

A frame is MessagePack (`network/serialization.ts`), laid out so that what every frame
has costs no field names and what there is most of costs bytes rather than numbers:

- **A positional array**, not a map: tick, phase (an index), countdown, round winner,
  door tick, players, trails, projectiles, explosions, satellites, pongs, acks. What a
  frame has only now and then follows as a map by name (`match`, `items`, `portals`,
  sounds, cleared areas and lines, deaths, roster, `earlier`, ...), absent when empty.
- **Players** as tuples, positions rounded to 1/1000 px, headings exact (guests replay
  movement from them), no colour or nickname (static, from the roster); weapon and
  effects as tuples too.
- **New trail pixels** as bytes: per player `[slot, count, 3 bytes a pixel]` (10 bits
  each way: the arena is 750 × 600).
- **Projectiles** as bytes: guests only draw them ("shown as received", above), so
  what travels is the pixel and the type (3 bytes), plus the heading in 1/256 of a turn
  for bullets and bombs, which are drawn as rotated sprites (4 bytes). Id, owner, speed
  and lifespan stay on the host; a guest's `Projectile` has made-up values for them.
- **Explosions** as bytes: pixel, animation frame, scale in tenths (5 bytes).
  **Satellites** as `[x, y, owner]` in pixels.
- Tracer paths as line segments (`clearedLines`) rather than one entry per pixel, and only
  the paths (and `clearedAreas`, as flat `[x, y, w, h]`) that actually erased something: a
  tracer flying through empty space is not reported.
- `match`, `items` and `portals` only when they changed (plus once a second); the guest keeps
  the last value. A portal's animation frame changes every third tick: that is no reason
  to send the portals again, only their frames (`portalFrames`).
- Loop-sound start/stop events only on transitions.

Builds with different formats never meet: the format is part of the Trystero app id
(`teratron/v4`).

#### Measured

`npm run bench:net`: a real `HostSession`, 60 s of rounds being played per scene, the
payload of the stream to one player in KB/s (WebRTC adds its own framing to each of the
70 messages a second: about 6–8 KB/s on top, see [spectators.md](./spectators.md)).
"Before" is the format with field names, one number per coordinate and ten numbers per
projectile.

| Scene | Before | Now | Bytes a message |
|-------|--------|-----|-----------------|
| 2 humans, nothing happening | 18.3 | 5.6 | 81 |
| 4 humans, nothing happening | 23.8 | 9.2 | 135 |
| A human and 3 hard bots | 27.7 | 11.2 | 164 |
| One of four fires a rifle without pause | 79.9 | 21.4 | 313 |
| One of four fires a shotgun | 137.4 | 32.7 | 478 |
| One of four fires an Uzi | 90.2 | 23.9 | 350 |
| All four fire Uzis | 175.5 | 29.7 | 435 |

Where it went (4 humans, quiet): field names 10 KB/s, trail pixels 6.3 → 1.1, portals
1.1 → 0.3. With weapons: projectiles took 22 bytes each on every tick they lived and
explosions 38 (rifle scene: 30 and 23 KB/s; now 4.2 and 5.0). What is left is mostly the
players (21–26 bytes each, two thirds of a quiet frame). Encoding is not slower: 13 µs a
frame on the host where it was 18 (40 with four Uzis), 4 µs to decode.

#### Considered and not done

- **Tracers from a random seed.** The Uzi's 20 tracers a tick are random headings and
  speeds; the host could send one seed and let guests draw the same numbers. After the
  change above a firing Uzi costs about 4 KB/s in projectiles (17 with four), and that is
  all a seed could save, for the few seconds an Uzi lasts. The price: guests would have to
  compute where tracers are, which today only the host knows, and it is not only the
  spread: under the swept tracers on trial ([projectiles.md](./projectiles.md)) a tracer
  stops at the first thing on its path, which a guest could only know by simulating
  collisions. A guest that drew them where they would have landed would show shots going
  through walls. If the experiment is dropped (tracers act where they land) the idea
  becomes exact and cheap, and is worth another look.
- **Spawn and removal events instead of positions every tick** (rifle tracers, pellets,
  bombs fly straight; explosions are a fixed animation). Would take most of what
  projectiles and explosions still cost (about 9 of 21 KB/s in the rifle scene), at the
  price of state on the guest that has to survive portals, satellites, joining late and
  the reduced stream. The stateless form was preferred while the numbers are this low.
- **General-purpose compression.** WebRTC data channels do not compress. Deflate on each
  message by itself gains little, and less than before (frames are small and have few
  repeats left): 2–12 % now. Deflate with the previous message as its dictionary gains
  30–65 % (quiet 4 humans: 9.2 → 4.6 KB/s), because consecutive frames are alike, but it
  needs every receiver to have decoded the previous message (a player joining late, the
  reduced stream and its own sequence), a synchronous deflate in JavaScript (the browser's
  `CompressionStream` is asynchronous and takes no dictionary: a library of some 10 KB)
  and its processor time 70 times a second on a phone that hosts. Sending the players as
  differences from the previous tick would get much of the same for the part that is
  left, without a library. Neither is done: at 6–11 KB/s for a normal game the stream is
  now smaller than the framing around it.
- **Fewer, larger messages** (a state every second tick with the events of the one in
  between, as the reduced stream does): halves the 6–8 KB/s of framing and nearly halves
  the players' part, for 14 ms more latency on what others do and a change to how inputs
  are acknowledged. The next thing to try if bandwidth matters again.

### Testing with artificial latency

Opening the game with `?lag=120` (and optionally `&jitter=40`) delays every game message
that client sends and receives by that many milliseconds, so prediction can be felt and
tested with two tabs on one machine. The debug overlay (`F`) shows lag and predicted ticks.

### Validation

`tests/netcode.test.ts` wires a `HostSession` and a `GuestSession` through a simulated link
(`tests/netsim.ts`) with configurable latency and jitter on a virtual clock and asserts that
- the predicted position for input `seq` equals the host's position after consuming `seq`
  (exactly, for jitter-free links; within a small bound otherwise),
- the guest's view responds to input on the same tick regardless of latency,
- no event is lost or duplicated (guest trail canvas equals host trail grid),
- dead reckoning reduces the position error of remote players versus no extrapolation.

## Resilience: reloads, late joins, host loss

| Event | Behaviour |
|-------|-----------|
| Guest reloads in the lobby | Rejoins with the same `userId`; keeps its seat |
| Guest reloads / reconnects during a game | Seat was kept. The client sees `phase: 'game'`, requests a **snapshot** from the host and resumes. Meanwhile its player keeps going straight (last input held) |
| Someone new joins during a game | Becomes a spectator with a snapshot; can ask to play from the next round ([spectators.md](./spectators.md)) or take a seat when the room is back in the lobby |
| Host reloads in the lobby | Comes back as host (`hostId` matches); guests see "host reconnecting…" meanwhile |
| Host reloads during a game | The simulation is lost: the host returns and puts the room back in the lobby (scores reset). *Host migration is a possible later improvement* |
| Host gone | Guests wait 25 s for it to return, then leave to the menu with a message |
| Host silent during a game | The host sends a state every tick, so a guest that has heard nothing for 1.5 s (`HOST_SILENCE_MS`) shows "Connection to the host lost — waiting…" with a seconds counter over the frozen game. It disappears with the next state. This covers a host that left, crashed or lost its connection (`NetworkStats.silentMs`) |
| Room empty, host reloads | No peer holds the room state; the host recreates it (remembered in `sessionStorage`) |

### Snapshot

```ts
interface Snapshot {
  tick: number;          // Host tick the snapshot was taken on
  palette: string[];     // Collision grid colours
  runs: number[];        // Run-length encoded grid: [paletteIndex, count, ...]
  state: Uint8Array;     // Full serialized frame for that tick
  smoothLines?: { palette: number[]; data: Uint8Array };  // Translucent part of the trails
}
```

`smoothLines` is display only (see [display-layer.md](./display-layer.md)): the host keeps
it from the frames it sends, and a guest that gets it continues it from the frames that
follow, ending with the very same lines.

Every state frame carries its `tick`. A joining guest buffers frames until the snapshot
arrives, paints the grid, then applies only frames with `tick > snapshot.tick`.

## Diagnostics and testing

- Lobby shows, per connected player, the round-trip time and whether the path is **direct**
  or **relayed** (TURN), from `RTCPeerConnection.getStats()`.
- In game, `F` toggles an overlay with lag, predicted ticks and bitrate.
- `?lag=120&jitter=40`: artificial latency. `?relay=1`: force TURN.
- Headless tests: `tests/netcode.test.ts` (simulated links), `tests/room.test.ts` (lobby
  reconciliation logic), and `npm run test:e2e` (two real headless browsers through the
  public signaling relays, including reload-rejoin and back-to-lobby).

## Security

Acceptable for games among friends:

- The host can cheat (it runs the simulation) and sees guests' IP addresses (WebRTC).
- Room codes are guessable in principle; anyone with the code can join as a spectator.
- Signaling payloads are encrypted by Trystero; game traffic is DTLS-encrypted end to end,
  also through TURN.
- All peer-supplied strings (nicknames, chat) are HTML-escaped; inputs are clamped.
