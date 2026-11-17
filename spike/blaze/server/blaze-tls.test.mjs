// NCAA_BLAZE_TLS: the game port behind the game's own SSLv3 (sslv3-server.mjs), and the redirector's SECU answer that
// tells the game to use it. Real processes on OS-picked loopback ports, temp state. Never the live league.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { once } from 'node:events';
import { MSG, PacketStream, encodePacket } from './packet.mjs';
import { decode } from './tdf.mjs';
import { tmpDir, freePort, serverEnv, startServer, blazeClient, sslv3Connect, sslv3Request, ticket, player, until, sleep, HERE } from './testkit.mjs';

const ERR = MSG.ERROR, OK = MSG.RESPONSE;
const HAVE_CERT = fs.existsSync(path.join(HERE, 'certs', 'gosredirector_mod.crt')) && fs.existsSync(path.join(HERE, 'certs', 'gosredirector.key.pem'));
const NO_CERT = 'no certificate in certs/ (run gen-cert.mjs)';
const within = (promise, ms, what) => Promise.race([promise, sleep(ms).then(() => { throw new Error(what); })]);
// a public-server profile with a member list in a file: limits on, one member (user 101, credential 1)
async function cloudEnv(name, extra = {}) {
  const dir = tmpDir(name), file = path.join(dir, 'registry.json'), blazePort = await freePort();
  fs.writeFileSync(file, JSON.stringify({ version: 1, players: [player(101, 'LocalOne', 1)] }));
  const env = serverEnv(dir, { NCAA_CLOUD: '1', NCAA_PUBLIC_HOST: '127.0.0.1', NCAA_BIND: '127.0.0.1', NCAA_REGISTRY_SYNC: 'off', NCAA_REGISTRY_FILE: file,
    NCAA_BLAZE_PORT: String(blazePort), NCAA_LOCKER_PORT: String(await freePort()), NCAA_CONNS_PER_MIN_PER_IP: '1000', ...extra });
  return { dir, env, blazePort };
}
// a raw TCP connection: what came back, and when the server closed it
async function rawClient(port) {
  const sock = net.connect(port, '127.0.0.1'); sock.on('error', () => {});
  const got = []; sock.on('data', (d) => got.push(d));
  const closed = new Promise((resolve) => sock.once('close', () => resolve(true)));
  await once(sock, 'connect');
  return { sock, closed, received: () => Buffer.concat(got) };
}

test('NCAA_BLAZE_TLS=on: a console that completes the handshake signs in; every limit of the plaintext port still applies', async (t) => {
  if (!HAVE_CERT) return t.skip(NO_CERT);
  const { env, blazePort } = await cloudEnv('tls-on', { NCAA_BLAZE_TLS: 'on', NCAA_BLAZE_TLS_HANDSHAKE_SECONDS: '3', NCAA_MAX_CONNS_PER_IP: '4' });
  const server = startServer('blaze.mjs', { env, ready: 'blaze stub listening' });
  try {
    await server.up;
    assert.match(server.out.text, /blaze stub listening on 127\.0\.0\.1:\d+ \(encrypted: SSLv3, NCAA_BLAZE_TLS on\)/);

    // --- the encrypted sign-in ---
    const c = await blazeClient(blazePort, { tls: true });
    assert.equal(c.suite, 'RC4-SHA');
    const pre = await c.call(9, 7); // preAuth, as a console sends first
    assert.equal(pre.type, OK); assert.equal(pre.body.PLAT, 'ps3');
    assert.equal((await c.call(9, 8)).type, ERR, 'not signed in: the same refusal as on the plaintext port');
    assert.equal((await c.login(ticket(9))).type, ERR, 'a credential that is not in the member list');
    const login = await c.login(ticket(1));
    assert.equal(login.type, OK); assert.equal(Number(login.body.SESS.UID), 101);
    assert.equal((await c.call(9, 8)).type, OK, 'signed in: postAuth answers');
    await until(() => /encrypted connection from 127\.0\.0\.1 \(SSLv3 RC4-SHA\)/.test(server.out.text), { what: 'the handshake log line' });
    assert.match(server.out.text, /ps3Login for LocalOne \(user 101, service [^)]*\) over an encrypted connection \(SSLv3 RC4-SHA\)/);

    // --- limits, through the encrypted path (the log lines for the refusals below are checked in the local-server
    // test further down: here an outsider's lines are limited to ten a minute per address) ---
    // a packet over the few KB allowed before sign-in: dropped on its header
    const big = await blazeClient(blazePort, { tls: true });
    big.write(encodePacket({ component: 9, command: 7, id: 1, type: MSG.REQUEST, payload: Buffer.alloc(8192) }));
    await within(big.closed, 3000, 'an oversized packet before sign-in was not dropped');
    await until(() => /packet of 8192 bytes exceeds the 4096-byte limit before sign-in/.test(server.out.text), { what: 'the size-limit log line' });
    // a record that fails its check value (tampered or made up): closed
    const forged = await sslv3Connect(blazePort);
    forged.sock.write(Buffer.concat([Buffer.from([23, 3, 0, 0, 40]), Buffer.alloc(40, 7)]));
    await within(once(forged.sock, 'close'), 3000, 'a record with a bad MAC was not refused');

    // --- plaintext on the encrypted port: nothing comes back, and the connection is closed at once ---
    const t0 = Date.now();
    const plain = await rawClient(blazePort);
    plain.sock.write(encodePacket({ component: 9, command: 7, id: 1, type: MSG.REQUEST }));
    plain.sock.write(encodePacket({ component: 1, command: 200, id: 2, type: MSG.REQUEST, payload: Buffer.alloc(0) }));
    await within(plain.closed, 2500, 'plaintext Blaze bytes were not refused');
    assert.ok(Date.now() - t0 < 2500, 'closed by the record check, not by the handshake timeout');
    assert.equal(plain.received().length, 0, 'not one byte is sent to a client that does not speak SSL');
    const viaClient = await blazeClient(blazePort); // the ordinary test client, as used against a plaintext server
    await assert.rejects(viaClient.login(ticket(1)), /connection closed/);

    // --- the connection cap counts encrypted connections, and a handshake that stalls is closed ---
    const silent = await rawClient(blazePort); // connects, says nothing
    const half = await rawClient(blazePort); // starts a handshake (a ClientHello), never continues
    half.sock.write(Buffer.concat([Buffer.from([22, 3, 0, 0, 45, 1, 0, 0, 41, 3, 0]), Buffer.alloc(32, 1), Buffer.from([0, 0, 2, 0, 5, 1, 0])]));
    const third = await rawClient(blazePort); // with the signed-in console: four open, the limit
    const fifth = await rawClient(blazePort);
    await within(fifth.closed, 2000, 'a connection over the per-address limit was not refused');
    await within(Promise.all([silent.closed, half.closed, third.closed]), 8000, 'a stalled handshake was not closed');
    assert.ok(half.received().length > 0, 'the half-open one did get a ServerHello before it stalled');

    // none of that touched the signed-in console or the process
    assert.equal(server.child.exitCode, null);
    assert.equal((await c.call(9, 2)).type, OK);
    assert.ok(!/uncaught|handler error/.test(server.out.text), server.out.text);
  } finally { await server.stop(); }
});

test('NCAA_BLAZE_TLS unset or off: the plaintext port, exactly as before', async (t) => {
  for (const extra of [{}, { NCAA_BLAZE_TLS: 'off' }]) {
    const { env, blazePort } = await cloudEnv('tls-off', extra);
    const server = startServer('blaze.mjs', { env, ready: 'blaze stub listening' });
    try {
      await server.up;
      assert.match(server.out.text, /blaze stub listening on 127\.0\.0\.1:\d+ \(plaintext\)/);
      const c = await blazeClient(blazePort);
      assert.equal((await c.call(9, 7)).type, OK);
      const login = await c.login(ticket(1));
      assert.equal(login.type, OK); assert.equal(Number(login.body.SESS.UID), 101);
      await until(() => /ps3Login for LocalOne \(user 101, service [^)]*\)\s*$/m.test(server.out.text), { what: 'the unchanged sign-in log line' });
      assert.ok(!/encrypted/.test(server.out.text), 'nothing about encryption in the log');
      if (HAVE_CERT) await assert.rejects(sslv3Connect(blazePort), 'a plaintext port does not answer an SSL handshake');
      assert.equal((await c.call(9, 2)).type, OK);
    } finally { await server.stop(); }
  }
});

test('--blaze-tls: the flag wins over the environment, and works on a local server without a member list', async (t) => {
  if (!HAVE_CERT) return t.skip(NO_CERT);
  const start = async (extra, args) => {
    const dir = tmpDir('tls-flag'), port = await freePort();
    const server = startServer('blaze.mjs', { env: serverEnv(dir, extra), ready: 'blaze stub listening', args: ['--port', String(port), '--http-port', String(await freePort()), ...args] });
    await server.up; return { server, port };
  };
  const on = await start({ NCAA_BLAZE_TLS_HANDSHAKE_SECONDS: '2' }, ['--blaze-tls', 'on']);
  try {
    assert.match(on.server.out.text, /\(encrypted: SSLv3, NCAA_BLAZE_TLS on\)/);
    const c = await blazeClient(on.port, { tls: true });
    assert.equal((await c.call(9, 7)).body.PLAT, 'ps3');
    const plain = await blazeClient(on.port);
    await assert.rejects(plain.call(9, 7), /connection closed/);
    await until(() => /ssl error \(127\.0\.0\.1\): record processing failed: not an SSLv3 record/.test(on.server.out.text), { what: 'the refusal log line' });
    // each way a connection is refused says why in the log (no limits on a local server, so every line is written)
    const forged = await sslv3Connect(on.port);
    forged.sock.write(Buffer.concat([Buffer.from([23, 3, 0, 0, 40]), Buffer.alloc(40, 7)]));
    await within(once(forged.sock, 'close'), 3000, 'a record with a bad MAC was not refused');
    await until(() => /record processing failed: client MAC mismatch/.test(on.server.out.text), { what: 'the MAC log line' });
    const silent = net.connect(on.port, '127.0.0.1'); silent.on('error', () => {});
    await within(once(silent, 'close'), 6000, 'a silent connection was not closed');
    await until(() => /closing 127\.0\.0\.1: no SSL handshake within 2s/.test(on.server.out.text), { what: 'the handshake-timeout log line' });
    assert.equal((await c.call(9, 2)).type, OK, 'the console that did the handshake is still connected');
  } finally { await on.server.stop(); }
  const off = await start({ NCAA_BLAZE_TLS: 'on' }, ['--blaze-tls', 'off']);
  try {
    assert.match(off.server.out.text, /\(plaintext\)/);
    assert.equal((await (await blazeClient(off.port)).call(9, 7)).type, OK);
  } finally { await off.server.stop(); }
});

test('redirector: SECU 1 when the game port is encrypted, SECU 0 otherwise', async (t) => {
  if (!HAVE_CERT) return t.skip(NO_CERT);
  const ask = async (extra, args = []) => {
    const dir = tmpDir('tls-redir'), port = await freePort();
    const server = startServer('redirector.mjs', { env: serverEnv(dir, { NCAA_BIND: '127.0.0.1', NCAA_REDIRECTOR_PORT: String(port), NCAA_BLAZE_PORT: '33999', ...extra }), args, ready: 'SSLv3 redirector listening' });
    try {
      await server.up;
      const reply = await sslv3Request(port, encodePacket({ component: 5, command: 1, id: 7, type: MSG.REQUEST }));
      const [p] = new PacketStream().feed(reply); assert.equal(p.type, MSG.RESPONSE);
      const body = decode(p.payload);
      assert.deepEqual(body.ADDR.VALU, { HOST: '127.0.0.1', IP: 0x7f000001, PORT: 33999 }, 'the address does not change with the setting');
      await until(() => /getServerInstance response/.test(server.out.text), { what: 'the reply log line' });
      return { secu: Number(body.SECU), log: server.out.text };
    } finally { await server.stop(); }
  };
  const dflt = await ask({});
  assert.equal(dflt.secu, 0); assert.match(dflt.log, /\(plaintext Blaze\)/); assert.ok(!/told to encrypt/.test(dflt.log));
  assert.equal((await ask({ NCAA_BLAZE_TLS: 'off' })).secu, 0);
  const on = await ask({ NCAA_BLAZE_TLS: 'on' });
  assert.equal(on.secu, 1); assert.match(on.log, /\(encrypted Blaze, SECU 1\)/); assert.match(on.log, /told to encrypt that connection \(NCAA_BLAZE_TLS on, SECU 1\)/);
  assert.equal((await ask({}, ['--blaze-tls', 'on'])).secu, 1);
  assert.equal((await ask({ NCAA_BLAZE_TLS: 'on' }, ['--blaze-tls', 'off'])).secu, 0, 'the flag wins');
  // cloud mode reads the same setting
  assert.equal((await ask({ NCAA_CLOUD: '1', NCAA_PUBLIC_HOST: '127.0.0.1', NCAA_BLAZE_TLS: '1' })).secu, 1);
});

test('NCAA_BLAZE_TLS: a value that is not on or off, or a certificate that cannot be read, stops the service (exit 78)', async () => {
  const dir = tmpDir('tls-config');
  const run = async (script, extra, args = []) => { const s = startServer(script, { env: serverEnv(dir, extra), args }); const code = await Promise.race([s.exited, sleep(8000).then(async () => { await s.stop(); return 'still running'; })]); return { code, text: s.out.text }; };
  const ports = async () => ({ NCAA_BLAZE_PORT: String(await freePort()), NCAA_LOCKER_PORT: String(await freePort()), NCAA_REDIRECTOR_PORT: String(await freePort()) });
  for (const [script, extra, args] of [
    ['blaze.mjs', { NCAA_BLAZE_TLS: 'on # try it' }, []],
    ['redirector.mjs', { NCAA_BLAZE_TLS: 'maybe' }, []],
    ['blaze.mjs', {}, ['--blaze-tls', 'yes please']],
    ['redirector.mjs', {}, ['--blaze-tls', '2']],
  ]) {
    const r = await run(script, { ...(await ports()), ...extra }, args);
    assert.equal(r.code, 78, `${script}: ${r.text}`);
    assert.match(r.text, /cannot start: (NCAA_BLAZE_TLS|--blaze-tls) must be on or off/);
    assert.ok(!/listening/.test(r.text), 'nothing listens');
  }
  // on, but no certificate where NCAA_CERT_DIR points: a clear line, not an open plaintext port
  const empty = path.join(dir, 'no-certs'); fs.mkdirSync(empty, { recursive: true });
  const r = await run('blaze.mjs', { ...(await ports()), NCAA_BLAZE_TLS: 'on', NCAA_CERT_DIR: empty });
  assert.equal(r.code, 78, r.text);
  assert.match(r.text, /cannot start: NCAA_BLAZE_TLS is on but the certificate files are not readable/);
  assert.ok(!/blaze stub listening/.test(r.text));
});
