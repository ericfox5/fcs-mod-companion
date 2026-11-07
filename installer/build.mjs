// Builds installer/dist/FCS-online.exe: generates the payload from the project's private files, bundles src/main.ts
// with esbuild and injects it into a copy of node.exe as a single executable application (Node SEA).
//   node installer/build.mjs [--roster <save folder, e.g. ...\2026\out\BLUS31159-ROSTER-FCS2026>] [--no-exe]
import fs from 'node:fs';
import path from 'node:path';
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
const uniforms = {};
for (const f of fs.readdirSync(path.join(root, 'spike', 'blaze', 'tools', 'uniforms'))) if (/_Pack0_MixAndMatch\.XML$/i.test(f)) uniforms[f] = fs.readFileSync(path.join(root, 'spike', 'blaze', 'tools', 'uniforms', f), 'latin1');
let roster;
const rosterDir = opt('roster');
if (rosterDir) {
  const files = {}; for (const f of fs.readdirSync(rosterDir)) files[f] = fs.readFileSync(path.join(rosterDir, f)).toString('base64');
  const readme = path.join(rosterDir, '..', 'README.txt');
  roster = { dir: path.basename(rosterDir), files, note: fs.existsSync(readme) ? fs.readFileSync(readme, 'utf8').split('\n')[0] : '' };
}
const payload = { builtAt: new Date().toISOString().slice(0, 16).replace('T', ' '), site: 'https://ncaa-online.foxbros.workers.dev', ppuHash, patches: entries, uniforms, ...(roster ? { roster } : {}) };
fs.mkdirSync(path.join(here, 'generated'), { recursive: true });
fs.writeFileSync(path.join(here, 'generated', 'payload.json'), JSON.stringify(payload));
console.log(`payload: ${entries.length} patch entries (${entries.reduce((a, e) => a + e.words, 0)} words), ${Object.keys(uniforms).length} uniform XMLs${roster ? `, roster save ${roster.dir} (${Object.keys(roster.files).length} files)` : ''}`);

// ---- bundle
const dist = path.join(here, 'dist'); fs.mkdirSync(dist, { recursive: true });
const bundle = path.join(dist, 'fcs-online.cjs');
await build({ entryPoints: [path.join(here, 'src', 'main.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile: bundle, logLevel: 'warning', legalComments: 'none' });
console.log(`bundle: ${bundle} (${(fs.statSync(bundle).size / 1024).toFixed(0)} KB)`);
if (args.includes('--no-exe')) process.exit(0);

// ---- single executable (Node SEA): blob, node.exe copy, inject
const seaCfg = path.join(dist, 'sea-config.json'); const blob = path.join(dist, 'sea-prep.blob');
fs.writeFileSync(seaCfg, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }));
run(process.execPath, ['--experimental-sea-config', seaCfg]);
const exe = path.join(dist, 'FCS-online.exe');
fs.copyFileSync(process.execPath, exe);
run(process.execPath, [path.join(root, 'node_modules', 'postject', 'dist', 'cli.js'), exe, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2']);
console.log(`exe: ${exe} (${(fs.statSync(exe).size / 1048576).toFixed(0)} MB, Node ${process.version})`);
