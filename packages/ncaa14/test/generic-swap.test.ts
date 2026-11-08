import { describe, it, expect } from 'vitest';
import type { TdbFile, TdbTable } from '@ncaa/tdb';
import { swapGenericTeam, copyTeamIdentity, fillGenericRows, staleGenericRows, filledGenericRows } from '../src/generic-swap.js';

// Just enough of a TdbTable: named columns (type 0 = string of bits/8 bytes, 3 = unsigned) over plain row objects.
type Rec = Record<string, number | string>;
function table(name: string, cols: Record<string, [number, number]>, rows: Rec[]): TdbTable {
  const fieldMap = new Map(Object.entries(cols).map(([k, [type, bits]]) => [k, { name: k, type, bits }]));
  return {
    name, fieldMap, rows, fields: [...fieldMap.values()], header: { maxRecords: rows.length },
    get recordCount() { return rows.length; },
    field: (c: string) => { const f = fieldMap.get(c); if (!f) throw new Error(`no field ${c}`); return f; },
    get: (i: number, c: string) => rows[i]![c]!,
    set: (i: number, c: string, v: number | string) => {
      const f = fieldMap.get(c)!;
      if (f.type === 0 && String(v).length > f.bits / 8) throw new RangeError(`${c} too long`);
      if (f.type === 3 && (Number(v) < 0 || Number(v) >= 2 ** f.bits)) throw new RangeError(`${c} out of range`);
      rows[i]![c] = v;
    },
  } as unknown as TdbTable;
}
const file = (tables: TdbTable[]): TdbFile => ({ tables, table: (n: string) => tables.find((t) => t.name === n)! }) as unknown as TdbFile;
const PCOLS: Record<string, [number, number]> = { PGID: [3, 16], POID: [3, 16], TGID: [3, 10], PPOS: [3, 5], POVR: [3, 7], PFNA: [0, 88], PLNA: [0, 104], PJEN: [3, 7], PSPD: [3, 7], PXTR: [3, 8] };
const DCOLS: Record<string, [number, number]> = { PGID: [3, 16], TGID: [3, 10], PPOS: [3, 5], ddep: [3, 4] };
const gen = (pgid: number, tgid: number, pos: number, ovr: number, pxtr = 9): Rec => ({ PGID: pgid, POID: pgid, TGID: tgid, PPOS: pos, POVR: ovr, PFNA: '', PLNA: `#${pgid}`, PJEN: 1, PSPD: 50, PXTR: pxtr });
const donor = (pgid: number, pos: number, ovr: number, last: string, spd = 70): Rec => ({ PGID: pgid, POID: pgid, TGID: 106, PPOS: pos, POVR: ovr, PFNA: 'Joe', PLNA: last, PJEN: pgid % 100, PSPD: spd, PUHE: 1 });

function fixture(stride: number) {
  const base = 162 * stride;
  // generic 162: QB, HB, FB, WR, C, K (rows deliberately out of PGID order); a 160 player that must stay
  const plst = table('PLST', PCOLS, [gen(base + 3, 162, 3, 60), gen(160 * stride, 160, 0, 55), gen(base, 162, 0, 61), gen(base + 1, 162, 1, 62), gen(base + 2, 162, 2, 58), gen(base + 4, 162, 7, 57), gen(base + 5, 162, 19, 50)]);
  const spot = (pos: number, d = 0): Rec => ({ PGID: base, TGID: 162, PPOS: pos, ddep: d });
  const dcst = table('DCST', DCOLS, [spot(0), spot(1), spot(2), spot(3), spot(7), spot(19), spot(21), spot(24), { PGID: 160 * stride, TGID: 160, PPOS: 0, ddep: 0 }]);
  const players = [donor(10600, 0, 80, 'Starter'), donor(10601, 0, 70, 'Backup'), donor(10602, 1, 75, 'Runner'), donor(10603, 3, 85, 'Burner', 95),
    donor(10604, 3, 60, 'Slot'), donor(10605, 7, 72, 'Center'), donor(10606, 19, 66, 'Kicker'), donor(10607, 24, 50, 'Snapper'), donor(10608, 4, 68, 'Averylongsurnameforthis')];
  const depth: Rec[] = [{ PGID: 10600, TGID: 106, PPOS: 0, ddep: 0 }, { PGID: 10601, TGID: 106, PPOS: 0, ddep: 1 }, { PGID: 10603, TGID: 106, PPOS: 21, ddep: 0 }, { PGID: 10607, TGID: 106, PPOS: 24, ddep: 0 }];
  return { plst, dcst, players, depth, base };
}

describe('swapGenericTeam', () => {
  it("fills the generic team's own position counts from the donor's best, in place, and re-points the depth chart", () => {
    const { plst, dcst, players, depth, base } = fixture(70);
    const r = swapGenericTeam(file([plst, dcst]), { players, depth }, { tgid: 162 });
    expect(r.stride).toBe(70); expect(r.count).toBe(6); expect(plst.recordCount).toBe(7); expect(dcst.recordCount).toBe(9);
    // position order QB, HB, WR, C, K, then the long snapper that took the FB slot (the donor has no FB)
    expect(r.players.map((p) => [p.pgid, p.name, p.pos, p.ovr])).toEqual([
      [base, 'Joe Starter', 'QB', 80], [base + 1, 'Joe Runner', 'HB', 75], [base + 2, 'Joe Burner', 'WR', 85],
      [base + 3, 'Joe Center', 'C', 72], [base + 4, 'Joe Kicker', 'K', 66], [base + 5, 'Joe Snapper', 'LS', 50]]);
    expect(r.improvised[0]).toMatch(/^FB slot given to the donor's LS Joe Snapper/);
    // rows keep their place: the row that held PGID base (index 2) now holds the QB; the 160 player is untouched
    expect(plst.get(2, 'PLNA')).toBe('Starter'); expect(plst.get(2, 'TGID')).toBe(162); expect(plst.get(2, 'POID')).toBe(base);
    expect(plst.get(1, 'PGID')).toBe(160 * 70); expect(plst.get(1, 'PLNA')).toBe('#11200');
    expect(plst.get(2, 'PXTR')).toBe(9); // a field the donor lacks keeps the generic value
    // depth chart: QB from the donor's depth, FB by stand-in (HB), KR from the donor's KR depth, LS the snapper
    const at = (pos: number) => dcst.get(dcst.rows.findIndex((x: Rec) => x.PPOS === pos && x.TGID === 162), 'PGID');
    expect(at(0)).toBe(base); expect(at(2)).toBe(base + 1); expect(at(21)).toBe(base + 2); expect(at(24)).toBe(base + 5); expect(at(19)).toBe(base + 4);
    expect(r.improvised.some((s) => s.startsWith('depth FB #1: HB Joe Runner'))).toBe(true);
    expect(dcst.get(8, 'PGID')).toBe(160 * 70);
    expect(r.ovr.before.top).toBe(62); expect(r.ovr.after.top).toBe(85);
  });

  it('keeps the stride the team uses (100 after the re-key) and cuts long names to the field', () => {
    const { plst, dcst, players, depth, base } = fixture(100);
    players[0]!.PLNA = 'Abcdefghijklmnopq'; // 17 > 13 bytes
    const r = swapGenericTeam(file([plst, dcst]), { players, depth }, { tgid: 162 });
    expect(r.stride).toBe(100); expect(base).toBe(16200);
    expect(r.players[0]!.pgid).toBe(16200); expect(plst.get(2, 'PLNA')).toBe('Abcdefghijklm');
  });

  it('refuses a team with no PLST rows and a donor smaller than the team', () => {
    const { plst, dcst, players, depth } = fixture(70);
    expect(() => swapGenericTeam(file([plst, dcst]), { players, depth }, { tgid: 163 })).toThrow(/no rows for TGID 163/);
    expect(() => swapGenericTeam(file([plst, dcst]), { players: players.slice(0, 3), depth }, { tgid: 162 })).toThrow(/needs 6/);
  });
});

describe('copyTeamIdentity', () => {
  it("copies the donor's names and colours into the generic TEAM row only", () => {
    const cols: Record<string, [number, number]> = { TGID: [3, 10], TDNA: [0, 136], TMNA: [0, 136], TSNA: [0, 64], TBCR: [3, 8], TBCG: [3, 8], TBCB: [3, 8], TTYP: [3, 2] };
    const team = table('TEAM', cols, [{ TGID: 162, TDNA: 'Wagner', TMNA: 'Seahawks', TSNA: 'WAG', TBCR: 0, TBCG: 72, TBCB: 58, TTYP: 1 }, { TGID: 10, TDNA: 'Duquesne', TMNA: 'Dukes', TSNA: 'DUQ', TBCR: 4, TBCG: 30, TBCB: 66, TTYP: 0 }]);
    const changed = copyTeamIdentity(file([team]), 162, { TGID: 106, TDNA: 'Pittsburgh', TMNA: 'Panthers', TSNA: 'PITT', TBCR: 0, TBCG: 53, TBCB: 148, TTYP: 0, TLNA: 'Pitt' });
    expect(team.get(0, 'TDNA')).toBe('Pittsburgh'); expect(team.get(0, 'TSNA')).toBe('PITT'); expect(team.get(0, 'TBCB')).toBe(148);
    expect(team.get(0, 'TTYP')).toBe(1); expect(team.get(0, 'TGID')).toBe(162); expect(team.get(1, 'TDNA')).toBe('Duquesne');
    expect(changed).toHaveLength(5); // TDNA TMNA TSNA TBCG TBCB (TBCR equal; TLNA not a column here)
  });
});

describe('fillGenericRows', () => {
  const mk = () => {
    const rows = [{ PGID: 16300, TGID: 163, PPOS: 0, POVR: 73, PJEN: 12, PFNA: '', PLNA: 'QB #12', PYEA: 1, PRSD: 0, PHGT: 74, PWGT: 40 }, { PGID: 1000, TGID: 10, PPOS: 0, POVR: 80, PJEN: 7, PFNA: 'Real', PLNA: 'Player', PYEA: 3, PRSD: 0, PHGT: 75, PWGT: 50 }];
    const fieldMap = new Map(Object.keys(rows[0]!).map((k) => [k, { name: k, bits: ['PFNA', 'PLNA'].includes(k) ? 104 : 16, type: ['PFNA', 'PLNA'].includes(k) ? 0 : 3 }]));
    const t = { name: 'PLST', fieldMap, get recordCount() { return rows.length; }, field: (c: string) => fieldMap.get(c)!, get: (i: number, c: string) => (rows[i] as Record<string, unknown>)[c], set: (i: number, c: string, v: unknown) => { (rows[i] as Record<string, unknown>)[c] = v; } };
    return { rows, stda: { tables: [t], table: () => t } as never };
  };
  it('sets only identity fields on existing generic rows', () => {
    const { rows, stda } = mk();
    const r = fillGenericRows(stda, [{ pgid: 16300, tgid: 163, fields: { PFNA: 'James', PLNA: 'White', PJEN: 12, PYEA: 3, PHGT: 75 } }]);
    expect(rows[0]).toMatchObject({ PFNA: 'James', PLNA: 'White', PJEN: 12, PYEA: 3, PHGT: 75, PPOS: 0, POVR: 73, PWGT: 40 });
    expect(r).toEqual({ rows: 1, cells: 4, teams: [163] });
    expect(rows[1]!.PLNA).toBe('Player');
  });
  it('refuses rows outside the generic teams, unknown rows and non-identity fields', () => {
    const { stda } = mk();
    expect(() => fillGenericRows(stda, [{ pgid: 1000, tgid: 10, fields: { PLNA: 'X' } }])).toThrow(/not a generic team/);
    expect(() => fillGenericRows(stda, [{ pgid: 16399, tgid: 163, fields: { PLNA: 'X' } }])).toThrow(/no row/);
    expect(() => fillGenericRows(stda, [{ pgid: 16300, tgid: 163, fields: { POVR: 99 } }])).toThrow(/not an identity field/);
  });
  it('finds plan rows whose stock row changed, and counts the rows already filled', () => {
    const { stda } = mk();
    const plan = [{ pgid: 16300, tgid: 163, ppos: 0, povr: 73, fields: { PFNA: 'James', PLNA: 'White' } }];
    expect(staleGenericRows(stda, plan)).toEqual([]);
    expect(staleGenericRows(stda, [{ ...plan[0]!, povr: 90 }, { ...plan[0]!, pgid: 16399 }, { ...plan[0]!, tgid: 164 }])).toHaveLength(3);
    expect(filledGenericRows(stda, plan)).toBe(0);
    fillGenericRows(stda, plan);
    expect(filledGenericRows(stda, plan)).toBe(1);
  });
});
