import { describe, expect, it } from 'vitest';
import { HostSession } from '../src/game/session/HostSession';
import { GuestSession } from '../src/game/session/GuestSession';
import { PixelGrid } from '../src/game/PixelGrid';
import { createRng } from '../src/game/rng';
import { FFA_COLORS } from '../src/types/lobby';
import type { SlotIndex } from '../src/types/lobby';
import type { GameConfig, PlayerControl, TronGameStateData, TronInput } from '../src/types/game';
import { SimNet } from './netsim';
import type { LinkOptions } from './netsim';
import { loadLevelGrid } from './helpers';

function config(host: PlayerControl, level = 'blank'): GameConfig {
  return {
    players: [
      { slotIndex: 0, nickname: 'Host', color: FFA_COLORS[0], control: host },
      { slotIndex: 1, nickname: 'Guest', color: FFA_COLORS[1], control: { type: 'remote' } },
    ],
    gameMode: 'ffa',
    levelMode: level,
  };
}

interface Rig {
  net: SimNet;
  host: HostSession;
  guest: GuestSession;
  hostInput: TronInput;
  guestInput: TronInput;
  onHostTick: (() => void) | null;
  onGuestTick: (() => void) | null;
}

function makeRig(link: LinkOptions, opts: {
  seed?: number; hostControl?: PlayerControl; level?: string;
  predict?: boolean; extrapolate?: boolean; guestRate?: number;
} = {}): Rig {
  const net = new SimNet(opts.seed ?? 1);
  const cfg = config(opts.hostControl ?? { type: 'local', scheme: 'solo' }, opts.level);
  const host = new HostSession(cfg, { transport: net.hostTransport, rng: createRng(opts.seed ?? 1), now: net.now });
  if (opts.level && opts.level !== 'blank') host.setLevelObstacles(host.game.currentLevelIndex, loadLevelGrid(opts.level));
  const guest = new GuestSession(net.addGuest(1, link), 1, cfg.players, { now: net.now, predict: opts.predict, extrapolate: opts.extrapolate });
  const rig: Rig = {
    net, host, guest,
    hostInput: { steer: 0, action: false },
    guestInput: { steer: 0, action: false },
    onHostTick: null, onGuestTick: null,
  };
  net.every(() => {
    host.step(new Map<SlotIndex, TronInput>([[0, rig.hostInput]]));
    rig.onHostTick?.();
  });
  // The guest's ticks are not aligned with the host's
  net.every(() => {
    guest.step(new Map<SlotIndex, TronInput>([[1, rig.guestInput]]));
    rig.onGuestTick?.();
  }, 5, opts.guestRate ?? 1);
  return rig;
}

// Wavy steering that keeps a player alive and turning for a while
function wavy(tick: number, period = 90): number {
  const phase = tick % period;
  return phase < period * 0.3 ? 1 : phase < period * 0.5 ? 0 : phase < period * 0.8 ? -1 : 0;
}

/** Compare the guest's predicted position for input `seq` with the host's truth. */
function measurePrediction(rig: Rig, seconds: number): { samples: number; exact: number; maxError: number; meanError: number } {
  const predicted = new Map<number, { x: number; y: number }>();
  const errors: number[] = [];
  let guestTick = 0;
  rig.onGuestTick = () => {
    rig.guestInput = { steer: wavy(guestTick++), action: false };
    const p = rig.guest.getPredictedPlayer();
    if (p && p.alive && rig.guest.getViewState()?.round.phase === 'playing') {
      // After step(): the prediction includes the input just sent (seq = guestTick)
      predicted.set(guestTick, { x: p.x, y: p.y });
    }
  };
  let lastAck = -1;
  rig.onHostTick = () => {
    const ack = rig.host.getAck(1);
    if (ack === undefined || ack === lastAck) return;
    lastAck = ack;
    const truth = rig.host.game.players[1]!;
    const guess = predicted.get(ack);
    if (guess && truth.alive && rig.host.game.phase === 'playing') {
      errors.push(Math.hypot(guess.x - truth.x, guess.y - truth.y) / 1000);
    }
    predicted.delete(ack);
  };
  rig.net.runUntil(seconds * 1000);
  // Skip the first samples: the first plays ticks are predicted before any playing state arrived
  const settled = errors.slice(30);
  return {
    samples: settled.length,
    exact: settled.filter(e => e < 0.01).length,
    maxError: Math.max(0, ...settled),
    meanError: settled.reduce((a, b) => a + b, 0) / Math.max(1, settled.length),
  };
}

describe('client-side prediction', () => {
  for (const delayMs of [0, 40, 120, 250]) {
    it(`matches the host exactly on a steady ${delayMs} ms link`, () => {
      const rig = makeRig({ delayMs });
      const result = measurePrediction(rig, 7.5);
      expect(result.samples).toBeGreaterThan(200);
      expect(result.exact).toBe(result.samples);
    });
  }

  it('stays close on a jittery link', () => {
    const rig = makeRig({ delayMs: 60, jitterMs: 40 }, { seed: 3 });
    const result = measurePrediction(rig, 7.5);
    expect(result.samples).toBeGreaterThan(200);
    // A held or skipped input shifts things by a tick (1px, 4°) until reconciled
    expect(result.exact / result.samples).toBeGreaterThan(0.9);
    expect(result.maxError).toBeLessThan(6);
  });

  it('copes with a guest clock that runs fast', () => {
    const rig = makeRig({ delayMs: 50 }, { guestRate: 1.02 });
    const result = measurePrediction(rig, 7.5);
    expect(result.meanError).toBeLessThan(1.5);
    // The input queue stays bounded, so latency does not creep up
    expect(rig.guest.getPendingCount()).toBeLessThan(20);
  });

  it('shows steering on the very next tick regardless of latency', () => {
    const responseTicks = (predict: boolean): number => {
      const rig = makeRig({ delayMs: 100 }, { predict, extrapolate: false });
      rig.net.runUntil(4000);
      const before = rig.guest.getPredictedPlayer()!.direction;
      rig.guestInput = { steer: 1, action: false };
      for (let tick = 1; tick <= 60; tick++) {
        rig.net.runUntil(rig.net.time + 1000 / 70);
        if (rig.guest.getPredictedPlayer()!.direction !== before) return tick;
      }
      return Infinity;
    };
    expect(responseTicks(true)).toBeLessThanOrEqual(2);
    // Without prediction the turn is only visible after a full round trip (200 ms ≈ 14 ticks)
    expect(responseTicks(false)).toBeGreaterThanOrEqual(14);
  });

  it('draws a provisional trail from the last authoritative position to the predicted head', () => {
    const rig = makeRig({ delayMs: 100 });
    rig.net.runUntil(4500);
    const view = rig.guest.getViewState()!;
    const mine = view.overlayTrails?.find(t => t.color === FFA_COLORS[1]);
    expect(mine).toBeDefined();
    // ~200 ms round trip at 1 px/tick ≈ 14 px
    expect(mine!.segments.length).toBeGreaterThanOrEqual(10);
    expect(mine!.segments.length).toBeLessThanOrEqual(20);
  });
});

describe('dead reckoning', () => {
  // Error of the guest's picture of the HOST player, compared with where the host
  // player really is on the host tick that consumes the guest's newest input
  function remoteError(extrapolate: boolean): number {
    const rig = makeRig({ delayMs: 60 }, { extrapolate });
    const seen = new Map<number, { x: number; y: number }>();
    const errors: number[] = [];
    let hostTick = 0;
    let guestTick = 0;
    let lastAck = -1;
    rig.onGuestTick = () => {
      guestTick++;
      const view = rig.guest.getViewState();
      const other = view?.round.players[0];
      if (view?.round.phase === 'playing' && other?.alive) seen.set(guestTick, { x: other.x, y: other.y });
    };
    rig.onHostTick = () => {
      rig.hostInput = { steer: wavy(hostTick++, 140), action: false };
      const ack = rig.host.getAck(1);
      if (ack === undefined || ack === lastAck) return;
      lastAck = ack;
      const truth = rig.host.game.players[0]!;
      const guess = seen.get(ack);
      if (guess && truth.alive) errors.push(Math.hypot(guess.x - truth.x, guess.y - truth.y) / 1000);
      seen.delete(ack);
    };
    rig.net.runUntil(7500);
    expect(errors.length).toBeGreaterThan(200);
    return errors.reduce((a, b) => a + b, 0) / errors.length;
  }

  it('shows remote players closer to where they really are', () => {
    const without = remoteError(false);
    const withDr = remoteError(true);
    // 120 ms round trip ≈ 8.4 px behind without extrapolation
    expect(without).toBeGreaterThan(7);
    expect(withDr).toBeLessThan(without / 3);
  });
});

describe('event delivery', () => {
  it('guest reconstructs exactly the same arena as the host', () => {
    // A long, busy game: bots with weapons on a level with obstacles
    const rig = makeRig({ delayMs: 80, jitterMs: 60 }, { seed: 11, hostControl: { type: 'ai', difficulty: 'hard' }, level: 'bricks' });
    const level = loadLevelGrid('bricks');
    const mirror = new PixelGrid();
    let frames = 0;
    let sounds = 0;
    let bytes = 0;
    let maxBytes = 0;
    const broadcast = rig.net.hostTransport.broadcastState;
    rig.net.hostTransport.broadcastState = (data) => {
      bytes += data.length;
      maxBytes = Math.max(maxBytes, data.length);
      broadcast(data);
    };
    rig.guest.onFrame = (f: TronGameStateData) => {
      frames++;
      sounds += f.soundEvents.length;
      if (f.roundStarted || f.eraserUsed) mirror.copyFrom(level);
      for (const { slotIndex, segments } of f.newTrailSegments) {
        for (const seg of segments) mirror.set(seg.x, seg.y, FFA_COLORS[slotIndex]);
      }
      for (const { color, segments } of f.borderSegments ?? []) {
        for (const seg of segments) mirror.set(seg.x, seg.y, color);
      }
      const lines = f.clearedLines ?? [];
      for (let i = 0; i + 3 < lines.length; i += 4) mirror.clearLine(lines[i]!, lines[i + 1]!, lines[i + 2]!, lines[i + 3]!);
      for (const r of f.clearedAreas ?? []) mirror.clearRect(r.x, r.y, r.w, r.h);
    };
    let hostFrames = 0;
    let hostSounds = 0;
    rig.host.onFrame = (f) => { hostFrames++; hostSounds += f.soundEvents.length; };

    let guestTick = 0;
    const rng = createRng(4);
    rig.onGuestTick = () => {
      guestTick++;
      rig.guestInput = { steer: wavy(guestTick, 200), action: rng() < 0.5 };
    };
    rig.net.runUntil(45_000);
    // Stop the host and let everything in flight arrive
    const hostGrid = new PixelGrid();
    hostGrid.copyFrom(rig.host.game.pixels);
    const totalHostFrames = hostFrames;
    const totalHostSounds = hostSounds;
    rig.host.step = () => {};
    rig.net.runUntil(46_000);

    expect(frames).toBe(totalHostFrames);
    expect(sounds).toBe(totalHostSounds);
    let diff = 0;
    for (let y = 0; y < 600; y++) for (let x = 0; x < 750; x++) if (mirror.get(x, y) !== hostGrid.get(x, y)) diff++;
    expect(diff).toBe(0);
    expect(rig.host.game.currentRound).toBeGreaterThan(1);
    // Bandwidth budget: average and worst frame
    expect(bytes / frames).toBeLessThan(350);
    expect(maxBytes).toBeLessThan(6000);
  }, 120_000);
});
