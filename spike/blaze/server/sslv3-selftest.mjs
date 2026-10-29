// Self-test: a tiny SSLv3 client (built from the same primitives) completes a handshake with Sslv3ServerSocket and exchanges data.
import net from 'node:net';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSslv3Server, REC, HS, u24 } from './sslv3-server.mjs';
import { RC4, SUITES, masterSecret, keyBlock, sslMac, finishedHash, SENDER_CLIENT, SENDER_SERVER, pemToDer } from './sslv3-crypto.mjs';

const certs = join(import.meta.dirname, 'certs');
const certDer = pemToDer(readFileSync(join(certs, 'gosredirector_mod.crt')));
const privateKeyPem = readFileSync(join(certs, 'gosredirector.key.pem'));

const server = createSslv3Server({ certDer, privateKeyPem, log: (t, m) => console.log(`  server[${t}] ${m}`) }, (ssl) => {
  ssl.on('data', (d) => { console.log(`  server got app data: ${d.toString()}`); ssl.write(Buffer.from('pong:' + d.toString())); });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const sock = net.connect(port, '127.0.0.1');
await new Promise((r) => sock.on('connect', r));
const suite = SUITES[0x0005];
const clientRandom = crypto.randomBytes(32);
const transcript = [];
const hs = (type, body) => { const m = Buffer.concat([Buffer.from([type]), u24(body.length), body]); if (type !== HS.FINISHED) transcript.push(m); return m; };
const record = (type, frag) => Buffer.concat([Buffer.from([type, 3, 0, frag.length >> 8, frag.length & 255]), frag]);
const hello = hs(HS.CLIENT_HELLO, Buffer.concat([Buffer.from([3, 0]), clientRandom, Buffer.from([0, 0, 2, 0, 5, 1, 0])]));
sock.write(record(REC.HANDSHAKE, hello));

let rx = Buffer.alloc(0), serverRandom, serverCert, master, enc, dec, cMac, sMac, cSeq = 0, sSeq = 0, secure = false, done = false, got = [];
const records = [];
sock.on('data', (d) => { rx = Buffer.concat([rx, d]); while (rx.length >= 5) { const len = rx.readUInt16BE(3); if (rx.length < 5 + len) break; records.push({ type: rx[0], frag: Buffer.from(rx.subarray(5, 5 + len)) }); rx = rx.subarray(5 + len); } });
const next = async () => { while (!records.length) await new Promise((r) => setTimeout(r, 5)); return records.shift(); };
const decrypt = (type, frag) => { const pt = dec.process(frag); const data = pt.subarray(0, pt.length - suite.macLen); const mac = pt.subarray(pt.length - suite.macLen); const ok = mac.equals(sslMac(suite.mac, sMac, sSeq++, type, data)); return { data, ok }; };

// ServerHello, Certificate, ServerHelloDone (maybe split across records)
let hsBuf = Buffer.alloc(0);
const msgs = [];
while (msgs.length < 3) { const r = await next(); if (r.type !== REC.HANDSHAKE) throw new Error('unexpected record ' + r.type); hsBuf = Buffer.concat([hsBuf, r.frag]); while (hsBuf.length >= 4) { const len = hsBuf.readUIntBE(1, 3); if (hsBuf.length < 4 + len) break; msgs.push(Buffer.from(hsBuf.subarray(0, 4 + len))); hsBuf = hsBuf.subarray(4 + len); } }
for (const m of msgs) transcript.push(m);
serverRandom = msgs[0].subarray(4 + 2, 4 + 34);
const certLen = msgs[1].readUIntBE(4 + 3, 3); serverCert = msgs[1].subarray(4 + 6, 4 + 6 + certLen);
const pub = new crypto.X509Certificate(serverCert).publicKey;
console.log(`client: ServerHello suite 0x${msgs[0].readUInt16BE(msgs[0].length - 3).toString(16)}, cert subject ${new crypto.X509Certificate(serverCert).subject.split('\n')[0]}`);

const pre = Buffer.concat([Buffer.from([3, 0]), crypto.randomBytes(46)]);
const encPre = crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_PADDING }, pre);
sock.write(record(REC.HANDSHAKE, hs(HS.CKE, encPre)));
master = masterSecret(pre, clientRandom, serverRandom);
const kb = keyBlock(master, serverRandom, clientRandom, 2 * suite.macLen + 2 * suite.keyLen);
let o = 0; cMac = kb.subarray(o, o += suite.macLen); sMac = kb.subarray(o, o += suite.macLen); enc = new RC4(kb.subarray(o, o += suite.keyLen)); dec = new RC4(kb.subarray(o, o += suite.keyLen));
sock.write(record(REC.CCS, Buffer.from([1])));
const sendSecure = (type, data) => { const mac = sslMac(suite.mac, cMac, cSeq++, type, data); sock.write(record(type, enc.process(Buffer.concat([data, mac])))); };
const clientFin = hs(HS.FINISHED, finishedHash(master, Buffer.concat(transcript), SENDER_CLIENT));
transcript.push(clientFin);
sendSecure(REC.HANDSHAKE, clientFin);

const ccs = await next(); if (ccs.type !== REC.CCS) throw new Error('expected server CCS, got ' + ccs.type);
const finRec = await next(); const { data: finMsg, ok } = decrypt(finRec.type, finRec.frag);
const expected = finishedHash(master, Buffer.concat(transcript), SENDER_SERVER);
console.log(`client: server Finished MAC ${ok ? 'ok' : 'BAD'}, verify ${finMsg.subarray(4).equals(expected) ? 'ok' : 'BAD'}`);
sendSecure(REC.APP, Buffer.from('ping'));
const app = await next(); const r2 = decrypt(app.type, app.frag);
console.log(`client: app reply "${r2.data}" MAC ${r2.ok ? 'ok' : 'BAD'}`);
sock.destroy(); server.close();
console.log(ok && finMsg.subarray(4).equals(expected) && r2.ok && r2.data.toString() === 'pong:ping' ? 'SELFTEST PASS' : 'SELFTEST FAIL');
