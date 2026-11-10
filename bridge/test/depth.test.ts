import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseTdb } from '@ncaa/tdb';
import { PGID_NONE } from '@ncaa/ncaa14';
import { placeInDepth, depthSet } from '../src/commands/depth.js';

describe('placeInDepth', () => {
  it('puts the player at the depth and moves the rest down, dropping the last', () => {
    expect(placeInDepth([1, 2, 3], 9, 0)).toEqual([9, 1, 2]);
    expect(placeInDepth([1, 2, 3], 9, 1)).toEqual([1, 9, 2]);
  });
  it('moves a player already on the chart instead of listing him twice', () => {
    expect(placeInDepth([1, 2, 3], 3, 0)).toEqual([3, 1, 2]);
    expect(placeInDepth([1, 2, 3], 1, 2)).toEqual([2, 3, 1]);
  });
  it('keeps empty slots at the end and the chart length', () => {
    expect(placeInDepth([1, PGID_NONE, PGID_NONE], 9, 0)).toEqual([9, 1, PGID_NONE]);
    expect(placeInDepth([1, PGID_NONE, PGID_NONE], 9, 2)).toEqual([1, 9, PGID_NONE]);
  });
});

// A stock offline dynasty save (fixtures/real is gitignored: skipped without it).
const FIXTURE = join(import.meta.dirname, '../../fixtures/real/BLUS31159-DYNASTY-2/USR-DATA');

describe.skipIf(!existsSync(FIXTURE))('depth set on a save', () => {
  it("changes only the named positions of the team's chart", () => {
    const before = parseTdb(new Uint8Array(readFileSync(FIXTURE)));
    const play = before.table('PLAY'), dcht = before.table('DCHT');
    let tgid = -1, pgid = -1, name = '';
    for (let i = 0; i < play.recordCount && pgid < 0; i++) if (Number(play.get(i, 'PPOS')) === 0) { tgid = Number(play.get(i, 'TGID')); pgid = Number(play.get(i, 'PGID')); name = `${play.get(i, 'PFNA')} ${play.get(i, 'PLNA')}`; }
    const chart = (f: typeof before) => { const d = f.table('DCHT'); const out: string[] = []; for (let i = 0; i < d.recordCount; i++) out.push(`${d.get(i, 'TGID')}:${d.get(i, 'PPOS')}:${d.get(i, 'ddep')}:${d.get(i, 'PGID')}`); return out; };
    const dir = mkdtempSync(join(tmpdir(), 'depth-')), out = join(dir, 'USR-DATA');
    try {
      depthSet(FIXTURE, { team: String(tgid), player: name, pos: 'K,P', out });
      const after = parseTdb(new Uint8Array(readFileSync(out)));
      const a = chart(before), b = chart(after);
      expect(b.length).toBe(dcht.recordCount);
      const diff = a.map((x, i) => [x, b[i]!]).filter(([x, y]) => x !== y);
      expect(diff.length).toBeGreaterThan(0);
      for (const [x] of diff) { const [t, pos] = x!.split(':').map(Number); expect(t).toBe(tgid); expect([19, 20]).toContain(pos); }
      for (const pos of [19, 20]) expect(b).toContain(`${tgid}:${pos}:0:${pgid}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
