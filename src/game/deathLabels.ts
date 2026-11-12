// Wording of deaths on the round summary. See design/architecture.md (Rendering).

import type { DeathCause } from '../types/game';

// How a death reads on the round summary. `killer` is the name of whoever did it
// (null if nobody or unknown); `self` when the victim did it to themselves; `level`
// when it was a level gun.
export function describeDeath(cause: DeathCause, killer: string | null, self: boolean, level: boolean): string {
  switch (cause) {
    case 'trail': return killer ? `crashed into ${killer}'s trail` : 'crashed into a trail';
    case 'own-trail': return 'crashed into their own trail';
    case 'level': return 'crashed into the scenery';
    case 'crossing': return killer ? `head-on collision with ${killer}` : 'head-on collision';
    case 'tracer':
      if (level) return 'shot by the level';
      return self ? 'shot by their own bullet' : killer ? `shot by ${killer}` : 'shot';
    case 'bullet': return self ? 'blown up by their own bullet' : killer ? `blown up by ${killer}` : 'blown up';
    case 'bomb': return self ? 'bombed by their own bomb' : killer ? `bombed by ${killer}` : 'bombed';
    case 'bodyguard': return killer ? `killed by ${killer}'s satellite` : 'killed by a satellite';
    case 'door': return 'crushed by a door';
  }
}
