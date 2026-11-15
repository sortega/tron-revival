// End-to-end check of spectators (design/spectators.md) with real headless Chrome
// instances talking through the public signaling relays: joining a game in progress,
// the join code on the game screen, the reduced stream, asking to play and being seated
// at the next round, stepping down, reloads, and what spectators cost the host.
//
//   npm run test:e2e:spectators
//   E2E_SHOTS=design/research/spectators npm run test:e2e:spectators   (save screenshots)
//   E2E_CAP=1 npm run test:e2e:spectators                              (also fill the room: 12 browsers)
//
// Requires Google Chrome and internet access.

import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const steps = [];
let failed = false;
function check(name, ok, detail = '') {
  steps.push({ name, ok });
  console.log(`${ok ? '  ok ' : 'FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
}

let server = null;
let baseUrl = process.env.E2E_URL;
if (!baseUrl) {
  server = await createServer({ server: { port: 0, strictPort: false, https: false, host: '127.0.0.1' }, logLevel: 'error' });
  await server.listen();
  baseUrl = `http://127.0.0.1:${server.httpServer.address().port}${server.config.base}`;
}
const shotsDir = process.env.E2E_SHOTS;
if (shotsDir) mkdirSync(shotsDir, { recursive: true });
const shot = async (page, name, fullPage = false) => {
  if (shotsDir) await page.screenshot({ path: `${shotsDir}/${name}.png`, fullPage });
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
const gone = ['Specky'];   // Users who leave the room during the test
const DESKTOP = { viewport: { width: 1200, height: 800 } };
const PHONE = { viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 };

async function newUser(name, options = DESKTOP) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, ...options });
  await context.addInitScript((nickname) => {
    localStorage.setItem('teratron-nickname', nickname);
    // Keep track of the peer connections, to measure what the host really sends
    const Native = window.RTCPeerConnection;
    window.__pcs = [];
    window.RTCPeerConnection = class extends Native {
      constructor(...args) {
        super(...args);
        window.__pcs.push(this);
      }
    };
  }, name);
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  page.on('console', m => {
    if (m.type() === 'error') errors.push(`${name}: ${m.text()}`);
    if (process.env.E2E_VERBOSE) console.log(`    [${name}] ${m.text().slice(0, 200)}`);
  });
  return page;
}

const view = (page) => page.evaluate(() => {
  const v = window.__teratron?.view();
  return v ? {
    phase: v.round.phase,
    round: v.match.currentRound,
    scores: v.match.scores,
    players: v.round.players.map(p => ({ slot: p.slotIndex, name: p.nickname, alive: p.alive, x: Math.round(p.x / 1000), y: Math.round(p.y / 1000), direction: p.direction })),
  } : null;
});
const inGame = (page, timeout = 30000) => page.waitForFunction(() => !!window.__teratron?.view(), null, { timeout });
const inLobby = (page, timeout = 30000) => page.waitForSelector('#playersPanel', { timeout });
const mySlot = (page) => page.evaluate(() => window.__teratron.config.players.find(p => p.control.type === 'local')?.slotIndex ?? null);
const audience = (page) => page.evaluate(() => window.__teratron.audience());
const label = (page) => page.evaluate(() => document.querySelector('#spectatorLabel')?.textContent ?? '');
const visible = (page, selector) => page.evaluate((s) => {
  const el = document.querySelector(s);
  return !!el && window.getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
}, selector);
const litPixels = (page) => page.evaluate(() => {
  const canvas = document.querySelector('#gameCanvas canvas');
  const data = canvas.getContext('2d').getImageData(0, 0, 750, 600).data;
  let n = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] > 60) n++;
  return n;
});
const waitFor = async (what, test, timeout = 20000) => {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await what();
    if (test(value)) return value;
    if (Date.now() > end) throw new Error(`timeout waiting; last value ${JSON.stringify(value)}`);
    await new Promise(r => setTimeout(r, 150));
  }
};

// Bytes the page has sent on each of its live peer connections
const sentBytes = (page) => page.evaluate(async () => {
  const result = [];
  for (const pc of window.__pcs) {
    if (pc.connectionState !== 'connected') continue;
    const stats = await pc.getStats();
    let bytes = 0;
    stats.forEach(r => { if (r.type === 'transport') bytes += r.bytesSent ?? 0; });
    result.push(bytes);
  }
  return result;
});
// What the host sends per second during the first seconds of a round: per connection, sorted
async function measureHost(host, players, seconds = 3) {
  for (let attempt = 0; attempt < 6; attempt++) {
    // Start from a fresh round, so that nobody crashes while measuring
    await endRound(host, players);
    await nextRound(host, players);
    await host.waitForFunction(() => window.__teratron.view()?.round.phase === 'playing', null, { timeout: 30000 });
    const before = await sentBytes(host);
    await host.waitForTimeout(seconds * 1000);
    const after = await sentBytes(host);
    const stats = await host.evaluate(() => window.__teratron.stats());
    if ((await view(host)).phase !== 'playing' || before.length !== after.length) continue;   // Round ended meanwhile
    const rates = after.map((b, i) => Math.round((b - before[i]) / seconds)).sort((a, b) => b - a);
    return { rates, total: rates.reduce((a, b) => a + b, 0), stats };
  }
  return null;
}

// Human players drive in circles until they crash; returns when the round is over.
// (The next round never starts by itself: the humans have to press "ready".)
async function endRound(host, players) {
  await host.waitForFunction(() => window.__teratron.view()?.round.phase !== 'countdown', null, { timeout: 60000 });
  if ((await view(host)).phase === 'waiting_ready') return;
  for (const p of players) await p.keyboard.down('ArrowLeft');
  await host.waitForFunction(() => window.__teratron.view()?.round.phase === 'waiting_ready', null, { timeout: 90000 });
  for (const p of players) await p.keyboard.up('ArrowLeft');
}
// The given players press "ready" until the next round starts
async function nextRound(host, players) {
  const round = (await view(host)).round;
  await host.waitForTimeout(1200);   // Ready lock
  for (let i = 0; i < 20; i++) {
    for (const p of players) await p.keyboard.press('Space', { delay: 60 });
    await host.waitForTimeout(250);
    if ((await view(host)).round > round) return;
    // A press may have toggled "ready" off again: look and press only where needed
    const ready = await host.evaluate(() => window.__teratron.view().match.playersReady);
    players = await Promise.all(players.map(async p => (ready.includes(await mySlot(p)) ? null : p))).then(l => l.filter(Boolean));
  }
  throw new Error('next round did not start');
}
// Make sure a round is being played (the idle players may have crashed meanwhile)
async function ensurePlaying(host, players) {
  if ((await view(host)).phase === 'waiting_ready') await nextRound(host, players);
  await host.waitForFunction(() => window.__teratron.view()?.round.phase === 'playing', null, { timeout: 30000 });
}

try {
  // --- A room with a game in progress: host, a guest and a bot ---
  const host = await newUser('Hosty');
  await host.goto(baseUrl);
  await host.click('#networkGameBtn');
  await host.click('#createRoomBtn');
  await host.waitForSelector('#startGameBtn', { timeout: 30000 });
  const code = (await host.textContent('#roomCode')).trim();
  const roomUrl = `${baseUrl}?room=${code}`;
  const guest = await newUser('Guesty');
  await guest.goto(roomUrl);
  await guest.waitForSelector('#leaveSlot1', { timeout: 60000 });
  await host.click('#addBot2');
  await host.waitForFunction(() => !document.querySelector('#startGameBtn')?.disabled, null, { timeout: 15000 });
  await host.click('#startGameBtn');
  await Promise.all([inGame(host), inGame(guest)]);
  check('game started with host, guest and a bot', (await view(host)).players.length === 3, code);

  // --- Join code on the game screen ---
  const badge = (await host.textContent('#joinCode')).trim();
  const site = (await host.textContent('#joinSite')).trim();
  check('game screen shows how to join', badge === code && baseUrl.includes(site), `${badge} at ${site}`);
  check('join badge counts no spectators yet', (await host.textContent('#watchCount')).includes('0'));
  check('QR code beside the canvas (desktop, wide margin)', await host.locator('#joinCorner svg').count() === 1);
  const overlap = await host.evaluate(() => {
    const canvas = document.querySelector('#gameCanvas canvas').getBoundingClientRect();
    return ['#joinBadge', '#joinCorner'].map(s => document.querySelector(s).getBoundingClientRect())
      .some(r => r.width > 0 && r.left < canvas.right && r.right > canvas.left && r.top < canvas.bottom && r.bottom > canvas.top);
  });
  check('join code does not cover the canvas', !overlap);
  check('guest has a WATCH button, no spectator bar', await visible(guest, '#watchBtn') && !(await visible(guest, '#seatBar')));

  // --- Host cost without spectators ---
  const baseline = await measureHost(host, [host, guest]);
  check('measured host output with 0 spectators', baseline !== null && baseline.rates.length === 1, JSON.stringify(baseline));

  // --- A spectator arrives mid-game ---
  const spec = await newUser('Specky');
  await spec.goto(roomUrl);
  await inGame(spec, 60000);
  await spec.waitForFunction(() => window.__teratron.view()?.round.players.length === 3, null, { timeout: 15000 });
  check('newcomer during a game becomes a spectator', (await mySlot(spec)) === null && (await label(spec)).includes('SPECTATING'), await label(spec));
  await ensurePlaying(host, [host, guest]);
  await spec.waitForTimeout(700);
  const [h, s] = [await view(host), await view(spec)];
  const far = h.players.some((p, i) => Math.hypot(p.x - s.players[i].x, p.y - s.players[i].y) > 40);
  check('spectator sees the players where the host has them', !far && s.round === h.round);
  const lit = await litPixels(spec);
  check('spectator sees the arena so far', lit > 150, `${lit} lit pixels`);
  await host.waitForFunction(() => document.querySelector('#watchCount')?.textContent.includes('1'), null, { timeout: 15000 });
  check('host screen counts the spectator', true);
  check('spectator has no WATCH button', !(await visible(spec, '#watchBtn')));

  // --- A phone and one more spectator ---
  const phone = await newUser('Phony', PHONE);
  await phone.goto(roomUrl);
  await inGame(phone, 60000);
  check('phone spectator: no steering zone, no action button, no steering-mode button',
    !(await visible(phone, '#steerZone')) && !(await visible(phone, '#actionZone')) && !(await visible(phone, '#touchModeBtn')));
  check('phone spectator: spectating bar with a button', (await label(phone)).includes('SPECTATING') && await visible(phone, '[data-room-action=ask]'));
  const phoneJoin = await phone.evaluate(() => {
    // The canvas element fills the screen; the 4:3 picture is centred in it
    const width = (window.innerHeight * 4) / 3;
    const canvas = { left: (window.innerWidth - width) / 2, right: (window.innerWidth + width) / 2 };
    const rects = ['#joinBadge', '#seatBar'].map(s => document.querySelector(s).getBoundingClientRect());
    return {
      qr: !!document.querySelector('#joinQr svg'),
      code: document.querySelector('#joinCode')?.textContent,
      rects: rects.map(r => [Math.round(r.left), Math.round(r.right)]),
      overlap: rects.some(r => r.width > 0 && r.left < canvas.right - 1 && r.right > canvas.left + 1),
    };
  });
  check('phone: room code and QR in the margin, off the canvas', phoneJoin.qr && phoneJoin.code === code && !phoneJoin.overlap, JSON.stringify(phoneJoin));
  const spec2 = await newUser('Watchy');
  await spec2.goto(roomUrl);
  await inGame(spec2, 60000);
  await host.waitForFunction(() => document.querySelector('#watchCount')?.textContent.includes('3'), null, { timeout: 20000 });
  check('three spectators counted', (await audience(host)).spectators === 3);

  // --- Host cost with three spectators ---
  const loaded = await measureHost(host, [host, guest]);
  check('measured host output with 3 spectators', loaded !== null && loaded.rates.length === 4, JSON.stringify(loaded));
  if (baseline && loaded) {
    const player = loaded.rates[0];
    const watchers = loaded.rates.slice(1);
    const perWatcher = Math.round(watchers.reduce((a, b) => a + b, 0) / watchers.length);
    console.log(`       host sends ${baseline.total} B/s with 0 spectators, ${loaded.total} B/s with 3: ` +
      `${player} B/s to the player, ${perWatcher} B/s per spectator (${Math.round(100 * perWatcher / player)} %)`);
    console.log(`       payload: ${loaded.stats.bytesOut} B/s per player, ${loaded.stats.bytesOutSpectators} B/s per spectator`);
    check('a spectator costs the host less than 60 % of a player', perWatcher < player * 0.6, `${perWatcher} vs ${player} B/s`);
  }
  const [gIn, sIn] = [await guest.evaluate(() => window.__teratron.stats().bytesIn), await spec.evaluate(() => window.__teratron.stats().bytesIn)];
  check('spectator receives the reduced stream', sIn > 500 && sIn < gIn * 0.7, `${sIn} vs ${gIn} B/s`);

  await shot(host, 'desktop-game-join-code');
  await shot(spec, 'desktop-spectator');
  await shot(phone, 'phone-spectator');

  // --- Spectator reloads ---
  await spec.reload();
  await inGame(spec, 60000);
  await spec.waitForFunction(() => window.__teratron.view()?.round.players.length === 3, null, { timeout: 15000 });
  check('spectator reload: watching again', (await mySlot(spec)) === null && (await label(spec)).includes('SPECTATING'));
  await ensurePlaying(host, [host, guest]);
  await spec.waitForTimeout(1500);
  const litAfter = await litPixels(spec);
  check('spectator reload: sees the arena so far', litAfter > 150, `${litAfter} lit pixels`);

  // --- Ask to play: seated when the next round starts ---
  await spec.click('[data-room-action=ask]');
  await waitFor(() => label(spec), l => l.includes('next round'));
  check('spectator asks to play', true, await label(spec));
  await waitFor(() => audience(host), a => a.joining.includes('Specky'));
  check('host knows who joins next round', true);
  await spec.reload();
  await inGame(spec, 60000);
  await waitFor(() => label(spec), l => l.includes('next round'), 30000);
  check('the request survives a reload', true);
  check('nobody is seated in the middle of a round', (await view(host)).players.length === 3 && (await mySlot(spec)) === null);

  await endRound(host, [host, guest]);
  await host.waitForTimeout(300);
  const summary = await audience(host);
  check('round summary data: spectators and who joins', summary.spectators === 3 && summary.joining.includes('Specky'), JSON.stringify(summary));
  await shot(host, 'desktop-results-spectators');
  await shot(phone, 'phone-results-spectators');
  const roundBefore = (await view(host)).round;
  await nextRound(host, [host, guest]);
  await spec.waitForFunction(() => window.__teratron.config.players.some(p => p.control.type === 'local'), null, { timeout: 15000 });
  const seated = await view(host);
  check('newcomer plays from the next round', seated.round === roundBefore + 1 && seated.players.length === 4 && (await mySlot(spec)) === 3,
    `slot ${await mySlot(spec)}, ${seated.players.map(p => p.name).join(', ')}`);
  check('newcomer starts at 0', seated.scores[3] === 0, JSON.stringify(seated.scores));
  check('everybody knows the newcomer by name', (await view(guest)).players.find(p => p.slot === 3)?.name === 'Specky');
  check('newcomer gets controls and a WATCH button', await visible(spec, '#watchBtn') && !(await visible(spec, '#seatBar')));
  await waitFor(() => audience(host), a => a.spectators === 2);
  check('one spectator less', true);

  await host.waitForFunction(() => window.__teratron.view()?.round.phase === 'playing', null, { timeout: 15000 });
  const before = (await view(host)).players.find(p => p.slot === 3).direction;
  await spec.keyboard.down('ArrowRight');
  await spec.waitForTimeout(400);
  await spec.keyboard.up('ArrowRight');
  await spec.waitForTimeout(400);
  const after = (await view(host)).players.find(p => p.slot === 3).direction;
  check('newcomer steers its player on the host', before !== after, `${before}° -> ${after}°`);
  const specStats = await spec.evaluate(() => window.__teratron.stats());
  check('newcomer now gets the full stream and predicts', specStats.bytesIn > 5000, JSON.stringify(specStats));

  // --- A player steps down, the phone takes the seat ---
  await phone.tap('[data-room-action=ask]');
  await guest.click('#watchBtn');
  await waitFor(() => label(guest), l => l.includes('watch from the next round'));
  check('player steps down: keeps playing this round', (await mySlot(guest)) === 1, await label(guest));
  await waitFor(() => audience(host), a => a.joining.includes('Phony') && a.leaving.includes('Guesty'));
  await endRound(host, [host, guest, spec]);
  await host.waitForTimeout(300);
  await shot(host, 'desktop-results-join-leave');
  await nextRound(host, [host, spec]);   // The leaver is not waited for
  await phone.waitForFunction(() => window.__teratron.config.players.some(p => p.control.type === 'local'), null, { timeout: 15000 });
  const swapped = await view(host);
  check('phone takes the seat the player left', (await mySlot(phone)) === 1 && swapped.players.find(p => p.slot === 1)?.name === 'Phony',
    swapped.players.map(p => `${p.slot}:${p.name}`).join(' '));
  await guest.waitForFunction(() => !window.__teratron.config.players.some(p => p.control.type === 'local'), null, { timeout: 15000 });
  check('the one who stepped down is a spectator', (await label(guest)).includes('SPECTATING') && !(await visible(guest, '#watchBtn')));
  check('phone player gets touch controls', await visible(phone, '#steerZone') && await visible(phone, '#actionZone') && !(await visible(phone, '#seatBar')));
  await host.waitForFunction(() => window.__teratron.view()?.round.phase === 'playing', null, { timeout: 15000 });
  await phone.waitForTimeout(600);
  await shot(phone, 'phone-player-join-code');
  const [h2, g2] = [await view(host), await view(guest)];
  check('former player still sees the game in sync', h2.round === g2.round &&
    !h2.players.some((p, i) => Math.hypot(p.x - g2.players[i].x, p.y - g2.players[i].y) > 40));

  // --- Queue: a bot is replaced, then nobody is displaced ---
  await spec2.click('[data-room-action=ask]');
  await waitFor(() => label(spec2), l => l.includes('next round'));
  await guest.click('[data-room-action=ask]');
  await waitFor(() => label(guest), l => l.includes('Waiting for a free seat'));
  check('with four humans to be, the next one waits', true, await label(guest));

  // Narrow desktop window: no margin for the QR, it opens from the badge
  await spec2.setViewportSize({ width: 1000, height: 800 });
  await spec2.waitForTimeout(300);
  const cornerHidden = !(await visible(spec2, '#joinCorner'));
  await spec2.click('[data-room-action=qr]');
  check('narrow window: QR opens from the badge', cornerHidden && await spec2.locator('#joinQrPop svg').count() === 1);
  await shot(spec2, 'desktop-narrow-qr-popover');
  await spec2.click('[data-room-action=qr]');
  await spec2.setViewportSize({ width: 1200, height: 800 });

  // --- Everybody back to the lobby ---
  await host.click('#lobbyBtn');
  await Promise.all([host, guest, spec, phone, spec2].map(p => inLobby(p)));
  check('host sends everyone back to the lobby, spectators included', true);
  await host.waitForSelector('#spectatorsHeading', { timeout: 15000 });
  const heading = await host.textContent('#spectatorsHeading');
  check('lobby lists the spectators', /Spectators \(2\/\d+\)/.test(heading), heading);
  check('lobby marks who asked to play', (await host.textContent('#playersPanel')).includes('wants to play'));
  await spec2.fill('#chatInput', 'hello from the stands');
  await spec2.press('#chatInput', 'Enter');
  await host.waitForFunction(() => document.querySelector('#chatMessages')?.textContent.includes('hello from the stands'), null, { timeout: 10000 });
  check('spectators can chat in the lobby', true);
  await shot(host, 'desktop-lobby-spectators');
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.waitForTimeout(300);
  await shot(phone, 'phone-lobby-spectators', true);
  await phone.setViewportSize(PHONE.viewport);

  // --- A new game: spectators go straight to their view ---
  await host.waitForFunction(() => !document.querySelector('#startGameBtn')?.disabled, null, { timeout: 15000 });
  await host.click('#startGameBtn');
  await Promise.all([host, guest, spec, phone, spec2].map(p => inGame(p)));
  check('second game: players play, spectators watch',
    (await mySlot(host)) === 0 && (await mySlot(phone)) === 1 && (await mySlot(spec)) === 3 && (await mySlot(guest)) === null && (await mySlot(spec2)) === null);

  // --- The host steps down: it keeps simulating, and those who were waiting get in ---
  // (Watchy and Guesty asked to play during the first game and are still in the queue:
  // one takes the host's seat, the other replaces the bot)
  await host.click('#watchBtn');
  await waitFor(() => audience(host), a => a.leaving.includes('Hosty'));
  await endRound(host, [host, phone, spec]);
  await nextRound(host, [phone, spec]);
  await host.waitForFunction(() => !window.__teratron.config.players.some(p => p.control.type === 'local'), null, { timeout: 15000 });
  const hostless = await view(host);
  const names = hostless.players.map(p => `${p.slot}:${p.name}`).join(' ');
  check('the host can step down and watch', (await label(host)).includes('SPECTATING') && !names.includes('Hosty'), names);
  check('the queue outlives the game: free seat first, then the bot', names === '0:Watchy 1:Phony 2:Guesty 3:Specky', names);
  await spec2.waitForFunction(() => window.__teratron.config.players.some(p => p.control.type === 'local'), null, { timeout: 15000 });
  await host.waitForFunction(() => window.__teratron.view()?.round.phase === 'playing', null, { timeout: 15000 });
  const dirBefore = (await view(host)).players.find(p => p.slot === 0).direction;
  await spec2.keyboard.down('ArrowRight');
  await spec2.waitForTimeout(400);
  await spec2.keyboard.up('ArrowRight');
  await spec2.waitForTimeout(300);
  check('the game goes on without the host playing', (await view(host)).players.find(p => p.slot === 0).direction !== dirBefore);
  await host.click('[data-room-action=ask]');
  await waitFor(() => label(host), l => l.includes('Waiting for a free seat'));
  check('the host queues like anybody else', true, await label(host));

  // --- A player quits: the seat is not kept, and goes to the first in the queue ---
  await spec.click('#backBtn');
  await spec.waitForSelector('#networkGameBtn', { timeout: 15000 });
  await waitFor(() => audience(host), a => a.leaving.includes('Specky') && a.joining.includes('Hosty'), 15000);
  check('a player who quits gives up the seat at the next round', true);
  await endRound(host, [spec2, phone, guest]);
  await nextRound(host, [spec2, phone, guest]);   // Nobody waits for the one who left
  await host.waitForFunction(() => window.__teratron.config.players.some(p => p.control.type === 'local'), null, { timeout: 15000 });
  check('the host is back in the game, at 0', (await mySlot(host)) === 3 && (await view(host)).scores[3] === 0, JSON.stringify((await view(host)).scores));

  // --- Optional: fill the room ---
  if (process.env.E2E_CAP === '1') {
    const extra = [];
    for (let i = 0; i < 7; i++) {
      const page = await newUser(`Extra${i}`);
      await page.goto(roomUrl);
      extra.push(page);
      await page.waitForTimeout(1500);
    }
    const last = extra[extra.length - 1];
    const refused = await last.waitForFunction(() => document.body.textContent.includes('room is full'), null, { timeout: 60000 }).then(() => true, () => false);
    check('the room refuses a 7th spectator', refused);
    gone.push(`Extra${extra.length - 1}`);
    const watching = await waitFor(() => audience(host), a => a.spectators === 6, 30000).then(() => true, () => false);
    check('six spectators stay', watching);
    for (const page of extra) await page.context().close();
  }

  // --- Host reloads: the simulation is lost, everybody returns to the lobby ---
  await host.reload();
  await inLobby(host, 30000);
  await host.waitForSelector('#startGameBtn', { timeout: 30000 });
  await Promise.all([guest, phone, spec2].map(p => inLobby(p, 30000)));
  check('host reload: players and spectators return to the lobby', true);

  // --- Host leaves ---
  await host.click('#disconnectBtn');
  await guest.waitForSelector('#networkGameBtn', { timeout: 40000 });
  await phone.waitForSelector('#networkGameBtn', { timeout: 40000 });
  check('spectators and players are sent to the menu when the host leaves', true);

  // A user who has left the room can still log a connection that was torn down half-way
  // through its handshake (seen with many browsers on one machine)
  // ... and a dozen browsers behind one address get rate-limited by public relays (429)
  const real = errors.filter(e => !gone.some(name => e.startsWith(`${name}: Trystero peer error`)) &&
    !/WebSocket connection to 'wss:.*429/.test(e));
  check('no page errors', real.length === 0, real.slice(0, 3).join(' | '));
} catch (err) {
  check('completed without exceptions', false, String(err).split('\n')[0]);
  if (errors.length) console.log('page errors:', errors.slice(0, 5));
} finally {
  await browser.close();
  await server?.close();
}

console.log(`\n${steps.filter(s => s.ok).length}/${steps.length} checks passed`);
process.exit(failed ? 1 : 0);
