// End-to-end check of a network game with two real (headless) Chrome instances
// talking through the public signaling relays.
//
//   npm run test:e2e            (starts its own dev server)
//   E2E_URL=https://... npm run test:e2e   (against a running/deployed build)
//   E2E_RELAY=1 npm run test:e2e           (everything through a local TURN server)
//   E2E_QUERY=lag=80 npm run test:e2e      (with artificial latency)
//
// Requires Google Chrome and internet access.

import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const steps = [];
let failed = false;
function check(name, ok, detail = '') {
  steps.push({ name, ok });
  console.log(`${ok ? '  ok ' : 'FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
}

// E2E_RELAY=1: start a local TURN server and force every connection through it
// (`?relay=1`). This exercises the path used by players who cannot connect directly.
let turn = null;
const relayMode = process.env.E2E_RELAY === '1';
if (relayMode) {
  const { default: Turn } = await import('node-turn');
  turn = new Turn({ authMech: 'long-term', credentials: { teratron: 'e2e-secret' }, listeningPort: 34780, listeningIps: ['127.0.0.1'], relayIps: ['127.0.0.1'], debugLevel: 'OFF' });
  turn.start();
  process.env.VITE_TURN_URLS = 'turn:127.0.0.1:34780?transport=udp';
  process.env.VITE_TURN_USERNAME = 'teratron';
  process.env.VITE_TURN_CREDENTIAL = 'e2e-secret';
}

let server = null;
let baseUrl = process.env.E2E_URL;
if (!baseUrl) {
  server = await createServer({ server: { port: 0, strictPort: false, https: false, host: '127.0.0.1' }, logLevel: 'error' });
  await server.listen();
  const address = server.httpServer.address();
  baseUrl = `http://127.0.0.1:${address.port}${server.config.base}`;
}
const extraQuery = [process.env.E2E_QUERY, relayMode ? 'relay=1' : ''].filter(Boolean).join('&');   // e.g. "lag=80"
const withQuery = (query) => baseUrl + (query || extraQuery ? `?${[query, extraQuery].filter(Boolean).join('&')}` : '');

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
async function newPlayer(name) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1200, height: 800 } });
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
    players: v.round.players.map(p => ({ slot: p.slotIndex, alive: p.alive, x: Math.round(p.x / 1000), y: Math.round(p.y / 1000) })),
  } : null;
});
const inGame = (page, timeout = 20000) => page.waitForFunction(() => !!window.__teratron?.view(), null, { timeout });
const inLobby = (page, timeout = 20000) => page.waitForSelector('#playersPanel', { timeout });

try {
  // --- Lobby ---
  const host = await newPlayer('host');
  await host.goto(withQuery(''));
  await host.click('#networkGameBtn');
  await host.click('#createRoomBtn');
  await host.waitForSelector('#startGameBtn', { timeout: 30000 });
  const code = (await host.textContent('#roomCode')).trim();
  check('host creates a room', /^[a-z]+-[a-z]+-[a-z]+$/.test(code), code);
  check('room code is kept in the URL', new URL(host.url()).searchParams.get('room') === code);
  check('lobby shows a QR code', await host.locator('.lobby-qr svg').count() === 1);

  const guest = await newPlayer('guest');
  const t0 = Date.now();
  await guest.goto(withQuery(`room=${code}`));
  await host.waitForFunction(() => !document.querySelector('#startGameBtn')?.disabled, null, { timeout: 60000 });
  check('guest joins and is seated', true, `${Date.now() - t0} ms`);
  await guest.waitForSelector('#leaveSlot1', { timeout: 15000 });
  check('guest sees its own seat', true);

  await host.waitForSelector('.link-badge', { timeout: 15000 });
  const badge = await host.textContent('.link-badge');
  check('lobby shows connection diagnostics', /direct|relay/.test(badge), badge);
  if (/relay=1/.test(extraQuery)) check('connection is relayed through TURN', /relay/.test(badge), badge);

  await guest.fill('#chatInput', 'hello from guest');
  await guest.press('#chatInput', 'Enter');
  await host.waitForFunction(() => document.querySelector('#chatMessages')?.textContent.includes('hello from guest'), null, { timeout: 10000 });
  check('chat reaches the host', true);

  await host.click('#addBot2');
  await guest.waitForFunction(() => document.querySelector('#playersPanel')?.textContent.includes('Bot'), null, { timeout: 10000 });
  check('host adds a bot, guest sees it', true);

  // --- Game ---
  await host.click('#startGameBtn');
  await Promise.all([inGame(host), inGame(guest)]);
  check('both enter the game', true);
  await guest.waitForFunction(() => window.__teratron.view()?.round.phase === 'playing', null, { timeout: 15000 });
  const start = await view(guest);
  check('three players in the game', start.players.length === 3);

  // Guest steers; the host must see the guest's player turn
  const before = await host.evaluate(() => window.__teratron.view().round.players[1].direction);
  await guest.keyboard.down('ArrowRight');
  await guest.waitForTimeout(400);
  await guest.keyboard.up('ArrowRight');
  await guest.waitForTimeout(400);
  const after = await host.evaluate(() => window.__teratron.view().round.players[1].direction);
  check('guest input steers its player on the host', before !== after, `${before}° -> ${after}°`);
  const stats = await guest.evaluate(() => window.__teratron.stats());
  check('guest receives state and predicts', stats.bytesIn > 1000 && stats.predictedTicks >= 0, JSON.stringify(stats));

  const h = await view(host);
  const g = await view(guest);
  const far = h.players.some((p, i) => Math.hypot(p.x - g.players[i].x, p.y - g.players[i].y) > 40);
  check('host and guest agree on positions', !far);

  // --- Guest reloads mid-game ---
  await guest.reload();
  await inGame(guest, 30000);
  await guest.waitForFunction(() => window.__teratron.view()?.round.players.length === 3, null, { timeout: 15000 });
  const resumed = await guest.evaluate(() => window.__teratron.config.players.find(p => p.control.type === 'local')?.slotIndex);
  check('guest reload rejoins the running game in its seat', resumed === 1, `slot ${resumed}`);
  const arena = await guest.evaluate(() => {
    // Count coloured pixels: the trails drawn before the reload must be there
    const canvas = document.querySelector('#gameCanvas canvas');
    const data = canvas.getContext('2d').getImageData(0, 0, 750, 600).data;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] > 60) n++;
    return n;
  });
  check('rejoined guest sees the arena so far', arena > 150, `${arena} lit pixels`);

  // --- Back to lobby and start again ---
  await host.click('#lobbyBtn');
  await Promise.all([inLobby(host), inLobby(guest)]);
  check('host sends everyone back to the lobby', true);
  check('same room', (await guest.textContent('#roomCode')).trim() === code);
  await guest.waitForSelector('#leaveSlot1', { timeout: 15000 });
  check('seats are kept', true);
  await host.selectOption('#levelSelect', 'bricks');
  await host.waitForFunction(() => !document.querySelector('#startGameBtn')?.disabled, null, { timeout: 15000 });
  await host.click('#startGameBtn');
  await Promise.all([inGame(host), inGame(guest)]);
  await guest.waitForFunction(() => window.__teratron.view()?.match.levelMode === 'bricks', null, { timeout: 15000 });
  check('second game starts with the new settings', true);

  // --- Host goes silent: the guest notices, and recovers ---
  const frozen = host.evaluate(() => { const end = Date.now() + 3000; while (Date.now() < end); });
  const noticed = await guest.waitForFunction(() => window.__teratron.stats()?.silentMs > 1500, null, { timeout: 10000 })
    .then(() => true, () => false);
  check('guest notices a silent host', noticed);
  await frozen;
  const recovered = await guest.waitForFunction(() => window.__teratron.stats()?.silentMs < 500, null, { timeout: 10000 })
    .then(() => true, () => false);
  check('guest recovers when the host is back', recovered);

  // --- Host reloads: room survives, back in the lobby ---
  await host.reload();
  await inLobby(host, 30000);
  await host.waitForSelector('#startGameBtn', { timeout: 30000 });
  check('host reload: host is host again', true);
  await inLobby(guest, 30000);
  check('host reload: guests return to the lobby', true);

  // --- Leaving ---
  await host.click('#disconnectBtn');
  await guest.waitForSelector('#networkGameBtn', { timeout: 40000 });
  check('guest is sent to the menu when the host leaves', true);

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  check('completed without exceptions', false, String(err).split('\n')[0]);
  if (errors.length) console.log('page errors:', errors.slice(0, 5));
} finally {
  await browser.close();
  await server?.close();
  turn?.stop();
}

console.log(`\n${steps.filter(s => s.ok).length}/${steps.length} checks passed`);
process.exit(failed ? 1 : 0);
