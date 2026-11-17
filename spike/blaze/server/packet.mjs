// Blaze 3 packet framing: [len u16][component u16][command u16][error u16][type u16][msgId u16] (+2 bytes ext length when type & 0x10)
export const MSG = { REQUEST: 0x0000, RESPONSE: 0x1000, NOTIFY: 0x2000, ERROR: 0x3000 };

export function encodePacket({ component, command, error = 0, type = MSG.RESPONSE, id = 0, payload = Buffer.alloc(0) }) {
  const ext = payload.length > 0xffff;
  const h = Buffer.alloc(ext ? 14 : 12);
  h.writeUInt16BE(payload.length & 0xffff, 0);
  h.writeUInt16BE(component, 2);
  h.writeUInt16BE(command, 4);
  h.writeUInt16BE(error, 6);
  h.writeUInt16BE(type | (ext ? 0x10 : 0), 8);
  h.writeUInt16BE(id & 0xffff, 10);
  if (ext) h.writeUInt16BE(payload.length >>> 16, 12);
  return Buffer.concat([h, payload]);
}

// Incremental parser. push(chunk) queues bytes; next() returns the next complete packet or null.
//   - Chunks are kept in a list and joined once, when a packet is complete. A large packet that arrives in thousands
//     of small pieces costs time in proportion to its size (the previous parser copied everything received so far on
//     every piece).
//   - The size limit is asked per packet, as soon as its 12-byte header is in: limitFor({ component, command, type })
//     returns the most payload bytes that packet may have right now. next() throws PacketTooLarge on a header
//     announcing more, before any of the payload is kept, and the caller drops the socket. (The extended header can
//     announce up to 4 GB.) Packets are handed out one at a time so a limit can depend on what an earlier packet did
//     (blaze.mjs: a few KB until the connection has signed in, then a limit per command).
//   - maxPacket is the fixed limit used when no limitFor is given.
// feed(chunk) = push + every complete packet, for callers with one fixed limit (the redirector, the test client).
export class PacketTooLarge extends Error {}
export class PacketStream {
  constructor({ maxPacket = 16 * 1024 * 1024, limitFor = null } = {}) {
    this.chunks = []; this.size = 0; this.maxPacket = maxPacket; this.limitFor = limitFor;
    this.head = null; // header of the packet being received, once its limit has been checked
  }
  get buffered() { return this.size; }
  push(chunk) { if (chunk.length) { this.chunks.push(chunk); this.size += chunk.length; } }
  // The first n bytes as one buffer (n is at most a header: 14 bytes), joining only as many leading chunks as needed.
  #front(n) {
    while (this.chunks[0].length < n && this.chunks.length > 1) { const [x, y] = this.chunks.splice(0, 2); this.chunks.unshift(Buffer.concat([x, y])); }
    return this.chunks[0];
  }
  next() {
    if (!this.head) {
      if (this.size < 12) return null;
      let b = this.#front(12);
      const type = b.readUInt16BE(8), ext = (type & 0x10) !== 0, hlen = ext ? 14 : 12;
      if (this.size < hlen) return null;
      if (ext) b = this.#front(14);
      const len = b.readUInt16BE(0) + (ext ? b.readUInt16BE(12) * 0x10000 : 0);
      const head = { component: b.readUInt16BE(2), command: b.readUInt16BE(4), error: b.readUInt16BE(6), type: type & 0xf000, id: b.readUInt16BE(10), hlen, len };
      const limit = this.limitFor ? this.limitFor(head) : this.maxPacket;
      if (len > limit) { this.chunks = []; this.size = 0; throw Object.assign(new PacketTooLarge(`packet of ${len} bytes exceeds the ${limit}-byte limit`), { head, limit }); }
      this.head = head;
    }
    const { hlen, len } = this.head, total = hlen + len;
    if (this.size < total) return null; // nothing is copied while a packet is still arriving
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.size); // once per packet
    const { component, command, error, type, id } = this.head;
    const packet = { component, command, error, type, id, payload: all.subarray(hlen, total) };
    this.head = null; this.size -= total;
    this.chunks = this.size ? [all.subarray(total)] : [];
    return packet;
  }
  feed(chunk) { this.push(chunk); const out = []; for (let p; (p = this.next());) out.push(p); return out; }
}

// Blaze 3 component ids (BlazeSDK / ZamboniCommonComponents; the OSDK class names appear in the NCAA 14 EBOOT)
export const COMPONENTS = {
  1: 'Authentication', 4: 'GameManager', 5: 'Redirector', 6: 'Playgroups', 7: 'Stats', 9: 'Util', 10: 'CensusData', 11: 'Clubs',
  15: 'Messaging', 20: 'Locker', 21: 'Rooms', 25: 'AssociationLists', 28: 'GameReporting', 30: 'DynamicInetFilter', 0x7802: 'UserSessions',
  2249: 'OSDKSettings', 2250: 'OsdkDynamicMessaging', 2251: 'OsdkWebOfferSurvey', 2257: 'OSDKSeasonalPlay', 2262: 'OsdkTicker2', 2268: 'OsdkOnlinePass',
  2148: 'DynastyOnDemand',
};
export function describe(p) {
  const name = COMPONENTS[p.component] ?? `comp${p.component}`;
  const kind = { 0: 'REQ', 0x1000: 'RSP', 0x2000: 'NTF', 0x3000: 'ERR' }[p.type] ?? `t${p.type.toString(16)}`;
  return `${kind} ${name}(${p.component}) cmd=${p.command} id=${p.id} err=${p.error} len=${p.payload.length}`;
}
