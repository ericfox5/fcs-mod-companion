import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RegistryStore, syncOnce, startRegistrySync, normalizeRegistry, writeAtomic } from './registry-sync.mjs';
import { tmpDir, fakeSite, freePort, ticket, player, until, sleep } from './testkit.mjs';

const TOKEN = 'test-bridge-token-not-a-real-one';
const reg = (...players) => ({ version: 1, generatedAt: new Date().toISOString(), players });
const A = () => player(800001, 'CoachAlpha', 1), B = () => player(800002, 'CoachBravo', 2);
const endpoint = (site) => `${site.url}/api/bridge/league-registry`;

test('sync success: validates, writes the cache atomically, authenticates from memory', async () => {
  const dir = tmpDir('regsync'), file = path.join(dir, 'league-registry.json');
  const site = await fakeSite(TOKEN, reg(A(), B()));
  try {
    const store = new RegistryStore({ file });
    const r = await syncOnce({ url: endpoint(site), token: TOKEN, store, file });
    assert.equal(r.status, 'updated'); assert.equal(r.players, 2);
    assert.equal(site.state.lastAuth, `Bearer ${TOKEN}`); // the bridge scheme: Authorization: Bearer <token>
    assert.equal(store.authenticate(ticket(1)).userId, 800001);
    assert.equal(store.authenticate(ticket(2)).onlineId, 'CoachBravo');
    assert.throws(() => store.authenticate(ticket(3)));
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(cached.version, 1); assert.equal(cached.players.length, 2);
    assert.deepEqual(fs.readdirSync(dir), ['league-registry.json']); // no temp file left behind
    // ETag: the next pull sends If-None-Match and the site answers 304
    const again = await syncOnce({ url: endpoint(site), token: TOKEN, store, file, etag: r.etag });
    assert.equal(again.status, 'unchanged'); assert.equal(site.state.etagHits, 1);
  } finally { await site.close(); }
});

test('unknown fields are dropped and only the strict shape is kept', () => {
  const out = normalizeRegistry({ version: 1, generatedAt: 'x', extra: 1, players: [{ ...A(), isAdmin: true, disabled: undefined }] }, { minUserId: 800000 });
  assert.deepEqual(Object.keys(out.players[0]).sort(), ['disabled', 'joinDynasties', 'onlineId', 'ticketSha256', 'userId']);
  assert.equal(out.players[0].disabled, false);
});

test('unreachable site: the last good registry keeps serving and the cache is untouched', async () => {
  const dir = tmpDir('regsync'), file = path.join(dir, 'league-registry.json');
  const site = await fakeSite(TOKEN, reg(A()));
  const store = new RegistryStore({ file });
  assert.equal((await syncOnce({ url: endpoint(site), token: TOKEN, store, file })).status, 'updated');
  const before = fs.readFileSync(file, 'utf8');
  await site.close();
  const r = await syncOnce({ url: endpoint(site), token: TOKEN, store, file, timeoutMs: 2000 });
  assert.equal(r.status, 'error'); assert.match(r.error, /unreachable/);
  assert.ok(!JSON.stringify(r).includes(TOKEN)); // the token never appears in a result or message
  assert.equal(store.authenticate(ticket(1)).userId, 800001);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  // a site that hangs is cut off by the timeout
  const keepAlive = setInterval(() => {}, 50); // the timeout's own timer does not keep the process alive; a real request does
  const slow = await syncOnce({ url: 'http://127.0.0.1:1/', token: TOKEN, store, file, timeoutMs: 300, fetchImpl: (_u, o) => new Promise((_res, rej) => o.signal.addEventListener('abort', () => rej(o.signal.reason))) });
  clearInterval(keepAlive);
  assert.equal(slow.status, 'error'); assert.match(slow.error, /timed out/);
  assert.equal(store.current().players.length, 1);
});

test('bad payloads and error statuses never replace the last good registry', async () => {
  const dir = tmpDir('regsync'), file = path.join(dir, 'league-registry.json');
  const site = await fakeSite(TOKEN, reg(A()));
  try {
    const store = new RegistryStore({ file });
    await syncOnce({ url: endpoint(site), token: TOKEN, store, file });
    const before = fs.readFileSync(file, 'utf8');
    const bad = [
      '{"version":1,"players":[{"userId":',                                   // truncated JSON
      'null', '[]', '"ok"',
      { version: 2, players: [A()] },                                            // wrong version
      { version: 1 },                                                            // no players
      { version: 1, players: 'all' },
      reg(A(), { ...B(), userId: 800001 }),                                      // duplicate id
      reg(A(), { ...B(), ticketSha256: A().ticketSha256 }),                      // duplicate credential
      reg({ ...A(), userId: 700001 }),                                           // below the site id range: an operator's id
      reg({ ...A(), userId: 1000 }),
      reg({ ...A(), userId: '800001' }),
      reg({ ...A(), ticketSha256: 'ABC' }),
      reg({ ...A(), ticketSha256: A().ticketSha256.toUpperCase() }),
      reg({ ...A(), onlineId: 'x' }), reg({ ...A(), onlineId: 'has space' }), reg({ ...A(), onlineId: 5 }),
      reg({ ...A(), disabled: 'false' }), reg({ ...A(), disabled: 0 }),          // disabled must be a real boolean
      reg({ ...A(), joinDynasties: 'all' }), reg({ ...A(), joinDynasties: [0] }), reg({ ...A(), joinDynasties: undefined }),
      reg(null), reg([A()]),
    ];
    for (const payload of bad) {
      site.state.registry = payload;
      const r = await syncOnce({ url: endpoint(site), token: TOKEN, store, file });
      assert.equal(r.status, 'error', `accepted ${JSON.stringify(payload).slice(0, 80)}`);
      assert.equal(store.authenticate(ticket(1)).userId, 800001);
      assert.equal(fs.readFileSync(file, 'utf8'), before);
    }
    site.state.mode = 'error';
    assert.match((await syncOnce({ url: endpoint(site), token: TOKEN, store, file })).error, /500/);
    site.state.mode = 'ok'; site.state.registry = reg(A());
    assert.match((await syncOnce({ url: endpoint(site), token: 'wrong-token', store, file })).error, /401/);
    // too large a response is refused before it is parsed
    site.state.registry = reg(A(), B());
    assert.match((await syncOnce({ url: endpoint(site), token: TOKEN, store, file, maxBytes: 64 })).error, /too large/);
    assert.equal(store.current().players.length, 1);
  } finally { await site.close(); }
});

test('revocation: a disabled or removed player is out after one sync, and the store announces it', async () => {
  const dir = tmpDir('regsync'), file = path.join(dir, 'league-registry.json');
  const site = await fakeSite(TOKEN, reg(A(), B()));
  try {
    const store = new RegistryStore({ file }); let updates = 0; store.on('update', () => updates++);
    await syncOnce({ url: endpoint(site), token: TOKEN, store, file });
    const sessionA = store.authenticate(ticket(1)), sessionB = store.authenticate(ticket(2));
    assert.ok(store.isActive(sessionA) && store.isActive(sessionB));
    site.state.registry = reg({ ...A(), disabled: true }, B());
    assert.equal((await syncOnce({ url: endpoint(site), token: TOKEN, store, file })).status, 'updated');
    assert.equal(updates, 2);
    assert.ok(!store.isActive(sessionA)); assert.ok(store.isActive(sessionB));
    assert.throws(() => store.authenticate(ticket(1)), /revoked/);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).players[0].disabled, true); // and it survives a restart
    // a re-issued credential ends the old session; a removed player is gone
    site.state.registry = reg(player(800002, 'CoachBravo', 9));
    await syncOnce({ url: endpoint(site), token: TOKEN, store, file });
    assert.ok(!store.isActive(sessionB)); assert.equal(store.find(800001), null);
    assert.throws(() => store.authenticate(ticket(2)));
    // an empty list from the site locks everyone out (fail closed), it does not keep the old list
    site.state.registry = reg();
    await syncOnce({ url: endpoint(site), token: TOKEN, store, file });
    assert.equal(store.current().players.length, 0);
  } finally { await site.close(); }
});

test('startRegistrySync: cache first, then the site; nothing cached and no site means nobody gets in', async () => {
  const dir = tmpDir('regsync'), file = path.join(dir, 'league-registry.json');
  const dead = `http://127.0.0.1:${await freePort()}/api/bridge/league-registry`;
  const logs = [];
  // no cache, site down: empty registry (deny all), never an exception
  const empty = new RegistryStore({ file });
  const s1 = startRegistrySync({ url: dead, token: TOKEN, store: empty, file, intervalMs: 60000, timeoutMs: 1000, log: (m) => logs.push(m) });
  assert.equal((await s1.ready).status, 'error'); s1.stop();
  assert.throws(() => empty.authenticate(ticket(1)));
  assert.ok(!fs.existsSync(file));
  assert.ok(logs.some((m) => /nobody can log in/.test(m)) && logs.some((m) => /sync failed/.test(m)));
  assert.ok(!logs.join('\n').includes(TOKEN));
  // a cache from an earlier run, site down: the cached players still get in
  writeAtomic(file, JSON.stringify(reg(A())));
  const cached = new RegistryStore({ file });
  const s2 = startRegistrySync({ url: dead, token: TOKEN, store: cached, file, intervalMs: 60000, timeoutMs: 1000 });
  await s2.ready; s2.stop();
  assert.equal(cached.authenticate(ticket(1)).userId, 800001);
  // a corrupt cache is ignored (empty), and the periodic pull repairs it once the site answers
  fs.writeFileSync(file, '{ not json');
  const site = await fakeSite(TOKEN, reg(A(), B()));
  try {
    const store = new RegistryStore({ file });
    const s3 = startRegistrySync({ url: endpoint(site), token: TOKEN, store, file, intervalMs: 100 });
    await s3.ready;
    assert.equal(store.current().players.length, 2);
    site.state.registry = reg(A(), { ...B(), disabled: true });
    await until(() => store.find(800002)?.disabled === true, { what: 'periodic sync to pick up the revocation' });
    s3.stop();
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).players.length, 2);
  } finally { await site.close(); }
});

test('a static registry file is re-read when edited and fails closed when broken', async () => {
  const dir = tmpDir('regsync'), file = path.join(dir, 'registry.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, players: [player(101, 'LocalOne', 1)] }));
  const store = new RegistryStore({ file, watch: true });
  assert.ok(store.loadFile());
  const session = store.authenticate(ticket(1));
  await sleep(20);
  fs.writeFileSync(file, JSON.stringify({ version: 1, players: [player(101, 'LocalOne', 1, { disabled: true }), player(202, 'LocalTwo', 2)] }));
  assert.ok(!store.isActive(session));
  assert.equal(store.authenticate(ticket(2)).userId, 202);
  await sleep(20);
  fs.writeFileSync(file, '{"version":1,"players":[{'); // a broken edit must not keep anyone in
  assert.equal(store.current().players.length, 0);
  assert.throws(() => store.authenticate(ticket(2)));
  await sleep(20);
  fs.rmSync(file);
  assert.equal(store.current().players.length, 0);
});
