// Room codes (no browser or network dependencies)

// Word list for human-friendly room codes (short, common, phonetically distinct)
const ROOM_WORDS = [
  'red', 'blue', 'gold', 'jade', 'pink', 'gray', 'lime', 'plum', 'rose', 'teal',
  'bear', 'bird', 'crab', 'deer', 'duck', 'fish', 'frog', 'goat', 'hawk', 'lion',
  'moon', 'star', 'rain', 'snow', 'wind', 'fire', 'lake', 'rock', 'sand', 'wave',
  'cake', 'drum', 'fork', 'harp', 'kite', 'lamp', 'mask', 'ring', 'vase', 'bell',
  'arch', 'barn', 'cave', 'dome', 'gate', 'hill', 'mill', 'pier', 'tower', 'well',
];

/** A speakable room code like "red-bear-moon". */
export function generateRoomCode(): string {
  const pick = (): string => ROOM_WORDS[Math.floor(Math.random() * ROOM_WORDS.length)]!;
  return `${pick()}-${pick()}-${pick()}`;
}

/** Lowercase, spaces to hyphens: "Red Bear  moon" -> "red-bear-moon". */
export function normalizeRoomCode(input: string): string {
  return input.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
}
