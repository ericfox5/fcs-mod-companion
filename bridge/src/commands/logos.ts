// `ncaa-bridge logos upload --dir <folder>`: pushes team logos (<dir>/teams/<id>.png) and conference logos (<dir>/conf/*)
// to the site's R2 store under logos/, skipping objects already there. `ncaa-bridge logos check --did N` prints the
// teams of a dynasty that have no logo in bridge/data/logos.json.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { WorkerApi } from '../api.js';
import type { BridgeConfig } from '../config.js';

const BATCH = 40;
const typeOf = (f: string) => (f.endsWith('.svg') ? 'image/svg+xml' : f.endsWith('.jpg') ? 'image/jpeg' : 'image/png');

export async function logosUpload(cfg: BridgeConfig, dir: string, opts: { force?: boolean } = {}): Promise<void> {
  const api = new WorkerApi(cfg);
  const items: { key: string; path: string }[] = [];
  const subs = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); // teams, teams64, teams160, conf, conf64 ...
  for (const sub of subs) {
    const d = join(dir, sub);
    if (!existsSync(d)) { console.log(`no ${d}`); continue; }
    for (const f of readdirSync(d)) if (/\.(png|svg|jpg)$/i.test(f)) items.push({ key: `${sub}/${f}`, path: join(d, f) });
  }
  const existing = new Set<string>(opts.force ? [] : (await api.json<{ keys: string[] }>('GET', '/api/bridge/logos')).keys);
  const todo = items.filter((x) => !existing.has(x.key));
  console.log(`${items.length} logo files (${existing.size} already stored), uploading ${todo.length}`);
  for (let i = 0; i < todo.length; i += BATCH) {
    const files = todo.slice(i, i + BATCH).map((x) => ({ key: x.key, b64: readFileSync(x.path).toString('base64'), type: typeOf(x.key) }));
    await api.json('PUT', '/api/bridge/logos', { files });
    console.log(`  ${Math.min(i + BATCH, todo.length)}/${todo.length}`);
  }
  console.log('done');
}
