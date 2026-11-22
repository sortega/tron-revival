import { SmoothLineKeeper } from '../src/game/display/SmoothLines';
import { packCss } from '../src/game/display/shade';
import { describe, expect, it } from 'vitest';
import { HostSession } from '../src/game/session/HostSession';
import { GuestSession } from '../src/game/session/GuestSession';
import { HOST_SILENCE_MS } from '../src/game/session/GameSession';
import { decode } from '@msgpack/msgpack';
import { deserializeState, serializeState } from '../src/network/serialization';
import { makeGame, skipCountdown } from './helpers';
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
    expect(bytes / frames).toBeLessThan(150);
    expect(maxBytes).toBeLessThan(2000);
  }, 120_000);
});

describe('joining a game in progress', () => {
  it('a snapshot plus the frames after it reproduce the arena exactly', () => {
    const rig = makeRig({ delayMs: 40, jitterMs: 30 }, { seed: 5, hostControl: { type: 'ai', difficulty: 'normal' }, level: 'pop-culture' });
    let guestTick = 0;
    rig.onGuestTick = () => { rig.guestInput = { steer: wavy(guestTick++, 220), action: guestTick % 90 < 8 }; };
    rig.net.runUntil(9000);

    // A second client arrives mid-game: frames flow before its snapshot does
    const cfg = config({ type: 'remote' }, 'pop-culture');
    const late = new GuestSession(rig.net.addGuest(2 as SlotIndex, { delayMs: 70, jitterMs: 50 }), null, cfg.players, { now: rig.net.now, awaitSnapshot: true });
    let mirror: PixelGrid | null = null;
    let framesBeforeSnapshot = 0;
    // The translucent part of the trails travels in the snapshot too (display-layer.md)
    const smooth = new SmoothLineKeeper(750, 600, slot => packCss(FFA_COLORS[slot]));
    late.onSnapshot = (arena, smoothLines) => { mirror = arena; smooth.lines.load(smoothLines); };
    late.onFrame = (f) => {
      if (!mirror) { framesBeforeSnapshot++; return; }
      smooth.apply(f);
      for (const { slotIndex, segments } of f.newTrailSegments) for (const seg of segments) mirror.set(seg.x, seg.y, FFA_COLORS[slotIndex]);
      for (const { color, segments } of f.borderSegments ?? []) for (const seg of segments) mirror.set(seg.x, seg.y, color);
      const lines = f.clearedLines ?? [];
      for (let i = 0; i + 3 < lines.length; i += 4) mirror.clearLine(lines[i]!, lines[i + 1]!, lines[i + 2]!, lines[i + 3]!);
      for (const r of f.clearedAreas ?? []) mirror.clearRect(r.x, r.y, r.w, r.h);
    };
    expect(late.getViewState()).toBeNull();
    rig.net.runUntil(9400);
    expect(late.getViewState()).toBeNull(); // Still waiting for the snapshot

    // The snapshot is taken now but arrives later than frames sent after it
    const snapshot = rig.host.makeSnapshot();
    rig.net.schedule(rig.net.time + 300, () => late.loadSnapshot(snapshot));
    const roundAtSnapshot = rig.host.game.currentRound;
    rig.net.runUntil(11_000);

    const hostGrid = new PixelGrid();
    hostGrid.copyFrom(rig.host.game.pixels);
    rig.host.step = () => {};
    rig.net.runUntil(12_000);

    expect(rig.host.game.currentRound).toBe(roundAtSnapshot); // Same round: the comparison is meaningful
    expect(framesBeforeSnapshot).toBe(0);
    expect(mirror).not.toBeNull();
    expect(late.getViewState()!.round.players.length).toBe(2);
    expect(late.getViewState()!.match.levelMode).toBe('pop-culture');
    let diff = 0;
    for (let y = 0; y < 600; y++) for (let x = 0; x < 750; x++) if (mirror!.get(x, y) !== hostGrid.get(x, y)) diff++;
    expect(diff).toBe(0);
    expect(hostGrid.count()).toBeGreaterThan(1000);
    const hostSmooth = (rig.host as unknown as { smoothLines: SmoothLineKeeper }).smoothLines.lines;
    let smoothDiff = 0, smoothCells = 0;
    for (let i = 0; i < hostSmooth.alpha.length; i++) {
      const a = hostSmooth.alpha[i]!;
      if (a !== 0) smoothCells++;
      if (a !== smooth.lines.alpha[i] || (a !== 0 && hostSmooth.color[i] !== smooth.lines.color[i])) smoothDiff++;
    }
    expect(smoothDiff).toBe(0);
    expect(smoothCells).toBeGreaterThan(300);
  });

  it('survives a corrupt snapshot', () => {
    const rig = makeRig({ delayMs: 10 });
    const cfg = config({ type: 'remote' });
    const late = new GuestSession(rig.net.addGuest(2 as SlotIndex, { delayMs: 10 }), null, cfg.players, { now: rig.net.now, awaitSnapshot: true });
    rig.net.runUntil(500);
    late.loadSnapshot(new Uint8Array([1, 2, 3]));
    rig.net.runUntil(1000);
    expect(late.getViewState()).not.toBeNull();
  });
});

describe('host silence', () => {
  it('is measured by the guest and ends with the next state', () => {
    const rig = makeRig({ delayMs: 40 });
    expect(rig.guest.getNetworkStats().silentMs).toBe(0); // Nothing received yet
    rig.net.runUntil(1000);
    expect(rig.guest.getNetworkStats().silentMs).toBeLessThan(HOST_SILENCE_MS / 10);

    const broadcast = rig.net.hostTransport.broadcastState;
    rig.net.hostTransport.broadcastState = () => {};
    rig.net.runUntil(4000);
    const silent = rig.guest.getNetworkStats().silentMs!;
    expect(silent).toBeGreaterThan(HOST_SILENCE_MS);
    expect(silent).toBeLessThanOrEqual(3000);
    // The frozen game is still there to look at
    expect(rig.guest.getViewState()).not.toBeNull();

    rig.net.hostTransport.broadcastState = broadcast;
    rig.net.runUntil(4200);
    expect(rig.guest.getNetworkStats().silentMs).toBeLessThan(HOST_SILENCE_MS / 10);
  });
});

// design/local-and-ai.md, "Speeding up when only bots are left"
describe('speeding up', () => {
  it('guests get one message per ten ticks, and still every event', () => {
    const net = new SimNet(3);
    const cfg = config({ type: 'local', scheme: 'solo' });
    cfg.players.push(
      { slotIndex: 2, nickname: 'Bot A', color: FFA_COLORS[2], control: { type: 'ai', difficulty: 'normal' } },
      { slotIndex: 3, nickname: 'Bot B', color: FFA_COLORS[3], control: { type: 'ai', difficulty: 'normal' } },
    );
    const host = new HostSession(cfg, { transport: net.hostTransport, rng: createRng(3), now: net.now });
    const guest = new GuestSession(net.addGuest(1, { delayMs: 40, jitterMs: 20 }), 1, cfg.players, { now: net.now });

    const mirror = new PixelGrid();
    let guestFrames = 0;
    let guestSounds = 0;
    let seenOn = false;
    guest.onFrame = (f: TronGameStateData) => {
      guestFrames++;
      guestSounds += f.soundEvents.length;
      if (f.round.speedUp === 'on') seenOn = true;
      if (f.roundStarted || f.eraserUsed) mirror.clear();
      for (const { slotIndex, segments } of f.newTrailSegments) {
        for (const seg of segments) mirror.set(seg.x, seg.y, FFA_COLORS[slotIndex]);
      }
      const lines = f.clearedLines ?? [];
      for (let i = 0; i + 3 < lines.length; i += 4) mirror.clearLine(lines[i]!, lines[i + 1]!, lines[i + 2]!, lines[i + 3]!);
      for (const r of f.clearedAreas ?? []) mirror.clearRect(r.x, r.y, r.w, r.h);
    };
    let hostFrames = 0;
    let hostSounds = 0;
    host.onFrame = (f) => { hostFrames++; hostSounds += f.soundEvents.length; };

    // Both humans circle into their own trails; the host holds action from the offer on
    let fastTicks = 0;
    let fastMessages = 0;
    let stopped = false;
    const circling = { steer: -1, action: false };
    net.every(() => {
      if (stopped) return;
      // As the ticking loop does: `timeScale` ticks for one of real time
      for (let i = host.timeScale; i > 0 && !stopped; i--) {
        const fast = host.timeScale > 1;
        const before = net.bytes.playerMessages;
        host.step(new Map<SlotIndex, TronInput>([[0, circling]]));
        if (fast && host.timeScale > 1) {
          fastTicks++;
          fastMessages += net.bytes.playerMessages - before;
        }
        if (host.getViewState().round.speedUp === 'offered') host.setSpeedUp(true);
        // Stop a little into the pause after the round that was sped up
        if (fastTicks > 0 && host.game.phase === 'waiting_ready' && host.timeScale === 1) stopped = true;
      }
    });
    net.every(() => guest.step(new Map<SlotIndex, TronInput>([[1, circling]])), 5);
    net.runUntil(120_000);
    expect(stopped).toBe(true);
    const messages = net.bytes.playerMessages;
    net.runUntil(121_000);

    expect(fastTicks).toBeGreaterThan(100);
    expect(fastMessages).toBeLessThanOrEqual(Math.ceil(fastTicks / 10));
    expect(fastMessages).toBeGreaterThanOrEqual(Math.floor(fastTicks / 10) - 1);
    expect(messages).toBeLessThan(hostFrames - fastTicks * 0.85);
    expect(seenOn).toBe(true);
    expect(guest.getViewState()?.round.phase).toBe('waiting_ready');
    expect(guest.getViewState()?.round.speedUp).toBeUndefined();
    // Nothing was lost on the way
    expect(guestFrames).toBe(hostFrames);
    expect(guestSounds).toBe(hostSounds);
    let diff = 0;
    for (let y = 0; y < 600; y++) for (let x = 0; x < 750; x++) if (mirror.get(x, y) !== host.game.pixels.get(x, y)) diff++;
    expect(diff).toBe(0);
  }, 120_000);
});

// design/networking.md, "Wire format"
describe('wire format', () => {
  const frame = (): TronGameStateData => {
    const g = makeGame(2, 1);
    skipCountdown(g);
    g.tick(new Map());
    return g.serialize();
  };

  it('carries what is drawn of projectiles, explosions and satellites, in a few bytes each', () => {
    const state = frame();
    state.round.projectiles = [
      { id: 7, x: 749_900, y: 599_900, direction: 33.3, ownerSlot: 1, speed: 20000, type: 'tracer', remainingFrames: 3 },
      { id: 8, x: 12_345, y: 0, direction: 270, ownerSlot: 0, speed: 5000, type: 'bullet' },
      { id: 9, x: 300_000, y: 200_999, direction: 359.9, ownerSlot: 0, speed: 2000, type: 'bomb', hp: 100 },
      // A little outside the arena: wrapped in
      { id: 10, x: -1_500, y: 600_200, direction: 0, ownerSlot: 0, speed: 2000, type: 'tracer' },
    ];
    state.round.explosions = [
      { id: 1, x: 749, y: 599, frame: 38 },
      { id: 2, x: 0, y: 300, frame: 0, scale: 2 },
      { id: 3, x: 10, y: 20, frame: 5, scale: 4 },
    ];
    state.round.bodyguards = [{ id: 4, ownerSlot: 1, x: 100_700, y: 50_200, phaseOffset: 180 }];
    const plain = serializeState({ ...state, round: { ...state.round, projectiles: [], explosions: [], bodyguards: [] } }).length;
    const data = serializeState(state);
    // 3 bytes a tracer, 4 a bullet or a bomb, 5 an explosion, about 5 a satellite
    expect(data.length - plain).toBeLessThanOrEqual(3 + 4 + 4 + 3 + 3 * 5 + 6);

    const copy = deserializeState(data, state.round.players);
    expect(copy.round.projectiles.map(p => [p.type, p.x, p.y])).toEqual([
      ['tracer', 749_000, 599_000], ['bullet', 12_000, 0], ['bomb', 300_000, 200_000], ['tracer', 1022_000, 600_000],
    ]);
    expect(copy.round.projectiles[1]!.direction).toBeCloseTo(270, 0);
    expect(Math.abs(copy.round.projectiles[2]!.direction - 359.9) % 360).toBeLessThan(1.5);
    expect(copy.round.explosions.map(e => [e.x, e.y, e.frame, e.scale])).toEqual([[749, 599, 38, undefined], [0, 300, 0, 2], [10, 20, 5, 4]]);
    expect(copy.round.bodyguards.map(b => [b.x, b.y, b.ownerSlot])).toEqual([[100_000, 50_000, 1]]);
  });

  it('carries every new trail pixel, however many', () => {
    const state = frame();
    const long = Array.from({ length: 600 }, (_, i) => ({ x: i % 750, y: (i * 7) % 600 }));
    state.newTrailSegments = [
      { slotIndex: 0, segments: long },
      { slotIndex: 1, segments: [] },
      { slotIndex: 3, segments: Array.from({ length: 255 }, (_, i) => ({ x: 749 - i, y: 599 })) },
      { slotIndex: 2, segments: [{ x: 0, y: 0 }, { x: 749, y: 599 }] },
    ];
    const copy = deserializeState(serializeState(state), state.round.players);
    expect(copy.newTrailSegments).toEqual(state.newTrailSegments);
  });

  it('carries weapons, effects, the phase and the winner', () => {
    const state = frame();
    state.round.players[0]!.equippedWeapon = { sprite: 'uzi', remainingFrames: 120 };
    state.round.players[1]!.equippedWeapon = { sprite: 'rifle', ammo: 45 };
    state.round.players[1]!.activeEffects = [{ sprite: 'shield', remainingFrames: 2000 }, { sprite: 'crossing', remainingFrames: 7 }];
    for (const [phase, winner, speedUp] of [['playing', null, 'on'], ['waiting_ready', 'draw', undefined], ['waiting_ready', 1, undefined], ['playing', null, 'offered']] as const) {
      state.round.phase = phase;
      state.round.roundWinner = winner;
      state.round.speedUp = speedUp;
      const copy = deserializeState(serializeState(state), state.round.players);
      expect(copy.round.players).toEqual(state.round.players.map(p => ({ ...p, x: Math.round(p.x), y: Math.round(p.y) })));
      expect([copy.round.phase, copy.round.roundWinner, copy.round.speedUp]).toEqual([phase, winner, speedUp]);
    }
  });

  it('a quiet frame of four players is small', () => {
    const g = makeGame(4, 2);
    skipCountdown(g);
    let bytes = 0;
    for (let i = 0; i < 70; i++) {
      g.tick(new Map());
      const state = g.serialize();
      const { items: _items, portals: _portals, ...round } = state.round;
      bytes += serializeState({ ...state, round, match: undefined, tick: 5000 + i }).length;
    }
    // It was about 330 with field names and one number per coordinate
    expect(bytes / 70).toBeLessThan(140);
  });

  it('portals travel when they change; in between only their animation frames do', () => {
    const rig = makeRig({ delayMs: 20 }, { seed: 4, level: 'portals' });
    let whole = 0;
    let frames = 0;
    let messages = 0;
    const broadcast = rig.net.hostTransport.broadcastState;
    rig.net.hostTransport.broadcastState = (data) => {
      const extras = (decode(data) as unknown[])[12] as { portals?: unknown; portalFrames?: unknown } | undefined;
      messages++;
      if (extras?.portals) whole++;
      if (extras?.portalFrames) frames++;
      broadcast(data);
    };
    rig.net.runUntil(8_000);
    // Stop the host and let everything arrive: the guest's portals are the host's, frames included
    const truth = rig.host.getViewState().round.portals;
    rig.host.step = () => {};
    rig.net.runUntil(8_500);
    expect(truth.length).toBeGreaterThan(0);
    expect(rig.guest.getViewState()?.round.portals).toEqual(truth);
    expect(messages).toBeGreaterThan(500);
    // Once a second as a safety net, and when a round sets new ones up
    expect(whole).toBeLessThan(messages / 50);
    // The animation advances every third tick, while a round is on
    expect(frames).toBeGreaterThan(messages / 10);
    expect(frames).toBeLessThan(messages / 2.9);
  });
});
