// Minimal SSLv3 server (RSA key exchange, RC4-SHA / RC4-MD5) for EA's 2013 ProtoSSL clients. OpenSSL 3 cannot speak SSLv3.
import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { RC4, SUITES, masterSecret, keyBlock, sslMac, finishedHash, SENDER_CLIENT, SENDER_SERVER } from './sslv3-crypto.mjs';

export const REC = { CCS: 20, ALERT: 21, HANDSHAKE: 22, APP: 23 };
export const HS = { CLIENT_HELLO: 1, SERVER_HELLO: 2, CERT: 11, SERVER_DONE: 14, CKE: 16, FINISHED: 20 };
export const u24 = (n) => Buffer.from([(n >> 16) & 255, (n >> 8) & 255, n & 255]);

export class Sslv3ServerSocket extends EventEmitter {
  constructor(socket, { certDer, privateKeyPem, log = () => {} }) {
    super();
    this.socket = socket; this.certDer = certDer; this.key = privateKeyPem; this.log = log;
    this.rx = Buffer.alloc(0); this.hsBuf = Buffer.alloc(0); this.transcript = [];
    this.clientRandom = null; this.serverRandom = null; this.suite = null; this.master = null;
    this.clientDec = null; this.serverEnc = null; this.clientSeq = 0; this.serverSeq = 0; this.clientMacSecret = null; this.serverMacSecret = null;
    this.secure = false; this.clientSecure = false;
    socket.on('data', (d) => this.onData(d));
    socket.on('close', () => this.emit('close'));
    socket.on('error', (e) => this.emit('error', e));
  }
  onData(d) { this.rx = Buffer.concat([this.rx, d]); try { this.processRecords(); } catch (e) { this.log('error', `record processing failed: ${e.message}`); this.socket.destroy(); } }
  processRecords() {
    while (this.rx.length >= 5) {
      const type = this.rx[0], ver = this.rx.readUInt16BE(1), len = this.rx.readUInt16BE(3);
      if (this.rx.length < 5 + len) break;
      let frag = Buffer.from(this.rx.subarray(5, 5 + len)); this.rx = this.rx.subarray(5 + len);
      if (this.clientSecure) frag = this.decrypt(type, frag);
      this.onRecord(type, ver, frag);
    }
  }
  decrypt(type, frag) {
    const pt = this.clientDec.process(frag);
    const data = pt.subarray(0, pt.length - this.suite.macLen), mac = pt.subarray(pt.length - this.suite.macLen);
    const expect = sslMac(this.suite.mac, this.clientMacSecret, this.clientSeq++, type, data);
    if (!mac.equals(expect)) this.log('warn', `client MAC mismatch on record type ${type} seq ${this.clientSeq - 1}`);
    return data;
  }
  onRecord(type, ver, frag) {
    if (type === REC.HANDSHAKE) { this.hsBuf = Buffer.concat([this.hsBuf, frag]); this.processHandshake(); }
    else if (type === REC.CCS) { this.clientSecure = true; this.clientSeq = 0; this.log('hs', 'client ChangeCipherSpec'); }
    else if (type === REC.ALERT) { this.log('alert', `client alert level ${frag[0]} description ${frag[1]}`); this.emit('alert', frag[0], frag[1]); }
    else if (type === REC.APP) this.emit('data', frag);
    else this.log('warn', `unknown record type ${type} (version 0x${ver.toString(16)})`);
  }
  processHandshake() {
    while (this.hsBuf.length >= 4) {
      const t = this.hsBuf[0], len = this.hsBuf.readUIntBE(1, 3);
      if (this.hsBuf.length < 4 + len) break;
      const raw = Buffer.from(this.hsBuf.subarray(0, 4 + len)); this.hsBuf = this.hsBuf.subarray(4 + len);
      const body = raw.subarray(4);
      if (t === HS.CLIENT_HELLO) { this.transcript.push(raw); this.onClientHello(body); }
      else if (t === HS.CKE) { this.transcript.push(raw); this.onClientKeyExchange(body); }
      else if (t === HS.FINISHED) this.onClientFinished(body, raw);
      else this.log('warn', `unexpected handshake message type ${t}`);
    }
  }
  onClientHello(b) {
    const ver = b.readUInt16BE(0); this.clientRandom = Buffer.from(b.subarray(2, 34));
    let p = 34; const sidLen = b[p]; p += 1 + sidLen; const csLen = b.readUInt16BE(p); p += 2;
    const suites = []; for (let i = 0; i < csLen; i += 2) suites.push(b.readUInt16BE(p + i));
    const suite = suites.map((s) => SUITES[s]).find(Boolean);
    this.log('hs', `ClientHello version 0x${ver.toString(16)} suites ${suites.map((s) => '0x' + s.toString(16).padStart(4, '0')).join(',')} -> ${suite ? suite.name : 'NONE SUPPORTED'}`);
    if (!suite) { this.sendAlert(2, 40); this.socket.end(); return; }
    this.suite = suite; this.serverRandom = crypto.randomBytes(32);
    const sid = crypto.randomBytes(32);
    const sh = Buffer.concat([Buffer.from([3, 0]), this.serverRandom, Buffer.from([32]), sid, Buffer.from([suite.id >> 8, suite.id & 255, 0])]);
    const entry = Buffer.concat([u24(this.certDer.length), this.certDer]);
    this.sendHandshake(HS.SERVER_HELLO, sh);
    this.sendHandshake(HS.CERT, Buffer.concat([u24(entry.length), entry]));
    this.sendHandshake(HS.SERVER_DONE, Buffer.alloc(0));
    this.log('hs', `ServerHello(${suite.name}) + Certificate(${this.certDer.length} bytes) + ServerHelloDone sent`);
  }
  onClientKeyExchange(b) {
    const keyLen = crypto.createPublicKey(this.key).asymmetricKeyDetails.modulusLength / 8;
    let enc = b;
    if (b.length === keyLen + 2 && b.readUInt16BE(0) === keyLen) enc = b.subarray(2);
    let pre;
    try { pre = crypto.privateDecrypt({ key: this.key, padding: crypto.constants.RSA_PKCS1_PADDING }, enc); }
    catch (e) { this.log('error', `premaster decrypt failed: ${e.message}`); pre = crypto.randomBytes(48); }
    this.log('hs', `ClientKeyExchange ${b.length} bytes -> premaster ${pre.length} bytes (version 0x${pre.length >= 2 ? pre.readUInt16BE(0).toString(16) : '?'})`);
    this.master = masterSecret(pre, this.clientRandom, this.serverRandom);
    const s = this.suite, kb = keyBlock(this.master, this.serverRandom, this.clientRandom, 2 * s.macLen + 2 * s.keyLen);
    let o = 0;
    this.clientMacSecret = kb.subarray(o, o += s.macLen); this.serverMacSecret = kb.subarray(o, o += s.macLen);
    this.clientDec = new RC4(kb.subarray(o, o += s.keyLen)); this.serverEnc = new RC4(kb.subarray(o, o += s.keyLen));
  }
  onClientFinished(body, raw) {
    const expect = finishedHash(this.master, Buffer.concat(this.transcript), SENDER_CLIENT);
    this.log('hs', `client Finished ${body.equals(expect) ? 'verified' : 'MISMATCH (continuing anyway)'}`);
    this.transcript.push(raw);
    this.sendRecord(REC.CCS, Buffer.from([1]));
    this.secure = true; this.serverSeq = 0;
    this.sendHandshake(HS.FINISHED, finishedHash(this.master, Buffer.concat(this.transcript), SENDER_SERVER));
    this.log('hs', 'server ChangeCipherSpec + Finished sent: handshake complete');
    this.emit('secure', this.suite.name);
  }
  sendHandshake(type, body) {
    const msg = Buffer.concat([Buffer.from([type]), u24(body.length), body]);
    if (type !== HS.FINISHED) this.transcript.push(msg);
    this.sendRecord(REC.HANDSHAKE, msg);
  }
  sendRecord(type, data) {
    let frag = data;
    if (this.secure) { const mac = sslMac(this.suite.mac, this.serverMacSecret, this.serverSeq++, type, data); frag = this.serverEnc.process(Buffer.concat([data, mac])); }
    this.socket.write(Buffer.concat([Buffer.from([type, 3, 0, frag.length >> 8, frag.length & 255]), frag]));
  }
  sendAlert(level, desc) { this.sendRecord(REC.ALERT, Buffer.from([level, desc])); }
  write(data) { for (let i = 0; i < data.length; i += 16384) this.sendRecord(REC.APP, data.subarray(i, i + 16384)); }
  end() { try { this.sendAlert(1, 0); } catch {} this.socket.end(); }
}

export function createSslv3Server(opts, onConnection) {
  return net.createServer((sock) => onConnection(new Sslv3ServerSocket(sock, opts), sock));
}
