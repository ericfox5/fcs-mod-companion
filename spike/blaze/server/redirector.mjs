// gosredirector.ea.com stand-in for the NCAA 14 spike. The PS3 client speaks SSLv3 (RC4-SHA), which no modern TLS
// library offers, so this uses our own SSLv3 implementation (sslv3-server.mjs) with the forged certificate.
//   node redirector.mjs            SSLv3 redirector answering Redirector.getServerInstance
//   node redirector.mjs --peek     raw TCP: print the ClientHello the game sends, then close (no handshake)
// Options: --port 42127  --blaze-host 127.0.0.1  --blaze-port 33152
// Environment (cloud-config.mjs; a flag wins): NCAA_REDIRECTOR_PORT, NCAA_BLAZE_PORT, NCAA_CERT_DIR, and in cloud mode
// (NCAA_CLOUD=1) NCAA_PUBLIC_HOST / NCAA_ADVERTISE for the Blaze address consoles are sent.
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseClientHello } from './clienthello.mjs';
import { PacketStream, encodePacket, describe, MSG } from './packet.mjs';
import { decode, Writer, ipToInt, T } from './tdf.mjs';
import { log, captureFile } from './log.mjs';
import { createSslv3Server } from './sslv3-server.mjs';
import { pemToDer } from './sslv3-crypto.mjs';
import { cloudSettings, createAdvertiser, fixedAdvertiser, bindSettings, fatalConfig, flag, port, certDir } from './cloud-config.mjs';
import { createConnectionGuard, hardenSocket, installProcessGuards, exitOnListenError, clientIp } from './net-guard.mjs';

let cfg, adv, PORT, BLAZE_PORT, BIND;
try {
  cfg = cloudSettings({ needRegistry: false });
  // this PC only unless cloud mode, a registry, or --lan / a LAN --blaze-host says otherwise (cloud-config.mjs bindSettings)
  ({ bind: BIND } = bindSettings({ cloud: cfg.cloud, registry: !!cfg.registryFile, advertised: [flag('--blaze-host')] }));
  PORT = port('--port', 'NCAA_REDIRECTOR_PORT', 42127);
  BLAZE_PORT = port('--blaze-port', 'NCAA_BLAZE_PORT', 33152);
  // --blaze-host (local, what league.mjs --lan passes) wins; cloud mode advertises NCAA_PUBLIC_HOST
  adv = flag('--blaze-host') !== undefined || !cfg.cloud ? fixedAdvertiser(flag('--blaze-host') ?? '127.0.0.1')
    : await createAdvertiser(cfg.publicHost, cfg.advertise, { onChange: (a, b) => log('redirector', `public address changed ${a} -> ${b}`) });
} catch (e) { fatalConfig('redirector', e); }
const PEEK = process.argv.includes('--peek');
const L = cfg.limits;
const guard = cfg.hardened ? createConnectionGuard({ maxTotal: L.maxConns, maxPerIp: L.maxConnsPerIp, perMinutePerIp: L.connsPerMinutePerIp }) : null;
installProcessGuards((m) => log('redirector', m));

log('redirector', `capture file: ${captureFile}`);
log('redirector', cfg.cloud ? 'mode: cloud (limits on)' : `mode: local${cfg.hardened ? ' (limits on)' : ''}, listening on ${BIND}`);

if (PEEK) {
  net.createServer((sock) => {
    log('peek', `connection from ${sock.remoteAddress}:${sock.remotePort}`);
    sock.once('data', (d) => { log('peek', `first ${d.length} bytes`, { hex: d.subarray(0, 256).toString('hex'), hello: parseClientHello(d) }); sock.destroy(); });
    sock.on('error', (e) => log('peek', `socket error ${e.message}`));
  }).listen(PORT, BIND, () => log('peek', `raw listener on ${BIND}:${PORT} (no handshake; prints ClientHello)`));
} else {
  const certs = certDir();
  let opts;
  try { opts = { certDer: pemToDer(readFileSync(join(certs, 'gosredirector_mod.crt'))), privateKeyPem: readFileSync(join(certs, 'gosredirector.key.pem')), log: (t, m) => { if (!cfg.cloud || t === 'error' || t === 'warn') log(`ssl:${t}`, m); } }; }
  catch (e) { console.error(`[redirector] cannot start: certificate files not readable in ${certs} (${e.code ?? e.message}); run gen-cert.mjs or set NCAA_CERT_DIR`); process.exit(78); }
  const server = createSslv3Server(opts, (ssl, sock) => {
    ssl.on('error', () => {}); // a reset connection is not a crash (the logging listener is added below)
    if (guard && !guard.admit(sock)) { log('tcp', `refused ${clientIp(sock.remoteAddress)} (connection limit)`); sock.destroy(); return; }
    // one question, one answer: a real console is done within a second or two
    if (cfg.hardened) { hardenSocket(sock, { idleMs: 20000 }); const life = setTimeout(() => sock.destroy(), 60000); sock.once('close', () => clearTimeout(life)); }
    log('tcp', `connection from ${sock.remoteAddress}:${sock.remotePort}`);
    const stream = new PacketStream({ maxPacket: 65536 });
    ssl.on('secure', (suite) => log('ssl', `handshake complete (${suite})`));
    ssl.on('data', (chunk) => {
      log('ssl', `app data ${chunk.length} bytes`, chunk.subarray(0, 512).toString('hex'));
      let packets;
      try { packets = stream.feed(chunk); } catch (e) { log('blaze', `dropping connection: ${e.message}`); sock.destroy(); return; }
      for (const p of packets) {
        let body;
        try { body = decode(p.payload); } catch (e) { body = { $decodeError: e.message, hex: p.payload.toString('hex') }; }
        log('blaze', describe(p), body);
        if (p.component === 5 && p.command === 1) {
          const w = new Writer();
          // HOST is a string (an IPv4 literal, or the hostname with NCAA_ADVERTISE=host); IP is always the numeric IPv4
          w.unionStruct('ADDR', 0, 'VALU', (s) => { s.str('HOST', adv.host()); s.int('IP', ipToInt(adv.ip())); s.int('PORT', BLAZE_PORT); });
          w.list('AMAP', T.STRUCT, [], () => {});
          w.stringList('MSGS', []);
          w.list('NMAP', T.STRUCT, [], () => {});
          w.int('SECU', 0);
          w.int('XDNS', 0);
          const out = encodePacket({ component: 5, command: 1, type: MSG.RESPONSE, id: p.id, payload: w.bytes() });
          ssl.write(out);
          log('blaze', `-> getServerInstance response: ${adv.host()}:${BLAZE_PORT} (plaintext Blaze)`, out.toString('hex'));
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
  exitOnListenError(server, (m) => log('ssl', m), `listen on ${BIND}:${PORT}`);
  server.listen(PORT, BIND, () => log('ssl', `SSLv3 redirector listening on ${BIND}:${server.address().port} (RC4-SHA / RC4-MD5, forged cert); consoles are sent to ${adv.host()}:${BLAZE_PORT}${cfg.cloud ? ' (cloud mode)' : ''}`));
}
