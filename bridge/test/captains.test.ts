import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseTdb, serializeTdb } from '@ncaa/tdb';
import { rekeyStride, pgidOf, slotOfPgid, teamOfPgid } from '@ncaa/ncaa14';
import { patchDynasty, staleCaptains, emptyPatchSet, buildDynastyFile } from '../src/dynasty-patch.js';
import { openDynastyFile } from '../src/od.js';

// A stock stride-70 dynasty (fixtures/real is gitignored: skipped without it).
const FIXTURE = join(import.meta.dirname, '../../fixtures/real/BLUS31159-DYNASTY-2/USR-DATA');

describe.skipIf(!existsSync(FIXTURE))('od captains (TEAM.OCAP/DCAP left at stride 70)', () => {
  it('re-keys exactly the stale captains back to their own team and nothing else', () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE));
    const file = parseTdb(bytes);
    rekeyStride(file, { from: 70, to: 100 }); // re-keys the captains too (PGID_ALIASES)
    const team = file.table('TEAM'); const want = new Map<string, number>();
    // put them back the way a re-key without PGID_ALIASES left them; a stride-70 id that also reads as its own team at
    // 100 (team 1's 100..139) is ambiguous and left alone by the patch, so it is not made stale here
    for (let i = 0; i < team.recordCount; i++) for (const col of ['OCAP', 'DCAP']) {
      const v = Number(team.get(i, col)), tgid = Number(team.get(i, 'TGID'));
      if (teamOfPgid(v, 100) !== tgid) continue;
      const old = pgidOf(tgid, slotOfPgid(v, 100), 70); if (teamOfPgid(old, 100) === tgid) continue;
      want.set(`${i}:${col}`, v); team.set(i, col, old);
    }
    expect(want.size).toBeGreaterThan(200);
    const blob = buildDynastyFile(serializeTdb(file, { padTo: bytes.length }));
    expect(staleCaptains(openDynastyFile(blob).file)).toBe(want.size);

    const r = patchDynasty(blob, { ...emptyPatchSet(), captains: true });
    expect(r.changes).toContain(`captains: ${want.size} TEAM.OCAP/DCAP cells re-keyed 70 -> 100`);
    const after = openDynastyFile(r.blob).file, before = openDynastyFile(blob).file;
    expect(staleCaptains(after)).toBe(0);
    const t = after.table('TEAM');
    for (const [k, v] of want) { const [i, col] = k.split(':'); expect(Number(t.get(Number(i), col!))).toBe(v); }
    // every other table byte for byte, TEAM only in those cells
    after.tables.forEach((tb, i) => { if (tb.name !== 'TEAM') expect(Buffer.compare(Buffer.from(tb.data), Buffer.from(before.tables[i]!.data))).toBe(0); });
    const tb = before.table('TEAM'); let other = 0;
    for (let i = 0; i < t.recordCount; i++) for (const f of t.fieldMap.keys()) if (f !== 'OCAP' && f !== 'DCAP' && t.get(i, f) !== tb.get(i, f)) other++;
    expect(other).toBe(0);
  });
});
