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

// Incremental parser: feed chunks, get complete packets.
export class PacketStream {
  constructor() { this.buf = Buffer.alloc(0); }
  feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out = [];
    for (;;) {
      if (this.buf.length < 12) break;
      const type = this.buf.readUInt16BE(8);
      const ext = (type & 0x10) !== 0;
      const hlen = ext ? 14 : 12;
      if (this.buf.length < hlen) break;
      let len = this.buf.readUInt16BE(0);
      if (ext) len |= this.buf.readUInt16BE(12) << 16;
      if (this.buf.length < hlen + len) break;
      out.push({
        component: this.buf.readUInt16BE(2),
        command: this.buf.readUInt16BE(4),
        error: this.buf.readUInt16BE(6),
        type: type & 0xf000,
        id: this.buf.readUInt16BE(10),
        payload: this.buf.subarray(hlen, hlen + len),
      });
      this.buf = this.buf.subarray(hlen + len);
    }
    return out;
  }
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
