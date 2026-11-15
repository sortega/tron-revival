// `npm run bots:trace`: plays the same seeded situations with the old bots (planner
// alone) and the human-like ones and writes a page of pictures to compare them:
// out/bot-trace.html. See design/bots-human.md. Not part of the regular test run.

import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { PixelGrid } from '../src/game/PixelGrid';
import { createRng } from '../src/game/rng';
import { TronGameState } from '../src/game/TronGameState';
import { PLAY_HEIGHT, PLAY_WIDTH, TICK_RATE } from '../src/game/constants';
import type { SlotIndex } from '../src/types/lobby';
import type { BotDifficulty, TronInput } from '../src/types/game';
import { loadLevelGrid, makePlayers, skipCountdown } from './helpers';
import { makeDriver } from './sim';
import type { DriverSpec } from './sim';

interface Sample { x: number; y: number; dir: number; key: number; alive: boolean }

interface Recording {
  tracks: Sample[][];       // Per player, per tick
  obstacles: PixelGrid;
}

/** Play one round and record every tick. `during` can meddle with the game. */
function record(level: string, drivers: DriverSpec[], seed: number, ticks: number,
  during?: (game: TronGameState, tick: number) => void): Recording {
  const game = new TronGameState(makePlayers(drivers.length), 'ffa', level, createRng(seed));
  const obstacles = level === 'blank' ? new PixelGrid() : loadLevelGrid(level);
  game.setLevelObstacles(obstacles);
  const bots = drivers.map((spec, i) => makeDriver(spec, i as SlotIndex, createRng(seed * 1000 + i)));
  skipCountdown(game);
  const tracks: Sample[][] = drivers.map(() => []);
  const inputs = new Map<SlotIndex, TronInput>();
  for (let tick = 0; tick < ticks && game.phase === 'playing'; tick++) {
    during?.(game, tick);
    bots.forEach((bot, i) => {
      const input = bot.decide(game);
      inputs.set(i as SlotIndex, input);
      const p = game.players[i]!;
      tracks[i]!.push({ x: p.x / 1000, y: p.y / 1000, dir: p.direction, key: input.steer, alive: p.alive });
    });
    game.tick(inputs);
    game.serialize();
  }
  return { tracks, obstacles };
}

// --- Drawing (plain SVG; colours come from CSS variables so that dark mode works)

const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)'];

/** A trail as SVG path data, broken where the player wraps around or teleports. */
function trailPath(track: Sample[], from = 0, to = track.length): string {
  let d = '';
  let prev: Sample | null = null;
  for (let i = from; i < to && i < track.length; i++) {
    const s = track[i]!;
    if (!s.alive) break;
    const jump = !prev || Math.abs(s.x - prev.x) > 10 || Math.abs(s.y - prev.y) > 10;
    d += `${jump ? 'M' : 'L'}${s.x.toFixed(1)} ${s.y.toFixed(1)}`;
    prev = s;
  }
  return d;
}

function obstaclePath(grid: PixelGrid): string {
  let d = '';
  grid.forEachRun((x, y, length) => {
    d += `M${x} ${y}h${length}v1h${-length}z`;
  });
  return d;
}

function lastAlive(track: Sample[]): Sample {
  let last = track[0]!;
  for (const s of track) if (s.alive) last = s;
  return last;
}

function arenaSvg(rec: Recording, labels: string[], title: string, firstColour = 0): string {
  const parts = [`<svg viewBox="0 0 ${PLAY_WIDTH} ${PLAY_HEIGHT}" role="img" aria-label="${title}">`,
    `<rect width="${PLAY_WIDTH}" height="${PLAY_HEIGHT}" class="arena"/>`,
    `<path d="${obstaclePath(rec.obstacles)}" class="wall"/>`];
  rec.tracks.forEach((track, k) => {
    const i = k + firstColour;
    const end = lastAlive(track);
    const lived = track.filter(s => s.alive).length;
    parts.push(`<path d="${trailPath(track)}" fill="none" stroke="${SERIES[i]}" stroke-width="2"><title>${labels[k]}: ${(lived / TICK_RATE).toFixed(1)} s</title></path>`);
    parts.push(`<circle cx="${end.x.toFixed(1)}" cy="${end.y.toFixed(1)}" r="5" fill="${SERIES[i]}" class="ring"/>`);
    const lx = Math.min(Math.max(end.x + 8, 4), PLAY_WIDTH - 110);
    const ly = Math.min(Math.max(end.y - 8, 14), PLAY_HEIGHT - 6);
    parts.push(`<text x="${lx.toFixed(0)}" y="${ly.toFixed(0)}" class="label">${labels[k]} ${lived < track.length ? `† ${(lived / TICK_RATE).toFixed(1)} s` : ''}</text>`);
  });
  parts.push('</svg>');
  return parts.join('');
}

/** Heading over time (unwrapped, degrees), one line per recording, with a shaded band. */
function headingSvg(series: { label: string; track: Sample[] }[], band: [number, number] | null, from: number, to: number): string {
  const W = 720;
  const H = 220;
  const L = 44;
  const R = 100;
  const T = 10;
  const B = 26;
  const unwrapped = series.map(s => {
    const out: number[] = [];
    let acc = 0;
    for (let i = from; i < to && i < s.track.length && s.track[i]!.alive; i++) {
      if (i > from) acc += ((s.track[i]!.dir - s.track[i - 1]!.dir + 540) % 360) - 180;
      out.push(acc);
    }
    return out;
  });
  const all = unwrapped.flat();
  const lo = Math.min(...all, -90);
  const hi = Math.max(...all, 90);
  const sx = (i: number): number => L + (i / (to - from)) * (W - L - R);
  const sy = (v: number): number => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const parts = [`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Heading over time">`];
  if (band) {
    parts.push(`<rect x="${sx(band[0] - from)}" y="${T}" width="${sx(band[1] - from) - sx(band[0] - from)}" height="${H - T - B}" class="band"/>`);
    parts.push(`<text x="${sx(band[0] - from) + 4}" y="${T + 12}" class="tick">controls reversed</text>`);
  }
  for (let v = Math.ceil(lo / 180) * 180; v <= hi; v += 180) {
    parts.push(`<line x1="${L}" x2="${W - R}" y1="${sy(v)}" y2="${sy(v)}" class="grid"/>`);
    parts.push(`<text x="${L - 6}" y="${sy(v) + 4}" text-anchor="end" class="tick">${v}°</text>`);
  }
  for (let s = 0; s <= (to - from) / TICK_RATE; s += 2) {
    parts.push(`<text x="${sx(s * TICK_RATE)}" y="${H - 8}" text-anchor="middle" class="tick">${s} s</text>`);
  }
  unwrapped.forEach((values, k) => {
    if (values.length === 0) return;
    const d = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${sx(i).toFixed(1)} ${sy(v).toFixed(1)}`).join('');
    const died = values.length < to - from;
    parts.push(`<path d="${d}" fill="none" stroke="${SERIES[k]}" stroke-width="2"><title>${series[k]!.label}</title></path>`);
    const ex = sx(values.length - 1);
    const ey = sy(values[values.length - 1]!);
    if (died) parts.push(`<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="4" fill="${SERIES[k]}" class="ring"/>`);
    parts.push(`<text x="${(ex + 7).toFixed(1)}" y="${(ey + 4 + (k === 0 ? -8 : 8)).toFixed(1)}" class="label">${series[k]!.label}${died ? ' †' : ''}</text>`);
  });
  parts.push('</svg>');
  return parts.join('');
}

/** Which key is down, tick by tick: one strip per recording. */
function keysSvg(series: { label: string; track: Sample[] }[], from: number, to: number): string {
  const W = 720;
  const ROW = 34;
  const L = 96;
  const R = 10;
  const H = series.length * ROW + 24;
  const sx = (i: number): number => L + (i / (to - from)) * (W - L - R);
  const parts = [`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Steering key over time">`];
  series.forEach((s, k) => {
    const mid = k * ROW + ROW / 2;
    parts.push(`<text x="${L - 8}" y="${mid + 4}" text-anchor="end" class="label">${s.label}</text>`);
    parts.push(`<line x1="${L}" x2="${W - R}" y1="${mid}" y2="${mid}" class="grid"/>`);
    let d = '';
    let presses = 0;
    for (let i = from; i < to && i < s.track.length && s.track[i]!.alive; i++) {
      const key = s.track[i]!.key;
      if (key === 0) continue;
      if (i === from || s.track[i - 1]!.key !== key) presses++;
      const y = key < 0 ? mid - 11 : mid + 1;
      d += `M${sx(i - from).toFixed(1)} ${y}h${Math.max(1, sx(1) - sx(0)).toFixed(2)}v10h-${Math.max(1, sx(1) - sx(0)).toFixed(2)}z`;
    }
    parts.push(`<path d="${d}" fill="${SERIES[k]}"><title>${s.label}: ${presses} presses (left above the line, right below)</title></path>`);
  });
  for (let s = 0; s <= (to - from) / TICK_RATE; s += 1) {
    parts.push(`<text x="${sx(s * TICK_RATE)}" y="${H - 6}" text-anchor="middle" class="tick">${s} s</text>`);
  }
  parts.push('</svg>');
  return parts.join('');
}

function legend(labels: string[]): string {
  return `<p class="legend">${labels.map((l, i) => `<span><i style="background:${SERIES[i]}"></i>${l}</span>`).join('')}</p>`;
}

const CSS = `
:root { --bg:#f9f9f7; --surface:#fcfcfb; --ink:#0b0b0b; --ink2:#52514e; --grid:#e3e2de; --wall:#b9b8b2; --band:#f0efec;
  --s1:#2a78d6; --s2:#eb6834; --s3:#1baf7a; --s4:#eda100; }
@media (prefers-color-scheme: dark) { :root { --bg:#0d0d0d; --surface:#1a1a19; --ink:#f0efec; --ink2:#c3c2b7; --grid:#383835; --wall:#6b6a64; --band:#2a2a28;
  --s1:#3987e5; --s2:#d95926; --s3:#199e70; --s4:#c98500; } }
body { background:var(--bg); color:var(--ink); font:15px/1.5 system-ui,sans-serif; margin:0; padding:24px 16px 64px; }
main { max-width:1100px; margin:0 auto; }
h1 { font-size:24px; margin:0 0 4px; } h2 { font-size:18px; margin:40px 0 4px; } h3 { font-size:14px; margin:16px 0 4px; color:var(--ink2); font-weight:600; }
p { margin:4px 0 12px; max-width:75ch; } .note { color:var(--ink2); }
.pair { display:grid; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); gap:16px; }
figure { margin:0; background:var(--surface); border:1px solid var(--grid); border-radius:8px; padding:12px; }
figcaption { font-weight:600; margin-bottom:6px; }
svg { width:100%; height:auto; display:block; }
.arena { fill:var(--surface); stroke:var(--grid); } .wall { fill:var(--wall); } .band { fill:var(--band); }
.grid { stroke:var(--grid); stroke-width:1; } .tick { fill:var(--ink2); font-size:11px; } .label { fill:var(--ink); font-size:12px; }
figure svg[viewBox="0 0 750 600"] .label { font-size:16px; }
.ring { stroke:var(--surface); stroke-width:2; }
.legend span { margin-right:16px; white-space:nowrap; } .legend i { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:6px; }
table { border-collapse:collapse; margin:8px 0; } td,th { padding:2px 12px 2px 0; text-align:right; font-variant-numeric:tabular-nums; } th:first-child,td:first-child { text-align:left; }
`;

describe.runIf(!!process.env.BOT_TRACE)('bot trace', () => {
  it('writes out/bot-trace.html', () => {
    const body: string[] = [];
    body.push('<h1>Old bots and human-like bots, side by side</h1>');
    body.push('<p class="note">Same level, same seed, same planner. "Old" is the planner alone: exact perception, tick-perfect keys. "Human" sees late, presses clumsily and has to relearn reversed controls (design/bots-human.md). † marks a death. Hover a line for details.</p>');

    // 1. Control Reversal
    body.push('<h2>Control Reversal</h2>');
    body.push('<p>A bot driving around <em>bricks</em> picks up Control Reversal after 2 s (it lasts 10 s). The old bots compensate after a fixed delay and never look back; the human ones turn the wrong way, catch themselves, over-correct and settle — quickly for hard, slowly for easy.</p>');
    const REV_AT = 140;
    const REV_TICKS = 1100;
    for (const d of ['easy', 'normal', 'hard'] as BotDifficulty[]) {
      const run = (spec: DriverSpec): Recording => record('bricks', [spec, 'raw-calm-hard'], 12, REV_TICKS, (game, tick) => {
        game.items.length = 0;
        if (tick === REV_AT) game.players[0]!.activateEffect('reverse', 700);
      });
      const old = run(`raw-calm-${d}` as DriverSpec);
      const human = run(`calm-${d}` as DriverSpec);
      const series = [{ label: `old ${d}`, track: old.tracks[0]! }, { label: `human ${d}`, track: human.tracks[0]! }];
      body.push(`<h3>${d}</h3>`);
      body.push(legend(series.map(s => s.label)));
      body.push(`<div class="pair"><figure><figcaption>Heading (cumulative turn) over time</figcaption>${headingSvg(series, [REV_AT, REV_AT + 700], 0, REV_TICKS)}</figure>`);
      body.push(`<figure><figcaption>Steering key during the first 6 s of the reversal</figcaption>${keysSvg(series, REV_AT, REV_AT + 420)}</figure></div>`);
      body.push(`<div class="pair"><figure><figcaption>Path, old ${d}</figcaption>${arenaSvg({ tracks: [old.tracks[0]!], obstacles: old.obstacles }, [`old ${d}`], 'Path of the old bot')}</figure>`);
      body.push(`<figure><figcaption>Path, human ${d}</figcaption>${arenaSvg({ tracks: [human.tracks[0]!], obstacles: human.obstacles }, [`human ${d}`], 'Path of the human bot', 1)}</figure></div>`);
    }

    // 2. Ordinary driving
    body.push('<h2>Ordinary driving: the keys</h2>');
    body.push('<p>Six seconds of a duel on <em>bricks</em>. The old bots tap for as little as one to three ticks (14–43 ms) whenever the plan says so; a person cannot, so the human bots press longer and a little late.</p>');
    for (const d of ['normal', 'hard'] as BotDifficulty[]) {
      const old = record('bricks', [`raw-calm-${d}` as DriverSpec, `raw-calm-${d}` as DriverSpec], 21, 700);
      const human = record('bricks', [`calm-${d}` as DriverSpec, `calm-${d}` as DriverSpec], 21, 700);
      const series = [{ label: `old ${d}`, track: old.tracks[0]! }, { label: `human ${d}`, track: human.tracks[0]! }];
      const shortest = (track: Sample[]): string => {
        const runs: number[] = [];
        let run = 0;
        for (let i = 0; i < track.length; i++) {
          if (track[i]!.key !== 0 && (i === 0 || track[i - 1]!.key === track[i]!.key)) run++;
          else {
            if (run > 0) runs.push(run);
            run = track[i]!.key !== 0 ? 1 : 0;
          }
        }
        runs.sort((a, b) => a - b);
        return `${runs.length} presses, shortest ${runs[0] ?? 0} ticks, median ${runs[Math.floor(runs.length / 2)] ?? 0}`;
      };
      body.push(`<figure><figcaption>${d}: steering key, 2 s to 8 s into the round</figcaption>${legend(series.map(s => s.label))}${keysSvg(series, 140, 560)}<p class="note">Whole 10 s: old ${shortest(old.tracks[0]!)}; human ${shortest(human.tracks[0]!)}.</p></figure>`);
    }

    // 3. Whole rounds
    body.push('<h2>Whole rounds</h2>');
    body.push('<p>Four bots (easy, normal, hard, hard), 20 s at most, same seed. The rounds diverge after the first moments — this is to get a feel for the lines they draw, not a like-for-like comparison.</p>');
    for (const level of ['blank', 'bricks']) {
      const labels = ['easy', 'normal', 'hard', 'hard 2'];
      const specs = ['easy', 'normal', 'hard', 'hard'];
      const old = record(level, specs.map(s => `raw-${s}` as DriverSpec), 8, 1400);
      const human = record(level, specs as DriverSpec[], 8, 1400);
      body.push(`<h3>${level}</h3>${legend(labels)}<div class="pair"><figure><figcaption>Old bots</figcaption>${arenaSvg(old, labels, 'Trails of the old bots')}</figure>`);
      body.push(`<figure><figcaption>Human-like bots</figcaption>${arenaSvg(human, labels, 'Trails of the human-like bots')}</figure></div>`);
    }

    mkdirSync('out', { recursive: true });
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bot trace</title><style>${CSS}</style></head><body><main>${body.join('\n')}</main></body></html>`;
    writeFileSync('out/bot-trace.html', html);
    console.log('wrote out/bot-trace.html');
  }, 600_000);
});
