import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { boostRow, boostTargets, ovrOf } from '../src/swap/boost.js';
import { OVR_FORMULAS } from '../src/swap/ovr-formulas.js';
import { buildNamedBigfile, fnv1a64, inflateEntry, parseNamedBigfile, renameBigfile, type NamedBigfile } from '../src/swap/bigfile.js';
import { planUniforms } from '../src/swap/uniforms.js';

describe('boost (97-99 by original rank)', () => {
  it('splits a team into thirds by original overall', () => {
    const t = boostTargets([90, 85, 80, 75, 70, 65].map((ovr, key) => ({ key, ovr })));
    expect([0, 1, 2, 3, 4, 5].map((k) => t.get(k))).toEqual([99, 99, 98, 98, 97, 97]);
  });
  it('reaches the target on every position formula without lowering a field or passing 99', () => {
    for (const ppos of Object.keys(OVR_FORMULAS).map(Number)) {
      const row: Record<string, number> = { POVR: 60, PIMP: 60 }; for (const [k] of OVR_FORMULAS[ppos]!.vars) row[k] = 55;
      for (const target of [97, 98, 99]) {
        const ch = boostRow(row, ppos, target), after = { ...row, ...ch };
        expect(after.POVR).toBe(target); expect(after.PIMP).toBe(target);
        expect(Math.floor(ovrOf(after, ppos)! + 1e-9)).toBeGreaterThanOrEqual(target);
        for (const [k, v] of Object.entries(ch)) if (k !== 'POVR' && k !== 'PIMP') { expect(v).toBeLessThanOrEqual(99); expect(v).toBeGreaterThanOrEqual(row[k]!); }
      }
    }
  });
});

describe('bigfile rename + rebuild', () => {
  it('renames entry names, hashes and scene references, and round-trips', () => {
    const scene = Buffer.from('scene: textures/calxxx_jersey_2014_white_JERSEYBAKED_COL.p3s and Teams\\CALXXX\\HELMET', 'latin1');
    const tex = Buffer.alloc(300, 7);
    const big: NamedBigfile = { header: Buffer.alloc(64), prefix: [0x78baf565], entries: [
      { flags: 0x11, name: 'CALXXX_JERSEY_2014_WHITE', hash: fnv1a64('CALXXX_JERSEY_2014_WHITE'), raw: deflateSync(scene) },
      { flags: 0x111, name: 'CALXXX_JERSEY_2014_WHITE_JERSEYBAKED_COL', hash: fnv1a64('CALXXX_JERSEY_2014_WHITE_JERSEYBAKED_COL'), raw: deflateSync(tex) },
    ] };
    big.header.write('BGFA1.05', 0, 'latin1');
    renameBigfile(big, [{ from: 'calxxx_jersey_2014_white', to: 'D1AANW_HELMET_2099_GOLDX' }, { from: 'CALXXX', to: 'QNW001' }]);
    const back = parseNamedBigfile(buildNamedBigfile(big));
    expect(back.entries.map((e) => e.name)).toEqual(['D1AANW_HELMET_2099_GOLDX', 'D1AANW_HELMET_2099_GOLDX_JERSEYBAKED_COL']);
    for (const e of back.entries) expect(e.hash).toBe(fnv1a64(e.name));
    expect(inflateEntry(back.entries[0]!.raw).toString('latin1')).toBe('scene: textures/d1aanw_helmet_2099_goldx_JERSEYBAKED_COL.p3s and Teams\\QNW001\\HELMET');
    expect(inflateEntry(back.entries[1]!.raw).equals(tex)).toBe(true);
  });
});

describe('uniform XMLs layered like the game', () => {
  const base = `<?xml version="1.0"?>\r\n<root>\r\n  <partType name="jersey" />\r\n  <partType name="helmet" />\r\n  <officialType name="Home" />\r\n  <officialType name="Away" />\r\n
  <part name="Gold" type="helmet">\r\n    <bigfile name="TEAMXX_HELMET_2010_GOLD_big" />\r\n    <official name="Home" />\r\n    <official name="Away" />\r\n  </part>\r\n
  <part name="Blue" shade="dark" type="jersey">\r\n    <bigfile name="TEAMXX_JERSEY_2010_BLUE_big" />\r\n    <official name="Home" />\r\n  </part>\r\n
  <part name="Old White" shade="light" type="jersey">\r\n    <bigfile name="TEAMXX_JERSEY_2001_WHITE_big" />\r\n    <official name="Away" />\r\n  </part>\r\n</root>`;
  const stub = '<?xml version="1.0" ?><root>\r\n \r\n</root>';
  const pack = `<root><officialType name="Away"/><part name="New White" type="jersey"><bigfile name="TEAMXX_JERSEY_2024_WHITE_big"/><official name="Away"/></part><part name="Gold" type="helmet"><bigfile name="TEAMXX_HELMET_2010_GOLD_big"/><official name="Away"/></part></root>`;
  const cfbr = { xmls: () => [{ from: 'archive', text: base }, { from: 'UNIF001 Pack0', text: stub }, { from: 'CUSTOM Pack1', text: pack }], partSource: (b: string) => (b.includes('MISSING') ? null : 'archive') };
  it('takes each official from the last XML that lists it; empty stubs never win', () => {
    const p = planUniforms(cfbr as never, {} as never, 'TEAMXX', 'D1AANW');
    expect(p.officials).toEqual(['Home', 'Away']);
    expect(p.byOfficial.Home!.map((x) => x.name)).toEqual(['Gold', 'Blue']);
    expect(p.byOfficial.Away!.map((x) => x.name)).toEqual(['New White', 'Gold']);
    expect(p.parts.map((x) => x.big)).not.toContain('TEAMXX_JERSEY_2001_WHITE_big');
  });
});
