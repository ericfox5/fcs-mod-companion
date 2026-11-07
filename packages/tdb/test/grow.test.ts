import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseTdb, serializeTdb, verifyTdb, hasExtraData } from '../src/index.js';

const FIXTURES = join(import.meta.dirname, '../../../fixtures/real');
const saves = existsSync(FIXTURES)
  ? readdirSync(FIXTURES).filter((d) => existsSync(join(FIXTURES, d, 'USR-DATA')))
  : [];

describe.each(saves)('growTable on %s', (dir) => {
  const bytes = new Uint8Array(readFileSync(join(FIXTURES, dir, 'USR-DATA')));

  it('extends a fixed-allocation table, appends past the old maximum and round-trips with valid checksums', () => {
    const file = parseTdb(bytes);
    const play = file.table('PLAY');
    const oldMax = play.header.maxRecords, oldCount = play.recordCount, L = play.header.lengthBytes;
    expect(play.storedRecords).toBe(oldMax); // fixed allocation in every real save
    const others = file.tables.map((t, i) => ({ i, data: Buffer.from(t.data) })).filter((o) => file.tables[o.i] !== play); // by position: saves hold unnamed tables
    const lastRow = play.row(oldCount - 1);

    play.growTable(oldMax + 130);
    expect(play.header.maxRecords).toBe(oldMax + 130);
    expect(play.data.length).toBe((oldMax + 130) * L);
    expect(play.row(oldCount - 1)).toEqual(lastRow);
    // fill every old free slot and one past the old maximum
    while (play.recordCount < oldMax) play.appendRecord({ PGID: 50000 + (play.recordCount - oldCount) });
    const idx = play.appendRecord({ ...lastRow, PGID: 65000 });
    expect(idx).toBe(oldMax);
    expect(play.get(idx, 'PGID')).toBe(65000);
    expect(play.get(idx, 'PLNA')).toBe(lastRow['PLNA']);

    const oldDbSize = file.header.dbSize;
    const out = serializeTdb(file);
    expect(file.header.dbSize).toBe(oldDbSize + 130 * L); // the padding may absorb the growth, the DB itself must not
    expect(out.length).toBeGreaterThanOrEqual(bytes.length);
    const back = parseTdb(out);
    expect(verifyTdb(out, back)).toEqual([]);
    const bp = back.table('PLAY');
    expect(bp.header.maxRecords).toBe(oldMax + 130);
    expect(bp.recordCount).toBe(oldMax + 1);
    expect(bp.get(oldMax, 'PGID')).toBe(65000);
    for (const o of others) expect(Buffer.compare(Buffer.from(back.tables[o.i]!.data), o.data)).toBe(0);
  });

  it('refuses to shrink or to exceed 16 bits, keeps index definitions, and is a no-op at the same size', () => {
    const file = parseTdb(bytes);
    const play = file.table('PLAY');
    expect(() => play.growTable(play.header.maxRecords - 1)).toThrow(/shrink/);
    expect(() => play.growTable(70000)).toThrow(/16-bit/);
    const indexed = file.tables.find((t) => t.header.indexCount > 0 && !hasExtraData(t.header));
    if (indexed) {
      const index = Buffer.from(indexed.index), max = indexed.header.maxRecords;
      indexed.growTable(max + 1);
      expect(indexed.header.maxRecords).toBe(max + 1);
      expect(Buffer.compare(Buffer.from(indexed.index), index)).toBe(0);
      expect(verifyTdb(serializeTdb(file), file)).toEqual([]);
    }
    const fresh = parseTdb(bytes); fresh.table('PLAY').growTable(fresh.table('PLAY').header.maxRecords); // no-op
    expect(Buffer.compare(Buffer.from(serializeTdb(fresh)), Buffer.from(bytes))).toBe(0);
  });
});
