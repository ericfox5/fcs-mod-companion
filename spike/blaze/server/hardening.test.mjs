// Hardening added for the public server: hostile packets, limits, authenticated Sports World, QoS reflection limits.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import dgram from 'node:dgram';
import { once, EventEmitter } from 'node:events';
import { tmpDir, freePort, freeDualPort, freeUdpPort, serverEnv, startServer, ticket, player, sleep, HERE } from './testkit.mjs';

// state and logs of anything imported below go to a temp folder, never the real private/ directory
const DIR = tmpDir('hardening');
process.env.NCAA_PRIVATE = path.join(DIR, 'private'); process.env.NCAA_CAPTURE = 'off'; process.env.NCAA_LOG_BODIES = '0';
delete process.env.NCAA_XMS_DIR; delete process.env.NCAA_CLOUD;
const { decode, Writer, T } = await import('./tdf.mjs');
const { PacketStream, PacketTooLarge, encodePacket } = await import('./packet.mjs');
const { createRateLimiter, createConnectionGuard, readBody } = await import('./net-guard.mjs');
const { RegistryStore } = await import('./registry-sync.mjs');

test('TDF decoder: hostile lengths and nesting fail fast instead of eating memory or CPU', () => {
  const tag = [0x92, 0x9b, 0x20]; // any 3-byte tag
  const hostile = {
    'list of a billion structs': Buffer.from([...tag, T.LIST, T.STRUCT, 0xbf, 0xff, 0xff, 0xff, 0x7f]),
    'map of a billion entries': Buffer.from([...tag, T.MAP, T.INT, T.INT, 0xbf, 0xff, 0xff, 0xff, 0x7f]),
    'negative string length': Buffer.from([...tag, T.STRING, 0x41, 0x00]),
    'negative blob length': Buffer.from([...tag, T.BLOB, 0x7f]),
    'string longer than the packet': Buffer.from([...tag, T.STRING, 0xbf, 0x7f, 0x41]),
    'endless varint': Buffer.concat([Buffer.from([...tag, T.INT]), Buffer.alloc(4096, 0xff)]),
    'unknown type': Buffer.from([...tag, 0x3f, 0x00]),
  };
  for (const [name, buf] of Object.entries(hostile)) {
    const t0 = Date.now();
    assert.throws(() => decode(buf), /tdf/, name);
    assert.ok(Date.now() - t0 < 500, `${name} took too long`);
  }
  const deep = Buffer.concat([...Array(5000)].map(() => Buffer.from([...tag, T.STRUCT])));
  assert.throws(() => decode(deep), /nested too deep/);
  // ordinary packets still decode
  const w = new Writer(); w.int('A', 5); w.str('S', 'hi'); w.list('L', T.STRUCT, [1, 2], (x, i) => { x.int('V', i); x.push(0); }); w.blob('B', Buffer.from('abc')); w.int('NEG', -77);
  assert.deepEqual(decode(w.bytes()), { A: 5, S: 'hi', L: { $list: 'struct', items: [{ V: 1 }, { V: 2 }] }, B: '0x616263', NEG: -77 });
});

test('packet framing: an oversized header is refused, normal and extended packets pass', () => {
  const s = new PacketStream({ maxPacket: 1024 });
  const small = encodePacket({ component: 9, command: 2, id: 1, payload: Buffer.alloc(100, 1) });
  assert.equal(s.feed(small.subarray(0, 7)).length, 0);
  assert.equal(s.feed(small.subarray(7)).length, 1);
  const big = encodePacket({ component: 9, command: 2, id: 2, payload: Buffer.alloc(70000, 1) }); // extended header
  assert.throws(() => s.feed(big.subarray(0, 14)), PacketTooLarge);
  const roomy = new PacketStream();
  const out = roomy.feed(Buffer.concat([big, small]));
  assert.equal(out.length, 2); assert.equal(out[0].payload.length, 70000); assert.equal(out[1].payload.length, 100);
  const header = Buffer.alloc(14); header.writeUInt16BE(0xffff, 0); header.writeUInt16BE(0x10, 8); header.writeUInt16BE(0xffff, 12);
  assert.throws(() => roomy.feed(header), /exceeds/); // ~4 GB announced: nothing is buffered
});

test('rate limiter and connection guard', () => {
  let t = 0; const rl = createRateLimiter({ limit: 3, windowMs: 1000, now: () => t });
  assert.ok(rl.hit('a') && rl.hit('a') && rl.hit('a')); assert.ok(!rl.hit('a')); assert.ok(rl.blocked('a'));
  assert.ok(rl.hit('b')); assert.ok(!rl.blocked('b'));
  t = 1001; assert.ok(!rl.blocked('a')); assert.ok(rl.hit('a'));
  const small = createRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 100, now: () => t });
  for (let i = 0; i < 5000; i++) small.hit(`k${i}`);
  assert.ok(small.size <= 100, 'the limiter table is bounded');

  const sock = (ip) => Object.assign(new EventEmitter(), { remoteAddress: ip });
  const guard = createConnectionGuard({ maxTotal: 3, maxPerIp: 2 });
  const a1 = sock('::ffff:10.0.0.1'), a2 = sock('10.0.0.1'), a3 = sock('10.0.0.1'), b1 = sock('10.0.0.2'), c1 = sock('10.0.0.3');
  assert.ok(guard.admit(a1) && guard.admit(a2)); assert.ok(!guard.admit(a3)); // mapped and plain IPv4 are one client
  assert.ok(guard.admit(b1)); assert.ok(!guard.admit(c1)); // total cap
  a1.emit('close'); assert.equal(guard.total, 2); assert.ok(guard.admit(c1));
  const perMinute = createConnectionGuard({ maxTotal: 100, maxPerIp: 100, perMinutePerIp: 2 });
  const x = () => { const s = sock('10.9.9.9'); const ok = perMinute.admit(s); s.emit('close'); return ok; };
  assert.ok(x() && x()); assert.ok(!x());
});

test('readBody stops at the limit', async () => {
  const server = http.createServer(async (req, res) => { const r = await readBody(req, 1000); res.writeHead(r.ok ? 200 : r.status, { connection: 'close' }); res.end(r.ok ? String(r.body.length) : 'no'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    assert.equal(await (await fetch(url, { method: 'POST', body: Buffer.alloc(900) })).text(), '900');
    assert.equal((await fetch(url, { method: 'POST', body: Buffer.alloc(5000) })).status, 413); // declared too large
    // chunked (no Content-Length): cut off once the limit is passed
    const status = await new Promise((resolve) => {
      const req = http.request(url, { method: 'POST' }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', () => resolve('reset'));
      let n = 0; const pump = () => { if (n++ < 200 && !req.destroyed) req.write(Buffer.alloc(1024), () => setImmediate(pump)); else req.end(); }; pump();
    });
    assert.ok(status === 413 || status === 'reset');
  } finally { server.closeAllConnections?.(); server.close(); }
});

test('table names from the wire cannot leave their folder', async () => {
  const { safeName, name4 } = await import('./dod.mjs');
  assert.equal(safeName('PLAY'), 'PLAY'); assert.equal(safeName('../x'), '___x'); assert.equal(safeName('a\\b:'), 'a_b_');
  const packed = Buffer.from('x/..', 'latin1').readUInt32BE(0); // name4 reverses: "../x"
  assert.ok(!/[\\/.]/.test(safeName(name4(packed))));
});

test('Sports World in registry mode: every request is tied to the signed-in player', async () => {
  const { startEaswHttp, configureEaswAuth, setLoginIdentity, getMedia } = await import('./easw.mjs');
  const store = new RegistryStore();
  const A = player(800001, 'CoachAlpha', 1), B = player(800002, 'CoachBravo', 2), C = player(800003, 'CoachCharl', 3);
  store.set({ version: 1, players: [A, B, C] });
  const dynasties = { 5: { id: 5, private: true, members: [{ blazeId: 800001 }, { blazeId: 800002 }] } };
  configureEaswAuth({ authenticate: (t) => store.authenticate(t), isActive: (t) => store.isActive(t), dynasties, canSee: (d, uid) => d.members.some((m) => m.blazeId === uid), limits: {} });
  setLoginIdentity({ personaId: 999, onlineId: 'LastLogin' }); // the legacy global identity must play no part
  const server = startEaswHttp({ port: 0, bind: '127.0.0.1', hardened: true, limits: { maxUploadBytes: 2 * 1024 * 1024 } });
  await once(server, 'listening'); const base = `http://127.0.0.1:${server.address().port}`;
  const signIn = (body) => fetch(`${base}/easw/authenticationPS3?version=v2&locale=en_US&skuid=NCA14PS3`, { method: 'POST', body, headers: { 'content-type': 'application/octet-stream' } });
  const call = (token, method, p, body, headers = {}) => fetch(base + p, { method, body, headers: { ...(token ? { 'easw-token': token } : {}), ...headers } });
  const multipart = (parts) => { const b = 'XxBoundaryxX'; return { headers: { 'content-type': `multipart/form-data; boundary=${b}` }, body: Buffer.concat([...parts.map(([name, data]) => Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`), Buffer.from(data), Buffer.from('\r\n')])), Buffer.from(`--${b}--\r\n`)]) }; };
  try {
    // sign-in: only a registered league credential, and the reply names its owner
    const bad = await signIn(ticket(77)); assert.equal(bad.status, 401); assert.equal(bad.headers.get('easw-token'), null);
    assert.equal((await signIn(Buffer.from('2101000000000000', 'hex'))).status, 401);
    const sa = await signIn(ticket(1)), sb = await signIn(ticket(2)), sc = await signIn(ticket(3));
    const ta = sa.headers.get('easw-token'), tb = sb.headers.get('easw-token'), tc = sc.headers.get('easw-token');
    assert.equal(sa.headers.get('easw-userid'), '800001'); assert.equal(sb.headers.get('easw-userid'), '800002'); assert.notEqual(ta, tb);
    const again = await signIn(ticket(1)); // A signs in after B and C: still A, not "the last login"
    assert.equal(again.headers.get('easw-userid'), '800001'); assert.match(await again.text(), /<persona_id>800001</);

    // no token: nothing but the sign-in answers, and an upload is refused before its body is read
    assert.equal((await call(null, 'GET', '/easw/media_content;full')).status, 401);
    assert.equal((await call('f'.repeat(48), 'GET', '/easw/media_content;full')).status, 401);
    assert.equal((await call(null, 'POST', '/easw/personas/800001/sku/NCA14PS3/media', Buffer.alloc(1024 * 1024))).status, 401);

    // A uploads while naming B's persona in the path: the media is A's
    const xml = '<create_media type="MEDIA_CONTAINER" slot="1"><name>Recap</name><description>d</description><attributes><attribute key="CONTAINER_GROUP" value="5"/></attributes></create_media>';
    const up = multipart([['xml', xml], ['container', 'story bytes']]);
    const made = await call(ta, 'POST', '/easw/personas/800002/sku/NCA14PS3/media', up.body, up.headers);
    assert.equal(made.status, 200); const madeXml = await made.text();
    const id = Number(/<media_metadata id="(\d+)"/.exec(madeXml)[1]);
    assert.match(madeXml, /<owner>CoachAlpha<\/owner>/); assert.equal(getMedia(id).ownerId, 800001);

    // B is in the dynasty: can read, cannot change or delete. C is not: cannot even see it.
    assert.equal((await call(tb, 'GET', `/easw/media/${id};full`)).status, 200);
    assert.match(await (await call(tb, 'GET', '/easw/media_content;full?attributes=CONTAINER_GROUP%235')).text(), /count="1"/);
    assert.equal((await call(tb, 'POST', `/easw/media/${id}?http-type=DELETE`)).status, 403);
    assert.equal((await call(tb, 'POST', `/easw/media/${id};full?http-type=PUT`, '<create_media><name>Stolen</name></create_media>')).status, 403);
    assert.equal((await call(tb, 'POST', `/easw/media/${id}/binary/container`, 'overwrite')).status, 403);
    assert.equal(getMedia(id).name, 'Recap');
    assert.equal((await call(tc, 'GET', `/easw/media/${id};full`)).status, 404);
    assert.match(await (await call(tc, 'GET', '/easw/media_content;full')).text(), /count="0"/);
    assert.equal((await call(tc, 'GET', `/easw/media/${id}/binary/1`)).status, 404);

    // binary links work without headers (the console's plain fetch) but only with their signature
    const uri = /uri="([^"]+)"/.exec(madeXml)[1].replace(/&amp;/g, '&');
    assert.match(uri, /\/xms\/binary\/\d+\/1\?k=[0-9a-f]{32}$/);
    assert.equal(await (await fetch(uri)).text(), 'story bytes');
    assert.equal((await fetch(uri.split('?')[0])).status, 403);
    assert.equal((await fetch(uri.replace(/k=.{4}/, 'k=0000'))).status, 403);

    // an upload over the size cap is refused; a broken path does not take the server down
    assert.equal((await call(ta, 'POST', '/easw/personas/800001/sku/NCA14PS3/media', Buffer.alloc(3 * 1024 * 1024))).status, 413);
    assert.ok([400, 500].includes((await call(ta, 'GET', '/easw/%E0%A4%A')).status));

    // revoked in the registry: the token stops working at once
    store.set({ version: 1, players: [{ ...A, disabled: true }, B, C] });
    assert.equal((await call(ta, 'GET', '/easw/media_content;full')).status, 401);
    assert.equal((await signIn(ticket(1))).status, 401);
    assert.equal((await call(tb, 'GET', `/easw/media/${id};full`)).status, 200);
    assert.equal((await call(tb, 'POST', `/easw/media/${id}?http-type=DELETE`)).status, 403); // still A's
    assert.equal(fs.readdirSync(path.join(process.env.NCAA_PRIVATE, 'xms', 'raw')).length, 0); // no request dumps (they would hold credentials)

    // guessing credentials from one address is cut off
    let last = 0; for (let i = 0; i < 12; i++) last = (await signIn(ticket(200 + i))).status;
    assert.equal(last, 429);
  } finally { server.closeAllConnections?.(); server.close(); }
});

test('QoS on the public internet: no amplification toward an address that never connected', async () => {
  const dir = tmpDir('qos'); const port = await freeDualPort(), fw1 = await freeUdpPort(), fw2 = await freeUdpPort();
  const server = startServer('qos.mjs', { env: serverEnv(dir, { NCAA_HARDEN: '1', NCAA_BIND: '127.0.0.1', NCAA_QOS_PORT: String(port), NCAA_QOS_FW1: String(fw1), NCAA_QOS_FW2: String(fw2) }), ready: 'listening on tcp/' });
  const udp = dgram.createSocket('udp4'); udp.bind(0, '127.0.0.1'); await once(udp, 'listening');
  const ask = (msg, to = port) => new Promise((resolve) => { const t = setTimeout(() => { udp.off('message', on); resolve(null); }, 400); const on = (m) => { clearTimeout(t); resolve(m); }; udp.once('message', on); udp.send(msg, to, '127.0.0.1'); });
  const bandwidth = Buffer.alloc(20); bandwidth.writeInt32BE(1234, 4); bandwidth.writeInt32BE(5678, 8); bandwidth.writeInt32BE(0x7fffffff, 12); // the +1 used to overflow and crash
  const ping = Buffer.alloc(20); ping.writeInt32BE(1, 4);
  try {
    await server.up; await sleep(150);
    assert.equal(await ask(Buffer.from('hello')), null); // not a probe: no reply at all
    assert.ok((await ask(bandwidth)).length <= 20); // 20 bytes in, never 1200 out
    assert.equal((await ask(ping)).length, 30); // the ping reply (what the member wizard and the console check) is always whole
    assert.equal((await ask(Buffer.alloc(8, 3), fw1)).length, 8); // firewall echo: same size
    assert.equal(await ask(Buffer.alloc(900, 3), fw1), null);
    // after a real TCP request from this address (which a forged source cannot make) the full replies are sent
    const res = await fetch(`http://127.0.0.1:${port}/qos/qos?qtyp=2`); assert.equal(res.status, 200); assert.match(await res.text(), /<probesize>1200<\/probesize>/);
    assert.equal((await ask(bandwidth)).length, 1200);
    assert.equal((await ask(ping)).length, 30);
    // a large request body is discarded, a bad query does not crash, and the service is still up
    assert.equal((await fetch(`http://127.0.0.1:${port}/qos/firewall?nint=abc`, { method: 'POST', body: Buffer.alloc(2 * 1024 * 1024) })).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/qos/firetype`)).status, 200);
    assert.equal(server.child.exitCode, null);
  } finally { udp.close(); await server.stop(); }
});

test('redirector: garbage and oversized handshakes close that connection only', async (t) => {
  if (!fs.existsSync(path.join(HERE, 'certs', 'gosredirector_mod.crt'))) return t.skip('no certificate in certs/ (run gen-cert.mjs)');
  const dir = tmpDir('redirector'); const port = await freePort();
  const server = startServer('redirector.mjs', { env: serverEnv(dir, { NCAA_HARDEN: '1', NCAA_BIND: '127.0.0.1', NCAA_REDIRECTOR_PORT: String(port) }), ready: 'SSLv3 redirector listening' });
  const poke = (bytes) => new Promise((resolve) => { const s = net.connect(port, '127.0.0.1'); const timer = setTimeout(() => { s.destroy(); resolve('open'); }, 4000); s.on('error', () => {}); s.on('close', () => { clearTimeout(timer); resolve('closed'); }); s.on('connect', () => { for (const b of bytes) s.write(b); }); });
  try {
    await server.up;
    const record = (type, body) => Buffer.concat([Buffer.from([type, 3, 0, body.length >> 8, body.length & 255]), body]);
    const hugeHandshake = Buffer.concat([Buffer.from([1, 0xff, 0xff, 0xff]), Buffer.alloc(16000, 1)]); // ClientHello announcing 16 MB
    assert.equal(await poke([record(22, hugeHandshake), record(22, hugeHandshake), record(22, hugeHandshake), record(22, hugeHandshake), record(22, hugeHandshake)]), 'closed');
    assert.equal(await poke([record(22, Buffer.from([1, 0, 0, 2, 3, 0]))]), 'closed'); // truncated ClientHello
    assert.equal(await poke([record(20, Buffer.from([1])), record(23, Buffer.alloc(40, 9))]), 'closed'); // "encrypted" data before any key exchange
    assert.equal(await poke([record(22, Buffer.from([16, 0, 0, 1, 0]))]), 'closed'); // key exchange with no hello
    assert.equal(await poke([record(22, Buffer.from([20, 0, 0, 1, 0]))]), 'closed'); // Finished with no handshake
    assert.equal(server.child.exitCode, null);
    const alive = net.connect(port, '127.0.0.1'); await once(alive, 'connect'); alive.destroy();
    assert.ok(!/uncaught/.test(server.out.text), server.out.text);
  } finally { await server.stop(); }
});
