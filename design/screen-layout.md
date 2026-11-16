# Screen Layout (menu, local set-up, lobby)

How the DOM screens before a game lay themselves out on a desktop and on a phone held
either way. The game screen is not covered here (see [touch-controls.md](./touch-controls.md)
and [spectators.md](./spectators.md)).

Related: [networking.md](./networking.md) (what the lobby shows and does),
[local-and-ai.md](./local-and-ai.md) (the local set-up).

Status: checked in headless Chrome with phone-sized touch viewports only. **Not yet seen on
a real iPhone** (see `TODO.md`).

## Goals

- Nothing is wider than the screen: no sideways scrolling, no pinch. Vertical scrolling is
  fine.
- Controls are at least 44 px high on phones (buttons, text fields, selects, level chips).
- Text fields and selects use a 16 px font on phones: below that iOS Safari zooms in when
  one gets the focus, and does not zoom back.
- The main actions — take a seat, start, share the room — are on the first screenful, in
  both orientations.
- Typing (chat, nickname) keeps the on-screen keyboard open and the text field in view.
- Same look as on a desktop (monospace, dark, neon), and the desktop layout is unchanged.

## Where the styles live

`src/screens/screens.css`, imported by `main.ts`. The screens build their DOM with template
strings and use its classes (`ui-*` shared, `menu-*`, `setup-*`, `lobby-*`, `level-*`);
inline styles are left only for values computed at run time (a seat's colour). Element ids
are what the code and the e2e tests hold on to; classes are only for looks.

Every screen is a `.ui-screen`. `index.html` centres `#app`, which would shrink to its
content; `#app:has(> .ui-screen)` stretches it instead, so a screen is exactly as wide as
the window and its children can be sized in percentages. Screens are at least `100dvh`
high (with `100vh` as fallback), pad themselves by `env(safe-area-inset-*)` at the sides
and the bottom, and set `text-size-adjust: 100%` (Safari otherwise inflates text in
landscape). The viewport tag is not `viewport-fit=cover`, so today Safari already keeps the
page out of the notch; the insets matter if that changes.

## Breakpoints

| Name | Media query | Used for |
|------|-------------|----------|
| Desktop | (none) | As before: lobby in three columns of 250 / 350 / 300 px |
| Tablet | `max-width: 950px` | Lobby in two columns, chat below (as before) |
| Touch sizes | `max-width: 600px`, or `max-height: 500px`, or `pointer: coarse` | 44 px controls, 16 px fields, roomier seats, sticky start button |
| Phone upright | `max-width: 600px` | One column |
| Phone on its side | `max-height: 500px` and `min-width: 601px` | Two columns, one-line header |

A phone on its side narrower than 601 px gets the upright layout.

## Network lobby

The DOM is the same in every layout: a header (title, connection status, notice) and a
grid with three children — the side panel `#settingsPanel`, `#playersPanel`, `#chatPanel`.
The side panel has four sections: *settings* (game mode, levels, nickname), *room* (code,
copy buttons, QR code), *action* (START GAME for the host, a "waiting" banner for a guest)
and *leave*.

```
Desktop                      Phone upright        Phone on its side
┌────────┬─────────┬──────┐  ┌───────────────┐    ┌ LOBBY · status ──────────┐
│settings│ players │ chat │  │ room code + QR│    │ players    │ room + QR   │
│room    │         │      │  │ players       │    │            │ START       │
│START   │         │      │  │ START (sticky)│    │────────────│ settings    │
│leave   │         │      │  │ settings      │    │ chat       │ leave       │
└────────┴─────────┴──────┘  │ chat          │    └────────────┴─────────────┘
                             │ leave         │
                             └───────────────┘
```

- **Upright**: the side panel dissolves (`display: contents`) and its sections become
  panels of their own, ordered with `order` around the players and chat panels. Sharing
  comes first because a room starts with one person in it; then the seats; then START.
  Settings, chat and LEAVE ROOM follow, a scroll away.
- **On its side**: seats at the left with the chat under them; at the right one panel
  with the room, START, the settings and LEAVE ROOM. The header is one line (the notice,
  when there is one, goes on a second line).
- **Room section on phones**: the code and the two copy buttons at the left, the QR code
  (100 px) at the right. **Tapping the QR code toggles a big version** (up to 320 px, the
  section then stacks) for scanning from across a table; this works on a desktop too. It
  is not remembered.
- **START GAME is sticky on phones** when upright (`position: sticky; bottom: 0`): the
  host sees it at the bottom of the screen until the page is scrolled past its place
  under the seats. A guest's "waiting for host" banner is not sticky. On its side the
  button is already on the first screenful.
- **Seats**: colour dot, name (one line, ellipsis), controls. On phones a row is at least
  56 px high and its buttons (JOIN, + AI, LEAVE, ✕, the bot level select) 44 px.
- **Chat**: the message list is between 6 and 11–12 rem high on phones, so that the list
  and the text field fit above an on-screen keyboard when upright; long words wrap.

### What is rebuilt and what is not

The lobby used to rebuild all three panels with `innerHTML` on every change of the room.
On a phone that takes the focus away from a text field being typed in (the keyboard
closes), and a button rebuilt while a finger is on it loses the tap. Now:

- The chat panel and the side panel are built once. A change of the room only refills the
  message list, the options (`#lobbyOptions`: heading, game mode, levels) and the action
  (`#lobbyAction`). The chat field, the nickname field, the room code and the QR code stay
  the same elements.
- The players panel is still rebuilt when the room changes, but the latency figures that
  arrive every 2 s are written into the existing `.link-badge` elements (one per remote
  user, empty and hidden until something is known).
- SEND puts the focus back in the chat field, so the keyboard stays open. Enter in the
  nickname field ("done" on a phone keyboard) closes the keyboard.
- When the visual viewport changes size while the chat field has the focus (the keyboard
  opening), the page is scrolled so that the field is inside the visible part.

## Main menu and joining by code

- The title scales with the width (`clamp(2rem, 11vw, 4rem)`); it used to be wider than a
  phone.
- LOCAL GAME / NETWORK GAME are stacked when upright and side by side on a phone on its
  side, as are CREATE ROOM / JOIN ROOM, so that everything fits in the ~340 px of height
  without scrolling.
- The room code field is as wide as its panel (at most 20 rem), 16 px, without
  capitalisation, correction or suggestions, and its keyboard says "go".

## Local set-up

- One column; on a phone on its side two (players at the left; mode, levels and buttons
  at the right).
- START GAME is sticky at the bottom on phones in both orientations (the level chips are
  taller there, and the screen no longer fits in one screenful); BACK is under it.

## Validation

- `tests/e2e/touch.e2e.mjs`: main menu, join by code and local set-up at 360 × 640 and
  844 × 390 — not wider than the screen, every visible control ≥ 40 px high, fields
  ≥ 16 px; the local START button in view without scrolling at 844 × 390.
- `tests/e2e/spectators.e2e.mjs`: the lobby of a room with players, a bot and spectators
  on the phone-sized browser at 390 × 844, 360 × 640 (one column) and 844 × 390 (two
  columns), same checks.
- Looked at in screenshots (host and guest, with chat, a spectator, team mode, the big QR
  code) at 390 × 844, 844 × 390, 360 × 640, 640 × 360 and 750 × 340, and at desktop sizes
  for regressions.
- Not validated: anything that needs the real thing — the iOS keyboard (focus kept, field
  in view), Safari's tool bars and safe areas, the zoom on focus, how well the 100 px QR
  code scans.
