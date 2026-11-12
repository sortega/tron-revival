// End-to-end check of the touch steering modes (design/touch-controls.md) in a headless
// Chrome emulating a phone, with synthetic touches.
//
//   npm run test:e2e:touch
//   E2E_SHOTS=/some/dir npm run test:e2e:touch    (also saves a screenshot per mode)

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
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}${server.config.base}`;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const diff = (from, to) => ((((to - from) % 360) + 540) % 360) - 180;

try {
  const context = await browser.newContext({
    viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(() => {
    localStorage.setItem('teratron-local-setup', JSON.stringify({ slots: ['human', 'ai-easy', 'off', 'off'], gameMode: 'ffa', levelMode: 'blank' }));
    if (!localStorage.getItem('teratron-touch-mode')) localStorage.setItem('teratron-touch-mode', 'buttons');
  });
  await page.goto(baseUrl);
  await page.tap('#localGameBtn');
  await page.tap('#startBtn');
  await page.waitForSelector('#steerZone');
  check('phone layout with a steering area', true);

  const cdp = await context.newCDPSession(page);
  let touchId = 0;
  const touch = (type, x, y, id) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id }],
  });
  /** Drag one finger through the points, `hold` ms at the end; returns a release function. */
  async function drag(points, hold = 0) {
    const id = ++touchId;
    await touch('touchStart', points[0][0], points[0][1], id);
    for (const [x, y] of points.slice(1)) {
      await touch('touchMove', x, y, id);
      await sleep(16);
    }
    await sleep(hold);
    return () => touch('touchEnd', 0, 0, id);
  }
  const me = () => page.evaluate(() => {
    const round = window.__teratron.view().round;
    const p = round.players[0];
    return { phase: round.phase, alive: p.alive, direction: p.direction, ready: window.__teratron.view().match.playersReady.includes(0) };
  });
  const action = await page.locator('#actionButton').boundingBox();
  /** Wait until our player can be steered (readying up for a new round if needed); returns its heading. */
  async function ready() {
    for (let i = 0; i < 600; i++) {
      const state = await me();
      if (state.phase === 'playing' && state.alive) return state.direction;
      if (state.phase === 'waiting_ready' && !state.ready) {
        // A press must last at least one tick to be seen
        const release = await drag([[action.x + action.width / 2, action.y + action.height / 2]], 100);
        await release();
      }
      await sleep(50);
    }
    throw new Error('player never became steerable');
  }
  const mode = () => page.evaluate(() => localStorage.getItem('teratron-touch-mode'));
  async function selectMode(wanted) {
    for (let i = 0; i < 4 && await mode() !== wanted; i++) await page.tap('#touchModeBtn');
    check(`mode button selects ${wanted}`, await mode() === wanted, await page.textContent('#touchModeBtn'));
    if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/touch-${wanted}.png` });
  }
  const zone = await page.locator('#steerZone').boundingBox();

  /**
   * Make a gesture while our player is steerable and report its heading before and after.
   * The player drives unattended, so it may crash or pick up an item meanwhile: then try again.
   * `flick`: lift the finger at once and wait `hold` ms afterwards instead of holding.
   */
  async function steer(points, hold, flick = false) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const before = await ready();
      const started = Date.now();
      const release = await drag(points, flick ? 0 : hold);
      if (flick) {
        await release();
        await sleep(hold);
      }
      const state = await me();
      if (!flick) await release();
      // More than full lock allows: something else (an item) turned the player. Try again.
      const possible = 280 * (Date.now() - started) / 1000 * 1.3 + 10;
      if (state.alive && state.phase === 'playing' && Math.abs(diff(before, state.direction)) <= possible) {
        return { before, after: state.direction, turned: diff(before, state.direction) };
      }
    }
    throw new Error('player kept crashing during a gesture');
  }

  // --- buttons: binary, like keys ---
  await selectMode('buttons');
  const pads = await page.locator('.steer-pads').boundingBox();
  const padY = pads.y + pads.height / 2;
  let r = await steer([[pads.x + pads.width * 0.25, padY]], 300);
  check('buttons: left pad turns left at full rate', r.turned < -60 && r.turned > -110, `${r.turned.toFixed(0)}° in 0.3 s`);
  r = await steer([[pads.x + pads.width * 0.75, padY]], 300);
  check('buttons: right pad turns right at full rate', r.turned > 60 && r.turned < 110, `${r.turned.toFixed(0)}° in 0.3 s`);
  await sleep(100);
  const straight = (await me()).direction;
  await sleep(200);
  check('buttons: straight on when released', Math.abs(diff(straight, (await me()).direction)) < 0.01);

  // --- heading: point where you want to go ---
  await selectMode('heading');
  const cx = zone.x + zone.width / 2;
  const cy = zone.y + zone.height / 2;
  r = await steer([[cx, cy], [cx, cy - 20], [cx, cy - 40]], 1500);
  check('heading: dragging up turns the player up', Math.abs(diff(r.after, 270)) < 1, `${r.after.toFixed(1)}°`);
  r = await steer([[cx, cy], [cx - 20, cy + 20], [cx - 40, cy + 40]], 1500);
  check('heading: dragging down-left turns the player down-left', Math.abs(diff(r.after, 135)) < 1, `${r.after.toFixed(1)}°`);

  // --- swipe: distance dragged = angle turned ---
  await selectMode('swipe');
  // A flick: the turn completes after the finger is lifted
  r = await steer([[cx - 40, cy], [cx - 20, cy], [cx, cy], [cx + 20, cy], [cx + 35, cy]], 900, true);
  check('swipe: 75 px to the right is a right angle', Math.abs(r.turned - 90) < 1.5, `${r.turned.toFixed(1)}°`);
  r = await steer([[cx, cy], [cx - 25, cy + 30]], 700);
  check('swipe: 25 px to the left is 30° left', Math.abs(r.turned + 30) < 1.5, `${r.turned.toFixed(1)}°`);

  // --- classic: the original proportional stick ---
  await selectMode('classic');
  const stick = await page.locator('.joystick-zone').boundingBox();
  const sx = stick.x + stick.width / 2;
  const sy = stick.y + stick.height / 2;
  r = await steer([[sx, sy], [sx + 20, sy], [sx + 45, sy]], 300);
  check('classic: full travel right turns right', r.turned > 50, `${r.turned.toFixed(0)}° in 0.3 s`);
  r = await steer([[sx, sy], [sx - 22, sy]], 300);
  check('classic: half travel left turns left slowly', r.turned < -5 && r.turned > -30, `${r.turned.toFixed(0)}° in 0.3 s`);

  // The choice survives a reload
  await page.reload();
  check('mode is remembered', await mode() === 'classic');
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
