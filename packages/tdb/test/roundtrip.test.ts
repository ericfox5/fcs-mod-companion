import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseTdb, serializeTdb, verifyTdb, tdbChecksum, crc32be } from '../src/index.js';

const FIXTURES = join(import.meta.dirname, '../../../fixtures/real');
const saves = existsSync(FIXTURES)
  ? readdirSync(FIXTURES).filter((d) => existsSync(join(FIXTURES, d, 'USR-DATA')))
  : [];

describe('crc32_be', () => {
  it('matches the stored file-header checksum of a real save', () => {
    if (saves.length === 0) return;
    const bytes = readFileSync(join(FIXTURES, saves[0]!, 'USR-DATA'));
    const stored = bytes.readUInt32BE(0x14);
    expect(tdbChecksum(bytes, 0, 0x14)).toBe(stored);
    expect(~crc32be(bytes, 0, 0x14) >>> 0).toBe(stored);
  });
});

describe.each(saves)('%s', (dir) => {
  const path = join(FIXTURES, dir, 'USR-DATA');
  const bytes = new Uint8Array(readFileSync(path));

  it('parses every table and all checksums verify', () => {
    const file = parseTdb(bytes);
    expect(file.tables.length).toBe(file.header.numTables);
    expect(file.header.endian).toBe(1);
    expect(verifyTdb(bytes, file)).toEqual([]);
  });

  it('round-trips byte-identically', () => {
    const file = parseTdb(bytes);
    const out = serializeTdb(file);
    expect(out.length).toBe(bytes.length);
    expect(Buffer.compare(Buffer.from(out), Buffer.from(bytes))).toBe(0);
  });

  it('decodes records', () => {
    const file = parseTdb(bytes);
    if (file.hasTable('SEAI')) {
      const seai = file.table('SEAI');
      expect(seai.recordCount).toBeGreaterThan(0);
      expect(typeof seai.row(0)['SEWN']).toBe('number');
    }
    const team = file.table('TEAM');
    expect(team.recordCount).toBeGreaterThan(50);
    expect(team.fields.filter((f) => f.type === 0).length).toBeGreaterThan(0);
  });

  it('writes a field and reads it back without disturbing neighbours', () => {
    const file = parseTdb(bytes);
    const team = file.table('TEAM');
    const numeric = team.fields.find((f) => f.type === 3 && f.bits >= 4 && f.bits <= 16)!;
    const before = team.row(0);
    const original = team.get(0, numeric.name) as number;
    const changed = original === 0 ? 1 : original - 1;
    team.set(0, numeric.name, changed);
    expect(team.get(0, numeric.name)).toBe(changed);
    for (const f of team.fields) if (f.name !== numeric.name) expect(team.get(0, f.name)).toEqual(before[f.name]);
    team.set(0, numeric.name, original);
    const out = serializeTdb(file);
    expect(Buffer.compare(Buffer.from(out), Buffer.from(bytes))).toBe(0);
  });
});
