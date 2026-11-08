import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { SCOREBUG_PATH, readScorebug, restoreScorebug, revertScorebug, scorebugChain, scorebugSha, scorebugSnapshot, scorebugTeams, setScorebugTeams, writeScorebug } from '../src/scorebug.js';

// A BGFA container: one prefix word, records {flags (flagsW bytes), u64 hash, u32 off, u32 csize, u32 usize-csize};
// `gap` bytes between the header and the TOC (the outer score bug bigfile does not start its TOC at 64); entries
// 8-byte aligned.
function bgfa(entries: { hash: bigint; data: Buffer; usize?: number }[], flagsW: 1 | 2, gap = 0): Buffer {
  const rec = flagsW + 20, tocOff = 64 + gap, tocSize = 4 + rec * entries.length;
  const head = Buffer.alloc(tocOff); head.write('BGFA1.05', 0, 'latin1');
  head.writeUInt32LE(entries.length + 1, 8); head.writeUInt32LE(entries.length, 12); head.writeUInt32LE(tocOff, 16); head.writeUInt32LE(tocSize, 24);
  head.writeUInt32LE(0x04080000 | ((flagsW - 1) << 8), 32); head.writeUInt32LE(0x404, 36); head.writeUInt32LE(1, 40);
  const toc = Buffer.alloc(tocSize); const parts: { off: number; data: Buffer }[] = []; let off = tocOff + tocSize;
  entries.forEach((e, k) => {
    off = Math.ceil(off / 8) * 8; const p = 4 + k * rec; toc[p] = 1;
    toc.writeBigUInt64LE(e.hash, p + flagsW); toc.writeUInt32LE(off, p + flagsW + 8); toc.writeUInt32LE(e.data.length, p + flagsW + 12); toc.writeUInt32LE((e.usize ?? e.data.length) - e.data.length, p + flagsW + 16);
    parts.push({ off, data: e.data }); off += e.data.length;
  });
  const out = Buffer.alloc(Math.ceil(off / 8) * 8); head.copy(out); toc.copy(out, tocOff);
  for (const x of parts) x.data.copy(out, x.off);
  return out;
}
// Apt Data with CFBR's team table: 56-byte blocks starting at an offset = 1 mod 4 (as in the real one, so the aligned
// operands land where they do there), `b9 08 b6 <NN> 49 12 9d .. .. .. <s32 41> b7 <c1> 87 .. .. <4> 17 b7 <c2> 87 ..
// <5> 17 a1 .. .. <ptr> 87 .. .. .. <3> 17`, then other code, the names (4-aligned) and an incompressible tail.
const CHAIN_AT = 61;
function apt(teams: { index?: number; name: string; color: number; color2?: number }[], pad = 0): Buffer {
  const names = teams.map((t) => { const b = Buffer.alloc(Math.ceil((t.name.length + 1) / 4) * 4); b.write(t.name, 'latin1'); return b; });
  const after = CHAIN_AT + 56 * teams.length, namesAt = Math.ceil((after + 16) / 4) * 4; let p = namesAt; const ptrs = names.map((n) => { const at = p; p += n.length; return at; });
  const out = Buffer.alloc(p + pad); out.write('Apt Data:1:8:4', 0, 'latin1');
  teams.forEach((t, i) => {
    const h = CHAIN_AT + 56 * i; out[h] = 0xb9; out[h + 1] = 8; out[h + 2] = 0xb6; out.writeUInt16BE(t.index ?? i, h + 3); out[h + 5] = 0x49; out[h + 6] = 0x12; out[h + 7] = 0x9d; out.writeInt32BE(41, h + 11);
    out[h + 15] = 0xb7; out.writeUInt32BE(t.color, h + 16); out[h + 20] = 0x87; out.writeUInt32BE(4, h + 23); out[h + 27] = 0x17;
    out[h + 28] = 0xb7; out.writeUInt32BE(t.color2 ?? t.color, h + 29); out[h + 33] = 0x87; out.writeUInt32BE(5, h + 35); out[h + 39] = 0x17;
    out[h + 40] = 0xa1; out.writeUInt32BE(ptrs[i]!, h + 43); out[h + 47] = 0x87; out.writeUInt32BE(3, h + 51); out[h + 55] = 0x17;
  });
  Buffer.from('b90673491299', 'hex').copy(out, after); // whatever code follows the table
  names.forEach((n, i) => n.copy(out, ptrs[i]!));
  for (let i = p; i < out.length; i++) out[i] = (i * 7919 + (i >> 7)) & 255;
  return out;
}
function archive(a: Buffer, stream = deflateSync(a, { level: 1 }), after = false): Buffer {
  const inner = bgfa([{ hash: SCOREBUG_PATH[2], data: stream, usize: a.length }, { hash: 0x1111n, data: Buffer.from('next entry') }], 2);
  const mid = bgfa([{ hash: 0x2222n, data: Buffer.from('x') }, { hash: SCOREBUG_PATH[1], data: inner }, { hash: 0x5555n, data: Buffer.from('after the bigfile') }], 1, 40);
  return bgfa([{ hash: 0x3333n, data: Buffer.alloc(100, 7) }, { hash: SCOREBUG_PATH[0], data: mid }, ...(after ? [{ hash: 0x4444n, data: Buffer.alloc(300, 9) }] : [])], 2);
}
const tmp = (b: Buffer) => { const d = mkdtempSync(join(tmpdir(), 'scorebug-')); const f = join(d, 'qkl_patch.ast'); writeFileSync(f, b); return { d, f }; };
// the table's opcodes run for one teamLogoId: what r3 / r4 / r5 come out as (the game's values when no entry matches)
function lookup(b: Buffer, r8: number): { name: unknown; c1: unknown; c2: unknown } {
  const ch = scorebugChain(b)!, al = (p: number) => Math.ceil(p / 4) * 4, reg: Record<number, unknown> = { 3: 'GAME', 4: -1, 5: -1, 8: r8 }, st: unknown[] = []; let pc = ch.start, n = 0;
  while (pc !== ch.end) {
    if (pc < ch.start || pc > ch.end || ++n > 1e5) throw new Error(`pc ${pc} left the table`);
    const op = b[pc]!, o = al(pc + 1);
    if (op === 0xb9) { st.push(reg[b[pc + 1]!]); pc += 2; } else if (op === 0xb6) { st.push(b.readUInt16BE(pc + 1)); pc += 3; } else if (op === 0xb7) { st.push(b.readUInt32BE(pc + 1)); pc += 5; }
    else if (op === 0xa1) { const p = b.readUInt32BE(o); st.push(b.toString('latin1', p, b.indexOf(0, p))); pc = o + 4; }
    else if (op === 0x49) { const y = st.pop(); st.push(st.pop() === y); pc++; } else if (op === 0x12) { st.push(!st.pop()); pc++; }
    else if (op === 0x9d) { pc = o + 4 + (st.pop() ? b.readInt32BE(o) : 0); } else if (op === 0x99) { pc = o + 4 + b.readInt32BE(o); }
    else if (op === 0x87) { reg[b.readUInt32BE(o)] = st[st.length - 1]; pc = o + 4; } else if (op === 0x17) { if (!st.length) throw new Error(`pop on an empty stack at ${pc}`); st.pop(); pc++; }
    else throw new Error(`opcode ${op.toString(16)} at ${pc}`);
  }
  expect(st).toEqual([]);
  return { name: reg[3], c1: reg[4], c2: reg[5] };
}

describe('score bug (qkl_patch.ast -> nested bigfiles -> Apt Data)', () => {
  const stock = apt([{ name: 'Morehead St', color: 0xffcf00 }, { name: 'Kennesaw', color: 0xfdbb30 }, { name: 'Delaware St', color: 0xee3124, color2: 0x111111 }], 600);
  const fixed = Buffer.from(stock); const k = fixed.indexOf('Kennesaw'); fixed.fill(0, k, k + 8); fixed.write('RMU', k, 'latin1');
  fixed.writeUInt32BE(0x15234b, CHAIN_AT + 56 + 16); fixed.writeUInt32BE(0x15234b, CHAIN_AT + 56 + 29);

  it('finds the Apt Data through both BGFA layouts and decodes the team table', () => {
    const { f } = tmp(archive(stock)); const loc = readScorebug(f)!;
    expect(loc.apt.equals(stock)).toBe(true);
    expect(scorebugTeams(loc.apt).map((t) => [t.index, t.name, t.primary, t.secondary])).toEqual([[0, 'Morehead St', 0xffcf00, 0xffcf00], [1, 'Kennesaw', 0xfdbb30, 0xfdbb30], [2, 'Delaware St', 0xee3124, 0x111111]]);
    expect(loc.slot).toBeGreaterThanOrEqual(loc.stream.length);
  });

  it('team table: CFBR layout re-encodes byte for byte; a team is added compactly and removed back to the same bytes', () => {
    const big = apt(Array.from({ length: 12 }, (_, i) => ({ index: i < 10 ? i : i + 20, name: `Team ${i}`, color: 0x100000 + i, color2: 0x200000 + i })), 40);
    expect(setScorebugTeams(big, {}).equals(big)).toBe(true);
    const plus = setScorebugTeams(big, { 15: { name: 'Pittsburgh', primary: 0x003b9d, secondary: 0xffb81c }, 16: { name: 'San José St', primary: 1, secondary: 2 } });
    expect(plus.length).toBeGreaterThan(big.length); expect(plus.subarray(CHAIN_AT + 56 * 12).subarray(0, big.length - CHAIN_AT - 56 * 12).equals(big.subarray(CHAIN_AT + 56 * 12))).toBe(true); // nothing after the table moves
    expect(scorebugChain(plus)!.layout).toBe('compact');
    for (let id = 0; id < 40; id++) {
      const want = id === 15 ? { name: 'Pittsburgh', c1: 0x003b9d, c2: 0xffb81c } : id === 16 ? { name: 'San José St', c1: 1, c2: 2 } : id < 10 ? { name: `Team ${id}`, c1: 0x100000 + id, c2: 0x200000 + id } : id >= 30 && id < 32 ? { name: `Team ${id - 20}`, c1: 0x100000 + id - 20, c2: 0x200000 + id - 20 } : { name: 'GAME', c1: -1, c2: -1 };
      expect(lookup(plus, id)).toEqual(want);
    }
    const again = setScorebugTeams(plus, { 15: { name: 'Florida', primary: 3, secondary: 4 } });
    expect(lookup(again, 15)).toEqual({ name: 'Florida', c1: 3, c2: 4 }); expect(lookup(again, 16)).toEqual({ name: 'San José St', c1: 1, c2: 2 });
    expect(setScorebugTeams(again, { 15: null, 16: null }).equals(big)).toBe(true);
    expect(() => setScorebugTeams(big, Object.fromEntries(Array.from({ length: 40 }, (_, i) => [100 + i, { name: 'X', primary: 0, secondary: 0 }])))).toThrow(/do not fit/);
  });

  it('writes in place when the stream fits (slot + TOC record only), is idempotent, and restores', () => {
    const orig = archive(stock); const { d, f } = tmp(orig); const before = readScorebug(f)!;
    const r = writeScorebug(f, deflateSync(fixed, { level: 9 }), join(d, 'bk'), { replaces: [before.sha] });
    expect(r.status).toBe('written'); expect(r.note).toMatch(/in place/);
    const now = readFileSync(f); expect(now.length).toBe(orig.length);
    for (let i = 0; i < now.length; i++) if (now[i] !== orig[i]) expect((i >= before.slotOffset && i < before.slotOffset + before.slot) || (i >= before.recOffset && i < before.recOffset + before.rec.length)).toBe(true);
    const after = readScorebug(f)!; expect(after.apt.equals(fixed)).toBe(true);
    expect(scorebugTeams(after.apt)[1]).toMatchObject({ name: 'RMU', primary: 0x15234b, secondary: 0x15234b });
    expect(writeScorebug(f, deflateSync(fixed, { level: 9 }), join(d, 'bk2'), { replaces: [before.sha] }).status).toBe('already');
    expect(restoreScorebug(join(d, 'bk'))).toMatch(/restored/);
    expect(readFileSync(f).equals(orig)).toBe(true);
  });

  for (const after of [false, true]) it(`appends a stream that does not fit (score bug bigfile ${after ? 'mid-archive' : 'last'}), rewrites it in place later, restores, reverts`, () => {
    const eight = apt(Array.from({ length: 8 }, (_, i) => ({ name: `Team ${i}`, color: i })), 600);
    const orig = archive(eight, undefined, after); const { d, f } = tmp(orig); const snap = scorebugSnapshot(f);
    const one = setScorebugTeams(eight, { 122: { name: 'Pittsburgh', primary: 0x003b9d, secondary: 0xffb81c } }), z1 = deflateSync(one, { level: 0 });
    expect(z1.length).toBeGreaterThan(readScorebug(f)!.slot);
    const r1 = writeScorebug(f, z1, join(d, 'a1')); expect(r1.note).toMatch(/appended/);
    expect(readScorebug(f)!.apt.equals(one)).toBe(true); expect(lookup(readScorebug(f)!.apt, 122)).toEqual({ name: 'Pittsburgh', c1: 0x003b9d, c2: 0xffb81c });
    const size1 = statSync(f).size;
    const two = setScorebugTeams(one, { 122: { name: 'Florida', primary: 1, secondary: 2 } }); writeScorebug(f, deflateSync(two, { level: 0 }), join(d, 'a2'));
    expect(readScorebug(f)!.apt.equals(two)).toBe(true); expect(statSync(f).size).toBeLessThanOrEqual(size1 + 16); // the second write reuses the tail
    expect(restoreScorebug(join(d, 'a2'))).toMatch(/restored/); expect(readScorebug(f)!.apt.equals(one)).toBe(true); expect(statSync(f).size).toBe(size1);
    expect(scorebugSha(setScorebugTeams(one, { 122: null }))).toBe(snap.sha);
    if (!after) { expect(() => revertScorebug(f, snap)).toThrow(/no longer reads back/); return; } // the bigfile was last: rewritten in place, the snapshot's bytes are gone
    expect(revertScorebug(f, snap)).toMatch(/before the first swap/);
    expect(readFileSync(f).equals(orig)).toBe(true);
  });

  it('leaves a score bug it does not know alone', () => {
    const orig = archive(stock); const { d, f } = tmp(orig);
    expect(writeScorebug(f, deflateSync(fixed), join(d, 'a'), { replaces: ['0'.repeat(64)] }).status).toBe('skipped');
    expect(readFileSync(f).equals(orig)).toBe(true);
  });
});
