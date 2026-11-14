// Display-layer lab (design/display-layer.md): comparison screenshots and render cost of
// the shade variants, in headless Chrome.
//
//   node tools/display-lab.mjs shots [outDir]     comparison sheets + full screenshots
//   node tools/display-lab.mjs perf [outDir]      ms per render() and frame pacing for each variant
//   node tools/display-lab.mjs perf-sw [outDir]   the same with Canvas 2D rasterised on the CPU
//
// Requires Google Chrome. Starts its own dev server on a free port.

import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';

const SHADES = ['off', 'glow', 'fringe', 'half', 'outline', 'auto', 'crisp'];
const HEADS = ['glow', 'ring', 'box', 'dot'];
const DEVICES = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  retina: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
  phone: { viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};

const mode = process.argv[2] ?? 'shots';
const outDir = process.argv[3] ?? 'design/research/display-shading';

const server = await createServer({ server: { port: 0, strictPort: false, https: false, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}${server.config.base}`;
// perf-sw: Canvas 2D rasterised on the CPU, as on a device without GPU canvas acceleration
const software = mode === 'perf-sw';
const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: software ? ['--disable-accelerated-2d-canvas', '--disable-gpu'] : [],
});
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** Start a local game (one idle human and three bots) on a level; returns the page. */
async function startGame(device, level, { query = '', bots = 'ai-hard', throttle = 1 } = {}) {
  const context = await browser.newContext(DEVICES[device]);
  const page = await context.newPage();
  page.on('pageerror', e => console.log(`  page error: ${e.message}`));
  await page.addInitScript(([levelMode, kind]) => {
    localStorage.setItem('teratron-local-setup', JSON.stringify({ slots: ['human', kind, kind, kind], gameMode: 'ffa', levelMode }));
    localStorage.setItem('teratron-touch-mode', 'buttons');
    localStorage.removeItem('teratron-display');
  }, [level, bots]);
  if (throttle > 1) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  }
  await page.goto(baseUrl + (query ? `?${query}` : ''));
  const press = (selector) => (DEVICES[device].hasTouch ? page.tap(selector) : page.click(selector));
  await press('#localGameBtn');
  await press('#startBtn');
  await page.waitForFunction(() => window.__teratron?.view()?.round.phase === 'playing', null, { timeout: 30000 });
  return page;
}

// Stop the simulation (the ticker sees no time passing) while frames keep being drawn
const freeze = (page) => page.evaluate(() => {
  const now = performance.now();
  performance.now = () => now;
});
const setDisplay = async (page, spec) => {
  await page.evaluate((s) => window.__teratronDisplay.set(s), spec);
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
};
// Where the 800×600 picture is on the page (on phones the canvas element is letter-boxed)
const contentBox = async (page) => {
  const box = await page.locator('#gameCanvas canvas').boundingBox();
  const k = Math.min(box.width / 800, box.height / 600);
  return { x: box.x + (box.width - 800 * k) / 2, y: box.y + (box.height - 600 * k) / 2, width: 800 * k, height: 600 * k };
};

/** CSS-pixel rectangle of the page showing `size` logical pixels around a logical point. */
async function cropAround(page, x, y, size) {
  const box = await contentBox(page);
  const k = box.height / 600;
  const half = size / 2;
  const cx = Math.max(half, Math.min(750 - half, x));
  const cy = Math.max(half, Math.min(600 - half, y));
  return { x: box.x + (cx - half) * k, y: box.y + (cy - half) * k, width: size * k, height: size * k };
}

async function sheet(title, columns, file) {
  // columns: [{ label, png (Buffer) }]
  const page = await browser.newPage({ viewport: { width: 200, height: 200 } });
  const cells = columns.map(c => `<figure><img src="data:image/png;base64,${c.png.toString('base64')}"><figcaption>${c.label}</figcaption></figure>`).join('');
  await page.setContent(`<body style="margin:0;background:#222;color:#ddd;font:14px monospace">
    <div id="sheet" style="display:inline-block;padding:10px">
      <div style="margin-bottom:8px">${title}</div>
      <div style="display:flex;gap:8px">${cells}</div>
    </div>
    <style>figure{margin:0} img{display:block;width:300px;height:300px;image-rendering:pixelated} figcaption{padding:4px 0;text-align:center}</style>
  </body>`);
  await page.locator('#sheet').screenshot({ path: file });
  await page.close();
  console.log(`  ${file}`);
}

// Where the test card goes on each level: next to a wall, clear of the start positions
const CARD = { bricks: [150, 247], blueprint: [196, 112], paper: [176, 220] };

async function shots() {
  mkdirSync(outDir, { recursive: true });
  for (const level of Object.keys(CARD)) {
    for (const device of Object.keys(DEVICES)) {
      // A live game a few seconds in, frozen; plus the test card (display only)
      const page = await startGame(device, level);
      await sleep(3500);
      await freeze(page);
      const [ox, oy] = CARD[level];
      await page.evaluate(([x, y]) => window.__teratronDisplay.testCard(x, y), [ox, oy]);
      const box = await contentBox(page);
      const dpr = DEVICES[device].deviceScaleFactor;
      const where = `${level} · ${device} (arena ${Math.round(box.height)} CSS px tall, DPR ${dpr})`;
      console.log(where);
      const card = await cropAround(page, ox + 22, oy + 22, 48);

      const shadeCrops = [];
      for (const shade of SHADES) {
        await setDisplay(page, `shade=${shade}&head=ring&fx=`);
        await page.screenshot({ path: `${outDir}/full-${level}-${device}-${shade}.jpg`, type: 'jpeg', quality: 80, clip: box });
        shadeCrops.push({ label: `shade=${shade}`, png: await page.screenshot({ clip: card }) });
      }
      await sheet(`${where} · shade variants (head=ring) · test card, 48×48 logical px`, shadeCrops, `${outDir}/sheet-shade-${level}-${device}.png`);

      const headCrops = [];
      const heads = await cropAround(page, ox + 36, oy + 19, 24);
      for (const shade of ['off', 'auto']) {
        for (const h of HEADS) {
          await setDisplay(page, `shade=${shade}&head=${h}&fx=`);
          headCrops.push({ label: `${shade} / head=${h}`, png: await page.screenshot({ clip: heads }) });
        }
      }
      await sheet(`${where} · head markers · 24×24 logical px`, headCrops, `${outDir}/sheet-head-${level}-${device}.png`);

      const fxCrops = [];
      for (const spec of ['shade=off&fx=', 'shade=auto&fx=', 'shade=auto&fx=shadow', 'shade=auto&fx=tracer', 'shade=auto&fx=pattern', 'shade=fringe&fx=pattern']) {
        await setDisplay(page, `${spec}&head=ring`);
        fxCrops.push({ label: spec.replace('&', ' ').replace(/fx=$/, 'fx=(none)'), png: await page.screenshot({ clip: card }) });
      }
      await sheet(`${where} · extras · test card, 48×48 logical px`, fxCrops, `${outDir}/sheet-fx-${level}-${device}.png`);
      await page.context().close();
    }
  }
}

async function perf() {
  const rows = [];
  const suffix = software ? ', software canvas' : '';
  for (const [label, device, throttle] of [['desktop' + suffix, 'desktop', 1], ['phone ×6 CPU throttle' + suffix, 'phone', 6]]) {
    for (const level of ['bricks', 'blueprint']) {
      for (const spec of [
        ...SHADES.map(s => `shade=${s}&head=ring&fx=`),
        'shade=off&head=glow&fx=',
        'shade=auto&head=ring&fx=shadow,tracer,fade,pattern',
      ]) {
        const page = await startGame(device, level, { query: spec, bots: 'ai-easy', throttle });
        await page.evaluate(() => {
          // Frame pacing next to the time spent inside render()
          const w = window;
          w.__frames = [];
          let last = performance.now();
          const tick = (t) => { w.__frames.push(t - last); last = t; requestAnimationFrame(tick); };
          requestAnimationFrame(tick);
          w.__teratronDisplay.resetPerf();
        });
        await sleep(8000);
        const result = await page.evaluate(() => {
          const f = window.__frames.slice(5).sort((a, b) => a - b);
          const render = window.__teratronDisplay.perf();
          const rederive = [0, 0, 0].map(() => window.__teratronDisplay.rederive()).sort((a, b) => a - b)[1];
          return {
            render, rederive,
            slowFrames: f.filter(v => v > 25).length / f.length,
            frameAvg: f.reduce((a, b) => a + b, 0) / f.length,
            frameP95: f[Math.floor(f.length * 0.95)],
          };
        });
        rows.push({ label, level, spec, ...result });
        console.log(`${label.padEnd(22)} ${level.padEnd(10)} ${spec.padEnd(52)} render avg ${result.render.avg.toFixed(3)} p95 ${result.render.p95.toFixed(3)} max ${result.render.max.toFixed(2)} ms | frame avg ${result.frameAvg.toFixed(1)} p95 ${result.frameP95.toFixed(1)} ms, ${(result.slowFrames * 100).toFixed(1)}% > 25 ms | full re-derive ${result.rederive.toFixed(1)} ms`);
        await page.context().close();
      }
    }
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/${mode}.json`, JSON.stringify(rows, null, 2));
}

try {
  if (mode === 'perf' || mode === 'perf-sw') await perf();
  else await shots();
} finally {
  await browser.close();
  await server.close();
}
