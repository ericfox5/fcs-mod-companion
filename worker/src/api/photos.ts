// Image store in R2: photos/players/<file> (the league's real player photos), photos/faces/<n>.png (the game's face
// art), logos/teams/<espn id>.png and logos/conf/<id>.png (team and conference logos). Uploaded in batches by
// `ncaa-bridge photos upload` / `ncaa-bridge logos upload`; served under /img/players, /img/faces and /img/logos.
import type { Env } from '../env.js';
import { json } from '../html.js';

const SILHOUETTE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 96"><rect width="80" height="96" fill="#dfe3e6"/><circle cx="40" cy="36" r="16" fill="#aab2b8"/><path d="M12 96c2-22 14-32 28-32s26 10 28 32z" fill="#aab2b8"/></svg>';
// Monogram shield for teams/conferences without a logo (the abbreviation comes in as ?t=).
const monogram = (text: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M8 6h48v30c0 14-12 20-24 24C20 56 8 50 8 36z" fill="#4a5560"/><text x="32" y="40" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-weight="bold" font-size="${text.length > 3 ? 16 : 20}" fill="#fff">${text.replace(/[<>&"]/g, '').slice(0, 4)}</text></svg>`;
// File names come from the schools' rosters (accents, apostrophes, spaces); no path tricks.
const KEY_RE = /^[\p{L}\p{N}][\p{L}\p{N}._ ()'&,-]*(\/[\p{L}\p{N}][\p{L}\p{N}._ ()'&,-]*)*$/u;
const safeKey = (k: string) => (KEY_RE.test(k) && !k.includes('..') ? k : null);

async function serveStored(env: Env, key: string, fallbackSvg: string): Promise<Response> {
  const obj = safeKey(key) ? await env.SAVES.get(key) : null;
  if (!obj) return new Response(fallbackSvg, { status: 200, headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=3600' } });
  const h = new Headers();
  obj.writeHttpMetadata(h);
  if (!h.get('content-type')) h.set('content-type', key.endsWith('.png') ? 'image/png' : key.endsWith('.svg') ? 'image/svg+xml' : 'image/jpeg');
  h.set('cache-control', 'public, max-age=31536000, immutable');
  h.set('etag', obj.httpEtag);
  return new Response(obj.body, { headers: h });
}

export const servePhoto = (env: Env, key: string) => serveStored(env, key, SILHOUETTE);
export const serveLogo = (env: Env, key: string, label: string) => serveStored(env, key, monogram(label || '?'));
// Member-written News Wire photos: stories/<dynasty id>/<story id>-<timestamp>.<ext>; a neutral grey card stands in when the object is gone.
const STORY_PLACEHOLDER = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 9"><rect width="16" height="9" fill="#dfe3e6"/></svg>';
export const serveStoryImage = (env: Env, key: string) => serveStored(env, key, STORY_PLACEHOLDER);

async function readJson(req: Request): Promise<any> {
  if (req.headers.get('x-content-encoding') === 'gzip' && req.body) return JSON.parse(await new Response(req.body.pipeThrough(new DecompressionStream('gzip'))).text());
  return req.json();
}

// Bridge API (authenticated by the caller): GET lists stored keys under a prefix (photos/ or logos/); PUT stores a batch.
export async function handlePhotos(req: Request, env: Env, root: 'photos' | 'logos' = 'photos'): Promise<Response> {
  if (req.method === 'GET') {
    const prefix = `${root}/${new URL(req.url).searchParams.get('prefix') ?? ''}`;
    const keys: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const page = await env.SAVES.list({ prefix, cursor, limit: 1000 });
      keys.push(...page.objects.map((o) => o.key.slice(root.length + 1)));
      if (!page.truncated) break;
      cursor = page.cursor;
    }
    return json({ keys });
  }
  if (req.method === 'PUT') {
    const body = await readJson(req);
    const files: { key: string; b64: string; type?: string }[] = body.files ?? [];
    if (files.length > 40) return json({ error: 'at most 40 files per request' }, 400);
    const bad = files.find((f) => !safeKey(f.key));
    if (bad) return json({ error: `bad key ${bad.key}` }, 400);
    await Promise.all(files.map((f) => env.SAVES.put(`${root}/${f.key}`, Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)), { httpMetadata: { contentType: f.type ?? (f.key.endsWith('.png') ? 'image/png' : f.key.endsWith('.svg') ? 'image/svg+xml' : 'image/jpeg') } })));
    return json({ ok: true, stored: files.length });
  }
  return json({ error: 'not found' }, 404);
}
