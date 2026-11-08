// An FBS team swapped into a generic slot (TGID 160-164), everything the game shows of the team:
//   players   the donor roster's (PHOENIX26) players into the slot's PLST / DCST rows of every standard-data copy
//             (swapGenericTeam), each then boosted to 97-99 (boost.ts);
//   identity  TEAM name / nickname / abbreviations / colours, and a home stadium (the slot's repainted HS stadium row
//             named after the donor's), in the FCS2026 roster save and the game's default roster;
//   uniforms  CFBR's (uniforms.ts), logos CFBR's menu + score bug logos (logos.ts);
//   score bug CFBR's short name and colours for the team, as the slot's TLGL entry of the score bug's team table
//             (scorebug.ts setScorebugTeams; the generic slots have none of their own).
// The first swap of a slot snapshots what it replaces (rows, records, XML); a restore puts that back. State and backups
// live in %LOCALAPPDATA%\ncaa-bridge\swaps.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join } from 'node:path';
import { parseTdb, type FieldValue, type TdbFile, type TdbTable } from '@ncaa/tdb';
import { copyTeamIdentity, swapGenericTeam } from '@ncaa/ncaa14';
import { STDA_BACKUP_ROOT, findStdaCopies, gameArchives, rekeyStdaArchive, rpcs3RunningOver, stdaFile } from '../stda.js';
import { Cfbr, SCOREBUG_LOGO, dlcKlic } from './cfbr.js';
import { GENERIC_SLOTS, GENERIC_STADIUMS, GENERIC_STADIUM_ART, InstallParts, dbTargets, readDb, rewriteDb, rosterSavePath, type DbTarget } from './install.js';
import { buildUniforms, installUniforms, planUniforms, restoreUniforms, type UniformApplied } from './uniforms.js';
import { logoPng, logoSnapshot, writeLogos, type LogoSnapshot } from './logos.js';
import { boostRow, boostTargets } from './boost.js';
import { decodeDds, encodePng } from './bigfile.js';
import { readScorebug, revertScorebug, scorebugArchive, scorebugSha, scorebugSnapshot, setScorebugTeams, writeScorebug, type ScorebugColours, type ScorebugSnapshot } from '../scorebug.js';

type Row = Record<string, FieldValue>;
export const SWAP_ROOT = join(STDA_BACKUP_ROOT, '..', 'swaps');
export const POS = ['QB', 'HB', 'FB', 'WR', 'TE', 'LT', 'LG', 'C', 'RG', 'RT', 'LE', 'RE', 'DT', 'LOLB', 'MLB', 'ROLB', 'CB', 'FS', 'SS', 'K', 'P', 'KR', 'PR', 'KOS', 'LS'];
export interface SlotOriginal { name: string; plst: Row[]; dcst: Row[]; team: Record<string, Row>; stad: Record<string, Row | null>; logos: LogoSnapshot }
export interface SlotState { donorTgid: number; donorName: string; at: string; original: SlotOriginal; uniforms: UniformApplied | null; backupDir: string }
// scorebug: the archive's score bug record before the tool's first score bug write (restoring the last swap goes back to it)
export interface SwapState { version: 1; slots: Record<string, SlotState>; scorebug?: ScorebugSnapshot }
export interface Step { label: string; status: 'done' | 'skipped' | 'error'; note: string }
export interface SwapEnv { rpcs3: string; cfbrPkg?: string; donorRoster: string | Uint8Array; stateDir?: string } // donor roster: a USR-DATA path or its bytes
export const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;
const rgb = (v: number) => `#${(v >>> 0).toString(16).padStart(6, '0')}`;

const findRow = (t: TdbTable, col: string, v: number): number => { for (let i = 0; i < t.recordCount; i++) if (Number(t.get(i, col)) === v) return i; return -1; };
const putStr = (t: TdbTable, i: number, k: string, s: string) => { if (t.fieldMap.has(k)) t.set(i, k, s.slice(0, Math.max(0, t.field(k).bits / 8 - 1))); };
const putNum = (t: TdbTable, i: number, k: string, v: number) => { if (t.fieldMap.has(k)) t.set(i, k, v); };

export class SwapTool {
  readonly stateDir: string; private cfbrCache?: Cfbr; private installCache?: InstallParts; private donorFile: TdbFile; private pngCache = new Map<string, Buffer>();
  constructor(readonly env: SwapEnv) {
    this.stateDir = env.stateDir ?? SWAP_ROOT;
    if (typeof env.donorRoster === 'string' && !existsSync(env.donorRoster)) throw new Error(`donor roster not found: ${env.donorRoster}`);
    this.donorFile = parseTdb(typeof env.donorRoster === 'string' ? new Uint8Array(readFileSync(env.donorRoster)) : env.donorRoster);
  }
  get cfbr(): Cfbr { if (!this.cfbrCache) { if (!this.env.cfbrPkg || !existsSync(this.env.cfbrPkg)) throw new Error('CFBR installer pkg not found (pass --cfbr <...EASY_INSTALLER...pkg>)'); const klic = dlcKlic(this.env.rpcs3); if (!klic) throw new Error("NCAA 14's DLC key is not in this install's RPCS3.log yet: start the game in RPCS3 once (to the main menu), close it, then try again"); this.cfbrCache = new Cfbr(this.env.cfbrPkg, klic); } return this.cfbrCache; }
  get install(): InstallParts { return (this.installCache ??= new InstallParts(this.env.rpcs3)); }
  cfbrStatus(): { pkg: string | null; ok: boolean; error?: string } { try { this.cfbr; return { pkg: this.env.cfbrPkg ?? null, ok: true }; } catch (e) { return { pkg: this.env.cfbrPkg ?? null, ok: false, error: (e as Error).message }; } }
  running(): boolean { return rpcs3RunningOver(gameArchives(this.env.rpcs3)); }
  state(): SwapState { const p = join(this.stateDir, 'state.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { version: 1, slots: {} }; }
  private save(s: SwapState): void { mkdirSync(this.stateDir, { recursive: true }); writeFileSync(join(this.stateDir, 'state.json'), JSON.stringify(s, null, 1)); }
  private targets(): DbTarget[] { return dbTargets(this.env.rpcs3).filter((t) => existsSync(t.path)); }

  // ---- what the UI shows ----
  slots() {
    const f = readDb(this.targets()[0]!), T = f.table('TEAM'), S = f.table('STAD'), st = this.state();
    return GENERIC_SLOTS.map((tg) => {
      const i = findRow(T, 'TGID', tg), g = (k: string) => T.get(i, k), si = findRow(S, 'SGID', Number(g('SGID'))), sw = st.slots[tg];
      return { tgid: tg, slot: String(g('CSAT')), name: String(g('TDNA')), mascot: String(g('TMNA')), abbr: String(g('TSNA')), tlgl: Number(g('TLGL')),
        colors: { primary: hex(Number(g('TBCR')), Number(g('TBCG')), Number(g('TBCB'))), secondary: hex(Number(g('TB2R')), Number(g('TB2G')), Number(g('TB2B'))) },
        logo: `/api/logo/install/${Number(g('TLGL'))}`, stadium: si >= 0 ? String(S.get(si, 'SNAM')) : '(no home stadium)',
        swapped: sw ? { donorTgid: sw.donorTgid, donorName: sw.donorName, at: sw.at, original: sw.original.name } : null };
    });
  }
  donors() {
    const T = this.donorFile.table('TEAM'), C = this.donorFile.table('CONF'), conf = new Map<number, string>();
    for (let i = 0; i < C.recordCount; i++) conf.set(Number(C.get(i, 'CGID')), String(C.get(i, 'CNAM')));
    const out = [];
    for (let i = 0; i < T.recordCount; i++) {
      const g = (k: string) => T.get(i, k), tg = Number(g('TGID')); if (Number(g('TTYP')) !== 0 || tg >= 600) continue;
      out.push({ tgid: tg, name: String(g('TDNA')), mascot: String(g('TMNA')), abbr: String(g('TSNA')), conference: conf.get(Number(g('CGID'))) ?? '', slot: String(g('CSAT')), tlgl: Number(g('TLGL')),
        colors: { primary: hex(Number(g('TBCR')), Number(g('TBCG')), Number(g('TBCB'))), secondary: hex(Number(g('TB2R')), Number(g('TB2G')), Number(g('TB2B'))) }, logo: `/api/logo/cfbr/${Number(g('TLGL'))}` });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
  private donorTeam(tgid: number): Row { const T = this.donorFile.table('TEAM'), i = findRow(T, 'TGID', tgid); if (i < 0 || Number(T.get(i, 'TTYP')) !== 0) throw new Error(`no FBS team ${tgid} in the donor roster`); return T.row(i); }
  private donorRows(table: string, tgid: number): Row[] { const t = this.donorFile.table(table), out: Row[] = []; for (let i = 0; i < t.recordCount; i++) if (Number(t.get(i, 'TGID')) === tgid) out.push(t.row(i)); return out; }
  private donorStadium(team: Row): Row | null { const S = this.donorFile.table('STAD'), i = findRow(S, 'SGID', Number(team.SGID)); return i >= 0 ? S.row(i) : null; }
  donor(tgid: number) {
    const d = this.donors().find((x) => x.tgid === tgid); if (!d) throw new Error(`no FBS team ${tgid}`);
    const players = this.donorRows('PLAY', tgid), targets = boostTargets(players.map((p) => ({ key: Number(p.PGID), ovr: Number(p.POVR) })));
    const top3 = [...players].sort((a, b) => Number(b.POVR) - Number(a.POVR)).slice(0, 3).map((p) => ({ name: `${p.PFNA} ${p.PLNA}`, pos: POS[Number(p.PPOS)] ?? String(p.PPOS), jersey: Number(p.PJEN), ovr: Number(p.POVR), boosted: targets.get(Number(p.PGID))! }));
    const st = this.donorStadium(this.donorTeam(tgid)); let uniforms: { official: string; parts: Record<string, string> }[] = [], warnings: string[] = [];
    try {
      const plan = planUniforms(this.cfbr, this.install, d.slot, 'XXXXXX');
      uniforms = plan.officials.map((o) => ({ official: o, parts: Object.fromEntries(plan.byOfficial[o]!.filter((b) => ['helmet', 'jersey', 'pants'].includes(b.type)).map((b) => [b.type, b.name])) }));
      warnings = plan.warnings;
    } catch (e) { warnings = [(e as Error).message]; }
    let scorebug: { name: string; primary: string; secondary: string } | null = null;
    try { const sb = this.cfbr.scorebugTeams().get(d.tlgl); if (sb) scorebug = { name: sb.name, primary: rgb(sb.primary), secondary: rgb(sb.secondary) }; } catch { /* no CFBR pkg: the preview goes without */ }
    return { ...d, stadium: { name: st ? String(st.SNAM) : '', city: st ? String(st.SCIT) : '' }, players: players.length, top3, uniforms, warnings, scorebug };
  }
  logo(source: 'cfbr' | 'install', index: number): Buffer {
    const key = `${source}:${index}`; const hit = this.pngCache.get(key); if (hit && source === 'cfbr') return hit;
    const png = source === 'cfbr' ? (() => { const l = this.cfbr.logo(index); return encodePngFromDds(l.dds); })() : logoPng(this.env.rpcs3, index);
    if (source === 'cfbr') this.pngCache.set(key, png); return png;
  }

  // ---- apply / restore ----
  apply(slot: number, donorTgid: number): Step[] {
    if (!(GENERIC_SLOTS as readonly number[]).includes(slot)) throw new Error(`slot ${slot}: only the generic teams 160-164 can be swapped`);
    if (this.running()) throw new Error('RPCS3 is running from this install: close it first');
    const team = this.donorTeam(donorTgid), name = String(team.TDNA), st = this.state(), prior = st.slots[slot], steps: Step[] = [];
    const backupDir = prior?.backupDir ?? join(this.stateDir, `${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}-slot${slot}`);
    const run = (label: string, fn: () => string) => { try { steps.push({ label, status: 'done', note: fn() }); } catch (e) { steps.push({ label, status: 'error', note: (e as Error).message }); } };
    const targets = this.targets(), first = readDb(targets[0]!), FT = first.table('TEAM'), ti = findRow(FT, 'TGID', slot);
    const slotCsat = String(FT.get(ti, 'CSAT')), slotTlgl = Number(FT.get(ti, 'TLGL'));
    // the first swap of a slot remembers what it replaces
    const original: SlotOriginal = prior?.original ?? (() => {
      const copy = findStdaCopies(gameArchives(this.env.rpcs3))[0]; const sf = copy ? stdaFile(copy.archive) : null; if (!sf) throw new Error('no standard-data entry in this install');
      const rows = (t: string) => { const tb = sf.table(t), out: Row[] = []; for (let i = 0; i < tb.recordCount; i++) if (Number(tb.get(i, 'TGID')) === slot) out.push(tb.row(i)); return out; };
      const team: Record<string, Row> = {}, stad: Record<string, Row | null> = {};
      for (const t of targets) { const f = readDb(t), T = f.table('TEAM'), S = f.table('STAD'), si = findRow(S, 'SGID', GENERIC_STADIUMS[slot]!.sgid); team[t.label] = T.row(findRow(T, 'TGID', slot)); stad[t.label] = si >= 0 ? S.row(si) : null; }
      return { name: String(FT.get(ti, 'TDNA')), plst: rows('PLST'), dcst: rows('DCST'), team, stad, logos: logoSnapshot(this.env.rpcs3, slotTlgl) };
    })();
    const entry: SlotState = { donorTgid, donorName: name, at: '', original, uniforms: prior?.uniforms ?? null, backupDir };
    const players = this.donorRows('PLAY', donorTgid), depth = this.donorRows('DCHT', donorTgid);
    run(`Players: ${name} into the ${original.name} slot, boosted to 97-99`, () => {
      const notes: string[] = [];
      for (const c of findStdaCopies(gameArchives(this.env.rpcs3))) {
        let r: ReturnType<typeof swapGenericTeam> | undefined; let boosted = 0;
        rekeyStdaArchive(c.archive, join(backupDir, `stda-${Date.now()}`), { to: 100, tool: 'ncaa-bridge swap', edit: (f) => {
          r = swapGenericTeam(f, { players, depth }, { tgid: slot });
          const P = f.table('PLST'), idx: number[] = []; for (let i = 0; i < P.recordCount; i++) if (Number(P.get(i, 'TGID')) === slot) idx.push(i);
          const tg = boostTargets(idx.map((i) => ({ key: Number(P.get(i, 'PGID')), ovr: Number(P.get(i, 'POVR')) })));
          for (const i of idx) { const ch = boostRow(P.row(i), Number(P.get(i, 'PPOS')), tg.get(Number(P.get(i, 'PGID')))!); for (const [k, v] of Object.entries(ch)) if (P.fieldMap.has(k)) P.set(i, k, Math.min(v, 2 ** P.field(k).bits - 1)); boosted++; }
        } });
        if (r && !notes.length) notes.push(`${r.count} players${r.improvised.length ? ` (${r.improvised.length} spots improvised)` : ''}, ${boosted} boosted`);
      }
      return notes.join('; ') || 'no standard-data copy found';
    });
    const ds = this.donorStadium(team), stadium = GENERIC_STADIUMS[slot]!;
    for (const t of targets) run(`Name, colours and home stadium: ${t.label}`, () => {
      const r = rewriteDb(t, backupDir, (f) => {
        copyTeamIdentity(f, slot, team); const T = f.table('TEAM'), S = f.table('STAD'), i = findRow(T, 'TGID', slot); putNum(T, i, 'SGID', stadium.sgid);
        const si = findRow(S, 'SGID', stadium.sgid); if (si < 0) throw new Error(`no STAD row ${stadium.sgid}`);
        putStr(S, si, 'SNAM', ds ? String(ds.SNAM) : `${name} Stadium`); putStr(S, si, 'SCIT', ds ? String(ds.SCIT) : ''); putStr(S, si, 'TDNA', name);
        putStr(S, si, 'STAA', GENERIC_STADIUM_ART); putStr(S, si, 'FLID', stadium.field);
        if (ds) for (const k of ['SCAP', 'SLAT', 'SLON']) if (S.fieldMap.has(k) && k in ds) S.set(si, k, ds[k]!);
      });
      return `${r.changed ? 'updated' : 'already current'}: ${name}, ${ds ? String(ds.SNAM) : `${name} Stadium`}`;
    });
    run(`Uniforms (CFBR ${String(team.CSAT)})`, () => {
      if (entry.uniforms) { restoreUniforms(entry.uniforms); entry.uniforms = null; } // a re-swap: the previous donor's files out, the slot's own XML back
      this.installCache = undefined; const u = buildUniforms(this.cfbr, this.install, String(team.CSAT), slotCsat);
      entry.uniforms = installUniforms(this.env.rpcs3, this.install, slotCsat, u, join(backupDir, 'set-aside'));
      return `${u.plan.officials.join(' / ')}: ${u.files.length} part files written, ${u.plan.parts.filter((p) => p.reuse).length} reused${u.plan.warnings.length ? `; ${u.plan.warnings.join('; ')}` : ''}`;
    });
    run('Logos (menu and score bug)', () => writeLogos(this.env.rpcs3, slotTlgl, { menu: this.cfbr.logo(Number(team.TLGL)), scorebug: this.cfbr.logo(SCOREBUG_LOGO + Number(team.TLGL)) }, backupDir));
    run('Score bug name and colour', () => {
      const sb = this.cfbr.scorebugTeams().get(Number(team.TLGL)) ?? null;
      const r = this.scorebugWrite(st, { [slotTlgl]: sb }, join(backupDir, `scorebug-${Date.now()}`));
      return sb ? `"${sb.name}" ${rgb(sb.primary)} / ${rgb(sb.secondary)} (${r})` : `CFBR has no score bug entry for ${name}: the bar shows the game's name and colour (${r})`;
    });
    entry.at = new Date().toISOString(); st.slots[slot] = entry; this.save(st); return steps;
  }

  restore(slot: number): Step[] {
    if (this.running()) throw new Error('RPCS3 is running from this install: close it first');
    const st = this.state(), s = st.slots[slot]; if (!s) throw new Error(`slot ${slot} is not swapped`);
    const steps: Step[] = []; const run = (label: string, fn: () => string) => { try { steps.push({ label, status: 'done', note: fn() }); } catch (e) { steps.push({ label, status: 'error', note: (e as Error).message }); } };
    const o = s.original;
    run(`Players: ${o.name} back`, () => {
      for (const c of findStdaCopies(gameArchives(this.env.rpcs3))) rekeyStdaArchive(c.archive, join(s.backupDir, `stda-${Date.now()}`), { to: 100, tool: 'ncaa-bridge swap restore', edit: (f) => {
        const P = f.table('PLST'), D = f.table('DCST'), byPgid = new Map(o.plst.map((r) => [Number(r.PGID), r]));
        for (let i = 0; i < P.recordCount; i++) { if (Number(P.get(i, 'TGID')) !== slot) continue; const r = byPgid.get(Number(P.get(i, 'PGID'))); if (!r) throw new Error(`PLST PGID ${P.get(i, 'PGID')} has no saved original`); for (const [k, v] of Object.entries(r)) P.set(i, k, v); }
        const di: number[] = []; for (let i = 0; i < D.recordCount; i++) if (Number(D.get(i, 'TGID')) === slot) di.push(i);
        if (di.length !== o.dcst.length) throw new Error(`DCST has ${di.length} rows for the slot, the saved original ${o.dcst.length}`);
        di.forEach((i, k) => { for (const [f2, v] of Object.entries(o.dcst[k]!)) D.set(i, f2, v); });
      } });
      return `${o.plst.length} PLST and ${o.dcst.length} DCST rows`;
    });
    for (const t of this.targets()) run(`Name, colours and stadium: ${t.label}`, () => {
      const team = o.team[t.label], stad = o.stad[t.label]; if (!team) return 'no saved original for this file (skipped)';
      rewriteDb(t, s.backupDir, (f) => {
        const T = f.table('TEAM'), i = findRow(T, 'TGID', slot); for (const [k, v] of Object.entries(team)) T.set(i, k, v);
        if (stad) { const S = f.table('STAD'), si = findRow(S, 'SGID', Number(stad.SGID)); if (si >= 0) for (const [k, v] of Object.entries(stad)) S.set(si, k, v); }
      });
      return o.name;
    });
    run('Uniforms', () => (s.uniforms ? restoreUniforms(s.uniforms) : 'none were installed'));
    run('Logos', () => writeLogos(this.env.rpcs3, Number(o.team[Object.keys(o.team)[0]!]!.TLGL), o.logos, s.backupDir));
    run('Score bug', () => this.scorebugWrite(st, { [Number(o.team[Object.keys(o.team)[0]!]!.TLGL)]: null }, join(s.backupDir, `scorebug-${Date.now()}`)));
    if (steps.every((x) => x.status !== 'error')) { delete st.slots[slot]; this.save(st); }
    return steps;
  }

  // set / remove team table entries of the score bug; back to the snapshot from before the first swap when the table
  // comes out as it was then (so undoing every swap leaves qkl_patch.ast byte for byte as it was)
  private scorebugWrite(st: SwapState, change: Record<number, ScorebugColours | null>, dir: string): string {
    const archive = scorebugArchive(this.env.rpcs3); const loc = existsSync(archive) ? readScorebug(archive) : null; if (!loc) throw new Error(`no score bug in ${archive}`);
    const apt = setScorebugTeams(loc.apt, change), sha = scorebugSha(apt);
    if (sha === loc.sha) return 'already current';
    if (st.scorebug?.sha === sha) try { const n = revertScorebug(archive, st.scorebug); delete st.scorebug; return n; } catch { /* the snapshot's bytes are gone: write it like any other */ }
    st.scorebug ??= scorebugSnapshot(archive);
    const r = writeScorebug(archive, deflateSync(apt, { level: 9, memLevel: 9 }), dir, { tool: 'ncaa-bridge swap' });
    return r.status === 'written' ? `written; backup in ${dir}` : r.note;
  }

  // the generic slots' own home stadiums (unswapped slots only): their real stadium names on the repainted HS rows
  stadiums(): Step[] {
    if (this.running()) throw new Error('RPCS3 is running from this install: close it first');
    const st = this.state(), steps: Step[] = [], dir = join(this.stateDir, `${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}-stadiums`);
    for (const t of this.targets()) {
      try {
        const r = rewriteDb(t, dir, (f) => {
          const T = f.table('TEAM'), S = f.table('STAD');
          for (const slot of GENERIC_SLOTS) {
            if (st.slots[slot]) continue; const p = GENERIC_STADIUMS[slot]!, i = findRow(T, 'TGID', slot), si = findRow(S, 'SGID', p.sgid); if (i < 0 || si < 0) continue;
            putNum(T, i, 'SGID', p.sgid); putStr(S, si, 'SNAM', p.name); putStr(S, si, 'SCIT', p.city); putStr(S, si, 'TDNA', String(T.get(i, 'TDNA'))); putStr(S, si, 'STAA', GENERIC_STADIUM_ART); putStr(S, si, 'FLID', p.field);
          }
        });
        steps.push({ label: `Generic home stadiums: ${t.label}`, status: 'done', note: r.changed ? `set (originals in ${dir})` : 'already current' });
      } catch (e) { steps.push({ label: `Generic home stadiums: ${t.label}`, status: 'error', note: (e as Error).message }); }
    }
    return steps;
  }
  close(): void { this.cfbrCache?.close(); }
}
const encodePngFromDds = (dds: Buffer) => encodePng(decodeDds(dds, 256));
export { rosterSavePath };
