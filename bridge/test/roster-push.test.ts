import { describe, it, expect } from 'vitest';
import { overlayRosterPush } from '../src/commands/od.js';

const player = (pgid: number, tgid: number, first: string, last: string, extra: Record<string, unknown> = {}) => ({
  pgid, tgid, firstName: first, lastName: last, pos: 18, position: 'SS', year: 2, redshirt: 0, classLabel: 'JR', jersey: 50, overall: 72,
  heightInches: 72, weight: 200, gamesPlayed: 0, headId: 1, leaveFlag: 0, leaveType: 0, ratings: { PAWR: 72, PSTR: 64, PSPD: 74, PACC: 74, PTEN: 0, PLCR: 0 } as Record<string, number>, raw: {} as Record<string, number | string>, ...extra,
});
const ex = () => ({ players: [player(4766, 47, 'Matthew', 'Sopp'), player(4701, 47, 'Other', 'Guy'), player(1801, 18, 'Else', 'Where')] }) as any;
const row = (o: Record<string, number | string>) => ({ PGID: 4766, TGID: 47, PLFL: 0, PTEN: 0, PTYP: 0, PAWR: 72, PPOS: 18, PSTR: 64, PSPD: 74, PRSD: 0, POVR: 72, PJEN: 50, PACC: 74, PLCR: 0, PLNA: 'Sopp', PFNA: 'Matthew', ...o });

describe('overlayRosterPush', () => {
  it('applies a rename, number, position and redshirt from a push newer than the file; the last row of a player wins', () => {
    const e = ex();
    const n = overlayRosterPush(e, { updatedAt: 200, rows: [row({}), row({ PFNA: 'Eric', PLNA: 'Fox', PJEN: 5, PPOS: 0, PRSD: 1, POVR: 70, PTEN: 2 })] }, 100);
    expect(n).toBe(1);
    expect(e.players[0]).toMatchObject({ firstName: 'Eric', lastName: 'Fox', jersey: 5, pos: 0, position: 'QB', redshirt: 1, classLabel: 'RS JR', overall: 70 });
    expect(e.players[0].ratings.PTEN).toBe(2);
    expect(e.players[1].firstName).toBe('Other');
  });
  it('does nothing for a push older than the file, an empty push, an unknown player or a player on another team', () => {
    const e = ex();
    expect(overlayRosterPush(e, { updatedAt: 100, rows: [row({ PFNA: 'Eric' })] }, 100)).toBe(0);
    expect(overlayRosterPush(e, null, 0)).toBe(0);
    expect(overlayRosterPush(e, { updatedAt: 200, rows: [row({ PGID: 9999, PFNA: 'Eric' }), row({ PGID: 1801, TGID: 47, PFNA: 'Eric' })] }, 100)).toBe(0);
    expect(e.players.map((p: any) => p.firstName)).toEqual(['Matthew', 'Other', 'Else']);
  });
  it('counts only players that really changed and keeps a name when the push sends a blank', () => {
    const e = ex();
    expect(overlayRosterPush(e, { updatedAt: 200, rows: [row({}), row({ PGID: 4701, PFNA: '', PLNA: 'Guy', PJEN: 50 })] }, 100)).toBe(0);
    expect(e.players[1].firstName).toBe('Other');
  });
});
