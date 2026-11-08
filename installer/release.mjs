// Publishes FCS-online.exe as a GitHub Release of this repo: builds it with installer/build.mjs (its payload comes from
// this PC's private files, so GitHub's runners cannot build it), then `gh release create` with installer/RELEASE.md,
// the player guide, as the release notes. The asset is always named FCS-online.exe, so
// https://github.com/<owner>/<repo>/releases/latest/download/FCS-online.exe always gets the newest one.
//   npm run release [-- --roster <save folder>] [--draft] [--no-build] [--allow-dirty]
// The release is tagged v<yyyy.mm.dd> (v<yyyy.mm.dd>-2, -3 ... later the same day) on the current commit, which must be
// pushed: the tag lives on GitHub, so it has to point at code that is there.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const has = (n) => args.includes(`--${n}`);
const run = (cmd, a, o = {}) => spawnSync(cmd, a, { cwd: root, encoding: 'utf8', shell: false, ...o });
const must = (cmd, a, o) => { const r = run(cmd, a, o); if (r.status !== 0) throw new Error(`${cmd} ${a.join(' ')} failed:\n${r.stderr || r.stdout}`); return r.stdout.trim(); };

// ---- the commit the release points at
const dirty = must('git', ['status', '--porcelain', '--untracked-files=no']);
if (dirty && !has('allow-dirty')) throw new Error(`uncommitted changes (commit them, or pass --allow-dirty):\n${dirty}`);
must('git', ['fetch', '--quiet', 'origin']);
const head = must('git', ['rev-parse', 'HEAD']);
if (!must('git', ['branch', '-r', '--contains', head]).split('\n').some((b) => b.trim().startsWith('origin/'))) throw new Error(`commit ${head.slice(0, 7)} is not on GitHub yet: push it first`);

// ---- the exe
const exe = path.join(here, 'dist', 'FCS-online.exe');
if (!has('no-build')) {
  const roster = opt('roster') ?? path.resolve(root, '..', 'FCS', 'Rosters', '2026', 'out', 'BLUS31159-ROSTER-FCS2026');
  if (!fs.existsSync(roster)) throw new Error(`roster save folder not found: ${roster} (pass --roster)`);
  const b = run(process.execPath, [path.join(here, 'build.mjs'), '--roster', roster], { stdio: 'inherit' });
  if (b.status !== 0) throw new Error('build failed');
}
if (!fs.existsSync(exe)) throw new Error(`${exe} not found`);
const bytes = fs.readFileSync(exe), sha = createHash('sha256').update(bytes).digest('hex');
const built = JSON.parse(fs.readFileSync(path.join(here, 'generated', 'payload.json'), 'utf8')).builtAt;

// ---- tag, notes, release
const d = new Date(), day = `v${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
const taken = new Set(must('gh', ['release', 'list', '--limit', '200', '--json', 'tagName', '--jq', '.[].tagName']).split('\n').filter(Boolean));
let tag = day; for (let n = 2; taken.has(tag); n++) tag = `${day}-${n}`;
const notes = fs.readFileSync(path.join(here, 'RELEASE.md'), 'utf8').replaceAll('{{VERSION}}', tag).replaceAll('{{BUILT}}', built).replaceAll('{{SHA256}}', sha).replaceAll('{{SIZE}}', (bytes.length / 1048576).toFixed(0));
const notesFile = path.join(here, 'dist', 'release-notes.md'); fs.writeFileSync(notesFile, notes);
console.log(`release ${tag}: ${exe} (${(bytes.length / 1048576).toFixed(0)} MB, sha256 ${sha.slice(0, 16)}...), commit ${head.slice(0, 7)}`);
must('gh', ['release', 'create', tag, exe, '--target', head, '--title', `FCS mod add-ons ${tag}`, '--notes-file', notesFile, ...(has('draft') ? ['--draft'] : ['--latest'])], { stdio: ['ignore', 'pipe', 'pipe'] });
const repo = must('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
console.log(`published: https://github.com/${repo}/releases/tag/${tag}${has('draft') ? ' (draft: publish it on GitHub)' : `\nnewest-download link: https://github.com/${repo}/releases/latest/download/FCS-online.exe`}`);
