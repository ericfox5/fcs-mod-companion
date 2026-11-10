// FCS-online: one executable that sets a member's RPCS3 up for the FCS mod online league (the roster/jersey patches,
// the uniform sets and stop-gap uniform files, the league server address, the private PSN server), installs the FCS2026
// roster save, and starts the league server on the host's PC. Built into a single .exe by installer/build.mjs (Node
// SEA); the payload (patch entries, uniform XMLs, optional roster save) is generated at build time from the project's
// private files and embedded, the uniform sets' bigfiles as the SEA asset uniform-pack.bin. `join` also re-keys the
// generic teams' stored rosters in the game archives to the 100-player stride and gives their rows the real 2026
// rosters' names (bridge/src/stda.ts, bundled in). Runs as a console wizard; every flag makes a step non-interactive.
//
//   FCS-online.exe                       menu
//   FCS-online.exe install [--rpcs3 DIR] [--roster false] [--yes]   (everything except the league network settings)
//   FCS-online.exe join   [--rpcs3 DIR] [--server IP] [--rpcn HOST:PORT] [--roster false] [--yes]
//   FCS-online.exe roster [--rpcs3 DIR] [--yes]
//   FCS-online.exe host   [--project DIR]
//   FCS-online.exe status [--rpcs3 DIR]
//   FCS-online.exe swap   [--rpcs3 DIR] [--cfbr PKG] [--donors USR-DATA] [--port N] [--no-open]   (commissioner: FBS team -> generic slot)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import payload from '../generated/payload.json';
import { findStdaCopies, gameArchives, newStdaBackupDir, rekeyStdaArchive, rpcs3RunningOver, stdaFile } from '../../bridge/src/stda.js';
import { fillGenericRows, filledGenericRows, staleGenericRows, type GenericPlanRow } from '@ncaa/ncaa14';
import { FCS_MOD_SCOREBUG_SHA, newScorebugBackupDir, readScorebug, scorebugArchive, writeScorebug } from '../../bridge/src/scorebug.js';
import { SwapTool } from '../../bridge/src/swap/swap.js';
import { startSwapServer } from '../../bridge/src/swap/server.js';
import { findCfbrPkg, findDonorRoster } from '../../bridge/src/swap/find.js';
import { applySwapPack, swapPackSummary, type SwapPackManifest } from '../../bridge/src/swap/pack.js';
import { SWAP_ROOT } from '../../bridge/src/swap/swap.js';
import { applyPlaybookPack, packSummary, playbookPackStatus, type PlaybookPackManifest } from '../../bridge/src/playbook-pack.js';
import { newEntryBackupDir } from '../../bridge/src/archive-entry.js';
import swapPage from './swap-ui.html';

interface UniformFile { folder: string; name: string; offset: number; size: number; sha1: string }
interface Payload { builtAt: string; site: string; ppuHash: string; patches: { name: string; block: string; words: number }[]; uniforms: Record<string, string>; uniformSets?: UniformFile[]; roster?: { dir: string; files: Record<string, string>; note: string }; genericRosters?: { built: string; teams: { tgid: number; team: string }[]; rows: GenericPlanRow[] }; scorebug?: { stream: string; sha: string; replaces: string[]; teams: number }; swapDonors?: { name: string; b64: string }; swapPack?: SwapPackManifest; playbooks?: PlaybookPackManifest }
const P = payload as Payload;
const GAME = 'BLUS31159';
const args = process.argv.slice(2);
const flags = new Map<string, string>(); const words: string[] = [];
for (let i = 0; i < args.length; i++) { const a = args[i]!; if (a.startsWith('--')) { const v = args[i + 1] && !args[i + 1]!.startsWith('--') ? args[++i]! : 'true'; flags.set(a.slice(2), v); } else words.push(a); }
const YES = flags.get('yes') === 'true';
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q: string, def = ''): Promise<string> => { if (YES && def) return def; const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim(); return a || def; };
const confirm = async (q: string, def = true): Promise<boolean> => { if (YES) return def; const a = (await rl.question(`${q} ${def ? '[Y/n]' : '[y/N]'}: `)).trim().toLowerCase(); return a ? a.startsWith('y') : def; };
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backup = (file: string): string | null => { if (!fs.existsSync(file)) return null; const b = `${file}.bak-${stamp()}`; fs.copyFileSync(file, b); return b; };
const say = (s = '') => console.log(s);

// ---- RPCS3 -------------------------------------------------------------------------------------------------------
const isRpcs3Dir = (d: string) => !!d && fs.existsSync(path.join(d, 'rpcs3.exe')) && fs.existsSync(path.join(d, 'dev_hdd0'));
function findRpcs3(): string[] {
  const found = new Set<string>();
  const add = (d: string) => { if (isRpcs3Dir(d)) found.add(path.resolve(d)); };
  if (flags.get('rpcs3')) add(flags.get('rpcs3')!);
  let d = path.dirname(process.execPath); for (let i = 0; i < 4; i++) { add(d); d = path.dirname(d); }
  const roots = [os.homedir(), path.join(os.homedir(), 'Desktop'), path.join(os.homedir(), 'Downloads'), path.join(os.homedir(), 'Documents'), path.join(os.homedir(), 'OneDrive', 'Desktop'), 'C:\\', 'D:\\', 'C:\\Games', 'D:\\Games', 'C:\\Program Files', 'C:\\Emulators'];
  for (const r of roots) {
    try { for (const e of fs.readdirSync(r, { withFileTypes: true })) if (e.isDirectory() && /rpcs3/i.test(e.name)) add(path.join(r, e.name)); } catch { /* no such root */ }
    try { for (const e of fs.readdirSync(r, { withFileTypes: true })) if (e.isDirectory()) { const d2 = path.join(r, e.name); try { for (const f of fs.readdirSync(d2, { withFileTypes: true })) if (f.isDirectory() && /rpcs3/i.test(f.name)) add(path.join(d2, f.name)); } catch { /* skip */ } } } catch { /* skip */ }
  }
  return [...found];
}
async function chooseRpcs3(): Promise<string> {
  const found = findRpcs3();
  if (found.length === 1 && (YES || await confirm(`RPCS3 found at ${found[0]}. Use it?`))) return found[0]!;
  if (found.length > 1) { say('RPCS3 installs found:'); found.forEach((f, i) => say(`  ${i + 1}. ${f}`)); const pick = await ask('Which one (number), or a path'); const n = Number(pick); if (n >= 1 && n <= found.length) return found[n - 1]!; if (isRpcs3Dir(pick)) return path.resolve(pick); }
  for (;;) { const p = await ask('Path of the RPCS3 folder (the one with rpcs3.exe)'); if (isRpcs3Dir(p)) return path.resolve(p); say('  no rpcs3.exe + dev_hdd0 there'); if (YES) throw new Error('RPCS3 folder not found; pass --rpcs3 DIR'); }
}

// ---- patches: patches/imported_patch.yml + config/patch_config.yml --------------------------------------------------
const entryRe = /^  "(.+)":\s*$/;
function splitEntries(text: string): { head: string; entries: Map<string, string>; order: string[] } {
  // the file: "Version: 1.2\n\nPPU-<hash>:\n" then entries at two-space indent
  const lines = text.split(/\r?\n/); const entries = new Map<string, string>(); const order: string[] = [];
  let head: string[] = [], cur: string | null = null, buf: string[] = [];
  const flush = () => { if (cur !== null) { entries.set(cur, buf.join('\n').replace(/\n+$/, '') + '\n'); order.push(cur); } };
  for (const l of lines) { const m = entryRe.exec(l); if (m) { flush(); cur = m[1]!; buf = [l]; } else if (cur === null) head.push(l); else buf.push(l); }
  flush();
  return { head: head.join('\n').replace(/\n+$/, '') + '\n', entries, order };
}
function installPatches(rpcs3: string): { changed: string[]; kept: string[] } {
  const file = path.join(rpcs3, 'patches', 'imported_patch.yml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : `Version: 1.2\n\n${P.ppuHash}:\n`;
  if (!text.includes(`${P.ppuHash}:`)) text = text.replace(/\n*$/, '\n') + `\n${P.ppuHash}:\n`;
  const { head, entries, order } = splitEntries(text);
  const changed: string[] = [], kept: string[] = [];
  for (const p of P.patches) { if (entries.get(p.name) === p.block) kept.push(p.name); else { if (!entries.has(p.name)) order.push(p.name); entries.set(p.name, p.block); changed.push(p.name); } }
  if (changed.length) { backup(file); fs.writeFileSync(file, head + order.map((n) => entries.get(n)!).join('')); }
  // enable them (the file may be CRLF: matched and compared as LF, written back in its own style)
  const cfg = path.join(rpcs3, 'config', 'patch_config.yml');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  const raw = fs.existsSync(cfg) ? fs.readFileSync(cfg, 'utf8') : ''; const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  let c = raw.replace(/\r\n/g, '\n');
  if (!c.includes(`${P.ppuHash}:`)) c = c.replace(/\n*$/, c ? '\n' : '') + `${P.ppuHash}:\n`;
  let cfgChanged = false;
  for (const p of P.patches) {
    const block = `  "${p.name}":\n    NCAA Football 14:\n      ${GAME}:\n        01.00:\n          Enabled: true\n        01.02:\n          Enabled: true\n`;
    const re = new RegExp(`^  "${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}":\\n(?:    .*\\n|      .*\\n|        .*\\n|          .*\\n)*`, 'm');
    const m = re.exec(c);
    if (!m) { c = c.replace(/\n*$/, '\n') + block; cfgChanged = true; }
    else if (m[0] !== block) { c = c.replace(m[0], block); cfgChanged = true; }
  }
  if (cfgChanged) { backup(cfg); fs.writeFileSync(cfg, c.split('\n').join(eol)); }
  return { changed, kept };
}
function patchStatus(rpcs3: string): string[] {
  const file = path.join(rpcs3, 'patches', 'imported_patch.yml'); const cfg = path.join(rpcs3, 'config', 'patch_config.yml');
  const entries = fs.existsSync(file) ? splitEntries(fs.readFileSync(file, 'utf8')).entries : new Map<string, string>();
  const c = fs.existsSync(cfg) ? fs.readFileSync(cfg, 'utf8').replace(/\r\n/g, '\n') : '';
  return P.patches.map((p) => { const have = entries.get(p.name); const en = new RegExp(`^  "${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}":\\n(?:[^\\n]*\\n){6}`, 'm').exec(c)?.[0]?.includes('Enabled: true'); return `${have ? (have === p.block ? 'installed' : 'DIFFERENT') : 'missing'}${have ? (en ? ', enabled' : ', NOT enabled') : ''}  ${p.name} (${p.words} words)`; });
}

// ---- uniforms: stop-gap XMLs into USRDIR\DLC\FCS_DLC_NEC, uniform sets (bigfiles + XML) into their FCS_DLC_* folders ---
// A DLC file this replaces is backed up outside the DLC folders (the studio's backup folder: a stray copy in a DLC folder
// is one more file the game scans). A slot XML of the same name in another FCS_DLC folder is moved there too, so no slot
// has two definitions.
const dlcDir = (rpcs3: string) => path.join(rpcs3, 'dev_hdd0', 'game', GAME, 'USRDIR', 'DLC');
const DLC_BACKUP = path.join(process.env.LOCALAPPDATA || os.homedir(), 'ncaa-bridge', 'uniforms', 'backup');
const ROSTER_BACKUP = path.join(process.env.LOCALAPPDATA || os.homedir(), 'ncaa-bridge', 'backups', 'roster-saves');
const sha1 = (b: Buffer) => createHash('sha1').update(b).digest('hex');
function setAside(dlc: string, file: string): void { fs.mkdirSync(DLC_BACKUP, { recursive: true }); fs.renameSync(file, path.join(DLC_BACKUP, `${path.relative(dlc, file).replace(/[\\/]/g, '__')}.${stamp()}.bak`)); dlcBackups++; }
let dlcBackups = 0;
function backupDlc(dlc: string, file: string): void { if (!fs.existsSync(file)) return; fs.mkdirSync(DLC_BACKUP, { recursive: true }); fs.copyFileSync(file, path.join(DLC_BACKUP, `${path.relative(dlc, file).replace(/[\\/]/g, '__')}.${stamp()}.bak`)); dlcBackups++; }
// uniform-pack.bin: the SEA asset in the exe; generated/uniform-pack.bin when the bundle runs under plain node
function uniformPack(): Buffer | null {
  try { const sea = require('node:sea'); if (sea.isSea()) return Buffer.from(sea.getAsset('uniform-pack.bin')); } catch { /* not a SEA build */ }
  const f = path.resolve(__dirname, '..', 'generated', 'uniform-pack.bin'); return fs.existsSync(f) ? fs.readFileSync(f) : null;
}
function installUniforms(rpcs3: string): { written: string[]; same: string[]; setAside: string[]; bigfiles: { written: number; same: number }; missingDlc: boolean; missingPack: boolean } {
  const res = { written: [] as string[], same: [] as string[], setAside: [] as string[], bigfiles: { written: 0, same: 0 }, missingDlc: false, missingPack: false };
  const dlc = dlcDir(rpcs3); if (!fs.existsSync(dlc)) return { ...res, missingDlc: true };
  const nec = path.join(dlc, 'FCS_DLC_NEC'); fs.mkdirSync(nec, { recursive: true });
  for (const [name, text] of Object.entries(P.uniforms)) { const f = path.join(nec, name); if (fs.existsSync(f) && fs.readFileSync(f, 'latin1') === text) res.same.push(name); else { backupDlc(dlc, f); fs.writeFileSync(f, text, 'latin1'); res.written.push(name); } }
  const sets = P.uniformSets ?? []; if (!sets.length) return res;
  const pack = uniformPack(); if (!pack) return { ...res, missingPack: true };
  const folders = fs.readdirSync(dlc).filter((f) => /^FCS_DLC_/i.test(f) && fs.statSync(path.join(dlc, f)).isDirectory());
  const swapXml = new Set((P.swapPack?.slots ?? []).flatMap((s) => (s.swap?.uniforms ? [s.swap.uniforms.xmlName.toLowerCase()] : [])));
  for (const u of sets) {
    if (swapXml.has(u.name.toLowerCase())) continue; // an FBS swap's XML: the swap step installs it
    const dest = path.join(dlc, u.folder, u.name), xml = /_MixAndMatch\.XML$/i.test(u.name);
    if (xml) for (const other of folders) {
      if (other.toLowerCase() === u.folder.toLowerCase()) continue;
      for (const f of fs.readdirSync(path.join(dlc, other))) if (f.toLowerCase() === u.name.toLowerCase()) { setAside(dlc, path.join(dlc, other, f)); res.setAside.push(`${other}\\${f}`); }
    }
    if (fs.existsSync(dest) && sha1(fs.readFileSync(dest)) === u.sha1) { if (xml) res.same.push(u.name); else res.bigfiles.same++; continue; }
    const bytes = pack.subarray(u.offset, u.offset + u.size); if (sha1(bytes) !== u.sha1) throw new Error(`uniform pack is damaged at ${u.folder}\\${u.name}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true }); backupDlc(dlc, dest); fs.writeFileSync(dest, bytes);
    if (xml) res.written.push(`${u.folder}\\${u.name}`); else res.bigfiles.written++;
  }
  return res;
}

// ---- network: the game's custom config (IP swap -> league server, PSN -> RPCN) and config/rpcn.yml Host -------------
function setYamlKey(text: string, section: string, key: string, value: string): string {
  // "Net:" section, two-space keys; keeps everything else byte for byte
  const lines = text.split(/\r?\n/); let inSec = false, done = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^\S/.test(l)) inSec = l.startsWith(`${section}:`);
    else if (inSec && l.startsWith(`  ${key}:`)) { lines[i] = `  ${key}: ${value}`; done = true; break; }
  }
  if (!done) { const idx = lines.findIndex((l) => l.startsWith(`${section}:`)); if (idx < 0) lines.push(`${section}:`, `  ${key}: ${value}`); else lines.splice(idx + 1, 0, `  ${key}: ${value}`); }
  return lines.join('\n');
}
function configureNetwork(rpcs3: string, server: string, rpcn: string): string[] {
  const notes: string[] = [];
  const custom = path.join(rpcs3, 'config', 'custom_configs', `config_${GAME}.yml`);
  if (!fs.existsSync(custom)) notes.push(`no custom config for ${GAME} yet: in RPCS3 right-click NCAA Football 14 > Create Custom Configuration, save it, then run this again (it lives at ${custom})`);
  else {
    let t = fs.readFileSync(custom, 'utf8'); const before = t;
    t = setYamlKey(t, 'Net', 'Internet enabled', 'Connected');
    t = setYamlKey(t, 'Net', 'PSN status', 'RPCN');
    t = setYamlKey(t, 'Net', 'IP swap list', `"gosredirector.ea.com=${server}&&*.ea.com=${server}"`);
    if (t !== before) { backup(custom); fs.writeFileSync(custom, t); notes.push(`custom config: Network Connected, PSN RPCN, EA hosts -> ${server}`); } else notes.push('custom config already pointed at the league');
  }
  const rp = path.join(rpcs3, 'config', 'rpcn.yml'); fs.mkdirSync(path.dirname(rp), { recursive: true });
  let r = fs.existsSync(rp) ? fs.readFileSync(rp, 'utf8') : 'Version: 1\nHost: ""\nNPID: ""\nPassword: ""\nToken: ""\nHosts: ""\n';
  const beforeR = r; r = r.replace(/^Host: .*$/m, `Host: "${rpcn}"`); if (!/^Host: /m.test(r)) r += `Host: "${rpcn}"\n`;
  if (r !== beforeR) { backup(rp); fs.writeFileSync(rp, r); notes.push(`RPCN host -> ${rpcn}`); } else notes.push('RPCN host already set');
  const npid = /^NPID: "?([^"\n]*)"?$/m.exec(r)?.[1] ?? '';
  if (!npid) notes.push('no RPCN account on this install yet: RPCS3 > Configuration > RPCN > Create Account (any email, a token the league host gives you), then Test');
  return notes;
}

// ---- generic rosters: the stored rosters of the generic teams (PLST / DCST in the standard-data entry of the game
// archives) re-keyed to the 100-player patch's stride, every copy in place, originals backed up first. The build's
// generic plan (the roster tools' generics.ts) then gives each team's rows its real 2026 players' names, numbers, class,
// height and weight; positions and ratings stay. A team whose rows no longer match the plan (a swap) is left as it is.
const genericTeamName = (tgid: number) => P.genericRosters?.teams.find((t) => t.tgid === tgid)?.team ?? String(tgid);
function installGenericRosters(rpcs3: string): string[] {
  const archives = gameArchives(rpcs3), copies = findStdaCopies(archives);
  if (!copies.length) return [`no game archive with the standard-data entry found under ${rpcs3} (${archives.length} archive(s) checked)`];
  const plan = P.genericRosters?.rows ?? [];
  if (!plan.length && copies.every((c) => c.stride === 100)) return copies.map((c) => `${path.basename(c.archive)}: already at stride 100`);
  if (rpcs3RunningOver(archives)) return ['RPCS3 is running from this install: close it, then run join again to set up the generic rosters'];
  const dir = newStdaBackupDir(), notes: string[] = []; let wrote = false;
  for (const c of copies) {
    let filled = '';
    const edit = plan.length ? (f: Parameters<typeof fillGenericRows>[0]) => {
      const stale = new Set(staleGenericRows(f, plan).map((r) => r.tgid));
      const r = fillGenericRows(f, plan.filter((x) => !stale.has(x.tgid)));
      filled = `; real rosters: ${r.teams.map(genericTeamName).join(', ') || 'none'}${stale.size ? `; left as is (rows changed by a swap): ${[...stale].map(genericTeamName).join(', ')}` : ''}`;
    } : undefined;
    try { const r = rekeyStdaArchive(c.archive, dir, { to: 100, tool: 'FCS-online.exe join', edit }); wrote ||= r.status === 'rekeyed'; notes.push(`${path.basename(c.archive)}: ${r.status === 'rekeyed' ? `updated, ${r.note}` : r.status === 'already' ? 'already current' : `skipped (${r.note})`}${r.status === 'skipped' ? '' : filled}`); }
    catch (e) { notes.push(`${path.basename(c.archive)}: NOT changed: ${(e as Error).message}`); }
  }
  if (wrote) notes.push(`original entries backed up in ${dir} (ncaa-bridge stda restore --backup "${dir}" puts them back)`);
  return notes;
}
function genericRosterStatus(rpcs3: string): string[] {
  const copies = findStdaCopies(gameArchives(rpcs3)), plan = P.genericRosters?.rows ?? [];
  if (!copies.length) return ['generic rosters: no game archive with the standard-data entry found'];
  return copies.map((c) => {
    let names = '';
    if (!c.error && plan.length) { const f = stdaFile(c.archive); if (f) names = `, real names on ${filledGenericRows(f, plan)} of ${plan.length} rows`; }
    return `generic rosters in ${path.basename(c.archive)}: ${c.error ?? `${c.stride === 100 ? 'stride 100 (current)' : `stride ${c.stride ?? '?'} (join re-keys them)`}${names}`}`;
  });
}

// ---- score bug: the in-game score bug's team names / colours (CFBR's Apt movie in the DLC qkl_patch.ast, with the
// commissioner's fixes and FBS swaps), written when the member's copy is the FCS mod's original or one an earlier build
// shipped (bridge/src/scorebug.ts: in place, or appended when it no longer fits), what it replaces backed up first --
function installScorebug(rpcs3: string): string[] {
  if (!P.scorebug) return ['this build carries no score bug fix'];
  const archive = scorebugArchive(rpcs3); if (!fs.existsSync(archive)) return [`no ${archive} (install the FCS mod first)`];
  if (rpcs3RunningOver([archive])) return ['RPCS3 is running from this install: close it, then run join again to fix the score bug'];
  try { return [writeScorebug(archive, Buffer.from(P.scorebug.stream, 'base64'), newScorebugBackupDir(), { replaces: P.scorebug.replaces, tool: 'FCS-online.exe join' }).note]; }
  catch (e) { return [`NOT changed: ${(e as Error).message}`]; }
}
function scorebugStatus(rpcs3: string): string {
  const archive = scorebugArchive(rpcs3); if (!fs.existsSync(archive)) return 'score bug: no qkl_patch.ast in the DLC folder';
  const loc = readScorebug(archive); if (!loc) return 'score bug: entry not found in qkl_patch.ast';
  return `score bug: ${P.scorebug?.sha === loc.sha ? 'current' : P.scorebug?.replaces.includes(loc.sha) ? (loc.sha === FCS_MOD_SCOREBUG_SHA ? "the FCS mod's original (join fixes it)" : 'an earlier version (join updates it)') : `sha ${loc.sha.slice(0, 12)} (not this build's)`}`;
}

// ---- roster save -------------------------------------------------------------------------------------------------
// Installs the build's roster save once per roster: a later run with the same roster leaves the save alone (it changes
// after install: the generic-team step writes into it, players save edits from the game). A build with a different
// roster replaces it, the old folder kept under ROSTER_BACKUP (not in savedata, where the game would list it).
const ROSTER_STATE = path.join(process.env.LOCALAPPDATA || os.homedir(), 'ncaa-bridge', 'roster-installed.json');
function installRoster(rpcs3: string): string {
  if (!P.roster) return 'this build carries no roster save';
  const dir = path.join(rpcs3, 'dev_hdd0', 'home', '00000001', 'savedata', P.roster.dir);
  const shipped = sha1(Buffer.concat(Object.keys(P.roster.files).sort().map((n) => Buffer.from(P.roster!.files[n]!, 'base64'))));
  let state: Record<string, string> = {}; try { state = JSON.parse(fs.readFileSync(ROSTER_STATE, 'utf8')); } catch { /* first install */ }
  const key = path.resolve(dir).toLowerCase(), remember = () => { state[key] = shipped; fs.mkdirSync(path.dirname(ROSTER_STATE), { recursive: true }); fs.writeFileSync(ROSTER_STATE, JSON.stringify(state, null, 1)); };
  if (fs.existsSync(path.join(dir, 'USR-DATA')) && state[key] === shipped) return `roster save ${P.roster.dir}: this build's roster is already installed (changes made since are kept)`;
  const same = (name: string, b64: string) => { const f = path.join(dir, name); return fs.existsSync(f) && fs.readFileSync(f).equals(Buffer.from(b64, 'base64')); };
  if (fs.existsSync(dir) && Object.entries(P.roster.files).every(([n, b]) => same(n, b))) { remember(); return `roster save ${P.roster.dir}: already current`; }
  let kept = '';
  if (fs.existsSync(dir)) { const to = path.join(ROSTER_BACKUP, `${P.roster.dir}-${stamp()}`); fs.cpSync(dir, to, { recursive: true }); fs.rmSync(dir, { recursive: true }); kept = ` (the one it replaced is in ${to})`; }
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, b64] of Object.entries(P.roster.files)) fs.writeFileSync(path.join(dir, name), Buffer.from(b64, 'base64'));
  remember();
  return `roster save ${P.roster.dir} installed (${Object.keys(P.roster.files).length} files)${kept}. ${P.roster.note}`;
}

// ---- host: the league server from a project checkout --------------------------------------------------------------
function findProject(): string | null {
  const cands = [flags.get('project'), process.cwd()]; let d = path.dirname(process.execPath); for (let i = 0; i < 5; i++) { cands.push(d); d = path.dirname(d); }
  for (const c of cands) if (c && fs.existsSync(path.join(c, 'spike', 'blaze', 'server', 'league.mjs'))) return path.resolve(c);
  return null;
}
async function hostFlow(): Promise<void> {
  let proj = findProject();
  if (!proj) { const p = await ask('Path of the football-sim-project checkout (has spike\\blaze\\server\\league.mjs)'); if (fs.existsSync(path.join(p, 'spike', 'blaze', 'server', 'league.mjs'))) proj = path.resolve(p); }
  if (!proj) { say('No project checkout found. The league server runs from the repository (git clone + npm install), not from this exe.'); return; }
  const node = spawnSync('node', ['--version'], { encoding: 'utf8' });
  if (node.status !== 0) { say('Node.js is not on PATH. Install Node 20 or newer from https://nodejs.org and run this again.'); return; }
  if (!fs.existsSync(path.join(proj, 'node_modules'))) { say(`Installing dependencies in ${proj} (npm install)...`); const r = spawnSync('npm', ['install'], { cwd: proj, stdio: 'inherit', shell: true }); if (r.status !== 0) { say('npm install failed'); return; } }
  say(`Starting the league server from ${proj} (Node ${node.stdout.trim()}) in its own window...`);
  const child = spawn('node', [path.join(proj, 'spike', 'blaze', 'server', 'league.mjs'), 'start', ...(flags.get('lan') ? ['--lan', flags.get('lan')!] : [])], { cwd: proj, detached: true, stdio: 'ignore', shell: false });
  child.unref();
  say('Started. league-status.cmd in spike\\blaze\\server shows the services; the private RPCN server (WSL) must be running too.');
  say(`Members point their RPCS3 at this PC's address with: FCS-online.exe join --server <this PC's IP> --rpcn <this PC's IP>:31313`);
}

// ---- swaps on a member's install: the commissioner's generic slots (home stadiums, FBS swaps) from swap-pack.bin --
function swapBlob(): Buffer | null {
  try { const sea = require('node:sea'); if (sea.isSea()) return Buffer.from(sea.getAsset('swap-pack.bin')); } catch { /* not a SEA build */ }
  const f = path.resolve(__dirname, '..', 'generated', 'swap-pack.bin'); return fs.existsSync(f) ? fs.readFileSync(f) : null;
}
function installSwaps(rpcs3: string): string[] {
  if (!P.swapPack) return ['this build carries no generic-slot setup'];
  const blob = swapBlob(); if (!blob) return ['this exe has no swap pack'];
  if (rpcs3RunningOver(gameArchives(rpcs3))) return ['RPCS3 is running from this install: close it, then run join again'];
  return applySwapPack(rpcs3, P.swapPack, blob, path.join(SWAP_ROOT, `${stamp()}-join`)).map((x) => `${x.status === 'error' ? 'NOT done' : x.label}: ${x.status === 'error' ? `${x.label}: ${x.note}` : x.note}`);
}

// ---- private playbooks the teams shaped on the site (bridge/src/playbook-pack.ts): each book into its slot's entry of
// qkl_fe2ig.ast (only over the stock donor book or an earlier version of the same book), the list rows renamed, the teams
// pointed at them in the roster save and the default roster. Every member needs the same books: a game between two
// consoles with different playbook data crashes.
function playbookBlob(): Buffer | null {
  try { const sea = require('node:sea'); if (sea.isSea()) return Buffer.from(sea.getAsset('playbook-pack.bin')); } catch { /* not a SEA build */ }
  const f = path.resolve(__dirname, '..', 'generated', 'playbook-pack.bin'); return fs.existsSync(f) ? fs.readFileSync(f) : null;
}
function installPlaybooks(rpcs3: string): string[] {
  if (!P.playbooks) return ['this build carries no private playbooks'];
  const blob = playbookBlob(); if (!blob) return ['this exe has no playbook pack'];
  if (rpcs3RunningOver(gameArchives(rpcs3))) return ['RPCS3 is running from this install: close it, then run join again'];
  const dir = newEntryBackupDir('playbook');
  const steps = applyPlaybookPack(rpcs3, P.playbooks, blob, dir, 'FCS-online.exe join');
  const out = steps.map((s) => `${s.label}: ${s.status === 'error' ? `NOT done: ${s.note}` : s.status === 'already' ? 'already current' : s.note}`);
  if (steps.some((s) => s.status === 'done')) out.push(`what they replaced is backed up in ${dir} (ncaa-bridge playbook restore --backup "${dir}" puts it back)`);
  return out;
}

// ---- swap: an FBS team into a generic slot, from a local web page (bridge/src/swap; the page is swap-ui.html) ------
async function swapFlow(): Promise<void> {
  const rpcs3 = await chooseRpcs3(); say(`RPCS3: ${rpcs3}`);
  const cfbr = flags.get('cfbr') ?? findCfbrPkg();
  say(cfbr ? `CFBR installer: ${cfbr}` : 'CFBR installer pkg not found on the Desktop or in Downloads (pass --cfbr <path>); the page opens, swapping needs it');
  const donors = flags.get('donors') ?? findDonorRoster() ?? (P.swapDonors ? new Uint8Array(Buffer.from(P.swapDonors.b64, 'base64')) : undefined);
  if (!donors) { say('No FBS donor roster on disk or in this build (pass --donors <PHOENIX26 USR-DATA>)'); return; }
  say(`FBS players from: ${typeof donors === 'string' ? donors : `${P.swapDonors!.name} (in this build)`}`);
  const tool = new SwapTool({ rpcs3, cfbrPkg: cfbr, donorRoster: donors });
  const s = await startSwapServer(tool, swapPage, Number(flags.get('port') ?? 0));
  say(`\nSwap tool open at ${s.url}\nKeep this window open while you use it; close it (or press Ctrl+C) when you are done.`);
  if (!flags.has('no-open')) spawn('cmd', ['/c', 'start', '', s.url], { detached: true, stdio: 'ignore' }).unref();
  rl.close(); await new Promise(() => { /* serve until the window is closed */ });
}

// ---- flows -------------------------------------------------------------------------------------------------------
// The game files these steps write must not be open: wait for RPCS3 to be closed (or stop)
async function rpcs3Closed(rpcs3: string): Promise<boolean> {
  const files = [...gameArchives(rpcs3), scorebugArchive(rpcs3)].filter((f) => fs.existsSync(f));
  while (rpcs3RunningOver(files)) {
    if (YES) { say('RPCS3 is running from this install: close it, then run this again'); return false; }
    if ((await rl.question('\nRPCS3 is open. Close the whole RPCS3 window, then press Enter here (or type q and Enter to stop): ')).trim().toLowerCase() === 'q') return false;
  }
  return true;
}
// install: everything a player needs for the FCS mod add-ons; join: the same plus the league's network settings and site
async function setupFlow(online: boolean): Promise<void> {
  say(online ? `\nJoin an online league (this build: ${P.builtAt})\n` : `\nInstall or update the FCS mod add-ons (this build: ${P.builtAt})\n`);
  const rpcs3 = await chooseRpcs3(); say(`RPCS3: ${rpcs3}`);
  let server = '', rpcn = '';
  if (online) {
    server = await ask('League server address (the host PC\'s IP, or 127.0.0.1 on the host itself)', flags.get('server') ?? '127.0.0.1');
    rpcn = await ask('Private PSN (RPCN) server host:port', flags.get('rpcn') ?? `${server}:31313`);
  }
  if (!(await rpcs3Closed(rpcs3))) { say('Stopped; nothing was changed.'); return; }
  let n = 0; const step = (t: string) => say(`\n${++n}. ${t}`);
  step('Game patches');
  const r = installPatches(rpcs3);
  for (const x of r.changed) say(`   installed/updated: ${x}`); for (const x of r.kept) say(`   already current:   ${x}`); say('   all entries enabled for 01.00 and 01.02 in config/patch_config.yml');
  step('Uniforms (sets for the Coming Soon teams, stop-gap XMLs)');
  const u = installUniforms(rpcs3);
  if (u.missingDlc) say(`   the FCS mod DLC folder is missing (${dlcDir(rpcs3)}); install the FCS mod first, then run this again`);
  else {
    for (const x of u.written) say(`   wrote ${x}`);
    if (u.same.length) say(`   already current: ${u.same.join(', ')}`);
    if (u.bigfiles.written || u.bigfiles.same) say(`   uniform files: ${u.bigfiles.written} written, ${u.bigfiles.same} already current`);
    for (const x of u.setAside) say(`   moved aside (same slot defined in another folder): ${x}`);
    if (u.missingPack) say('   this exe has no uniform pack (built without it); only the stop-gap XMLs were installed');
    if (dlcBackups) say(`   ${dlcBackups} replaced file(s) backed up in ${DLC_BACKUP}`);
  }
  step('Score bug (team names and colours)');
  for (const x of installScorebug(rpcs3)) say(`   ${x}`);
  step(`Generic teams' stored rosters (re-keyed for the 100-player patch${P.genericRosters ? ', real 2026 rosters' : ''})`);
  for (const x of installGenericRosters(rpcs3)) say(`   ${x}`);
  if (online) { step('Network'); for (const x of configureNetwork(rpcs3, server, rpcn)) say(`   ${x}`); }
  if (P.roster && flags.get('roster') !== 'false') { step(`Roster save ${P.roster.dir} (up to 90 players per team)`); say(`   ${installRoster(rpcs3)}`); }
  step(`Generic teams: home stadiums and FBS swaps${P.swapPack ? ` (${swapPackSummary(P.swapPack)})` : ''}`);
  for (const x of installSwaps(rpcs3)) say(`   ${x}`);
  if (P.playbooks) { step(`Playbooks the teams shaped on the site (${packSummary(P.playbooks)})`); for (const x of installPlaybooks(rpcs3)) say(`   ${x}`); }
  if (online) {
    step(`Companion site: ${P.site}`);
    say('   Create your account there (Sign in), then tell the commissioner your account name so they can link your team.');
    if (!YES && await confirm('   Open it in the browser now?')) spawn('cmd', ['/c', 'start', '', P.site], { detached: true, stdio: 'ignore' }).unref();
  }
  say(`\nDone. Start RPCS3, check Manage > Game Patches shows the FCS mod entries ticked, and start the game${P.roster ? `; in the game, load the roster ${P.roster.dir.replace(/^BLUS31159-/, '')}` : ''}.`);
}
async function statusFlow(): Promise<void> {
  const rpcs3 = await chooseRpcs3(); say(`RPCS3: ${rpcs3}`);
  for (const l of patchStatus(rpcs3)) say(`  ${l}`);
  const dlc = dlcDir(rpcs3); say(`  DLC folder: ${fs.existsSync(dlc) ? `${fs.readdirSync(dlc).filter((f) => f.startsWith('FCS_DLC_')).length} FCS_DLC folders` : 'MISSING (mod not installed)'}`);
  for (const n of Object.keys(P.uniforms)) say(`  uniform XML ${n}: ${fs.existsSync(path.join(dlc, 'FCS_DLC_NEC', n)) ? 'present' : 'missing'}`);
  if (P.uniformSets?.length) {
    const st = { current: 0, different: 0, missing: 0 }; const off: string[] = [];
    for (const u of P.uniformSets) { const f = path.join(dlc, u.folder, u.name); const s = !fs.existsSync(f) ? 'missing' : sha1(fs.readFileSync(f)) === u.sha1 ? 'current' : 'different'; st[s]++; if (s !== 'current' && /_MixAndMatch\.XML$/i.test(u.name)) off.push(`${u.folder}\\${u.name} ${s}`); }
    say(`  uniform sets: ${st.current} of ${P.uniformSets.length} files current, ${st.different} different, ${st.missing} missing${off.length ? ` (${off.join('; ')})` : ''}`);
  }
  for (const l of genericRosterStatus(rpcs3)) say(`  ${l}`);
  say(`  ${scorebugStatus(rpcs3)}`);
  if (P.swapPack) say(`  generic slots in this build: ${swapPackSummary(P.swapPack)}`);
  if (P.playbooks) for (const l of playbookPackStatus(rpcs3, P.playbooks)) say(`  playbook ${l}`);
  const custom = path.join(rpcs3, 'config', 'custom_configs', `config_${GAME}.yml`);
  if (fs.existsSync(custom)) { const t = fs.readFileSync(custom, 'utf8'); for (const k of ['Internet enabled', 'PSN status', 'IP swap list']) say(`  Net ${k}: ${/^  (Internet enabled|PSN status|IP swap list): (.*)$/m.exec(t.split('\n').find((l) => l.startsWith(`  ${k}:`)) ?? '')?.[2] ?? '?'}`); } else say('  no custom game config');
  const rp = path.join(rpcs3, 'config', 'rpcn.yml'); say(`  RPCN: ${fs.existsSync(rp) ? `host ${/^Host: (.*)$/m.exec(fs.readFileSync(rp, 'utf8'))?.[1] ?? '?'}, account ${/^NPID: "?([^"\n]+)"?$/m.test(fs.readFileSync(rp, 'utf8')) ? 'present' : 'none'}` : 'no rpcn.yml'}`);
  if (P.roster) say(`  roster save ${P.roster.dir}: ${fs.existsSync(path.join(rpcs3, 'dev_hdd0', 'home', '00000001', 'savedata', P.roster.dir, 'USR-DATA')) ? 'installed' : 'not installed'}`);
}
async function main(): Promise<void> {
  let mode = words[0] ?? flags.get('mode');
  if (!mode) {
    say(`FCS mod add-ons (this build: ${P.builtAt})\n  1. Install or update: game patches, uniforms, score bug${P.roster ? ', 2026 roster' : ''}  <- start here\n  2. Join an online league: everything in 1, plus your league's server settings\n  3. Host a league (commissioner): start the league server from a project checkout\n  4. Status of this PC's setup\n  5. Swap an FBS team into a generic slot (commissioner)\n  6. Quit`);
    mode = { '1': 'install', '2': 'join', '3': 'host', '4': 'status', '5': 'swap' }[await ask('Choice', '1')] ?? 'quit';
  }
  if (mode === 'install') await setupFlow(false);
  else if (mode === 'join') await setupFlow(true);
  else if (mode === 'roster') { const rpcs3 = await chooseRpcs3(); say(installRoster(rpcs3)); }
  else if (mode === 'host') await hostFlow();
  else if (mode === 'status') await statusFlow();
  else if (mode === 'swap') await swapFlow();
  else if (mode !== 'quit') say(`unknown mode ${mode}; use install | join | roster | host | status | swap`);
}
// started by double-clicking (no mode on the command line): keep the window open until the reader is done
const holdWindow = async () => { if (!words[0] && !flags.has('mode') && !YES) await rl.question('\nPress Enter to close this window.'); };
main().then(holdWindow, async (e: Error) => { console.error(`error: ${e.message}`); process.exitCode = 1; await holdWindow(); }).finally(() => rl.close());
