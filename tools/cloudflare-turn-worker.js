// Example Cloudflare Worker that mints short-lived TURN credentials for Teratron.
//
// 1. In the Cloudflare dashboard create a TURN key (Realtime -> TURN). Note the key id
//    and API token.
// 2. Deploy this worker with two secrets: TURN_KEY_ID and TURN_KEY_API_TOKEN.
//    (`npx wrangler deploy tools/cloudflare-turn-worker.js --name teratron-ice`,
//     `npx wrangler secret put TURN_KEY_ID`, `npx wrangler secret put TURN_KEY_API_TOKEN`)
// 3. Set ALLOWED_ORIGIN below to where the game is hosted.
// 4. Build the game with VITE_ICE_SERVERS_URL=https://teratron-ice.<you>.workers.dev
//
// The game accepts either a JSON array of RTCIceServer objects or {iceServers: ...}.
// Check Cloudflare's current TURN documentation if the endpoint below has changed:
// https://developers.cloudflare.com/realtime/turn/

const ALLOWED_ORIGIN = 'https://sortega.github.io';
const CREDENTIAL_TTL_SECONDS = 4 * 60 * 60;

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Cache-Control': 'no-store',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: CREDENTIAL_TTL_SECONDS }),
      }
    );
    if (!response.ok) return new Response('[]', { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } });
    return new Response(await response.text(), { headers: { ...cors, 'Content-Type': 'application/json' } });
  },
};
