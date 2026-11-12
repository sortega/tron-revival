import { describe, expect, it } from 'vitest';
import { HostSession } from '../src/game/session/HostSession';
import { createRng } from '../src/game/rng';
import { FFA_COLORS } from '../src/types/lobby';
import type { SlotIndex } from '../src/types/lobby';
import type { GameConfig, TronGameStateData } from '../src/types/game';
import { buildLocalConfig, canStartLocal, assignSchemes } from '../src/game/localSetup';

function localConfig(): GameConfig {
  return {
    players: [
      { slotIndex: 0, nickname: 'Human', color: FFA_COLORS[0], control: { type: 'local', scheme: 'solo' } },
      { slotIndex: 1, nickname: 'Bot', color: FFA_COLORS[1], control: { type: 'ai', difficulty: 'normal' } },
    ],
    gameMode: 'ffa',
    levelMode: 'blank',
  };
}

describe('HostSession (local game)', () => {
  it('delivers every frame once, starting with the initial frame', () => {
    const session = new HostSession(localConfig(), { rng: createRng(1), now: () => 0 });
    const frames: TronGameStateData[] = [];
    session.onFrame = f => frames.push(f);
    expect(session.getViewState().round.phase).toBe('countdown');
    for (let i = 0; i < 10; i++) session.step(new Map());
    expect(frames.length).toBe(11);
    expect(frames[0]!.roundStarted).toBe(true);
    expect(frames.slice(1).some(f => f.roundStarted)).toBe(false);
    expect(session.getNetworkStats()).toBeNull();
    expect(session.runsInBackground).toBe(false);
  });

  it('applies local input and lets bots drive their own slots', () => {
    const session = new HostSession(localConfig(), { rng: createRng(2), now: () => 0 });
    const left = new Map<SlotIndex, { steer: number; action: boolean }>([[0, { steer: -1, action: false }]]);
    // Input for the bot slot must be ignored
    left.set(1, { steer: 1, action: true });
    let playingTicks = 0;
    while (playingTicks < 40) {
      const wasPlaying = session.game.phase === 'playing';
      session.step(left);
      if (wasPlaying) playingTicks++;
    }
    const [human, bot] = session.game.players;
    // 40 ticks of full left lock from 45°
    expect(human!.direction).toBeCloseTo((45 - 40 * 4 + 720) % 360, 5);
    expect(bot!.alive).toBe(true);
    expect(bot!.lastAction).toBe(false);
  });

  it('bots ready up so an all-bot game keeps going', () => {
    const config = localConfig();
    config.players[0]!.control = { type: 'ai', difficulty: 'easy' };
    const session = new HostSession(config, { rng: createRng(3), now: () => 0 });
    for (let i = 0; i < 70 * 240 && session.game.currentRound < 3; i++) session.step(new Map());
    expect(session.game.currentRound).toBeGreaterThanOrEqual(3);
  }, 60_000);
});

describe('local setup', () => {
  it('assigns solo keys to a lone human and distinct schemes otherwise', () => {
    expect([...assignSchemes(['human', 'ai-easy', 'off', 'off'])]).toEqual([[0, 'solo']]);
    expect([...assignSchemes(['human', 'off', 'human', 'human'])]).toEqual([[0, 'arrows'], [2, 'wasd'], [3, 'ijkl']]);
  });

  it('validates player counts per mode', () => {
    expect(canStartLocal({ slots: ['human', 'off', 'off', 'off'], gameMode: 'ffa', levelMode: 'cycle' })).toBe(false);
    expect(canStartLocal({ slots: ['human', 'ai-hard', 'off', 'off'], gameMode: 'ffa', levelMode: 'cycle' })).toBe(true);
    expect(canStartLocal({ slots: ['human', 'ai-hard', 'ai-easy', 'off'], gameMode: 'team', levelMode: 'cycle' })).toBe(false);
  });

  it('builds a game config', () => {
    const config = buildLocalConfig({ slots: ['human', 'off', 'ai-hard', 'off'], gameMode: 'ffa', levelMode: 'bus' });
    expect(config.players.map(p => p.slotIndex)).toEqual([0, 2]);
    expect(config.players[0]!.control).toEqual({ type: 'local', scheme: 'solo' });
    expect(config.players[1]!.control).toEqual({ type: 'ai', difficulty: 'hard' });
    expect(config.levelMode).toBe('bus');
  });
});
