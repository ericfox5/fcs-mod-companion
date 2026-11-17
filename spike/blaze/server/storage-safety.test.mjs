// Storage limits, crash-safe state files and hashed dynasty passwords.
// Everything runs in temp folders: each child process gets its own NCAA_PRIVATE, every server an OS-picked port.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { tmpDir, freePort, serverEnv, startServer, blazeClient, fakeSite, ticket, player, HERE } from './testkit.mjs';

const DIR = tmpDir('storage');
process.env.NCAA_PRIVATE = path.join(DIR, 'private'); process.env.NCAA_CAPTURE = 'off'; process.env.NCAA_LOG_BODIES = '0';
delete process.env.NCAA_XMS_DIR; delete process.env.NCAA_CLOUD; delete process.env.NCAA_HARDEN;
const { writeFileAtomic, saveJsonState, loadJsonState, backupPath, damagedPath, maxNumericName } = await import('./state-file.mjs');
const { StorageBudget, treeSize } = await import('./storage-budget.mjs');
const { hashPassword, verifyPassword, isPasswordHash, protectDynastyPassword, passwordMatches, mayJoinDynasty, hasPassword } = await import('./league-auth.mjs');
const { limits } = await import('./cloud-config.mjs');
const { T } = await import('./tdf.mjs');

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const pack4 = (name) => Buffer.from(String(name).padEnd(4).slice(0, 4).split('').reverse().join(''), 'latin1').readUInt32BE(0);
const list = (a) => ({ items: a });
// a decoded sendTableUpdate body: rows of [TGID, PGID] plus an optional text column to give the table some weight
const tableBody = (did, table, rows, pad = 0) => ({
  DYID: did, TABL: pack4(table), SINT: list([pack4('TGID'), pack4('PGID')]), ...(pad ? { STRC: list([pack4('NAME')]) } : {}),
  ROWS: list(rows.map(([a, b]) => ({ SINT: list([a, b]), ...(pad ? { STRV: list(['x'.repeat(pad)]) } : {}) }))),
});
const rowsOf = (n, team = 7, from = 0) => Array.from({ length: n }, (_, i) => [team, from + i]);

// Runs DynastyOnDemand calls in a fresh process (the store is loaded when dod.mjs is imported), with its own data folder.
// plan: { limits?, budget?, calls: [{ user, auth?, cmd, body }] } -> { status, out, results: [{ ok, code?, body?, note }] }
const DRIVER = `
import fs from 'node:fs';
const plan = JSON.parse(fs.readFileSync(process.env.DRV_PLAN, 'utf8'));
const { limits } = await import('./cloud-config.mjs');
const dod = await import('./dod.mjs');
const { stateBudget } = await import('./storage-budget.mjs');
const { Writer, decode } = await import('./tdf.mjs');
if (plan.limits) dod.configureDodLimits({ ...limits({}), ...plan.limits });
if (plan.budget) stateBudget.configure({ root: process.env.NCAA_PRIVATE, maxBytes: plan.budget, rescanMs: 0, log: (m) => console.log('[storage] ' + m) });
const sessions = new Map(), results = [];
for (const s of plan.calls) {
  if (!sessions.has(s.user)) sessions.set(s.user, { userId: s.user, onlineId: 'User' + s.user, leagueAuthenticated: !!s.auth, joinDynasties: [] });
  let res = { ok: null };
  dod.handleDod({ p: { command: s.cmd }, body: s.body ?? {}, session: sessions.get(s.user),
    reply: (_, build, note) => { const w = new Writer(); build?.(w); res = { ok: true, body: decode(w.bytes()), note }; },
    replyError: (code, note) => { res = { ok: false, code, note }; } });
  results.push(res);
}
fs.writeFileSync(process.env.DRV_OUT, JSON.stringify(results, (k, v) => (typeof v === 'bigint' ? Number(v) : v)));
`;
function runDod(dir, plan, extraEnv = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const planFile = path.join(dir, 'plan.json'), outFile = path.join(dir, 'out.json');
  fs.writeFileSync(planFile, JSON.stringify(plan)); fs.rmSync(outFile, { force: true });
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', DRIVER], { cwd: HERE, env: serverEnv(dir, { DRV_PLAN: planFile, DRV_OUT: outFile, ...extraEnv }), encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, results: fs.existsSync(outFile) ? readJson(outFile) : null };
}
const priv = (dir, ...p) => path.join(dir, 'private', ...p);
const create = (user, name, pass = '') => ({ user, cmd: 2, body: { NAME: name, PASS: pass, DESC: 'test' } });
const start = (user, did, updt, auth) => ({ user, auth, cmd: 56, body: { DYID: did, UPDT: updt } });
const send = (user, did, table, rows, pad, auth) => ({ user, auth, cmd: 12, body: tableBody(did, table, rows, pad) });
const end = (user, did, updt, auth, extra = {}) => ({ user, auth, cmd: 57, body: { DYID: did, UPDT: updt, FID: 0, NWST: 1, NWWK: 0, NWYR: 0, ...extra } });

// ---------------------------------------------------------------------------------------------------------------
// state files
// ---------------------------------------------------------------------------------------------------------------
test('state files: written in one step, one previous good copy, a failed write leaves the old file', () => {
  const dir = tmpDir('statefile'), f = path.join(dir, 'state.json'), logs = [], log = (m) => logs.push(m);
  assert.equal(loadJsonState(f, { log }).source, 'none');
  saveJsonState(f, { v: 1 }, { backup: true, log, pretty: 2 });
  assert.ok(!fs.existsSync(backupPath(f)), 'nothing to keep before the second save');
  assert.equal(fs.readFileSync(f, 'utf8'), JSON.stringify({ v: 1 }, null, 2), 'same text on disk as a plain write');
  saveJsonState(f, { v: 2 }, { backup: true, log }); saveJsonState(f, { v: 3 }, { backup: true, log });
  assert.deepEqual(readJson(f), { v: 3 }); assert.deepEqual(readJson(backupPath(f)), { v: 2 }, 'exactly the previous save');
  // a write that fails (nothing sensible to write) changes nothing and leaves no temp file behind
  assert.throws(() => writeFileAtomic(f, 12345, { backup: true, log }));
  assert.deepEqual(readJson(f), { v: 3 }); assert.deepEqual(readJson(backupPath(f)), { v: 2 });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['state.json', 'state.json.bak']);
  // the folder cannot be created (a file is in the way): the error reaches the caller
  assert.throws(() => saveJsonState(path.join(f, 'x.json'), {}));
  // a reader holding the file open (Windows refuses the rename then) does not lose the save
  const fd = fs.openSync(f, 'r');
  try { saveJsonState(f, { v: 4 }, { backup: true, log }); } finally { fs.closeSync(fd); }
  assert.deepEqual(readJson(f), { v: 4 }); assert.deepEqual(readJson(backupPath(f)), { v: 3 });
  assert.equal(maxNumericName(dir), 0);
  fs.writeFileSync(path.join(dir, '41.bin'), ''); fs.mkdirSync(path.join(dir, '7')); fs.writeFileSync(path.join(dir, 'x9.bin'), '');
  assert.equal(maxNumericName(dir), 41); assert.equal(maxNumericName(path.join(dir, 'nope')), 0);
});

test('state files: a truncated, empty or wrong file loads the previous good copy and says so', () => {
  const dir = tmpDir('recover'), f = path.join(dir, 'dynasties.json'), valid = (v) => !!v && typeof v === 'object' && !!v.dynasties;
  const good = { nextId: 3, dynasties: { 1: { id: 1 }, 2: { id: 2 } } }, older = { nextId: 2, dynasties: { 1: { id: 1 } } };
  for (const [name, damage] of [['truncated', (text) => text.slice(0, Math.floor(text.length / 2))], ['empty', () => ''], ['binary junk', () => '\u0000\u0000\u0000'], ['wrong content', () => '[1,2,3]']]) {
    const logs = [];
    fs.rmSync(dir, { recursive: true, force: true });
    saveJsonState(f, older, { backup: true }); saveJsonState(f, good, { backup: true });
    fs.writeFileSync(f, damage(JSON.stringify(good)));
    const r = loadJsonState(f, { validate: valid, log: (m) => logs.push(m), what: 'the dynasty store' });
    assert.equal(r.source, 'backup', name); assert.deepEqual(r.value, older, name);
    assert.equal(logs.length, 1); assert.match(logs[0], /WARNING: the dynasty store .*Loaded the previous good copy .*dynasties\.json\.bak/, name);
    assert.ok(fs.existsSync(damagedPath(f)), `${name}: the damaged file is kept for a look`);
    // the damaged file is never copied over the good backup by the next save
    saveJsonState(f, { ...older, nextId: 9 }, { backup: true });
    assert.deepEqual(readJson(backupPath(f)), older, name); assert.equal(readJson(f).nextId, 9);
    saveJsonState(f, { ...older, nextId: 10 }, { backup: true });
    assert.equal(readJson(backupPath(f)).nextId, 9, 'after one good save the backup follows again');
  }
  // nothing usable: the caller is told, and both files are still there to look at
  const logs = [];
  fs.writeFileSync(f, '{"nextId":'); fs.writeFileSync(backupPath(f), 'also broken');
  const r = loadJsonState(f, { validate: valid, log: (m) => logs.push(m) });
  assert.equal(r.source, 'unreadable'); assert.equal(r.value, undefined); assert.match(logs[0], /no usable previous copy/);
  assert.equal(fs.readFileSync(damagedPath(f), 'utf8'), '{"nextId":');
  // a file that was removed on purpose is a fresh start, not a silent restore
  fs.rmSync(f); fs.writeFileSync(backupPath(f), JSON.stringify(good));
  const fresh = loadJsonState(f, { validate: valid, log: (m) => logs.push(m) });
  assert.equal(fresh.source, 'none'); assert.match(logs.at(-1), /does not exist/);
  // temp files of a writer that died are cleaned up, a live writer's file is not
  const stale = `${f}.999.deadbeef.tmp`, live = `${f}.998.cafecafe.tmp`;
  fs.writeFileSync(stale, 'x'); fs.writeFileSync(live, 'x'); fs.utimesSync(stale, new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));
  loadJsonState(f, { validate: valid });
  assert.ok(!fs.existsSync(stale)); assert.ok(fs.existsSync(live));
});

test('state files: a reader (the site sync) never sees half a file while the server keeps saving', async () => {
  const dir = tmpDir('reader'), f = path.join(dir, 'dynasties.json');
  saveJsonState(f, { n: 0, pad: 'x'.repeat(400000) }, { backup: true, pretty: 2 });
  const writer = spawn(process.execPath, ['--input-type=module', '-e', `
    import { saveJsonState } from './state-file.mjs';
    const pad = 'x'.repeat(400000);
    for (let n = 1; n <= 300; n++) saveJsonState(process.env.FILE, { n, pad }, { backup: true, pretty: 2 });
  `], { cwd: HERE, env: { ...process.env, FILE: f }, stdio: 'ignore' });
  let done = false, reads = 0, last = -1, busy = 0; writer.once('exit', () => { done = true; });
  while (!done) {
    let text;
    // what bridge/src/od.ts does: readFileSync + JSON.parse. Windows may briefly refuse to open a file being replaced.
    try { text = fs.readFileSync(f, 'utf8'); } catch (e) { assert.ok(['EBUSY', 'EPERM', 'EACCES'].includes(e.code), `unexpected read error ${e.code}`); busy++; await new Promise((r) => setImmediate(r)); continue; }
    const v = JSON.parse(text); // throws on half a file
    assert.ok(v.n >= last, 'never an older file than the one before'); assert.equal(v.pad.length, 400000);
    last = v.n; reads++;
    await new Promise((r) => setTimeout(r, 1));
  }
  assert.equal(writer.exitCode, 0); assert.equal(readJson(f).n, 300); assert.equal(readJson(backupPath(f)).n, 299);
  assert.ok(reads > 10, `read ${reads} times (${busy} busy)`);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['dynasties.json', 'dynasties.json.bak'], 'no temp files left');
});

// ---------------------------------------------------------------------------------------------------------------
// passwords
// ---------------------------------------------------------------------------------------------------------------
test('dynasty passwords: salted scrypt hash, checked in constant time, never the text', () => {
  const h1 = hashPassword('hunter2'), h2 = hashPassword('hunter2');
  assert.match(h1, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/); assert.ok(isPasswordHash(h1));
  assert.notEqual(h1, h2, 'a fresh salt every time'); assert.ok(!h1.includes('hunter2'));
  assert.ok(verifyPassword('hunter2', h1) && verifyPassword('hunter2', h2));
  for (const bad of ['Hunter2', 'hunter', 'hunter22', '', ' hunter2']) assert.ok(!verifyPassword(bad, h1), JSON.stringify(bad));
  assert.ok(verifyPassword('pässwörd ✓', hashPassword('pässwörd ✓')));
  // a stored value that was tampered with is "no", quickly: never an exception, never minutes of work
  const t0 = Date.now();
  for (const junk of ['', 'hunter2', 'scrypt$1$8$1$AAAAAAAAAAA=$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', h1.replace('$16384$', '$1048576$'), h1.replace('$16384$', '$16385$'), h1.replace('$8$1$', '$99$1$'), h1.replace('$8$1$', '$8$64$'), null, 5, {}])
    assert.equal(verifyPassword('hunter2', junk), false, String(junk));
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(!verifyPassword('hunter2', h1.slice(0, -4) + 'AAA='), 'a different key does not match');

  // a dynasty stored by the old server: converted once, the text is gone, the same password still opens it
  const d = { id: 13, request: { NAME: 'locked', PASS: 'secret', PRIV: 0 }, members: [{ blazeId: 303, commissioner: true }] };
  assert.ok(hasPassword(d)); assert.ok(protectDynastyPassword(d)); assert.ok(!protectDynastyPassword(d), 'only once');
  assert.equal(d.request.PASS, ''); assert.ok(isPasswordHash(d.passwordHash)); assert.ok(hasPassword(d));
  assert.ok(!JSON.stringify(d).includes('secret'));
  const b = { userId: 202, leagueAuthenticated: true, joinDynasties: [] };
  assert.ok(!mayJoinDynasty(d, b, { PASS: 'nope' })); assert.ok(!mayJoinDynasty(d, b, {})); assert.ok(!mayJoinDynasty(d, b, { PASS: '' }));
  assert.ok(mayJoinDynasty(d, b, { PASS: 'secret' }));
  assert.ok(mayJoinDynasty(d, { userId: 303 }, {}), 'a member needs no password');
  // no password: open as before, and nothing is added to the record
  const open = { id: 14, request: { NAME: 'open', PASS: '' }, members: [] };
  assert.ok(!protectDynastyPassword(open)); assert.equal(open.passwordHash, undefined); assert.ok(passwordMatches(open, {}));
  assert.ok(!protectDynastyPassword({ id: 15, members: [] })); assert.ok(!protectDynastyPassword({ id: 16, request: {} }));
  // guesses are counted: after a few wrong ones the answer is "no" without the slow check, even for the right one
  const guesser = { userId: 777, leagueAuthenticated: true, joinDynasties: [] };
  for (let i = 0; i < 12; i++) assert.ok(!passwordMatches(d, { PASS: `guess${i}` }, guesser));
  const t1 = Date.now();
  for (let i = 0; i < 2000; i++) assert.ok(!passwordMatches(d, { PASS: `guess${i}` }, guesser));
  assert.ok(Date.now() - t1 < 2000, 'blocked guesses cost nothing');
  assert.ok(!passwordMatches(d, { PASS: 'secret' }, guesser), 'locked out for the rest of the minute');
  assert.ok(passwordMatches(d, { PASS: 'secret' }, { userId: 778 }), 'someone else is not affected');
});

test('dynasty passwords: an old store is converted when it is loaded, and existing dynasties keep working', () => {
  const dir = tmpDir('pwstore');
  fs.mkdirSync(priv(dir), { recursive: true });
  const old = { nextId: 4, dynasties: {
    1: { id: 1, request: { NAME: 'locked', PASS: 'Sw0rdfish!' }, createdAt: 1, members: [{ blazeId: 1000, persona: 'Owner', commissioner: true, coach: 0, team: 5 }], season: 1, week: 3, year: 0, state: 0, fileId: 0, tables: {} },
    2: { id: 2, request: { NAME: 'open', PASS: '' }, createdAt: 1, members: [{ blazeId: 1000, persona: 'Owner', commissioner: true, coach: 0, team: 9 }], season: 1, week: 0, year: 0, state: 0, fileId: 0, tables: {} },
    3: { id: 3, request: { NAME: 'nopassfield' }, createdAt: 1, members: [{ blazeId: 1000, persona: 'Owner', commissioner: true, coach: 0, team: 0 }], season: 1, week: 0, year: 0, state: 0, fileId: 0, tables: {} },
  } };
  fs.writeFileSync(priv(dir, 'dynasties.json'), JSON.stringify(old, null, 2));
  const join = (user, did, pass) => ({ user, cmd: 6, body: { DID: did, PASS: pass, COCH: 65535 } });
  const r = runDod(dir, { calls: [
    { user: 1000, cmd: 13 }, { user: 1000, cmd: 5, body: { DID: 1 } }, { user: 1000, cmd: 71, body: { DID: 1 } },
    join(2001, 1, 'wrong'), join(2002, 1, 'Sw0rdfish!'), join(2003, 2, ''), join(2004, 3, 'anything'),
    create(1000, 'fresh', 'N3wPass'), join(2005, 4, 'nope'), join(2006, 4, 'N3wPass'), { user: 2006, cmd: 5, body: { DID: 4 } },
  ] });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /1 dynasty password\(s\) converted from plain text to a salted hash/);
  for (const secret of ['Sw0rdfish!', 'N3wPass']) assert.ok(!r.out.includes(secret), 'passwords are never logged');
  const [hub, getDyn, extra, wrong, right, openJoin, noField, created, wrongNew, rightNew, memberView] = r.results;
  assert.equal(hub.body.DNFO.items.length, 3, 'the owner still has all three dynasties');
  assert.equal(getDyn.body.NAME, 'locked'); assert.equal(getDyn.body.WEEK, 3); assert.equal(getDyn.body.PASS, '', 'nobody is sent a password');
  assert.equal(extra.body.PASS, '');
  assert.doesNotMatch(wrong.note, /joined/); assert.match(right.note, /joined DID 1/); assert.match(openJoin.note, /joined DID 2/); assert.match(noField.note, /joined DID 3/);
  assert.equal(created.body.DID, 4); assert.doesNotMatch(wrongNew.note, /joined/); assert.match(rightNew.note, /joined DID 4/); assert.equal(memberView.body.PASS, '');
  // on disk: no password text in the store or in its previous copy; hashes where there were passwords; the rest untouched
  const text = fs.readFileSync(priv(dir, 'dynasties.json'), 'utf8'), bak = fs.readFileSync(priv(dir, 'dynasties.json.bak'), 'utf8');
  for (const secret of ['Sw0rdfish!', 'N3wPass']) { assert.ok(!text.includes(secret)); assert.ok(!bak.includes(secret), 'not in the .bak either'); }
  const now = JSON.parse(text); // exactly how the site sync reads it
  assert.ok(isPasswordHash(now.dynasties[1].passwordHash)); assert.ok(isPasswordHash(now.dynasties[4].passwordHash));
  assert.equal(now.dynasties[1].request.PASS, ''); assert.equal(now.dynasties[1].request.NAME, 'locked'); assert.equal(now.dynasties[4].request.PASS, '');
  assert.equal(now.dynasties[2].passwordHash, undefined); assert.equal(now.dynasties[3].passwordHash, undefined); assert.ok(!('PASS' in now.dynasties[3].request));
  assert.deepEqual(now.dynasties[1].members.map((m) => m.blazeId), [1000, 2002]); assert.equal(now.dynasties[1].members[0].team, 5);
  assert.ok(verifyPassword('Sw0rdfish!', now.dynasties[1].passwordHash));
  // a second start changes nothing more
  const again = runDod(dir, { calls: [join(2007, 1, 'Sw0rdfish!')] });
  assert.doesNotMatch(again.out, /converted/); assert.match(again.results[0].note, /joined DID 1/);
  assert.equal(readJson(priv(dir, 'dynasties.json')).dynasties[1].passwordHash, now.dynasties[1].passwordHash);
});

// ---------------------------------------------------------------------------------------------------------------
// storage limits
// ---------------------------------------------------------------------------------------------------------------
test('limits settings: sensible defaults, configurable, and a bad value is a clear error', () => {
  const d = limits({});
  assert.deepEqual([d.tableMaxRows, d.tableMaxBytes, d.dynastyMaxTables, d.dynastyTablesBytes, d.memberMaxTables, d.memberTablesBytes, d.dynastyRecordBytes, d.gameDataMaxBytes, d.dynastyMaxGameFiles, d.stateBudgetBytes],
    [60000, 32 * 2 ** 20, 200, 128 * 2 ** 20, 100, 64 * 2 ** 20, 4096 * 1024, 2048 * 1024, 1000, 2048 * 2 ** 20]);
  const c = limits({ NCAA_TABLE_MAX_ROWS: '500', NCAA_TABLE_MAX_MB: '2', NCAA_DYNASTY_MAX_TABLES: '90', NCAA_DYNASTY_TABLES_MB: '40', NCAA_MEMBER_MAX_TABLES: '30', NCAA_MEMBER_TABLES_MB: '8', NCAA_DYNASTY_RECORD_KB: '512', NCAA_GAME_DATA_MAX_KB: '256', NCAA_DYNASTY_MAX_GAME_FILES: '50', NCAA_STATE_BUDGET_MB: '1000' });
  assert.deepEqual([c.tableMaxRows, c.tableMaxBytes, c.dynastyMaxTables, c.dynastyTablesBytes, c.memberMaxTables, c.memberTablesBytes, c.dynastyRecordBytes, c.gameDataMaxBytes, c.dynastyMaxGameFiles, c.stateBudgetBytes],
    [500, 2 * 2 ** 20, 90, 40 * 2 ** 20, 30, 8 * 2 ** 20, 512 * 1024, 256 * 1024, 50, 1000 * 2 ** 20]);
  assert.throws(() => limits({ NCAA_STATE_BUDGET_MB: 'lots' }), /NCAA_STATE_BUDGET_MB must be a whole number/);
  assert.throws(() => limits({ NCAA_TABLE_MAX_ROWS: '0' }), /NCAA_TABLE_MAX_ROWS/);
});

test('storage budget: counts what is on disk, refuses what does not fit, one clear log line', () => {
  const dir = tmpDir('budget'), logs = []; let t = 1e6;
  fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a', 'one.json'), 'x'.repeat(3000)); fs.writeFileSync(path.join(dir, 'a', 'b', 'two.bin'), 'x'.repeat(2000));
  assert.deepEqual(treeSize(dir), { bytes: 5000, files: 2 });
  const off = new StorageBudget();
  assert.ok(!off.enabled); assert.ok(off.fits(1e15), 'off: nothing is ever refused');
  const b = new StorageBudget().configure({ root: dir, maxBytes: 10000, log: (m) => logs.push(m), rescanMs: 0, now: () => t });
  assert.equal(b.used, 5000); assert.match(logs[0], /league data uses .* MB of the .* MB allowed \(NCAA_STATE_BUDGET_MB\)/);
  assert.ok(b.fits(5000)); assert.ok(!b.fits(5001)); assert.ok(b.fits(-1), 'freeing space always fits');
  b.refused('a 5001-byte upload by user 800001'); b.refused('another'); // the second within a minute is not repeated
  assert.equal(logs.filter((m) => /STORAGE FULL/.test(m)).length, 1);
  assert.match(logs.find((m) => /STORAGE FULL/.test(m)), /STORAGE FULL: league data is at .* of the .* MB allowed \(NCAA_STATE_BUDGET_MB\)\. Refused: a 5001-byte upload by user 800001/);
  t += 61000; b.refused('later'); assert.equal(logs.filter((m) => /STORAGE FULL/.test(m)).length, 2);
  // per-folder usage follows writes and removals; .tmp and .bak files are not counted as tables
  fs.writeFileSync(path.join(dir, 'a', 'x.json.123.tmp'), 'zz'); fs.writeFileSync(path.join(dir, 'a', 'one.json.bak'), 'zz');
  const u = b.folderUsage(path.join(dir, 'a'));
  assert.equal(u.count, 1); assert.equal(u.bytes, 3000);
  b.recordWrite(path.join(dir, 'a', 'new.json'), 4000, 0);
  assert.equal(b.used, 9000); assert.equal(b.folderUsage(path.join(dir, 'a')).count, 2); assert.equal(b.folderUsage(path.join(dir, 'a')).bytes, 7000);
  assert.ok(logs.some((m) => /WARNING: league data is at .*more than 80%/.test(m)), 'a warning before it is full');
  b.recordWrite(path.join(dir, 'a', 'new.json'), 1000, 4000); assert.equal(b.used, 6000); assert.equal(b.folderUsage(path.join(dir, 'a')).bytes, 4000);
  b.recordRemove(path.join(dir, 'a', 'new.json'), 1000); assert.equal(b.used, 5000); assert.equal(b.folderUsage(path.join(dir, 'a')).count, 1);
  b.recordTreeRemoved(path.join(dir, 'a'), 5000); assert.equal(b.used, 0);
  assert.equal(b.folderUsage(path.join(dir, 'missing')).count, 0);
});

test('local mode: no caps, nothing refused, same files as before (plus the .bak of the store)', () => {
  const dir = tmpDir('local');
  const r = runDod(dir, { calls: [
    create(1000, 'big'), start(1000, 1, 0), send(1000, 1, 'PLAY', rowsOf(30000), 20), send(1000, 1, 'PLAY', rowsOf(30000, 7, 30000), 20), send(1000, 1, 'PLAY', rowsOf(30000, 7, 60000), 20),
    ...Array.from({ length: 40 }, (_, i) => send(1000, 1, `T${String(i).padStart(3, '0')}`, rowsOf(5))), end(1000, 1, 0),
    { user: 1000, cmd: 80, body: { DYID: 1, PRED: list(Array.from({ length: 30000 }, (_, i) => ({ PRID: i, SQUT: 1 }))), TMED: list([]) } },
  ] });
  assert.equal(r.status, 0, r.out);
  assert.ok(r.results.every((x) => x.ok === true), 'every call answered normally');
  assert.doesNotMatch(r.out, /REFUSED|STORAGE FULL|league data uses/);
  const play = readJson(priv(dir, 'dynasty-tables', '1', 'PLAY.json')); // as bridge/src/commands/od.ts reads it
  assert.equal(play.rows.length, 90000); assert.deepEqual(play.rows[89999], { TGID: 7, PGID: 89999, NAME: 'x'.repeat(20) }); assert.equal(play.table, 'PLAY'); assert.deepEqual(play.columns.SINT, ['TGID', 'PGID']);
  assert.deepEqual(fs.readdirSync(priv(dir, 'dynasty-tables', '1')).filter((f) => !f.endsWith('.json')), [], 'only <TABLE>.json files: no .bak, no temp files');
  assert.equal(fs.readdirSync(priv(dir, 'dynasty-tables', '1')).length, 41);
  const store = readJson(priv(dir, 'dynasties.json'));
  assert.equal(store.nextId, 2); assert.equal(store.dynasties[1].tables.PLAY.rows, 90000); assert.equal(store.dynasties[1].prospectExtra.length, 30000);
  assert.equal(fs.readFileSync(priv(dir, 'dynasties.json'), 'utf8'), JSON.stringify(store, null, 2), 'same pretty-printed format');
  assert.deepEqual(fs.readdirSync(priv(dir)).filter((f) => f.startsWith('dynasties')).sort(), ['dynasties.json', 'dynasties.json.bak']);
});

test('limits on: rows, bytes and number of tables are capped per dynasty; a refusal changes nothing', () => {
  const dir = tmpDir('caps');
  const L = { tableMaxRows: 50, tableMaxBytes: 20000, dynastyMaxTables: 3, dynastyTablesBytes: 30000 };
  const r = runDod(dir, { limits: L, calls: [
    create(1000, 'capped'), start(1000, 1, 0),
    send(1000, 1, 'AAAA', rowsOf(30)),            // 2 ok
    send(1000, 1, 'AAAA', rowsOf(30, 7, 30)),     // 3 refused: 60 rows > 50
    send(1000, 1, 'AAAA', rowsOf(20, 7, 30)),     // 4 ok: exactly 50
    send(1000, 1, 'BBBB', rowsOf(10), 2500),      // 5 refused: one table > 20000 bytes
    send(1000, 1, 'BBBB', rowsOf(10), 1500),      // 6 ok (about 15.5 KB)
    send(1000, 1, 'CCCC', rowsOf(10), 1500),      // 7 refused: the dynasty would pass 30000 bytes
    send(1000, 1, 'CCCC', rowsOf(2)),             // 8 ok: third table
    send(1000, 1, 'DDDD', rowsOf(1)),             // 9 refused: a fourth table
    send(1000, 1, 'CCCC', rowsOf(3, 7, 2)),       // 10 ok: an existing table can still grow
    end(1000, 1, 0),
    start(1000, 1, 0), send(1000, 1, 'BBBB', rowsOf(1)), end(1000, 1, 0), // a smaller rewrite is never refused
  ] });
  assert.equal(r.status, 0, r.out);
  const ok = r.results.map((x) => x.ok);
  assert.deepEqual(ok.slice(0, 12), [true, true, true, false, true, false, true, false, true, false, true, true], r.out);
  for (const i of [3, 5, 7, 9]) { assert.equal(r.results[i].code, 63, 'the console gets an error reply, not a fake success'); assert.match(r.results[i].note, /refused, storage limit/); }
  const refusals = r.out.split('\n').filter((l) => /REFUSED \(storage limit\)/.test(l));
  assert.equal(refusals.length, 4);
  assert.match(refusals[0], /sendTableUpdate for DID 1 by user 1000: table AAAA would have 60 rows; the limit is 50 \(NCAA_TABLE_MAX_ROWS\)/);
  assert.match(refusals[1], /table BBBB would be \d+ bytes; the limit is 20000 \(NCAA_TABLE_MAX_MB\)/);
  assert.match(refusals[2], /the dynasty's tables would pass 30000 bytes \(NCAA_DYNASTY_TABLES_MB\)/);
  assert.match(refusals[3], /the dynasty already has 3 table files; the limit is 3 \(NCAA_DYNASTY_MAX_TABLES\)/);
  const t = (name) => readJson(priv(dir, 'dynasty-tables', '1', `${name}.json`));
  assert.equal(t('AAAA').rows.length, 50); assert.deepEqual(t('AAAA').rows[49], { TGID: 7, PGID: 49 }, 'the refused chunk left no rows behind');
  assert.equal(t('CCCC').rows.length, 5); assert.equal(t('BBBB').rows.length, 1);
  assert.deepEqual(fs.readdirSync(priv(dir, 'dynasty-tables', '1')).sort(), ['AAAA.json', 'BBBB.json', 'CCCC.json']);
  const d = readJson(priv(dir, 'dynasties.json')).dynasties[1];
  assert.deepEqual(Object.keys(d.tables).sort(), ['AAAA', 'BBBB', 'CCCC']); assert.equal(d.tables.AAAA.rows, 50); assert.equal(d.update, null);

  // a refused FIRST chunk of a full upload must not wipe the table that is already stored
  const r2 = runDod(dir, { limits: L, calls: [start(1000, 1, 0), send(1000, 1, 'AAAA', rowsOf(51)), end(1000, 1, 0)] });
  assert.equal(r2.results[1].ok, false); assert.equal(t('AAAA').rows.length, 50);
});

test('limits on: a signed-in member has their own caps, in one dynasty and across dynasties', () => {
  const dir = tmpDir('member');
  const L = { memberMaxTables: 2, memberTablesBytes: 6000, tableMaxRows: 1000, tableMaxBytes: 1e6, dynastyMaxTables: 100, dynastyTablesBytes: 1e7 };
  const join = (user, did) => ({ user, auth: true, cmd: 6, body: { DID: did, PASS: '', COCH: 65535 } });
  const M = 800002;
  const r = runDod(dir, { limits: L, calls: [
    create(800001, 'one'), create(800001, 'two'), join(M, 1), join(M, 2),
    start(M, 1, 1, true),
    send(M, 1, 'PLYZ', rowsOf(5), 400, true),  // 5 ok (about 2.2 KB)
    send(M, 1, 'TEAM', rowsOf(1), 0, true),    // 6 ok
    send(M, 1, 'COCH', rowsOf(1), 0, true),    // 7 refused: a third table file for this member here
    end(M, 1, 1, true, { TMID: 0 }),
    start(M, 2, 1, true),
    send(M, 2, 'PLYZ', rowsOf(5), 400, true),  // 10 ok: 4.4 KB in total now
    send(M, 2, 'TEAM', rowsOf(5), 400, true),  // 11 refused: would pass 6000 bytes across both dynasties
    end(M, 2, 1, true, { TMID: 0 }),
    // the commissioner is not held to the member caps (the dynasty caps apply to shared tables)
    start(800001, 1, 0, true), send(800001, 1, 'PLYZ', rowsOf(50), 400, true), end(800001, 1, 0, true),
  ] });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.results.map((x) => x.ok), [true, true, true, true, true, true, true, false, true, true, true, false, true, true, true, true], r.out);
  assert.equal(r.results[7].code, 63); assert.equal(r.results[11].code, 63);
  assert.match(r.out, /REFUSED \(storage limit\): sendTableUpdate for DID 1 by user 800002: the member already has 2 table files in this dynasty; the limit is 2 \(NCAA_MEMBER_MAX_TABLES\)/);
  assert.match(r.out, /REFUSED \(storage limit\): sendTableUpdate for DID 2 by user 800002: the member's own tables would pass 6000 bytes \(NCAA_MEMBER_TABLES_MB\)/);
  assert.deepEqual(fs.readdirSync(priv(dir, 'dynasty-member-tables', '1', String(M))).sort(), ['PLYZ.json', 'TEAM.json']);
  assert.deepEqual(fs.readdirSync(priv(dir, 'dynasty-member-tables', '2', String(M))), ['PLYZ.json']);
  assert.ok(!fs.existsSync(priv(dir, 'dynasty-tables', '2')), 'a member upload never touches the shared tables');
  assert.equal(readJson(priv(dir, 'dynasty-tables', '1', 'PLYZ.json')).rows.length, 50);
});

test('limits on: the total budget, the dynasty record, results, prospects, game data, and deleting frees space', () => {
  const dir = tmpDir('budgetdod');
  // 1. the state budget: 60 KB for everything
  const a = runDod(dir, { limits: {}, budget: 60000, calls: [
    create(1000, 'full'), start(1000, 1, 0), send(1000, 1, 'AAAA', rowsOf(20), 1000), send(1000, 1, 'BBBB', rowsOf(20), 1000),
    send(1000, 1, 'CCCC', rowsOf(20), 1000), end(1000, 1, 0),
  ] });
  assert.equal(a.status, 0, a.out);
  assert.deepEqual(a.results.map((x) => x.ok), [true, true, true, true, false, true], a.out);
  assert.equal(a.results[4].code, 63);
  assert.match(a.out, /\[storage\] league data uses .* MB of the 0\.1 MB allowed \(NCAA_STATE_BUDGET_MB\)/);
  assert.match(a.out, /\[storage\] STORAGE FULL: league data is at .* MB of the 0\.1 MB allowed \(NCAA_STATE_BUDGET_MB\)\. Refused: sendTableUpdate for dynasty 1 by user 1000\. New uploads are refused until space is freed or the limit is raised\./);
  assert.match(a.out, /REFUSED \(storage limit\): sendTableUpdate for DID 1 by user 1000: the league storage budget is full/);
  assert.ok(!fs.existsSync(priv(dir, 'dynasty-tables', '1', 'CCCC.json')));
  assert.ok(treeSize(priv(dir, 'dynasty-tables')).bytes < 60000);

  // 2. things kept inside dynasties.json
  const result = (user, wk, home, away) => ({ user, cmd: 24, body: { DYID: 1, GMWK: wk, HTID: home, ATID: away, HTSC: 21, ATSC: 14, TMID: home } });
  const b = runDod(dir, { limits: { dynastyRecordBytes: 40000 }, calls: [
    ...Array.from({ length: 9 }, (_, i) => result(1000, 1, 5, 100 + i)),                                   // 0-8: the ninth different game of one week by one member is refused
    result(1000, 1, 5, 100),                                                                                  // 9: replacing an own result is fine
    { user: 1000, cmd: 80, body: { DYID: 1, PRED: list(Array.from({ length: 20001 }, (_, i) => ({ PRID: i, SQUT: 1 }))), TMED: list([]) } }, // 10 refused
    { user: 1000, cmd: 80, body: { DYID: 1, PRED: list(Array.from({ length: 6000 }, (_, i) => ({ PRID: i, SQUT: 1 }))), TMED: list([]) } },  // 11 ok, and the record is now over 40 KB
    result(1000, 2, 5, 200),                                                                                  // 12 refused: the record is over its limit
    { user: 1000, cmd: 5, body: { DID: 1 } },                                                                 // 13 reading still works
    create(1000, 'x'.repeat(20000)),                                                                          // 14 refused: an oversized create request
  ] });
  assert.equal(b.status, 0, b.out);
  assert.deepEqual(b.results.map((x) => x.ok), [true, true, true, true, true, true, true, true, false, true, false, true, false, true, false], b.out);
  assert.match(b.out, /REFUSED \(storage limit\): UploadGameResults for DID 1 by user 1000: too many game results/);
  assert.match(b.out, /REFUSED \(storage limit\): optimizeProspectInfo for DID 1 by user 1000: prospect list of 20001/);
  assert.match(b.out, /REFUSED \(storage limit\): UploadGameResults for DID 1 by user 1000: the dynasty's entry in dynasties\.json is \d+ bytes; the limit is 40000 \(NCAA_DYNASTY_RECORD_KB\)/);
  assert.match(b.out, /REFUSED \(storage limit\): createDynasty .* larger than 16 KB/);
  const store = readJson(priv(dir, 'dynasties.json'));
  assert.equal(store.dynasties[1].games[1].length, 8); assert.equal(store.dynasties[1].games[2], undefined); assert.deepEqual(Object.keys(store.dynasties), ['1']);

  // 3. uploaded game data: one small file per team and week; oversized uploads are not kept; a new upload replaces the old file
  const game = (ghid, pad) => [
    start(1000, 1, 2), { user: 1000, cmd: 12, body: { ...tableBody(1, 'GINF', []), GHID: ghid, RTID: 5, SINT: list([pack4('GHTG'), pack4('GATG'), pack4('SGID')]), TINT: list([pack4('GHSC'), pack4('GASC'), pack4('GQTR'), pack4('SGNM')]), ROWS: list([{ SINT: list([5, 6, 1]), TINT: list([21, 14, 6, 3]) }]) } },
    { user: 1000, cmd: 12, body: { ...tableBody(1, 'PGOF', rowsOf(4), pad), GHID: ghid } }, end(1000, 1, 2, false, { TMID: 5, NWWK: 4 }),
  ];
  const c = runDod(dir, { limits: { dynastyRecordBytes: 1e7, gameDataMaxBytes: 3000 }, calls: [{ user: 1000, cmd: 45, body: { DYID: 1, OLTM: 0, NWTM: 5 } }, ...game(11, 10), ...game(12, 10), ...game(13, 2000)] });
  assert.equal(c.status, 0, c.out);
  assert.ok(c.results.every((x) => x.ok), c.out);
  assert.doesNotMatch(c.out, /rejected game data/);
  assert.match(c.out, /console game week 4 6@5 14-21 .* kept as game data 900001 for team 5/); assert.match(c.out, /kept as game data 900002/);
  assert.match(c.out, /REFUSED \(storage limit\): game data from user 1000 for DID 1 week 4: it is \d+ bytes; the limit is 3000 \(NCAA_GAME_DATA_MAX_KB\)/);
  assert.deepEqual(fs.readdirSync(priv(dir, 'game-data', '1')), ['900002.json'], 'the replaced upload is removed, the oversized one never written');
  assert.deepEqual(readJson(priv(dir, 'dynasties.json')).dynasties[1].gameData[4], [{ team: 5, id: 900002, source: 'console' }]);
  assert.equal(readJson(priv(dir, 'game-data', '1', '900002.json')).tables.PGOF.length, 4);

  // 4. deleting a dynasty frees its tables and game data (limits on); without limits the folders stay, as before
  const d1 = runDod(dir, { calls: [{ user: 1000, cmd: 3, body: { DID: 1 } }] });
  assert.equal(d1.status, 0, d1.out); assert.ok(fs.existsSync(priv(dir, 'dynasty-tables', '1', 'AAAA.json')), 'local mode keeps them');
  fs.writeFileSync(priv(dir, 'dynasties.json'), JSON.stringify(store)); // put the dynasty back
  const d2 = runDod(dir, { limits: {}, budget: 10e6, calls: [{ user: 1000, cmd: 3, body: { DID: 1 } }, create(1000, 'next')] });
  assert.equal(d2.status, 0, d2.out); assert.match(d2.out, /DID 1 deleted: \d+ bytes of tables and game data removed/);
  assert.ok(!fs.existsSync(priv(dir, 'dynasty-tables', '1'))); assert.ok(!fs.existsSync(priv(dir, 'game-data', '1')));
  assert.equal(d2.results[1].body.DID, 2, 'ids are not reused');
});

// ---------------------------------------------------------------------------------------------------------------
// recovery at start
// ---------------------------------------------------------------------------------------------------------------
test('start with a damaged dynasties.json: the previous good copy is loaded; ids never fall back onto old data', () => {
  const dir = tmpDir('dodrecover');
  const first = runDod(dir, { calls: [create(1000, 'alpha'), create(1000, 'beta'), start(1000, 2, 0), send(1000, 2, 'TEAM', rowsOf(3)), end(1000, 2, 0)] });
  assert.equal(first.status, 0, first.out);
  const good = fs.readFileSync(priv(dir, 'dynasties.json'), 'utf8');
  assert.ok(fs.existsSync(priv(dir, 'dynasties.json.bak')));
  // power cut mid-write on a server without atomic writes: half a file
  fs.writeFileSync(priv(dir, 'dynasties.json'), good.slice(0, good.length >> 1));
  const r = runDod(dir, { calls: [{ user: 1000, cmd: 13 }, create(1000, 'gamma')] });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /WARNING: the dynasty store \(dynasties\.json\) is not valid JSON \(truncated or damaged\)\. Loaded the previous good copy .*dynasties\.json\.bak/);
  assert.equal(r.results[0].body.DNFO.items.length, 2, 'both dynasties are back, not an empty league');
  assert.equal(r.results[1].body.DID, 3);
  assert.ok(fs.existsSync(priv(dir, 'dynasties.json.damaged')));
  assert.deepEqual(Object.keys(readJson(priv(dir, 'dynasties.json')).dynasties), ['1', '2', '3']);

  // a previous copy from BEFORE dynasty 3 existed: its id must not be handed out again while its tables are on disk
  fs.mkdirSync(priv(dir, 'dynasty-tables', '9'), { recursive: true });
  const older = { nextId: 2, dynasties: { 1: readJson(priv(dir, 'dynasties.json')).dynasties[1] } };
  fs.writeFileSync(priv(dir, 'dynasties.json.bak'), JSON.stringify(older)); fs.writeFileSync(priv(dir, 'dynasties.json'), '');
  const r2 = runDod(dir, { calls: [create(1000, 'delta')] });
  assert.equal(r2.status, 0, r2.out); assert.match(r2.out, /is empty\. Loaded the previous good copy/);
  assert.match(r2.out, /next dynasty id moved from 2 to 10/); assert.equal(r2.results[0].body.DID, 10);

  // nothing usable. Local PC: start empty (as it always did) but keep the damaged file and stay clear of old ids
  fs.writeFileSync(priv(dir, 'dynasties.json'), '{"nextId": 11, "dyn'); fs.writeFileSync(priv(dir, 'dynasties.json.bak'), '');
  const r3 = runDod(dir, { calls: [{ user: 1000, cmd: 13 }, create(1000, 'epsilon')] });
  assert.equal(r3.status, 0, r3.out); assert.match(r3.out, /no usable previous copy/);
  assert.equal(r3.results[0].body.DNFO.items.length, 0); assert.equal(r3.results[1].body.DID, 11, 'the id counter still readable in the damaged file is honoured');
  assert.equal(fs.readFileSync(priv(dir, 'dynasties.json.damaged'), 'utf8'), '{"nextId": 11, "dyn');
  // public server: refuses to start an empty league over existing data, with a message that says what to do
  fs.writeFileSync(priv(dir, 'dynasties.json'), '{"nextId": 5, "dyn'); fs.writeFileSync(priv(dir, 'dynasties.json.bak'), 'junk');
  const r4 = runDod(dir, { calls: [create(1000, 'never')] }, { NCAA_CLOUD: '1' });
  assert.equal(r4.status, 78, r4.out); assert.equal(r4.results, null);
  assert.match(r4.out, /\[dod\] cannot start: .*dynasties\.json is damaged and there is no good previous copy .*Restore the newest backup/);
  assert.equal(fs.readFileSync(priv(dir, 'dynasties.json'), 'utf8'), '{"nextId": 5, "dyn', 'nothing was overwritten');
});

test('Locker: index written atomically with a previous copy, recovered at start; uploads respect the budget', async () => {
  const dir = tmpDir('locker');
  const CHILD = `
    import fs from 'node:fs';
    const { handleLocker, startLockerHttp, getContent, configureLockerLimits } = await import('./locker.mjs');
    const { stateBudget } = await import('./storage-budget.mjs');
    const { Writer, decode } = await import('./tdf.mjs');
    const plan = JSON.parse(process.env.PLAN);
    if (plan.budget) stateBudget.configure({ root: process.env.NCAA_PRIVATE, maxBytes: plan.budget, rescanMs: 0, log: (m) => console.log('[storage] ' + m) });
    if (plan.quota) configureLockerLimits(plan.quota);
    const call = (command, body, userId = 1000) => { let out; handleLocker({ p: { command }, body, session: { userId, onlineId: 'U' + userId },
      reply: (build) => { const w = new Writer(); build?.(w); out = decode(w.bytes()); }, replyError: (code) => { out = { error: code }; } }); return out; };
    const server = startLockerHttp({ port: 0, bind: '127.0.0.1' });
    await new Promise((r) => server.once('listening', r));
    const base = 'http://127.0.0.1:' + server.address().port;
    const res = [];
    for (const s of plan.steps) {
      if (s.create) res.push(Number(call(1, { NAME: s.create, CCAT: 'LeagueStorage' }).INFO.CID));
      else if (s.upload) { const r = await fetch(base + '/locker/upload?cid=' + s.upload, { method: 'POST', body: Buffer.alloc(s.bytes, 7) }); res.push(r.status); if (r.status === 200) call(3, { INFO: { CID: s.upload } }); }
      else if (s.remove) { call(5, { CIDS: { items: s.remove } }); res.push('deleted'); }
      else if (s.get) res.push(getContent(s.get) ? getContent(s.get).size : null);
    }
    server.close(); console.log('RESULT ' + JSON.stringify(res));
  `;
  const run = (plan, extraEnv = {}) => { const r = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], { cwd: HERE, env: serverEnv(dir, { PLAN: JSON.stringify(plan), ...extraEnv }), encoding: 'utf8' }); const m = /RESULT (.*)/.exec(r.stdout); return { status: r.status, out: `${r.stdout}${r.stderr}`, res: m ? JSON.parse(m[1]) : null }; };
  const index = priv(dir, 'locker', 'index.json');

  const a = run({ steps: [{ create: 'a.team' }, { upload: 1, bytes: 5000 }, { create: 'b.team' }, { upload: 2, bytes: 3000 }, { get: 1 }] });
  assert.equal(a.status, 0, a.out); assert.deepEqual(a.res, [1, 200, 2, 200, 5000]);
  assert.equal(fs.statSync(priv(dir, 'locker', '1.bin')).size, 5000);
  assert.deepEqual(fs.readdirSync(priv(dir, 'locker')).sort(), ['1.bin', '2.bin', 'index.json', 'index.json.bak'], 'no temp files, one previous copy of the index');
  const idx = readJson(index); // as bridge/src/od.ts lockerIndex() reads it
  assert.equal(idx.contents[1].name, 'a.team'); assert.equal(idx.contents[2].size, 3000); assert.equal(idx.nextId, 3);
  assert.equal(fs.readFileSync(index, 'utf8'), JSON.stringify(idx, null, 2));

  // truncated index: the previous copy is used (it is one save older), and new ids stay clear of the files on disk
  fs.writeFileSync(index, fs.readFileSync(index, 'utf8').slice(0, 200));
  const b = run({ steps: [{ get: 1 }, { create: 'c.team' }] });
  assert.equal(b.status, 0, b.out); assert.match(b.out, /WARNING: the Locker index \(locker\/index\.json\) is not valid JSON.*Loaded the previous good copy/);
  assert.equal(b.res[0], 5000); assert.equal(b.res[1], 3);

  // budget: an upload that does not fit is refused with 413 and nothing is written; one that fits is stored
  const used = treeSize(priv(dir)).bytes;
  const c = run({ budget: used + 4000, steps: [{ create: 'd.team' }, { upload: 4, bytes: 6000 }, { get: 4 }, { upload: 4, bytes: 2000 }, { get: 4 }] });
  assert.equal(c.status, 0, c.out); assert.deepEqual(c.res, [4, 413, 0, 200, 2000]);
  assert.match(c.out, /STORAGE FULL: .*Refused: a 6000-byte Locker upload by user 1000/); assert.match(c.out, /upload for CID 4 refused \(the league's storage is full\)/);

  // with quotas on, a player's trash is bounded too: the oldest deleted files are removed first
  const quota = { maxUploadBytes: 1e6, lockerQuotaBytes: 5000, lockerMaxItems: 50 };
  const d = run({ quota, steps: [{ remove: [1] }, { remove: [2] }, { remove: [4] }] });
  assert.equal(d.status, 0, d.out); assert.match(d.out, /trash of user 1000: \d+ oldest deleted file\(s\) removed to stay within the storage limit/);
  const trash = fs.readdirSync(priv(dir, 'locker', 'trash'));
  assert.ok(trash.reduce((n, f) => n + fs.statSync(priv(dir, 'locker', 'trash', f)).size, 0) <= 5000, `trash ${trash}`);
  assert.ok(trash.includes('4.bin'), 'the newest deleted file is still recoverable');

  // nothing usable on a public server: it does not start
  fs.writeFileSync(index, '{'); fs.writeFileSync(`${index}.bak`, '');
  const e = run({ steps: [] }, { NCAA_CLOUD: '1' });
  assert.equal(e.status, 78, e.out); assert.match(e.out, /\[locker\] cannot start: .*index\.json is damaged/);
});

// ---------------------------------------------------------------------------------------------------------------
// the real server, end to end
// ---------------------------------------------------------------------------------------------------------------
test('cloud server end to end: caps on by default, error reply on refusal, hashed password, recovery after a crash', async () => {
  const TOKEN = 'test-bridge-token-0123456789abcdef', OK = 0x1000, ERR = 0x3000, DOD = 2148;
  const dir = tmpDir('cloudstore');
  const site = await fakeSite(TOKEN, { version: 1, generatedAt: new Date().toISOString(), players: [player(800001, 'CoachAlpha', 1), player(800002, 'CoachBravo', 2)] });
  const blazePort = await freePort(), lockerPort = await freePort();
  const env = serverEnv(dir, {
    NCAA_CLOUD: '1', NCAA_PUBLIC_HOST: '127.0.0.1', NCAA_BIND: '127.0.0.1', NCAA_SITE_URL: site.url, NCAA_BRIDGE_TOKEN: TOKEN,
    NCAA_BLAZE_PORT: String(blazePort), NCAA_LOCKER_PORT: String(lockerPort), NCAA_TABLE_MAX_ROWS: '100', NCAA_STATE_BUDGET_MB: '64',
  });
  const tableUpdate = (did, table, n, from = 0) => (w) => {
    w.int('DYID', did); w.list('ROWS', T.STRUCT, rowsOf(n, 7, from), (x, r) => { x.intList('SINT', r); x.push(0); });
    w.intList('SINT', [pack4('TGID'), pack4('PGID')]); w.int('TABL', pack4(table));
  };
  let server = startServer('blaze.mjs', { env, ready: 'blaze stub listening' });
  try {
    await server.up;
    assert.match(server.out.text, /\[storage\] league data uses 0 MB of the 64 MB allowed \(NCAA_STATE_BUDGET_MB\)/);
    const a = await blazeClient(blazePort), b = await blazeClient(blazePort);
    assert.equal((await a.login(ticket(1))).type, OK); assert.equal((await b.login(ticket(2))).type, OK);
    const made = await a.call(DOD, 2, (w) => { w.str('NAME', 'Locked League'); w.str('PASS', 'Tr0ub4dor'); });
    assert.equal(made.type, OK); const did = Number(made.body.DID);
    assert.equal((await a.call(DOD, 56, (w) => { w.int('DYID', did); w.int('UPDT', 0); })).type, OK);
    assert.equal((await a.call(DOD, 12, tableUpdate(did, 'PLAY', 60))).type, OK);
    const over = await a.call(DOD, 12, tableUpdate(did, 'PLAY', 60, 60));
    assert.equal(over.type, ERR); assert.equal(over.error, 63, 'DYNASTY_DATA_IS_LOCKED: the console is told the save did not happen');
    assert.equal((await a.call(DOD, 12, tableUpdate(did, 'PLAY', 40, 60))).type, OK, 'the connection is still usable and a chunk that fits is taken');
    assert.equal((await a.call(DOD, 57, (w) => { w.int('DYID', did); w.int('FID', 0); w.int('NWST', 1); w.int('NWWK', 0); w.int('NWYR', 0); w.int('UPDT', 0); })).type, OK);
    assert.match(server.out.text, /REFUSED \(storage limit\): sendTableUpdate for DID 1 by user 800001: table PLAY would have 120 rows; the limit is 100 \(NCAA_TABLE_MAX_ROWS\)/);
    assert.equal(readJson(priv(dir, 'dynasty-tables', String(did), 'PLAY.json')).rows.length, 100);
    // the password: wrong is refused, right joins, and the text is nowhere on disk or in the log
    assert.equal((await b.call(DOD, 6, (w) => { w.int('COCH', 65535); w.int('DID', did); w.str('PASS', 'guess'); })).type, ERR);
    assert.equal((await b.call(DOD, 6, (w) => { w.int('COCH', 65535); w.int('DID', did); w.str('PASS', 'Tr0ub4dor'); })).type, OK);
    const seen = await b.call(DOD, 5, (w) => w.int('DID', did));
    assert.equal(seen.type, OK); assert.equal(seen.body.PASS, '');
    const disk = fs.readFileSync(priv(dir, 'dynasties.json'), 'utf8');
    assert.ok(!disk.includes('Tr0ub4dor')); assert.ok(!server.out.text.includes('Tr0ub4dor'));
    assert.ok(!fs.readFileSync(priv(dir, 'dynasties.json.bak'), 'utf8').includes('Tr0ub4dor'));
    assert.ok(isPasswordHash(JSON.parse(disk).dynasties[did].passwordHash)); assert.deepEqual(JSON.parse(disk).dynasties[did].members.map((m) => m.blazeId), [800001, 800002]);
    a.sock.destroy(); b.sock.destroy();
    await server.stop();

    // the machine lost power while the file was being rewritten in place (what could happen before): half a file
    fs.writeFileSync(priv(dir, 'dynasties.json'), disk.slice(0, 300));
    server = startServer('blaze.mjs', { env, ready: 'blaze stub listening' });
    await server.up;
    assert.match(server.out.text, /WARNING: the dynasty store \(dynasties\.json\) is not valid JSON \(truncated or damaged\)\. Loaded the previous good copy/);
    const a2 = await blazeClient(blazePort);
    assert.equal((await a2.login(ticket(1))).type, OK);
    const hub = await a2.call(DOD, 13);
    assert.equal(hub.type, OK); assert.equal(hub.body.DNFO.items.length, 1, 'the league is still there');
    assert.equal(hub.body.DNFO.items[0].DYNA.NAME, 'Locked League');
    a2.sock.destroy();
    await server.stop();

    // both copies destroyed: the server says what to do and stays down (exit 78: systemd does not restart it)
    fs.writeFileSync(priv(dir, 'dynasties.json'), 'garbage'); fs.writeFileSync(priv(dir, 'dynasties.json.bak'), '');
    server = startServer('blaze.mjs', { env });
    assert.equal(await server.exited, 78);
    assert.match(server.out.text, /cannot start: .*dynasties\.json is damaged and there is no good previous copy/);
    assert.equal(fs.readFileSync(priv(dir, 'dynasties.json'), 'utf8'), 'garbage');
  } finally { await server.stop(); await site.close(); }
});
