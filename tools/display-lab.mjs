// Display-layer lab (design/display-layer.md): comparison pictures and render cost of
// the trail shades and head halos, in headless Chrome.
//
//   node tools/display-lab.mjs shots [outDir]     comparison sheets (phone at true device-pixel scale)
//   node tools/display-lab.mjs perf [outDir]      ms per render() and frame pacing for each candidate
//   node tools/display-lab.mjs perf-sw [outDir]   the same with Canvas 2D rasterised on the CPU
//   node tools/display-lab.mjs check              on-screen switches, auto per screen, cost of a full re-derive
//   node tools/display-lab.mjs identity           shade=off draws every level exactly like its image
//
// Requires Google Chrome. Starts its own dev server on a free port.

import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';

const SHADES = ['off', 'thin', 'bold', 'wide'];
const HEADS = ['ring', 'soft', 'wide'];
const DEVICES = {
  // An iPhone in landscape: the arena is 390 CSS px tall for 600 logical px
  phone: { viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  retina: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
};
// Where the 76×40 test card goes on each level: next to a wall, clear of the start positions
const CARD = { bricks: [150, 238], blueprint: [196, 102], paper: [170, 208] };

const mode = process.argv[2] ?? 'shots';
const outDir = process.argv[3] ?? 'design/research/display-shading';

const server = await createServer({ server: { port: 0, strictPort: false, https: false, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}${server.config.base}`;
// perf-sw: Canvas 2D rasterised on the CPU, as on a device without GPU canvas acceleration
// and render() made to wait for it (a 1×1 read-back), so that its time is the whole cost
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

// Stop the simulation (the ticker sees no time passing; needs `worker=0`) while the
// picture can still be redrawn
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
/** Page rectangle (CSS px) showing the logical rectangle (x, y, w, h) of the arena. */
async function clipOf(page, x, y, w, h) {
  const box = await contentBox(page);
  const k = box.height / 600;
  return { x: box.x + x * k, y: box.y + y * k, width: w * k, height: h * k };
}

/**
 * A labelled sheet of pictures. `zoom` is CSS px per image pixel on the sheet, which is
 * captured at DPR 1: zoom 1 = every image pixel is one sheet pixel (a phone screenshot is
 * then shown device pixel for device pixel), zoom 4 = enlarged without smoothing,
 * zoom < 1 = reduced with smoothing.
 */
async function sheet(file, title, notes, rows) {
  // rows: [{ label, zoom, cells: [{ label, png }] }]
  const page = await browser.newPage({ viewport: { width: 300, height: 300 }, deviceScaleFactor: 1 });
  const html = rows.map(row => `
    <div class="row-label">${row.label}</div>
    <div class="row">${row.cells.map(c => `<figure>
      <img src="data:image/png;base64,${c.png.toString('base64')}" data-zoom="${row.zoom}" style="image-rendering:${row.zoom > 1 ? 'pixelated' : 'auto'}">
      <figcaption>${c.label}</figcaption></figure>`).join('')}</div>`).join('');
  await page.setContent(`<body style="margin:0;background:#1c1c1c;color:#ddd;font:13px monospace">
    <div id="sheet" style="display:inline-block;padding:12px">
      <div style="font-size:15px;color:#fff">${title}</div>
      <div style="margin:4px 0 4px;color:#999;max-width:1500px">${notes}</div>
      ${html}
    </div>
    <style>figure{margin:0} .row{display:flex;gap:10px;align-items:flex-start} .row-label{margin:12px 0 4px;color:#0cc}
      img{display:block} figcaption{padding:3px 0;text-align:center;color:#bbb}</style>
  </body>`);
  await page.evaluate(async () => {
    for (const img of document.images) {
      await img.decode();
      img.style.width = `${img.naturalWidth * Number(img.dataset.zoom)}px`;
    }
  });
  await page.locator('#sheet').screenshot({ path: file });
  await page.close();
  console.log(`  ${file}`);
}

async function shots() {
  mkdirSync(outDir, { recursive: true });
  for (const level of Object.keys(CARD)) {
    for (const device of Object.keys(DEVICES)) {
      // A live game a few seconds in, frozen; plus the test card (display only)
      const page = await startGame(device, level, { query: 'worker=0' });
      await sleep(3500);
      await freeze(page);
      const [ox, oy] = CARD[level];
      await page.evaluate(([x, y]) => window.__teratronDisplay.testCard(x, y), [ox, oy]);
      const box = await contentBox(page);
      const dpr = DEVICES[device].deviceScaleFactor;
      const devicePerLogical = box.height / 600 * dpr;
      const where = `${level} · ${device}: arena ${Math.round(box.height)} CSS px tall at DPR ${dpr} = ${devicePerLogical.toFixed(2)} device px per logical px`;
      console.log(where);
      const card = await clipOf(page, ox - 4, oy - 4, 84, 48);
      const trails = await clipOf(page, ox - 2, oy + 1, 46, 14);
      const gaps = await clipOf(page, ox + 44, oy, 34, 32);

      const full = [];
      const cardShots = [];
      const trailShots = [];
      const gapShots = [];
      for (const shade of SHADES) {
        await setDisplay(page, `shade=${shade}&head=auto&fx=tracer,boost`);
        const label = `shade=${shade}`;
        full.push({ label, png: await page.screenshot({ clip: box }) });
        cardShots.push({ label, png: await page.screenshot({ clip: card }) });
        trailShots.push({ label, png: await page.screenshot({ clip: trails }) });
        gapShots.push({ label, png: await page.screenshot({ clip: gaps }) });
      }
      const headShots = [];
      const heads = await clipOf(page, ox + 30, oy + 2, 48, 38);
      for (const head of HEADS) {
        await setDisplay(page, `shade=bold&head=${head}&fx=tracer,boost`);
        headShots.push({ label: `head=${head} (shade=bold)`, png: await page.screenshot({ clip: heads }) });
      }
      const fxShots = [];
      for (const fx of ['', 'boost', 'tracer', 'tracer,boost,shadow']) {
        await setDisplay(page, `shade=bold&head=auto&fx=${fx}`);
        fxShots.push({ label: `fx=${fx || '(none)'} (shade=bold)`, png: await page.screenshot({ clip: card }) });
      }

      if (device === 'phone') {
        // The honest one: the whole screen about as big as it is in the hand. A phone
        // CSS pixel is 1/153 inch; on a 110 ppi monitor that is 0.72 monitor pixels.
        await sheet(`${outDir}/phone-whole-${level}.png`, where,
          'Whole screen reduced to the size it has in the hand when this picture is viewed at 100 % on a ~110 ppi monitor (hold the phone next to it to check). The test card is the small cluster left of centre.',
          [
            { label: 'physical size (0.24 monitor px per device px)', zoom: 0.72 / dpr, cells: full.slice(0, 2) },
            { label: '', zoom: 0.72 / dpr, cells: full.slice(2) },
          ]);
        await sheet(`${outDir}/phone-device-pixels-${level}.png`, where,
          'First row: one picture pixel = one device pixel of the phone, nothing enlarged — about 4× the physical size on a 110 ppi monitor. Second row: the same enlarged 4× to see what the pixels are. The card: six player colours (red and green one free pixel apart), a crossing, an erased hole; right, pairs of green trails with 1, 2 and 3 free pixels between them, a lone head, two tracers.',
          [
            { label: 'device pixels 1:1', zoom: 1, cells: cardShots },
            { label: 'enlarged 4×', zoom: 4, cells: cardShots },
          ]);
        await sheet(`${outDir}/phone-gaps-${level}.png`, where,
          'Pairs of trails with 1, 2 and 3 free (drivable) pixels between them, top to bottom. Is a gap still seen as a gap?',
          [
            { label: 'device pixels 1:1', zoom: 1, cells: gapShots },
            { label: 'enlarged 6×', zoom: 6, cells: gapShots },
          ]);
        await sheet(`${outDir}/phone-heads-${level}.png`, where,
          'Heads: a solid white pixel with a white, transparent halo (dark on a light level). The lone head and the two tracers (white pixel with a streak behind) are bottom right.',
          [
            { label: 'device pixels 1:1', zoom: 1, cells: headShots },
            { label: 'enlarged 6×', zoom: 6, cells: headShots },
          ]);
        await sheet(`${outDir}/phone-fx-${level}.png`, where,
          'Extras with shade=bold. boost lightens blue and purple (third and fifth trail).',
          [
            { label: 'device pixels 1:1', zoom: 1, cells: fxShots },
            { label: 'enlarged 4×', zoom: 4, cells: fxShots },
          ]);
      } else {
        await sheet(`${outDir}/${device}-${level}.png`, where,
          'First row: screen pixels 1:1. Second row: the left part of the card enlarged 6×. Third row: heads, enlarged 6×.',
          [
            { label: 'screen pixels 1:1', zoom: 1, cells: cardShots },
            { label: 'trails, enlarged 6×', zoom: 6, cells: trailShots },
            { label: 'heads, enlarged 6×', zoom: 6, cells: headShots },
          ]);
      }
      await page.context().close();
    }
  }
  // The level with doors, with the default settings (sprites drawn under a transform)
  const page = await startGame('phone', 'portals', { query: 'worker=0&displaydebug=1' });
  await sleep(3000);
  await page.screenshot({ path: `${outDir}/phone-portals-default-with-chips.png` });
  await page.context().close();
}

async function perf() {
  const rows = [];
  const suffix = software ? ', software canvas' : '';
  const specs = [
    ...SHADES.map(s => `shade=${s}&head=ring&fx=`),
    'shade=bold&head=soft&fx=',
    'shade=bold&head=wide&fx=',
    'shade=bold&head=soft&fx=tracer,boost',
    'shade=wide&head=wide&fx=tracer,boost,shadow,fade',
  ];
  for (const [label, device, throttle] of [['desktop' + suffix, 'desktop', 1], ['phone ×6 CPU throttle' + suffix, 'phone', 6]]) {
    for (const level of ['bricks', 'blueprint']) {
      for (const spec of specs) {
        const page = await startGame(device, level, { query: spec, bots: 'ai-easy', throttle });
        await page.evaluate((sync) => {
          // Frame pacing next to the time spent inside render()
          const w = window;
          w.__frames = [];
          let last = performance.now();
          const tick = (t) => { w.__frames.push(t - last); last = t; requestAnimationFrame(tick); };
          requestAnimationFrame(tick);
          w.__teratronDisplay.sync(sync);
          w.__teratronDisplay.resetPerf();
        }, software);
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
        console.log(`${label.padEnd(38)} ${level.padEnd(10)} ${spec.padEnd(50)} render avg ${result.render.avg.toFixed(3)} p95 ${result.render.p95.toFixed(3)} max ${result.render.max.toFixed(2)} ms | frame avg ${result.frameAvg.toFixed(1)} p95 ${result.frameP95.toFixed(1)} ms, ${(result.slowFrames * 100).toFixed(1)}% > 25 ms | full re-derive ${result.rederive.toFixed(1)} ms`);
        await page.context().close();
      }
    }
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/${mode}.json`, JSON.stringify(rows, null, 2));
}

// With shade=off the level layer must be, pixel for pixel, the level image over black
// (what the renderer drew before the display layer existed)
async function identity() {
  let bad = 0;
  for (const level of ['blank', 'pop-culture', 'selva', 'bricks', 'bus', 'dentistry', 'warzone', 'portals', 'blueprint', 'paper']) {
    const context = await browser.newContext(DEVICES.desktop);
    const page = await context.newPage();
    await page.addInitScript((levelMode) => {
      localStorage.setItem('teratron-local-setup', JSON.stringify({ slots: ['human', 'ai-easy', 'off', 'off'], gameMode: 'ffa', levelMode }));
    }, level);
    await page.goto(baseUrl + '?shade=off&fx=');
    await page.click('#localGameBtn');
    await page.click('#startBtn');
    await page.waitForFunction(() => window.__teratron?.view()?.round.phase === 'countdown' && window.__teratronDisplay, null, { timeout: 30000 });
    await sleep(1500);   // Level image loaded, still in the countdown: nothing damaged yet
    const result = await page.evaluate(async (file) => {
      const image = new Image();
      image.src = `${document.baseURI.split('?')[0]}assets/levels/${file}.png`;
      await image.decode();
      const draw = (source) => {
        const canvas = document.createElement('canvas');
        canvas.width = 750;
        canvas.height = 600;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, 750, 600);
        ctx.drawImage(source, 0, 0, 750, 600);
        return ctx.getImageData(0, 0, 750, 600).data;
      };
      const a = draw(image);
      const b = draw(window.__teratronDisplay.layers().level);
      let different = 0;
      let walls = 0;
      for (let i = 0; i < a.length; i += 4) {
        if (a[i] || a[i + 1] || a[i + 2]) walls++;
        if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) different++;
      }
      return { different, walls };
    }, level);
    console.log(`${result.different === 0 ? '  ok ' : 'FAIL '} ${level}: ${result.walls} wall pixels, ${result.different} pixels differ from the level image`);
    if (result.different) bad++;
    await context.close();
  }
  if (bad) process.exitCode = 1;
}

// The on-screen switches (`?displaydebug=1`) work by touch, `auto` follows the screen,
// and what a full re-derivation costs mid-round
async function check() {
  let bad = 0;
  const ok = (name, pass, detail = '') => {
    console.log(`${pass ? '  ok ' : 'FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!pass) bad++;
  };
  const get = (page) => page.evaluate(() => window.__teratronDisplay.get());
  const phone = await startGame('phone', 'bricks', { query: 'displaydebug=1' });
  ok('phone: default is auto / auto / tracer,boost', await get(phone) === 'shade=auto&head=auto&fx=tracer,boost', await get(phone));
  ok('phone: auto stands for bold and soft', (await phone.textContent('[data-display=shade]')).includes('auto→bold')
    && (await phone.textContent('[data-display=head]')).includes('auto→soft'));
  ok('phone: 1× backing store', await phone.evaluate(() => document.querySelector('#gameCanvas canvas').width) === 800);
  const ready = () => phone.evaluate(() => window.__teratron.view().match.playersReady.length);
  const before = await ready();
  await phone.tap('[data-display=shade]');
  ok('phone: tapping the trail chip cycles the shade', (await get(phone)).startsWith('shade=off'), await get(phone));
  await phone.tap('[data-display=shade]');
  ok('phone: thin switches to a 2× backing store', (await get(phone)).startsWith('shade=thin')
    && await phone.evaluate(() => document.querySelector('#gameCanvas canvas').width) === 1600);
  await phone.tap('[data-display=head]');
  await phone.tap('[data-display=fx]');
  ok('phone: head and fx chips cycle too', await get(phone) === 'shade=thin&head=ring&fx=', await get(phone));
  ok('phone: the choice is remembered', await phone.evaluate(() => localStorage.getItem('teratron-display')) === await get(phone));
  ok('phone: taps on the chips do not reach the game', await ready() === before);
  await phone.context().close();

  const desktop = await startGame('desktop', 'bricks', { query: 'displaydebug=1' });
  ok('desktop: auto stands for thin and ring', (await desktop.textContent('[data-display=shade]')).includes('auto→thin')
    && (await desktop.textContent('[data-display=head]')).includes('auto→ring'));
  await desktop.keyboard.press('Digit1');
  ok('desktop: key 1 cycles the shade', (await get(desktop)).startsWith('shade=off'));
  await desktop.evaluate(() => window.__teratronDisplay.set('shade=auto'));
  await desktop.setViewportSize({ width: 700, height: 500 });
  await desktop.waitForFunction(() => document.querySelector('[data-display=shade]').textContent.includes('auto→bold'), null, { timeout: 5000 })
    .then(() => ok('desktop: a small window turns auto into bold', true), () => ok('desktop: a small window turns auto into bold', false));
  await desktop.context().close();

  for (const [label, device, throttle] of [['desktop', 'desktop', 1], ['phone ×6', 'phone', 6]]) {
    const page = await startGame(device, 'bricks', { bots: 'ai-easy', throttle });
    await sleep(6000);
    const times = [];
    for (const shade of SHADES) {
      await page.evaluate((s) => window.__teratronDisplay.set(`shade=${s}`), shade);
      const ms = await page.evaluate(() => [0, 0, 0].map(() => window.__teratronDisplay.rederive()).sort((a, b) => a - b)[1]);
      times.push(`${shade} ${ms.toFixed(0)} ms`);
    }
    console.log(`  full re-derive mid-round, ${label}: ${times.join(', ')}`);
    await page.context().close();
  }
  if (bad) process.exitCode = 1;
}

try {
  if (mode === 'identity') await identity();
  else if (mode === 'check') await check();
  else if (mode === 'perf' || mode === 'perf-sw') await perf();
  else await shots();
} finally {
  await browser.close();
  await server.close();
}
