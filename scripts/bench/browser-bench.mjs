// In-browser frame cost of the real game: production build, headless Chrome driven by
// playwright-core, phase timers of src/game/perf.ts (`?perf=1`), a Chrome trace for GC
// pauses and per-thread CPU time. See design/research/performance.md.
//
//   npm run bench:browser                            all scenarios × all profiles
//   npm run bench:browser -- --only=hard4            scenarios whose name contains "hard4"
//   npm run bench:browser -- --profiles=desktop,mobile-6x
//   npm run bench:browser -- --seconds=30 --json=out.json
//   npm run bench:browser -- --query=worker=1        extra URL parameters. The default is
//                                                    worker=0 (simulation on the page's thread,
//                                                    which the injected scenes need)
//   npm run bench:browser -- --headed                a visible window (real GPU compositing)
//   npm run bench:browser -- --hz=120                display frames from a 120 Hz timer instead
//                                                    of the (60 Hz) headless compositor
//
// The "mobile" profiles are EMULATION: a phone-sized viewport and device pixel ratio plus
// Chrome's CPU throttling of the page's main thread. The GPU, the GPU process, memory
// bandwidth and thermal throttling of a real phone are not emulated.

/* global navigator, performance */
import { chromium } from 'playwright-core';
import { build, preview } from 'vite';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

const args = new Map(process.argv.slice(2).map(a => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.length ? v.join('=') : '1'];
}));
const seconds = Number(args.get('seconds') ?? 20);
const warmupSeconds = Number(args.get('warmup') ?? 6);
const only = args.get('only');
const extraQuery = args.get('query') ?? 'worker=0';

const PROFILES = {
  'desktop': { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, mobile: false, throttle: 1 },
  // Mid-range phone, landscape
  'mobile-4x': { viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, mobile: true, throttle: 4 },
  // Low-end phone, landscape
  'mobile-6x': { viewport: { width: 740, height: 360 }, deviceScaleFactor: 2, mobile: true, throttle: 6 },
};

// A scene script runs inside the page before every simulation tick
const keepAlive = `
  game.players.forEach((p, i) => {
    if (!p.alive) { p.alive = true; p.prevScreenX = -1; p.prevScreenY = -1; }
    p.direction = 0;
    p.y = (80 + i * 140) * 1000 + 500;
  });
  game.items.length = 0;`;

const SCENARIOS = [
  { name: 'easy2-blank', slots: ['ai-easy', 'ai-easy', 'off', 'off'], level: 'blank' },
  { name: 'hard4-cycle', slots: ['ai-hard', 'ai-hard', 'ai-hard', 'ai-hard'], level: 'cycle' },
  { name: 'hard4-portals', slots: ['ai-hard', 'ai-hard', 'ai-hard', 'ai-hard'], level: 'portals' },
  {
    name: 'heavy-uzi', slots: ['human', 'human', 'human', 'human'], level: 'bricks',
    scene: `${keepAlive}
      for (const p of game.players) { p.equipWeapon('uzi', undefined, 1000); inputs.set(p.slotIndex, { steer: 0, action: true }); }`,
  },
  {
    name: 'heavy-hbombs', slots: ['human', 'human', 'human', 'human'], level: 'bricks',
    scene: `${keepAlive}
      for (const p of game.players) {
        p.equipWeapon('bomb', 50);
        inputs.set(p.slotIndex, { steer: 0, action: (tick + p.slotIndex * 7) % 30 < 2 });
      }`,
  },
];

function stats(values) {
  if (!values || values.length === 0) return { n: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = Float64Array.from(values).sort();
  const q = p => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  let sum = 0;
  for (const v of sorted) sum += v;
  return { n: sorted.length, mean: sum / sorted.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: sorted[sorted.length - 1] };
}

// GC pauses and CPU time per thread from a Chrome trace
function analyseTrace(buffer, wallMs) {
  let events;
  try {
    const parsed = JSON.parse(buffer.toString('utf8'));
    events = Array.isArray(parsed) ? parsed : parsed.traceEvents;
  } catch {
    return null;
  }
  const threadNames = new Map();
  for (const e of events) {
    if (e.ph === 'M' && e.name === 'thread_name') threadNames.set(`${e.pid}:${e.tid}`, e.args?.name);
  }
  const gc = { minor: 0, major: 0, totalMs: 0, maxMs: 0 };
  const busy = new Map();
  for (const e of events) {
    if (e.ph !== 'X' || typeof e.dur !== 'number') continue;
    if (e.name === 'MinorGC' || e.name === 'MajorGC') {
      if (threadNames.get(`${e.pid}:${e.tid}`) !== 'CrRendererMain') continue;
      if (e.name === 'MinorGC') gc.minor++; else gc.major++;
      gc.totalMs += e.dur / 1000;
      gc.maxMs = Math.max(gc.maxMs, e.dur / 1000);
    }
    // Top-level tasks: how busy each thread was
    if (e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask') {
      const name = threadNames.get(`${e.pid}:${e.tid}`) ?? 'other';
      busy.set(name, (busy.get(name) ?? 0) + e.dur / 1000);
    }
  }
  const pct = name => +(100 * (busy.get(name) ?? 0) / wallMs).toFixed(1);
  return {
    gc,
    // Share of wall-clock time each thread spent running tasks (the main thread's is
    // inflated by CPU throttling, the others are not throttled the same way)
    busyPct: { rendererMain: pct('CrRendererMain'), gpuMain: pct('CrGpuMain'), compositor: pct('Compositor') },
  };
}

function bundleSize(dir) {
  const out = [];
  const walk = d => {
    for (const f of readdirSync(d)) {
      const p = path.join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(js|css|html|wasm)$/.test(f)) {
        const data = readFileSync(p);
        out.push({ file: path.relative(dir, p), bytes: data.length, gzip: gzipSync(data).length });
      }
    }
  };
  walk(dir);
  return out;
}

const outDir = 'node_modules/.bench/dist';
await build({ logLevel: 'warn', build: { outDir, emptyOutDir: true } });
const server = await preview({ logLevel: 'error', build: { outDir }, preview: { port: 0, host: '127.0.0.1', strictPort: false, https: false } });
const address = server.httpServer.address();
const baseUrl = `http://127.0.0.1:${address.port}${server.config.base}`;
const bundle = bundleSize(outDir);

const browser = await chromium.launch({ channel: 'chrome', headless: !args.has('headed') });
const profileNames = (args.get('profiles') ?? Object.keys(PROFILES).join(',')).split(',');
const results = [];
let gpuInfo = null;

try {
  for (const profileName of profileNames) {
    const profile = PROFILES[profileName];
    if (!profile) throw new Error(`unknown profile ${profileName}`);
    for (const scenario of SCENARIOS) {
      if (only && !scenario.name.includes(only)) continue;
      const context = await browser.newContext({
        viewport: profile.viewport, deviceScaleFactor: profile.deviceScaleFactor,
        hasTouch: profile.mobile, isMobile: profile.mobile,
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.addInitScript(({ slots, level }) => {
        localStorage.setItem('teratron-local-setup', JSON.stringify({ slots, gameMode: 'ffa', levelMode: level }));
        localStorage.setItem('teratron-touch-mode', 'buttons');
      }, scenario);
      if (args.has('hz')) {
        // A stand-in for a fast screen: animation frames from a timer
        await page.addInitScript((hz) => {
          let callbacks = [];
          window.requestAnimationFrame = (cb) => { callbacks.push(cb); return callbacks.length; };
          window.cancelAnimationFrame = () => { callbacks = []; };
          const interval = 1000 / hz;
          let next = performance.now() + interval;
          const tick = () => {
            const now = performance.now();
            if (now >= next) {
              next += interval * Math.max(1, Math.floor((now - next) / interval) + 1);
              const run = callbacks;
              callbacks = [];
              for (const cb of run) cb(now);
            }
            setTimeout(tick, Math.max(0, next - performance.now()));
          };
          setTimeout(tick, interval);
        }, Number(args.get('hz')));
      }
      await page.goto(`${baseUrl}?perf=1${extraQuery ? `&${extraQuery}` : ''}`);
      const press = sel => (profile.mobile ? page.tap(sel) : page.click(sel));
      await press('#localGameBtn');
      await press('#startBtn');
      await page.waitForFunction(() => window.__teratron?.perf && window.__teratron.view());

      if (!gpuInfo) {
        gpuInfo = await page.evaluate(() => {
          const gl = document.createElement('canvas').getContext('webgl2');
          const ext = gl?.getExtension('WEBGL_debug_renderer_info');
          return { webglRenderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : String(gl), userAgent: navigator.userAgent };
        });
      }

      if (scenario.scene) {
        await page.evaluate((source) => {
          const session = window.__teratron.session;
          const game = session.game;
          const scene = new Function('game', 'tick', 'inputs', source);
          const step = session.step.bind(session);
          const inputs = new Map();
          let tick = 0;
          session.step = () => {
            if (game.phase === 'playing') scene(game, tick++, inputs);
            step(inputs);
          };
        }, scenario.scene);
      }

      const cdp = await context.newCDPSession(page);
      if (profile.throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.throttle });
      await page.waitForTimeout(warmupSeconds * 1000);

      await browser.startTracing(page, { categories: ['devtools.timeline', 'toplevel', 'v8', 'gpu'] });
      await page.evaluate(async () => {
        window.__teratron.perf(true);
        await window.__teratron.session.workerPerf?.();
      });
      const started = Date.now();
      await page.waitForTimeout(seconds * 1000);
      const dump = await page.evaluate(async () => {
        const main = window.__teratron.perf(true);
        // `?worker=1`: the simulation's own timings come from the worker
        const worker = await window.__teratron.session.workerPerf?.();
        if (worker) {
          for (const [phase, values] of Object.entries(worker.samples)) main.samples[`worker.${phase}`] = values;
          main.counters.ticks = worker.counters.ticks ?? 0;
          main.counters.droppedTicks = worker.counters.droppedTicks ?? 0;
        }
        return main;
      });
      const wallMs = Date.now() - started;
      const trace = analyseTrace(await browser.stopTracing(), wallMs);
      const memory = await page.evaluate(() => performance.memory ? { usedMB: performance.memory.usedJSHeapSize / 1048576, totalMB: performance.memory.totalJSHeapSize / 1048576 } : null);

      const phases = {};
      for (const [phase, values] of Object.entries(dump.samples)) phases[phase] = stats(values);
      const gaps = dump.samples.rafGap ?? [];
      const expectedTicks = wallMs * 70 / 1000;
      const result = {
        profile: profileName, scenario: scenario.name, seconds: wallMs / 1000,
        phases,
        fps: gaps.length / (wallMs / 1000),
        // How often the canvas was actually redrawn, and what all of it cost
        rendersPerSecond: (dump.samples.render?.length ?? 0) / (wallMs / 1000),
        frameMsPerSecond: (dump.samples.frame ?? []).reduce((a, b) => a + b, 0) / (wallMs / 1000),
        // Display frames that took longer than 1.5 / 2.5 refresh intervals (60 Hz)
        slowFrames: gaps.filter(g => g > 25).length,
        verySlowFrames: gaps.filter(g => g > 41.7).length,
        ticks: dump.counters.ticks ?? 0,
        ticksPerSecond: (dump.counters.ticks ?? 0) / (wallMs / 1000),
        droppedTicks: dump.counters.droppedTicks ?? 0,
        missingTicks: Math.max(0, Math.round(expectedTicks - (dump.counters.ticks ?? 0))),
        trace, memory, errors,
      };
      results.push(result);
      const f = ms => ms.toFixed(2).padStart(6);
      const row = (name) => {
        const s = phases[name];
        return s ? `${name} ${f(s.mean)}/${f(s.p50)}/${f(s.p95)}/${f(s.p99)}/${f(s.max)}` : '';
      };
      console.log(`\n[${profileName}] ${scenario.name}: ${result.fps.toFixed(1)} fps, ${result.ticksPerSecond.toFixed(1)} ticks/s, dropped ticks ${result.droppedTicks}, slow frames ${result.slowFrames} (very slow ${result.verySlowFrames}) of ${gaps.length}`);
      console.log(`  ${result.rendersPerSecond.toFixed(1)} redraws/s; ${result.frameMsPerSecond.toFixed(1)} ms of main thread per second in animation frames`);
      console.log('  ms mean/p50/p95/p99/max');
      for (const name of ['frame', 'rafGap', 'step', 'bots', 'sim', 'serialize', 'events', 'render', 'workerLag', 'worker.step', 'worker.bots', 'worker.sim']) {
        const line = row(name);
        if (line) console.log(`  ${line}`);
      }
      if (trace) console.log(`  gc: ${trace.gc.minor} minor + ${trace.gc.major} major, ${trace.gc.totalMs.toFixed(1)} ms total, max ${trace.gc.maxMs.toFixed(2)} ms; busy: main ${trace.busyPct.rendererMain}% gpu ${trace.busyPct.gpuMain}% compositor ${trace.busyPct.compositor}%`);
      if (memory) console.log(`  JS heap ${memory.usedMB.toFixed(1)} MB used / ${memory.totalMB.toFixed(1)} MB`);
      if (errors.length) console.log('  page errors:', errors.slice(0, 3));
      await context.close();
    }
  }
} finally {
  await browser.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}

console.log('\nBundle:');
for (const f of bundle) console.log(`  ${f.file.padEnd(40)} ${(f.bytes / 1024).toFixed(1).padStart(8)} kB  gzip ${(f.gzip / 1024).toFixed(1).padStart(7)} kB`);
console.log(`GPU: ${gpuInfo?.webglRenderer}`);
if (args.has('json')) {
  writeFileSync(args.get('json'), JSON.stringify({ gpuInfo, bundle, seconds, results }, null, 2));
}
process.exit(0);
