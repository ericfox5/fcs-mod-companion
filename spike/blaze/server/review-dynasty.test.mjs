// Access-control and robustness fixes from the code review, dynasty side: the update lock, empty dynasties, removed
// members, passwords, roster pushes, the Locker, team packages and Dynasty Wire uploads.
// Everything runs in this process against a temp data folder: never the real league.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { tmpDir, ticket, player, sleep, until } from './testkit.mjs';

const DIR = tmpDir('review-dynasty');
const PRIVATE = path.join(DIR, 'private');
for (const k of Object.keys(process.env)) if (/^NCAA_/i.test(k)) delete process.env[k];
process.env.NCAA_PRIVATE = PRIVATE; process.env.NCAA_CAPTURE = 'off'; process.env.NCAA_LOG_BODIES = '0';

// A store as an older server left it: a dynasty everyone left, one with no member list at all, and one with an update
// lock that was never released (its holder is long gone).
const A = 800001, B = 800002, C = 800003, D = 800004;
fs.mkdirSync(PRIVATE, { recursive: true });
fs.writeFileSync(path.join(PRIVATE, 'dynasties.json'), JSON.stringify({ nextId: 50, dynasties: {
  7: { id: 7, request: { NAME: 'Ghost' }, createdAt: 1, members: [], season: 1, week: 0, fileId: 3, tables: {} },
  8: { id: 8, request: { NAME: 'NoList' }, createdAt: 1 },
  9: { id: 9, request: { NAME: 'Locked', MHUM: 12 }, createdAt: 1, fileId: 0, tables: {}, week: 0,
    members: [{ blazeId: A, persona: 'Alpha', commissioner: true, team: 1, coach: 0 }, { blazeId: B, persona: 'Bravo', commissioner: false, team: 2, coach: 0 }],
    update: { updt: 1, byUser: B, startedAt: 5, touched: [] } },
} }));

// what the server logs (the review asked for clear lines in a few places)
const logged = []; const realLog = console.log;
console.log = (...a) => { logged.push(a.join(' ')); };
test.after(() => { console.log = realLog; });

const { Writer, decode } = await import('./tdf.mjs');
const dod = await import('./dod.mjs');
const auth = await import('./league-auth.mjs');
const locker = await import('./locker.mjs');
const { store, handleDod, pack4 } = dod;

const session = (userId, onlineId) => ({ userId, onlineId, personaId: userId, leagueAuthenticated: true, joinDynasties: [], active: true });
const sA = session(A, 'Alpha'), sB = session(B, 'Bravo'), sC = session(C, 'Charl'), sD = session(D, 'Delta');
// One request, as blaze.mjs runs it in registry mode: authorizeDod first, then the handler.
function call(s, command, body = {}, { checked = true } = {}) {
  if (checked && !auth.authorizeDod(command, body, s, store, locker.getContent)) return { denied: true };
  let out = {};
  handleDod({ p: { command }, body, session: s, reply: (_, build, note) => { const w = new Writer(); build?.(w); out = { body: decode(w.bytes()), note }; }, replyError: (code) => { out = { error: code }; } });
  return out;
}
const lockerCall = (s, command, body = {}) => { let out = {}; locker.handleLocker({ p: { command }, body, session: s, reply: (build, note) => { const w = new Writer(); build?.(w); out = { body: decode(w.bytes()), note }; }, replyError: (code, note) => { out = { error: code, note }; } }); return out; };
const names = (r) => r.body.DLST.items.map((x) => x.NAME);
const create = (s, extra = {}) => Number(call(s, 2, { NAME: 'Dyn', MHUM: 12, ...extra }).body.DID);
const members = (did) => store.dynasties[did].members.map((m) => m.blazeId);

test('start: old records load, stale locks are cleared, empty dynasties answer every read without throwing', () => {
  assert.equal(store.dynasties[9].update, null, 'a lock from an earlier run is gone');
  assert.equal(store.dynasties[9].createdBy, A, 'the creator is filled in from the commissioner');
  assert.deepEqual(store.dynasties[8].members, []);
  assert.ok(logged.some((l) => /1 update lock\(s\) left by an earlier run cleared/.test(l)));
  assert.ok(logged.some((l) => /2 dynasties have no members/.test(l)));
  // search (the call that used to throw for everyone and send no reply): answers, and lists only the live dynasty
  const found = call(sC, 22, { NAME: '', MAXR: 50 });
  assert.deepEqual(names(found), ['Locked']);
  // every read on a dynasty with no members answers (handler alone, as on a local PC with no authorization step)
  for (const did of [7, 8]) for (const command of [4, 5, 11, 13, 22, 23, 25, 26, 58, 64, 71, 83, 107]) {
    assert.doesNotThrow(() => call(sC, command, { DID: did, DYID: did, DYNI: did, TABL: pack4('TEAM'), TMID: 1023, WKID: 0 }, { checked: false }), `command ${command} on dynasty ${did}`);
  }
  assert.equal(call(sC, 5, { DID: 7 }, { checked: false }).body.CMSH.PERS, '', 'no commissioner: an empty user, not a crash');
  // nobody can see or join a dynasty nobody is in
  assert.ok(call(sC, 5, { DID: 7 }).denied); assert.ok(call(sC, 6, { DID: 7 }).denied); assert.ok(call(sC, 58, { DYID: 8, TMID: 1023 }).denied);
  assert.equal(store.dynasties[7].members.length, 0, 'and it is kept on disk as it was');
});

test('update lock: one holder; the commissioner goes first, breaks it, and it ends by itself', () => {
  assert.ok(!call(sC, 6, { DID: 9 }).denied); assert.deepEqual(members(9), [A, B, C]);
  // a member holds it: another member is refused, the commissioner's update replaces it
  assert.ok(!call(sB, 56, { DYID: 9, UPDT: 1 }).denied); assert.equal(store.dynasties[9].update.byUser, B);
  assert.ok(call(sC, 56, { DYID: 9, UPDT: 1 }).denied, 'a second member waits');
  assert.ok(!call(sA, 56, { DYID: 9, UPDT: 0 }).denied, 'the commissioner does not');
  assert.equal(store.dynasties[9].update.byUser, A);
  assert.ok(call(sB, 12, { DYID: 9, TABL: pack4('TEAM') }).denied, 'the member whose update was replaced cannot write into the commissioner\'s');
  assert.ok(call(sB, 57, { DYID: 9, UPDT: 1, TMID: 2 }).denied, 'nor end it');
  assert.ok(call(sB, 56, { DYID: 9, UPDT: 1 }).denied, 'and a member never takes over the commissioner\'s update');
  assert.ok(!call(sA, 57, { DYID: 9, UPDT: 0 }).denied); assert.equal(store.dynasties[9].update, null);

  // BreakLock: only the commissioner, and it really clears the lock
  call(sB, 56, { DYID: 9, UPDT: 1 });
  assert.ok(call(sC, 32, { DYID: 9 }).denied); assert.equal(store.dynasties[9].update.byUser, B);
  assert.match(call(sA, 32, { DYID: 9 }).note, /lock cleared/); assert.equal(store.dynasties[9].update, null);
  assert.ok(call(sB, 12, { DYID: 9, TABL: pack4('TEAM') }).denied, 'the old holder has to start again');

  // the holder's connection ends
  call(sB, 56, { DYID: 9, UPDT: 1 });
  assert.equal(dod.releaseSessionLocks(sC), 0); assert.equal(store.dynasties[9].update.byUser, B, 'someone else disconnecting changes nothing');
  assert.equal(dod.releaseSessionLocks(sB), 1); assert.equal(store.dynasties[9].update, null);

  // the holder goes quiet: after the idle time anyone may start, and the sweep removes it without a request
  call(sB, 56, { DYID: 9, UPDT: 1 });
  assert.ok(call(sC, 56, { DYID: 9, UPDT: 1 }).denied);
  store.dynasties[9].update.lastAt -= auth.lockIdleSeconds() + 5;
  assert.ok(!call(sC, 56, { DYID: 9, UPDT: 1 }).denied); assert.equal(store.dynasties[9].update.byUser, C);
  store.dynasties[9].update.lastAt -= auth.lockIdleSeconds() + 5;
  assert.equal(dod.expireUpdateLocks(), 1); assert.equal(store.dynasties[9].update, null);
  // using the lock keeps it alive
  call(sB, 56, { DYID: 9, UPDT: 1 }); store.dynasties[9].update.lastAt -= auth.lockIdleSeconds() - 20;
  assert.ok(!call(sB, 12, { DYID: 9, TABL: pack4('TEAM') }).denied); assert.ok(store.dynasties[9].update.lastAt >= Math.floor(Date.now() / 1000) - 2);
  call(sB, 57, { DYID: 9, UPDT: 1, TMID: 2 });
  assert.ok(logged.some((l) => /DID 9: update lock of user 800002 cleared \(BreakLock by user 800001\)/.test(l)));
});

test('removing the lock holder frees the dynasty, and removal sticks until the commissioner invites them back', () => {
  call(sB, 56, { DYID: 9, UPDT: 1 });
  assert.ok(call(sC, 14, { DID: 9, BZID: B }).denied, 'a member cannot remove another member');
  assert.ok(!call(sA, 14, { DID: 9, BZID: B }).denied);
  assert.deepEqual(members(9), [A, C]); assert.equal(store.dynasties[9].update, null, 'their unfinished update went with them');
  assert.ok(store.dynasties[9].removed.some((r) => r.blazeId === B));
  assert.ok(call(sB, 6, { DID: 9 }).denied, 'a public dynasty, but the removed member cannot walk back in');
  assert.ok(call(session(B, 'Bravo'), 6, { DID: 9 }).denied, 'not with a new connection either');
  assert.deepEqual(members(9), [A, C]);
  assert.ok(call(sC, 8, { DID: 9, INVT: 'Bravo' }).denied, 'only the commissioner re-admits');
  assert.ok(!call(sA, 8, { DID: 9, INVT: 'bravo' }).denied);
  assert.ok(!call(sB, 6, { DID: 9 }).denied); assert.deepEqual(members(9), [A, C, B]);
  // leaving by yourself is not a removal: you may come back
  assert.ok(!call(sC, 14, { DID: 9 }).denied); assert.ok(!call(sC, 6, { DID: 9 }).denied); assert.deepEqual(members(9), [A, B, C]);
});

test('createDynasty keeps only known fields, capped; the creator is counted even after leaving', () => {
  const before = dod.dynastiesCreatedBy(A);
  const did = create(sA, { NAME: 'N'.repeat(500), DESC: 'D'.repeat(5000), ABBR: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', QTR: 5, EVIL: 'x'.repeat(100000), __proto__x: 1, CALG: { $map: 'int->int', entries: [[1, 2]] }, NESTED: { A: { B: 1 } } });
  const r = store.dynasties[did].request;
  assert.deepEqual(Object.keys(r).sort(), ['ABBR', 'DESC', 'MHUM', 'NAME', 'QTR']);
  assert.equal(r.NAME.length, 64); assert.equal(r.DESC.length, 128); assert.equal(r.ABBR.length, 16); assert.equal(r.QTR, 5);
  assert.ok(JSON.stringify(store.dynasties[did]).length < 2000, 'nothing large is stored');
  assert.equal(store.dynasties[did].createdBy, A); assert.equal(dod.dynastiesCreatedBy(A), before + 1);

  // the commissioner leaves while others remain: the longest-standing member takes over, and the slot is not freed
  call(sB, 6, { DID: did }); call(sC, 6, { DID: did });
  assert.equal(call(sA, 14, { DID: did }).body.DEST, 0);
  assert.deepEqual(members(did), [B, C]);
  assert.deepEqual(store.dynasties[did].members.map((m) => !!m.commissioner), [true, false]);
  assert.equal(dod.dynastiesCreatedBy(A), before + 1, 'create, hand over, leave does not reset the limit');
  assert.equal(call(sC, 5, { DID: did }).body.CMSH.BZID, B, 'the dynasty names its new commissioner');
  assert.ok(!call(sB, 14, { DID: did, BZID: C }).denied, 'who has the commissioner\'s rights');
  // the last member leaves: the dynasty is deleted, not left behind public with no owner
  const last = call(sB, 14, { DID: did });
  assert.equal(last.body.DEST, 1); assert.equal(store.dynasties[did], undefined);
  assert.equal(dod.dynastiesCreatedBy(A), before);
  assert.ok(!names(call(sD, 22, { NAME: '' })).includes(r.NAME));
  assert.doesNotThrow(() => call(sD, 22, { NAME: '' }));
  // on a local PC (no storage limits) the deleted record is kept beside the data, so a mistake can be undone by hand
  assert.equal(JSON.parse(fs.readFileSync(path.join(PRIVATE, 'deleted-dynasties', `${did}.json`), 'utf8')).dynasty.id, did);
  assert.ok(logged.some((l) => new RegExp(`DID ${did} deleted \\(its last member`).test(l)));
});

test('joinDynasty enforces the dynasty\'s maximum number of humans', () => {
  const did = create(sA, { MHUM: 2 });
  assert.ok(!call(sB, 6, { DID: did }).denied);
  assert.ok(call(sC, 6, { DID: did }).denied, 'full');
  assert.deepEqual(members(did), [A, B]);
  assert.ok(!call(sB, 6, { DID: did }).denied, 'a member already in is not counted against the limit');
  call(sB, 14, { DID: did }); assert.ok(!call(sC, 6, { DID: did }).denied, 'a place opened');
  assert.equal(auth.maxHumans({ request: { MHUM: 0 } }), 12); assert.equal(auth.maxHumans({ request: { MHUM: 99 } }), 12); assert.equal(auth.maxHumans({ request: {} }), 12);
});

test('a dynasty with a password gives its status and files only to members and to someone who gave the password', () => {
  const did = create(sA, { NAME: 'Vault', PASS: 'secret' });
  store.dynasties[did].fileId = 77;
  assert.equal(store.dynasties[did].request.PASS, '', 'only a hash is stored');
  const listed = (s) => call(s, 22, { NAME: 'Vault' }).body.DLST.items.find((x) => Number(x.DID) === did);
  assert.equal(Number(listed(sA).FID), 77);
  assert.equal(Number(listed(sC).FID), 0, 'the search listing has no file id for an outsider');
  for (const [command, body] of [[5, { DID: did }], [58, { DYID: did, TMID: 1023 }], [23, { DYNI: did, TABL: pack4('TEAM') }], [107, { DYID: did }], [26, { DYID: did }]]) assert.ok(call(sC, command, body).denied, `command ${command} before the password`);
  const file = { cid: 1, owner: A, group: { id: did } };
  assert.equal(auth.canReadSharedContent(file, sC, store.dynasties), false, 'no file download either');
  assert.equal(call(sC, 100, { DYID: did, PENT: 'wrong' }).error, 0x4000);
  assert.ok(call(sC, 5, { DID: did }).denied);
  assert.match(call(sC, 100, { DYID: did, PENT: 'secret' }).note, /password accepted/);
  assert.equal(Number(call(sC, 5, { DID: did }).body.FID), 77); assert.equal(Number(listed(sC).FID), 77);
  assert.ok(!call(sC, 58, { DYID: did, TMID: 1023 }).denied);
  assert.equal(auth.canReadSharedContent(file, sC, store.dynasties), true);
  assert.ok(call(session(C, 'Charl'), 5, { DID: did }).denied, 'the password counts for the connection that gave it');
  assert.ok(!logged.some((l) => l.includes('secret')), 'a password is never logged');
  // a public dynasty without a password can still be previewed before joining, as before
  const open = create(sA, { NAME: 'Open' });
  assert.ok(!call(sC, 5, { DID: open }).denied); assert.ok(!call(sC, 58, { DYID: open, TMID: 1023 }).denied);
});

test('roster push: a member names rows of their own team only; the commissioner any team', () => {
  const d = store.dynasties[9];
  d.members.find((m) => m.blazeId === B).team = 2; d.rosterPush = {};
  const rows = (pairs) => ({ DYID: 9, TABL: pack4('PLYZ'), INTC: { items: [pack4('TGID'), pack4('PGID')] }, ROWS: { items: pairs.map(([t, p]) => ({ INTV: { items: [t, p] } })) } });
  call(sB, 56, { DYID: 9, UPDT: 1 });
  assert.ok(!call(sB, 12, rows([[1, 111], [2, 222], [2, 223], [5, 555]])).denied);
  assert.deepEqual(Object.keys(d.rosterPush), ['2'], 'nothing for the commissioner\'s team 1 or anyone else\'s');
  assert.deepEqual(d.rosterPush[2].pgids, [222, 223]);
  call(sB, 57, { DYID: 9, UPDT: 1, TMID: 2 });
  call(sA, 56, { DYID: 9, UPDT: 1 });
  call(sA, 12, rows([[1, 111], [2, 224]]));
  assert.deepEqual(d.rosterPush[1].pgids, [111]); assert.ok(d.rosterPush[2].pgids.includes(224), 'the commissioner names rows of any team');
  call(sA, 57, { DYID: 9, UPDT: 1, TMID: 1 });
});

test('team package: a small upload that unpacks to megabytes is refused with a clear line, not unpacked', async () => {
  const { completeTeamPackage, inflateCapped, PackageTooLarge, TEAM_PACKAGE_MAX_BYTES } = await import('./team-package.mjs');
  const bomb = zlib.deflateSync(Buffer.alloc(64 * 1024 * 1024), { level: 9 });
  assert.ok(bomb.length < 100 * 1024, `the packed file is small (${bomb.length} bytes)`);
  assert.throws(() => completeTeamPackage(bomb, bomb, 1), PackageTooLarge);
  assert.throws(() => inflateCapped(bomb, TEAM_PACKAGE_MAX_BYTES, 'x'), /unpacks to more than 1048576 bytes/);
  assert.equal(inflateCapped(zlib.deflateSync(Buffer.alloc(50000, 1)), TEAM_PACKAGE_MAX_BYTES, 'x').length, 50000, 'a real-size package still unpacks');
  const { readDynastyFile } = await import('./tdb-read.mjs');
  const big = path.join(DIR, 'big.bin'); fs.writeFileSync(big, zlib.deflateSync(Buffer.alloc(80 * 1024 * 1024)));
  assert.throws(() => readDynastyFile(big), /unpacks to more than 67108864 bytes/);

  // through the server: EndDynastyUpdate naming that file as the member's team package
  const d = store.dynasties[9], m = d.members.find((x) => x.blazeId === B);
  const dynFile = Number(lockerCall(sA, 1, { NAME: 'DYNASTY.dynasty', CCAT: 'LeagueStorage' }).body.INFO.CID);
  const pkg = Number(lockerCall(sB, 1, { NAME: 'Bravo;2;0;0;0.team', CCAT: 'LeagueStorage' }).body.INFO.CID);
  fs.writeFileSync(path.join(PRIVATE, 'locker', `${dynFile}.bin`), zlib.deflateSync(Buffer.alloc(1000)));
  fs.writeFileSync(path.join(PRIVATE, 'locker', `${pkg}.bin`), bomb);
  d.fileId = d.consoleFileId = dynFile; m.teamFileId = 0;
  const before = process.memoryUsage().rss;
  assert.ok(!call(sB, 57, { DYID: 9, UPDT: 1, TMID: 2, FID: pkg }).denied);
  assert.equal(m.teamFileId, 0, 'the oversized file does not become the team package');
  assert.ok(logged.some((l) => new RegExp(`REFUSED \\(oversized upload\\): DID 9: file ${pkg} sent as the team package of team 2: the team package unpacks to more than 1048576 bytes`).test(l)));
  assert.ok(process.memoryUsage().rss - before < 48 * 1024 * 1024, 'and 64 MB was never allocated for it');
});

test('Locker: the permission check and the action use the same file id', () => {
  locker.configureLockerAuth({ dynasties: store.dynasties, isActive: () => true });
  try {
    const mine = Number(lockerCall(sC, 1, { NAME: 'c.team', CCAT: 'LeagueStorage' }).body.INFO.CID);
    const theirs = Number(lockerCall(sD, 1, { NAME: 'd.team', CCAT: 'LeagueStorage' }).body.INFO.CID);
    // confirmUpload used to check CID (mine) and then act on INFO.CID (theirs)
    assert.equal(lockerCall(sC, 3, { CID: mine, INFO: { CID: theirs }, STST: 1 }).error, 0x4000);
    assert.equal(locker.getContent(theirs).confirmed, false); assert.equal(locker.getContent(theirs).status, 0);
    assert.equal(locker.getContent(mine).confirmed, false, 'and CID alone names nothing for confirmUpload');
    assert.equal(Number(lockerCall(sC, 3, { INFO: { CID: mine }, STST: 1 }).body.INFO.CID), mine); assert.equal(locker.getContent(mine).confirmed, true);
    // the other commands: one id each, the same for the check and the action, whatever else the request carries
    assert.equal(lockerCall(sC, 4, { CID: theirs, INFO: { CID: mine }, NAME: 'stolen' }).error, 0x4000); assert.equal(locker.getContent(theirs).name, 'd.team');
    assert.equal(lockerCall(sC, 14, { CID: theirs, INFO: { CID: mine }, GPID: { component: 2148, type: 1, id: 9 } }).error, 0x4000); assert.equal(locker.getContent(theirs).group, undefined);
    assert.equal(lockerCall(sC, 5, { CID: mine, CIDS: { items: [mine, theirs] } }).error, 0x4000); assert.ok(locker.getContent(theirs) && locker.getContent(mine), 'nothing deleted when one id is not yours');
    for (const odd of ['5', -1, 0, 1.5, 2 ** 60, { id: theirs }, null]) assert.equal(lockerCall(sC, 4, { CID: odd, NAME: 'x' }).error === undefined && lockerCall(sC, 4, { CID: odd, NAME: 'x' }).body !== undefined, false, `id ${JSON.stringify(odd)} names no file`);
    // a member cannot turn a file of theirs that is tied to a dynasty into that dynasty's file by renaming it
    assert.ok(!lockerCall(sC, 14, { CID: mine, GPID: { component: 2148, type: 1, id: 9 } }).error);
    assert.equal(lockerCall(sC, 4, { CID: mine, NAME: 'DYNASTY.dynasty' }).error, 0x4000); assert.equal(locker.getContent(mine).name, 'c.team');
  } finally { locker.configureLockerAuth(null); }
});

test('Locker: deleted files count toward the quota; uploads go to disk as they arrive, one at a time per file', async () => {
  const quota = { maxUploadBytes: 200000, lockerQuotaBytes: 5000, lockerMaxItems: 6 };
  locker.configureLockerLimits(quota);
  locker.configureLockerAuth({ dynasties: store.dynasties, isActive: () => true });
  const server = locker.startLockerHttp({ port: 0, bind: '127.0.0.1' });
  await once(server, 'listening');
  const dir = path.join(PRIVATE, 'locker');
  const mine = []; // every file id player D ever made
  const onDisk = () => mine.reduce((n, cid) => n + [path.join(dir, `${cid}.bin`), path.join(dir, 'trash', `${cid}.bin`)].reduce((a, f) => a + (fs.existsSync(f) ? fs.statSync(f).size : 0), 0), 0);
  const make = (name = 'x.team') => { const r = lockerCall(sD, 1, { NAME: name, CCAT: 'LeagueStorage' }); if (r.error) return r; mine.push(Number(r.body.INFO.CID)); return { cid: Number(r.body.INFO.CID), url: r.body.INFO.UURL }; };
  const put = (url, bytes) => fetch(url, { method: 'POST', body: Buffer.alloc(bytes, 7) }).then((r) => r.status);
  const temps = () => fs.readdirSync(dir).filter((f) => f.endsWith('.upload.tmp'));
  try {
    // upload, delete, repeat: what the player holds on disk (live + deleted) never passes the quota
    for (let i = 0; i < 12; i++) {
      const f = make(); assert.ok(f.cid, `create ${i}`);
      assert.equal(await put(f.url, 3000), 200); lockerCall(sD, 3, { INFO: { CID: f.cid } });
      assert.ok(onDisk() <= quota.lockerQuotaBytes, `after upload ${i}: ${onDisk()} bytes`);
      assert.ok(!lockerCall(sD, 5, { CIDS: { items: [f.cid] } }).error);
      assert.ok(onDisk() <= quota.lockerQuotaBytes, `after delete ${i}: ${onDisk()} bytes`);
    }
    assert.ok(fs.existsSync(path.join(dir, 'trash', `${mine.at(-1)}.bin`)), 'the newest deleted file is still recoverable');
    assert.ok(logged.some((l) => /trash of user 800004: \d+ oldest deleted file\(s\) removed/.test(l)));
    // a live file over the quota is still refused, and a refused upload leaves nothing behind
    const big = make(); assert.equal(await put(big.url, 6000), 413); assert.equal(locker.getContent(big.cid).size, 0);
    assert.deepEqual(temps(), []);
    // the item limit counts deleted files too, and they make way for new ones
    for (let i = 0; i < 4; i++) assert.ok(make().cid);
    assert.equal(make().error, 9, 'six live files: the limit');

    // streamed: while an upload is still arriving its bytes are already in a temp file, and a second upload through
    // the same link is refused instead of being held in memory beside it
    const f = { cid: big.cid, url: new URL(big.url) };
    const first = http.request({ host: f.url.hostname, port: f.url.port, path: f.url.pathname + f.url.search, method: 'POST', headers: { 'transfer-encoding': 'chunked' } });
    const firstDone = new Promise((resolve, reject) => { first.on('response', (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); first.on('error', reject); });
    first.write(Buffer.alloc(1500, 1));
    await until(() => temps().length === 1 && fs.statSync(path.join(dir, temps()[0])).size === 1500, { what: 'the first half of the upload on disk' });
    assert.equal(fs.existsSync(path.join(dir, `${f.cid}.bin`)), false, 'not visible as the file until it is complete');
    assert.equal(await put(big.url, 100), 409);
    first.end(Buffer.alloc(500, 2));
    assert.equal(await firstDone, 200);
    assert.equal(fs.statSync(path.join(dir, `${f.cid}.bin`)).size, 2000); assert.deepEqual(temps(), []);
    assert.equal(locker.getContent(f.cid).size, 2000);
    assert.equal(await put(big.url, 1000), 200, 'the link works again once the first upload is done');
    // no declared length: stopped when it passes the limit, without reading the rest
    const endless = http.request({ host: f.url.hostname, port: f.url.port, path: f.url.pathname + f.url.search, method: 'POST', headers: { 'transfer-encoding': 'chunked' } });
    const endlessDone = new Promise((resolve) => { endless.on('response', (res) => { res.resume(); resolve(res.statusCode); }); endless.on('error', () => resolve('closed')); });
    for (let i = 0; i < 40 && !endless.destroyed; i++) { endless.write(Buffer.alloc(1000, 3)); await sleep(5); }
    assert.equal(await endlessDone, 413); endless.destroy();
    await until(() => temps().length === 0, { what: 'the temp file of the refused upload to be removed' });
    assert.equal(locker.getContent(f.cid).size, 1000, 'the stored file is untouched by the refused upload');
    assert.ok(onDisk() <= quota.lockerQuotaBytes);
  } finally { server.closeAllConnections?.(); server.close(); locker.configureLockerAuth(null); locker.configureLockerLimits(null); }
});

test('Dynasty Wire: an upload counts for a dynasty only when its uploader is a member; attributes are capped', async () => {
  const { RegistryStore } = await import('./registry-sync.mjs');
  const easw = await import('./easw.mjs');
  const { dynastyOf } = await import('./wire.mjs');
  const reg = new RegistryStore();
  reg.set({ version: 1, players: [player(A, 'CoachAlpha', 1), player(B, 'CoachBravo', 2), player(C, 'CoachCharl', 3)] });
  const dynasties = { 5: { id: 5, fileId: 1, members: [{ blazeId: A }, { blazeId: B }] }, 6: { id: 6, fileId: 1, members: [{ blazeId: C }] } };
  easw.configureEaswAuth({ authenticate: (t) => reg.authenticate(t), isActive: (t) => reg.isActive(t), dynasties, canSee: (d, uid) => d.members.some((m) => m.blazeId === uid), limits: { lockerQuotaBytes: 100000 } });
  const server = easw.startEaswHttp({ port: 0, bind: '127.0.0.1', hardened: true, limits: { maxUploadBytes: 2 * 1024 * 1024 } });
  await once(server, 'listening'); const base = `http://127.0.0.1:${server.address().port}`;
  const signIn = async (n) => (await fetch(`${base}/easw/authenticationPS3?version=v2`, { method: 'POST', body: ticket(n) })).headers.get('easw-token');
  const call = (token, method, p, body, headers = {}) => fetch(base + p, { method, body, headers: { 'easw-token': token, ...headers } });
  const xml = (attrs, name = 'Story') => `<create_media type="MEDIA_CONTAINER" slot="1"><name>${name}</name><description>d</description><attributes>${Object.entries(attrs).map(([k, v]) => `<attribute key="${k}" value="${v}"/>`).join('')}</attributes></create_media>`;
  const upload = (token, attrs) => { const b = 'XxBxX'; const body = Buffer.concat([['xml', xml(attrs)], ['container', 'bytes']].flatMap(([n, d]) => [Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n`), Buffer.from(d), Buffer.from('\r\n')]).concat(Buffer.from(`--${b}--\r\n`))); return call(token, 'POST', '/easw/personas/1/sku/NCA14PS3/media', body, { 'content-type': `multipart/form-data; boundary=${b}` }); };
  const idOf = async (res) => Number(/<media_metadata id="(\d+)"/.exec(await res.text())[1]);
  const wire = async (token, group) => await (await call(token, 'GET', `/easw/media_content;full?attributes=CONTAINER_GROUP%23${group}`)).text();
  try {
    const ta = await signIn(1), tb = await signIn(2), tc = await signIn(3);
    // C is not in dynasty 5: an upload naming it is refused, at creation and as a later change
    assert.equal((await upload(tc, { CONTAINER_GROUP: 5 })).status, 403);
    const loose = await idOf(await upload(tc, { CAPTION: 'mine' }));
    assert.equal((await call(tc, 'POST', `/easw/media/${loose};full?http-type=PUT`, xml({ CONTAINER_GROUP: 5 }))).status, 403);
    assert.equal(easw.getMedia(loose).attributes.CONTAINER_GROUP, undefined);
    // an item stored before this check existed (or written into the index) is not shown to the dynasty's members
    const planted = easw.addMedia({ type: 'MEDIA_CONTAINER', name: 'Planted', attributes: { CONTAINER_GROUP: '5' }, ownerId: C, owner: 'CoachCharl', origin: 'console' });
    assert.match(await wire(tb, 5), /count="0"/);
    assert.equal((await call(tb, 'GET', `/easw/media/${planted.id};full`)).status, 404);
    // a member's upload is, and the site's own stories still are
    const real = await idOf(await upload(ta, { CONTAINER_GROUP: 5 }));
    easw.addMedia({ type: 'MEDIA_CONTAINER', name: 'FromSite', attributes: { CONTAINER_GROUP: '5' }, ownerId: 12345, owner: 'Web', origin: 'site' });
    const seen = await wire(tb, 5);
    assert.match(seen, /count="2"/); assert.match(seen, new RegExp(`id="${real}"`)); assert.ok(!seen.includes('Planted'));
    assert.match(await wire(tc, 5), /count="0"/, 'someone outside the dynasty sees none of it');
    // the site sync applies the same rule before it sends anything to the site
    assert.equal(dynastyOf({ dynasties }, planted), null);
    assert.equal(dynastyOf({ dynasties }, easw.getMedia(real)).id, 5);
    assert.equal(dynastyOf({ dynasties }, easw.getMedia(loose)).id, 6, 'an item naming no dynasty goes to its uploader\'s own');

    // attributes: more than any real item has is refused; long values are cut; and they count toward storage
    const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`K${i}`, 'v']));
    assert.equal((await upload(ta, many)).status, 400);
    assert.equal((await upload(ta, Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`K${i}`, 'v'])))).status, 200);
    const long = await idOf(await upload(ta, { CAPTION: 'c'.repeat(5000), ['K'.repeat(300)]: 'v' }));
    assert.equal(easw.getMedia(long).attributes.CAPTION.length, 512); assert.ok(Object.keys(easw.getMedia(long).attributes).every((k) => k.length <= 64));
    // merging attributes onto an item cannot grow it past the cap either
    assert.equal((await call(ta, 'POST', `/easw/media/${long};full?http-type=PUT`, xml(many))).status, 400);
    // attribute text is part of what a player stores: items of nothing but attributes still reach the quota
    let status = 200, n = 0;
    const fat = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`A${i}`, 'x'.repeat(500)]));
    while (status === 200 && n < 20) { status = (await upload(tb, fat)).status; n++; }
    assert.equal(status, 413, `the quota stopped attribute-only uploads after ${n}`); assert.ok(n > 1 && n < 10);
  } finally { server.closeAllConnections?.(); server.close(); easw.configureEaswAuth(null); }
});
