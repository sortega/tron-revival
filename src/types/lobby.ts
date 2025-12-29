// Lobby types for Teratron

export type SlotIndex = 0 | 1 | 2 | 3;
export type GameMode = 'ffa' | 'team';

// FFA colors
export const FFA_COLORS: Record<SlotIndex, string> = {
  0: '#f44', // Red
  1: '#4f4', // Green
  2: '#44f', // Blue
  3: '#ff4', // Yellow
};

export const FFA_COLOR_NAMES: Record<SlotIndex, string> = {
  0: 'Red',
  1: 'Green',
  2: 'Blue',
  3: 'Yellow',
};

// Team colors
export const TEAM_COLORS = {
  purple: '#a0a', // Team Purple (slots 0, 2)
  brown: '#a60',  // Team Brown (slots 1, 3)
};

export function getSlotColor(mode: GameMode, slotIndex: SlotIndex): string {
  if (mode === 'ffa') {
    return FFA_COLORS[slotIndex];
  }
  // Team mode: slots 0,2 = purple, slots 1,3 = brown
  return slotIndex % 2 === 0 ? TEAM_COLORS.purple : TEAM_COLORS.brown;
}

export function getSlotColorName(mode: GameMode, slotIndex: SlotIndex): string {
  if (mode === 'ffa') {
    return FFA_COLOR_NAMES[slotIndex];
  }
  return slotIndex % 2 === 0 ? 'Purple' : 'Brown';
}

export interface PlayerSlot {
  slotIndex: SlotIndex;
  peerId: string | null;  // null = slot is open
  nickname: string;
  isHost: boolean;
}

export interface ChatMessage {
  id: string;
  senderSlotIndex: SlotIndex | null; // null for non-players
  senderNickname: string;
  text: string;
  timestamp: number;
}

export interface UnassignedPeer {
  peerId: string;
  nickname: string;
}

export interface LobbyState {
  roomId: string;
  hostPeerId: string;
  gameMode: GameMode;
  slots: [PlayerSlot, PlayerSlot, PlayerSlot, PlayerSlot];
  chatMessages: ChatMessage[];
  unassignedPeers: UnassignedPeer[];
}

export function createEmptySlot(slotIndex: SlotIndex): PlayerSlot {
  return {
    slotIndex,
    peerId: null,
    nickname: '',
    isHost: false,
  };
}

export function createInitialLobbyState(roomId: string, hostPeerId: string): LobbyState {
  // All slots start empty - host will choose their slot
  const slots: [PlayerSlot, PlayerSlot, PlayerSlot, PlayerSlot] = [
    createEmptySlot(0),
    createEmptySlot(1),
    createEmptySlot(2),
    createEmptySlot(3),
  ];

  return {
    roomId,
    hostPeerId,
    gameMode: 'ffa',
    slots,
    chatMessages: [],
    unassignedPeers: [],
  };
}

export function getFilledSlotCount(state: LobbyState): number {
  return state.slots.filter(s => s.peerId !== null).length;
}

export function canStartGame(state: LobbyState): boolean {
  const filled = getFilledSlotCount(state);
  if (state.gameMode === 'ffa') {
    return filled >= 2;
  }
  // Team mode requires all 4 slots
  return filled === 4;
}

export function findFirstOpenSlot(state: LobbyState): SlotIndex | null {
  for (const slot of state.slots) {
    if (slot.peerId === null) {
      return slot.slotIndex;
    }
  }
  return null;
}

export function findSlotByPeerId(state: LobbyState, peerId: string): PlayerSlot | null {
  return state.slots.find(s => s.peerId === peerId) ?? null;
}
