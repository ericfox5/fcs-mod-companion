// Shared by the *.test.mjs files: temp folders, free ports, a spawned server, a tiny Blaze client and a fake site.
// Nothing here touches the real league: every server gets its own NCAA_PRIVATE and HOME (so the bridge config and its
// token are never read) and ports picked by the OS.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import dgram from 'node:dgram';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { MAGIC, digest } from './league-auth.mjs';
import { Writer, decode } from './tdf.mjs';
import { PacketStream, encodePacket, MSG } from './packet.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const tmpDir = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `ncaa-${name}-`));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function freePort() { const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise((r) => s.close(r)); return p; }
export async function freeUdpPort() { const s = dgram.createSocket('udp4'); s.bind(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise((r) => s.close(r)); return p; }
// A port that is free for TCP and for UDP (the QoS service binds both). On Windows a port can be free for TCP and still
// be refused for UDP (reserved ranges), so both are tried.
export async function freeDualPort() {
  for (let i = 0; i < 50; i++) {
    const p = await freePort();
    const u = dgram.createSocket('udp4');
    const ok = await new Promise((resolve) => { u.once('error', () => resolve(false)); u.bind(p, '127.0.0.1', () => resolve(true)); });
    await new Promise((r) => { try { u.close(r); } catch { r(); } });
    if (ok) return p;
  }
  throw new Error('no port free for both TCP and UDP');
}
export const ticket = (n) => Buffer.concat([MAGIC, Buffer.alloc(64, n)]);
export const player = (userId, onlineId, n, extra = {}) => ({ userId, onlineId, ticketSha256: digest(ticket(n)), joinDynasties: [], disabled: false, ...extra });
export async function until(check, { timeoutMs = 8000, stepMs = 50, what = 'condition' } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) { const v = await check(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(stepMs); }
}

// A clean environment for a spawned server: no inherited NCAA_* settings, a private state folder, an empty home.
// Sports World is on by default in the server and would bind its fixed port 17504 (taken when a league runs on this
// PC), so tests switch it off unless they ask for it.
export function serverEnv(dir, extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^NCAA_/i.test(k)));
  const home = path.join(dir, 'home'); fs.mkdirSync(home, { recursive: true });
  return { ...env, HOME: home, USERPROFILE: home, NCAA_PRIVATE: path.join(dir, 'private'), NCAA_SUPERSIM: 'off', NCAA_CAPTURE: 'off', NCAA_EASW: 'off', ...extra };
}
// Starts `node <script>` and collects its output. ready: text that means it is up.
export function startServer(script, { env, args = [], ready }) {
  const child = spawn(process.execPath, [path.join(HERE, script), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { text: '' };
  child.stdout.on('data', (d) => { out.text += d; }); child.stderr.on('data', (d) => { out.text += d; });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  const up = ready ? Promise.race([
    until(() => out.text.includes(ready), { timeoutMs: 15000, what: `"${ready}" from ${script}` }),
    exited.then((code) => { throw new Error(`${script} exited ${code}: ${out.text}`); }),
  ]) : Promise.resolve();
  const stop = async () => { if (child.exitCode === null) { child.kill(); await exited; } };
  return { child, out, exited, up, stop };
}

// One Blaze connection: call(component, command, build) -> { type, body }; closed resolves when the server drops it.
export async function blazeClient(port) {
  const sock = net.connect(port, '127.0.0.1'); await once(sock, 'connect');
  const stream = new PacketStream(), pending = new Map(); let id = 1;
  const closed = new Promise((resolve) => sock.once('close', () => { for (const j of pending.values()) { clearTimeout(j.timer); j.reject(new Error('connection closed')); } pending.clear(); resolve(true); }));
  sock.on('error', () => {});
  sock.on('data', (data) => { for (const p of stream.feed(data)) { const job = pending.get(p.id); if (job && p.type !== MSG.NOTIFY) { pending.delete(p.id); clearTimeout(job.timer); job.resolve({ type: p.type, error: p.error, body: decode(p.payload) }); } } });
  const call = (component, command, build) => { const w = new Writer(); build?.(w); const seq = id++; return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(seq); reject(new Error(`timeout ${component}/${command}`)); }, 5000); pending.set(seq, { resolve, reject, timer });
    sock.write(encodePacket({ component, command, id: seq, type: MSG.REQUEST, payload: w.bytes() })); }); };
  const login = (t) => call(1, 200, (w) => w.blob('TCKT', t));
  return { sock, call, login, closed, isClosed: () => sock.destroyed };
}

// A stand-in for the website's registry endpoint. state.registry is what it serves; state.mode changes its behaviour.
export async function fakeSite(token, initial) {
  const state = { registry: initial, mode: 'ok', hits: 0, etagHits: 0, lastAuth: '' };
  const server = http.createServer((req, res) => {
    state.hits++; state.lastAuth = req.headers.authorization ?? '';
    if (req.url.split('?')[0] !== '/api/bridge/league-registry') { res.writeHead(404); return res.end('{}'); }
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); return res.end('{"error":"unauthorized"}'); }
    if (state.mode === 'error') { res.writeHead(500); return res.end('boom'); }
    if (state.mode === 'garbage') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"version":1,"players":[{"userId":'); }
    const text = typeof state.registry === 'string' ? state.registry : JSON.stringify(state.registry);
    const etag = `"${digest(Buffer.from(text)).slice(0, 16)}"`;
    if (req.headers['if-none-match'] === etag) { state.etagHits++; res.writeHead(304, { etag }); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json', etag }); res.end(text);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  const close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
  return { state, url: `http://127.0.0.1:${port}`, port, close };
}

// A tiny SSLv3 client (same primitives as sslv3-selftest.mjs): handshake, send one application record, return the reply.
export async function sslv3Request(port, payload) {
  const crypto = (await import('node:crypto')).default;
  const { REC, HS, u24 } = await import('./sslv3-server.mjs');
  const { RC4, SUITES, masterSecret, keyBlock, sslMac, finishedHash, SENDER_CLIENT } = await import('./sslv3-crypto.mjs');
  const sock = net.connect(port, '127.0.0.1'); await once(sock, 'connect');
  try {
    const suite = SUITES[0x0005], clientRandom = crypto.randomBytes(32), transcript = [];
    const hs = (type, body) => { const m = Buffer.concat([Buffer.from([type]), u24(body.length), body]); if (type !== HS.FINISHED) transcript.push(m); return m; };
    const record = (type, frag) => Buffer.concat([Buffer.from([type, 3, 0, frag.length >> 8, frag.length & 255]), frag]);
    let rx = Buffer.alloc(0); const records = [];
    sock.on('data', (d) => { rx = Buffer.concat([rx, d]); while (rx.length >= 5) { const len = rx.readUInt16BE(3); if (rx.length < 5 + len) break; records.push({ type: rx[0], frag: Buffer.from(rx.subarray(5, 5 + len)) }); rx = rx.subarray(5 + len); } });
    const next = () => until(() => records.shift(), { timeoutMs: 5000, stepMs: 5, what: 'an SSLv3 record' });
    sock.write(record(REC.HANDSHAKE, hs(HS.CLIENT_HELLO, Buffer.concat([Buffer.from([3, 0]), clientRandom, Buffer.from([0, 0, 2, 0, 5, 1, 0])]))));
    let hsBuf = Buffer.alloc(0); const msgs = [];
    while (msgs.length < 3) { const r = await next(); hsBuf = Buffer.concat([hsBuf, r.frag]); while (hsBuf.length >= 4) { const len = hsBuf.readUIntBE(1, 3); if (hsBuf.length < 4 + len) break; msgs.push(Buffer.from(hsBuf.subarray(0, 4 + len))); hsBuf = hsBuf.subarray(4 + len); } }
    for (const m of msgs) transcript.push(m);
    const serverRandom = msgs[0].subarray(6, 38), certLen = msgs[1].readUIntBE(7, 3), cert = msgs[1].subarray(10, 10 + certLen);
    const pre = Buffer.concat([Buffer.from([3, 0]), crypto.randomBytes(46)]);
    sock.write(record(REC.HANDSHAKE, hs(HS.CKE, crypto.publicEncrypt({ key: new crypto.X509Certificate(cert).publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, pre))));
    const master = masterSecret(pre, clientRandom, serverRandom), kb = keyBlock(master, serverRandom, clientRandom, 2 * suite.macLen + 2 * suite.keyLen);
    let o = 0; const cMac = kb.subarray(o, o += suite.macLen); o += suite.macLen; const enc = new RC4(kb.subarray(o, o += suite.keyLen)), dec = new RC4(kb.subarray(o, o += suite.keyLen));
    let cSeq = 0; const sendSecure = (type, data) => sock.write(record(type, enc.process(Buffer.concat([data, sslMac(suite.mac, cMac, cSeq++, type, data)]))));
    sock.write(record(REC.CCS, Buffer.from([1])));
    sendSecure(REC.HANDSHAKE, hs(HS.FINISHED, finishedHash(master, Buffer.concat(transcript), SENDER_CLIENT)));
    await next(); const fin = await next(); dec.process(fin.frag); // server CCS + Finished
    sendSecure(REC.APP, payload);
    const app = await next(); const pt = dec.process(app.frag);
    return pt.subarray(0, pt.length - suite.macLen);
  } finally { sock.destroy(); }
}
