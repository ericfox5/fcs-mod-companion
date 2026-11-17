// GET /api/bridge/league-registry: the list of league identities the public league server authenticates against
// (spike/blaze/server/league-auth.mjs validateRegistry / authenticate). The bridge router (api/bridge.ts) has already
// checked the bearer: `Authorization: Bearer <token>`, where the token is REGISTRY_TOKEN (a secret good for this route
// only; the one to give the league server) or the full BRIDGE_TOKEN. The response is
//   { version: 1, generatedAt: <ISO time>, players: [{ userId, onlineId, ticketSha256, joinDynasties: [], disabled }] }
// with an ETag computed from `players` alone (generatedAt changes on every call and is left out of it), so a poller
// that sends If-None-Match gets 304 with no body until a member signs up, regenerates or is disabled or enabled.
import type { Env } from '../env.js';
import { json } from '../html.js';
import { sha256Hex } from '../session.js';
import { registryPlayers } from '../league.js';

const etagMatches = (header: string | null, etag: string) =>
  !!header && header.split(',').map((t) => t.trim().replace(/^W\//, '')).some((t) => t === '*' || t === etag);

export async function leagueRegistry(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return json({ error: 'method not allowed' }, 405, { allow: 'GET, HEAD' });
  const players = await registryPlayers(env.DB);
  const etag = `"${(await sha256Hex(JSON.stringify(players))).slice(0, 40)}"`;
  const headers = { etag, 'cache-control': 'private, no-cache' };
  if (etagMatches(req.headers.get('if-none-match'), etag)) return new Response(null, { status: 304, headers });
  if (req.method === 'HEAD') return new Response(null, { status: 200, headers: { ...headers, 'content-type': 'application/json; charset=utf-8' } });
  return json({ version: 1, generatedAt: new Date().toISOString(), players }, 200, headers);
}
