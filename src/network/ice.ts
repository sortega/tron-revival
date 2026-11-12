// ICE / TURN configuration. See design/networking.md ("Connectivity").

export interface IceSetup {
  /** TURN servers to add to Trystero's default STUN servers. */
  turnConfig: { urls: string | string[]; username?: string; credential?: string }[];
  /** Force all traffic through TURN (`?relay=1`), to test the cross-network path locally. */
  forceRelay: boolean;
}

const env = import.meta.env as Record<string, string | undefined>;
const ICE_FETCH_TIMEOUT_MS = 4000;

export function isRelayForced(): boolean {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('relay') === '1';
}

function staticTurn(): IceSetup['turnConfig'] {
  const urls = (env.VITE_TURN_URLS ?? '').split(',').map(u => u.trim()).filter(Boolean);
  if (urls.length === 0) return [];
  return [{ urls, username: env.VITE_TURN_USERNAME, credential: env.VITE_TURN_CREDENTIAL }];
}

// Keep only well-formed TURN entries from a credentials endpoint
function parseIceServers(json: unknown): IceSetup['turnConfig'] {
  const list = Array.isArray(json) ? json : (json as { iceServers?: unknown })?.iceServers;
  const entries = Array.isArray(list) ? list : list ? [list] : [];
  const result: IceSetup['turnConfig'] = [];
  for (const entry of entries as { urls?: unknown; username?: unknown; credential?: unknown }[]) {
    const urls = (Array.isArray(entry?.urls) ? entry.urls : [entry?.urls])
      .filter((u): u is string => typeof u === 'string' && /^turns?:/.test(u));
    if (urls.length === 0) continue;
    result.push({
      urls,
      username: typeof entry.username === 'string' ? entry.username : undefined,
      credential: typeof entry.credential === 'string' ? entry.credential : undefined,
    });
  }
  return result;
}

let cached: Promise<IceSetup> | null = null;

/** Resolve the TURN configuration (static env vars and/or a credentials endpoint). */
export function loadIceSetup(): Promise<IceSetup> {
  cached ??= (async () => {
    let turnConfig = staticTurn();
    const url = env.VITE_ICE_SERVERS_URL;
    if (url) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ICE_FETCH_TIMEOUT_MS);
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        turnConfig = [...turnConfig, ...parseIceServers(await response.json())];
      } catch (err) {
        console.warn('[ice] Could not load TURN credentials; continuing without them:', err);
      }
    }
    return { turnConfig, forceRelay: isRelayForced() };
  })();
  return cached;
}
