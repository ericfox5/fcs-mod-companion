// Completing a member's .team package (2026-11-06). The console builds its weekly team package into a 70-row PLAY
// table; a user team above 70 (the 100-player roster patches) wraps around in it, the first rows of the roster are
// overwritten, and the advance's "Checking for team data" step, which downloads that package straight back, then
// reconciles the dynasty to it: the missing rows are deleted and the rows beyond slot 69 are re-created under new ids
// (Holy Cross lost 20 players that way, NOTES 2026-11-06). The package is uploaded (locker) before the console's
// PLYZ push names every row it still has, and EndDynastyUpdate UPDT 1 closes that sequence, so at that point the
// package is rebuilt here: PLAY grown to `max` rows and every row the push names but the package lacks appended from
// the dynasty file the console is on. A .team blob is zlib of a 50,000-byte EA DB with no prefix.
import { inflateSync, deflateSync } from 'node:zlib';
import { parseTdb, serializeTdb, verifyTdb } from '../../../packages/tdb/dist/index.js';

const DB_MAGIC = (b, i) => b[i] === 0x44 && b[i + 1] === 0x42 && b[i + 2] === 0 && b[i + 3] === 8;
function unwrap(blob) {
  const inflated = inflateSync(blob);
  let off = -1;
  for (let i = 0; i < Math.min(inflated.length - 4, 256); i++) if (DB_MAGIC(inflated, i)) { off = i; break; }
  if (off < 0) throw new Error('no EA DB header in the blob');
  return new Uint8Array(inflated.buffer, inflated.byteOffset + off, inflated.length - off);
}

// pkgBlob: the uploaded .team blob; dynastyBlob: the dynasty file the console is on; tgid: the member's team;
// rosterIds: the PGIDs of the console's roster push for that team (null = every row of the team in the dynasty file).
// Returns null when the package already carries every row, else { blob, added, before, after, max, missing }.
export function completeTeamPackage(pkgBlob, dynastyBlob, tgid, rosterIds = null, { max = 100 } = {}) {
  const db = unwrap(pkgBlob); const pkg = parseTdb(db);
  if (!pkg.hasTable('PLAY')) return null;
  const pp = pkg.table('PLAY'); const before = pp.recordCount;
  const present = new Set(); for (let i = 0; i < before; i++) present.add(Number(pp.get(i, 'PGID')));
  const dyn = parseTdb(unwrap(dynastyBlob)); const dp = dyn.table('PLAY');
  const want = rosterIds ? new Set(rosterIds.map(Number)) : null;
  const rows = [];
  for (let i = 0; i < dp.recordCount; i++) {
    if (Number(dp.get(i, 'TGID')) !== tgid) continue;
    const g = Number(dp.get(i, 'PGID')); if (present.has(g) || (want && !want.has(g))) continue;
    rows.push({ pgid: g, row: dp.row(i) });
  }
  if (!rows.length) return null;
  const need = before + rows.length;
  if (need > pp.header.maxRecords) pp.growTable(Math.max(pp.header.maxRecords, max)); // the stride cap; rows past it are reported, not forced
  const names = pp.fields.map((f) => f.name); const missing = [];
  for (const { pgid, row } of rows) {
    if (pp.recordCount >= pp.header.maxRecords) { missing.push(pgid); continue; }
    const vals = {}; for (const n of names) if (n in row) vals[n] = row[n];
    pp.appendRecord(vals);
  }
  const out = serializeTdb(pkg, { padTo: db.length });
  const problems = verifyTdb(out, pkg);
  if (problems.length) throw new Error(`completed package does not verify: ${JSON.stringify(problems.slice(0, 2))}`);
  return { blob: new Uint8Array(deflateSync(out, { level: 9 })), added: rows.length - missing.length, before, after: pp.recordCount, max: pp.header.maxRecords, missing };
}

// Rows of a team in a .team blob, for tests and reports.
export function packagePlayerIds(pkgBlob) {
  const pkg = parseTdb(unwrap(pkgBlob)); const t = pkg.table('PLAY'); const ids = [];
  for (let i = 0; i < t.recordCount; i++) ids.push(Number(t.get(i, 'PGID')));
  return { ids, max: t.header.maxRecords };
}
