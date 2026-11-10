// The game's playbook databases as one set of row views, from either source:
//  - a PER-BOOK DB (`new PlaybookDb(book, bokl)`): the compiled playbook the game plays from, qkl_fe2ig.ast entry
//    PLAYBOOK_<PLAB.PBAN>, one per book, 19 tables: PBFM formations, PBST sets of the book (SETL, PBFM, ord_), SETL /
//    SETP / SETG / 'SGF ' set geometry, PLYL play info, PBPL the play list (PBPL id, PLYL, PBST, ord_), PLYS per-slot
//    assignments, PSAL step programs, ARTL play art, PLPD progressions, PLRD run holes, PBAI AI weights (by PBPL id),
//    PBAU audibles, SPKF/SPKG packages, FORM, PLCM. Ids are the master's own, so the Book JSON is the same model.
//  - the MASTER DB (`new PlaybookDb(misc, boot)`): qkl_misc.ast entry #7 (CUSTOMPLAYBOOKS: PGFM/STID/PGPL book ->
//    formations -> sets -> plays, PBPL play info, PLYS, PSLO/PSLD step programs, ARTO/ARTD art, PBA1-4 AI weights,
//    BSMO/DPSF special sets) merged with the boot "base" DB (qkl_boot.ast entry #360: PSAL programs and the
//    formations/sets/plays every book shares). The master only feeds the game's custom-playbook feature, and on the FCS
//    mod it is CFBR's edited copy, so the site extracts from the per-book DBs; the master view stays for calibration.
// Both are already parsed by @ncaa/tdb: this file does no file reading, so the Worker, the bridge and the tests can all
// build the same views from the same bytes.
//
// Master merge rule: misc first, boot as the fallback (a row the master DB carries wins; byKey keeps the first row per
// key and group skips a duplicated (key, key2) pair). Quirks kept on purpose, because the generated JSON depends on
// them: boot's sub-formation list is the table 'SGF ' (trailing space) where misc has SGFF; boot keeps play info in
// PLYL where misc has PBPL; boot's art table is ARTL; and a step program is looked up PSLO, then PSLD, then PSAL
// whatever the side. The per-book DB uses the boot-style names throughout ('SGF ', PLYL, ARTL, PSAL).
import type { TdbFile } from '@ncaa/tdb';

export type PlaybookRow = Record<string, number | string>;
type Row = PlaybookRow;

const rows = (db: TdbFile | undefined, n: string): Row[] => { if (!db) return []; try { return [...db.table(n).rows()] as Row[]; } catch { return []; } };
const sgfName = (db: TdbFile | undefined) => db?.tables.find((t) => t.name.replace(/[\s\0]+$/, '') === 'SGF')?.name ?? 'SGF '; // the 4CC is 'SGF' + a NUL byte in the compiled DBs (shown as 'SGF ' in the scans)

// What a compiled book borrows from outside its own entry: the boot "base" DB (qkl_boot.ast entry #360, the same
// 19-table shape: the shared special-teams sets and plays with their programs and art) and, from the master DB, the
// list of special sets every book offers (BSMO) with their plays (DPSF). Without them a per-book view has only the
// book's own sets (Holy Cross's Spread: Shotgun, Wildcat, Goal Line, Hail Mary, Punt, Kickoff, Safety Punt) and no
// field goal, kneel, spike or fake-punt sets.
export interface SharedPlaybookData { boot?: TdbFile; master?: TdbFile }
const byKey = <T extends Row>(rs: T[], k: string) => { const m = new Map<number, T>(); for (const r of rs) if (!m.has(r[k] as number)) m.set(r[k] as number, r); return m; };
// group by k; when a second key is given, rows duplicated across the two databases (same k + k2) keep the first seen
const group = <T extends Row>(rs: T[], k: string, k2?: string) => { const m = new Map<number, T[]>(); const seen = new Set<string>(); for (const r of rs) { if (k2) { const id = `${r[k]}/${r[k2]}`; if (seen.has(id)) continue; seen.add(id); } const l = m.get(r[k] as number); if (l) l.push(r); else m.set(r[k] as number, [r]); } return m; };

export class PlaybookDb {
  readonly PBFM: Map<number, PlaybookRow>; // formation id -> name, FTYP
  readonly SETL: Map<number, PlaybookRow>; // set id -> name
  readonly SETP: Map<number, PlaybookRow[]>; // set id -> slots (poso, EPos, DPos, SETP)
  readonly SETG: Map<number, PlaybookRow[]>; // SETP slot id -> coordinates per sub-formation (SGF_, x___, y___)
  readonly SGFF: Map<number, PlaybookRow[]>; // set id -> sub-formations (SGF_, dflt)
  readonly PBPL: Map<number, PlaybookRow>; // play id -> name, PLYT, SITT, PLF_, vpos
  readonly PLYS: Map<number, PlaybookRow[]>; // play id -> per-slot assignments (poso, PSAL, PLRR, ARTL)
  readonly PSLO: Map<number, PlaybookRow[]>; // program id -> offense steps (misc)
  readonly PSLD: Map<number, PlaybookRow[]>; // program id -> defense steps (misc)
  readonly PSAL: Map<number, PlaybookRow[]>; // program id -> steps (boot)
  readonly ARTO: Map<number, PlaybookRow>; // art id -> offense art (misc ARTO, boot ARTL)
  readonly ARTD: Map<number, PlaybookRow>; // art id -> defense art
  readonly PLPD: Map<number, PlaybookRow>; // play id -> progression (per1..5, rcv1..5)
  readonly PLRD: Map<number, PlaybookRow>; // play id -> run hole
  readonly PGFM: Map<number, PlaybookRow[]>; // book -> formations (PBFM, ord_)
  readonly STID: Map<number, PlaybookRow[]>; // book -> sets (PBFM, SETL)
  readonly PGPL: Map<number, PlaybookRow[]>; // book -> plays (SETL, PLYL, ord_)
  readonly PBA: Map<number, PlaybookRow[]>; // book -> AI weights (PLYL, AIGR, prct); PBA1..4 are split by book ranges
  readonly BSMO: PlaybookRow[]; // special sets shared by every book (field goal, kneel, spike, returns)
  readonly DPSF: Map<number, PlaybookRow[]>; // special set -> its plays (PLYL)

  constructor(misc: TdbFile, boot: TdbFile);
  constructor(book: TdbFile, bokl: number, shared?: SharedPlaybookData);
  constructor(misc: TdbFile, bootOrBokl: TdbFile | number, shared: SharedPlaybookData = {}) {
    if (typeof bootOrBokl === 'number') {
      // one compiled book: its own tables first, the boot base DB behind them (same merge rule as the master path)
      const book = misc, bokl = bootOrBokl, base = shared.boot;
      this.PBFM = byKey(rows(book, 'PBFM'), 'PBFM');
      this.SETL = byKey([...rows(book, 'SETL'), ...rows(base, 'SETL')], 'SETL');
      this.SETP = group([...rows(book, 'SETP'), ...rows(base, 'SETP')], 'SETL', 'poso');
      this.SETG = group([...rows(book, 'SETG'), ...rows(base, 'SETG')], 'SETP', 'SGF_');
      this.SGFF = group([...rows(book, sgfName(book)), ...rows(base, sgfName(base))], 'SETL', 'SGF_');
      this.PBPL = byKey([...rows(book, 'PLYL'), ...rows(base, 'PLYL')], 'PLYL'); // play info (name, PLYT, SITT, PLF_, vpos) is the PLYL table here
      this.PLYS = group([...rows(book, 'PLYS'), ...rows(base, 'PLYS')], 'PLYL', 'poso');
      this.PSLO = new Map(); this.PSLD = new Map(); this.PSAL = group([...rows(book, 'PSAL'), ...rows(base, 'PSAL')], 'PSAL', 'step');
      this.ARTO = byKey([...rows(book, 'ARTL'), ...rows(base, 'ARTL')], 'ARTL'); this.ARTD = new Map();
      this.PLPD = byKey([...rows(book, 'PLPD'), ...rows(base, 'PLPD')], 'PLYL'); this.PLRD = byKey([...rows(book, 'PLRD'), ...rows(base, 'PLRD')], 'PLYL');
      const pbst = byKey(rows(book, 'PBST'), 'PBST'), list = rows(book, 'PBPL');
      // the game's menu order: formations by type group (FTYP 1 formations, 2 kickoff, 3 punt, 4 packages) then ord_
      // within the group; sets by PBST.ord_ within their formation
      this.PGFM = new Map([[bokl, rows(book, 'PBFM').map((r) => ({ BOKL: bokl, PBFM: r.PBFM!, FTYP: r.FTYP!, ord_: (r.FTYP as number) * 100 + (r.ord_ as number) }))]]);
      this.STID = new Map([[bokl, rows(book, 'PBST').filter((r) => r.SETL !== 0).sort((a, b) => (a.ord_ as number) - (b.ord_ as number)).map((r) => ({ BOKL: bokl, PBFM: r.PBFM!, SETL: r.SETL!, PBST: r.PBST!, ord_: r.ord_! }))]]); // SETL 0 rows are package subs (RB, WR1...), not sets
      this.PGPL = new Map([[bokl, list.map((r) => ({ BOKL: bokl, SETL: (pbst.get(r.PBST as number)?.SETL as number | undefined) ?? 0, PLYL: r.PLYL!, ord_: r.ord_!, PBST: r.PBST!, Flag: r.Flag! }))]]);
      const plylOf = new Map(list.map((r) => [r.PBPL as number, r.PLYL as number]));
      this.PBA = new Map([[bokl, rows(book, 'PBAI').map((r) => ({ BOKL: bokl, PLYL: plylOf.get(r.PBPL as number) ?? -1, AIGR: r.AIGR!, prct: r.prct! }))]]);
      this.BSMO = rows(shared.master, 'BSMO'); this.DPSF = group(rows(shared.master, 'DPSF'), 'SETL'); // the shared special sets (field goal, kneel, spike, fakes) come from the master's list
      return;
    }
    const boot = bootOrBokl;
    this.PBFM = byKey([...rows(misc, 'PBFM'), ...rows(boot, 'PBFM')], 'PBFM');
    this.SETL = byKey([...rows(misc, 'SETL'), ...rows(boot, 'SETL')], 'SETL');
    this.SETP = group([...rows(misc, 'SETP'), ...rows(boot, 'SETP')], 'SETL', 'poso');
    this.SETG = group([...rows(misc, 'SETG'), ...rows(boot, 'SETG')], 'SETP', 'SGF_');
    this.SGFF = group([...rows(misc, 'SGFF'), ...rows(boot, sgfName(boot))], 'SETL', 'SGF_');
    this.PBPL = byKey([...rows(misc, 'PBPL'), ...rows(boot, 'PLYL')], 'PLYL'); // boot keeps play info in PLYL
    this.PLYS = group([...rows(misc, 'PLYS'), ...rows(boot, 'PLYS')], 'PLYL', 'poso');
    this.PSLO = group(rows(misc, 'PSLO'), 'PSAL'); this.PSLD = group(rows(misc, 'PSLD'), 'PSAL'); this.PSAL = group(rows(boot, 'PSAL'), 'PSAL');
    this.ARTO = byKey([...rows(misc, 'ARTO'), ...rows(boot, 'ARTL')], 'ARTL'); this.ARTD = byKey(rows(misc, 'ARTD'), 'ARTL');
    this.PLPD = byKey([...rows(misc, 'PLPD'), ...rows(boot, 'PLPD')], 'PLYL'); this.PLRD = byKey([...rows(misc, 'PLRD'), ...rows(boot, 'PLRD')], 'PLYL');
    this.PGFM = group(rows(misc, 'PGFM'), 'BOKL'); this.STID = group(rows(misc, 'STID'), 'BOKL'); this.PGPL = group(rows(misc, 'PGPL'), 'BOKL');
    this.PBA = group([...rows(misc, 'PBA1'), ...rows(misc, 'PBA2'), ...rows(misc, 'PBA3'), ...rows(misc, 'PBA4')], 'BOKL');
    this.BSMO = rows(misc, 'BSMO'); this.DPSF = group(rows(misc, 'DPSF'), 'SETL');
  }

  // every book id (BOKL) that has plays, in PGPL order
  books(): number[] { return [...this.PGPL.keys()]; }

  // the step program behind a PLYS.PSAL id, in step order: misc offense, then misc defense, then the boot base
  steps(psal: number): PlaybookRow[] { return (this.PSLO.get(psal) ?? this.PSLD.get(psal) ?? this.PSAL.get(psal) ?? []).slice().sort((a, b) => (a.step as number) - (b.step as number)); }
}
