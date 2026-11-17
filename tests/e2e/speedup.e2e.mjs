// End-to-end check of speeding up when only bots are left (design/local-and-ai.md), in a
// headless Chrome: a human dies, the offer appears, the round runs about ten times faster
// while action is held, and at normal speed when it is let go. Also prints what the
// speed-up costs (`?perf=1` timers).
//
//   npm run test:e2e:speedup
//   E2E_QUERY=worker=0 npm run test:e2e:speedup     (simulation on the page's thread)
//   E2E_THROTTLE=4 npm run test:e2e:speedup         (CPU of the page slowed down 4 times)
//   E2E_SHOTS=/some/dir npm run test:e2e:speedup    (also saves screenshots)

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
const query = `?perf=1${process.env.E2E_QUERY ? `&${process.env.E2E_QUERY}` : ''}`;
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}${server.config.base}${query}`;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const stats = (list = []) => {
  const sorted = [...list].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length);
  return { n: sorted.length, mean, p99: sorted[Math.floor(sorted.length * 0.99)] ?? 0, max: sorted[sorted.length - 1] ?? 0 };
};
const show = (s, unit = 'ms') => `${s.mean.toFixed(2)} / ${s.p99.toFixed(2)} / ${s.max.toFixed(2)} ${unit} (n=${s.n})`;

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(() => {
    localStorage.setItem('teratron-local-setup', JSON.stringify({ slots: ['human', 'ai-hard', 'ai-hard', 'ai-hard'], gameMode: 'ffa', levelMode: 'bricks' }));
  });
  const throttle = Number(process.env.E2E_THROTTLE ?? 1);
  if (throttle > 1) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  }
  await page.goto(baseUrl);
  await page.click('#localGameBtn');
  await page.click('#startBtn');
  await page.waitForFunction(() => window.__teratron?.view());

  const state = () => page.evaluate(() => {
    const { round, match } = window.__teratron.view();
    return {
      phase: round.phase, round: match.currentRound, speedUp: round.speedUp, tick: round.doorTick,
      human: round.players[0].alive, ready: match.playersReady.includes(0), now: performance.now(),
    };
  });
  const until = async (what, test, seconds) => {
    for (let i = 0; i < seconds * 20; i++) {
      const s = await state();
      if (test(s)) return s;
      await sleep(50);
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  // Phase timers of the page and of the worker, emptied on reading
  const perf = () => page.evaluate(async () => ({
    page: window.__teratron.perf(),
    worker: await window.__teratron.session.workerPerf?.() ?? null,
  }));

  const measured = { normal: [], fast: [] };
  let fastTicks = 0;
  let fastMs = 0;
  let rounds = 0;
  let offeredEarly = false;
  let stayedOn = true;
  let released = null;
  // Rounds in which two bots outlive the human by more than a second are what we are after
  for (let attempt = 0; attempt < 12 && fastMs < 4000; attempt++) {
    await until('a round being played', s => s.phase === 'playing', 30);
    await perf();
    // The human circles into their own trail
    await page.keyboard.down('ArrowLeft');
    const playing = await state();
    await sleep(700);
    const stillPlaying = await state();
    if (stillPlaying.human && stillPlaying.phase === 'playing') {
      measured.normal.push({ ...(await perf()), ticks: stillPlaying.tick - playing.tick, ms: stillPlaying.now - playing.now });
    }
    const after = await until('the human to die', s => !s.human || s.phase !== 'playing', 30);
    await page.keyboard.up('ArrowLeft');
    if (after.speedUp) offeredEarly = true;

    const offer = await until('the offer or the end of the round', s => s.speedUp === 'offered' || s.phase !== 'playing', 30);
    if (offer.speedUp === 'offered') {
      if (process.env.E2E_SHOTS && rounds === 0) await page.screenshot({ path: `${process.env.E2E_SHOTS}/speedup-offered.png` });
      await page.keyboard.down('Space');
      const on = await until('the speed-up', s => s.speedUp === 'on' || s.phase !== 'playing', 5);
      if (on.speedUp === 'on' && rounds === 0) {
        // Letting go brings normal speed back
        await page.keyboard.up('Space');
        const a = await until('normal speed', s => s.speedUp === 'offered' || s.phase !== 'playing', 5);
        await sleep(400);
        const b = await state();
        if (a.phase === 'playing' && b.phase === 'playing') {
          released = b.speedUp === 'offered' && (b.tick - a.tick) / ((b.now - a.now) / 1000) < 100;
        }
        await page.keyboard.down('Space');
      }
      if (on.speedUp === 'on') {
        rounds++;
        if (process.env.E2E_SHOTS && rounds === 1) await page.screenshot({ path: `${process.env.E2E_SHOTS}/speedup-on.png` });
        await perf();
        let last = await state();
        const first = last;
        for (;;) {
          await sleep(100);
          const s = await state();
          if (s.phase !== 'playing') break;
          if (s.speedUp !== 'on') stayedOn = false;
          last = s;
        }
        if (last.now - first.now > 300) {
          measured.fast.push({ ...(await perf()), ticks: last.tick - first.tick, ms: last.now - first.now });
          fastTicks += last.tick - first.tick;
          fastMs += last.now - first.now;
        }
      }
    }
    await page.keyboard.up('Space');
    const over = await until('the round to end', s => s.phase === 'waiting_ready', 120);
    check(`round ${over.round}: no offer once the round is over`, over.speedUp === undefined);
    // Ready for the next one (presses count a second after the round ended)
    await sleep(1200);
    await page.keyboard.down('Space');
    await sleep(100);
    await page.keyboard.up('Space');
  }

  check('the offer waits for the human to be dead for a while', !offeredEarly);
  check('holding action speeds the round up', rounds > 0, `${rounds} rounds`);
  check('it stays sped up while held', stayedOn);
  check('letting go brings normal speed back', released !== false, released === null ? 'not seen: the round ended first' : '');
  const rate = fastTicks / (fastMs / 1000);
  const wanted = throttle > 1 ? 150 : 600;
  check(`time runs faster (${throttle > 1 ? 'throttled: ' : ''}more than ${wanted} ticks a second)`, rate > wanted && rate < 720, `${rate.toFixed(0)} ticks/s over ${(fastMs / 1000).toFixed(1)} s`);
  const normalRate = measured.normal.reduce((a, m) => a + m.ticks, 0) / (measured.normal.reduce((a, m) => a + m.ms, 0) / 1000);
  check('and at 70 ticks a second otherwise', normalRate > 60 && normalRate < 80, `${normalRate.toFixed(0)} ticks/s`);
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  // What it costs: mean / 99th percentile / worst
  const inWorker = await page.evaluate(() => window.__teratron.inWorker());
  for (const kind of ['normal', 'fast']) {
    const all = (side, phase) => measured[kind].flatMap(m => m[side]?.samples[phase] ?? []);
    const seconds = measured[kind].reduce((a, m) => a + m.ms, 0) / 1000;
    const sum = (list) => list.reduce((a, b) => a + b, 0);
    const side = inWorker ? 'worker' : 'page';
    console.log(`\n${kind} (${seconds.toFixed(1)} s, simulation ${inWorker ? 'in a worker' : 'on the page'}):`);
    console.log(`  tick (bots + rules + frame)   ${show(stats(all(side, 'step')))}`);
    console.log(`    bots                        ${show(stats(all(side, 'bots')))}`);
    console.log(`    rules                       ${show(stats(all(side, 'sim')))}`);
    console.log(`  simulating, share of a core   ${(sum(all(side, 'step')) / (seconds * 10)).toFixed(1)} %`);
    console.log(`  page: applying frames         ${(sum(all('page', 'events')) / (seconds * 10)).toFixed(1)} % of the main thread`);
    console.log(`  page: display frame           ${show(stats(all('page', 'frame')))}`);
    console.log(`  page: gap between frames      ${show(stats(all('page', 'rafGap')))}`);
    if (inWorker) console.log(`  age of a frame at the page    ${show(stats(all('page', 'workerLag')))}`);
  }
} catch (err) {
  check('completed without exceptions', false, String(err).split('\n')[0]);
  if (errors.length) console.log('page errors:', errors.slice(0, 5));
} finally {
  await browser.close();
  await server.close();
}

console.log(`\n${steps.filter(s => s.ok).length}/${steps.length} checks passed`);
process.exit(failed ? 1 : 0);
