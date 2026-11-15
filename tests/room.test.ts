import { describe, expect, it } from 'vitest';
import {
  MAX_WATCHERS, audienceOf, buildGameConfig, canStart, createSharedRoom, isRoomWriteAllowed, planNextRound, reconcile,
  sanitizeName, slotOfUser, toLobbyState,
} from '../src/network/roomLogic';
import type { Profile, SharedRoom } from '../src/network/roomLogic';

const profiles = (entries: Record<string, Partial<Profile> | null>): Record<string, Profile | null> =>
  Object.fromEntries(Object.entries(entries).map(([id, p]) => [id, p && { name: id, want: -1, ...p }]));

describe('lobby reconciliation', () => {
  it('seats users in the first free slot, host included', () => {
    let room = createSharedRoom('host');
    room = reconcile(room, profiles({ host: {}, ann: {}, bob: {} }));
    expect(room.slots.map(s => s?.userId)).toEqual(['host', 'ann', 'bob', undefined]);
    expect(slotOfUser(room, 'ann')).toBe(1);
  });

  it('is stable: reconciling again changes nothing', () => {
    const p = profiles({ host: {}, ann: {} });
    const once = reconcile(createSharedRoom('host'), p);
    expect(reconcile(once, p)).toBe(once);
  });

  it('honours a requested free slot and ignores a taken one', () => {
    let room = reconcile(createSharedRoom('host'), profiles({ host: {}, ann: { want: 3 } }));
    expect(room.slots.map(s => s?.userId)).toEqual(['host', undefined, undefined, 'ann']);
    // Ann asks for the host's seat: stays where she is
    room = reconcile(room, profiles({ host: {}, ann: { want: 0 } }));
    expect(slotOfUser(room, 'ann')).toBe(3);
    // Ann moves to a free one
    room = reconcile(room, profiles({ host: {}, ann: { want: 1 } }));
    expect(room.slots.map(s => s?.userId)).toEqual(['host', 'ann', undefined, undefined]);
  });

  it('frees the seat of spectators and of users who left the lobby', () => {
    let room = reconcile(createSharedRoom('host'), profiles({ host: {}, ann: {}, bob: {} }));
    room = reconcile(room, profiles({ host: {}, ann: { want: null }, bob: {} }));
    expect(room.slots.map(s => s?.userId)).toEqual(['host', undefined, 'bob', undefined]);
    room = reconcile(room, profiles({ host: {} }));
    expect(room.slots.map(s => s?.userId)).toEqual(['host', undefined, undefined, undefined]);
  });

  it('keeps seats of disconnected players during a game, and seats nobody new', () => {
    let room = reconcile(createSharedRoom('host'), profiles({ host: {}, ann: {} }));
    room = { ...room, phase: 'game' };
    const during = reconcile(room, profiles({ host: {}, late: {} }));
    expect(during.slots.map(s => s?.userId)).toEqual(['host', 'ann', undefined, undefined]);
    // Ann returns (same userId): nothing to do
    expect(reconcile(during, profiles({ host: {}, ann: {}, late: {} }))).toBe(during);
    // Back in the lobby, the latecomer gets a seat
    const lobby = reconcile({ ...during, phase: 'lobby' }, profiles({ host: {}, ann: {}, late: {} }));
    expect(lobby.slots.map(s => s?.userId)).toEqual(['host', 'ann', 'late', undefined]);
  });

  it('never touches bot seats and does not seat users on them', () => {
    let room = createSharedRoom('host');
    room.slots[0] = { ai: 'hard', name: 'Red Bot' };
    room = reconcile(room, profiles({ host: { want: 0 }, ann: {} }));
    expect(room.slots.map(s => s?.ai ?? s?.userId)).toEqual(['hard', 'host', 'ann', undefined]);
  });

  it('updates and sanitises nicknames', () => {
    let room = reconcile(createSharedRoom('host'), profiles({ host: { name: '  Big   Boss ' } }));
    expect(room.slots[0]!.name).toBe('Big Boss');
    room = reconcile(room, profiles({ host: { name: 'x'.repeat(100) } }));
    expect(room.slots[0]!.name.length).toBe(24);
    expect(sanitizeName('', 'Fallback')).toBe('Fallback');
    expect(sanitizeName(42)).toBe('Player');
  });

  it('tolerates malformed profiles from peers', () => {
    const room = reconcile(createSharedRoom('host'), {
      host: { name: 'h', want: -1 },
      evil: { name: { toString: 1 } as unknown as string, want: 99 },
      gone: null,
    });
    expect(room.slots.map(s => s?.userId)).toEqual(['host', 'evil', undefined, undefined]);
    expect(room.slots[1]!.name).toBe('Player');
  });
});

describe('room authority', () => {
  const room = createSharedRoom('host');
  it('lets the first writer become host', () => {
    expect(isRoomWriteAllowed(null, room, 'host')).toBe(true);
    expect(isRoomWriteAllowed(null, room, 'mallory')).toBe(false);
  });
  it('rejects writes by anyone but the host, and host takeover', () => {
    expect(isRoomWriteAllowed(room, { ...room, gameMode: 'team' }, 'host')).toBe(true);
    expect(isRoomWriteAllowed(room, { ...room, phase: 'game' }, 'mallory')).toBe(false);
    expect(isRoomWriteAllowed(room, { ...room, hostId: 'mallory' }, 'mallory')).toBe(false);
    expect(isRoomWriteAllowed(room, { ...room, slots: [] } as SharedRoom, 'host')).toBe(false);
  });
});

describe('game configuration', () => {
  const room: SharedRoom = {
    ...createSharedRoom('host'),
    slots: [{ userId: 'host', name: 'H' }, { ai: 'normal', name: 'Green Bot' }, null, { userId: 'ann', name: 'A' }],
  };

  it('requires 2 players for FFA and 4 for teams', () => {
    expect(canStart(room)).toBe(true);
    expect(canStart({ ...room, gameMode: 'team' })).toBe(false);
    expect(canStart({ ...room, slots: [room.slots[0]!, null, null, null] })).toBe(false);
  });

  it('gives each participant the right controls', () => {
    const host = buildGameConfig(room, 'host');
    expect(host.players.map(p => [p.slotIndex, p.control.type])).toEqual([[0, 'local'], [1, 'ai'], [3, 'remote']]);
    const guest = buildGameConfig(room, 'ann');
    expect(guest.players.map(p => [p.slotIndex, p.control.type])).toEqual([[0, 'remote'], [1, 'remote'], [3, 'local']]);
    const spectator = buildGameConfig(room, 'zoe');
    expect(spectator.players.every(p => p.control.type === 'remote')).toBe(true);
  });

  it('builds the lobby view model', () => {
    const view = toLobbyState('red-bear-moon', room, profiles({ host: {}, ann: {}, zoe: { name: 'Zoe' } }));
    expect(view.slots.map(s => s.peerId)).toEqual(['host', 'ai:1', null, 'ann']);
    expect(view.slots[0]!.isHost).toBe(true);
    expect(view.slots[1]!.ai).toBe('normal');
    expect(view.spectators).toEqual([{ peerId: 'zoe', nickname: 'Zoe' }]);
  });
});

describe('spectators', () => {
  const ids = (slots: SharedRoom['slots']) => slots.map(s => s?.userId ?? (s?.ai ? `bot:${s.ai}` : null));
  const inGame = (entries: Record<string, Partial<Profile> | null>, mode: SharedRoom['gameMode'] = 'ffa'): SharedRoom =>
    ({ ...reconcile({ ...createSharedRoom('host'), gameMode: mode }, profiles(entries)), phase: 'game' });

  it('admits watchers in order of arrival, up to the limit', () => {
    let room = inGame({ host: {}, ann: {} });
    const present: Record<string, Partial<Profile> | null> = { host: {}, ann: {} };
    for (let i = 1; i <= MAX_WATCHERS + 2; i++) {
      present[`w${i}`] = {};
      room = reconcile(room, profiles(present));
    }
    expect(room.watchers).toEqual(Array.from({ length: MAX_WATCHERS }, (_, i) => `w${i + 1}`));
    expect(ids(room.slots)).toEqual(['host', 'ann', null, null]);   // Nobody is seated during a game
    // One leaves: the next one in gets the place
    delete present.w2;
    room = reconcile(room, profiles(present));
    expect(room.watchers).toHaveLength(MAX_WATCHERS);
    expect(room.watchers).toContain(`w${MAX_WATCHERS + 1}`);
    expect(room.watchers).not.toContain('w2');
    // A watcher who reloads (absent, then back) is not guaranteed the place, but those inside stay
    expect(reconcile(room, profiles(present))).toBe(room);
  });

  it('never refuses the host or somebody who had a seat', () => {
    const present: Record<string, Partial<Profile> | null> = { host: {}, ann: {}, bob: {}, cat: {} };
    for (let i = 1; i <= MAX_WATCHERS; i++) present[`w${i}`] = {};
    let room = reconcile(createSharedRoom('host'), profiles(present));
    expect(room.watchers).toHaveLength(MAX_WATCHERS);
    // Host and Ann leave their seats in the lobby
    present.host = { want: null };
    present.ann = { want: null };
    room = reconcile(room, profiles(present));
    expect(room.watchers).toContain('host');
    expect(room.watchers).toContain('ann');
  });

  it('queues those who ask to play, in the order they asked', () => {
    let room = inGame({ host: {}, ann: {}, bob: {}, cat: {} });
    room = reconcile(room, profiles({ host: {}, ann: {}, bob: {}, cat: {}, zoe: { joinNext: true }, yan: {} }));
    room = reconcile(room, profiles({ host: {}, ann: {}, bob: {}, cat: {}, zoe: { joinNext: true }, yan: { joinNext: true } }));
    expect(room.queue).toEqual(['zoe', 'yan']);
    // Zoe changes her mind
    room = reconcile(room, profiles({ host: {}, ann: {}, bob: {}, cat: {}, zoe: {}, yan: { joinNext: true } }));
    expect(room.queue).toEqual(['yan']);
    expect(toLobbyState('x', room, profiles({ host: {}, yan: {}, zoe: {} })).spectators)
      .toEqual([{ peerId: 'yan', nickname: 'yan', queued: true }, { peerId: 'zoe', nickname: 'zoe' }]);
  });

  describe('next round', () => {
    it('changes nothing when nobody asked for anything', () => {
      const room = inGame({ host: {}, ann: {} });
      expect(planNextRound(room, profiles({ host: {}, ann: {}, zoe: {} }))).toBe(room.slots);
    });

    it('gives a queued spectator a free seat before a bot\'s', () => {
      let room = inGame({ host: {}, ann: {} });
      room.slots[2] = { ai: 'hard', name: 'Blue Bot' };
      const present = profiles({ host: {}, ann: {}, zoe: { joinNext: true, name: 'Zoe' }, yan: { joinNext: true } });
      room = reconcile(room, present);
      expect(ids(planNextRound(room, present))).toEqual(['host', 'ann', 'yan', 'zoe']);
      expect(planNextRound(room, present)[3]).toEqual({ userId: 'zoe', name: 'Zoe' });
    });

    it('replaces bots with humans, never humans, and keeps the rest waiting', () => {
      let room = inGame({ host: {}, ann: {}, bob: {} });
      room.slots[3] = { ai: 'easy', name: 'Yellow Bot' };
      const present = profiles({ host: {}, ann: {}, bob: {}, zoe: { joinNext: true }, yan: { joinNext: true } });
      room = reconcile(room, present);
      expect(ids(planNextRound(room, present))).toEqual(['host', 'ann', 'bob', 'zoe']);
      const audience = audienceOf(room, present, 'yan');
      expect(audience).toMatchObject({ spectators: 2, joining: ['zoe'], waiting: ['yan'], me: 'waiting', queuePosition: 1 });
      expect(audienceOf(room, present, 'zoe').me).toBe('joining');
      expect(audienceOf(room, present, 'ann').me).toBe('playing');
    });

    it('frees the seat of a player who steps down, for the first in the queue', () => {
      let room = inGame({ host: {}, ann: {}, bob: {}, cat: {} });
      const present = profiles({ host: {}, ann: { want: null }, bob: {}, cat: {}, zoe: { joinNext: true } });
      room = reconcile(room, present);
      expect(ids(room.slots)).toEqual(['host', 'ann', 'bob', 'cat']);   // Ann plays this round out
      expect(ids(planNextRound(room, present))).toEqual(['host', 'zoe', 'bob', 'cat']);
      expect(audienceOf(room, present, 'ann')).toMatchObject({ me: 'leaving', leaving: ['ann'], joining: ['zoe'] });
    });

    it('keeps the seat of a player who vanished, unless they said goodbye', () => {
      const room = inGame({ host: {}, ann: {}, bob: {} });
      const present = profiles({ host: {}, bob: {} });
      expect(planNextRound(room, present)).toBe(room.slots);
      expect(ids(planNextRound(room, present, new Set(['ann'])))).toEqual(['host', null, 'bob', null]);
    });

    it('fills in with bots when the game would fall below its minimum', () => {
      const ffa = inGame({ host: {}, ann: {} });
      expect(ids(planNextRound(ffa, profiles({ host: {}, ann: { want: null } })))).toEqual(['host', 'bot:normal', null, null]);
      const team = inGame({ host: {}, ann: {}, bob: {}, cat: {} }, 'team');
      const next = planNextRound(team, profiles({ host: {}, ann: {}, bob: { want: null }, cat: {} }));
      expect(ids(next)).toEqual(['host', 'ann', 'bot:normal', 'cat']);
      expect(next[2]!.name).toBe('Purple Bot');
      // With somebody waiting, the newcomer takes that team seat instead
      const present = profiles({ host: {}, ann: {}, bob: { want: null }, cat: {}, zoe: { joinNext: true } });
      expect(ids(planNextRound(reconcile(team, present), present))).toEqual(['host', 'ann', 'zoe', 'cat']);
    });

    it('picks up new nicknames', () => {
      const room = inGame({ host: {}, ann: {} });
      expect(planNextRound(room, profiles({ host: {}, ann: { name: 'Annie' } }))[1]!.name).toBe('Annie');
    });
  });

  it('back in the lobby, those who were waiting are seated first', () => {
    let room = inGame({ host: {}, ann: {}, bob: {}, cat: {} });
    const present = { yan: {}, host: {}, ann: {}, bob: {}, zoe: { joinNext: true } };
    room = reconcile(room, profiles(present));
    // Cat left during the game; the room returns to the lobby
    room = reconcile({ ...room, phase: 'lobby' }, profiles(present));
    expect(ids(room.slots)).toEqual(['host', 'ann', 'bob', 'zoe']);
    expect(room.queue).toEqual([]);
    expect(room.watchers).toEqual(['yan']);
  });

  it('marks who owns each slot in the game configuration', () => {
    const room: SharedRoom = {
      ...createSharedRoom('host'),
      slots: [{ userId: 'host', name: 'H' }, { ai: 'normal', name: 'Green Bot' }, null, null],
    };
    expect(buildGameConfig(room, 'host').players.map(p => p.owner)).toEqual(['host', 'ai']);
  });
});
