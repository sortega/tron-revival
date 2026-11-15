// Spectators: the reduced-rate stream, and seats changing hands at a round start.
// See design/spectators.md.
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HostSession, SPECTATOR_SEND_EVERY } from '../src/game/session/HostSession';
import { GuestSession } from '../src/game/session/GuestSession';
import { PixelGrid } from '../src/game/PixelGrid';
import { TronGameState } from '../src/game/TronGameState';
import { createRng } from '../src/game/rng';
import { FFA_COLORS, getSlotColor } from '../src/types/lobby';
import type { GameMode, SlotIndex } from '../src/types/lobby';
import type { GameConfig, GamePlayer, TronGameStateData, TronInput } from '../src/types/game';
import { SimNet } from './netsim';
import { loadLevelGrid, makeGame, makePlayers, inputs, NO_INPUT } from './helpers';

const bot = (slot: SlotIndex, mode: GameMode = 'ffa'): GamePlayer => ({
  slotIndex: slot, nickname: `Bot${slot}`, color: getSlotColor(mode, slot), control: { type: 'ai', difficulty: 'normal' }, owner: 'ai',
});
const remote = (slot: SlotIndex, owner: string, mode: GameMode = 'ffa'): GamePlayer => ({
  slotIndex: slot, nickname: owner, color: getSlotColor(mode, slot), control: { type: 'remote' }, owner,
});

/** Rebuilds the arena from the frames a client is given, like the renderer does. */
function mirrorOf(session: GuestSession, level: PixelGrid): { grid: PixelGrid; frames: number; sounds: number; rounds: number } {
  const state = { grid: new PixelGrid(), frames: 0, sounds: 0, rounds: 0 };
  session.onSnapshot = (arena) => { state.grid = arena; };
  session.onFrame = (f: TronGameStateData) => {
    state.frames++;
    state.sounds += f.soundEvents.length;
    if (f.roundStarted) state.rounds++;
    if (f.roundStarted || f.eraserUsed) state.grid.copyFrom(level);
    for (const { slotIndex, segments } of f.newTrailSegments) {
      for (const seg of segments) state.grid.set(seg.x, seg.y, FFA_COLORS[slotIndex]);
    }
    for (const { color, segments } of f.borderSegments ?? []) {
      for (const seg of segments) state.grid.set(seg.x, seg.y, color);
    }
    const lines = f.clearedLines ?? [];
    for (let i = 0; i + 3 < lines.length; i += 4) state.grid.clearLine(lines[i]!, lines[i + 1]!, lines[i + 2]!, lines[i + 3]!);
    for (const r of f.clearedAreas ?? []) state.grid.clearRect(r.x, r.y, r.w, r.h);
  };
  return state;
}

function differences(a: PixelGrid, b: PixelGrid): number {
  let diff = 0;
  for (let y = 0; y < 600; y++) for (let x = 0; x < 750; x++) if (a.get(x, y) !== b.get(x, y)) diff++;
  return diff;
}

function botGame(level: string, seed: number, players: GamePlayer[] = [bot(0), bot(1), bot(2)]): { net: SimNet; host: HostSession; config: GameConfig } {
  const net = new SimNet(seed);
  net.enableSpectatorStream();
  const config: GameConfig = { players, gameMode: 'ffa', levelMode: level };
  const host = new HostSession(config, {
    transport: net.hostTransport, rng: createRng(seed), now: net.now,
    onRosterApplied: (roster) => net.setRoles(new Map(
      roster.filter(p => p.owner && p.owner !== 'ai').map(p => [p.owner!, p.slotIndex]))),
  });
  if (level !== 'blank') host.setLevelObstacles(host.game.currentLevelIndex, loadLevelGrid(level));
  net.every(() => host.step(new Map()));
  return { net, host, config };
}

describe('reduced stream for watchers', () => {
  it('a watcher rebuilds exactly the host arena, from a fraction of the bytes', () => {
    const { net, host, config } = botGame('bricks', 11);
    const level = loadLevelGrid('bricks');
    const watcher = new GuestSession(net.addMember('w', { delayMs: 60, jitterMs: 50 }), null, config.players, { now: net.now, selfId: 'w' });
    const mirror = mirrorOf(watcher, level);
    net.every(() => watcher.step(new Map()), 3);
    let hostFrames = 0;
    let hostSounds = 0;
    host.onFrame = (f) => { hostFrames++; hostSounds += f.soundEvents.length; };

    net.runUntil(45_000);
    const hostGrid = new PixelGrid();
    hostGrid.copyFrom(host.game.pixels);
    const total = { frames: hostFrames, sounds: hostSounds };
    host.step = () => {};
    net.runUntil(46_000);

    // Whatever was still in the batch when the host stopped is the only thing missing
    expect(total.frames - mirror.frames).toBeLessThan(SPECTATOR_SEND_EVERY);
    expect(host.game.currentRound).toBeGreaterThan(1);
    expect(mirror.rounds).toBe(host.game.currentRound);
    if (total.frames === mirror.frames) {
      expect(mirror.sounds).toBe(total.sounds);
      expect(differences(mirror.grid, hostGrid)).toBe(0);
    } else {
      // At most the trail pixels of the unsent ticks
      expect(differences(mirror.grid, hostGrid)).toBeLessThan(40);
    }

    const perSecond = { players: net.bytes.players / 45, watchers: net.bytes.watchers / 45 };
    if (process.env.OUT) {
      writeFileSync(process.env.OUT, JSON.stringify({
        ...perSecond, ratio: perSecond.watchers / perSecond.players,
        playerMessageBytes: net.bytes.players / net.bytes.playerMessages,
        watcherMessageBytes: net.bytes.watchers / net.bytes.watcherMessages,
      }, null, 2));
    }
    expect(net.bytes.watcherMessages).toBeLessThanOrEqual(Math.ceil(net.bytes.playerMessages / SPECTATOR_SEND_EVERY) + 20);
    expect(perSecond.watchers).toBeLessThan(perSecond.players * 0.6);
  }, 120_000);

  it('produces nothing when nobody watches', () => {
    const { net } = botGame('blank', 3);
    net.runUntil(3000);
    expect(net.bytes.playerMessages).toBeGreaterThan(200);
    expect(net.bytes.watcherMessages).toBe(0);
  });

  it('a watcher arriving mid-round starts from a snapshot and misses nothing', () => {
    const { net, host, config } = botGame('pop-culture', 5);
    const level = loadLevelGrid('pop-culture');
    net.runUntil(7000);
    const late = new GuestSession(net.addMember('late', { delayMs: 70, jitterMs: 50 }), null, config.players, { now: net.now, awaitSnapshot: true, selfId: 'late' });
    const mirror = mirrorOf(late, level);
    net.runUntil(7300);
    expect(late.getViewState()).toBeNull();
    const snapshot = host.makeSnapshot();
    const round = host.game.currentRound;
    net.schedule(net.time + 250, () => late.loadSnapshot(snapshot));
    net.runUntil(8500);
    // Stop on a batch boundary so that nothing is left unsent
    while (net.bytes.playerMessages % SPECTATOR_SEND_EVERY !== 0 || net.bytes.watcherMessages * SPECTATOR_SEND_EVERY < net.bytes.playerMessages - 7000 / 14.3) {
      net.runUntil(net.time + 1);
      if (net.time > 9000) break;
    }
    const hostGrid = new PixelGrid();
    hostGrid.copyFrom(host.game.pixels);
    host.step = () => {};
    net.runUntil(net.time + 1000);
    expect(host.game.currentRound).toBe(round);
    expect(late.getViewState()!.round.players.length).toBe(3);
    expect(differences(mirror.grid, hostGrid)).toBeLessThan(40);
    expect(hostGrid.count()).toBeGreaterThan(1000);
  });

  it('extrapolates between messages so that watchers see smooth motion', () => {
    const run = (extrapolate: boolean): { steps: number; stalls: number; maxError: number } => {
      const { net, host, config } = botGame('blank', 7);
      const watcher = new GuestSession(net.addMember('w', { delayMs: 30 }), null, config.players, { now: net.now, selfId: 'w', extrapolate });
      const result = { steps: 0, stalls: 0, maxError: 0 };
      let last: { x: number; y: number } | null = null;
      net.every(() => {
        watcher.step(new Map());
        const view = watcher.getViewState();
        const seen = view?.round.players[0];
        const truth = host.game.players[0]!;
        if (view?.round.phase !== 'playing' || host.game.phase !== 'playing' || !seen?.alive || !truth.alive) {
          last = null;
          return;
        }
        if (last) {
          result.steps++;
          if (last.x === seen.x && last.y === seen.y) result.stalls++;
        }
        last = { x: seen.x, y: seen.y };
        result.maxError = Math.max(result.maxError, Math.hypot(seen.x - truth.x, seen.y - truth.y) / 1000);
      }, 1);
      net.runUntil(8000);
      return result;
    };
    const smooth = run(true);
    const raw = run(false);
    expect(smooth.steps).toBeGreaterThan(100);
    // As received, the picture moves once every 3 ticks
    expect(raw.stalls / raw.steps).toBeGreaterThan(0.5);
    expect(smooth.stalls / smooth.steps).toBeLessThan(0.05);
    // And extrapolating never takes the view further from the truth than not doing it
    expect(smooth.maxError).toBeLessThanOrEqual(raw.maxError + 0.001);
  });
});

describe('seats changing hands at a round start', () => {
  it('a watcher who asks to play becomes a player exactly when the next round starts', () => {
    const { net, host, config } = botGame('bricks', 21, [bot(0), bot(1)]);
    const level = loadLevelGrid('bricks');
    const session = new GuestSession(net.addMember('w', { delayMs: 50, jitterMs: 20 }), null, config.players, { now: net.now, selfId: 'w' });
    const mirror = mirrorOf(session, level);
    const rosters: (SlotIndex | null)[] = [];
    session.onRoster = (players) => rosters.push(players.find(p => p.control.type === 'local')?.slotIndex ?? null);

    // The watcher plays like a guest: wavy steering, action now and then (ready-up)
    let tick = 0;
    const predicted = new Map<number, { x: number; y: number }>();
    let seq = 0;
    net.every(() => {
      tick++;
      const input: TronInput = { steer: tick % 90 < 30 ? 1 : tick % 90 < 60 ? -1 : 0, action: tick % 50 < 5 };
      const wasPlayer = session.getMySlot() !== null && session.getViewState() !== null;
      session.step(new Map<SlotIndex, TronInput>([[2, input]]));
      if (wasPlayer) {
        seq++;
        const p = session.getPredictedPlayer();
        if (p?.alive && session.getViewState()?.round.phase === 'playing') predicted.set(seq, { x: p.x, y: p.y });
      }
    }, 4);
    const errors: number[] = [];
    let lastAck = -1;
    net.every(() => {
      const ack = host.getAck(2);
      if (ack === undefined || ack === lastAck) return;
      lastAck = ack;
      const truth = host.game.players.find(p => p.slotIndex === 2);
      const guess = predicted.get(ack);
      if (guess && truth?.alive && host.game.phase === 'playing') errors.push(Math.hypot(guess.x - truth.x, guess.y - truth.y) / 1000);
      predicted.delete(ack);
    }, 0.5);

    net.runUntil(2000);
    expect(session.getMySlot()).toBeNull();
    const roundAsked = host.game.currentRound;
    host.setNextPlayers([bot(0), bot(1), remote(2, 'w')]);
    // Nothing changes until the round is over
    net.runUntil(2500);
    expect(host.game.currentRound).toBe(roundAsked);
    expect(host.game.players.length).toBe(2);
    expect(session.getMySlot()).toBeNull();

    while (host.game.currentRound === roundAsked && net.time < 120_000) net.runUntil(net.time + 100);
    expect(host.game.currentRound).toBe(roundAsked + 1);
    expect(host.game.players.map(p => p.slotIndex)).toEqual([0, 1, 2]);
    expect(host.game.scores.get(2)).toBe(0);
    net.runUntil(net.time + 300);
    expect(session.getMySlot()).toBe(2);
    expect(rosters).toEqual([2]);
    expect(session.getViewState()!.round.players.find(p => p.slotIndex === 2)!.nickname).toBe('w');

    // Plays for a few rounds, then steps down
    const joinedAt = host.game.currentRound;
    while (host.game.currentRound < joinedAt + 2 && net.time < 300_000) net.runUntil(net.time + 100);
    expect(host.game.currentRound).toBeGreaterThanOrEqual(joinedAt + 2);
    expect(errors.length).toBeGreaterThan(100);
    // Prediction is exact once the first playing states are in (as for any guest)
    const settled = errors.slice(30);
    expect(settled.filter(e => e < 0.01).length / settled.length).toBeGreaterThan(0.97);

    host.setNextPlayers([bot(0), bot(1)]);
    const leftAt = host.game.currentRound;
    while (host.game.currentRound === leftAt && net.time < 400_000) net.runUntil(net.time + 100);
    net.runUntil(net.time + 300);
    expect(host.game.players.map(p => p.slotIndex)).toEqual([0, 1]);
    expect(session.getMySlot()).toBeNull();
    expect(rosters).toEqual([2, null]);
    expect(host.getAck(2)).toBeUndefined();
    expect(host.game.scores.has(2)).toBe(false);

    // Through both stream switches the client applied every tick once
    net.runUntil(net.time + 2000);
    while (net.bytes.playerMessages % SPECTATOR_SEND_EVERY !== 1 && net.time < 500_000) net.runUntil(net.time + 1);
    const hostGrid = new PixelGrid();
    hostGrid.copyFrom(host.game.pixels);
    host.step = () => {};
    net.runUntil(net.time + 1000);
    expect(mirror.rounds).toBe(host.game.currentRound);
    expect(differences(mirror.grid, hostGrid)).toBeLessThan(40);
  }, 240_000);

  it('a human who replaces a bot gets the seat, and the bot stops driving it', () => {
    const { net, host } = botGame('blank', 9, [bot(0), bot(1), bot(2), bot(3)]);
    host.setNextPlayers([bot(0), remote(1, 'ann'), bot(2), bot(3)]);
    const round = host.game.currentRound;
    while (host.game.currentRound === round && net.time < 200_000) net.runUntil(net.time + 100);
    expect(host.getPlayers().map(p => p.control.type)).toEqual(['ai', 'remote', 'ai', 'ai']);
    // Nobody steers slot 1: it goes straight
    net.runUntil(net.time + 3200);
    const p = host.game.players.find(q => q.slotIndex === 1)!;
    expect(p.lastSteer).toBe(0);
  }, 120_000);
});

describe('roster rules in the simulation', () => {
  const finishRound = (game: ReturnType<typeof makeGame>, winner: SlotIndex) => {
    for (const p of game.players) if (p.slotIndex !== winner) p.kill();
    game.tick(inputs());
  };
  const tickUntil = (game: ReturnType<typeof makeGame>, done: () => boolean, input: Map<SlotIndex, TronInput>, max = 1000) => {
    for (let i = 0; i < max && !done(); i++) {
      game.tick(input);
      // Release between presses so that every press is a rising edge
      if (!done()) game.tick(new Map([...input].map(([slot]) => [slot, NO_INPUT])));
    }
  };
  const playing = (game: ReturnType<typeof makeGame>) => { while (game.phase === 'countdown') game.tick(inputs()); };
  const withOwners = (mode: GameMode, owners: string[]): GamePlayer[] =>
    makePlayers(owners.length, mode).map((p, i) => ({ ...p, owner: owners[i]! }));

  it('free-for-all: a newcomer starts at 0, the others keep their wins', () => {
    const game = new TronGameState(withOwners('ffa', ['a', 'b', 'c']), 'ffa', 'blank', createRng(1));
    playing(game);
    finishRound(game, 2);
    expect(game.phase).toBe('waiting_ready');
    expect(game.scores.get(2)).toBe(1);
    // Slot 2 changes hands, slot 1 leaves
    const next = withOwners('ffa', ['a', 'b', 'zoe']).filter(p => p.slotIndex !== 1);
    next[1]!.nickname = 'Zoe';
    game.setNextPlayers(next);
    expect(game.players.length).toBe(3);   // Not before the round starts
    // Only slot 0 stays: its "ready" is enough
    tickUntil(game, () => game.currentRound === 2, new Map([[0 as SlotIndex, { steer: 0, action: true }]]));
    expect(game.currentRound).toBe(2);
    expect(game.players.map(p => p.slotIndex)).toEqual([0, 2]);
    expect(game.players[1]!.nickname).toBe('Zoe');
    expect(game.scores.get(2)).toBe(0);
    expect(game.scores.has(1)).toBe(false);
    expect(game.serialize().match.scores).toEqual({ 0: 0, 2: 0 });
    expect(game.rosterVersion).toBe(1);
  });

  it('team mode: the newcomer inherits the wins of the seat', () => {
    const game = new TronGameState(withOwners('team', ['a', 'b', 'ai', 'd']), 'team', 'blank', createRng(1));
    playing(game);
    game.players[1]!.kill();
    game.players[3]!.kill();
    game.tick(inputs());
    expect(game.scores.get(2)).toBe(1);
    game.ridiculousDeaths.set(2, 3);
    game.setNextPlayers(withOwners('team', ['a', 'b', 'zoe', 'd']));
    const ready = new Map<SlotIndex, TronInput>([0, 1, 3].map(s => [s as SlotIndex, { steer: 0, action: true }]));
    tickUntil(game, () => game.currentRound === 2, ready);
    expect(game.currentRound).toBe(2);
    expect(game.scores.get(2)).toBe(1);
    expect(game.ridiculousDeaths.get(2)).toBe(0);
    expect(game.scores.get(0)).toBe(1);
  });

  it('a round with no roster change waits for everybody, as before', () => {
    const game = makeGame(3);
    playing(game);
    finishRound(game, 0);
    const two = new Map<SlotIndex, TronInput>([[0, { steer: 0, action: true }], [1, { steer: 0, action: true }]]);
    tickUntil(game, () => game.currentRound === 2, two, 200);
    expect(game.currentRound).toBe(1);
    expect(game.rosterVersion).toBe(0);
  });

  it('when nobody stays, the next round starts after the ready lock', () => {
    const game = new TronGameState(withOwners('ffa', ['a', 'b']), 'ffa', 'blank', createRng(1));
    playing(game);
    finishRound(game, 0);
    game.setNextPlayers(withOwners('ffa', ['x', 'y']));
    let ticks = 0;
    while (game.currentRound === 1 && ticks < 500) { game.tick(inputs()); ticks++; }
    expect(game.currentRound).toBe(2);
    expect(ticks).toBeGreaterThanOrEqual(69);
    expect(ticks).toBeLessThan(80);
  });
});
