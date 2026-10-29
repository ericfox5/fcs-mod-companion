// Minimal PSN X-I-5 ticket reader (RPCN issues the same layout): TLV fields inside a 0x3000 body section.
// We only need the user id (u64) and the online id (first string) to answer ps3Login.
export function parseXi5(buf) {
  const out = { version: buf.readUInt32BE(0), userId: null, onlineId: null, region: null, domain: null, serviceId: null, issuer: null, strings: [], binaries: [] };
  let p = 8; // version(4) + total length(4)
  const end = buf.length;
  const walk = (p, end) => {
    while (p + 4 <= end) {
      const type = buf.readUInt16BE(p), len = buf.readUInt16BE(p + 2); p += 4;
      const data = buf.subarray(p, p + len);
      if (type === 0x3000 || type === 0x3002) { walk(p, p + len); }
      else if (type === 0x0001 && len === 4) { if (out.issuer === null) out.issuer = data.readUInt32BE(0); }
      else if (type === 0x0002 && len === 8) { if (out.userId === null) out.userId = Number(data.readBigUInt64BE(0)); }
      else if (type === 0x0004) { const s = data.toString('latin1').replace(/\0+$/, ''); out.strings.push(s); if (out.onlineId === null) out.onlineId = s; else if (out.domain === null) out.domain = s; }
      else if (type === 0x0008) { const s = data.toString('latin1').replace(/\0+$/, ''); out.binaries.push(s); if (/^[a-z]{2}$/.test(s)) out.region = s; else if (/^[A-Z]{2}\d{4}-/.test(s)) out.serviceId = s; }
      p += len;
    }
  };
  walk(p, end);
  return out;
}
