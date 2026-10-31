// Member invite codes, bridge side. The bridge router (api/bridge.ts) checks the BRIDGE_TOKEN and delegates
// `/api/bridge/invites/...` here with `path` = the segments after `invites`.
//   POST /api/bridge/invites  { od: <stub DID>, blazeId, note? }  -> { code, slug, persona, joinUrl }
//   GET  /api/bridge/invites?od=N                                 -> { slug, invites: [...] } (open invites)
// This is the only way to get a dynasty's first invite (the site cannot issue invites until a commissioner has an
// account), so whoever bootstraps accounts has proven control of the league server.
import type { Env } from '../env.js';
import { json } from '../html.js';
import { getDynastyByOdId, getMembers, getAccountForMember, insertInvite, listOpenInvites } from '../db/queries.js';
import { newInviteCode, joinUrl } from '../session.js';

async function readBody(req: Request): Promise<any> {
  try {
    if (req.headers.get('x-content-encoding') === 'gzip' && req.body) return JSON.parse(await new Response(req.body.pipeThrough(new DecompressionStream('gzip'))).text());
    return await req.json();
  } catch { return {}; }
}
const dynastyByOd = (db: D1Database, v: unknown) => { const n = Number(v); return Number.isInteger(n) ? getDynastyByOdId(db, n) : Promise.resolve(null); };

export async function handleInvites(req: Request, env: Env, path: string[]): Promise<Response> {
  const db = env.DB, url = new URL(req.url);
  if (path.length) return json({ error: 'not found' }, 404);

  if (req.method === 'GET') {
    const dyn = await dynastyByOd(db, url.searchParams.get('od'));
    if (!dyn) return json({ error: 'unknown dynasty (pass ?od=<stub DID>)' }, 404);
    const personas = new Map((await getMembers(db, dyn.id)).map((m) => [m.blaze_id, m.persona]));
    const invites = (await listOpenInvites(db, dyn.id)).map((i) => ({ code: i.code, blazeId: i.blaze_id, persona: personas.get(i.blaze_id) ?? null, note: i.note, createdAt: i.created_at, joinUrl: joinUrl(url.origin, dyn.slug, i.code) }));
    return json({ slug: dyn.slug, invites });
  }

  if (req.method === 'POST') {
    const body = await readBody(req);
    const dyn = await dynastyByOd(db, body.od);
    if (!dyn) return json({ error: 'unknown dynasty (body.od = stub DID)' }, 404);
    const blazeId = Number(body.blazeId);
    const member = (await getMembers(db, dyn.id)).find((m) => m.blaze_id === blazeId);
    if (!member) return json({ error: `no member with blazeId ${body.blazeId} in ${dyn.slug}` }, 404);
    const existing = await getAccountForMember(db, dyn.id, blazeId);
    if (existing) return json({ error: `${member.persona} already has an account (${existing.username})` }, 409);
    const code = newInviteCode();
    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 120) : 'issued by the bridge';
    await insertInvite(db, code, dyn.id, blazeId, null, note);
    return json({ code, slug: dyn.slug, blazeId, persona: member.persona, joinUrl: joinUrl(url.origin, dyn.slug, code) });
  }

  return json({ error: 'method not allowed' }, 405);
}
