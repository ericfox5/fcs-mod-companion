// `ncaa-bridge photos upload`: pushes the league's player photos and the game's face art to the site's R2 store in batches
// (skipping objects that are already there), so /img/players/<file> and /img/faces/<n>.png resolve.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { WorkerApi } from '../api.js';
import type { BridgeConfig } from '../config.js';
import { loadPhotoIndex } from '../photos.js';

const BATCH = 40;

export async function photosUpload(cfg: BridgeConfig, opts: { force?: boolean } = {}): Promise<void> {
  const api = new WorkerApi(cfg);
  const idx = loadPhotoIndex(cfg.photosDir);
  const items: { key: string; path: string; type: string }[] = [];
  if (idx) for (const f of idx.files) items.push({ key: `players/${f}`, path: join(idx.dir, 'player_photos', f), type: 'image/jpeg' });
  else console.log(`no photo manifest in ${cfg.photosDir ?? '(photosDir unset)'}`);
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
    await api.json('PUT', '/api/bridge/photos', { files });
    if ((i / BATCH) % 10 === 9 || i + BATCH >= todo.length) console.log(`  ${Math.min(i + BATCH, todo.length)}/${todo.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  console.log('done');
}
