// The console name service (dns.mjs): what it answers, what it ignores, and that a reply never outgrows the request.
import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseQuery, buildReply, answer, createLookup, isLeagueName, listenAddresses, RCODE } from './dns.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
function query(name, { type = 1, cls = 1, id = 0x1234, flags = 0x0100, qd = 1, extra = Buffer.alloc(0) } = {}) {
  const head = Buffer.alloc(12); head.writeUInt16BE(id, 0); head.writeUInt16BE(flags, 2); head.writeUInt16BE(qd, 4);
  const labels = name.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, 'latin1')]));
  const tail = Buffer.alloc(4); tail.writeUInt16BE(type, 0); tail.writeUInt16BE(cls, 2);
  return Buffer.concat([head, ...labels, Buffer.from([0]), tail, extra]);
}
const read = (r) => ({ id: r.readUInt16BE(0), qr: r[2] >> 7, rcode: r[3] & 15, an: r.readUInt16BE(6), ip: r.readUInt16BE(6) ? [...r.subarray(r.length - 4)].join('.') : null });
const ctx = (over = {}) => ({ league: () => '203.0.113.7', lookup: async (n) => (n === 'example.org' ? '198.51.100.20' : null), ...over });

test('league names get the league address, in any case, with the question echoed', async () => {
  for (const n of ['gosredirector.ea.com', 'GosRedirector.EA.com', 'reports.tools.gos.ea.com', 'gosca.ea.com', 'ea.com']) {
    const q = query(n), r = await answer(q, ctx());
    assert.deepEqual(read(r), { id: 0x1234, qr: 1, rcode: 0, an: 1, ip: '203.0.113.7' }, n);
    assert.equal(r.length, q.length + 16);
    assert.ok(r.subarray(12, q.length).equals(q.subarray(12)), 'question copied');
  }
  assert.equal(isLeagueName('notea.com'), false); assert.equal(isLeagueName('ea.com.example.org'), false);
});

test('other names are looked up and pass on one address; unknown names do not exist; a failed lookup is a server failure', async () => {
  assert.deepEqual(read(await answer(query('example.org'), ctx())), { id: 0x1234, qr: 1, rcode: 0, an: 1, ip: '198.51.100.20' });
  assert.equal(read(await answer(query('nothing.example'), ctx())).rcode, RCODE.nxdomain);
  assert.equal(read(await answer(query('example.org'), ctx({ lookup: async () => { throw new Error('down'); } }))).rcode, RCODE.servfail);
  assert.equal(read(await answer(query('example.org'), { ...ctx(), forward: false })).rcode, RCODE.refused);
  assert.equal(read(await answer(query('gosredirector.ea.com'), { ...ctx(), forward: false })).ip, '203.0.113.7', 'league names still answered');
  assert.equal(read(await answer(query('gosredirector.ea.com'), ctx({ league: () => null }))).rcode, RCODE.servfail);
});

test('only type A carries data; a reply is never more than the question plus 16 bytes', async () => {
  for (const type of [28, 15, 16, 255, 2, 6]) {
    const q = query('gosredirector.ea.com', { type }), r = await answer(q, ctx());
    assert.deepEqual([read(r).rcode, read(r).an, r.length], [0, 0, q.length], `type ${type}`);
  }
  const big = query('gosredirector.ea.com', { extra: Buffer.alloc(200, 1) }), r = await answer(big, ctx());
  assert.ok(r.length <= big.length, 'what follows the question is dropped, not echoed');
  assert.equal(read(await answer(query('example.org', { cls: 3 }), ctx())).rcode, RCODE.refused);
});

test('what is not one plain question gets no reply', async () => {
  const none = async (b) => assert.equal(await answer(b, ctx()), null);
  await none(Buffer.alloc(5)); await none(Buffer.alloc(600));
  await none(query('example.org', { flags: 0x8180 }));       // a response
  await none(query('example.org', { flags: 0x2800 }));       // another opcode
  await none(query('example.org', { qd: 2 }));
  await none(query('exa mple.org')); await none(query('a'.repeat(64) + '.org'));
  const ptr = query('example.org'); ptr[12] = 0xc0; await none(ptr); // a compression pointer in the question
  assert.equal(parseQuery(query('example.org')).name, 'example.org');
  assert.equal(buildReply(query('x.org'), parseQuery(query('x.org'))).length, query('x.org').length);
});

test('lookups are cached and bounded', async () => {
  let calls = 0, t = 0;
  const lk = createLookup({ resolve4: async (n) => { calls++; if (n === 'gone.example') { const e = new Error('nx'); e.code = 'ENOTFOUND'; throw e; } return ['192.0.2.1', '192.0.2.2']; }, now: () => t, ttlMs: 1000 });
  assert.equal(await lk('a.example'), '192.0.2.1'); assert.equal(await lk('a.example'), '192.0.2.1'); assert.equal(calls, 1);
  t = 2000; await lk('a.example'); assert.equal(calls, 2);
  assert.equal(await lk('gone.example'), null);
  let release; const slow = createLookup({ resolve4: () => new Promise((r) => { release = () => r(['192.0.2.9']); }), maxPending: 1 });
  const first = slow('one.example');
  await assert.rejects(slow('two.example'), /too many/);
  release(); assert.equal(await first, '192.0.2.9');
});

test('listens on the addresses of the machine, not loopback, unless told', () => {
  const ifs = { lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }], ens4: [{ family: 'IPv4', internal: false, address: '10.142.0.2' }, { family: 'IPv6', internal: false, address: 'fe80::1' }] };
  assert.deepEqual(listenAddresses('', ifs), ['10.142.0.2']);
  assert.deepEqual(listenAddresses('127.0.0.1, 10.0.0.5', ifs), ['127.0.0.1', '10.0.0.5']);
});

test('the service answers over UDP and limits one address', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(here, 'dns.mjs'), '--port', String(port), '--bind', '127.0.0.1'], { env: { ...process.env, NCAA_CLOUD: '', NCAA_PUBLIC_HOST: '203.0.113.7', NCAA_DNS_FORWARD: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  try {
    for (let i = 0; i < 100 && !/listening on/.test(out); i++) await new Promise((r) => setTimeout(r, 50));
    assert.match(out, /listening on 127\.0\.0\.1/, out);
    const sock = dgram.createSocket('udp4'); const got = [];
    sock.on('message', (m) => got.push(m));
    const ask = (b) => new Promise((r) => sock.send(b, port, '127.0.0.1', r));
    await ask(query('gosredirector.ea.com', { id: 7 })); await ask(query('example.org', { id: 8 })); await ask(Buffer.from('junk'));
    for (let i = 0; i < 40 && got.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    const by = Object.fromEntries(got.map((m) => [m.readUInt16BE(0), read(m)]));
    assert.equal(by[7].ip, '203.0.113.7'); assert.equal(by[8].rcode, RCODE.refused); assert.equal(got.length, 2);
    got.length = 0;
    for (let i = 0; i < 400; i++) await ask(query('gosredirector.ea.com', { id: 100 + i }));
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(got.length > 50 && got.length <= 200, `rate limit: ${got.length} replies to 400 questions`);
    sock.close();
  } finally { child.kill(); }
});
