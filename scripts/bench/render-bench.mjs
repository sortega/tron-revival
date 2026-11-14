// Renderer alternatives on the same synthetic scenes (scripts/bench/pages/render-bench.ts):
// main-thread time per frame, frame pacing, and how busy the GPU process was.
//
//   npm run bench:render
//   npm run bench:render -- --variants=c2d,webgl --scenes=heavy --profiles=mobile-6x
//   npm run bench:render -- --headed          (a visible window)
//   npm run bench:render -- --shots=/some/dir (a screenshot of the last frame of each run)
//
// "mobile" profiles are emulation (viewport, device pixel ratio, CPU throttling of the
// page's main thread); the GPU is this machine's. See design/research/performance.md.

import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { writeFileSync } from 'node:fs';

const args = new Map(process.argv.slice(2).map(a => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.length ? v.join('=') : '1'];
}));
const list = (name, all) => (args.get(name) ?? all).split(',');
const variants = list('variants', 'c2d,imagedata,webgl');
const scenes = list('scenes', 'typical,heavy,tint');
const profileNames = list('profiles', 'desktop,mobile-4x,mobile-6x');
const frames = Number(args.get('frames') ?? 600);

const PROFILES = {
  'desktop': { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, mobile: false, throttle: 1 },
  'mobile-4x': { viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, mobile: true, throttle: 4 },
  'mobile-6x': { viewport: { width: 740, height: 360 }, deviceScaleFactor: 2, mobile: true, throttle: 6 },
};

function busy(buffer, wallMs) {
  let events;
  try {
    const parsed = JSON.parse(buffer.toString('utf8'));
    events = Array.isArray(parsed) ? parsed : parsed.traceEvents;
  } catch {
    return null;
  }
  const names = new Map();
  for (const e of events) if (e.ph === 'M' && e.name === 'thread_name') names.set(`${e.pid}:${e.tid}`, e.args?.name);
  const total = new Map();
  for (const e of events) {
    if (e.ph !== 'X' || typeof e.dur !== 'number') continue;
    if (e.name !== 'RunTask' && e.name !== 'ThreadControllerImpl::RunTask') continue;
    const name = names.get(`${e.pid}:${e.tid}`) ?? 'other';
    total.set(name, (total.get(name) ?? 0) + e.dur / 1000);
  }
  const pct = name => +(100 * (total.get(name) ?? 0) / wallMs).toFixed(1);
  return { rendererMain: pct('CrRendererMain'), gpuMain: pct('CrGpuMain'), compositor: pct('Compositor') };
}

const server = await createServer({ server: { port: 0, strictPort: false, https: false, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}${server.config.base}scripts/bench/pages/render-bench.html`;
const browser = await chromium.launch({ channel: 'chrome', headless: !args.has('headed') });
const results = [];

try {
  console.log('profile     scene    variant     apply+draw ms mean / p95 / max     rAF gap p95   slow frames   busy % main / gpu');
  for (const profileName of profileNames) {
    const profile = PROFILES[profileName];
    for (const scene of scenes) {
      for (const variant of variants) {
        // Headless Chrome now and then stops delivering animation frames to a fresh page:
        // try again rather than lose the whole run
        for (let attempt = 1; attempt <= 3; attempt++) {
          let context = null;
          try {
            context = await browser.newContext({
              viewport: profile.viewport, deviceScaleFactor: profile.deviceScaleFactor,
              hasTouch: profile.mobile, isMobile: profile.mobile,
            });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', e => errors.push(e.message));
            await page.goto(`${baseUrl}?variant=${variant}&scene=${scene}&frames=${frames}`);
            await page.waitForFunction(() => window.__ready, null, { timeout: 30000 });
            const cdp = await context.newCDPSession(page);
            if (profile.throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.throttle });
            await browser.startTracing(page, { categories: ['toplevel'] });
            const started = Date.now();
            await page.evaluate(() => { window.__go = true; });
            await page.waitForFunction(() => window.__result, null, { timeout: 20000 + frames * 100 });
            const wallMs = Date.now() - started;
            const cpu = busy(await browser.stopTracing(), wallMs);
            const result = await page.evaluate(() => window.__result);
            if (args.has('shots')) await page.screenshot({ path: `${args.get('shots')}/render-${profileName}-${scene}-${variant}.png` });
            results.push({ profile: profileName, ...result, busyPct: cpu, errors });
            const t = result.total;
            console.log(`${profileName.padEnd(11)} ${scene.padEnd(8)} ${variant.padEnd(10)} ${t.mean.toFixed(2).padStart(7)} / ${t.p95.toFixed(2).padStart(6)} / ${t.max.toFixed(2).padStart(6)}` +
              `          ${result.rafGap.p95.toFixed(1).padStart(6)}   ${String(result.slowFrames).padStart(6)}        ${cpu ? `${cpu.rendererMain} / ${cpu.gpuMain}` : '?'}` +
              (result.canvasHash ? `   pixels ${result.canvasHash}` : '') + (errors.length ? `   ERRORS: ${errors[0]}` : ''));
            break;
          } catch (err) {
            await browser.stopTracing().catch(() => {});
            console.log(`${profileName.padEnd(11)} ${scene.padEnd(8)} ${variant.padEnd(10)} attempt ${attempt} failed: ${String(err).split('\n')[0]}`);
          } finally {
            await context?.close();
          }
        }
      }
    }
  }
} finally {
  await browser.close();
  await server.close();
}
if (args.has('json')) writeFileSync(args.get('json'), JSON.stringify(results, null, 2));
process.exit(0);
