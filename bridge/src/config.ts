import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultOdDir } from './od.js';

export interface BridgeConfig { workerUrl: string; token: string; dynastySlug: string; dynastyName?: string; saveDir?: string; rpcs3Root?: string; odDir: string; photosDir?: string; photosDirs?: string[]; facesDir?: string; screenshotsDir?: string; gameUsrDir?: string; overhaulExe?: string; startYear?: number }

export const CONFIG_FILE = join(homedir(), '.ncaa-bridge', 'config.json');
// The settings the CLI changes while `od watch` runs (od overhaul --set-exe, od year --default): re-read from the file
// so a running watcher follows them without a restart.
export function refreshConfig(cfg: BridgeConfig): void {
  if (!existsSync(CONFIG_FILE)) return;
  let f: Record<string, unknown>; try { f = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); } catch { return; }
  cfg.overhaulExe = typeof f.overhaulExe === 'string' ? f.overhaulExe : undefined;
  cfg.startYear = typeof f.startYear === 'number' ? f.startYear : undefined;
}
// Sets (or, with undefined, removes) one key of ~/.ncaa-bridge/config.json, keeping the rest as it is.
export function saveConfigKey(key: string, value: string | number | undefined): void {
  const cur = existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Record<string, unknown> : {};
  if (value === undefined) delete cur[key]; else cur[key] = value;
  mkdirSync(join(homedir(), '.ncaa-bridge'), { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cur, null, 2) + '\n');
}

// Precedence: CLI flags > environment (NCAA_WORKER_URL, NCAA_BRIDGE_TOKEN, NCAA_DYNASTY, NCAA_OD_DIR) > ~/.ncaa-bridge/config.json
// odDir = the Blaze stub's private store (spike/blaze/private in this checkout) for the `od` commands.
// overhaulExe = Fang's Recruit Overhaul tool (od overhaul --set-exe); the watcher runs it on every new recruiting class.
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
    photosDirs: Array.isArray(fromFile.photosDirs) ? fromFile.photosDirs.filter((d: unknown): d is string => typeof d === 'string') : undefined, // more photo sets (one folder each, same layout; later sets win), e.g. a roster year's pack from tools/photo-pack.py
    facesDir: flags.get('faces-dir') ?? fromFile.facesDir, // folder holding face_<n>.png
    screenshotsDir: flags.get('screenshots-dir') ?? fromFile.screenshotsDir ?? (fromFile.rpcs3Root ? join(fromFile.rpcs3Root, 'screenshots') : undefined), // RPCS3 F12 screenshots
    gameUsrDir: fromFile.gameUsrDir ?? (fromFile.rpcs3Root ? join(fromFile.rpcs3Root, 'dev_hdd0', 'game', 'BLUS31159', 'USRDIR') : undefined), // the game's highlight XML lives here
    overhaulExe: flags.get('overhaul-exe') ?? fromFile.overhaulExe, // Fang's Recruit Overhaul tool: run on every new recruiting class (od overhaul --set-exe)
    startYear: flags.has('start-year') ? Number(flags.get('start-year')) : typeof fromFile.startYear === 'number' ? fromFile.startYear : undefined, // new dynasties start in this calendar year (od year --default)
  };
  if (!cfg.token) throw new Error('bridge token missing (set NCAA_BRIDGE_TOKEN, --token, or ~/.ncaa-bridge/config.json)');
  if (opts.needSlug !== false && !cfg.dynastySlug) throw new Error('dynasty slug missing (set NCAA_DYNASTY, --dynasty, or config)');
  return cfg;
}
