import { describe, it, expect } from 'vitest';
import type { TdbFile, TdbTable } from '@ncaa/tdb';
import { rekeyStride, setTeamPlayerRefs, PGID_ALIASES } from '../src/roster.js';

// Just enough of a TdbTable for the roster helpers: named columns of plain numbers.
function table(name: string, cols: Record<string, number>, rows: Record<string, number>[], maxRecords = rows.length): TdbTable {
  const fieldMap = new Map(Object.entries(cols).map(([k, bits]) => [k, { name: k, bits, type: 3 }]));
  const t = {
    name, fieldMap, rows, header: { maxRecords },
    get recordCount() { return rows.length; },
    field: (c: string) => fieldMap.get(c)!,
    get: (i: number, c: string) => rows[i]![c]!,
    set: (i: number, c: string, v: number) => { rows[i]![c] = v; },
    growTable: (n: number) => { t.header.maxRecords = n; },
  };
  return t as unknown as TdbTable;
}
const file = (tables: TdbTable[]): TdbFile => ({ tables, table: (n: string) => tables.find((t) => t.name === n)! }) as unknown as TdbFile;
const pl = (tgid: number, slot: number, pos: number, ovr: number, yr: number, stride: number) => ({ PGID: tgid * stride + slot, POID: tgid * stride + slot, TGID: tgid, PPOS: pos, POVR: ovr, PYEA: yr });
const PCOLS = { PGID: 16, POID: 16, TGID: 10, PPOS: 5, POVR: 7, PYEA: 3 };
const TCOLS = { TGID: 10, OCAP: 16, DCAP: 16, TPIO: 16, TMPI: 16, TSI1: 16, TSI2: 16 };

describe('rekeyStride', () => {
  it('re-keys the PGID aliases (TEAM captains / featured players, SSUM, PLAY.POID) with every PGID', () => {
    const play = table('PLAY', PCOLS, [pl(10, 19, 12, 70, 3, 70), pl(10, 3, 0, 80, 2, 70)], 140);
    const team = table('TEAM', TCOLS, [{ TGID: 10, OCAP: 703, DCAP: 719, TPIO: 703, TMPI: 719, TSI1: 703, TSI2: 719 }]);
    const ssum = table('SSUM', { TGID: 10, SSFI: 16, SSPI: 16, SSTI: 16 }, [{ TGID: 10, SSFI: 719, SSPI: 703, SSTI: 65535 }]);
    const r = rekeyStride(file([play, team, ssum]), { from: 70, to: 100 });
    expect(play.get(0, 'PGID')).toBe(1019); expect(play.get(0, 'POID')).toBe(1019);
    expect(team.get(0, 'DCAP')).toBe(1019); expect(team.get(0, 'OCAP')).toBe(1003); expect(team.get(0, 'TSI2')).toBe(1019);
    expect(ssum.get(0, 'SSFI')).toBe(1019); expect(ssum.get(0, 'SSPI')).toBe(1003); expect(ssum.get(0, 'SSTI')).toBe(65535);
    expect(r.perTable).toContain('TEAM.DCAP 1');
    expect(PGID_ALIASES.TEAM).toHaveLength(6);
  });
});

describe('setTeamPlayerRefs', () => {
  it("picks featured players by rating and captains as each side's best senior", () => {
    const S = 100;
    const play = table('PLAY', PCOLS, [
      pl(10, 0, 0, 85, 1, S), pl(10, 1, 3, 80, 3, S), pl(10, 2, 1, 75, 3, S), // offense: QB 85 (so), WR 80 (sr), HB 75 (sr)
      pl(10, 3, 12, 88, 2, S), pl(10, 4, 16, 70, 3, S), pl(10, 5, 14, 82, 0, S), // defense: DT 88 (jr), CB 70 (sr), MLB 82 (fr)
      pl(10, 6, 19, 99, 3, S), // kicker: neither side
    ]);
    const team = table('TEAM', TCOLS, [
      { TGID: 10, OCAP: 719, DCAP: 703, TPIO: 0, TMPI: 0, TSI1: 0, TSI2: 0 },
      { TGID: 162, OCAP: 11353, DCAP: 11386, TPIO: 11359, TMPI: 65535, TSI1: 0, TSI2: 11340 }, // generic: no players, stale stride-70 ids
    ]);
    const r = setTeamPlayerRefs(file([play, team]), { stride: S });
    expect(team.get(0, 'TPIO')).toBe(1000); expect(team.get(0, 'TSI1')).toBe(1001);
    expect(team.get(0, 'TMPI')).toBe(1003); expect(team.get(0, 'TSI2')).toBe(1005);
    expect(team.get(0, 'OCAP')).toBe(1001); expect(team.get(0, 'DCAP')).toBe(1004);
    // the generic team keeps an empty slot of its own range at the new stride; sentinels stay
    expect(team.get(1, 'OCAP')).toBe(16213); expect(team.get(1, 'DCAP')).toBe(16246); expect(team.get(1, 'TSI2')).toBe(16200);
    expect(team.get(1, 'TMPI')).toBe(65535); expect(team.get(1, 'TSI1')).toBe(0);
    expect(r.teams).toBe(1);
  });
});
