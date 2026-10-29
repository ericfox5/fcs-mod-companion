// QoS ping-site stand-in, following the DirtySock QosApi used by 2010-2013 EA titles (reference: Skateboard3Server.Qos).
//   udp/17502  ping probes (requestId 1, secret 0): echo 20 bytes + client external IPv4 (4) + port (2) + 4 zero bytes
//              bandwidth probes: echo header, [12] requestCount+1, [16] totalCount (little-endian), constants, pad to 1200
//   udp/17500, udp/17501  firewall probes: 8-byte [requestId][requestSecret] echo
//   tcp/17502  HTTP /qos/qos, /qos/firewall, /qos/firetype -> XML (lists are nested: the client reads .ips.ips / .ports.ports)
//   node qos.mjs [--port 17502] [--fw1 17500] [--fw2 17501]
import dgram from 'node:dgram';
import http from 'node:http';
import { log } from './log.mjs';

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i === -1 ? dflt : process.argv[i + 1]; };
const PORT = Number(arg('--port', 17502));
const FW_PORTS = [Number(arg('--fw1', 17500)), Number(arg('--fw2', 17501))];
const ip4 = (addr) => { const m = (addr ?? '').replace('::ffff:', ''); const parts = m.split('.').map(Number); return parts.length === 4 ? Buffer.from(parts) : Buffer.from([127, 0, 0, 1]); };
const ipInt = (addr) => ip4(addr).readUInt32BE(0);

let probes = 0;
const udp = dgram.createSocket('udp4');
udp.on('message', (msg, rinfo) => {
  let out, kind;
  if (msg.length === 8) {
    kind = 'firewall';
    out = Buffer.from(msg);
  } else if (msg.length >= 20) {
    const requestId = msg.readInt32BE(4), secret = msg.readInt32BE(8);
    if (requestId === 1 && secret === 0) {
      kind = 'ping';
      out = Buffer.alloc(30);
      msg.copy(out, 0, 0, 20);
      ip4(rinfo.address).copy(out, 20);
      out.writeUInt16BE(rinfo.port, 24);
    } else {
      kind = 'bandwidth';
      out = Buffer.alloc(1200);
      msg.copy(out, 0, 0, 12);
      out.writeInt32BE(msg.readInt32BE(12) + 1, 12);
      out.writeInt32LE(msg.readInt32BE(16), 16);
      out.writeInt32BE(123456789, 20);
      out[24] = 0x0e; out[25] = 0x4b;
    }
  } else {
    kind = 'unknown';
    out = Buffer.from(msg);
  }
  probes++;
  log('qos-udp', `${kind} probe #${probes} from ${rinfo.address}:${rinfo.port} ${msg.length} bytes -> ${out.length} bytes`, msg.subarray(0, 32).toString('hex'));
  udp.send(out, rinfo.port, rinfo.address);
});
udp.on('error', (e) => log('qos-udp', `error ${e.message}`));
udp.bind(PORT, '0.0.0.0', () => log('qos-udp', `listening on udp/${PORT} (ping/bandwidth responder)`));

for (const fp of FW_PORTS) {
  const fw = dgram.createSocket('udp4');
  fw.on('message', (msg, rinfo) => {
    log('qos-fw', `firewall probe on ${fp} from ${rinfo.address}:${rinfo.port} ${msg.length} bytes`, msg.subarray(0, 32).toString('hex'));
    fw.send(msg, rinfo.port, rinfo.address);
  });
  fw.on('error', (e) => log('qos-fw', `error on ${fp}: ${e.message}`));
  fw.bind(fp, '0.0.0.0', () => log('qos-fw', `firewall responder on udp/${fp}`));
}

// Lists are emitted as <k><k>a</k><k>b</k></k>.
const el = (k, v) => (Array.isArray(v) ? `<${k}>${v.map((x) => `<${k}>${x}</${k}>`).join('')}</${k}>` : `<${k}>${v}</${k}>`);
const xml = (root, fields) => `<?xml version="1.0" encoding="UTF-8"?>\n<${root}>${Object.entries(fields).map(([k, v]) => el(k, v)).join('')}</${root}>`;

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const q = Object.fromEntries(url.searchParams);
    const client = req.socket.remoteAddress;
    log('qos-http', `${client}:${req.socket.remotePort} ${req.method} ${url.pathname}`, q);
    let body;
    if (url.pathname === '/qos/qos') {
      const bandwidth = q.qtyp !== undefined && q.qtyp !== '0' && q.qtyp !== '1';
      body = xml('qos', bandwidth
        ? { numprobes: 10, qosport: PORT, probesize: 1200, qosip: ipInt(client), requestid: 1234, reqsecret: 5678 }
        : { numprobes: 0, qosport: PORT, probesize: 0, qosip: ipInt(client), requestid: 1, reqsecret: 0 });
    } else if (url.pathname === '/qos/firewall') {
      const n = Math.max(1, Math.min(2, Number(q.nint ?? 2)));
      body = xml('firewall', { ips: Array(n).fill(ipInt(client)), numinterfaces: n, ports: FW_PORTS.slice(0, n), requestid: 1234, reqsecret: 5678 });
    } else if (url.pathname === '/qos/firetype') {
      body = xml('firetype', { firetype: 2 });
    } else {
      body = '<?xml version="1.0" encoding="UTF-8"?><response><status>ok</status></response>'; // unknown path (e.g. EA Sports World): logged above, answered benignly
    }
    res.writeHead(200, { 'content-type': 'text/xml', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    log('qos-http', '-> ' + body.replace(/\n/g, ' '));
  });
});
server.on('clientError', (e, s) => { log('qos-tcp', `client error ${e.message}`); s.destroy(); });
server.listen(PORT, '0.0.0.0', () => log('qos-http', `listening on tcp/${PORT}`));
