import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultOdDir } from './od.js';

export interface BridgeConfig { workerUrl: string; token: string; dynastySlug: string; dynastyName?: string; saveDir?: string; rpcs3Root?: string; odDir: string; photosDir?: string; facesDir?: string }

// Precedence: CLI flags > environment (NCAA_WORKER_URL, NCAA_BRIDGE_TOKEN, NCAA_DYNASTY, NCAA_OD_DIR) > ~/.ncaa-bridge/config.json
// odDir = the Blaze stub's private store (spike/blaze/private in this checkout) for the `od` commands.
export function loadConfig(flags: Map<string, string>, opts: { needSlug?: boolean } = {}): BridgeConfig {
  const file = join(homedir(), '.ncaa-bridge', 'config.json');
  const fromFile = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const cfg: BridgeConfig = {
    workerUrl: flags.get('url') ?? process.env.NCAA_WORKER_URL ?? fromFile.workerUrl ?? 'http://localhost:8787',
    token: flags.get('token') ?? process.env.NCAA_BRIDGE_TOKEN ?? fromFile.token ?? '',
    dynastySlug: flags.get('dynasty') ?? process.env.NCAA_DYNASTY ?? fromFile.dynastySlug ?? '',
    dynastyName: flags.get('name') ?? fromFile.dynastyName,
    saveDir: flags.get('save-dir') ?? fromFile.saveDir,
    rpcs3Root: fromFile.rpcs3Root,
    odDir: flags.get('od-dir') ?? process.env.NCAA_OD_DIR ?? fromFile.odDir ?? defaultOdDir(),
    photosDir: flags.get('photos-dir') ?? fromFile.photosDir, // folder holding player_photos/ + player_photos_manifest.csv
    facesDir: flags.get('faces-dir') ?? fromFile.facesDir, // folder holding face_<n>.png
  };
  if (!cfg.token) throw new Error('bridge token missing (set NCAA_BRIDGE_TOKEN, --token, or ~/.ncaa-bridge/config.json)');
  if (opts.needSlug !== false && !cfg.dynastySlug) throw new Error('dynasty slug missing (set NCAA_DYNASTY, --dynasty, or config)');
  return cfg;
}
