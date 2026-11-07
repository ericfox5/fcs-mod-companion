// node --test spike/blaze/server/team-package.test.mjs — the .team package completion against the 2026-11-06 files:
// package 336 (Holy Cross, 70 rows after the wrap), the copy the console was on (335) and the console's roster push.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { completeTeamPackage, packagePlayerIds } from './team-package.mjs';

const priv = new URL('../private/', import.meta.url);
const blob = (name) => { for (const p of [`locker/${name}.bin`, `locker/trash/${name}.bin`]) { const u = new URL(p, priv); if (fs.existsSync(u)) return fs.readFileSync(u); } return null; };
const pkg = blob(336), dyn = blob(335);
const plyz = fs.existsSync(new URL('dynasty-tables/8/PLYZ.json', priv)) ? JSON.parse(fs.readFileSync(new URL('dynasty-tables/8/PLYZ.json', priv), 'utf8')) : null;
const available = !!(pkg && dyn && plyz);

test('a wrapped 70-row package gets the roster push rows back and fits the 50,000-byte DB', { skip: !available }, () => {
  const ids = plyz.rows.slice(-90).map((r) => Number(r.PGID));
  assert.equal(new Set(ids).size, 90);
  const before = packagePlayerIds(pkg); assert.equal(before.ids.length, 70); assert.equal(before.max, 70);
  const r = completeTeamPackage(pkg, dyn, 18, ids);
  assert.ok(r, 'something to add');
  assert.equal(r.added, 20); assert.equal(r.before, 70); assert.equal(r.after, 90); assert.equal(r.max, 100); assert.deepEqual(r.missing, []);
  const after = packagePlayerIds(r.blob);
  assert.equal(after.ids.length, 90); assert.equal(after.max, 100);
  assert.equal(new Set(after.ids).size, 90, 'no duplicate ids');
  for (const g of [1800, 1801, 1802, 1809, 1863]) assert.ok(after.ids.includes(g), `row ${g} restored`);
  assert.deepEqual([...after.ids].sort((a, b) => a - b), [...ids].sort((a, b) => a - b), 'the package now names exactly the pushed roster');
  assert.equal(completeTeamPackage(r.blob, dyn, 18, ids), null, 'a complete package is left alone');
});
test('without a roster push every row of the team in the dynasty file is used', { skip: !available }, () => {
  const r = completeTeamPackage(pkg, dyn, 18, null);
  assert.ok(r); assert.equal(r.after, 90);
});
test('a package of a team at 69 is left alone', { skip: !blob(331) || !blob(333) }, () => {
  assert.equal(completeTeamPackage(blob(331), blob(333), 18, null), null);
});
