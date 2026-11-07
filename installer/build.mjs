// Builds installer/dist/FCS-online.exe: generates the payload from the project's private files, bundles src/main.ts
// with esbuild and injects it into a copy of node.exe as a single executable application (Node SEA).
//   node installer/build.mjs [--roster <save folder, e.g. ...\2026\out\BLUS31159-ROSTER-FCS2026>] [--rpcs3 DIR] [--no-exe]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
// no shell: node.exe usually sits in "C:\Program Files" and a shell would split the path at the space
const run = (cmd, a, cwd = root) => { const r = spawnSync(cmd, a, { cwd, stdio: 'inherit', shell: false }); if (r.status !== 0) throw new Error(`${cmd} ${a.join(' ')} failed (exit ${r.status})`); };

// ---- payload: patch entries (private/rpcs3-patches.yml), uniform XMLs, optional roster save
const ymlPath = path.join(root, 'spike', 'blaze', 'private', 'rpcs3-patches.yml');
const yml = fs.readFileSync(ymlPath, 'utf8');
const ppuHash = /^(PPU-[0-9a-f]{40}):/m.exec(yml)?.[1]; if (!ppuHash) throw new Error('no PPU hash in rpcs3-patches.yml');
const patches = []; let cur = null;
for (const line of yml.split(/\r?\n/)) {
  const h = /^  "(.+)":\s*$/.exec(line);
  if (h) { cur = { name: h[1], lines: [line] }; patches.push(cur); } else if (cur && (line.startsWith('    ') || line.trim() === '')) { if (line.trim()) cur.lines.push(line); }
}
const entries = patches.map((p) => ({ name: p.name, block: p.lines.join('\n') + '\n', words: p.lines.filter((l) => l.includes('be32')).length }));
// Uniform sets from make-coming-soon-sets.mjs: the file list is its dist/coming-soon copy (not in git), the bytes come
// from this PC's DLC folders when the file is there (studio touch-ups ship), else from dist. They travel as one SEA asset
// (generated/uniform-pack.bin, files back to back) indexed in the payload.
const uniformsDir = path.join(root, 'spike', 'blaze', 'tools', 'uniforms');
let rpcs3 = opt('rpcs3');
try { rpcs3 ??= JSON.parse(fs.readFileSync(path.join(os.homedir(), '.ncaa-bridge', 'config.json'), 'utf8')).rpcs3Root; } catch { /* no bridge config */ }
const liveDlc = rpcs3 ? path.join(rpcs3, 'dev_hdd0', 'game', 'BLUS31159', 'USRDIR', 'DLC') : null;
const packDir = path.join(uniformsDir, 'dist', 'coming-soon');
const uniformSets = [], chunks = []; let offset = 0, fromLive = 0, touched = 0;
if (fs.existsSync(packDir)) for (const folder of fs.readdirSync(packDir).filter((f) => /^FCS_DLC_/i.test(f)).sort()) {
  for (const name of fs.readdirSync(path.join(packDir, folder)).filter((f) => /(_big\.ast|_MixAndMatch\.XML)$/i.test(f)).sort()) {
    const live = liveDlc && path.join(liveDlc, folder, name), dist = fs.readFileSync(path.join(packDir, folder, name));
    const bytes = live && fs.existsSync(live) ? fs.readFileSync(live) : dist;
    if (bytes !== dist) { fromLive++; if (!bytes.equals(dist)) { touched++; console.log(`uniforms: ${folder}/${name} differs from the script's output (studio edit); shipping this PC's copy`); } }
    uniformSets.push({ folder, name, offset, size: bytes.length, sha1: createHash('sha1').update(bytes).digest('hex') }); chunks.push(bytes); offset += bytes.length;
  }
} else console.log(`uniforms: ${packDir} not found (run spike/blaze/tools/uniforms/make-coming-soon-sets.mjs); building with the stop-gap XMLs only`);
const packFile = path.join(here, 'generated', 'uniform-pack.bin');
fs.mkdirSync(path.dirname(packFile), { recursive: true }); fs.writeFileSync(packFile, Buffer.concat(chunks));
// stop-gap XMLs, except for slots a uniform set now covers (BALLST: Duquesne has its own set)
const covered = new Set(uniformSets.filter((f) => /_MixAndMatch\.XML$/i.test(f.name)).map((f) => f.name.toUpperCase()));
const uniforms = {};
for (const f of fs.readdirSync(uniformsDir)) if (/_Pack0_MixAndMatch\.XML$/i.test(f) && !covered.has(f.toUpperCase())) uniforms[f] = fs.readFileSync(path.join(uniformsDir, f), 'latin1');
let roster;
const rosterDir = opt('roster');
if (rosterDir) {
  const files = {}; for (const f of fs.readdirSync(rosterDir)) files[f] = fs.readFileSync(path.join(rosterDir, f)).toString('base64');
  const readme = path.join(rosterDir, '..', 'README.txt');
  roster = { dir: path.basename(rosterDir), files, note: fs.existsSync(readme) ? fs.readFileSync(readme, 'utf8').split('\n')[0] : '' };
}
const payload = { builtAt: new Date().toISOString().slice(0, 16).replace('T', ' '), site: 'https://fcs-mod.online', ppuHash, patches: entries, uniforms, uniformSets, ...(roster ? { roster } : {}) };
fs.writeFileSync(path.join(here, 'generated', 'payload.json'), JSON.stringify(payload));
console.log(`payload: ${entries.length} patch entries (${entries.reduce((a, e) => a + e.words, 0)} words), ${Object.keys(uniforms).length} stop-gap XMLs, ${uniformSets.length} uniform-set files (${(offset / 1048576).toFixed(1)} MB; ${fromLive} read from ${liveDlc ?? 'no DLC folder'}, ${touched} touched up)${roster ? `, roster save ${roster.dir} (${Object.keys(roster.files).length} files)` : ''}`);

// ---- bundle
const dist = path.join(here, 'dist'); fs.mkdirSync(dist, { recursive: true });
const bundle = path.join(dist, 'fcs-online.cjs');
await build({ entryPoints: [path.join(here, 'src', 'main.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile: bundle, logLevel: 'warning', legalComments: 'none' });
console.log(`bundle: ${bundle} (${(fs.statSync(bundle).size / 1024).toFixed(0)} KB)`);
if (args.includes('--no-exe')) process.exit(0);

// ---- single executable (Node SEA): blob, node.exe copy, inject
const seaCfg = path.join(dist, 'sea-config.json'); const blob = path.join(dist, 'sea-prep.blob');
fs.writeFileSync(seaCfg, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, assets: { 'uniform-pack.bin': packFile } }));
run(process.execPath, ['--experimental-sea-config', seaCfg]);
const exe = path.join(dist, 'FCS-online.exe');
fs.copyFileSync(process.execPath, exe);
run(process.execPath, [path.join(root, 'node_modules', 'postject', 'dist', 'cli.js'), exe, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2']);
console.log(`exe: ${exe} (${(fs.statSync(exe).size / 1048576).toFixed(0)} MB, Node ${process.version})`);
