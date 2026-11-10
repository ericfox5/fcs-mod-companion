// The private-playbook slot map and what it tells the dynasty-file patch: a live slot points its team at the private
// book (off the stock one), a released slot points it back, a pointer the console's file already shows is remembered and
// not re-sent. The map is a temp file; the dynasty file is the stock stride-70 fixture (fixtures/real is gitignored:
// those two tests are skipped without it).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTdb, serializeTdb } from '@ncaa/tdb';
import { patchDynasty, emptyPatchSet, patchSetEmpty, buildDynastyFile } from '../src/dynasty-patch.js';
import { openDynastyFile } from '../src/od.js';
import { dynastyScope, markBooksTaken, parseSlotKey, pendingBookPointers, readPrivateMap, slotKey, slotTarget, writePrivateMap, type PrivateMap, type PrivateSlot } from '../src/playbook-pack.js';

const FIXTURE = join(import.meta.dirname, '../../fixtures/real/BLUS31159-DYNASTY-2/USR-DATA');
const slot = (over: Partial<PrivateSlot> = {}): PrivateSlot => ({ bgid: 9, bokl: 123, pban: 'NCAA_Ball State', donor: 'Ball State', donorSha: 'd'.repeat(64), name: 'Holy Cross Spread', at: '2026-11-10T18:26:31.567Z', base: { bokl: 106, bgid: 121 }, sha: 'a'.repeat(64), ...over });
// the fixture's TEAM table with three teams' TOPB set as the test wants them
function teamsAt(topb: [number, number][]): { bytes: Uint8Array; tgids: number[] } {
  const bytes = new Uint8Array(readFileSync(FIXTURE)), file = parseTdb(bytes), team = file.table('TEAM');
  const tgids = Array.from({ length: topb.length }, (_, i) => Number(team.get(i, 'TGID')));
  topb.forEach(([, v], i) => team.set(i, 'TOPB', v));
  return { bytes: serializeTdb(file, { padTo: bytes.length }), tgids };
}

describe('private playbook slots', () => {
  let dir: string, file: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pb-')); file = join(dir, 'playbooks.json'); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('keys slots by scope, team and side', () => {
    expect(slotKey(dynastyScope(7), 18, 'off')).toBe('od7/18/off');
    expect(parseSlotKey('od7/18/off')).toEqual({ scope: 'od7', tgid: 18, side: 'off' });
    expect(parseSlotKey('local/18/def')).toEqual({ scope: 'local', tgid: 18, side: 'def' });
    expect(parseSlotKey('nonsense')).toBeNull(); expect(parseSlotKey('od7/x/off')).toBeNull();
    const m: PrivateMap = { 'od7/18/off': slot() }; writePrivateMap(m, file); expect(readPrivateMap(file)).toEqual(m);
    expect(readPrivateMap(join(dir, 'missing.json'))).toEqual({});
  });

  it('a live slot points the team at its book, a released one back at the stock book, no base means no pointer', () => {
    expect(slotTarget('od7/18/off', slot())).toEqual({ tgid: 18, side: 'off', bgid: 9, from: [121], name: 'Holy Cross Spread' });
    expect(slotTarget('od7/18/off', slot({ released: true }))).toEqual({ tgid: 18, side: 'off', bgid: 121, from: [9], name: 'stock book (was "Holy Cross Spread")' });
    expect(slotTarget('od7/18/off', slot({ base: undefined }))).toBeNull();
  });

  it('pending pointers are the dynasty\'s own slots not yet seen taken', () => {
    const map: PrivateMap = { 'od7/18/off': slot(), 'od7/22/off': slot({ bgid: 10, name: 'Stony Brook Pro', taken: { file: 5, bgid: 10 } }), 'od8/18/off': slot({ bgid: 11 }), 'local/18/off': slot({ bgid: 12 }), 'od7/30/off': slot({ bgid: 13, name: 'Elon Spread', released: true, taken: { file: 4, bgid: 13 } }) };
    expect(pendingBookPointers(7, map)).toEqual([
      { tgid: 18, side: 'off', bgid: 9, from: [121], name: 'Holy Cross Spread' },
      { tgid: 30, side: 'off', bgid: 121, from: [13], name: 'stock book (was "Elon Spread")' }, // taken for its own book, now wants the base again
    ]);
    expect(pendingBookPointers(9, map)).toEqual([]);
  });

  it.skipIf(!existsSync(FIXTURE))('the console\'s file marks a pointer taken once it shows the book', () => {
    const { bytes, tgids } = teamsAt([[0, 9], [0, 10], [0, 13]]); const [a, b, c] = tgids as [number, number, number];
    const map: PrivateMap = { [`od7/${a}/off`]: slot(), [`od7/${b}/off`]: slot({ bgid: 10, taken: { file: 5, bgid: 10 } }), [`od8/${a}/off`]: slot({ bgid: 11 }), [`od7/${c}/off`]: slot({ bgid: 13, name: 'Elon Spread', released: true, taken: { file: 4, bgid: 13 } }) };
    writePrivateMap(map, file);
    expect(markBooksTaken(7, parseTdb(bytes), 44, file)).toEqual([`team ${a} TOPB 9 ("Holy Cross Spread") taken by console file 44`]); // c still runs 13, wants 121
    const after = readPrivateMap(file);
    expect(after[`od7/${a}/off`]!.taken).toEqual({ file: 44, bgid: 9 }); expect(after[`od7/${c}/off`]!.taken).toEqual({ file: 4, bgid: 13 }); expect(after[`od8/${a}/off`]!.taken).toBeUndefined();
    expect(pendingBookPointers(7, after).map((p) => p.tgid)).toEqual([c]);
    expect(markBooksTaken(7, parseTdb(bytes), 45, file)).toEqual([]); // nothing new
  });

  it.skipIf(!existsSync(FIXTURE))('the dynasty-file patch moves TOPB only off the books it names and reads it back', () => {
    const { bytes, tgids } = teamsAt([[0, 121], [0, 77], [0, 9]]); const [a, b, c] = tgids as [number, number, number];
    const blob = buildDynastyFile(bytes);
    const set = { ...emptyPatchSet(), playbooks: [
      { tgid: a, side: 'off' as const, bgid: 9, from: [121], name: 'Holy Cross Spread' }, // stock -> private
      { tgid: b, side: 'off' as const, bgid: 10, from: [121], name: 'Stony Brook Pro' }, // chosen in game: left alone
      { tgid: c, side: 'off' as const, bgid: 121, from: [9], name: 'stock book (was "Elon Spread")' }, // released: back to stock
      { tgid: 9999, side: 'off' as const, bgid: 1, from: [2], name: 'nobody' },
    ] };
    expect(patchSetEmpty(set)).toBe(false); expect(patchSetEmpty(emptyPatchSet())).toBe(true);
    const r = patchDynasty(blob, set);
    expect(r.changes).toEqual([`team ${a} TOPB: 121 -> 9 ("Holy Cross Spread")`, `team ${b} TOPB: holds 77, not 121; chosen in game, left alone`, `team ${c} TOPB: 9 -> 121 ("stock book (was "Elon Spread")")`, 'team 9999 playbook: not in TEAM, skipped']);
    const back = openDynastyFile(r.blob).file.table('TEAM');
    expect([0, 1, 2].map((i) => Number(back.get(i, 'TOPB')))).toEqual([9, 77, 121]);
    expect(patchDynasty(r.blob, set).changes[0]).toBe(`team ${a} TOPB: already 9 ("Holy Cross Spread")`);
  });
});
