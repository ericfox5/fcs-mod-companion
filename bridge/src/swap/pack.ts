// The commissioner's generic slots as a pack for FCS-online.exe: what this install shows for each of the five generic
// teams (TEAM identity + home stadium row from the FCS2026 roster save), and for a swapped slot its PLST / DCST rows (as
// they stand in the standard data), its uniform files and XML (the DLC folder) and its two logo streams. exportSwapPack
// writes a manifest (JSON) and one blob; applySwapPack puts it all on a member's install and skips what is already
// current, so join can run it every time.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { FieldValue, TdbTable } from '@ncaa/tdb';
import { findStdaCopies, gameArchives, rekeyStdaArchive, stdaFile } from '../stda.js';
import { bgfaToc } from '../scorebug.js';
import { GENERIC_SLOTS, dbTargets, dlcDir, readDb, rewriteDb } from './install.js';
import { inflateEntry } from './bigfile.js';
import { SCOREBUG_LOGO } from './cfbr.js';
import { logoBigfile, writeLogos } from './logos.js';
import { TEAM_IDENTITY_FIELDS } from '@ncaa/ncaa14';
import type { SwapState, Step } from './swap.js';

type Row = Record<string, FieldValue>;
interface Blob { offset: number; size: number; sha1: string }
export interface SwapPackSlot {
  tgid: number; tlgl: number; team: Row; stad: Row | null;
  swap?: { donorTgid: number; donorName: string; at: string; plst: Row[]; dcst: Row[];
    uniforms: { folder: string; xmlName: string; xml: string; files: (Blob & { name: string })[] } | null;
    logos: { menu: Blob & { usize: number }; scorebug: Blob & { usize: number } } };
}
export interface SwapPackManifest { builtAt: string; slots: SwapPackSlot[] }
const sha1 = (b: Uint8Array) => createHash('sha1').update(b).digest('hex');
const findRow = (t: TdbTable, col: string, v: number) => { for (let i = 0; i < t.recordCount; i++) if (Number(t.get(i, col)) === v) return i; return -1; };

export function exportSwapPack(rpcs3: string, state: SwapState): { manifest: SwapPackManifest; blob: Buffer } {
  const chunks: Buffer[] = []; let off = 0; const add = (b: Buffer): Blob => { const r = { offset: off, size: b.length, sha1: sha1(b) }; chunks.push(b); off += b.length; return r; };
  const roster = readDb(dbTargets(rpcs3).find((t) => existsSync(t.path))!), T = roster.table('TEAM'), S = roster.table('STAD');
  const sf = stdaFile(findStdaCopies(gameArchives(rpcs3))[0]!.archive)!;
  const logoBig = logoBigfile(rpcs3);
  const logoStream = (k: number) => { const x = bgfaToc(logoBig).entries[k]!; const raw = Buffer.from(logoBig.subarray(x.off, x.off + x.csize)); return { ...add(raw), usize: inflateEntry(raw).length }; };
  const slots: SwapPackSlot[] = [];
  for (const tg of GENERIC_SLOTS) {
    const i = findRow(T, 'TGID', tg); const team: Row = {}; for (const k of [...TEAM_IDENTITY_FIELDS, 'SGID']) if (T.fieldMap.has(k)) team[k] = T.get(i, k);
    const si = findRow(S, 'SGID', Number(team.SGID)); const tlgl = Number(T.get(i, 'TLGL'));
    const slot: SwapPackSlot = { tgid: tg, tlgl, team, stad: si >= 0 ? S.row(si) : null };
    const st = state.slots[tg];
    if (st) {
      const rows = (t: string) => { const tb = sf.table(t), out: Row[] = []; for (let j = 0; j < tb.recordCount; j++) if (Number(tb.get(j, 'TGID')) === tg) out.push(tb.row(j)); return out; };
      const u = st.uniforms;
      slot.swap = { donorTgid: st.donorTgid, donorName: st.donorName, at: st.at, plst: rows('PLST'), dcst: rows('DCST'),
        uniforms: u ? { folder: basename(u.folder), xmlName: basename(u.xmlPath), xml: readFileSync(u.xmlPath, 'latin1'), files: u.written.filter((p) => !/MixAndMatch\.XML$/i.test(p)).map((p) => ({ name: basename(p), ...add(readFileSync(p)) })) } : null,
        logos: { menu: logoStream(tlgl), scorebug: logoStream(SCOREBUG_LOGO + tlgl) } };
    }
    slots.push(slot);
  }
  return { manifest: { builtAt: new Date().toISOString(), slots }, blob: Buffer.concat(chunks) };
}

const piece = (blob: Buffer, b: Blob) => { const x = blob.subarray(b.offset, b.offset + b.size); if (sha1(x) !== b.sha1) throw new Error('swap pack is damaged'); return Buffer.from(x); };
export function applySwapPack(rpcs3: string, m: SwapPackManifest, blob: Buffer, backupDir: string): Step[] {
  const steps: Step[] = []; const run = (label: string, fn: () => string) => { try { steps.push({ label, status: 'done', note: fn() }); } catch (e) { steps.push({ label, status: 'error', note: (e as Error).message }); } };
  const swapped = m.slots.filter((s) => s.swap);
  if (swapped.length) run(`Players (${swapped.map((s) => s.swap!.donorName).join(', ')})`, () => {
    const notes: string[] = [];
    for (const c of findStdaCopies(gameArchives(rpcs3))) {
      const r = rekeyStdaArchive(c.archive, join(backupDir, `stda-${basename(c.archive)}`), { to: 100, tool: 'FCS-online.exe join (swaps)', edit: (f) => {
        const P = f.table('PLST'), D = f.table('DCST');
        for (const s of swapped) {
          const by = new Map(s.swap!.plst.map((x) => [Number(x.PGID), x]));
          for (let i = 0; i < P.recordCount; i++) { if (Number(P.get(i, 'TGID')) !== s.tgid) continue; const x = by.get(Number(P.get(i, 'PGID'))); if (!x) throw new Error(`team ${s.tgid}: PLST PGID ${P.get(i, 'PGID')} is not in the pack`); for (const [k, v] of Object.entries(x)) if (P.fieldMap.has(k)) P.set(i, k, v); }
          const di: number[] = []; for (let i = 0; i < D.recordCount; i++) if (Number(D.get(i, 'TGID')) === s.tgid) di.push(i);
          if (di.length !== s.swap!.dcst.length) throw new Error(`team ${s.tgid}: ${di.length} DCST rows here, ${s.swap!.dcst.length} in the pack`);
          di.forEach((i, k) => { for (const [f2, v] of Object.entries(s.swap!.dcst[k]!)) if (D.fieldMap.has(f2)) D.set(i, f2, v); });
        }
      } });
      notes.push(`${basename(c.archive)} ${r.status === 'rekeyed' ? 'updated' : r.status === 'already' ? 'already current' : `skipped (${r.note})`}`);
    }
    return notes.join(', ') || 'no standard-data copy found';
  });
  for (const t of dbTargets(rpcs3).filter((x) => existsSync(x.path))) run(`Names, colours and home stadiums: ${t.label}`, () => {
    const r = rewriteDb(t, backupDir, (f) => {
      const T = f.table('TEAM'), S = f.table('STAD');
      for (const s of m.slots) {
        const i = findRow(T, 'TGID', s.tgid); if (i < 0) continue; for (const [k, v] of Object.entries(s.team)) if (T.fieldMap.has(k)) T.set(i, k, v);
        if (s.stad) { const si = findRow(S, 'SGID', Number(s.stad.SGID)); if (si >= 0) for (const [k, v] of Object.entries(s.stad)) if (S.fieldMap.has(k)) S.set(si, k, v); }
      }
    });
    return r.changed ? 'updated' : 'already current';
  });
  for (const s of swapped) {
    const u = s.swap!.uniforms;
    if (u) run(`Uniforms: ${s.swap!.donorName}`, () => {
      const dir = join(dlcDir(rpcs3), u.folder); mkdirSync(dir, { recursive: true }); let written = 0, same = 0;
      for (const f of u.files) { const p = join(dir, f.name); const b = piece(blob, f); if (existsSync(p) && sha1(readFileSync(p)) === f.sha1) { same++; continue; } writeFileSync(p, b); written++; }
      const xp = join(dir, u.xmlName); if (!existsSync(xp) || readFileSync(xp, 'latin1') !== u.xml) { if (existsSync(xp)) { mkdirSync(backupDir, { recursive: true }); writeFileSync(join(backupDir, `${u.folder}__${u.xmlName}`), readFileSync(xp)); } writeFileSync(xp, u.xml, 'latin1'); written++; } else same++;
      for (const d of readdirSync(dlcDir(rpcs3))) { if (d === u.folder) continue; const o = join(dlcDir(rpcs3), d, u.xmlName); if (existsSync(o)) { mkdirSync(backupDir, { recursive: true }); renameSync(o, join(backupDir, `${d}__${u.xmlName}.setaside`)); } }
      return `${written} file(s) written, ${same} already current`;
    });
    run(`Logos: ${s.swap!.donorName}`, () => {
      const cur = (() => { const big = logoBigfile(rpcs3), t = bgfaToc(big); return (k: number) => { const x = t.entries[k]!; return sha1(big.subarray(x.off, x.off + x.csize)); }; })();
      const lg = s.swap!.logos; if (cur(s.tlgl) === lg.menu.sha1 && cur(SCOREBUG_LOGO + s.tlgl) === lg.scorebug.sha1) return 'already current';
      const menu = piece(blob, lg.menu), sb = piece(blob, lg.scorebug);
      return writeLogos(rpcs3, s.tlgl, { menu: { raw: menu, dds: inflateEntry(menu) }, scorebug: { raw: sb, dds: inflateEntry(sb) } }, backupDir);
    });
  }
  return steps;
}
export const swapPackSummary = (m: SwapPackManifest): string => m.slots.map((s) => (s.swap ? `${s.tgid}: ${s.swap.donorName}` : `${s.tgid}: ${String(s.team.TDNA ?? '')}`)).join(', ');
