// FCS-online: one executable that sets a member's RPCS3 up for the FCS mod online league (the roster/jersey patches,
// the uniform sets and stop-gap uniform files, the league server address, the private PSN server), installs the FCS2026
// roster save, and starts the league server on the host's PC. Built into a single .exe by installer/build.mjs (Node
// SEA); the payload (patch entries, uniform XMLs, optional roster save) is generated at build time from the project's
// private files and embedded, the uniform sets' bigfiles as the SEA asset uniform-pack.bin. `join` also re-keys the
// generic teams' stored rosters in the game archives to the 100-player stride (bridge/src/stda.ts, bundled in). Runs
// as a console wizard; every flag makes a step non-interactive.
//
//   FCS-online.exe                       menu
//   FCS-online.exe join   [--rpcs3 DIR] [--server IP] [--rpcn HOST:PORT] [--yes]
//   FCS-online.exe roster [--rpcs3 DIR] [--yes]
//   FCS-online.exe host   [--project DIR]
//   FCS-online.exe status [--rpcs3 DIR]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import payload from '../generated/payload.json';
import { findStdaCopies, gameArchives, newStdaBackupDir, rekeyStdaArchive, rpcs3RunningOver } from '../../bridge/src/stda.js';

interface UniformFile { folder: string; name: string; offset: number; size: number; sha1: string }
interface Payload { builtAt: string; site: string; ppuHash: string; patches: { name: string; block: string; words: number }[]; uniforms: Record<string, string>; uniformSets?: UniformFile[]; roster?: { dir: string; files: Record<string, string>; note: string } }
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
  for (const u of sets) {
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
// archives) re-keyed to the 100-player patch's stride, every copy in place, originals backed up first -------------------
function installGenericRosters(rpcs3: string): string[] {
  const archives = gameArchives(rpcs3), copies = findStdaCopies(archives);
  if (!copies.length) return [`no game archive with the standard-data entry found under ${rpcs3} (${archives.length} archive(s) checked)`];
  if (copies.every((c) => c.stride === 100)) return copies.map((c) => `${path.basename(c.archive)}: already at stride 100`);
  if (rpcs3RunningOver(archives)) return ['RPCS3 is running from this install: close it, then run join again to re-key the generic rosters'];
  const dir = newStdaBackupDir(), notes: string[] = [];
  for (const c of copies) {
    try { const r = rekeyStdaArchive(c.archive, dir, { to: 100, tool: 'FCS-online.exe join' }); notes.push(`${path.basename(c.archive)}: ${r.status === 'rekeyed' ? `re-keyed, ${r.note}` : r.status === 'already' ? 'already at stride 100' : `skipped (${r.note})`}`); }
    catch (e) { notes.push(`${path.basename(c.archive)}: NOT changed: ${(e as Error).message}`); }
  }
  if (fs.existsSync(path.join(dir, 'manifest.json'))) notes.push(`original entries backed up in ${dir} (ncaa-bridge stda restore --backup "${dir}" puts them back)`);
  return notes;
}
function genericRosterStatus(rpcs3: string): string[] {
  const copies = findStdaCopies(gameArchives(rpcs3));
  if (!copies.length) return ['generic rosters: no game archive with the standard-data entry found'];
  return copies.map((c) => `generic rosters in ${path.basename(c.archive)}: ${c.error ?? (c.stride === 100 ? 'stride 100 (current)' : `stride ${c.stride ?? '?'} (join re-keys them)`)}`);
}

// ---- roster save -------------------------------------------------------------------------------------------------
function installRoster(rpcs3: string): string {
  if (!P.roster) return 'this build carries no roster save';
  const dir = path.join(rpcs3, 'dev_hdd0', 'home', '00000001', 'savedata', P.roster.dir);
  if (fs.existsSync(dir)) { const b = `${dir}.bak-${stamp()}`; fs.renameSync(dir, b); }
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, b64] of Object.entries(P.roster.files)) fs.writeFileSync(path.join(dir, name), Buffer.from(b64, 'base64'));
  return `roster save ${P.roster.dir} installed (${Object.keys(P.roster.files).length} files). ${P.roster.note}`;
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

// ---- flows -------------------------------------------------------------------------------------------------------
async function joinFlow(): Promise<void> {
  say(`\nFCS online: member setup (payload built ${P.builtAt})\n`);
  const rpcs3 = await chooseRpcs3(); say(`RPCS3: ${rpcs3}`);
  const server = await ask('League server address (the host PC\'s IP, or 127.0.0.1 on the host itself)', flags.get('server') ?? '127.0.0.1');
  const rpcn = await ask('Private PSN (RPCN) server host:port', flags.get('rpcn') ?? `${server}:31313`);
  say('\n1. Game patches');
  const r = installPatches(rpcs3);
  for (const n of r.changed) say(`   installed/updated: ${n}`); for (const n of r.kept) say(`   already current:   ${n}`); say('   all entries enabled for 01.00 and 01.02 in config/patch_config.yml');
  say('\n2. Uniforms (placeholder sets for the Coming Soon teams, stop-gap XMLs)');
  const u = installUniforms(rpcs3);
  if (u.missingDlc) say(`   the FCS mod DLC folder is missing (${dlcDir(rpcs3)}); install the FCS mod first, then run this again`);
  else {
    for (const n of u.written) say(`   wrote ${n}`);
    if (u.same.length) say(`   already current: ${u.same.join(', ')}`);
    if (u.bigfiles.written || u.bigfiles.same) say(`   uniform files: ${u.bigfiles.written} written, ${u.bigfiles.same} already current`);
    for (const n of u.setAside) say(`   moved aside (same slot defined in another folder): ${n}`);
    if (u.missingPack) say('   this exe has no uniform pack (built without it); only the stop-gap XMLs were installed');
    if (dlcBackups) say(`   ${dlcBackups} replaced file(s) backed up in ${DLC_BACKUP}`);
  }
  say('\n3. Generic teams\' stored rosters (re-keyed for the 100-player patch)');
  for (const n of installGenericRosters(rpcs3)) say(`   ${n}`);
  say('\n4. Network');
  for (const n of configureNetwork(rpcs3, server, rpcn)) say(`   ${n}`);
  if (P.roster && (flags.get('roster') === 'true' || (!YES && await confirm(`\n5. Install the roster save ${P.roster.dir} (up to 90 players per team; needs the patches above)?`, false)))) say(`   ${installRoster(rpcs3)}`);
  say(`\n6. Companion site: ${P.site}`);
  say('   Create your account there (Sign in), then tell the commissioner your account name so they can link your team.');
  if (!YES && await confirm('   Open it in the browser now?')) spawn('cmd', ['/c', 'start', '', P.site], { detached: true, stdio: 'ignore' }).unref();
  say('\nDone. Start RPCS3, check Manage > Game Patches shows the FCS mod entries ticked, and load the game.');
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
  const custom = path.join(rpcs3, 'config', 'custom_configs', `config_${GAME}.yml`);
  if (fs.existsSync(custom)) { const t = fs.readFileSync(custom, 'utf8'); for (const k of ['Internet enabled', 'PSN status', 'IP swap list']) say(`  Net ${k}: ${/^  (Internet enabled|PSN status|IP swap list): (.*)$/m.exec(t.split('\n').find((l) => l.startsWith(`  ${k}:`)) ?? '')?.[2] ?? '?'}`); } else say('  no custom game config');
  const rp = path.join(rpcs3, 'config', 'rpcn.yml'); say(`  RPCN: ${fs.existsSync(rp) ? `host ${/^Host: (.*)$/m.exec(fs.readFileSync(rp, 'utf8'))?.[1] ?? '?'}, account ${/^NPID: "?([^"\n]+)"?$/m.test(fs.readFileSync(rp, 'utf8')) ? 'present' : 'none'}` : 'no rpcn.yml'}`);
  if (P.roster) say(`  roster save ${P.roster.dir}: ${fs.existsSync(path.join(rpcs3, 'dev_hdd0', 'home', '00000001', 'savedata', P.roster.dir, 'USR-DATA')) ? 'installed' : 'not installed'}`);
}
async function main(): Promise<void> {
  let mode = words[0] ?? flags.get('mode');
  if (!mode) {
    say(`FCS online league setup (built ${P.builtAt})\n  1. Join a league: set this PC's RPCS3 up (patches, uniform sets, server address, PSN server)\n  2. Install the FCS2026 roster save${P.roster ? '' : ' (not in this build)'}\n  3. Host a league: start the league server from a project checkout\n  4. Status of this PC's setup\n  5. Quit`);
    mode = { '1': 'join', '2': 'roster', '3': 'host', '4': 'status' }[await ask('Choice', '1')] ?? 'quit';
  }
  if (mode === 'join') await joinFlow();
  else if (mode === 'roster') { const rpcs3 = await chooseRpcs3(); say(installRoster(rpcs3)); }
  else if (mode === 'host') await hostFlow();
  else if (mode === 'status') await statusFlow();
  else if (mode !== 'quit') say(`unknown mode ${mode}; use join | roster | host | status`);
  rl.close();
}
main().catch((e: Error) => { console.error(`error: ${e.message}`); rl.close(); process.exitCode = 1; });
