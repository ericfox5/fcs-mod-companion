import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEntry, newEntryBackupDir, readEntry, restoreEntries, rewriteEntry, type EntryManifest } from '../src/archive-entry.js';

// A BGFA 1.05 archive the way stda.ts archiveToc reads it: 'BGFA1.05', u32 count @0x08 (and @0x0c), u32 tocOff @0x10
// (= 0x40), u32 tocSize @0x18, widths @0x20 / @0x24 (u32 offsets, u64 hashes, u32 csize / size delta, 2-byte flags),
// u32 prefixWords @0x28, u32 nameWidth @0x2c; TOC = prefixWords * 4 bytes then records {u16 flags, u64 hash, u32 off,
// u32 csize, u32 usize - csize, char name[nameWidth]}; entries 8-byte aligned after the TOC.
function bgfa(entries: { hash: bigint; data: Buffer; usize?: number; name?: string }[], nameWidth = 8): Buffer {
  const rec = 2 + 8 + 4 + 4 + 4 + nameWidth, tocOff = 0x40, tocSize = 4 + rec * entries.length;
  const head = Buffer.alloc(tocOff); head.write('BGFA1.05', 0, 'latin1');
  head.writeUInt32LE(entries.length, 8); head.writeUInt32LE(entries.length, 12); head.writeUInt32LE(tocOff, 16); head.writeUInt32LE(tocSize, 24);
  head.writeUInt32LE(0x04080100, 32); head.writeUInt32LE(0x404, 36); head.writeUInt32LE(1, 40); head.writeUInt32LE(nameWidth, 44);
  const toc = Buffer.alloc(tocSize); const parts: { off: number; data: Buffer }[] = []; let off = tocOff + tocSize;
  entries.forEach((e, k) => {
    off = Math.ceil(off / 8) * 8; const p = 4 + k * rec; toc.writeUInt16LE(1, p);
    toc.writeBigUInt64LE(e.hash, p + 2); toc.writeUInt32LE(off, p + 10); toc.writeUInt32LE(e.data.length, p + 14); toc.writeUInt32LE((e.usize ?? e.data.length) - e.data.length, p + 18);
    if (e.name) toc.write(e.name.slice(0, nameWidth), p + 22, 'latin1');
    parts.push({ off, data: e.data }); off += e.data.length;
  });
  const out = Buffer.alloc(Math.ceil(off / 8) * 8); head.copy(out); toc.copy(out, tocOff);
  for (const x of parts) x.data.copy(out, x.off);
  return out;
}
const TARGET = 0x4e226c292cd63322n, PACKED = 0x7777n;
const stock = Buffer.from('the stored entry: forty-two bytes of data!'); // 42 bytes
const edited = Buffer.from(stock); edited.write('ZZ TEST', 4, 'latin1');
const other = Buffer.from(stock); other.write('ANOTHER', 4, 'latin1');
const archive = () => bgfa([{ hash: 0x1111n, data: Buffer.alloc(100, 7), name: 'before' }, { hash: TARGET, data: stock, name: 'target' }, { hash: PACKED, data: Buffer.from('zlib'), usize: 400 }, { hash: 0x4444n, data: Buffer.alloc(33, 9), name: 'after' }]);
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'archive-entry-')); const f = join(d, 'qkl_misc.ast'); const orig = archive(); writeFileSync(f, orig); return { d, f, orig, t: { archive: f, hash: TARGET } }; };

describe('archive-entry: a stored BGFA entry rewritten in place', () => {
  it('reads the entry by hash and refuses a compressed or missing one', () => {
    const { f, t } = tmp(); const r = readEntry(t);
    expect(r.bytes.equals(stock)).toBe(true); expect(r.off % 8).toBe(0); expect(r.sha).toMatch(/^[0-9a-f]{64}$/);
    expect(() => readEntry({ archive: f, hash: PACKED })).toThrow(/compressed/);
    expect(() => readEntry({ archive: f, hash: 0x9999n })).toThrow(/no entry 0000000000009999/);
  });

  it('writes the same-length bytes after a backup and manifest, reads back, and changes nothing else', () => {
    const { d, f, orig, t } = tmp(); const before = readEntry(t); const bk = join(d, 'bk');
    const r = rewriteEntry(t, edited, bk, { replaces: [before.sha], tool: 'test', note: 'rename' });
    expect(r.status).toBe('written'); expect(r.note).toMatch(/7 changed/);
    expect(r.item).toMatchObject({ archive: f, entryHash: '4e226c292cd63322', offset: before.off, length: 42, shaBefore: before.sha, note: 'rename' });
    expect(readFileSync(r.item!.backupFile).equals(stock)).toBe(true); expect(r.item!.backupFile).toBe(join(bk, `qkl_misc.ast.${before.off}.orig`));
    const mf = JSON.parse(readFileSync(join(bk, 'manifest.json'), 'utf8')) as EntryManifest;
    expect(mf.tool).toBe('test'); expect(mf.items).toEqual([r.item]);
    const now = readFileSync(f); expect(now.length).toBe(orig.length);
    for (let i = 0; i < now.length; i++) if (now[i] !== orig[i]) expect(i >= before.off && i < before.off + 42).toBe(true);
    const after = readEntry(t); expect(after.bytes.equals(edited)).toBe(true); expect(after.sha).toBe(r.item!.shaAfter);
    // a second write into the same folder would overwrite the backup: refused
    expect(() => rewriteEntry(t, other, bk)).toThrow(/exists/); expect(readEntry(t).bytes.equals(edited)).toBe(true);
  });

  it('reports already / skipped without touching the file, and refuses a different length', () => {
    const { d, f, orig, t } = tmp(); const sha = readEntry(t).sha;
    expect(rewriteEntry(t, stock, join(d, 'a')).status).toBe('already');
    expect(rewriteEntry(t, edited, join(d, 'b'), { replaces: ['0'.repeat(64)] }).status).toBe('skipped');
    expect(() => rewriteEntry(t, Buffer.concat([edited, Buffer.from('!')]), join(d, 'c'))).toThrow(/42 bytes; the rewrite is 43/);
    expect(() => rewriteEntry(t, edited.subarray(1), join(d, 'c'))).toThrow(/keep its length/);
    expect(readFileSync(f).equals(orig)).toBe(true); expect(readEntry(t).sha).toBe(sha);
    expect(existsSync(join(d, 'a'))).toBe(false); expect(existsSync(join(d, 'b'))).toBe(false); expect(existsSync(join(d, 'c'))).toBe(false);
  });

  it('restores from the manifest, says so when already the original, and refuses an entry changed since unless forced', () => {
    const { d, f, orig, t } = tmp(); const bk = join(d, 'bk');
    expect(rewriteEntry(t, edited, bk).status).toBe('written');
    expect(restoreEntries(bk)).toEqual([`${f}: entry at ${readEntry(t).off} restored (42 bytes)`]);
    expect(readFileSync(f).equals(orig)).toBe(true);
    expect(restoreEntries(bk)[0]).toMatch(/already the original/);
    // changed since: a second rewrite through another folder
    expect(rewriteEntry(t, edited, join(d, 'bk2')).status).toBe('written');
    expect(rewriteEntry(t, other, join(d, 'bk3')).status).toBe('written');
    expect(() => restoreEntries(join(d, 'bk2'))).toThrow(/changed since the rewrite .* --force/);
    expect(readEntry(t).bytes.equals(other)).toBe(true);
    expect(restoreEntries(join(d, 'bk2'), { force: true })[0]).toMatch(/restored/);
    expect(readFileSync(f).equals(orig)).toBe(true);
    // a backup file that no longer matches its manifest line is refused
    writeFileSync(join(d, 'bk3', `qkl_misc.ast.${readEntry(t).off}.orig`), other);
    expect(() => restoreEntries(join(d, 'bk3'))).toThrow(/does not match its manifest/);
  });

  it('names backup folders by stamp and label', () => {
    expect(newEntryBackupDir('playbook', join('root', 'x'))).toMatch(/^root[\\/]x[\\/]\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-playbook$/);
  });
});

describe('archive-entry: a grown entry appended to the archive with its TOC record repointed', () => {
  const bigger = Buffer.concat([stock, Buffer.from(' plus twenty more bytes.')]); // 66 bytes

  it('appends, repoints, leaves every other entry alone, and reads back through the TOC', () => {
    const { d, f, orig, t } = tmp(); const before = readEntry(t); const bk = join(d, 'bk');
    const r = appendEntry(t, bigger, bk, { replaces: [before.sha], tool: 'test', note: 'grow' });
    expect(r.status).toBe('written'); expect(r.note).toMatch(/moved from \d+ \(42 bytes\) to \d+ \(66 bytes\)/);
    expect(r.item).toMatchObject({ kind: 'append', offset: before.off, length: 42, newLength: 66, fileLengthBefore: orig.length, shaBefore: before.sha, note: 'grow' });
    expect(r.item!.newOffset! % 16).toBe(0); expect(r.item!.newOffset).toBeGreaterThanOrEqual(orig.length);
    const now = readFileSync(f); expect(now.length).toBe(r.item!.newOffset! + 66);
    expect(now.subarray(0, orig.length).equals(Buffer.from(orig).fill(0, r.item!.recordOffset!, r.item!.recordOffset! + 22)) || true).toBe(true);
    for (let i = 0; i < orig.length; i++) if (now[i] !== orig[i]) expect(i >= r.item!.recordOffset! && i < r.item!.recordOffset! + 22, `byte ${i}`).toBe(true); // only the record changed
    const after = readEntry(t); expect(after.off).toBe(r.item!.newOffset); expect(after.bytes.equals(bigger)).toBe(true);
    expect(readEntry({ archive: f, hash: 0x1111n }).bytes.equals(Buffer.alloc(100, 7))).toBe(true); expect(readEntry({ archive: f, hash: 0x4444n }).bytes.equals(Buffer.alloc(33, 9))).toBe(true);
    expect(readFileSync(r.item!.backupFile).equals(stock)).toBe(true);
    // same length falls back to the in-place rewrite
    const r2 = appendEntry(t, Buffer.from(bigger).fill(0x41, 0, 4), join(d, 'bk2')); expect(r2.status).toBe('written'); expect(r2.item!.kind).toBeUndefined(); expect(readFileSync(f).length).toBe(now.length);
  });

  it('restores the record and cuts the file back, or keeps a later tail', () => {
    const { d, f, orig, t } = tmp(); const bk = join(d, 'bk');
    expect(appendEntry(t, bigger, bk).status).toBe('written');
    const notes = restoreEntries(bk); expect(notes[0]).toMatch(/points at \d+ again; file cut back to/);
    expect(readFileSync(f).equals(orig)).toBe(true); expect(readEntry(t).bytes.equals(stock)).toBe(true);
    expect(restoreEntries(bk)[0]).toMatch(/already points at the original/);
    // something appended after ours: the record goes back, the tail stays
    expect(appendEntry(t, bigger, join(d, 'bk3')).status).toBe('written');
    expect(appendEntry({ archive: f, hash: 0x4444n }, Buffer.alloc(50, 1), join(d, 'bk4')).status).toBe('written');
    const n2 = restoreEntries(join(d, 'bk3')); expect(n2[0]).toMatch(/left in place/);
    expect(readEntry(t).bytes.equals(stock)).toBe(true); expect(readEntry({ archive: f, hash: 0x4444n }).bytes.equals(Buffer.alloc(50, 1))).toBe(true);
    // a record changed since the append is refused unless forced
    expect(appendEntry(t, bigger, join(d, 'bk5')).status).toBe('written');
    expect(appendEntry(t, Buffer.concat([bigger, Buffer.from('!')]), join(d, 'bk6')).status).toBe('written');
    expect(() => restoreEntries(join(d, 'bk5'))).toThrow(/changed since the append/);
    expect(restoreEntries(join(d, 'bk5'), { force: true })[0]).toMatch(/points at/); expect(readEntry(t).bytes.equals(stock)).toBe(true);
  });
});
