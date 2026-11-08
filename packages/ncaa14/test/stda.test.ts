import { describe, it, expect } from 'vitest';
import { TdbFile, TdbTable, parseTdb, serializeTdb, verifyTdb, BIG_ENDIAN, type TdbFieldDef, type TdbTableHeader } from '@ncaa/tdb';
import { genericRosterStride, rekeyGenericRosters, rewriteStandardData } from '../src/stda.js';

// A real big-endian TDB table (names stored reversed, as on the PS3) with unsigned fields packed MSB first.
function table(name: string, cols: [string, number][], rows: Record<string, number>[]): TdbTable {
  const rev = (s: string) => Uint8Array.from([...s].reverse(), (c) => c.charCodeAt(0));
  let bit = 0; const fields: TdbFieldDef[] = cols.map(([n, bits]) => { const f = { type: 3, bitOffset: bit, name: n, nameRaw: rev(n), bits }; bit += bits; return f; });
  const lengthBytes = Math.ceil(bit / 32) * 4;
  const raw = new Uint8Array(fields.length * 16); const dv = new DataView(raw.buffer);
  fields.forEach((f, i) => { dv.setUint32(i * 16, f.type); dv.setUint32(i * 16 + 4, f.bitOffset); raw.set(f.nameRaw, i * 16 + 8); dv.setUint32(i * 16 + 12, f.bits); });
  const header: TdbTableHeader = { priorCrc: 0, allocType: 2, lengthBytes, lengthBits: bit, zero: 0, maxRecords: rows.length, currentRecords: rows.length, unknown2: 0xffff, numFields: fields.length, indexCount: 0, zero2: 0, zero3: 0, headerCrc: 0 };
  const t = new TdbTable(name, rev(name), header, fields, raw, new Uint8Array(lengthBytes * rows.length), new Uint8Array(0));
  rows.forEach((r, i) => { for (const [k, v] of Object.entries(r)) t.set(i, k, v); });
  return t;
}
function db(tables: TdbTable[]): Uint8Array {
  const directory = tables.map((t) => ({ name: t.name, nameRaw: t.nameRaw, offset: 0 }));
  const file = new TdbFile({ digit: 0x4442, version: 8, endian: BIG_ENDIAN, unknown1: 0, unknown2: 0, dbSize: 0, zero: 0, numTables: tables.length, headerCrc: 0 }, directory, tables, 0, 0);
  return serializeTdb(file, { padTo: 4096 });
}
const PLST = [['PGID', 16], ['POID', 16], ['TGID', 10], ['POVR', 7]] as [string, number][];
const DCST = [['PGID', 16], ['TGID', 10], ['PPOS', 5], ['ddep', 4]] as [string, number][];
// stock keying: TGID * 70 + slot (162 -> 11340.., 610 -> 42700..)
const players = [[162, 0, 70], [162, 1, 65], [164, 24, 80], [610, 3, 87]].map(([t, s, o]) => ({ PGID: t! * 70 + s!, POID: t! * 70 + s!, TGID: t!, POVR: o! }));
const depth = [{ PGID: 162 * 70, TGID: 162, PPOS: 0, ddep: 0 }, { PGID: 164 * 70 + 24, TGID: 164, PPOS: 5, ddep: 1 }, { PGID: 610 * 70 + 3, TGID: 610, PPOS: 3, ddep: 0 }];
const image = () => db([table('AAAA', [['XXXX', 8]], [{ XXXX: 7 }]), table('DCST', DCST, depth), table('DCSB', [['PPOS', 8]], [{ PPOS: 1 }]), table('PLST', PLST, players), table('PTMP', [['TGID', 10]], [{ TGID: 162 }])]);

describe('generic rosters (PLST / DCST)', () => {
  it('detects the stride and re-keys PLST.PGID, PLST.POID and DCST.PGID to TGID * 100 + slot', () => {
    const f = parseTdb(image());
    expect(genericRosterStride(f)).toBe(70);
    const r = rekeyGenericRosters(f, { to: 100 });
    expect(r).toMatchObject({ from: 70, to: 100, cells: 11, skipped: 0, teams: [162, 164, 610] });
    expect(r.perColumn).toEqual({ 'PLST.PGID': 4, 'PLST.POID': 4, 'DCST.PGID': 3 });
    const p = f.table('PLST'), d = f.table('DCST');
    expect([0, 1, 2, 3].map((i) => p.get(i, 'PGID'))).toEqual([16200, 16201, 16424, 61003]);
    expect([0, 1, 2, 3].map((i) => p.get(i, 'POID'))).toEqual([16200, 16201, 16424, 61003]);
    expect([0, 1, 2].map((i) => d.get(i, 'PGID'))).toEqual([16200, 16424, 61003]);
    expect(genericRosterStride(f)).toBe(100);
    expect(rekeyGenericRosters(f, { to: 100 }).cells).toBe(0); // idempotent
  });

  it('rewrites the image in place: same length, verifies, only PLST/DCST data and their checksum words change', () => {
    const before = image();
    const { bytes, result, changed } = rewriteStandardData(before);
    expect(result.cells).toBe(11);
    expect(bytes.length).toBe(before.length);
    expect(verifyTdb(bytes, parseTdb(bytes))).toEqual([]);
    const f = parseTdb(before), dataStart = 0x18 + 5 * 8, at = (n: string) => dataStart + f.directory.find((x) => x.name === n)!.offset;
    const inData = (n: string, i: number) => { const t = f.table(n), s = at(n) + 0x28 + t.fieldDefsRaw.length; return i >= s && i < s + t.data.length; };
    for (const [a, b] of changed) for (let i = a; i < b; i++) expect(inData('PLST', i) || inData('DCST', i) || (i >= at('DCSB') && i < at('DCSB') + 4) || (i >= at('PTMP') && i < at('PTMP') + 4)).toBe(true);
    expect(changed.some(([a]) => a === at('DCSB')) && changed.some(([a]) => a === at('PTMP'))).toBe(true); // the following tables' priorCrc moved
    const again = rewriteStandardData(bytes);
    expect(again.changed).toEqual([]); expect(again.result.cells).toBe(0);
  });

  it('refuses a DB that is not the standard data or does not verify', () => {
    expect(() => rewriteStandardData(db([table('PLAY', PLST, players)]))).toThrow(/standard-data/);
    const broken = image(); broken[broken.length - 4000 - 5] ^= 0xff; // inside the body: the checksum chain no longer matches
    expect(() => rewriteStandardData(broken)).toThrow(/verify/);
  });

  it('refuses ids that would not fit the column', () => {
    const f = parseTdb(db([table('DCST', DCST, depth), table('PLST', [['PGID', 14], ['POID', 16], ['TGID', 10], ['POVR', 7]], players.filter((p) => p.TGID === 164))]));
    expect(() => rekeyGenericRosters(f, { to: 100 })).toThrow(/does not fit 14 bits/); // 11504 fits 14 bits, 16424 does not
  });
});
