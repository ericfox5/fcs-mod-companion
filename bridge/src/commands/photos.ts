// `ncaa-bridge photos upload`: pushes the league's player photos (every photo set in the config: photosDir +
// photosDirs) and the game's face art to the site's R2 store in batches (skipping objects that are already there), so
// /img/players/<file> and /img/faces/<n>.png resolve.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { WorkerApi } from '../api.js';
import type { BridgeConfig } from '../config.js';
import { loadPhotoIndex, photoDirsOf } from '../photos.js';

const BATCH = 40;
const TYPES: Record<string, string> = { '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

export async function photosUpload(cfg: BridgeConfig, opts: { force?: boolean } = {}): Promise<void> {
  const api = new WorkerApi(cfg);
  const dirs = photoDirsOf(cfg);
  const idx = loadPhotoIndex(dirs);
  const items: { key: string; path: string; type: string }[] = [];
  if (idx) {
    for (const f of idx.files) items.push({ key: f.key, path: join(f.dir, 'player_photos', f.file), type: TYPES[extname(f.file).toLowerCase()] ?? 'image/jpeg' });
    console.log(`${idx.files.length} player photos in ${idx.dirs.length} set(s): ${idx.dirs.join(', ')}`);
  } else console.log(`no photo manifest in ${dirs.join(', ') || '(photosDir unset)'}`);
  if (cfg.facesDir && existsSync(cfg.facesDir)) {
    for (const f of readdirSync(cfg.facesDir)) { const m = /^face_(\d+)\.png$/i.exec(f); if (m) items.push({ key: `faces/${Number(m[1])}.png`, path: join(cfg.facesDir, f), type: 'image/png' }); }
  } else console.log(`no face art folder (${cfg.facesDir ?? 'facesDir unset'})`);
  const existing = new Set<string>(opts.force ? [] : (await api.json<{ keys: string[] }>('GET', '/api/bridge/photos')).keys);
  const todo = items.filter((x) => !existing.has(x.key));
  console.log(`${items.length} files (${existing.size} already stored), uploading ${todo.length}`);
  const t0 = Date.now();
  for (let i = 0; i < todo.length; i += BATCH) {
    const slice = todo.slice(i, i + BATCH);
    const files = slice.map((x) => ({ key: x.key, b64: readFileSync(x.path).toString('base64'), type: x.type }));
    // a long run meets the odd edge 5xx; the PUT is idempotent, so retry the batch a few times before giving up
    for (let attempt = 1; ; attempt++) {
      try { await api.json('PUT', '/api/bridge/photos', { files }); break; }
      catch (e) { if (attempt >= 4) throw e; console.log(`  batch at ${i} failed (${(e as Error).message.slice(0, 80)}), retry ${attempt}`); await new Promise((r) => setTimeout(r, 2000 * attempt)); }
    }
    if ((i / BATCH) % 10 === 9 || i + BATCH >= todo.length) console.log(`  ${Math.min(i + BATCH, todo.length)}/${todo.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  console.log('done');
}
