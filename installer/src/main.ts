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
//   FCS-online.exe join   [--rpcs3 DIR] [--profile FILE | --code - | --code FCS1-...] [--server HOST] [--trust-server] [--psn disconnected|simulated]
//                         [--skip-check] [--check-timeout MS] [--roster false] [--yes]      (the online league: docs/online-member-setup.md;
//                         --code - reads the join code from standard input, so it is not in the process list or the shell history)
//   FCS-online.exe join-lan [--rpcs3 DIR] [--server IP] [--rpcn HOST:PORT] [--roster false] [--yes]   (a league on a private RPCN server; also: join --rpcn ...)
//   FCS-online.exe check  [--server HOST] [--rpcs3 DIR] [--check-timeout MS]   (can this PC reach the league server, and is the game still set to its address?)
//   FCS-online.exe help                                                   (the modes and flags, and how to hand over a join code safely)
//   FCS-online.exe signout [--rpcs3 DIR] [--yes]                          (remove the personal sign-in and the saved profile)
//   FCS-online.exe roster [--rpcs3 DIR] [--yes]
//   FCS-online.exe host   [--project DIR]
//   FCS-online.exe status [--rpcs3 DIR] [--no-check]
//   FCS-online.exe swap   [--rpcs3 DIR] [--cfbr PKG] [--donors USR-DATA] [--port N] [--no-open]   (commissioner: FBS team -> generic slot)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline/promises';
import { findOnPath, openInBrowser, spawn, spawnSync } from './online/system.js'; // never node:child_process directly: programs start by full path
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
import { Writable } from 'node:stream';
import type { AdapterTemplate } from '../../spike/blaze/tools/np-adapter-rpcs3.mjs';
import { CREDENTIAL_PATCH, adapterConflicts, credentialPatchEntry } from './online/np-patch.js';
import { enablePatchEntries, isPatchEnabled, mergePatchEntries, patchEntryBlock, patchEntryState, removePatchEntry, type PatchEntry } from './online/patch-files.js';
import { OWN_CODE_RULE, ProfileError, describeProfile, findDownloadedProfiles, forgetProfile, identityOf, inheritAccess, isOfficialServer, isPunycodeName, loadInstallNote, loadStoredProfile, profileChange, profileStorePath, profileWarnings, readProfileFile, readProfileInput, readProfileText, restrictToUser, saveInstallNote, saveProfile, serverNameProblem, shownPath, type OnlineProfile } from './online/profile.js';
import { configureOnlineNet, isIPv4, netState, setYamlKey, type PsnMode } from './online/rpcs3-config.js';
import { FIX_COMMAND, addressDrift, checkServer, resolveIPv4, verdict } from './online/netcheck.js';

interface UniformFile { folder: string; name: string; offset: number; size: number; sha1: string }
interface Payload { builtAt: string; site: string; ppuHash: string; patches: { name: string; block: string; words: number }[]; uniforms: Record<string, string>; uniformSets?: UniformFile[]; roster?: { dir: string; files: Record<string, string>; note: string }; genericRosters?: { built: string; teams: { tgid: number; team: string }[]; rows: GenericPlanRow[] }; scorebug?: { stream: string; sha: string; replaces: string[]; teams: number }; swapDonors?: { name: string; b64: string }; swapPack?: SwapPackManifest; playbooks?: PlaybookPackManifest; npAdapter?: AdapterTemplate }
const P = payload as Payload;
const GAME = 'BLUS31159';
const args = process.argv.slice(2);
const flags = new Map<string, string>(); const words: string[] = [];
for (let i = 0; i < args.length; i++) { const a = args[i]!; if (a.startsWith('--')) { const v = args[i + 1] && !args[i + 1]!.startsWith('--') ? args[++i]! : 'true'; flags.set(a.slice(2), v); } else words.push(a); }
const YES = flags.get('yes') === 'true';
// the console goes through a gate, so a pasted join code is not shown on screen (askHidden)
let muted = false;
const gate = new Writable({ write(chunk, _enc, cb) { if (!muted) process.stdout.write(chunk); cb(); } });
Object.defineProperty(gate, 'columns', { get: () => process.stdout.columns }); // readline wraps long lines by the console's width
const isConsole = !!process.stdin.isTTY && !!process.stdout.isTTY;
const rl = readline.createInterface({ input: process.stdin, output: gate, terminal: isConsole });
// A question nobody can answer (piped input that ran out) stops the wizard with an error: it must never end quietly,
// as if the step had been answered, with exit code 0. Input that is not a console (a script's pipe) is read line by
// line as it arrives and each question takes the next line, so an answer sent before its question is not lost.
let inputClosed = false;
const noInput = () => new Error('this step needs an answer and there is no more input: run it in a console window, or pass --yes and the flags for each step (FCS-online.exe help)');
const early: string[] = []; let waiting: { resolve: (line: string) => void; reject: (e: Error) => void } | null = null;
if (!isConsole) rl.on('line', (line) => { if (waiting) { const w = waiting; waiting = null; w.resolve(line); } else early.push(line); });
rl.once('close', () => { inputClosed = true; if (waiting) { const w = waiting; waiting = null; w.reject(noInput()); } });
const pipedLine = (): Promise<string> => (early.length ? Promise.resolve(early.shift()!) : inputClosed ? Promise.reject(noInput()) : new Promise((resolve, reject) => { waiting = { resolve, reject }; }));
const question = (q: string): Promise<string> => {
  if (!isConsole) { gate.write(q); return pipedLine(); }
  return new Promise((resolve, reject) => {
    if (inputClosed) { reject(noInput()); return; }
    const onClose = () => reject(noInput());
    rl.once('close', onClose);
    rl.question(q).then((a) => { rl.off('close', onClose); resolve(a); }, reject);
  });
};
const ask = async (q: string, def = ''): Promise<string> => { if (YES && def) return def; const a = (await question(def ? `${q} [${def}]: ` : `${q}: `)).trim(); return a || def; };
const confirm = async (q: string, def = true): Promise<boolean> => { if (YES) return def; const a = (await question(`${q} ${def ? '[Y/n]' : '[y/N]'}: `)).trim().toLowerCase(); return a ? a.startsWith('y') : def; };
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backup = (file: string): string | null => { if (!fs.existsSync(file)) return null; const b = `${file}.bak-${stamp()}`; fs.copyFileSync(file, b); return b; };
const say = (s = '') => console.log(s);
const askHidden = async (q: string): Promise<string> => { process.stdout.write(q); muted = true; try { return (await question('')).trim(); } finally { muted = false; process.stdout.write('\n'); } };
// --code - : the join code is the first line of standard input (pasted hidden in a console, or piped in by a script),
// so it is in no process list and no shell history. The line is claimed here, before anything else reads the input;
// the wizard waits for it first thing. '' when the input ended without one.
const stdinCode: Promise<string> | null = flags.get('code') !== '-' ? null
  : isConsole ? askHidden('Join code (paste it and press Enter; it stays hidden): ').catch(() => '') : pipedLine().then((line) => line.trim(), () => '');

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
  const given = flags.get('rpcs3');
  if (given && given !== 'true') { if (isRpcs3Dir(given)) return path.resolve(given); say(`--rpcs3 ${shownPath(given)}: no rpcs3.exe + dev_hdd0 there`); if (YES) throw new Error('RPCS3 folder not found; pass --rpcs3 DIR'); }
  const found = findRpcs3();
  if (found.length === 1 && (YES || await confirm(`RPCS3 found at ${found[0]}. Use it?`))) return found[0]!;
  if (found.length > 1) { say('RPCS3 installs found:'); found.forEach((f, i) => say(`  ${i + 1}. ${f}`)); const pick = await ask('Which one (number), or a path'); const n = Number(pick); if (n >= 1 && n <= found.length) return found[n - 1]!; if (isRpcs3Dir(pick)) return path.resolve(pick); }
  for (;;) { const p = await ask('Path of the RPCS3 folder (the one with rpcs3.exe)'); if (isRpcs3Dir(p)) return path.resolve(p); say('  no rpcs3.exe + dev_hdd0 there'); if (YES) throw new Error('RPCS3 folder not found; pass --rpcs3 DIR'); }
}

// ---- patches: patches/imported_patch.yml + config/patch_config.yml --------------------------------------------------
const patchFile = (rpcs3: string) => path.join(rpcs3, 'patches', 'imported_patch.yml');
const patchConfig = (rpcs3: string) => path.join(rpcs3, 'config', 'patch_config.yml');
const readText = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
// a backup copy of the patch file never carries the personal sign-in entry (it holds the member's credential, and join
// can write it again from the saved profile)
function backupPatchFile(file: string): string | null {
  const text = readText(file); if (text === null) return null;
  const b = `${file}.bak-${stamp()}`; fs.writeFileSync(b, removePatchEntry(text, P.ppuHash, CREDENTIAL_PATCH).text); return b;
}
// the mod's entries, plus the member's personal sign-in entry when joining the online league (online/patch-files.ts:
// only this game's section of either file is rewritten, line endings kept)
// With the personal entry in it, the patch file is the member's credential: an RPCS3 folder outside the user's own
// folders (C:\Games\rpcs3) is readable by every account on the PC, so the file's access is cut down to this Windows
// account before the entry is written. `restricted` is null when no personal entry is involved.
function installPatches(rpcs3: string, personal?: PatchEntry): { changed: string[]; kept: string[]; restricted: boolean | null } {
  const entries: PatchEntry[] = [...P.patches, ...(personal ? [personal] : [])];
  const file = patchFile(rpcs3); fs.mkdirSync(path.dirname(file), { recursive: true });
  const old = readText(file), r = mergePatchEntries(old, P.ppuHash, entries);
  let restricted: boolean | null = null;
  if (personal) { if (old === null) fs.writeFileSync(file, '', { flag: 'a' }); restricted = restrictToUser(file, false); }
  if (r.text !== old) { if (old !== null) backupPatchFile(file); fs.writeFileSync(file, r.text); }
  if (personal) scrubPatchBackups(file);
  const cfg = patchConfig(rpcs3); fs.mkdirSync(path.dirname(cfg), { recursive: true });
  const oldCfg = readText(cfg), c = enablePatchEntries(oldCfg, P.ppuHash, entries.map((e) => e.name));
  if (c.text !== oldCfg) { backup(cfg); fs.writeFileSync(cfg, c.text); }
  return { changed: r.changed, kept: r.kept, restricted };
}
// Copies of the patch file next to it (imported_patch.yml.bak-..., or a copy somebody made by hand under a similar
// name) that still hold a personal sign-in entry: the entry is taken out of each, so no old key stays behind.
function scrubPatchBackups(file: string): number {
  let n = 0;
  try {
    for (const f of fs.readdirSync(path.dirname(file))) {
      if (f === path.basename(file) || !f.toLowerCase().startsWith(path.basename(file, '.yml').toLowerCase())) continue;
      const copy = path.join(path.dirname(file), f);
      try {
        const st = fs.lstatSync(copy); if (!st.isFile() || st.size > 64 * 1048576) continue;
        const r = removePatchEntry(fs.readFileSync(copy, 'utf8'), P.ppuHash, CREDENTIAL_PATCH);
        if (r.removed) { fs.writeFileSync(copy, r.text); n++; }
      } catch { /* not a file this can rewrite */ }
    }
  } catch { /* no patches folder */ }
  return n;
}
function patchStatus(rpcs3: string): string[] {
  const text = readText(patchFile(rpcs3)), cfg = readText(patchConfig(rpcs3));
  return P.patches.map((p) => { const s = patchEntryState(text, P.ppuHash, p); return `${s === 'missing' ? 'missing' : s === 'current' ? 'installed' : 'DIFFERENT'}${s === 'missing' ? '' : isPatchEnabled(cfg, P.ppuHash, p.name) ? ', enabled' : ', NOT enabled'}  ${p.name} (${p.words} words)`; });
}
// the personal sign-in entry: present / enabled / written from the profile saved on this PC. Never its contents.
function signInStatus(rpcs3: string): string {
  const text = readText(patchFile(rpcs3)), stored = loadStoredProfile();
  if (patchEntryBlock(text, P.ppuHash, CREDENTIAL_PATCH) === null) return 'league sign-in: not installed (run join with your join code)';
  const enabled = isPatchEnabled(readText(patchConfig(rpcs3)), P.ppuHash, CREDENTIAL_PATCH) ? 'enabled' : 'NOT enabled (run join again)';
  const match = !stored ? 'no profile is saved on this PC (run join again)' : !P.npAdapter ? 'this build cannot compare it with the saved profile'
    : patchEntryState(text, P.ppuHash, credentialPatchEntry(P.npAdapter, stored)) === 'current' ? 'matches the profile saved on this PC' : 'DIFFERENT from the profile saved on this PC (run join again)';
  return `league sign-in: installed, ${enabled}, ${match}`;
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

// ---- network for a league on a private RPCN server (join-lan): the game's custom config (IP swap -> league server, PSN
// -> RPCN) and config/rpcn.yml Host. The online league's settings are written by online/rpcs3-config.ts.
function configureNetwork(rpcs3: string, server: string, rpcn: string): string[] {
  const notes: string[] = [];
  // both values go into RPCS3's settings files as text: only an address in numbers and a plain host:port are written
  if (!isIPv4(server)) return [`NOT done: "${shownPath(server).slice(0, 60)}" is not an IPv4 address (four numbers, like 192.168.1.20). RPCS3 accepts only that for the league server.`];
  if (!/^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(:\d{1,5})?$/.test(rpcn)) return [`NOT done: "${shownPath(rpcn).slice(0, 60)}" is not a host:port for the private PSN server (like 192.168.1.20:31313).`];
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
  // a checkout found by looking around (the current folder, the folders above the exe) holds the code that is about to
  // run: it is named and confirmed first, unless --project chose it
  const named = flags.get('project') && flags.get('project') !== 'true' && path.resolve(flags.get('project')!) === proj;
  if (!named && !(await confirm(`The league server will be started from the checkout at ${proj}. Is that your own copy of the project?`))) { say('Stopped. Pass --project DIR to choose the checkout.'); return; }
  // Node is found on PATH by this program (full folders only, never "the current folder") and started by its full
  // path; npm is run as Node's own npm-cli.js, so no shell and no npm.cmd lookup is involved.
  const nodeExe = findOnPath(process.platform === 'win32' ? 'node.exe' : 'node');
  const node = nodeExe ? spawnSync(nodeExe, ['--version'], { encoding: 'utf8' }) : null;
  if (!nodeExe || !node || node.status !== 0) { say('Node.js is not on PATH. Install Node 20 or newer from https://nodejs.org and run this again.'); return; }
  if (!fs.existsSync(path.join(proj, 'node_modules'))) {
    const npmCli = [path.join(path.dirname(nodeExe), 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(path.dirname(nodeExe), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find((f) => fs.existsSync(f));
    if (!npmCli) { say(`The project's dependencies are not installed and npm was not found next to ${nodeExe}. Open a console in ${proj}, run "npm install", then run this again.`); return; }
    say(`Installing dependencies in ${proj} (npm install)...`);
    const r = spawnSync(nodeExe, [npmCli, 'install'], { cwd: proj, stdio: 'inherit' }); if (r.status !== 0) { say('npm install failed'); return; }
  }
  say(`Starting the league server from ${proj} (Node ${String(node.stdout).trim()}, ${nodeExe}) in its own window...`);
  const child = spawn(nodeExe, [path.join(proj, 'spike', 'blaze', 'server', 'league.mjs'), 'start', ...(flags.get('lan') ? ['--lan', flags.get('lan')!] : [])], { cwd: proj, detached: true, stdio: 'ignore' });
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
  if (!flags.has('no-open') && !openInBrowser(s.url)) say('The browser could not be opened from here: open that address yourself.');
  rl.close(); await new Promise(() => { /* serve until the window is closed */ });
}

// ---- flows -------------------------------------------------------------------------------------------------------
// The game files these steps write must not be open: wait for RPCS3 to be closed (or stop)
async function rpcs3Closed(rpcs3: string): Promise<boolean> {
  const files = [...gameArchives(rpcs3), scorebugArchive(rpcs3)].filter((f) => fs.existsSync(f));
  while (rpcs3RunningOver(files)) {
    if (YES) { say('RPCS3 is running from this install: close it, then run this again'); return false; }
    if ((await question('\nRPCS3 is open. Close the whole RPCS3 window, then press Enter here (or type q and Enter to stop): ')).trim().toLowerCase() === 'q') return false;
  }
  return true;
}
// ---- the online league: the member's profile, the server, the connection check (installer/src/online) ---------------
const NOT_READY = 2; // exit code when a step that matters for playing online did not complete
const siteHost = (() => { try { return new URL(P.site).hostname.toLowerCase(); } catch { return 'fcs-mod.online'; } })();
const profileProblem = (e: unknown) => (e instanceof ProfileError ? e.message : 'That profile could not be read.'); // never the raw error: it may quote the input
// a server name the member typed (--server): held to the same rules as a profile's, then lower-cased
const serverFlag = (): { host?: string; problem?: string } => {
  const v = flags.get('server'); if (!v || v === 'true') return {};
  const problem = serverNameProblem(v);
  return problem ? { problem: `--server ${shownPath(v).slice(0, 80)} cannot be used: ${problem}.` } : { host: v.toLowerCase() };
};
interface Member { profile: OnlineProfile; from: string; file?: string; saved?: boolean }
// The member's profile: --profile / --code - (standard input) / --code, else the one saved on this PC, else a downloaded
// fcs-online-profile.json, else a pasted join code (hidden) or a typed file path. null = the member stopped (or, with
// --yes, there is none). `saved` marks the profile this PC already uses.
async function getProfile(): Promise<Member | null> {
  const code = flags.get('code'), file = flags.get('profile');
  if (stdinCode) {
    try { return { profile: readProfileText(await stdinCode).profile, from: 'the join code from standard input' }; }
    catch (e) { say(`   ${profileProblem(e)}`); say('   (--code - reads the join code from the first line of standard input)'); return null; }
  }
  if (code && code !== 'true') {
    say('   note: a join code on the command line can be read by other programs on this PC while this runs and stays in the shell history.\n   Next time use --profile <file>, --code - (standard input) or the hidden paste; get a new join code on the site if this one may have been seen.');
    try { return { profile: readProfileText(code).profile, from: 'the join code' }; } catch (e) { say(`   ${profileProblem(e)}`); if (YES) return null; }
  }
  else if (file && file !== 'true') { try { return { profile: readProfileFile(file), from: shownPath(file), file }; } catch (e) { say(`   ${profileProblem(e)}`); if (YES) return null; } }
  const stored = loadStoredProfile();
  if (stored && stored.expiresMs > Date.now()) {
    if (YES || await confirm(`This PC already has a profile: ${describeProfile(stored)}.\nKeep using it?`)) return { profile: stored, from: 'the profile saved on this PC', saved: true };
  } else if (stored) say(`The profile saved on this PC (${identityOf(stored)}) has expired; you need a new join code.`);
  if (YES) { say('No profile: pass --profile <fcs-online-profile.json> (from your account page on the site), or --code - with the join code on standard input.'); return null; }
  for (const f of findDownloadedProfiles().slice(0, 3)) {
    try { const p = readProfileFile(f); if (await confirm(`Found ${f}: ${describeProfile(p)}.\nUse it?`)) return { profile: p, from: f, file: f }; } catch { /* not a usable profile: ask instead */ }
  }
  say(`\nYour join code comes from the site: sign in at ${P.site}, open your account page and press "Copy join code"\n(or download fcs-online-profile.json). It is personal, like a password: do not post it or show it on a stream.\n${OWN_CODE_RULE}`);
  for (;;) {
    const pasted = await askHidden('\nPaste the join code and press Enter (right-click pastes; it stays hidden).\nTo use the downloaded profile file instead, just press Enter: ');
    let input = pasted;
    if (!input) { input = await ask('Path of fcs-online-profile.json (or q to stop)'); if (!input || input.toLowerCase() === 'q') return null; }
    else say(`   received ${input.replace(/\s/g, '').length} characters`);
    try { const r = readProfileInput(input); return { profile: r.profile, from: r.source === 'file' ? shownPath(input) : 'the join code', ...(r.source === 'file' ? { file: input.replace(/^"(.*)"$/, '$1') } : {}) }; }
    catch (e) { say(`   ${profileProblem(e)}`); if (!(await confirm('   Try again?'))) return null; }
  }
}
// Whose sign-in is about to be installed, in plain words, and the member's yes to it. A profile this PC already uses
// was accepted before and is only named; a new one is confirmed (with --yes it is named and installed). Replacing
// another member's saved profile names both, and its question defaults to No.
async function confirmIdentity(member: Member): Promise<boolean> {
  const p = member.profile, change = member.saved ? { kind: 'same' as const } : profileChange(loadStoredProfile(), p);
  say(`\nThis sets the game on this PC up to play online as ${identityOf(p)}.`);
  say(`   from ${member.from}: ${describeProfile(p)}`);
  for (const w of profileWarnings(p)) say(`   note: ${w}`);
  if (member.saved || change.kind === 'same') return true;
  say(OWN_CODE_RULE);
  if ('line' in change && change.line) say(change.line);
  if (YES) return true;
  return confirm(change.kind === 'different' ? `Replace it and play as ${p.onlineId}? Say yes only if ${p.onlineId} is your own account on ${siteHost}` : `Is ${p.onlineId} your own account on ${siteHost}?`, change.kind !== 'different');
}
// The server the game will be pointed at. The member's own --server is taken as typed. A profile's server must be the
// league's (the site's name or a name under it); any other address is refused unless the member says yes to it by
// name (--trust-server when nobody is there to ask). null = refused.
async function chooseServer(profile: OnlineProfile): Promise<string | null> {
  const typed = serverFlag();
  if (typed.problem) { say(typed.problem); return null; }
  if (typed.host) { if (!isOfficialServer(typed.host, siteHost)) say(`   note: --server ${typed.host} is used instead of the league's server (${siteHost}); your sign-in is sent to it.`); return typed.host; }
  const host = profile.server;
  if (isOfficialServer(host, siteHost)) return host;
  if (flags.has('trust-server')) { say(`   note: this profile points the game at ${host}, which is not the league's server (${siteHost} or a name ending in .${siteHost}). Accepted because of --trust-server; your sign-in is sent to that address.`); return host; }
  say(`\nREFUSED: this profile points the game at ${host}, which is not the league's server.`);
  say(`   The league's server is ${siteHost} or a name ending in .${siteHost}${isPunycodeName(host) ? '; this name has an "xn--" part, which is how look-alike names are written' : ''}.`);
  say('   A profile from your own account page always uses the league\'s server. The game sends your sign-in to this address, so whoever runs it could play as you.');
  if (YES) { say('   Nothing was changed. (Only if your commissioner gave you this address: pass --trust-server.)'); return null; }
  if (await confirm(`   Only continue if your commissioner gave you the address ${host} personally. Use it anyway?`, false)) return host;
  return null;
}
const psnMode = (): PsnMode => (flags.get('psn')?.toLowerCase() === 'simulated' ? 'Simulated' : 'Disconnected');
const checkTimeout = () => { const n = Number(flags.get('check-timeout')); return Number.isFinite(n) && n >= 500 ? n : 5000; };
const sameFolder = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
// the RPCS3 folder `check` compares with, without asking: --rpcs3, else the one join last set up, else the only one found
function knownRpcs3(): string | null {
  const given = flags.get('rpcs3'); if (given && given !== 'true') return isRpcs3Dir(given) ? path.resolve(given) : null;
  const note = loadInstallNote(); if (note && isRpcs3Dir(note.rpcs3)) return path.resolve(note.rpcs3);
  const found = findRpcs3(); return found.length === 1 ? found[0]! : null;
}
// the server name the game in that folder was set up with: join's note for it, else the saved profile's
function leagueHost(rpcs3: string | null): string | null {
  const note = loadInstallNote();
  if (note && rpcs3 && sameFolder(note.rpcs3, rpcs3)) return note.server;
  return loadStoredProfile()?.server ?? note?.server ?? null;
}
// configuredIp: the address in the game's settings, when the check is for the name the game was set up with. A server
// that has moved is NOT READY whatever the ports say: the game still calls the old address.
async function connectionCheck(host: string, configuredIp: string | null = null): Promise<boolean> {
  const c = await checkServer(host, { timeoutMs: checkTimeout() }), v = verdict(c), drift = addressDrift(host, c.ip, configuredIp);
  for (const l of v.lines) say(`   ${l}`);
  if (drift) {
    say(`\n   ${drift.headline}`); say(`   ${drift.fix}`);
    if (!v.ready) { say(`   And at the new address: ${v.headline}`); if (v.fix) say(`   ${v.fix}`); }
    return false;
  }
  say(`\n   ${v.headline}`); if (v.fix) say(`   ${v.fix}`);
  return v.ready;
}
async function checkFlow(): Promise<void> {
  const typed = serverFlag();
  if (typed.problem) { say(typed.problem); process.exitCode = NOT_READY; return; }
  const rpcs3 = knownRpcs3(), setUpWith = leagueHost(rpcs3), host = typed.host ?? setUpWith;
  if (!host) { say('No league server known on this PC yet: run join with your join code first (or pass --server HOST).'); process.exitCode = NOT_READY; return; }
  const compare = host === setUpWith, set = compare && rpcs3 ? netState(rpcs3) : null;
  say(`\nChecking the league server ${host} ...`);
  let ok = await connectionCheck(host, set?.serverIp ?? null);
  if (compare && !rpcs3) say('   Not compared with the game\'s own setting: no single RPCS3 folder was found (pass --rpcs3 DIR).');
  else if (compare && !set?.serverIp) { ok = false; say(`   NOT READY: the game in ${rpcs3} is not set up for the league. Run this to fix it (close RPCS3 first): ${FIX_COMMAND}`); }
  else if (compare && ok) say(`   The game in ${rpcs3} is set to that address.`);
  if (!ok) process.exitCode = NOT_READY;
}
async function signoutFlow(): Promise<void> {
  const rpcs3 = await chooseRpcs3(); say(`RPCS3: ${rpcs3}`);
  if (!(await confirm('Remove your league sign-in from this RPCS3 and forget the profile saved on this PC?'))) return;
  const file = patchFile(rpcs3), text = readText(file);
  if (text !== null) {
    const r = removePatchEntry(text, P.ppuHash, CREDENTIAL_PATCH);
    if (r.removed) { fs.writeFileSync(file, r.text); inheritAccess(file); } // the file is no longer personal: back to the folder's own access
    say(r.removed ? '   sign-in entry removed from patches/imported_patch.yml' : '   no sign-in entry in patches/imported_patch.yml');
  }
  const scrubbed = scrubPatchBackups(file);
  if (scrubbed) say(`   sign-in entry also removed from ${scrubbed} other cop${scrubbed === 1 ? 'y' : 'ies'} of the patch file in that folder`);
  const cfg = patchConfig(rpcs3), ctext = readText(cfg);
  if (ctext !== null) { const r = removePatchEntry(ctext, P.ppuHash, CREDENTIAL_PATCH); if (r.removed) { backup(cfg); fs.writeFileSync(cfg, r.text); } }
  say(forgetProfile() ? `   saved profile deleted (${profileStorePath()})` : '   no saved profile on this PC');
  say('The game settings and the mod stay as they are. If someone else may have seen your join code, also get a new one on the site and tell the commissioner, so the old one stops working.');
}

// install: everything a player needs for the FCS mod add-ons; online: the same plus the member's sign-in and the league
// server's address; lan: the same plus a league host's address and private RPCN server (the pre-cloud setup)
async function setupFlow(kind: 'install' | 'online' | 'lan'): Promise<void> {
  say(kind === 'install' ? `\nInstall or update the FCS mod add-ons (this build: ${P.builtAt})\n` : `\nJoin ${kind === 'online' ? 'the online league' : 'a league on a private server'} (this build: ${P.builtAt})\n`);
  const rpcs3 = await chooseRpcs3(); say(`RPCS3: ${rpcs3}`);
  if (stdinCode && kind !== 'online') say('note: --code - is only used by join; the line read from standard input is ignored.');
  let server = '', rpcn = '', member: Awaited<ReturnType<typeof getProfile>> = null, personal: (PatchEntry & { words: number }) | undefined, host = '', serverIp = '', dnsError = '';
  if (kind === 'lan') {
    server = await ask('League server address (the host PC\'s IP, or 127.0.0.1 on the host itself)', flags.get('server') ?? '127.0.0.1');
    rpcn = await ask('Private PSN (RPCN) server host:port', flags.get('rpcn') ?? `${server}:31313`);
  }
  if (kind === 'online') {
    if (!P.npAdapter) { say('This build of FCS-online.exe was made without the league sign-in. Download the current FCS-online.exe from the site and run it again.'); process.exitCode = NOT_READY; return; }
    const clash = adapterConflicts(P.npAdapter, P.patches);
    if (clash.length) throw new Error(`this build's game patches overlap the league sign-in (${clash.slice(0, 3).join('; ')}): tell the commissioner`);
    member = await getProfile();
    if (!member) { say('Stopped; nothing was changed.'); process.exitCode = NOT_READY; return; }
    if (!(await confirmIdentity(member))) { say('Stopped; nothing was changed. Get the join code from your own account page on the site and run this again.'); process.exitCode = NOT_READY; return; }
    const chosen = await chooseServer(member.profile);
    if (!chosen) { say('Stopped; nothing was changed.'); process.exitCode = NOT_READY; return; }
    host = chosen;
    const r = await resolveIPv4(host);
    if ('ip' in r) serverIp = r.ip; else dnsError = r.error;
    personal = credentialPatchEntry(P.npAdapter, member.profile);
  }
  if (!(await rpcs3Closed(rpcs3))) { say('Stopped; nothing was changed.'); if (kind === 'online') process.exitCode = NOT_READY; return; }
  let n = 0, ready = true; const step = (t: string) => say(`\n${++n}. ${t}`);
  step(kind === 'online' ? 'Game patches and your league sign-in' : 'Game patches');
  const r = installPatches(rpcs3, personal);
  const label = (x: string) => (x === CREDENTIAL_PATCH ? `your league sign-in as ${member!.profile.onlineId} (${personal!.words} words; personal, never share patches\\imported_patch.yml)` : x);
  for (const x of r.changed) say(`   installed/updated: ${label(x)}`); for (const x of r.kept) say(`   already current:   ${label(x)}`); say('   all entries enabled for 01.00 and 01.02 in config/patch_config.yml');
  if (r.restricted === true) say('   patches\\imported_patch.yml now holds your sign-in, so only this Windows account may read it');
  if (r.restricted === false) say('   could not limit patches\\imported_patch.yml to this Windows account: other accounts on this PC can read your sign-in from it');
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
  if (kind === 'lan') { step('Network'); for (const x of configureNetwork(rpcs3, server, rpcn)) say(`   ${x}`); }
  if (kind === 'online') {
    step('Network settings for the game');
    if (!serverIp) { ready = false; say(`   NOT done: the name ${host} could not be looked up (${dnsError}). Check that this PC is online and run join again.`); }
    else {
      const psn = psnMode(), c = configureOnlineNet(rpcs3, serverIp, psn, backup);
      if (c.created !== 'no') say(`   made a custom configuration for the game (${c.created === 'from-global' ? 'a copy of your RPCS3 settings' : 'network settings only'}): ${c.file}`);
      say(c.changed ? `   Internet: Connected, PSN: ${psn}, EA's server names -> ${host}${host === serverIp ? '' : ` (${serverIp})`}` : '   already set for the league');
      if (host !== serverIp) say(`   RPCS3 takes only a number there, so ${host} was looked up now. If the league server ever moves, "FCS-online.exe check" and "status" say so, and "${FIX_COMMAND}" fixes it.`);
      saveInstallNote({ rpcs3, server: host, ip: serverIp, at: Date.now() });
      if (c.before.psn === 'RPCN') say('   RPCN is no longer used by this game: no RPCN account is needed (your RPCN settings for other games are untouched).');
    }
  }
  if (P.roster && flags.get('roster') !== 'false') { step(`Roster save ${P.roster.dir} (up to 90 players per team)`); say(`   ${installRoster(rpcs3)}`); }
  step(`Generic teams: home stadiums and FBS swaps${P.swapPack ? ` (${swapPackSummary(P.swapPack)})` : ''}`);
  for (const x of installSwaps(rpcs3)) say(`   ${x}`);
  if (P.playbooks) { step(`Playbooks the teams shaped on the site (${packSummary(P.playbooks)})`); for (const x of installPlaybooks(rpcs3)) say(`   ${x}`); }
  if (kind === 'lan') {
    step(`Companion site: ${P.site}`);
    say('   Create your account there (Sign in), then tell the commissioner your account name so they can link your team.');
    if (!YES && await confirm('   Open it in the browser now?') && !openInBrowser(P.site)) say(`   The browser could not be opened from here: go to ${P.site} yourself.`);
  }
  if (kind === 'online') {
    step('Your profile');
    const s = saveProfile(member!.profile);
    say(`   saved for this Windows account only: ${s.file}${s.restricted ? '' : ' (could not tighten its permissions; it is still inside your own user folder)'}`);
    if (member!.file && path.resolve(member!.file) !== path.resolve(s.file) && fs.existsSync(member!.file)) {
      if (!YES && await confirm(`   ${shownPath(member!.file)} is no longer needed and works like a password. Delete it?`)) { fs.rmSync(member!.file); say('   deleted (if it went through the Recycle Bin or a cloud folder such as OneDrive before, empty that too)'); }
      else say(`   ${shownPath(member!.file)} is no longer needed and works like a password: delete it when you are done.`);
    }
    step('Connection to the league server');
    if (flags.has('skip-check')) say('   skipped (--skip-check); run "FCS-online.exe check" any time');
    else if (!serverIp) say('   skipped: the server name could not be looked up');
    else if (!(await connectionCheck(host))) ready = false;
    if (!ready) { process.exitCode = NOT_READY; say('\nThe mod and your sign-in are installed, but this PC is not ready to play online yet: fix the line marked NOT above, then run join again (it keeps what is already done).'); return; }
    say(`\nDone. Start RPCS3 and the game${P.roster ? `, load the roster ${P.roster.dir.replace(/^BLUS31159-/, '')}` : ''} and choose Online Dynasty. There is no PSN or RPCN sign-in any more: the game signs in as ${member!.profile.onlineId} by itself.`);
    say('The first start after this takes a few minutes longer than usual (RPCS3 rebuilds the patched parts of the game).');
    return;
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
  // online league: the saved profile and the sign-in entry (what they are, never the credential), the game's network
  // settings, and whether the server answers
  const stored = loadStoredProfile(), net = netState(rpcs3);
  say(`  online profile on this PC: ${stored ? describeProfile(stored) : 'none'}`);
  say(`  ${signInStatus(rpcs3)}`);
  if (net.exists) for (const [k, v] of [['Internet enabled', net.internet], ['PSN status', net.psn], ['IP swap list', net.swap]] as const) say(`  Net ${k}: ${v ?? '?'}`); else say('  no custom game config');
  const rp = path.join(rpcs3, 'config', 'rpcn.yml'); say(`  RPCN: ${net.psn === 'RPCN' ? '' : 'not used by this game; '}${fs.existsSync(rp) ? `host ${/^Host: (.*)$/m.exec(fs.readFileSync(rp, 'utf8'))?.[1] ?? '?'}, account ${/^NPID: "?([^"\n]+)"?$/m.test(fs.readFileSync(rp, 'utf8')) ? 'present' : 'none'}` : 'no rpcn.yml'}`);
  if (P.roster) say(`  roster save ${P.roster.dir}: ${fs.existsSync(path.join(rpcs3, 'dev_hdd0', 'home', '00000001', 'savedata', P.roster.dir, 'USR-DATA')) ? 'installed' : 'not installed'}`);
  // the name this game was set up with (join's note for this folder, else the saved profile's), looked up now and
  // compared with the address in the game's settings: a server that has moved is said first, with the fix
  const host = leagueHost(rpcs3);
  if (host && !flags.has('no-check')) {
    const c = await checkServer(host, { timeoutMs: Math.min(checkTimeout(), 4000) }), v = verdict(c), drift = addressDrift(host, c.ip, net.serverIp);
    if (drift) { say(`  league server: ${drift.headline}`); say(`    ${drift.fix}`); process.exitCode = NOT_READY; }
    else if (stored && !net.serverIp) { say(`  league server: NOT READY: the game in this RPCS3 is not set up for the league. Run this to fix it (close RPCS3 first): ${FIX_COMMAND}`); process.exitCode = NOT_READY; }
    say(`  league server${drift ? ' at its new address' : ''}: ${v.ready ? `reachable (${host}, ${c.ip})` : v.headline}`);
    if (!v.ready) { for (const l of v.lines) say(`    ${l}`); if (v.fix) say(`    ${v.fix}`); }
  } else if (host) say(`  league server: not checked (--no-check), so a move of ${host} to another address would not show here`);
}
const HELP = `FCS-online.exe: sets RPCS3 up for the FCS mod and the online league (this build: ${P.builtAt})

  FCS-online.exe                     the menu (double-click does the same)
  FCS-online.exe install             game patches, uniforms, score bug, roster      [--rpcs3 DIR] [--roster false] [--yes]
  FCS-online.exe join                everything in install, plus your league sign-in and the server settings
                                     [--rpcs3 DIR] [--profile FILE | --code - | --code FCS1-...] [--server HOST] [--trust-server]
                                     [--psn disconnected|simulated] [--skip-check] [--check-timeout MS] [--roster false] [--yes]
  FCS-online.exe check               can this PC reach the league server, and is the game still set to its address?
                                     [--server HOST] [--rpcs3 DIR] [--check-timeout MS]
  FCS-online.exe status              what is installed on this PC   [--rpcs3 DIR] [--no-check]
  FCS-online.exe signout             remove your league sign-in and the saved profile   [--rpcs3 DIR] [--yes]
  FCS-online.exe join-lan | roster | host | swap     (league on a private server, roster save only, commissioner tools)

Your join code is a password. Use only the one from your own account page on ${siteHost}: with a code that
somebody sent you, you would be playing as them. Ways to hand it to join, safest first:
  (nothing)          join asks for it; what you paste is not shown
  --profile FILE     the fcs-online-profile.json you downloaded from your account page
  --code -           the join code is read from standard input (first line), for scripts:
                       Get-Content code.txt | .\\FCS-online.exe join --code - --yes
  --code FCS1-...    works, but AVOID IT: the code is then visible in the process list to other programs on this PC
                     for as long as the wizard runs, and it stays in the shell history. If you used it on a shared PC,
                     get a new join code on the site.

--trust-server       accept a profile whose server is not ${siteHost} or a name under it. Without it such a profile
                     is refused (asked about in the console, stopped with --yes). Only for an address your
                     commissioner gave you.
If the league server moves, check and status say so; "${FIX_COMMAND}" fixes it.
Exit codes: 0 done / ready to play online, 2 not ready (the output says what to fix), 1 error.`;
// a mode nobody knows is not repeated when it may be a join code typed in the wrong place
const shownWord = (w: string) => (shownPath(w) === w && w.length <= 40 ? `"${w}"` : 'that');
async function main(): Promise<void> {
  if (flags.has('help') || flags.has('h') || ['help', '-h', '-?', '/?', '/h', '/help'].includes((words[0] ?? '').toLowerCase())) { say(HELP); return; }
  if (stdinCode) await stdinCode; // --code -: the line is taken off standard input before any question is asked
  let mode = words[0] ?? flags.get('mode');
  if (!mode) {
    say(`FCS mod add-ons (this build: ${P.builtAt})\n  1. Install or update: game patches, uniforms, score bug${P.roster ? ', 2026 roster' : ''}  <- start here\n  2. Join the online league: everything in 1, plus your sign-in (the join code from ${siteHost}) and the server settings\n  3. Host a league (commissioner): start the league server from a project checkout\n  4. Status of this PC's setup\n  5. Swap an FBS team into a generic slot (commissioner)\n  6. Check the connection to the league server\n  7. Quit`);
    mode = { '1': 'install', '2': 'join', '3': 'host', '4': 'status', '5': 'swap', '6': 'check' }[await ask('Choice', '1')] ?? 'quit';
  }
  if (mode === 'install') await setupFlow('install');
  else if (mode === 'join') await setupFlow(flags.has('rpcn') ? 'lan' : 'online');
  else if (mode === 'join-lan') await setupFlow('lan');
  else if (mode === 'check') await checkFlow();
  else if (mode === 'signout') await signoutFlow();
  else if (mode === 'roster') { const rpcs3 = await chooseRpcs3(); say(installRoster(rpcs3)); }
  else if (mode === 'host') await hostFlow();
  else if (mode === 'status') await statusFlow();
  else if (mode === 'swap') await swapFlow();
  else if (mode !== 'quit') { say(`unknown mode ${shownWord(mode)}; use install | join | join-lan | check | signout | roster | host | status | swap | help`); process.exitCode = 1; }
}
// started by double-clicking (no mode on the command line): keep the window open until the reader is done
const holdWindow = async () => { if (!words[0] && !flags.has('mode') && !flags.has('help') && !YES && !inputClosed) await question('\nPress Enter to close this window.').catch(() => { /* the input ended */ }); };
main().then(holdWindow, async (e: Error) => { console.error(`error: ${e.message}`); process.exitCode = 1; await holdWindow(); }).finally(() => rl.close());
