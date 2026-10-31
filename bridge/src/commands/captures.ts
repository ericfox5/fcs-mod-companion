// In-game captures for the News Wire. Under RPCS3 the game's own "photo" files hold a stale texture (see NOTES), so the
// source is the emulator's screenshot folder (F12 in RPCS3). Each new screenshot is shrunk to a JPEG with the Windows
// drawing classes, captioned from the game's highlight XML when a photo entry was logged within a few minutes of it,
// and pushed to the site as a capture that members can attach to a story.
import { readdirSync, statSync, readFileSync, existsSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { WorkerApi } from '../api.js';
import type { BridgeConfig } from '../config.js';
import type { OdDynasty } from '../od.js';

const STATE_FILE = join(homedir(), '.ncaa-bridge', 'captures-state.json');
type CaptureState = Record<string, Record<string, string>>; // "<workerUrl> #<did>" -> { screenshot file -> uploaded at }
const loadState = (): CaptureState => (existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {});
const saveState = (s: CaptureState) => { mkdirSync(dirname(STATE_FILE), { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); };
const stamp = () => new Date().toTimeString().slice(0, 8);
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'to-jpeg.ps1');

export interface PhotoMeta { at: number; week: number | null; homeTgid: number | null; awayTgid: number | null; homeName: string; awayName: string; homeScore: number | null; awayScore: number | null; quarter: number | null; clock: string | null; play: string | null }

// The game logs one <AP: Type="Photo"> block per in-game photo, with the local time, teams, score and the play.
export function readHighlightXml(usrDir: string | undefined): PhotoMeta[] {
  if (!usrDir || !existsSync(usrDir)) return [];
  const out: PhotoMeta[] = [];
  const attr = (block: string, tag: string, name: string): string | null => { const m = new RegExp(`<${tag}\\b[^>]*\\b${name}="([^"]*)"`).exec(block); return m ? m[1]! : null; };
  for (const f of readdirSync(usrDir)) {
    if (!f.toLowerCase().endsWith('.xml')) continue;
    let text: string;
    try { text = readFileSync(join(usrDir, f), 'utf8'); } catch { continue; }
    for (const block of text.split('<AP: ').slice(1)) {
      if (!/^Type="Photo"/.test(block)) continue;
      const y = Number(attr(block, 'Time', 'Year')), mo = Number(attr(block, 'Time', 'Month')), dd = Number(attr(block, 'Time', 'Day')), hh = Number(attr(block, 'Time', 'Hour')), mi = Number(attr(block, 'Time', 'Minute'));
      if (![y, mo, dd, hh, mi].every(Number.isFinite)) continue;
      const at = new Date(y, mo - 1, dd, hh, mi).getTime();
      const score = attr(block, 'Scores', 'Current') ?? '';
      const [hs, as] = score.split('-').map((s) => Number(s.trim()));
      const secs = Number(attr(block, 'Play', 'TimeLeftSeconds'));
      out.push({
        at, week: attr(block, 'Dynasty', 'Week') !== null ? Number(attr(block, 'Dynasty', 'Week')) : null,
        homeTgid: attr(block, 'HomeTeam', 'ID') !== null ? Number(attr(block, 'HomeTeam', 'ID')) : null, awayTgid: attr(block, 'AwayTeam', 'ID') !== null ? Number(attr(block, 'AwayTeam', 'ID')) : null,
        homeName: attr(block, 'HomeTeam', 'Name') ?? '', awayName: attr(block, 'AwayTeam', 'Name') ?? '',
        homeScore: Number.isFinite(hs) ? hs! : null, awayScore: Number.isFinite(as) ? as! : null,
        quarter: attr(block, 'Play', 'Quarter') !== null ? Number(attr(block, 'Play', 'Quarter')) : null,
        clock: Number.isFinite(secs) ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : null,
        play: attr(block, 'Play', 'Description'),
      });
    }
  }
  return out;
}

const listScreenshots = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string, depth: number) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) { if (depth < 3) walk(p, depth + 1); } else if (/\.(png|jpe?g)$/i.test(e.name)) out.push(p); } };
  walk(dir, 0);
  return out;
};

export async function syncCaptures(cfg: BridgeConfig, d: OdDynasty, api = new WorkerApi(cfg), opts: { quiet?: boolean; limit?: number } = {}): Promise<number> {
  if (!cfg.screenshotsDir || !existsSync(cfg.screenshotsDir)) { if (!opts.quiet) console.log(`${stamp()} captures: screenshot folder not found (${cfg.screenshotsDir ?? 'screenshotsDir unset'})`); return 0; }
  const state = loadState();
  const key = `${cfg.workerUrl} #${d.id}`;
  const done = (state[key] ??= {});
  const files = listScreenshots(cfg.screenshotsDir).filter((f) => !done[f]).sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs).slice(0, opts.limit ?? 20);
  if (!files.length) return 0;
  const metas = readHighlightXml(cfg.gameUsrDir);
  let n = 0;
  for (const f of files) {
    const mtime = statSync(f).mtimeMs;
    const tmp = join(tmpdir(), `ncaa-capture-${Date.now()}-${n}.jpg`);
    let dims = '';
    try { dims = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-In', f, '-Out', tmp, '-MaxWidth', '1280'], { encoding: 'utf8', windowsHide: true }).trim(); }
    catch (e) { console.error(`${stamp()} captures: could not convert ${basename(f)}: ${(e as Error).message.split('\n')[0]}`); continue; }
    const [w, h] = dims.split(/\s+/).map(Number);
    const bytes = readFileSync(tmp); try { unlinkSync(tmp); } catch { /* temp */ }
    const near = metas.filter((m) => Math.abs(m.at - mtime) < 5 * 60 * 1000).sort((a, b) => Math.abs(a.at - mtime) - Math.abs(b.at - mtime))[0];
    const name = basename(f, extname(f));
    await api.json('PUT', '/api/bridge/captures', {
      od: d.id, name, b64: bytes.toString('base64'), type: 'image/jpeg', width: w ?? null, height: h ?? null, takenAt: new Date(mtime).toISOString(),
      week: near?.week ?? null, homeTgid: near?.homeTgid ?? null, awayTgid: near?.awayTgid ?? null, homeScore: near?.homeScore ?? null, awayScore: near?.awayScore ?? null,
      quarter: near?.quarter ?? null, clock: near?.clock ?? null, playText: near?.play ?? null,
    });
    done[f] = new Date().toISOString(); saveState(state); n++;
    if (!opts.quiet) console.log(`${stamp()} DID ${d.id}: capture ${name} (${w}x${h}${near ? `, ${near.awayName} at ${near.homeName} ${near.awayScore}-${near.homeScore}, ${near.play ?? ''}` : ', no play info'})`);
  }
  return n;
}
