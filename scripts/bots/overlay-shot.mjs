// Screenshots of the `?botdebug` overlay in the real game (headless Chrome, all-AI local
// game): a check that the overlay draws, and pictures to look at.
//
//   node scripts/bots/overlay-shot.mjs [outDir] [level] [seconds]

import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { mkdirSync } from 'node:fs';

const out = process.argv[2] ?? 'snapshots';
const level = process.argv[3] ?? 'bricks';
const seconds = Number(process.argv[4] ?? 12);
mkdirSync(out, { recursive: true });

const server = await createServer({ server: { port: 0, strictPort: false, https: false, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}${server.config.base}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
let failed = false;
try {
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 720 } })).newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript((levelMode) => {
    localStorage.setItem('teratron-local-setup', JSON.stringify({ slots: ['ai-hard', 'ai-hard', 'ai-normal', 'ai-easy'], gameMode: 'ffa', levelMode }));
  }, level);
  await page.goto(`${baseUrl}?botdebug=1`);
  await page.click('#localGameBtn');
  await page.click('#startBtn');
  // Wait for the round to be under way
  await page.waitForFunction(() => window.__teratron?.view()?.round.phase === 'playing', null, { timeout: 30000 });
  await page.waitForTimeout(seconds * 1000);
  for (const layer of ['territory', 'risk', 'clearance']) {
    const file = `${out}/overlay-${level}-${layer}.png`;
    await page.screenshot({ path: file });
    console.log(file);
    await page.keyboard.press('b');
    await page.waitForTimeout(300);
  }
  const phase = await page.evaluate(() => window.__teratron.view().round.phase);
  console.log(`phase after ${seconds}s: ${phase}`);
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await browser.close();
  await server.close();
}
if (errors.length > 0) {
  failed = true;
  console.error('page errors:', errors);
}
process.exit(failed ? 1 : 0);
