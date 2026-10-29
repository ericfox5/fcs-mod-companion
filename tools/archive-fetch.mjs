#!/usr/bin/env node
// Mirror the archived EA "NCAA Online Dynasty" site into archive/wayback/ for reference.
// Uses the Wayback CDX index + the raw "id_" snapshot form. Retries with backoff (the archive is flaky).
// Usage: node tools/archive-fetch.mjs [--limit N] [--only <substring>]
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const ROOT = new URL('../archive/wayback/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const CDX = 'https://web.archive.org/cdx/search/cdx';

// [url pattern, {from,to,latest}] – latest=true keeps only the newest snapshot per URL (default), else oldest.
const PATTERNS = [
  ['cdn.www.easports.com/dynasty/static/b7934fd/*', {}],          // NCAA 14 bundle, 2014-01-22
  ['cdn.www.easports.com/dynasty/static/35072c0/*', {}],          // NCAA 14 bundle, 2022
  ['cdn.www.easports.com/dynasty/static/a7b6cfe/*', {}],          // NCAA 14 bundle, 2013-07
  ['www.easports.com/dynasty/bundles/*', {}],                     // team logos + story images
  ['www.easports.com/dynasty/default', { from: '2013', to: '2014' }],
  ['www.easports.com/dynasty/login', { from: '2013', to: '2014' }],
  ['www.easports.com/dynasty/webtips', {}],
  ['www.easports.com/dynasty/dynastybrowse', {}],
  ['www.easports.com/dynasty/home*', { to: '2012' }],              // NCAA 12 logged-in snapshots
  ['www.easports.com/dynasty/teams*', { to: '2012' }],
  ['www.easports.com/dynasty/rankings*', { to: '2012' }],
  ['www.easports.com/dynasty/schedule*', { to: '2012' }],
  ['www.easports.com/dynasty/standings*', { to: '2012' }],
  ['www.easports.com/dynasty/stats*', { to: '2012' }],
  ['www.easports.com/dynasty/rosters*', { to: '2012' }],
  ['www.easports.com/dynasty/static/*', {}],                      // 2012/2013 css/js/theme images
  ['www.easports.com/dynasty/assets/*', {}],
  ['www.easports.com/dynasty12/*', {}],
  ['www.easports.com/dynasty13/*', {}],
  ['cdn.www.easports.com/dynasty12/*', {}],
  ['cdn.www.easports.com/dynasty13/*', {}],
];

const args = process.argv.slice(2);
const limit = Number(args[args.indexOf('--limit') + 1]) || Infinity;
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchRetry(url, tries = 4) {
  let delay = 2000;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'ncaa-online-dynasty-archive-fetch/0.1 (personal research)' } });
      if (res.ok) return res;
      if (res.status === 404) return res;
      console.warn(`  ${res.status} ${url}`);
    } catch (e) {
      console.warn(`  ${e.message} ${url}`);
    }
    await sleep(delay);
    delay *= 2.5;
  }
  return null;
}

async function cdx(pattern, opts) {
  const q = new URLSearchParams({ url: pattern, output: 'json', collapse: 'urlkey', filter: 'statuscode:200', limit: '20000', fl: 'timestamp,original,mimetype,length,digest' });
  if (opts.from) q.set('from', opts.from);
  if (opts.to) q.set('to', opts.to);
  const res = await fetchRetry(`${CDX}?${q}`);
  if (!res || !res.ok) return [];
  const text = await res.text();
  if (!text.trim().startsWith('[')) { console.warn(`  CDX returned non-JSON for ${pattern}`); return []; }
  const rows = JSON.parse(text);
  return rows.slice(1).map(([timestamp, original, mimetype, length, digest]) => ({ timestamp, original, mimetype, length: Number(length), digest }));
}

function localPath(original) {
  const u = new URL(original);
  let p = decodeURIComponent(u.pathname);
  if (p.endsWith('/')) p += 'index.html';
  if (u.search) p += '__' + u.search.slice(1).replace(/[^A-Za-z0-9._-]+/g, '_');
  if (!/\.[A-Za-z0-9]{1,5}$/.test(p)) p += '.html';
  return join(ROOT, u.hostname, p);
}

const manifest = [];
let count = 0;
for (const [pattern, opts] of PATTERNS) {
  if (only && !pattern.includes(only)) continue;
  console.log(`CDX ${pattern}`);
  const rows = await cdx(pattern, opts);
  console.log(`  ${rows.length} rows`);
  for (const row of rows) {
    if (count >= limit) break;
    const path = localPath(row.original);
    try { const s = await stat(path); if (s.size > 0) { manifest.push({ ...row, path, skipped: true }); continue; } } catch {}
    const raw = `https://web.archive.org/web/${row.timestamp}id_/${row.original}`;
    const res = await fetchRetry(raw);
    if (!res || !res.ok) { manifest.push({ ...row, path, error: res ? res.status : 'network' }); continue; }
    const buf = Buffer.from(await res.arrayBuffer());
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, buf);
    manifest.push({ ...row, path, bytes: buf.length });
    count++;
    if (count % 25 === 0) console.log(`  …${count} files`);
    await sleep(250);
  }
}
await mkdir(ROOT, { recursive: true });
let prev = [];
try { prev = JSON.parse(await readFile(join(ROOT, 'manifest.json'), 'utf8')); } catch {}
const merged = new Map(prev.map((m) => [m.original, m]));
for (const m of manifest) merged.set(m.original, m);
await writeFile(join(ROOT, 'manifest.json'), JSON.stringify([...merged.values()], null, 1));
console.log(`done: ${count} new files, ${manifest.filter((m) => m.error).length} errors, manifest ${merged.size} entries`);
