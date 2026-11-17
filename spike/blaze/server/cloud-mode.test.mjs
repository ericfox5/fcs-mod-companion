// Cloud mode end to end: real processes on OS-picked loopback ports, a fake site, temp state. Never the live league.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { cloudSettings, createAdvertiser, siteSettings, ConfigError } from './cloud-config.mjs';
import { MSG } from './packet.mjs';
import { tmpDir, freePort, serverEnv, startServer, blazeClient, fakeSite, ticket, player, until, sleep } from './testkit.mjs';

const TOKEN = 'test-bridge-token-not-a-real-one';
const reg = (...players) => ({ version: 1, generatedAt: new Date().toISOString(), players });
const ERR = MSG.ERROR, OK = MSG.RESPONSE;
// what an unsigned RPCN/PSN-style ticket looks like to the legacy parser: claims any user id and name it likes
function forgedTicket(userId, name) {
  const id = Buffer.alloc(12); id.writeUInt16BE(2, 0); id.writeUInt16BE(8, 2); id.writeBigUInt64BE(BigInt(userId), 4);
  const n = Buffer.from(name.padEnd(32, '\0'), 'latin1'), nh = Buffer.alloc(4); nh.writeUInt16BE(4, 0); nh.writeUInt16BE(n.length, 2);
  const body = Buffer.concat([id, nh, n]), head = Buffer.alloc(8); head.writeUInt32BE(0x21010000, 0); head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
}

test('cloud settings: refuses to start without a registry, a public address, or https', () => {
  const base = { NCAA_CLOUD: '1', NCAA_PUBLIC_HOST: 'play.example.org' };
  const s = (env, argv = ['node', 'blaze.mjs']) => cloudSettings({ env, argv });
  assert.throws(() => s({ ...base }), /refuses to start without a player registry/);
  assert.throws(() => s({ ...base, NCAA_SITE_URL: 'https://site.example' }), /registry/); // a URL without the token is not a registry
  assert.throws(() => s({ ...base, NCAA_REGISTRY_SYNC: 'off' }), ConfigError);
  assert.throws(() => s({ NCAA_CLOUD: '1', NCAA_SITE_URL: 'https://site.example', NCAA_BRIDGE_TOKEN: 't' }), /NCAA_PUBLIC_HOST/);
  assert.throws(() => s({ ...base, NCAA_PUBLIC_HOST: 'not a host!', NCAA_SITE_URL: 'https://site.example', NCAA_BRIDGE_TOKEN: 't' }), /not a hostname/);
  assert.throws(() => s({ ...base, NCAA_SITE_URL: 'http://site.example', NCAA_BRIDGE_TOKEN: 't' }), /https/); // the token must not travel in clear
  assert.throws(() => s({ ...base, NCAA_ADVERTISE: 'dns', NCAA_SITE_URL: 'https://site.example', NCAA_BRIDGE_TOKEN: 't' }), /NCAA_ADVERTISE/);
  const synced = s({ ...base, NCAA_SITE_URL: 'https://site.example/', NCAA_BRIDGE_TOKEN: 't' });
  assert.equal(synced.registrySync.url, 'https://site.example/api/bridge/league-registry');
  assert.equal(synced.registrySync.intervalMs, 60000); assert.equal(synced.registrySync.minUserId, 800000);
  assert.match(synced.registryFile, /league-registry\.json$/); assert.equal(synced.advertise, 'ip'); assert.ok(synced.hardened);
  const fixed = s({ ...base, NCAA_REGISTRY_SYNC: 'off', NCAA_REGISTRY_FILE: '/tmp/r.json' });
  assert.equal(fixed.registrySync, null); assert.ok(fixed.registryFile.endsWith('r.json'));
  // the bridge's variable name works too, and local mode asks for nothing
  assert.equal(siteSettings({ NCAA_WORKER_URL: 'https://w.example', NCAA_BRIDGE_TOKEN: 't' }).siteUrl, 'https://w.example');
  const local = s({});
  assert.equal(local.cloud, false); assert.equal(local.hardened, false); assert.equal(local.registryFile, '');
  assert.equal(s({}, ['node', 'blaze.mjs', '--ticket-registry', 'reg.json']).registryFile, 'reg.json');
});

test('advertised address: IPv4 literal, a hostname resolved on the server, or the hostname itself', async () => {
  const lit = await createAdvertiser('203.0.113.7', 'ip');
  assert.equal(lit.ip(), '203.0.113.7'); assert.equal(lit.host(), '203.0.113.7');
  const lookup = async () => ({ address: '198.51.100.9', family: 4 });
  const ip = await createAdvertiser('play.example.org', 'ip', { lookup, refreshMs: 0 });
  assert.equal(ip.host(), '198.51.100.9'); assert.equal(ip.ip(), '198.51.100.9');
  const host = await createAdvertiser('play.example.org', 'host', { lookup, refreshMs: 0 });
  assert.equal(host.host(), 'play.example.org'); assert.equal(host.ip(), '198.51.100.9'); // numeric fields still get IPv4
  await assert.rejects(createAdvertiser('nope.invalid', 'ip', { lookup: async () => { throw new Error('ENOTFOUND'); }, refreshMs: 0 }), ConfigError);
  await assert.rejects(createAdvertiser('six.example', 'ip', { lookup: async () => ({ address: '2001:db8::1' }), refreshMs: 0 }), /IPv4/);
});

test('blaze, redirector and qos exit with a clear message instead of starting misconfigured', async () => {
  const dir = tmpDir('cloud-refuse');
  const run = async (script, extra, args = []) => { const s = startServer(script, { env: serverEnv(dir, { NCAA_CLOUD: '1', ...extra }), args }); const code = await s.exited; return { code, text: s.out.text }; };
  const noRegistry = await run('blaze.mjs', { NCAA_PUBLIC_HOST: '127.0.0.1', NCAA_BLAZE_PORT: String(await freePort()) });
  assert.equal(noRegistry.code, 78); assert.match(noRegistry.text, /refuses to start without a player registry/);
  assert.ok(!/listening/.test(noRegistry.text)); // no port was opened
  const missingFile = await run('blaze.mjs', { NCAA_PUBLIC_HOST: '127.0.0.1', NCAA_REGISTRY_SYNC: 'off', NCAA_REGISTRY_FILE: path.join(dir, 'nope.json') });
  assert.equal(missingFile.code, 78); assert.ok(!/listening/.test(missingFile.text));
  const noHost = await run('redirector.mjs', {});
  assert.equal(noHost.code, 78); assert.match(noHost.text, /NCAA_PUBLIC_HOST/);
  const badHost = await run('qos.mjs', { NCAA_PUBLIC_HOST: 'bad host' });
  assert.equal(badHost.code, 78);
});

test('cloud mode: site-synced registry, forged tickets refused, live revocation, last good copy, cache on restart', async () => {
  const dir = tmpDir('cloud');
  const site = await fakeSite(TOKEN, reg(player(800001, 'CoachAlpha', 1), player(800002, 'CoachBravo', 2)));
  const blazePort = await freePort(), lockerPort = await freePort();
  const env = serverEnv(dir, {
    NCAA_CLOUD: '1', NCAA_PUBLIC_HOST: '127.0.0.1', NCAA_BIND: '127.0.0.1', NCAA_SITE_URL: site.url, NCAA_BRIDGE_TOKEN: TOKEN, NCAA_REGISTRY_INTERVAL: '1',
    NCAA_BLAZE_PORT: String(blazePort), NCAA_LOCKER_PORT: String(lockerPort), NCAA_MAX_UPLOAD_MB: '1', NCAA_LOGIN_ATTEMPTS_PER_MIN: '4', NCAA_MAX_CONNS_PER_IP: '8',
  });
  let server = startServer('blaze.mjs', { env, ready: 'blaze stub listening' });
  try {
    await server.up;
    assert.match(server.out.text, /cloud mode/); assert.match(server.out.text, /registry updated from the site: 2 player/);
    assert.ok(!server.out.text.includes(TOKEN), 'the bridge token must never be logged');
    assert.ok(!fs.readdirSync(path.join(dir, 'private')).some((f) => f.startsWith('capture-')), 'no capture file in cloud mode');

    const a = await blazeClient(blazePort), b = await blazeClient(blazePort), stranger = await blazeClient(blazePort);
    // before login: only the bootstrap calls answer
    assert.equal((await stranger.call(2148, 2, (w) => w.str('NAME', 'unauth'))).type, ERR);
    const pre = await stranger.call(9, 7);
    assert.equal(pre.type, OK); assert.equal(pre.body.QOSS.BWPS.PSA, '127.0.0.1');
    // the legacy hole: an unsigned ticket naming someone else's id. Refused, and never falls back to 1000/Player
    assert.equal((await stranger.login(forgedTicket(800001, 'CoachAlpha'))).type, ERR);
    assert.equal((await stranger.login(Buffer.alloc(0))).type, ERR);
    assert.equal((await stranger.call(2148, 13)).type, ERR);
    const la = await a.login(ticket(1)), lb = await b.login(ticket(2));
    assert.equal(la.type, OK); assert.equal(Number(la.body.SESS.UID), 800001); assert.equal(Number(lb.body.SESS.UID), 800002);
    assert.match(server.out.text, /ps3Login for CoachAlpha \(user 800001/);
    assert.ok(!server.out.text.includes(ticket(1).toString('hex')), 'credentials must never be logged');
    assert.ok(fs.existsSync(path.join(dir, 'private', 'league-registry.json')));

    // Locker: the URL capability is the only way in, and it is checked before the body is read
    const created = await a.call(20, 1, (w) => { w.str('CCAT', 'LeagueStorage'); w.str('NAME', 'TEST.dynasty'); });
    const info = created.body.INFO, cid = Number(info.CID);
    assert.ok(String(info.UURL).startsWith(`http://127.0.0.1:${lockerPort}/locker/upload?cid=${cid}&cap=`));
    const up = (url, body) => fetch(url, { method: 'POST', body });
    assert.equal((await up(`http://127.0.0.1:${lockerPort}/locker/upload?cid=${cid}`, 'x')).status, 403);
    assert.equal((await up(`http://127.0.0.1:${lockerPort}/locker/upload?cid=${cid}&cap=${'0'.repeat(48)}`, 'x')).status, 403);
    assert.equal((await up(`http://127.0.0.1:${lockerPort}/locker/upload?cid=__proto__&cap=x`, 'x')).status, 403);
    assert.equal((await up(`http://127.0.0.1:${lockerPort}/locker/upload?cid=..%2F..%2Fx&cap=x`, 'x')).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${lockerPort}/locker/download?cid=${cid}`)).status, 403);
    assert.equal((await up(info.UURL, Buffer.alloc(1024 * 1024 + 4096, 7))).status, 413); // over NCAA_MAX_UPLOAD_MB
    assert.equal((await up(info.UURL, 'saved dynasty')).status, 200);
    assert.equal(await (await fetch(info.GURL)).text(), 'saved dynasty');
    assert.equal((await b.call(20, 8, (w) => w.int('CID', cid))).type, ERR); // not B's file, no shared dynasty

    // hostile bytes: an oversized packet header and plain garbage close that socket only
    const junk = net.connect(blazePort, '127.0.0.1'); junk.on('error', () => {});
    const junkClosed = new Promise((r) => junk.once('close', r));
    const huge = Buffer.alloc(14); huge.writeUInt16BE(0xffff, 0); huge.writeUInt16BE(0x10, 8); huge.writeUInt16BE(0xffff, 12); // announces ~4 GB
    junk.write(huge); await junkClosed;
    assert.match(server.out.text, /exceeds the \d+-byte limit/);
    // a request whose body is not TDF at all still gets an answer or is ignored; the process survives
    const { encodePacket } = await import('./packet.mjs');
    a.sock.write(encodePacket({ component: 2148, command: 12, id: 9000, type: MSG.REQUEST, payload: Buffer.from('04ffffffffff7f00ffffff0503ffffffff', 'hex') }));
    a.sock.write(encodePacket({ component: 9, command: 4, id: 9001, type: MSG.REQUEST, payload: Buffer.alloc(64, 0x9f) }));
    assert.equal((await a.call(9, 2)).type, OK);

    // revocation: the site disables A; the live connection is closed within one sync interval and A cannot return
    site.state.registry = reg(player(800001, 'CoachAlpha', 1, { disabled: true }), player(800002, 'CoachBravo', 2));
    await Promise.race([a.closed, sleep(6000).then(() => { throw new Error('revoked session was not closed'); })]);
    assert.match(server.out.text, /closing the session of user 800001/);
    assert.equal((await fetch(info.GURL)).status, 403); // its Locker capability died with it
    const a2 = await blazeClient(blazePort);
    assert.equal((await a2.login(ticket(1))).type, ERR);
    assert.equal((await b.call(2148, 13)).type, OK); // B is untouched

    // the site goes away: the last good registry keeps serving (B in, A still out)
    await site.close();
    await until(() => /registry sync failed/.test(server.out.text), { what: 'a logged sync failure' });
    const b2 = await blazeClient(blazePort);
    assert.equal((await b2.login(ticket(2))).type, OK);
    assert.equal((await a2.login(ticket(1))).type, ERR);
    assert.ok(!server.out.text.includes(TOKEN));

    // restart with the site still down: the cache file is loaded, the revocation is remembered
    await server.stop();
    server = startServer('blaze.mjs', { env, ready: 'blaze stub listening' });
    await server.up;
    assert.match(server.out.text, /loaded the cached registry: 2 player/);
    const b3 = await blazeClient(blazePort), a3 = await blazeClient(blazePort);
    assert.equal((await b3.login(ticket(2))).type, OK);
    assert.equal((await a3.login(ticket(1))).type, ERR);

    // login attempts per address are limited: after the limit the address is refused and disconnected
    const guesser = await blazeClient(blazePort);
    for (let i = 0; i < 4; i++) { try { await guesser.login(ticket(100 + i)); } catch { /* dropped */ } }
    await Promise.race([guesser.login(ticket(2)).catch(() => {}), guesser.closed]);
    await Promise.race([guesser.closed, sleep(3000).then(() => { throw new Error('guesser was not disconnected'); })]);
    assert.match(server.out.text, /too many failed attempts/);
  } finally { await server.stop(); await site.close().catch(() => {}); }
});

test('cloud mode: a silent connection is closed, and connections per address are capped', async () => {
  const dir = tmpDir('cloud-limits'), file = path.join(dir, 'registry.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, players: [player(101, 'LocalOne', 1)] }));
  const blazePort = await freePort();
  const env = serverEnv(dir, { NCAA_CLOUD: '1', NCAA_PUBLIC_HOST: 'localhost', NCAA_ADVERTISE: 'host', NCAA_BIND: '127.0.0.1', NCAA_REGISTRY_SYNC: 'off', NCAA_REGISTRY_FILE: file,
    NCAA_BLAZE_PORT: String(blazePort), NCAA_LOCKER_PORT: String(await freePort()), NCAA_PREAUTH_SECONDS: '5', NCAA_MAX_CONNS_PER_IP: '3' });
  const server = startServer('blaze.mjs', { env, ready: 'blaze stub listening' });
  try {
    await server.up;
    const idle = await blazeClient(blazePort), user = await blazeClient(blazePort), third = await blazeClient(blazePort);
    assert.equal((await user.login(ticket(1))).type, OK);
    // NCAA_ADVERTISE=host: strings carry the hostname
    assert.equal((await third.call(9, 7)).body.QOSS.BWPS.PSA, 'localhost');
    const created = await user.call(20, 1, (w) => w.str('NAME', 'X.dynasty'));
    assert.match(String(created.body.INFO.UURL), /^http:\/\/localhost:\d+\/locker\/upload/);
    // a fourth connection from the same address is refused
    const fourth = net.connect(blazePort, '127.0.0.1'); fourth.on('error', () => {});
    await Promise.race([new Promise((r) => fourth.once('close', r)), sleep(3000).then(() => { throw new Error('fourth connection was not refused'); })]);
    // no login within NCAA_PREAUTH_SECONDS: closed; the logged-in one stays
    await Promise.race([idle.closed, sleep(9000).then(() => { throw new Error('silent connection was not closed'); })]);
    assert.equal((await user.call(9, 2)).type, OK);
    // a static registry file edit (the operator disables the player) reaches the live session as well
    fs.writeFileSync(file, JSON.stringify({ version: 1, players: [player(101, 'LocalOne', 1, { disabled: true })] }));
    await Promise.race([user.closed, sleep(9000).then(() => { throw new Error('disabled player stayed connected'); })]);
  } finally { await server.stop(); }
});

test('local mode is unchanged: flags, 127.0.0.1 by default, the legacy ticket path still answers', async () => {
  const dir = tmpDir('local');
  const blazePort = await freePort();
  const server = startServer('blaze.mjs', { env: serverEnv(dir), ready: 'blaze stub listening',
    args: ['--port', String(blazePort), '--http-port', String(await freePort()), '--easw', 'off', '--sync', 'off', '--qos-addr', '192.168.5.5'] });
  try {
    await server.up;
    assert.ok(!/cloud mode|registry mode/.test(server.out.text));
    const c = await blazeClient(blazePort);
    assert.equal((await c.call(9, 7)).body.QOSS.BWPS.PSA, '192.168.5.5'); // what league.mjs --lan passes
    const login = await c.login(forgedTicket(4242, 'LanPlayer'));
    assert.equal(login.type, OK); assert.equal(Number(login.body.SESS.UID), 4242); // trusted on a LAN only: exactly why cloud mode forbids it
    assert.equal((await c.login(ticket(1))).type, ERR); // a league credential without a registry is still refused
  } finally { await server.stop(); }
});

test('redirector in cloud mode sends consoles to the public address: IPv4 by default, the hostname on request', async (t) => {
  const { HERE, sslv3Request } = await import('./testkit.mjs');
  if (!fs.existsSync(path.join(HERE, 'certs', 'gosredirector_mod.crt'))) return t.skip('no certificate in certs/ (run gen-cert.mjs)');
  const { encodePacket, PacketStream } = await import('./packet.mjs'); const { decode } = await import('./tdf.mjs');
  const ask = async (extra, args = []) => {
    const dir = tmpDir('redir'), port = await freePort();
    const server = startServer('redirector.mjs', { env: serverEnv(dir, { NCAA_BIND: '127.0.0.1', NCAA_REDIRECTOR_PORT: String(port), NCAA_BLAZE_PORT: '33999', ...extra }), args, ready: 'SSLv3 redirector listening' });
    try {
      await server.up;
      const reply = await sslv3Request(port, encodePacket({ component: 5, command: 1, id: 7, type: MSG.REQUEST }));
      const [p] = new PacketStream().feed(reply); assert.equal(p.type, MSG.RESPONSE);
      return decode(p.payload).ADDR.VALU;
    } finally { await server.stop(); }
  };
  const cloud = { NCAA_CLOUD: '1', NCAA_PUBLIC_HOST: 'localhost' }; // a hostname, like play.fcs-mod.online
  assert.deepEqual(await ask(cloud), { HOST: '127.0.0.1', IP: 0x7f000001, PORT: 33999 }); // resolved on the server
  assert.deepEqual(await ask({ ...cloud, NCAA_ADVERTISE: 'host' }), { HOST: 'localhost', IP: 0x7f000001, PORT: 33999 });
  assert.deepEqual(await ask({ NCAA_CLOUD: '1', NCAA_PUBLIC_HOST: '203.0.113.7' }), { HOST: '203.0.113.7', IP: 0xcb007107, PORT: 33999 });
  // local mode: 127.0.0.1 unless --blaze-host (league.mjs --lan) says otherwise
  assert.deepEqual(await ask({}), { HOST: '127.0.0.1', IP: 0x7f000001, PORT: 33999 });
  assert.deepEqual(await ask({}, ['--blaze-host', '192.168.5.5', '--blaze-port', '33152']), { HOST: '192.168.5.5', IP: 0xc0a80505, PORT: 33152 });
});
