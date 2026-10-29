// Parse a raw TLS/SSL ClientHello (first record on the wire) so we can see what the PS3 ProtoSSL client offers.
const SUITES = {
  0x0004: 'RC4-MD5', 0x0005: 'RC4-SHA', 0x000a: 'DES-CBC3-SHA', 0x002f: 'AES128-SHA', 0x0035: 'AES256-SHA',
  0x003c: 'AES128-SHA256', 0x003d: 'AES256-SHA256', 0x009c: 'AES128-GCM-SHA256', 0x009d: 'AES256-GCM-SHA384',
  0xc013: 'ECDHE-RSA-AES128-SHA', 0xc014: 'ECDHE-RSA-AES256-SHA', 0x0009: 'DES-CBC-SHA', 0x0003: 'EXP-RC4-MD5',
};
const VERS = { 0x0300: 'SSLv3', 0x0301: 'TLSv1.0', 0x0302: 'TLSv1.1', 0x0303: 'TLSv1.2', 0x0304: 'TLSv1.3' };

export function parseClientHello(buf) {
  if (buf.length < 11) return { error: 'too short', hex: buf.toString('hex') };
  if (buf[0] === 0x80 || buf[0] === 0x81) {
    // SSLv2-compatible ClientHello
    const len = ((buf[0] & 0x7f) << 8) | buf[1];
    const ver = buf.readUInt16BE(3);
    const csLen = buf.readUInt16BE(5);
    const suites = [];
    for (let i = 0; i < csLen; i += 3) { const s = buf.readUIntBE(11 + i, 3); suites.push(SUITES[s & 0xffff] ?? '0x' + s.toString(16)); }
    return { format: 'SSLv2-compat hello', recordLen: len, version: VERS[ver] ?? ver.toString(16), suites };
  }
  if (buf[0] !== 0x16) return { error: `not a handshake record (0x${buf[0].toString(16)})`, hex: buf.subarray(0, 64).toString('hex') };
  const recVer = buf.readUInt16BE(1);
  const hsType = buf[5];
  const clientVer = buf.readUInt16BE(9);
  let p = 11 + 32; // random
  const sidLen = buf[p]; p += 1 + sidLen;
  const csLen = buf.readUInt16BE(p); p += 2;
  const suites = [];
  for (let i = 0; i < csLen; i += 2) { const s = buf.readUInt16BE(p + i); suites.push(SUITES[s] ?? '0x' + s.toString(16).padStart(4, '0')); }
  p += csLen;
  const compLen = buf[p]; p += 1 + compLen;
  const exts = [];
  if (p + 2 <= buf.length) {
    const extLen = buf.readUInt16BE(p); p += 2;
    const end = Math.min(buf.length, p + extLen);
    while (p + 4 <= end) { const t = buf.readUInt16BE(p); const l = buf.readUInt16BE(p + 2); let v = ''; if (t === 0) v = buf.subarray(p + 9, p + 4 + l).toString('latin1'); exts.push(`${t}${v ? `(sni=${v})` : ''}`); p += 4 + l; }
  }
  return { format: 'TLS record', recordVersion: VERS[recVer] ?? recVer.toString(16), handshakeType: hsType, clientVersion: VERS[clientVer] ?? clientVer.toString(16), suites, extensions: exts };
}
