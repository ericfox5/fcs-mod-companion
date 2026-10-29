// gosredirector.ea.com stand-in for the NCAA 14 spike. The PS3 client speaks SSLv3 (RC4-SHA), which no modern TLS
// library offers, so this uses our own SSLv3 implementation (sslv3-server.mjs) with the forged certificate.
//   node redirector.mjs            SSLv3 redirector answering Redirector.getServerInstance
//   node redirector.mjs --peek     raw TCP: print the ClientHello the game sends, then close (no handshake)
// Options: --port 42127  --blaze-host 127.0.0.1  --blaze-port 33152
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseClientHello } from './clienthello.mjs';
import { PacketStream, encodePacket, describe, MSG } from './packet.mjs';
import { decode, Writer, ipToInt, T } from './tdf.mjs';
import { log, captureFile } from './log.mjs';
import { createSslv3Server } from './sslv3-server.mjs';
import { pemToDer } from './sslv3-crypto.mjs';

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i === -1 ? dflt : process.argv[i + 1]; };
const PORT = Number(arg('--port', 42127));
const BLAZE_HOST = arg('--blaze-host', '127.0.0.1');
const BLAZE_PORT = Number(arg('--blaze-port', 33152));
const PEEK = process.argv.includes('--peek');

log('redirector', `capture file: ${captureFile}`);

if (PEEK) {
  net.createServer((sock) => {
    log('peek', `connection from ${sock.remoteAddress}:${sock.remotePort}`);
    sock.once('data', (d) => { log('peek', `first ${d.length} bytes`, { hex: d.subarray(0, 256).toString('hex'), hello: parseClientHello(d) }); sock.destroy(); });
    sock.on('error', (e) => log('peek', `socket error ${e.message}`));
  }).listen(PORT, '0.0.0.0', () => log('peek', `raw listener on 0.0.0.0:${PORT} (no handshake; prints ClientHello)`));
} else {
  const certs = join(import.meta.dirname, 'certs');
  const opts = { certDer: pemToDer(readFileSync(join(certs, 'gosredirector_mod.crt'))), privateKeyPem: readFileSync(join(certs, 'gosredirector.key.pem')), log: (t, m) => log(`ssl:${t}`, m) };
  const server = createSslv3Server(opts, (ssl, sock) => {
    log('tcp', `connection from ${sock.remoteAddress}:${sock.remotePort}`);
    const stream = new PacketStream();
    ssl.on('secure', (suite) => log('ssl', `handshake complete (${suite})`));
    ssl.on('data', (chunk) => {
      log('ssl', `app data ${chunk.length} bytes`, chunk.subarray(0, 512).toString('hex'));
      for (const p of stream.feed(chunk)) {
        let body;
        try { body = decode(p.payload); } catch (e) { body = { $decodeError: e.message, hex: p.payload.toString('hex') }; }
        log('blaze', describe(p), body);
        if (p.component === 5 && p.command === 1) {
          const w = new Writer();
          w.unionStruct('ADDR', 0, 'VALU', (s) => { s.str('HOST', BLAZE_HOST); s.int('IP', ipToInt(BLAZE_HOST)); s.int('PORT', BLAZE_PORT); });
          w.list('AMAP', T.STRUCT, [], () => {});
          w.stringList('MSGS', []);
          w.list('NMAP', T.STRUCT, [], () => {});
          w.int('SECU', 0);
          w.int('XDNS', 0);
          const out = encodePacket({ component: 5, command: 1, type: MSG.RESPONSE, id: p.id, payload: w.bytes() });
          ssl.write(out);
          log('blaze', `-> getServerInstance response: ${BLAZE_HOST}:${BLAZE_PORT} (plaintext Blaze)`, out.toString('hex'));
        } else {
          const out = encodePacket({ component: p.component, command: p.command, type: MSG.ERROR, error: 0x4000, id: p.id });
          ssl.write(out);
          log('blaze', '-> unhandled, replied error', out.toString('hex'));
        }
      }
    });
    ssl.on('alert', (level, desc) => log('ssl', `ALERT level ${level} description ${desc}${desc === 42 ? ' (bad_certificate)' : desc === 48 ? ' (unknown_ca)' : desc === 40 ? ' (handshake_failure)' : desc === 0 ? ' (close_notify)' : ''}`));
    ssl.on('error', (e) => log('ssl', `socket error ${e.message}`));
    ssl.on('close', () => log('tcp', 'connection closed'));
  });
  server.listen(PORT, '0.0.0.0', () => log('ssl', `SSLv3 redirector listening on 0.0.0.0:${PORT} (RC4-SHA / RC4-MD5, forged cert)`));
}
