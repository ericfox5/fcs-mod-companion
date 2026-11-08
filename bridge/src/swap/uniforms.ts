// A generic slot dressed in a CFBR team's uniforms. The donor's MixAndMatch XMLs (its archive XML layered with the DLC
// packs, per official the last one wins) are cut to Home / Away and up to three Alts whose parts all resolve; every part this install does not already have
// byte for byte is renamed to a same-length name under the target slot (<SLOT>_<PART>_2099_<COLOUR>; entry names, hashes
// and scene / kerning text), and any leftover mention of the part's own slot code inside it (CFBR recycles names: Pitt's
// Alt gloves are a Georgia helmet file whose textures say GEORGA) becomes a swap-only code, so nothing shares a name
// with another team's art. The files and the new <SLOT>_Pack0_MixAndMatch.XML go into the DLC folder that holds the
// slot's XML (copies of that XML in other folders are set aside), every write listed so a restore can undo it.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Cfbr } from './cfbr.js';
import { buildNamedBigfile, parseNamedBigfile, renameBigfile, inflateEntry } from './bigfile.js';
import { dlcDir, type InstallParts } from './install.js';

const T6: Record<string, string> = { helmet: 'HELMET', jersey: 'JERSEY', pants: 'PANTSX', socks: 'SOCKSX', shoes: 'SHOESX', gloves: 'GLOVES' };
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
interface XmlPart { src: string; name: string; type: string; big: string; officials: string[] }
export interface UniformPart { type: string; name: string; big: string; from: string; reuse: boolean; to?: string }
export interface UniformPlan { donorSlot: string; slot: string; officials: string[]; parts: UniformPart[]; warnings: string[]; xmlFrom: string }
export interface UniformFiles { plan: UniformPlan; xml: string; files: { name: string; bytes: Buffer }[] }
export interface UniformApplied { folder: string; written: string[]; xmlPath: string; originalXml: string | null; setAside: { from: string; to: string }[] }

const parseParts = (text: string): XmlPart[] => [...text.matchAll(/<part name="([^"]*)"[^>]*?type="([^"]*)"[^>]*>([\s\S]*?)<\/part>/g)].map((m) => ({ src: m[0], name: m[1]!, type: m[2]!, big: /<bigfile name="([^"]+)"/.exec(m[3]!)?.[1] ?? '', officials: [...m[3]!.matchAll(/<official name="([^"]+)"/g)].map((x) => x[1]!) }));
const officialTypes = (text: string): string[] => [...text.matchAll(/<officialType name="([^"]+)"\s*\/>/g)].map((m) => m[1]!);

// which officials come over: Home, Away and Alt #1..#3 when the XMLs have them, else their first five
export function chooseOfficials(all: string[]): string[] {
  const std = ['Home', 'Away', 'Alt #1', 'Alt #2', 'Alt #3'].filter((o) => all.includes(o));
  return std.length >= 2 ? std : all.slice(0, 5);
}

// The slot's XMLs layered as the game does: officials in order of first appearance, each official's parts from the
// last XML that lists it (cfbr.xmls order).
interface Layered { sources: { from: string; text: string; parts: XmlPart[] }[]; officials: string[]; winner: Map<string, number>; partTypes: string[] }
function layer(cfbr: Cfbr, donorSlot: string): Layered {
  const sources = cfbr.xmls(donorSlot).map((x) => ({ ...x, parts: parseParts(x.text) })); if (!sources.length) throw new Error(`CFBR has no uniforms for slot ${donorSlot}`);
  const officials: string[] = [], winner = new Map<string, number>(), partTypes: string[] = [];
  sources.forEach((s, i) => {
    for (const o of officialTypes(s.text)) if (!officials.includes(o)) officials.push(o);
    for (const m of s.text.matchAll(/<partType name="([^"]+)"\s*\/>/g)) if (!partTypes.includes(m[1]!)) partTypes.push(m[1]!);
    for (const p of s.parts) for (const o of p.officials) winner.set(o, i);
  });
  return { sources, officials: officials.filter((o) => winner.has(o)), winner, partTypes };
}
const partsOf = (l: Layered, o: string): XmlPart[] => { const i = l.winner.get(o); return i === undefined ? [] : l.sources[i]!.parts.filter((p) => p.officials.includes(o)); };

// plan without reading any part's bytes (cheap: for previews)
export function planUniforms(cfbr: Cfbr, install: InstallParts, donorSlot: string, slot: string): UniformPlan & { layered: Layered; byOfficial: Record<string, { type: string; name: string }[]> } {
  const l = layer(cfbr, donorSlot), warnings: string[] = [];
  const found = new Map<string, string>(); const where = (big: string) => { if (!found.has(big)) found.set(big, cfbr.partSource(big) ?? ''); return found.get(big)!; };
  const officials = chooseOfficials(l.officials).filter((o) => {
    const ps = partsOf(l, o), missing = ps.filter((p) => !p.big || !where(p.big));
    if (!ps.length) { warnings.push(`${o}: no parts`); return false; }
    if (missing.length) { warnings.push(`${o}: left out (missing ${missing.map((p) => p.big || p.name).join(', ')})`); return false; }
    return true;
  });
  if (!officials.length) throw new Error(`${donorSlot}: no complete uniform in CFBR (${l.sources.map((s) => s.from).join(', ')})`);
  if (!officials.includes('Home') || !officials.includes('Away')) warnings.push(`no complete ${['Home', 'Away'].filter((o) => !officials.includes(o)).join(' / ')}; bringing ${officials.join(' / ')}`);
  const out: UniformPart[] = []; const seen = new Set<string>();
  for (const o of officials) for (const p of partsOf(l, o)) { if (seen.has(p.big.toLowerCase())) continue; seen.add(p.big.toLowerCase()); out.push({ type: p.type, name: p.name, big: p.big, from: where(p.big), reuse: false }); }
  const byOfficial = Object.fromEntries(officials.map((o) => [o, partsOf(l, o).map((p) => ({ type: p.type, name: p.name }))]));
  return { donorSlot, slot, officials, parts: out, warnings, xmlFrom: [...new Set(officials.map((o) => l.sources[l.winner.get(o)!]!.from))].join(' + '), layered: l, byOfficial };
}

// read, rename and rebuild every part; the XML for the target slot
export function buildUniforms(cfbr: Cfbr, install: InstallParts, donorSlot: string, slot: string): UniformFiles {
  const plan = planUniforms(cfbr, install, donorSlot, slot); const files: { name: string; bytes: Buffer }[] = [];
  const taken = new Set<string>(); const maps = new Map<string, { from: string; to: string }[]>(); let code = 0;
  for (const p of plan.parts) {
    const got = cfbr.part(p.big)!; const base = p.big.replace(/_big$/i, '');
    const mine = install.has(p.big) ? install.bytes(p.big) : null;
    if (mine && sha(mine) === sha(got.bytes)) { p.reuse = true; continue; }
    let head = `${slot}_${T6[p.type] ?? 'PARTXX'}_2099_`; if (base.length - head.length < 1) head = `${slot}_${T6[p.type] ?? 'PARTXX'}_`.slice(0, base.length - 2);
    const room = base.length - head.length; if (room < 1) throw new Error(`${p.big}: name too short to rename under ${slot}`);
    const colour = (p.name.toUpperCase().replace(/[^A-Z0-9]/g, '') + 'XXXXXXXXXXXXXXXXXXXX').slice(0, room); let to = head + colour, k = 0;
    while (taken.has(to.toUpperCase()) || install.has(`${to}_big`)) { k++; to = head + colour.slice(0, room - String(k).length) + k; }
    taken.add(to.toUpperCase());
    const map = [{ from: base, to }]; const own = base.slice(0, 6);
    if (/^[A-Za-z0-9]{6}$/.test(own) && !/^generi$/i.test(own) && own.toUpperCase() !== slot.toUpperCase()) map.push({ from: own, to: `Q${slot.slice(-2)}${String(++code).padStart(3, '0')}` });
    maps.set(p.big.toLowerCase(), map); p.to = to;
    const big = parseNamedBigfile(got.bytes); for (const e of big.entries) e.data = inflateEntry(e.raw);
    renameBigfile(big, map);
    const stray = big.entries.filter((e) => map.some((m) => e.name.toLowerCase().includes(m.from.toLowerCase()))); if (stray.length) throw new Error(`${p.big}: names left unrenamed: ${stray.map((e) => e.name).join(', ')}`);
    files.push({ name: `${to}_big.ast`, bytes: buildNamedBigfile(big) });
  }
  // XML: each chosen official's part blocks from the XML that wins it, each block renamed with its own map and cut to the
  // officials it carries there; file names follow the XML's case
  const l = plan.layered, types = l.partTypes.map((t) => `  <partType name="${t}"/>`).join('\n'), offs = plan.officials.map((o) => `  <officialType name="${o}"/>`).join('\n');
  const blocks: string[] = [];
  l.sources.forEach((src, i) => {
    for (const p of src.parts) {
      const keep = p.officials.filter((o) => plan.officials.includes(o) && l.winner.get(o) === i); if (!keep.length) continue;
      let s = p.src.replace(/\s*<official name="([^"]+)"\s*\/>/g, (m, o: string) => (keep.includes(o) ? m : ''));
      for (const m of maps.get(p.big.toLowerCase()) ?? []) s = s.replace(new RegExp(m.from, 'gi'), (x) => (x === x.toUpperCase() ? m.to.toUpperCase() : x === x.toLowerCase() ? m.to.toLowerCase() : m.to));
      blocks.push(`  ${s}`);
    }
  });
  const xml = `<?xml version="1.0" ?><root>\n${types}\n\n${offs}\n\n${blocks.join('\n')}\n</root>\n`;
  for (const f of files) { const inXml = [...xml.matchAll(/<bigfile name="([^"]+)"/g)].map((m) => m[1]!).find((n) => `${n}.ast`.toLowerCase() === f.name.toLowerCase()); if (inXml) f.name = `${inXml}.ast`; }
  for (const m of xml.matchAll(/<bigfile name="([^"]+)"/g)) if (!files.some((f) => f.name.toLowerCase() === `${m[1]}.ast`.toLowerCase()) && !install.has(m[1]!)) throw new Error(`XML references ${m[1]}, which is neither written nor in this install`);
  return { plan, xml, files };
}

export function installUniforms(rpcs3: string, install: InstallParts, slot: string, u: UniformFiles, setAsideDir: string): UniformApplied {
  const xmlName = `${slot}_Pack0_MixAndMatch.XML`, existing = install.slotXmls(slot);
  const folder = existing.length ? dirname(existing[0]!) : join(dlcDir(rpcs3), 'FCS_DLC_NEC');
  const xmlPath = existing[0] ?? join(folder, xmlName); const originalXml = existsSync(xmlPath) ? readFileSync(xmlPath, 'latin1') : null;
  const applied: UniformApplied = { folder, written: [], xmlPath, originalXml, setAside: [] };
  mkdirSync(setAsideDir, { recursive: true });
  for (const other of existing.slice(1)) { const to = join(setAsideDir, `${basename(dirname(other))}__${basename(other)}`); renameSync(other, to); applied.setAside.push({ from: other, to }); }
  for (const f of u.files) { const p = join(folder, f.name); if (existsSync(p)) throw new Error(`${p} already exists`); writeFileSync(p, f.bytes); applied.written.push(p); install.noteWritten(p); }
  writeFileSync(xmlPath, u.xml, 'latin1');
  return applied;
}
export function restoreUniforms(a: UniformApplied): string {
  let removed = 0; for (const p of a.written) if (existsSync(p)) { unlinkSync(p); removed++; }
  if (a.originalXml !== null) writeFileSync(a.xmlPath, a.originalXml, 'latin1'); else if (existsSync(a.xmlPath)) unlinkSync(a.xmlPath);
  for (const s of a.setAside) if (existsSync(s.to) && !existsSync(s.from)) renameSync(s.to, s.from);
  return `${removed} part file(s) removed, ${a.originalXml !== null ? 'original XML put back' : 'XML removed'}${a.setAside.length ? `, ${a.setAside.length} set-aside XML(s) back` : ''}`;
}
