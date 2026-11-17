// The game-local NP adapter (ps3-np-adapter.py) as words RPCS3 can write at boot, so a member's unmodified game signs
// in to the league with the 72-byte league credential from their site profile: no PSN, no RPCN account.
//
// Two halves, so a member's PC never needs the decrypted executable:
//   extractTemplate(elf)        on the build PC: the addresses the adapter needs (hooked call sites, the two cellRtc
//                               import stubs, where the code and its 128 bytes of state go). No game bytes.
//   adapterWords(template, p)   anywhere: the adapter's PowerPC code for profile p, word for word what
//                               ps3-np-adapter.py bakes into a personalized ELF, as [va, word] pairs.
//
// Why RPCS3 can take it without a changed file (RPCS3 v0.0.29 and master, checked in source):
//   - a PT_LOAD segment is mapped in 64 KB pages (vm.cpp block_t::falloc aligns the size up), the patch engine may write
//     up to that page end (PPUAnalyser.h ppu_module::get_ptr), and the whole page run is registered executable
//     (PPUThread.cpp ppu_register_range). The code goes right after the RX segment (0x1bc26f0, 55 KB free before the RW
//     segment at 0x1bd0000) and the state right after the RW segment's .bss (0x1d61150), both inside those tail pages
//     and zero-filled; the ELF builder had to extend the segment sizes for the same addresses, RPCS3 does not need it.
//   - calls into code the analyser did not see go through the function table to the interpreter fallback
//     (PPUTranslator.cpp CallFunction, PPUThread.cpp ppu_recompiler_fallback), the path RPCS3's own code-cave patches use.
//
// Command line: np-adapter-rpcs3-cli.mjs (this module stays free of file access so the installer can bundle it).
import crypto from 'node:crypto';

export const INPUT_SHA256 = '144dee9040da9cb1e8337844fbb685a0f06e560b8fee8d9ba1eac87b9e300c1c';
export const MAGIC = Buffer.from('FCSNP001');
export const TICKET_LENGTH = 72;
export const STATE_SIZE = 128;
const SALT = Buffer.from('6759659904250490566427499489741a', 'hex');
export const nid = (name) => crypto.createHash('sha1').update(Buffer.concat([Buffer.from(name), SALT])).digest().readUInt32LE(0);
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
// hook order is the code layout order (ps3-np-adapter.py); the count is the number of direct calls in the 1.02 executable
export const HOOKS = [['GetStatus', 13], ['GetNpId', 10], ['GetOnlineId', 1], ['GetSigninId', 1], ['GetChatRestrictionFlag', 1], ['GetNetworkTime', 2],
  ['GetContentRatingFlag', 2], ['GetAccountRegion', 3], ['RegisterCallback', 1], ['UnregisterCallback', 1], ['RequestTicket2', 1], ['GetTicket', 6], ['GetTicketParam', 8]];
export const RETAIN = { va: 0x719560, original: 0x987f00e5, replacement: 0x60000000 }; // the caller's "pending = 0" after RequestTicket2

const d = (op, rt, ra, imm) => ((op << 26) | (rt << 21) | (ra << 16) | (imm & 0xffff)) >>> 0;
export function jump(at, target, link = false) {
  const delta = target - at;
  if (delta % 4 || delta < -0x2000000 || delta > 0x1fffffc) throw new Error('branch reach/alignment');
  return (0x48000000 | (delta & 0x3fffffc) | Number(link)) >>> 0;
}
class Code {
  constructor(base) { this.base = base; this.words = []; this.labels = new Map(); this.fixups = []; }
  get pc() { return this.base + 4 * this.words.length; }
  emit(w) { this.words.push(w >>> 0); }
  mark(label) { if (this.labels.has(label)) throw new Error('duplicate label'); this.labels.set(label, this.pc); }
  li(r, value) { this.emit(d(14, r, 0, value)); }
  addr(r, value) { this.emit(d(15, r, 0, value >>> 16)); this.emit(((24 << 26) | (r << 21) | (r << 16) | (value & 0xffff)) >>> 0); }
  cmp(r, value) { this.emit(d(11, 0, r, value)); }
  branch(label, condition = null) { this.fixups.push([this.words.length, label, condition]); this.emit(0); }
  ret(value = 0) { if (value >= -32768 && value <= 32767) this.li(3, value); else this.addr(3, value); this.emit(0x4e800020); }
  check(r, error = 'invalid') { this.cmp(r, 0); this.branch(error, 'eq'); }
  // byte stores: no alignment assumption about the NP structs
  bytesTo(dest, value) { let last = null; value.forEach((v, i) => { if (last !== v) { this.li(12, v); last = v; } this.emit(d(38, 12, dest, i)); }); }
  finish() {
    for (const [index, label, cond] of this.fixups) {
      const at = this.base + 4 * index, target = this.labels.get(label);
      if (target === undefined) throw new Error(`undefined label ${label}`);
      if (cond === null) this.words[index] = jump(at, target);
      else {
        const delta = target - at;
        if (delta % 4 || delta < -32768 || delta > 32764) throw new Error('conditional branch reach');
        this.words[index] = ({ eq: 0x41820000, ne: 0x40820000, lt: 0x41800000, ge: 0x40800000 }[cond] | (delta & 0xfffc)) >>> 0;
      }
    }
    return this.words;
  }
}
const u32be = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const u64be = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const padded = (text, size) => { const b = Buffer.alloc(size); Buffer.from(text, 'ascii').copy(b); return b; };

// The same checks as the server registry and ps3-np-adapter.py. Never put profile.ticketHex in an error message.
export function checkProfile(profile) {
  const { userId, onlineId, ticketHex, issuedMs, expiresMs } = profile ?? {};
  if (!Number.isSafeInteger(userId) || userId <= 0 || userId > 0x7fffffff) throw new Error('userId must be a positive signed 31-bit league ID');
  if (typeof onlineId !== 'string' || !/^[A-Za-z0-9_-]{3,16}$/.test(onlineId)) throw new Error('onlineId must be 3..16 ASCII characters');
  if (typeof ticketHex !== 'string' || !/^[0-9a-fA-F]{144}$/.test(ticketHex) || !Buffer.from(ticketHex.slice(0, 16), 'hex').equals(MAGIC)) throw new Error('Expected provisioned league credential');
  if (!Number.isSafeInteger(issuedMs) || !Number.isSafeInteger(expiresMs) || issuedMs < 0 || issuedMs >= expiresMs) throw new Error('Invalid ticket lifetime');
  return { userId, onlineId, ticket: Buffer.from(ticketHex, 'hex'), issuedMs, expiresMs };
}

// ---- build PC: the addresses, from the stock decrypted 1.02 executable ------------------------------------------------
export function extractTemplate(elf) {
  if (sha256(elf).toString('hex') !== INPUT_SHA256) throw new Error('Unsupported or modified input ELF');
  const u16 = (o) => elf.readUInt16BE(o), u32 = (o) => elf.readUInt32BE(o), u64 = (o) => Number(elf.readBigUInt64BE(o));
  const segs = [];
  for (let i = 0; i < u16(56); i++) {
    const p = u64(32) + i * u16(54);
    if (u32(p) === 1 && u64(p + 32)) segs.push({ flags: u32(p + 4), offset: u64(p + 8), va: u64(p + 16), size: u64(p + 32), memory: u64(p + 40) });
  }
  const offset = (va, size = 4) => {
    const found = segs.filter((s) => s.va <= va && va + size <= s.va + s.size);
    if (found.length !== 1) throw new Error(`unmapped VA ${va.toString(16)}`);
    return found[0].offset + va - found[0].va;
  };
  const imports = new Map();
  for (let o = 0; o < elf.length - 44; o += 4) {
    if ((elf[o] !== 0x1c && elf[o] !== 0x2c) || !(u16(o + 6) > 0 && u16(o + 6) < 1000)) continue;
    try {
      const n = u16(o + 6), ni = offset(u32(o + 20), n * 4), st = offset(u32(o + 24), n * 4), no = offset(u32(o + 16), 1);
      const end = elf.indexOf(0, no); if (end < 0 || end - no > 64) continue;
      const lib = elf.subarray(no, end); if (lib.some((c) => c >= 0x80)) continue;
      const name = lib.toString('ascii'); if (name !== 'sceNp' && name !== 'cellRtc') continue;
      for (let j = 0; j < n; j++) imports.set(`${name}:${u32(ni + j * 4)}`, u32(st + j * 4));
    } catch { /* not an import table */ }
  }
  const stub = (lib, name) => { const v = imports.get(`${lib}:${nid(name)}`); if (v === undefined) throw new Error(`import ${name} not found`); return v; };
  const rx = segs.find((s) => s.flags & 1), rw = segs.find((s) => s.flags & 2);
  const codeVa = (rx.va + rx.size + 15) & ~15, stateVa = (rw.va + rw.memory + 15) & ~15;
  if (stateVa + STATE_SIZE >= 0x10000000) throw new Error('unexpected data placement');
  // RPCS3 maps both segments in 64 KB pages: the code must end before the RX segment's page run does (and before the RW
  // segment starts), the state inside the RW segment's last page
  const page = (v) => Math.ceil(v / 0x10000) * 0x10000;
  const codeLimit = Math.min(rw.va, page(rx.va + rx.memory));
  if (stateVa + STATE_SIZE > page(rw.va + rw.memory)) throw new Error('state does not fit the RW segment page run');
  const stubs = new Map(HOOKS.map(([name]) => [stub('sceNp', `sceNpManager${name}`), name]));
  const sites = Object.fromEntries(HOOKS.map(([name]) => [name, []]));
  for (const s of segs) {
    if (!(s.flags & 1)) continue;
    for (let off = s.offset; off < s.offset + s.size - 3; off += 4) {
      const w = u32(off);
      if (w >>> 26 !== 18 || w & 2) continue;
      let delta = w & 0x3fffffc; if (delta & 0x2000000) delta -= 0x4000000;
      const at = s.va + off - s.offset, name = stubs.get(at + delta);
      if (!name) continue;
      if (!(w & 1)) throw new Error('Unexpected tail call');
      sites[name].push(at);
    }
  }
  for (const [name, count] of HOOKS) if (sites[name].length !== count) throw new Error(`Unexpected ${name} caller count: ${sites[name].length}`);
  if (u32(offset(RETAIN.va)) !== RETAIN.original) throw new Error('Request pending flag original differs');
  return { format: 1, titleId: 'BLUS31159', version: '01.02', inputSha256: INPUT_SHA256, codeVa, codeLimit, stateVa,
    rtcClock: stub('cellRtc', 'cellRtcGetCurrentClock'), rtcTick: stub('cellRtc', 'cellRtcGetTick'),
    stubs: Object.fromEntries([...stubs].map(([va, name]) => [name, va])), sites };
}
export function checkTemplate(t) {
  const va = (v) => Number.isSafeInteger(v) && v >= 0x10000 && v < 0x10000000 && v % 4 === 0;
  if (t?.format !== 1 || !va(t.codeVa) || !va(t.codeLimit) || !va(t.stateVa) || !va(t.rtcClock) || !va(t.rtcTick) || t.codeVa >= t.codeLimit) throw new Error('Invalid adapter template');
  for (const [name, count] of HOOKS) if (!Array.isArray(t.sites?.[name]) || t.sites[name].length !== count || !t.sites[name].every(va) || !va(t.stubs?.[name])) throw new Error(`Invalid adapter template (${name})`);
  return t;
}

// ---- anywhere: the adapter code for one profile -------------------------------------------------------------------
// Returns { code: [va, word][], hooks: { name: va }, patches: [va, word, original][], ticketStore, digestStore }.
// ticketStore / digestStore are the [startVa, endVa) of the only instructions that carry the credential (as li/stb
// immediates in GetTicket) and its SHA-256 prefix (GetTicketParam 0); nothing else in the output depends on it except
// branch displacements across those two runs, whose length varies with repeated bytes.
export function assemble(template, profile) {
  const t = checkTemplate(template), { userId, onlineId, ticket, issuedMs, expiresMs } = checkProfile(profile);
  const state = t.stateVa, c = new Code(t.codeVa), hooks = {};
  const start = (name) => { hooks[name] = c.pc; c.mark(name); };
  const outputHook = (name, value) => { start(name); c.check(3); c.bytesTo(3, value); c.ret(); };
  outputHook('GetStatus', u32be(3));
  outputHook('GetNpId', padded(onlineId, 36));
  outputHook('GetOnlineId', padded(onlineId, 20));
  outputHook('GetSigninId', padded(`${onlineId}@league.invalid`, 64));
  outputHook('GetChatRestrictionFlag', Buffer.alloc(4));
  // the console clock through the game's own cellRtc imports, not an NP network-time service
  start('GetNetworkTime'); c.check(3);
  c.emit(0x7c0802a6); c.emit(0xf8010010); c.emit(0xf821ff61); // mflr r0; std r0,0x10(r1); stdu r1,-0xa0(r1)
  c.emit(0xf8610070); c.emit(d(14, 3, 1, 0x80)); c.li(4, 0);
  c.emit(jump(c.pc, t.rtcClock, true));
  c.cmp(3, 0); c.branch('rtc_end', 'ne');
  c.emit(d(14, 3, 1, 0x80)); c.emit(0xe8810070);
  c.emit(jump(c.pc, t.rtcTick, true));
  c.mark('rtc_end'); c.emit(d(14, 1, 1, 0xa0)); c.emit(0xe8010010); c.emit(0x7c0803a6); c.emit(0x4e800020);
  start('GetContentRatingFlag'); c.check(3); c.check(4);
  c.bytesTo(3, Buffer.alloc(4)); c.bytesTo(4, u32be(18)); c.ret();
  start('GetAccountRegion'); c.check(3); c.check(4);
  c.bytesTo(3, Buffer.from('us\0\0')); c.bytesTo(4, u32be(1)); c.ret();
  start('RegisterCallback'); c.check(3); c.check(4); c.addr(11, state);
  c.emit(d(36, 4, 11, 0)); c.li(12, 0); c.emit(d(36, 12, 11, 8));
  c.emit(d(38, 12, 4, 0xe4)); c.li(12, -1); c.emit(d(38, 12, 4, 0xe5)); c.ret();
  start('UnregisterCallback'); c.addr(11, state); c.emit(d(32, 10, 11, 0)); c.cmp(10, 0); c.branch('unregistered', 'eq');
  c.li(12, -1); c.emit(d(38, 12, 10, 0xe5)); c.li(12, 0); c.emit(d(38, 12, 10, 0xed)); c.emit(d(38, 12, 10, 0xe4));
  c.mark('unregistered'); c.li(12, 0); c.emit(d(36, 12, 11, 0)); c.emit(d(36, 12, 11, 8)); c.ret();
  start('RequestTicket2'); c.check(3); c.check(4); c.check(5); c.addr(11, state);
  c.emit(d(32, 10, 11, 0)); c.check(10, 'notready');
  // the one caller holds NetConn's mutex: queue the completion, never call the manager callback from here
  c.li(6, 0); c.emit(d(14, 7, 11, 16)); c.mark('service_copy');
  c.emit(d(34, 12, 5, 0)); c.emit(d(38, 12, 7, 0)); c.cmp(12, 0); c.branch('service_done', 'eq');
  c.emit(d(14, 5, 5, 1)); c.emit(d(14, 7, 7, 1)); c.emit(d(14, 6, 6, 1)); c.cmp(6, 63); c.branch('service_copy', 'lt');
  c.li(12, 0); c.emit(d(38, 12, 7, 0)); c.branch('invalid');
  c.mark('service_done'); c.li(12, 1); c.emit(d(36, 12, 11, 8)); c.emit(d(38, 12, 10, 0xe5));
  c.li(12, ticket.length); c.emit(d(36, 12, 10, 0xe0)); c.ret();
  start('GetTicket'); c.check(4); c.addr(11, state); c.emit(d(32, 12, 11, 8)); c.check(12, 'notready');
  c.emit(d(32, 5, 4, 0)); c.li(12, ticket.length); c.emit(d(36, 12, 4, 0)); c.cmp(3, 0); c.branch('success', 'eq');
  c.emit(d(10, 0, 5, ticket.length)); c.branch('small', 'lt');
  const ticketStore = [c.pc, 0]; c.bytesTo(3, ticket); ticketStore[1] = c.pc; c.ret();
  start('GetTicketParam'); c.check(4); c.addr(11, state); c.emit(d(32, 12, 11, 8)); c.check(12, 'notready');
  c.emit(d(10, 0, 3, 12)); c.branch('invalid', 'ge');
  c.bytesTo(4, Buffer.alloc(256));
  // Param 1 is the ticket issuer. The game maps issuer 1 to EA's TEST environment (gosredirector.stest.ea.com) and 8 to
  // CERT (VA 0x71aaa8); anything else is production. 0x100 is the real PSN production issuer.
  const values = new Map([[0, sha256(ticket).subarray(0, 20)], [1, u32be(0x100)], [2, u64be(issuedMs)], [3, u64be(expiresMs)], [4, u64be(userId)],
    [5, Buffer.from(`${onlineId}\0`)], [6, Buffer.from('us\0\x01', 'latin1')], [7, Buffer.from('league\0')], [9, Buffer.alloc(4)], [10, Buffer.alloc(4)],
    [11, Buffer.from([2000 >> 8, 2000 & 255, 1, 1])]]);
  for (let param = 0; param < 12; param++) { c.cmp(3, param); c.branch(`param${param}`, 'eq'); }
  c.branch('invalid');
  const digestStore = [0, 0];
  for (const [param, value] of values) {
    c.mark(`param${param}`);
    if (param === 0) { digestStore[0] = c.pc; c.bytesTo(4, value); digestStore[1] = c.pc; } else c.bytesTo(4, value);
    c.ret();
  }
  c.mark('param8'); c.li(5, 0); c.emit(d(14, 6, 11, 16)); c.mark('param_service');
  c.emit(d(34, 12, 6, 0)); c.emit(d(38, 12, 4, 0)); c.cmp(12, 0); c.branch('success', 'eq');
  c.emit(d(14, 6, 6, 1)); c.emit(d(14, 4, 4, 1)); c.emit(d(14, 5, 5, 1)); c.cmp(5, 64); c.branch('param_service', 'lt'); c.branch('invalid');
  c.mark('success'); c.ret();
  c.mark('invalid'); c.ret(0x8002aa03);
  c.mark('notready'); c.ret(0x8002aa0a);
  c.mark('small'); c.ret(0x8002aa0f);
  const words = c.finish();
  if (t.codeVa + 4 * words.length > t.codeLimit) throw new Error('adapter code does not fit after the executable segment');
  const code = words.map((w, i) => [t.codeVa + 4 * i, w]);
  const patches = [];
  for (const [name] of HOOKS) for (const va of t.sites[name]) patches.push([va, jump(va, hooks[name], true), jump(va, t.stubs[name], true)]);
  patches.push([RETAIN.va, RETAIN.replacement, RETAIN.original]);
  return { code, hooks, patches, ticketStore, digestStore, stateVa: state, credentialSha256: sha256(ticket).toString('hex') };
}
// every word RPCS3 has to write, low address first: [va, word]
export function adapterWords(template, profile) {
  const a = assemble(template, profile), all = [...a.patches.map(([va, w]) => [va, w]), ...a.code].sort((x, y) => x[0] - y[0]);
  for (let i = 1; i < all.length; i++) if (all[i][0] === all[i - 1][0]) throw new Error('adapter words overlap');
  return all;
}
// what a run of `li r12,v` / `stb r12,i(rN)` words stores, by offset (tests and `status`-style checks; no secrets printed)
export function decodeByteStores(words) {
  const out = []; let cur = null;
  for (const w of words) {
    if (w >>> 16 === ((14 << 10) | (12 << 5))) cur = w & 0xff;
    else if (w >>> 26 === 38 && ((w >>> 21) & 31) === 12) { if (cur === null) throw new Error('store before load'); out[w & 0xffff] = cur; }
    else throw new Error('not a byte-store run');
  }
  return Buffer.from(out);
}
