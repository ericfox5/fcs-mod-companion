// QoS ping-site stand-in, following the DirtySock QosApi used by 2010-2013 EA titles (reference: Skateboard3Server.Qos).
//   udp/17502  ping probes (requestId 1, secret 0): echo 20 bytes + client external IPv4 (4) + port (2) + 4 zero bytes
//              bandwidth probes: echo header, [12] requestCount+1, [16] totalCount (little-endian), constants, pad to 1200
//   udp/17500, udp/17501  firewall probes: 8-byte [requestId][requestSecret] echo
//   tcp/17502  HTTP /qos/qos, /qos/firewall, /qos/firetype -> XML (lists are nested: the client reads .ips.ips / .ports.ports)
//   node qos.mjs [--port 17502] [--fw1 17500] [--fw2 17501]
// Environment (a flag wins): NCAA_QOS_PORT, NCAA_QOS_FW1, NCAA_QOS_FW2, NCAA_BIND.
//
// On the public internet (NCAA_CLOUD=1 or NCAA_HARDEN=1) a UDP responder is a reflection target: anyone can send a
// packet with a forged source address and the reply goes to the victim. So here:
//   - a reply is never more than twice the size of the request (the 30-byte ping reply to a 20-byte probe is allowed)
//     unless that address talked to the HTTP side (TCP, cannot be forged) in the last five minutes, which is what a
//     real console does before it sends bandwidth probes;
//   - packets that are not a known probe get no reply;
//   - each address gets a bounded number of replies per ten seconds.
import dgram from 'node:dgram';
import http from 'node:http';
import { log } from './log.mjs';
import { cloudSettings, bindSettings, fatalConfig, port } from './cloud-config.mjs';
import { createConnectionGuard, createRateLimiter, hardenHttpServer, installProcessGuards, exitOnListenError, clientIp } from './net-guard.mjs';

let cfg, PORT, FW_PORTS, BIND;
try {
  cfg = cloudSettings({ needRegistry: false });
  // this PC only unless cloud mode, a registry, or --lan / NCAA_LAN=on says otherwise (cloud-config.mjs bindSettings)
  ({ bind: BIND } = bindSettings({ cloud: cfg.cloud, registry: !!cfg.registryFile }));
  PORT = port('--port', 'NCAA_QOS_PORT', 17502);
  FW_PORTS = [port('--fw1', 'NCAA_QOS_FW1', 17500), port('--fw2', 'NCAA_QOS_FW2', 17501)];
} catch (e) { fatalConfig('qos', e); }
const HARD = cfg.hardened, QUIET = cfg.cloud;
installProcessGuards((m) => log('qos', m));
log('qos', cfg.cloud ? 'mode: cloud (limits on)' : `mode: local${HARD ? ' (limits on)' : ''}, listening on ${BIND}`);
const ip4 = (addr) => { const parts = clientIp(addr).split('.').map(Number); return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? Buffer.from(parts) : Buffer.from([127, 0, 0, 1]); };
const ipInt = (addr) => ip4(addr).readUInt32BE(0);

// addresses that completed a TCP request to the HTTP side recently
const VERIFIED_MS = 5 * 60 * 1000;
const verified = new Map();
const verify = (ip) => { if (verified.size > 20000) { const t = Date.now(); for (const [k, v] of verified) if (t - v > VERIFIED_MS) verified.delete(k); if (verified.size > 20000) verified.clear(); } verified.set(ip, Date.now()); };
const isVerified = (ip) => { const t = verified.get(ip); return t !== undefined && Date.now() - t <= VERIFIED_MS; };
// Replies per address per ten seconds. Its cost per packet is constant however many (forged) source addresses a
// flood uses; when its table is full of addresses seen in the last ten seconds, new addresses get no reply.
const udpRate = createRateLimiter({ limit: 400, windowMs: 10000, maxKeys: 100000 });
// a ping reply is 30 bytes for a 20-byte probe: sent in full (1.5x is no use to an attacker, and a console needs it to
// learn its outside address); only a reply more than twice the request, the 1200-byte bandwidth reply, is cut back
const bound = (out, msg, ip) => (!HARD || isVerified(ip) || out.length <= msg.length * 2 ? out : out.subarray(0, msg.length));

// What to answer one probe on the main port; null = no reply.
function probeReply(msg, rinfo) {
  if (msg.length === 8) return { kind: 'firewall', out: Buffer.from(msg) };
  if (msg.length >= 20) {
    const requestId = msg.readInt32BE(4), secret = msg.readInt32BE(8);
    if (requestId === 1 && secret === 0) {
      const out = Buffer.alloc(30);
      msg.copy(out, 0, 0, 20);
      ip4(rinfo.address).copy(out, 20);
      out.writeUInt16BE(rinfo.port, 24);
      return { kind: 'ping', out };
    }
    const out = Buffer.alloc(1200);
    msg.copy(out, 0, 0, 12);
    out.writeInt32BE((msg.readInt32BE(12) + 1) | 0, 12);
    out.writeInt32LE(msg.readInt32BE(16), 16);
    out.writeInt32BE(123456789, 20);
    out[24] = 0x0e; out[25] = 0x4b;
    return { kind: 'bandwidth', out };
  }
  return HARD ? null : { kind: 'unknown', out: Buffer.from(msg) };
}

let probes = 0;
const udp = dgram.createSocket('udp4');
udp.on('message', (msg, rinfo) => {
  try {
    if (HARD && !udpRate.hit(rinfo.address)) return;
    const r = probeReply(msg, rinfo); if (!r) return;
    const out = bound(r.out, msg, rinfo.address);
    probes++;
    if (!QUIET) log('qos-udp', `${r.kind} probe #${probes} from ${rinfo.address}:${rinfo.port} ${msg.length} bytes -> ${out.length} bytes`, msg.subarray(0, 32).toString('hex'));
    udp.send(out, rinfo.port, rinfo.address, () => {});
  } catch (e) { log('qos-udp', `probe error ${e.message}`); }
});
udp.on('error', (e) => { log('qos-udp', `error ${e.message}`); if (!udpBound) process.exit(1); });
let udpBound = false;
udp.bind(PORT, BIND, () => { udpBound = true; log('qos-udp', `listening on udp/${udp.address().port} (ping/bandwidth responder)${HARD ? ', reflection limits on' : ''}`); });

for (const fp of FW_PORTS) {
  const fw = dgram.createSocket('udp4'); let up = false;
  fw.on('message', (msg, rinfo) => {
    try {
      if (HARD && (msg.length > 64 || !udpRate.hit(rinfo.address))) return; // a firewall probe is 8 bytes; the echo is never larger than the request
      if (!QUIET) log('qos-fw', `firewall probe on ${fp} from ${rinfo.address}:${rinfo.port} ${msg.length} bytes`, msg.subarray(0, 32).toString('hex'));
      fw.send(msg, rinfo.port, rinfo.address, () => {});
    } catch (e) { log('qos-fw', `probe error ${e.message}`); }
  });
  fw.on('error', (e) => { log('qos-fw', `error on ${fp}: ${e.message}`); if (!up) process.exit(1); });
  fw.bind(fp, BIND, () => { up = true; log('qos-fw', `firewall responder on udp/${fw.address().port}`); });
}

// Lists are emitted as <k><k>a</k><k>b</k></k>.
const el = (k, v) => (Array.isArray(v) ? `<${k}>${v.map((x) => `<${k}>${x}</${k}>`).join('')}</${k}>` : `<${k}>${v}</${k}>`);
const xml = (root, fields) => `<?xml version="1.0" encoding="UTF-8"?>\n<${root}>${Object.entries(fields).map(([k, v]) => el(k, v)).join('')}</${root}>`;

const server = http.createServer((req, res) => {
  req.resume(); // no QoS request has a body worth reading; whatever is sent is discarded, not buffered
  try {
    const url = new URL(req.url, 'http://x');
    const q = Object.fromEntries(url.searchParams);
    const client = req.socket.remoteAddress;
    verify(clientIp(client));
    if (!QUIET) log('qos-http', `${client}:${req.socket.remotePort} ${req.method} ${url.pathname}`, q);
    let body;
    if (url.pathname === '/qos/qos') {
      const bandwidth = q.qtyp !== undefined && q.qtyp !== '0' && q.qtyp !== '1';
      body = xml('qos', bandwidth
        ? { numprobes: 10, qosport: PORT, probesize: 1200, qosip: ipInt(client), requestid: 1234, reqsecret: 5678 }
        : { numprobes: 0, qosport: PORT, probesize: 0, qosip: ipInt(client), requestid: 1, reqsecret: 0 });
    } else if (url.pathname === '/qos/firewall') {
      const n = Math.max(1, Math.min(2, Number(q.nint ?? 2) || 2));
      body = xml('firewall', { ips: Array(n).fill(ipInt(client)), numinterfaces: n, ports: FW_PORTS.slice(0, n), requestid: 1234, reqsecret: 5678 });
    } else if (url.pathname === '/qos/firetype') {
      body = xml('firetype', { firetype: 2 });
    } else {
      body = '<?xml version="1.0" encoding="UTF-8"?><response><status>ok</status></response>'; // unknown path (e.g. EA Sports World): logged above, answered benignly
    }
    res.writeHead(200, { 'content-type': 'text/xml', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    if (!QUIET) log('qos-http', '-> ' + body.replace(/\n/g, ' '));
  } catch (e) {
    log('qos-http', `request error ${e.message}`);
    if (!res.headersSent) { res.writeHead(400, { 'content-length': 0 }); } res.end();
  }
});
if (HARD) hardenHttpServer(server, { guard: createConnectionGuard({ maxTotal: cfg.limits.maxConns, maxPerIp: cfg.limits.maxConnsPerIp, perMinutePerIp: cfg.limits.connsPerMinutePerIp }), requestMs: 15000, idleMs: 15000 });
server.on('clientError', (e, s) => { if (!QUIET) log('qos-tcp', `client error ${e.message}`); s.destroy(); });
exitOnListenError(server, (m) => log('qos-http', m), `listen on tcp/${PORT}`);
server.listen(PORT, BIND, () => log('qos-http', `listening on tcp/${server.address().port}${cfg.cloud ? ' (cloud mode)' : ''}`));
