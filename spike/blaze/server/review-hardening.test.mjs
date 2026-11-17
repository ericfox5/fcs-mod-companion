// Robustness fixes from the code review, network side: packet framing and decoding before and after sign-in, strict
// on/off settings and the listen address, the registry token and its age, the rate limiter, log limits, and the
// deployment files. Real processes use OS-picked loopback ports, a fake site and temp folders: never the live league.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { cloudSettings, parseSwitch, bindSettings, registrySite, limits, ConfigError } from './cloud-config.mjs';
import { PacketStream, PacketTooLarge, encodePacket, MSG } from './packet.mjs';
import { decode, Writer, T, encodeTag } from './tdf.mjs';
import { createRateLimiter, createLogLimiter } from './net-guard.mjs';
import { RegistryStore, startRegistrySync } from './registry-sync.mjs';
import { tmpDir, freePort, serverEnv, startServer, blazeClient, fakeSite, ticket, player, until, sleep, HERE } from './testkit.mjs';

const REGISTRY_TOKEN = 'test-registry-token-read-only';
const reg = (...players) => ({ version: 1, generatedAt: new Date().toISOString(), players });
const ERR = MSG.ERROR, OK = MSG.RESPONSE;
const DEPLOY = path.join(HERE, '..', '..', '..', 'deploy', 'league-server');
const closedWithin = (c, ms = 4000) => Promise.race([c.closed, sleep(ms).then(() => false)]);
// a 12- or 14-byte header announcing `len` payload bytes, with no payload behind it
function header(component, command, len, id = 1) {
  const ext = len > 0xffff, h = Buffer.alloc(ext ? 14 : 12);
  h.writeUInt16BE(len & 0xffff, 0); h.writeUInt16BE(component, 2); h.writeUInt16BE(command, 4); h.writeUInt16BE(ext ? 0x10 : 0, 8); h.writeUInt16BE(id, 10);
  if (ext) h.writeUInt16BE(len >>> 16, 12);
  return h;
}

// ---------------------------------------------------------------------------------------------------------------
// item 1: packets and decoding
// ---------------------------------------------------------------------------------------------------------------
test('packet stream: a large packet in small pieces is joined once, not copied again on every piece', () => {
  const payload = Buffer.alloc(4 * 1024 * 1024); for (let i = 0; i < payload.length; i += 4099) payload[i] = i & 255;
  const wire = Buffer.concat([encodePacket({ component: 2148, command: 12, type: MSG.REQUEST, id: 7, payload }), encodePacket({ component: 9, command: 2, type: MSG.REQUEST, id: 8 })]);
  const realConcat = Buffer.concat; let copied = 0;
  Buffer.concat = (list, total) => { const out = realConcat(list, total); copied += out.length; return out; };
  const s = new PacketStream({ maxPacket: 8 * 1024 * 1024 }); const got = []; const t0 = performance.now();
  try { for (let i = 0; i < wire.length; i += 64) got.push(...s.feed(wire.subarray(i, i + 64))); } finally { Buffer.concat = realConcat; }
  const ms = performance.now() - t0;
  assert.equal(got.length, 2); assert.ok(got[0].payload.equals(payload)); assert.equal(got[0].id, 7); assert.equal(got[1].command, 2); assert.equal(s.buffered, 0);
  // 65,537 pieces: the old parser copied everything received so far on each one (about 137 GB in all)
  assert.ok(copied < 3 * payload.length, `bytes copied while reassembling: ${copied}`);
  assert.ok(ms < 3000, `took ${Math.round(ms)} ms`);
});

test('packet stream: headers split anywhere, several packets per chunk, and a limit asked per packet', () => {
  const a = encodePacket({ component: 1, command: 200, type: MSG.REQUEST, id: 1, payload: Buffer.alloc(100, 1) });
  const b = encodePacket({ component: 2148, command: 12, type: MSG.REQUEST, id: 2, payload: Buffer.alloc(70000, 2) }); // extended header
  const c = encodePacket({ component: 9, command: 2, type: MSG.REQUEST, id: 3 });
  const all = Buffer.concat([a, b, c]);
  for (const step of [1, 2, 5, 11, 13, 14, 4096, all.length]) {
    const s = new PacketStream(); const got = [];
    for (let i = 0; i < all.length; i += step) got.push(...s.feed(all.subarray(i, i + step)));
    assert.deepEqual(got.map((p) => [p.component, p.command, p.id, p.payload.length]), [[1, 200, 1, 100], [2148, 12, 2, 70000], [9, 2, 3, 0]], `step ${step}`);
    assert.ok(got[1].payload.every((x) => x === 2));
  }
  // the limit can depend on what an earlier packet in the same chunk did (sign-in, then something larger)
  let signedIn = false; const asked = [];
  const s = new PacketStream({ limitFor: (h) => { asked.push([h.component, h.command, h.len]); return signedIn ? 100000 : 4096; } });
  s.push(all);
  assert.equal(s.next().command, 200); signedIn = true;
  assert.equal(s.next().payload.length, 70000); assert.equal(s.next().id, 3); assert.equal(s.next(), null);
  assert.deepEqual(asked, [[1, 200, 100], [2148, 12, 70000], [9, 2, 0]], 'asked once per packet');
  // refused from the header alone: nothing of an oversized packet is kept, however it is announced
  const strict = new PacketStream({ limitFor: () => 4096 });
  strict.push(header(9, 7, 8192).subarray(0, 11)); assert.equal(strict.next(), null);
  strict.push(header(9, 7, 8192).subarray(11));
  assert.throws(() => strict.next(), (e) => e instanceof PacketTooLarge && e.limit === 4096 && e.head.command === 7 && /packet of 8192 bytes exceeds the 4096-byte limit/.test(e.message));
  assert.equal(strict.buffered, 0);
  const huge = new PacketStream({ limitFor: () => 4096 }); huge.push(header(9, 7, 0xfffffff0));
  assert.throws(() => huge.next(), PacketTooLarge);
});

test('TDF decoder: caps on list sizes and on values per message; short integers never touch BigInt', () => {
  const ints = (n) => { const w = new Writer(); w.intList('LIST', Array.from({ length: n }, (_, i) => i)); return w.bytes(); };
  assert.equal(decode(ints(256), { maxElements: 256, maxNodes: 1024 }).LIST.items.length, 256);
  assert.throws(() => decode(ints(257), { maxElements: 256, maxNodes: 1024 }), /a list of 257 items is over the limit of 256/);
  assert.throws(() => decode(ints(2000), { maxElements: 4096, maxNodes: 1000 }), /more than 1000 values in one message/);
  const map = new Writer(); map.intMap('MAP', Array.from({ length: 300 }, (_, i) => [i, i]));
  assert.throws(() => decode(map.bytes(), { maxElements: 256, maxNodes: 100000 }), /a list of 300 items is over the limit/);
  // nested lists multiply: many small lists inside a list are stopped by the total, whatever each one's size
  const nest = new Writer(); nest.list('ROWS', T.STRUCT, Array.from({ length: 200 }), (x) => { x.intList('INTV', Array.from({ length: 200 }, () => 1)); x.push(0); });
  assert.throws(() => decode(nest.bytes(), { maxElements: 4096, maxNodes: 20000 }), /more than 20000 values/);
  assert.equal(decode(nest.bytes()).ROWS.items.length, 200, 'the defaults (tests, the redirector) are generous');

  // integers: numbers up to 2^53 exactly as before, BigInt beyond; and no BigInt at all on the way for the usual ones
  const w = new Writer();
  const values = { A: 0, B: -1, C: 63, D: 64, E: 800001, F: -800001, G: 0x7fffffff, H: 2 ** 40, I: 2 ** 47 + 12345, J: -(2 ** 46) };
  for (const [k, v] of Object.entries(values)) w.int(k, v);
  const realBigInt = globalThis.BigInt; let bigCalls = 0;
  globalThis.BigInt = Object.assign(function (v) { bigCalls++; return realBigInt(v); }, { asUintN: realBigInt.asUintN, asIntN: realBigInt.asIntN });
  let body;
  try { body = decode(w.bytes()); } finally { globalThis.BigInt = realBigInt; }
  assert.deepEqual(body, values); assert.equal(bigCalls, 0, 'no BigInt work for integers up to 48 bits');
  const wide = new Writer(); wide.int('X', 2n ** 50n); wide.int('Y', 2n ** 62n + 5n); wide.int('Z', -(2n ** 61n)); wide.int('S', 2n ** 53n);
  assert.deepEqual(decode(wide.bytes()), { X: 2 ** 50, Y: 2n ** 62n + 5n, Z: -(2n ** 61n), S: 2 ** 53 });
  const tooLong = Buffer.from([...encodeTag('BAD'), T.INT, ...Array(11).fill(0xff), 0x01]);
  assert.throws(() => decode(tooLong), /varint too long/);
});

test('game port in cloud mode: small packets and sign-in commands only until signed in, then a limit per command', async () => {
  const dir = tmpDir('review-port');
  const site = await fakeSite(REGISTRY_TOKEN, reg(player(800001, 'CoachAlpha', 1), player(800002, 'CoachBravo', 2)));
  const blazePort = await freePort();
  // the game service is given ONLY the read-only registry token (item 7): no bridge token anywhere in its environment
  const env = serverEnv(dir, { NCAA_CLOUD: '1', NCAA_PUBLIC_HOST: '127.0.0.1', NCAA_BIND: '127.0.0.1', NCAA_SITE_URL: site.url, NCAA_REGISTRY_TOKEN: REGISTRY_TOKEN,
    NCAA_BLAZE_PORT: String(blazePort), NCAA_LOCKER_PORT: String(await freePort()), NCAA_MAX_PACKET_MB: '1', NCAA_MAX_CONNS_PER_IP: '32', NCAA_CONNS_PER_MIN_PER_IP: '1000', NCAA_SUPERSIM: 'on' });
  const server = startServer('blaze.mjs', { env, ready: 'blaze stub listening' });
  const lines = (re) => server.out.text.split('\n').filter((l) => re.test(l));
  try {
    await server.up;
    assert.match(server.out.text, /\[blaze\] mode: cloud \(member list required, limits on\)/, 'the line check.sh looks for');
    assert.match(server.out.text, /registry updated from the site: 2 player/);
    assert.equal(site.state.lastAuth, `Bearer ${REGISTRY_TOKEN}`, 'the member list is pulled with the registry token');
    assert.ok(!server.out.text.includes(REGISTRY_TOKEN), 'a token is never logged');
    assert.match(server.out.text, /no bridge token for this service .*web-simulated games are not polled/, 'and nothing that writes to the site runs in this process');

    // --- before sign-in ---
    // a header announcing more than a few KB: the connection is dropped on the header, before any payload is read
    const big = await blazeClient(blazePort); big.sock.write(header(9, 7, 8192));
    assert.equal(await closedWithin(big), true); await until(() => /packet of 8192 bytes exceeds the 4096-byte limit before sign-in/.test(server.out.text));
    const huge = await blazeClient(blazePort); huge.sock.write(header(2148, 12, 900 * 1024)); // not even the row upload gets its megabytes yet
    assert.equal(await closedWithin(huge), true);
    // what a console sends before sign-in still answers
    const stranger = await blazeClient(blazePort);
    assert.equal((await stranger.call(9, 7)).type, OK); assert.equal((await stranger.call(9, 2)).type, OK);
    assert.equal((await stranger.call(9, 1, (w) => w.str('CFID', 'OSDK_CORE'))).type, OK);
    // anything else is refused without being decoded: the payload here is not valid TDF, and no decoder error appears
    const junk = Buffer.alloc(300, 0xff);
    const raw = (component, command, payload, id) => stranger.sock.write(encodePacket({ component, command, type: MSG.REQUEST, id, payload }));
    assert.equal((await stranger.call(2148, 22, (w) => w.raw(junk))).type, ERR);
    assert.equal((await stranger.call(20, 9, (w) => w.raw(junk))).type, ERR);
    assert.equal(lines(/tdf:/).length, 0, 'nothing was decoded for a refused command');
    // a sign-in whose body is a list bomb: stopped by the decoder caps, refused, connection still fine
    const bomb = new Writer(); bomb.intList('TCKT', Array.from({ length: 300 }, () => 1));
    assert.equal((await stranger.call(1, 200, (w) => w.raw(bomb.bytes()))).type, ERR);
    await until(() => /refused REQ Authentication\(1\) cmd=200 .* from 127\.0\.0\.1: tdf: a list of 300 items is over the limit of 256/.test(server.out.text));
    assert.equal((await stranger.login(ticket(77))).type, ERR, 'an unknown credential is still just refused');

    // refused packets are logged at most ten times a minute per address (10d); the rest are counted, not written
    const noisyBefore = lines(/not signed in/).length;
    for (let i = 0; i < 60; i++) raw(2148, 22, junk, 1000 + i);
    assert.equal((await stranger.call(9, 2)).type, OK);
    const refusedLines = lines(/\[blaze\] .*(not signed in|league authentication rejected|refused REQ|connection from|connection closed|dropping)/).length;
    assert.ok(lines(/not signed in/).length - noisyBefore < 60 && refusedLines <= 10, `log lines an outsider caused from this address: ${refusedLines}`);
    // and a connection cannot keep sending forever without signing in
    for (let i = 0; i < 200; i++) raw(9, 2, Buffer.alloc(0), 2000 + i);
    assert.equal(await closedWithin(stranger), true);

    // --- after sign-in ---
    const a = await blazeClient(blazePort);
    assert.equal((await a.login(ticket(1))).type, OK);
    // a list longer than any ordinary command carries: refused by the decoder cap, the session stays
    const many = await a.call(9, 4, (w) => w.stringList('LSID', Array.from({ length: 5000 }, () => 'x')));
    assert.equal(many.type, ERR); await until(() => /refused REQ Util\(9\) cmd=4 .* from user 800001: tdf: a list of 5000 items is over the limit of 4096/.test(server.out.text));
    assert.equal((await a.call(9, 2)).type, OK);
    // the row upload gets megabytes: 300 KB of rows in one packet is taken
    const did = Number((await a.call(2148, 2, (w) => { w.int('MHUM', 12); w.str('NAME', 'Limits'); })).body.DID);
    assert.equal((await a.call(2148, 56, (w) => { w.int('DYID', did); w.int('UPDT', 0); })).type, OK);
    const pack4 = (name) => Buffer.from(String(name).padEnd(4).slice(0, 4).split('').reverse().join(''), 'latin1').readUInt32BE(0);
    const rows = Array.from({ length: 300 }, (_, i) => `${i}`.padEnd(1000, 'r'));
    const up = await a.call(2148, 12, (w) => { w.int('DYID', did); w.list('ROWS', T.STRUCT, rows, (x, r) => { x.list('STRV', T.STRING, [r], (y, v) => y.string(v)); x.push(0); }); w.intList('STRC', [pack4('NAME')]); w.int('TABL', pack4('TEST')); });
    assert.equal(up.type, OK); assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'private', 'dynasty-tables', String(did), 'TEST.json'), 'utf8')).rows.length, 300);
    // ...but not more than its own limit (1 MB in this test), and an ordinary command gets 64 KB, not megabytes
    const b = await blazeClient(blazePort); assert.equal((await b.login(ticket(2))).type, OK);
    b.sock.write(header(2148, 12, 2 * 1024 * 1024));
    assert.equal(await closedWithin(b), true); await until(() => /packet of 2097152 bytes exceeds the 1048576-byte limit for 2148\/12/.test(server.out.text));
    const c = await blazeClient(blazePort); assert.equal((await c.login(ticket(2))).type, OK);
    c.sock.write(header(9, 11, 100 * 1024));
    assert.equal(await closedWithin(c), true); await until(() => /packet of 102400 bytes exceeds the 65536-byte limit for 9\/11/.test(server.out.text));
    assert.equal((await a.call(9, 2)).type, OK, 'other connections are untouched');
    assert.equal(server.child.exitCode, null);
  } finally { await server.stop(); await site.close(); }
});

// ---------------------------------------------------------------------------------------------------------------
// item 4: settings
// ---------------------------------------------------------------------------------------------------------------
test('on/off settings: on or off or a configuration error, never a silent "off"', () => {
  for (const v of ['1', 'true', 'ON', 'Yes', ' on ']) assert.equal(parseSwitch('X', v, false), true, v);
  for (const v of ['0', 'false', 'OFF', 'No']) assert.equal(parseSwitch('X', v, true), false, v);
  for (const v of [undefined, '', '   ']) { assert.equal(parseSwitch('X', v, true), true); assert.equal(parseSwitch('X', v, false), false); }
  for (const v of ['1 # public server', 'on # comment', 'enabled', '2', 'tru', 'o n', '"1"', 'off;']) assert.throws(() => parseSwitch('NCAA_CLOUD', v, false), (e) => e instanceof ConfigError && /NCAA_CLOUD must be on or off/.test(e.message), v);
  const cloud = { NCAA_PUBLIC_HOST: '203.0.113.7', NCAA_SITE_URL: 'https://example.org', NCAA_REGISTRY_TOKEN: 'r' };
  assert.equal(cloudSettings({ env: { ...cloud, NCAA_CLOUD: '1' }, argv: [] }).cloud, true);
  // the review's case: a trailing comment used to mean "not cloud" and started the open server
  assert.throws(() => cloudSettings({ env: { ...cloud, NCAA_CLOUD: '1 # public' }, argv: [] }), /NCAA_CLOUD must be on or off/);
  assert.throws(() => cloudSettings({ env: { ...cloud, NCAA_CLOUD: '1', NCAA_HARDEN: 'sure' }, argv: [] }), /NCAA_HARDEN must be on or off/);
  assert.throws(() => cloudSettings({ env: { ...cloud, NCAA_CLOUD: '1', NCAA_REGISTRY_SYNC: 'of' }, argv: [] }), /NCAA_REGISTRY_SYNC must be on or off/);
  assert.throws(() => cloudSettings({ env: { ...cloud, NCAA_CLOUD: '1', NCAA_LAN: 'home' }, argv: [] }), /NCAA_LAN must be on or off/);
  assert.equal(cloudSettings({ env: { NCAA_CLOUD: 'off' }, argv: [] }).cloud, false);
});

test('listen address: this PC only without the member list, unless the home network is asked for', () => {
  const b = (o) => bindSettings({ env: {}, argv: [], ...o });
  assert.deepEqual(b({}), { bind: '127.0.0.1', lan: false, open: true });
  assert.equal(b({ cloud: true }).bind, '0.0.0.0'); assert.equal(b({ registry: true }).bind, '0.0.0.0');
  assert.equal(b({ argv: ['node', 'blaze.mjs', '--lan'] }).bind, '0.0.0.0');
  assert.equal(b({ env: { NCAA_LAN: 'on' } }).bind, '0.0.0.0'); assert.equal(b({ env: { NCAA_LAN: 'off' } }).bind, '127.0.0.1');
  assert.equal(b({ advertised: ['192.168.137.1', undefined] }).bind, '0.0.0.0', 'what league.mjs --lan passes'); assert.equal(b({ advertised: ['127.0.0.1'] }).bind, '127.0.0.1');
  assert.equal(b({ env: { NCAA_BIND: '127.0.0.5' } }).bind, '127.0.0.5');
  assert.equal(b({ env: { NCAA_BIND: '192.168.1.20', NCAA_LAN: '1' } }).bind, '192.168.1.20');
  assert.equal(b({ env: { NCAA_BIND: '10.0.0.5' }, cloud: true }).bind, '10.0.0.5');
  for (const addr of ['0.0.0.0', '192.168.1.20', '203.0.113.7', '::']) assert.throws(() => b({ env: { NCAA_BIND: addr } }), (e) => e instanceof ConfigError && /refusing to listen on .* without the member list/.test(e.message), addr);
  assert.throws(() => b({ env: { NCAA_BIND: '0.0.0.0 # all' } }), /NCAA_BIND must be an IP address/);
  assert.throws(() => b({ env: { NCAA_LAN: 'yes please' } }), /NCAA_LAN must be on or off/);
});

test('a bad setting stops each service with exit code 78 and one line; nothing listens', async () => {
  const dir = tmpDir('review-config');
  const run = async (script, extra, args = []) => { const s = startServer(script, { env: serverEnv(dir, extra), args }); const code = await Promise.race([s.exited, sleep(8000).then(async () => { await s.stop(); return 'still running'; })]); return { code, text: s.out.text }; };
  const cloud = { NCAA_PUBLIC_HOST: '127.0.0.1', NCAA_BIND: '127.0.0.1', NCAA_REGISTRY_SYNC: 'off', NCAA_REGISTRY_FILE: path.join(dir, 'registry.json') };
  fs.writeFileSync(cloud.NCAA_REGISTRY_FILE, JSON.stringify(reg(player(800001, 'CoachAlpha', 1))));
  const cases = [
    ['blaze.mjs', { ...cloud, NCAA_CLOUD: '1 # public server' }, /NCAA_CLOUD must be on or off/],
    ['redirector.mjs', { ...cloud, NCAA_CLOUD: 'on # yes' }, /NCAA_CLOUD must be on or off/],
    ['qos.mjs', { ...cloud, NCAA_CLOUD: 'TRUE!' }, /NCAA_CLOUD must be on or off/],
    ['blaze.mjs', { ...cloud, NCAA_CLOUD: '1', NCAA_EASW: 'enabled' }, /NCAA_EASW must be on or off/],
    ['blaze.mjs', { ...cloud, NCAA_CLOUD: '1', NCAA_SUPERSIM: 'off # later' }, /NCAA_SUPERSIM must be on or off/],
    ['blaze.mjs', { ...cloud, NCAA_CLOUD: '1', NCAA_LOG_BODIES: '2' }, /NCAA_LOG_BODIES must be on or off/],
    ['qos.mjs', { NCAA_HARDEN: 'maybe' }, /NCAA_HARDEN must be on or off/],
    ['qos.mjs', { NCAA_CAPTURE: 'on # debug' }, /NCAA_CAPTURE must be on or off/],
    // no member list and a public address: refused, for every service
    ['blaze.mjs', { NCAA_BIND: '0.0.0.0', NCAA_BLAZE_PORT: String(await freePort()) }, /refusing to listen on 0\.0\.0\.0 without the member list/],
    ['qos.mjs', { NCAA_BIND: '0.0.0.0' }, /refusing to listen on 0\.0\.0\.0 without the member list/],
    ['redirector.mjs', { NCAA_BIND: '0.0.0.0' }, /refusing to listen on 0\.0\.0\.0 without the member list/],
  ];
  for (const [script, env, why] of cases) {
    const r = await run(script, env);
    assert.equal(r.code, 78, `${script} ${JSON.stringify(env)}: ${r.text}`); assert.match(r.text, why);
    const reason = r.text.split('\n').filter((l) => /cannot start/.test(l));
    assert.equal(reason.length, 1, `one line: ${r.text}`); assert.ok(!/\n\s+at /.test(r.text), 'no stack trace');
    assert.ok(!/listening/.test(r.text), `no port was opened: ${r.text}`);
  }
  // --easw takes the same words, so "--easw off" (the documented flag) still works and a typo does not mean "on"
  const flagTypo = await run('blaze.mjs', { NCAA_BLAZE_PORT: String(await freePort()) }, ['--easw', 'of']);
  assert.equal(flagTypo.code, 78); assert.match(flagTypo.text, /--easw must be on or off/);
});

test('local use is unchanged apart from the listen address: default 127.0.0.1, --lan every interface', async () => {
  const dir = tmpDir('review-local');
  const start = async (args, extraEnv = {}) => { const port = await freePort(); const s = startServer('blaze.mjs', { env: serverEnv(dir, extraEnv), ready: 'blaze stub listening', args: ['--port', String(port), '--http-port', String(await freePort()), '--easw', 'off', '--sync', 'off', ...args] }); await s.up; return { s, port }; };
  const plain = await start([]);
  try {
    assert.match(plain.s.out.text, /blaze stub listening on 127\.0\.0\.1:/); assert.match(plain.s.out.text, /mode: local \(no member list/);
    const c = await blazeClient(plain.port);
    assert.equal((await c.call(9, 7)).body.QOSS.BWPS.PSA, '127.0.0.1');
    // no limits on a local PC: the old 16 MB packet limit, everything decoded, commands answered without a sign-in
    assert.equal((await c.call(2148, 22, (w) => w.str('NAME', ''))).type, OK);
    const fat = await c.call(9, 11, (w) => { w.str('DATA', 'd'.repeat(200 * 1024)); w.str('KEY', 'k'); });
    assert.equal(fat.type, OK, 'a 200 KB ordinary command is not dropped locally');
  } finally { await plain.s.stop(); }
  const lan = await start(['--lan']);
  try { assert.match(lan.s.out.text, /blaze stub listening on 0\.0\.0\.0:/); assert.match(lan.s.out.text, /home network \(--lan\)/); } finally { await lan.s.stop(); }
});

// ---------------------------------------------------------------------------------------------------------------
// item 7: tokens (the deployment side is checked with the unit files below)
// ---------------------------------------------------------------------------------------------------------------
test('registry token: used for the member list when set, the bridge token otherwise', () => {
  const base = { NCAA_CLOUD: '1', NCAA_PUBLIC_HOST: '203.0.113.7', NCAA_SITE_URL: 'https://example.org/' };
  const narrow = cloudSettings({ env: { ...base, NCAA_REGISTRY_TOKEN: 'reg-only', NCAA_BRIDGE_TOKEN: 'full' }, argv: [] });
  assert.equal(narrow.registrySync.token, 'reg-only'); assert.equal(narrow.registrySync.narrowToken, true); assert.equal(narrow.registrySync.url, 'https://example.org/api/bridge/league-registry');
  const only = cloudSettings({ env: { ...base, NCAA_REGISTRY_TOKEN: 'reg-only' }, argv: [] });
  assert.equal(only.registrySync.token, 'reg-only'); assert.equal(only.site, null, 'no full token: nothing in this process can write to the site');
  const fallback = cloudSettings({ env: { ...base, NCAA_BRIDGE_TOKEN: 'full' }, argv: [] });
  assert.equal(fallback.registrySync.token, 'full'); assert.equal(fallback.registrySync.narrowToken, false);
  assert.throws(() => cloudSettings({ env: base, argv: [] }), /refuses to start without a player registry/);
  assert.throws(() => registrySite({ NCAA_SITE_URL: 'http://example.org', NCAA_REGISTRY_TOKEN: 'r' }), /must be https/);
});

// ---------------------------------------------------------------------------------------------------------------
// item 8: the rate limiter
// ---------------------------------------------------------------------------------------------------------------
test('rate limiter: constant work per call, and a full table refuses new keys instead of scanning', () => {
  let t = 0;
  const rl = createRateLimiter({ limit: 3, windowMs: 1000, maxKeys: 50000, now: () => t, sweepMs: 0 });
  for (let i = 0; i < 50000; i++) rl.hit(`k${i}`);
  assert.equal(rl.size, 50000);
  // 300,000 packets from addresses never seen before, table full (the QoS UDP port under a forged-source flood)
  const t0 = performance.now();
  for (let i = 0; i < 300000; i++) assert.equal(rl.hit(`new${i}`), false);
  const ms = performance.now() - t0;
  assert.ok(ms < 1500, `300,000 refusals took ${Math.round(ms)} ms (the old limiter scanned the whole table for each one)`);
  assert.equal(rl.size, 50000, 'nothing was stored and nobody already counted was pushed out'); assert.equal(rl.refusedNew, 300000);
  assert.equal(rl.blocked('never-seen'), true, 'unknown while full: the same answer hit() gives');
  assert.ok(rl.hit('k10') && rl.hit('k10')); assert.ok(!rl.hit('k10')); assert.ok(rl.blocked('k10'), 'known keys are still counted exactly');
  // when the window is over, room comes back a few entries per call, with no pause anywhere
  t = 1001;
  assert.equal(rl.blocked('k10'), false); assert.ok(rl.hit('fresh1'));
  for (let i = 0; i < 20000; i++) rl.hit(`again${i}`);
  assert.ok(rl.size <= 50000 && rl.size >= 20000, `size ${rl.size}`);
  assert.ok(rl.hit('k10') && rl.hit('k10') && rl.hit('k10') && !rl.hit('k10'), 'a returning key starts a new window');
  // a limiter that is not full behaves as before
  let u = 0; const small = createRateLimiter({ limit: 2, windowMs: 100, now: () => u, sweepMs: 0 });
  assert.ok(small.hit('a') && small.hit('a') && !small.hit('a')); assert.ok(small.hit('b')); u = 100; assert.ok(small.hit('a'));
});

test('log limiter: a few lines per address per minute, and the next one says how many were left out', () => {
  let t = 0; const out = [];
  const lim = createLogLimiter((m) => out.push(m), { perWindow: 3, windowMs: 60000, maxKeys: 4, now: () => t });
  for (let i = 0; i < 50; i++) lim.write('1.2.3.4', `refused ${i}`);
  assert.deepEqual(out, ['refused 0', 'refused 1', 'refused 2']);
  assert.ok(lim.write('5.6.7.8', 'other address'), 'one noisy address does not silence another');
  t = 60001; lim.write('1.2.3.4', 'refused again');
  assert.equal(out.at(-1), 'refused again (47 similar line(s) not shown)');
  for (let i = 0; i < 100; i++) lim.write(`10.0.0.${i}`, 'x');
  assert.ok(lim.size <= 4, 'the table of addresses is bounded');
});

// ---------------------------------------------------------------------------------------------------------------
// item 10c: how old the member list may get
// ---------------------------------------------------------------------------------------------------------------
test('member list age: a warning first, then no new sign-ins until the site answers; signed-in players stay', async () => {
  const dir = tmpDir('review-age'); const file = path.join(dir, 'registry.json');
  const HOUR = 3600000; let t = Date.now(), siteUp = true;
  const body = JSON.stringify(reg(player(800001, 'CoachAlpha', 1)));
  const fetchImpl = async () => { if (!siteUp) throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' }); return new Response(body, { status: 200, headers: { etag: '"v1"' } }); };
  const store = new RegistryStore(); const out = [];
  const sync = startRegistrySync({ url: 'https://site.invalid/api/bridge/league-registry', token: 'x', store, file, intervalMs: 3600000, log: (m) => out.push(m), fetchImpl, warnAfterMs: 6 * HOUR, maxAgeMs: 72 * HOUR, now: () => t });
  try {
    await sync.ready;
    const session = store.authenticate(ticket(1));
    assert.equal(store.signInsOpen(t), true); assert.equal(store.ageMs(t), 0);
    siteUp = false;
    t += 5 * HOUR; await sync.syncNow(); assert.ok(!out.some((l) => /WARNING/.test(l)), 'five hours: nothing to say yet');
    t += 2 * HOUR; await sync.syncNow();
    assert.match(out.at(-1), /WARNING: the member list has not been confirmed with the site for 7 hours .*New sign-ins stop at 72 hours/);
    const warned = out.filter((l) => /WARNING/.test(l)).length;
    await sync.syncNow(); await sync.syncNow(); assert.equal(out.filter((l) => /WARNING/.test(l)).length, warned, 'once an hour, not on every failed pull');
    t += 24 * HOUR; await sync.syncNow();
    assert.equal(store.signInsOpen(t), true, 'a site outage of a day (31 hours here) changes nothing for players');
    t += 42 * HOUR; await sync.syncNow(); // 73 hours
    assert.equal(store.signInsOpen(t), false);
    assert.match(out.at(-1), /WARNING: NEW SIGN-INS ARE STOPPED\. The member list was last confirmed with the site 73 hours ago, more than the 72 hours allowed/);
    assert.equal(store.isActive(session), true, 'a session that is already signed in is still good');
    assert.equal(store.find(800001).onlineId, 'CoachAlpha', 'and the list itself is kept');
    siteUp = true; await sync.syncNow();
    assert.equal(store.signInsOpen(t), true); assert.match(out.at(-1), /new sign-ins are accepted again/);
    // the time of the last contact survives a restart: it is the cache file's timestamp
    assert.ok(Math.abs(fs.statSync(file).mtimeMs - t) < 5000);
    // limits off: never stops
    const loose = new RegistryStore(); loose.lastContact = 1; assert.equal(loose.signInsOpen(Date.now()), true);
  } finally { sync.stop(); }
});

test('member list age, end to end: a server started on a very old cached list takes no sign-ins until the site is back', async () => {
  const dir = tmpDir('review-age-e2e');
  const list = reg(player(800001, 'CoachAlpha', 1));
  const site = await fakeSite(REGISTRY_TOKEN, list); site.state.mode = 'error';
  const cache = path.join(dir, 'private', 'league-registry.json'); fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, JSON.stringify(list)); const old = new Date(Date.now() - 100 * 3600000); fs.utimesSync(cache, old, old);
  const blazePort = await freePort();
  const env = serverEnv(dir, { NCAA_CLOUD: '1', NCAA_PUBLIC_HOST: '127.0.0.1', NCAA_BIND: '127.0.0.1', NCAA_SITE_URL: site.url, NCAA_REGISTRY_TOKEN: REGISTRY_TOKEN, NCAA_REGISTRY_INTERVAL: '1',
    NCAA_BLAZE_PORT: String(blazePort), NCAA_LOCKER_PORT: String(await freePort()) });
  const server = startServer('blaze.mjs', { env, ready: 'blaze stub listening' });
  try {
    await server.up;
    assert.match(server.out.text, /loaded the cached registry: 1 player\(s\), last confirmed with the site/);
    assert.match(server.out.text, /WARNING: NEW SIGN-INS ARE STOPPED\. The member list was last confirmed with the site 100 hours ago/);
    const c = await blazeClient(blazePort);
    assert.equal((await c.login(ticket(1))).type, ERR);
    await until(() => /sign-in refused for 127\.0\.0\.1: the member list is too old/.test(server.out.text));
    site.state.mode = 'ok';
    await until(() => /new sign-ins are accepted again/.test(server.out.text), { timeoutMs: 10000 });
    assert.equal((await c.login(ticket(1))).type, OK);
  } finally { await server.stop(); await site.close(); }
});

// ---------------------------------------------------------------------------------------------------------------
// items 1, 4, 7: the deployment files
// ---------------------------------------------------------------------------------------------------------------
test('deployment: units always restart, each service has its own user, and only the site sync gets the bridge token', () => {
  const read = (...p) => fs.readFileSync(path.join(DEPLOY, ...p), 'utf8');
  const unit = (name) => { const text = read('systemd', `fcs-league-${name}.service`); const get = (k) => text.split('\n').filter((l) => l.startsWith(`${k}=`)).map((l) => l.slice(k.length + 1)); return { text, get }; };
  const users = new Set();
  for (const name of ['blaze', 'redirector', 'qos', 'sync']) {
    const u = unit(name);
    // comes back by itself, whatever stopped it, and can never be left stopped by a restart counter
    assert.deepEqual(u.get('Restart'), ['always'], name); assert.deepEqual(u.get('StartLimitIntervalSec'), ['0'], name);
    assert.equal(u.get('StartLimitBurst').length, 0, name); assert.equal(u.get('RestartPreventExitStatus').length, 0, name);
    assert.ok(Number(u.get('RestartSec')[0]) >= 5, name); assert.ok(u.get('MemoryMax').length === 1, name);
    assert.equal(u.get('User').length, 1); users.add(u.get('User')[0]);
    assert.ok(!/\r/.test(u.text), `${name}: Unix line endings`);
  }
  assert.equal(users.size, 4, `one user per service: ${[...users]}`); assert.ok(!users.has('fcsleague') && !users.has('root'));
  assert.deepEqual(unit('blaze').get('EnvironmentFile'), ['/etc/fcs-league/league.env', '/etc/fcs-league/registry.env']);
  assert.deepEqual(unit('sync').get('EnvironmentFile'), ['/etc/fcs-league/league.env', '/etc/fcs-league/bridge.env']);
  for (const name of ['redirector', 'qos']) assert.deepEqual(unit(name).get('EnvironmentFile'), ['/etc/fcs-league/league.env'], `${name} gets no secret`);
  // the game service writes the data, the site sync only its own two folders
  assert.deepEqual(unit('blaze').get('ReadWritePaths'), ['/var/lib/fcs-league/private']);
  assert.deepEqual(unit('sync').get('ReadWritePaths'), ['/var/lib/fcs-league/private/web-edits /var/lib/fcs-league/sync']);
  assert.equal(unit('qos').get('ReadWritePaths').length, 0);

  // templates: no secret in league.env; the two token files name one secret each; every setting the server reads
  // for the new behaviour is documented with its default
  const leagueEnv = read('league.env.example');
  assert.ok(!/^\s*NCAA_(BRIDGE|REGISTRY)_TOKEN=/m.test(leagueEnv));
  assert.match(read('registry.env.example'), /^NCAA_REGISTRY_TOKEN=paste-the-registry-token-here$/m);
  assert.match(read('bridge.env.example'), /^NCAA_BRIDGE_TOKEN=paste-the-token-here$/m);
  const defaults = limits({});
  for (const [name, value] of [['NCAA_PREAUTH_PACKET_KB', defaults.preauthPacketBytes / 1024], ['NCAA_COMMAND_PACKET_KB', defaults.commandPacketBytes / 1024], ['NCAA_MAX_PACKET_MB', defaults.maxPacketBytes / 1048576],
    ['NCAA_REGISTRY_WARN_HOURS', 6], ['NCAA_REGISTRY_MAX_AGE_HOURS', 72], ['NCAA_UPDATE_LOCK_SECONDS', 300]]) assert.match(leagueEnv, new RegExp(`^#${name}=${value}$`, 'm'), name);
  const age = cloudSettings({ env: { NCAA_CLOUD: '1', NCAA_PUBLIC_HOST: '203.0.113.7', NCAA_SITE_URL: 'https://example.org', NCAA_REGISTRY_TOKEN: 'r' }, argv: [] }).registrySync;
  assert.equal(age.warnAfterMs, 6 * 3600000); assert.equal(age.maxAgeMs, 72 * 3600000);
  for (const line of leagueEnv.split('\n')) assert.ok(!/^#?NCAA_[A-Z0-9_]+=\S*\s+#/.test(line), `no note after a value: ${line}`);

  // scripts: provision creates the users and both token files; check.sh reads the mode from the log; firewall.sh
  // reads NCAA_EASW the way the server does
  const provision = read('provision.sh');
  for (const user of users) assert.ok(provision.includes(user), `provision.sh creates ${user}`);
  assert.match(provision, /registry\.env/); assert.match(provision, /NCAA_REGISTRY_TOKEN/);
  const check = read('check.sh');
  assert.match(check, /mode: cloud/); assert.match(check, /_SYSTEMD_INVOCATION_ID/); assert.match(check, /LOCAL mode/);
  const firewall = read('firewall.sh');
  assert.match(firewall, /on\|1\|true\|yes\) EASW_ON=1/); assert.match(firewall, /must be on or off/); assert.ok(!firewall.includes('[ "$EASW" = "on" ]'));
  for (const f of ['provision.sh', 'check.sh', 'firewall.sh', 'restore.sh', 'backup.sh', 'registry.env.example', 'bridge.env.example', 'league.env.example']) assert.ok(!/\r/.test(read(f)), `${f}: Unix line endings`);
});
