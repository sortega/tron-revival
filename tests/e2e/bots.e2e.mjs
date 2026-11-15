// End-to-end check of an all-AI local game in a headless Chrome: the human-like bots
// (design/bots-human.md) run in the real app, rounds get played, nothing throws.
//
//   npm run test:e2e:bots
//   E2E_SHOTS=/some/dir npm run test:e2e:bots    (also saves screenshots of the game)
//   E2E_QUERY=human=0 npm run test:e2e:bots      (the old, perfect bots)

import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const steps = [];
let failed = false;
function check(name, ok, detail = '') {
  steps.push({ name, ok });
  console.log(`${ok ? '  ok ' : 'FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
}

const server = await createServer({ server: { port: 0, strictPort: false, https: false, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const query = process.env.E2E_QUERY ? `?${process.env.E2E_QUERY}` : '';
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}${server.config.base}${query}`;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(() => {
    localStorage.setItem('teratron-local-setup', JSON.stringify({ slots: ['ai-easy', 'ai-normal', 'ai-hard', 'ai-hard'], gameMode: 'ffa', levelMode: 'bricks' }));
  });
  await page.goto(baseUrl);
  await page.click('#localGameBtn');
  await page.click('#startBtn');
  await page.waitForFunction(() => window.__teratron?.view());

  const state = () => page.evaluate(() => {
    const { round, match } = window.__teratron.view();
    return {
      phase: round.phase, round: match.currentRound,
      players: round.players.map(p => ({ alive: p.alive, x: Math.round(p.x / 1000), y: Math.round(p.y / 1000), steer: p.steer })),
    };
  });

  // Watch for up to 2 min: the bots must ready up, drive (and steer), die and start another round
  let steered = false;
  let moved = false;
  let firstRound = null;
  let lastRound = null;
  let start = null;
  for (let i = 0; i < 480 && !(lastRound > firstRound && i > 60); i++) {
    const s = await state();
    firstRound ??= s.round;
    lastRound = s.round;
    if (s.phase === 'playing') {
      start ??= s.players;
      if (s.players.some(p => p.steer !== 0)) steered = true;
      if (s.players.some((p, k) => Math.abs(p.x - start[k].x) + Math.abs(p.y - start[k].y) > 40)) moved = true;
    }
    if (process.env.E2E_SHOTS && (i === 24 || i === 60)) {
      await page.screenshot({ path: `${process.env.E2E_SHOTS}/bots-${i === 24 ? 'a' : 'b'}.png` });
    }
    await sleep(250);
  }
  check('bots drive', moved);
  check('bots steer', steered);
  check('rounds follow one another without a human', lastRound > firstRound, `round ${firstRound} → ${lastRound}`);
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  check('completed without exceptions', false, String(err).split('\n')[0]);
  if (errors.length) console.log('page errors:', errors.slice(0, 5));
} finally {
  await browser.close();
  await server.close();
}

console.log(`\n${steps.filter(s => s.ok).length}/${steps.length} checks passed`);
process.exit(failed ? 1 : 0);
