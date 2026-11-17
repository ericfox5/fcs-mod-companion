// Name service for real consoles. A PS3 has no "IP swap list": it asks whatever DNS server its network settings name
// for gosredirector.ea.com. A member sets this server as the console's primary DNS, and it answers
//   - every name under ea.com (gosredirector.ea.com, gosca.ea.com, reports.tools.gos.ea.com, ...) with the league
//     server's own public IPv4 address, so the game finds the league and never reaches EA;
//   - every other name by looking it up itself and passing on ONE address, so the console keeps working normally.
//   udp/53   node dns.mjs [--port 53] [--bind ADDRESS[,ADDRESS]]
// Environment (a flag wins): NCAA_DNS_PORT, NCAA_DNS_BIND, NCAA_DNS_FORWARD (on|off, default on), NCAA_PUBLIC_HOST.
//
// A public UDP answering service is a reflection target (a forged source address gets the reply). So:
//   - only one kind of question is answered with data: one question, type A, class IN. Everything else gets an empty
//     answer the size of the question (AAAA, MX, ...) or no reply at all (not a query, several questions, junk);
//   - a reply is the question plus at most one 16-byte address record, never larger: about 1.5 times the request;
//   - each address gets a bounded number of replies per ten seconds, and lookups for other names are bounded in number.
// There is no TCP side: no reply is ever too long for UDP.
import dgram from 'node:dgram';
import dns from 'node:dns';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './log.mjs';
import { cloudSettings, createAdvertiser, fatalConfig, parseSwitch, port } from './cloud-config.mjs';
import { createRateLimiter, installProcessGuards } from './net-guard.mjs';

export const TYPE_A = 1, CLASS_IN = 1;
export const RCODE = { ok: 0, servfail: 2, nxdomain: 3, refused: 5 };

// One standard query with exactly one question -> { id, rd, name, type, cls, end } (end = offset after the question);
// null for anything else. Names are lower-cased; compression pointers are not valid in a question and are refused.
export function parseQuery(msg) {
  if (!Buffer.isBuffer(msg) || msg.length < 17 || msg.length > 512) return null;
  const flags = msg.readUInt16BE(2);
  if (flags & 0x8000) return null;            // a response, not a query
  if ((flags >> 11) & 0xf) return null;       // not a standard query
  if (msg.readUInt16BE(4) !== 1 || msg.readUInt16BE(6) !== 0 || msg.readUInt16BE(8) !== 0) return null;
  const labels = []; let o = 12, total = 0;
  for (;;) {
    if (o >= msg.length) return null;
    const n = msg[o++];
    if (n === 0) break;
    if (n > 63 || o + n > msg.length) return null;
    total += n + 1; if (total > 254) return null;
    const label = msg.toString('latin1', o, o + n);
    if (!/^[A-Za-z0-9_-]+$/.test(label)) return null;
    labels.push(label.toLowerCase()); o += n;
  }
  if (!labels.length || o + 4 > msg.length) return null;
  return { id: msg.readUInt16BE(0), rd: !!(flags & 0x0100), name: labels.join('.'), type: msg.readUInt16BE(o), cls: msg.readUInt16BE(o + 2), end: o + 4 };
}

// The reply to a parsed query: the header and question copied from the request, then zero or one A record.
// Anything after the question in the request (an EDNS record) is dropped, so the reply never grows with it.
export function buildReply(msg, q, { rcode = RCODE.ok, address = null, ttl = 60 } = {}) {
  const out = Buffer.alloc(q.end + (address ? 16 : 0));
  msg.copy(out, 0, 0, q.end);
  out.writeUInt16BE(0x8000 | (q.rd ? 0x0100 : 0) | 0x0080 | (rcode & 0xf), 2); // QR, RD as asked, RA
  out.writeUInt16BE(1, 4); out.writeUInt16BE(address ? 1 : 0, 6); out.writeUInt16BE(0, 8); out.writeUInt16BE(0, 10);
  if (address) {
    let o = q.end;
    out.writeUInt16BE(0xc00c, o); o += 2;      // the name: a pointer to the question
    out.writeUInt16BE(TYPE_A, o); o += 2; out.writeUInt16BE(CLASS_IN, o); o += 2;
    out.writeUInt32BE(ttl >>> 0, o); o += 4; out.writeUInt16BE(4, o); o += 2;
    address.split('.').forEach((b, i) => { out[o + i] = Number(b); });
  }
  return out;
}

export const isLeagueName = (name) => name === 'ea.com' || name.endsWith('.ea.com');
const isIPv4 = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s) && s.split('.').every((n) => Number(n) <= 255);

// What to send back for one packet. `league()` gives the league address (or null while unknown), `lookup(name)`
// resolves another name to an IPv4 address (or null = no such name; it throws when the lookup itself failed).
// Returns a Buffer, or null for no reply.
export async function answer(msg, { league, lookup, forward = true }) {
  const q = parseQuery(msg);
  if (!q) return null;
  if (q.cls !== CLASS_IN) return buildReply(msg, q, { rcode: RCODE.refused });
  if (q.type !== TYPE_A) return buildReply(msg, q);               // no such record here: empty answer
  if (isLeagueName(q.name)) {
    const ip = league();
    return ip ? buildReply(msg, q, { address: ip, ttl: 60 }) : buildReply(msg, q, { rcode: RCODE.servfail });
  }
  if (!forward) return buildReply(msg, q, { rcode: RCODE.refused });
  try {
    const ip = await lookup(q.name);
    return ip && isIPv4(ip) ? buildReply(msg, q, { address: ip, ttl: 60 }) : buildReply(msg, q, { rcode: RCODE.nxdomain });
  } catch { return buildReply(msg, q, { rcode: RCODE.servfail }); }
}

// A small cache in front of the system resolver, with a cap on lookups in flight (a flood of made-up names must not
// queue without bound). null = the name does not exist.
export function createLookup({ resolve4 = (n) => dns.promises.resolve4(n), ttlMs = 60000, maxEntries = 5000, maxPending = 200, now = Date.now } = {}) {
  const cache = new Map(), pending = new Map();
  return async (name) => {
    const hit = cache.get(name);
    if (hit && now() - hit.at < ttlMs) return hit.ip;
    if (pending.has(name)) return pending.get(name);
    if (pending.size >= maxPending) throw new Error('too many lookups in flight');
    const p = (async () => {
      let ip = null;
      try { ip = (await resolve4(name))[0] ?? null; }
      catch (e) { if (!['ENOTFOUND', 'ENODATA', 'NXDOMAIN'].includes(e?.code)) throw e; }
      if (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
      cache.set(name, { ip, at: now() });
      return ip;
    })().finally(() => pending.delete(name));
    pending.set(name, p);
    return p;
  };
}

// The addresses to listen on: every IPv4 address of this machine that is not loopback, each on its own socket. Not
// 0.0.0.0, because Ubuntu's own resolver already holds 127.0.0.53:53 and a wildcard bind would collide with it.
export function listenAddresses(setting, interfaces = os.networkInterfaces()) {
  if (setting) return String(setting).split(',').map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const list of Object.values(interfaces)) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  return out;
}

async function main() {
  let cfg, PORT, FORWARD, ADDRS;
  try {
    cfg = cloudSettings({ needRegistry: false });
    PORT = port('--port', 'NCAA_DNS_PORT', 53);
    FORWARD = parseSwitch('NCAA_DNS_FORWARD', process.env.NCAA_DNS_FORWARD, true);
    const i = process.argv.indexOf('--bind');
    ADDRS = listenAddresses(i >= 0 ? process.argv[i + 1] : process.env.NCAA_DNS_BIND);
    if (!ADDRS.length) throw new Error('no network address to listen on (set NCAA_DNS_BIND)');
    if (!cfg.publicHost) throw new Error('NCAA_PUBLIC_HOST is not set: the name service answers with that address');
  } catch (e) { fatalConfig('dns', e); }
  installProcessGuards((m) => log('dns', m));
  // the league address: NCAA_PUBLIC_HOST, resolved here and re-resolved every few minutes
  let advertiser = null;
  const start = async () => { try { advertiser = await createAdvertiser(cfg.publicHost, 'ip', { onChange: (ip) => log('dns', `league address is now ${ip}`) }); } catch (e) { log('dns', `cannot resolve ${cfg.publicHost} yet (${e.message}); retrying`); setTimeout(start, 30000).unref?.(); } };
  await start();
  const league = () => { const ip = advertiser ? advertiser.ip() : null; return ip && isIPv4(ip) ? ip : null; };
  const lookup = createLookup();
  const rate = createRateLimiter({ limit: 200, windowMs: 10000, maxKeys: 100000 });
  const counts = { league: 0, other: 0, dropped: 0, limited: 0 };
  for (const addr of ADDRS) {
    const sock = dgram.createSocket('udp4');
    sock.on('error', (e) => { log('dns', `cannot listen on ${addr}:${PORT}: ${e.message}`); process.exit(e.code === 'EACCES' || e.code === 'EADDRINUSE' ? 78 : 1); });
    sock.on('message', async (msg, rinfo) => {
      try {
        if (!rate.hit(rinfo.address)) { counts.limited++; return; }
        const out = await answer(msg, { league, lookup, forward: FORWARD });
        if (!out) { counts.dropped++; return; }
        if (out.length > msg.length + 16) return; // cannot happen; the reflection bound, stated once more
        const q = parseQuery(msg); if (q && isLeagueName(q.name)) counts.league++; else counts.other++;
        sock.send(out, rinfo.port, rinfo.address);
      } catch (e) { log('dns', `error: ${e.message}`); }
    });
    sock.bind(PORT, addr, () => log('dns', `listening on ${addr}:${PORT} (udp); ea.com names -> ${league() ?? 'not known yet'}; other names ${FORWARD ? 'looked up' : 'refused'}`));
  }
  setInterval(() => { if (counts.league || counts.other || counts.limited) log('dns', `last hour: ${counts.league} league answers, ${counts.other} other answers, ${counts.dropped} ignored, ${counts.limited} over the limit`); counts.league = counts.other = counts.dropped = counts.limited = 0; }, 3600000).unref?.();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
