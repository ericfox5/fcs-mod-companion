// League downloads (the roster saves offered on the landing page): R2 objects under downloads/<file>, put there with
// `wrangler r2 object put ncaa-online-saves/downloads/<file> --file <zip>`, served as attachments from /downloads/<file>.
import type { Env } from '../env.js';
import { json } from '../html.js';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

export async function serveDownload(env: Env, name: string): Promise<Response> {
  if (!NAME_RE.test(name) || name.includes('..')) return json({ error: 'not found' }, 404);
  const obj = await env.SAVES.get(`downloads/${name}`);
  if (!obj) return json({ error: 'not found' }, 404);
  const h = new Headers();
  obj.writeHttpMetadata(h);
  if (!h.get('content-type')) h.set('content-type', name.endsWith('.zip') ? 'application/zip' : 'application/octet-stream');
  h.set('content-disposition', `attachment; filename="${name}"`);
  h.set('content-length', String(obj.size));
  h.set('cache-control', 'public, max-age=600'); // a replaced roster shows up within minutes
  h.set('etag', obj.httpEtag);
  return new Response(obj.body, { headers: h });
}
