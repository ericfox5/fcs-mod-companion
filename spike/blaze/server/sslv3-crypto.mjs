// SSLv3 (RFC 6101) primitives for the EA ProtoSSL client: RSA key exchange + RC4-128 with SHA-1 or MD5 MAC.
import crypto from 'node:crypto';

export const md5 = (...parts) => { const h = crypto.createHash('md5'); for (const p of parts) h.update(p); return h.digest(); };
export const sha1 = (...parts) => { const h = crypto.createHash('sha1'); for (const p of parts) h.update(p); return h.digest(); };

export class RC4 {
  constructor(key) {
    const S = new Uint8Array(256);
    for (let i = 0; i < 256; i++) S[i] = i;
    for (let i = 0, j = 0; i < 256; i++) { j = (j + S[i] + key[i % key.length]) & 255; const t = S[i]; S[i] = S[j]; S[j] = t; }
    this.S = S; this.i = 0; this.j = 0;
  }
  process(buf) {
    const out = Buffer.alloc(buf.length); const S = this.S; let { i, j } = this;
    for (let k = 0; k < buf.length; k++) { i = (i + 1) & 255; j = (j + S[i]) & 255; const t = S[i]; S[i] = S[j]; S[j] = t; out[k] = buf[k] ^ S[(S[i] + S[j]) & 255]; }
    this.i = i; this.j = j; return out;
  }
}

export const SUITES = {
  0x0005: { id: 0x0005, name: 'RC4-SHA', mac: 'sha1', macLen: 20, keyLen: 16 },
  0x0004: { id: 0x0004, name: 'RC4-MD5', mac: 'md5', macLen: 16, keyLen: 16 },
};

const label = (i) => Buffer.alloc(i, 0x41 + i - 1); // 'A', 'BB', 'CCC', ...

export function masterSecret(pre, clientRandom, serverRandom) {
  return Buffer.concat([1, 2, 3].map((i) => md5(pre, sha1(label(i), pre, clientRandom, serverRandom))));
}

export function keyBlock(master, serverRandom, clientRandom, length) {
  const parts = [];
  for (let i = 1, n = 0; n < length; i++) { const b = md5(master, sha1(label(i), master, serverRandom, clientRandom)); parts.push(b); n += b.length; }
  return Buffer.concat(parts).subarray(0, length);
}

// hash(secret + pad2 + hash(secret + pad1 + seq(8) + type(1) + len(2) + data))
export function sslMac(hashName, secret, seq, type, data) {
  const H = hashName === 'md5' ? md5 : sha1;
  const padLen = hashName === 'md5' ? 48 : 40;
  const pad1 = Buffer.alloc(padLen, 0x36), pad2 = Buffer.alloc(padLen, 0x5c);
  const hdr = Buffer.alloc(11); hdr.writeUInt32BE(Math.floor(seq / 2 ** 32), 0); hdr.writeUInt32BE(seq >>> 0, 4); hdr[8] = type; hdr.writeUInt16BE(data.length, 9);
  return H(secret, pad2, H(secret, pad1, hdr, data));
}

export function finishedHash(master, handshakeMessages, sender) {
  const m = md5(master, Buffer.alloc(48, 0x5c), md5(handshakeMessages, sender, master, Buffer.alloc(48, 0x36)));
  const s = sha1(master, Buffer.alloc(40, 0x5c), sha1(handshakeMessages, sender, master, Buffer.alloc(40, 0x36)));
  return Buffer.concat([m, s]);
}
export const SENDER_CLIENT = Buffer.from('CLNT');
export const SENDER_SERVER = Buffer.from('SRVR');

export function pemToDer(pem) {
  return Buffer.from(pem.toString().replace(/-----BEGIN [^-]+-----/, '').replace(/-----END [^-]+-----/, '').replace(/\s+/g, ''), 'base64');
}
