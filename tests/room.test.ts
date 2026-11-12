import { describe, expect, it } from 'vitest';
import {
  buildGameConfig, canStart, createSharedRoom, isRoomWriteAllowed, reconcile, sanitizeName, slotOfUser, toLobbyState,
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
