// A team's playbook edits on the companion site, and how they turn into a Book the engine can use.
//
// A team starts from a stock book (edits.base) and changes what it holds: formations in order (its own, or ones taken
// from another stock book: `from`), each formation's sets, each set's plays in order. Anything left out is dropped.
// Custom plays drawn on the site are "c<n>" entries (custom[cid]); compiling them into assignments is the play creator's
// job (playbook/compile.ts), handed in through `custom` of composeBook so this file stays free of the step language.
// The same edits are later written into the game's own playbook database by the bridge (private book per team), and
// the bridge proves the written book re-extracts to exactly what composeBook returns.
import type { Assign, Book, Formation, Play, SetDef, Slot } from './types.js';

export type PlayRef = number | string; // a stock PLYL, or "c<n>" for a custom play of this book
export interface SetEdit { id: number; plays: PlayRef[] }
export interface FormationEdit { id: number; from?: number; sets: SetEdit[] } // from: the stock book it was taken from when it is not in the base
// one slot of a drawn play: kind + path in yards from the slot's alignment [x right, y downfield] + creator options
export interface SlotDraw { k: string; p?: number[][]; o?: Record<string, number> }
export interface DrawnPlay { n: string; t: number; set: number; slots: SlotDraw[]; sit?: number; f?: number; v?: number; prog?: number[][]; h?: number }
export interface BookEdits { v: 1; base: number; name: string; formations: FormationEdit[]; custom: Record<string, DrawnPlay> }

// the stock envelope: the biggest stock books (PGFM 15, STID 41, PGPL 419); a play name is 24 latin1 characters in the
// per-book DBs the game plays from (PBPL.name / PLYL.name, 192 bits; the master DB's 31 do not reach the field)
export const LIMITS = { formations: 15, sets: 41, plays: 419, nameChars: 24 } as const;
export const CUSTOM_ID_BASE = 30000; // composed custom plays get ids above every stock PLYL (max 20526) and inside the game's u15 PLYL field
export const isCustomRef = (r: PlayRef): r is string => typeof r === 'string' && /^c\d+$/.test(r);

// the books composeBook needs loaded: the base and every `from`
export const booksNeeded = (e: BookEdits): number[] => [...new Set([e.base, ...e.formations.map((f) => f.from).filter((b): b is number => typeof b === 'number')])];

// the edits that reproduce a stock book unchanged: the editor's starting point
export function stockEdits(base: Book): BookEdits {
  return { v: 1, base: base.id, name: base.name, formations: base.formations.map((f) => ({ id: f.id, sets: f.sets.map((s) => ({ id: s.id, plays: [...s.plays] })) })), custom: {} };
}

export interface ComposeOptions {
  // a compiled custom play for a cid: the play's assignments (one per slot) and type fields; absent = the play is dropped
  custom?: (cid: string, draw: DrawnPlay, set: SetDef) => { play: Omit<Play, 'id' | 'a'>; asg: Assign[] } | null;
}

// Problems that make edits unusable (ids that exist nowhere, a set listed under a formation that does not hold it, the
// envelope exceeded). Warnings are not here: a play missing from a set is simply not in the book.
export function validateEdits(e: BookEdits, books: Map<number, Book>): string[] {
  const out: string[] = [];
  if (e.v !== 1) out.push(`unknown edits version ${String(e.v)}`);
  if (!books.has(e.base)) out.push(`base book ${e.base} is not loaded`);
  if (typeof e.name !== 'string' || !e.name.trim()) out.push('the book needs a name'); else if (e.name.length > LIMITS.nameChars) out.push(`name longer than ${LIMITS.nameChars} characters`);
  if (e.formations.length > LIMITS.formations) out.push(`${e.formations.length} formations (limit ${LIMITS.formations})`);
  let sets = 0, plays = 0; const seenF = new Set<number>();
  for (const f of e.formations) {
    if (seenF.has(f.id)) out.push(`formation ${f.id} listed twice`); seenF.add(f.id);
    const src = books.get(f.from ?? e.base); if (!src) { out.push(`book ${f.from} for formation ${f.id} is not loaded`); continue; }
    const form = src.formations.find((x) => x.id === f.id); if (!form) { out.push(`formation ${f.id} is not in book ${src.id}`); continue; }
    const seenS = new Set<number>();
    for (const s of f.sets) {
      if (seenS.has(s.id)) out.push(`set ${s.id} listed twice in formation ${f.id}`); seenS.add(s.id);
      const set = form.sets.find((x) => x.id === s.id); if (!set) { out.push(`set ${s.id} is not in formation ${f.id} of book ${src.id}`); continue; }
      sets++; plays += s.plays.length;
      for (const r of s.plays) {
        if (isCustomRef(r)) { const d = e.custom[r]; if (!d) out.push(`custom play ${r} has no drawing`); else if (d.set !== s.id) out.push(`custom play ${r} belongs to set ${d.set}, listed in ${s.id}`); }
        else if (!Number.isInteger(r) || !findPlay(books, r as number)) out.push(`play ${String(r)} exists in no loaded book`);
      }
    }
  }
  if (sets > LIMITS.sets) out.push(`${sets} sets (limit ${LIMITS.sets})`);
  if (plays > LIMITS.plays) out.push(`${plays} plays (limit ${LIMITS.plays})`);
  return out;
}

// a stock play by id: the base's copy first, then any loaded book's (the id is the same everywhere)
function findPlay(books: Map<number, Book>, id: number, prefer?: Book): { book: Book; play: Play } | null {
  if (prefer?.plays[String(id)]) return { book: prefer, play: prefer.plays[String(id)]! };
  for (const b of books.values()) { const p = b.plays[String(id)]; if (p) return { book: b, play: p }; }
  return null;
}

// Compose the edited book. Assignments are re-interned into one list (identical entries shared); every formation / set
// keeps its id and slots; `ai` keeps the source books' weights for the plays that made it in.
export function composeBook(e: BookEdits, books: Map<number, Book>, opts: ComposeOptions = {}): Book {
  const problems = validateEdits(e, books); if (problems.length) throw new Error(`playbook edits: ${problems.join('; ')}`);
  const base = books.get(e.base)!;
  const asg: Assign[] = [], asgIndex = new Map<string, number>();
  const intern = (a: Assign): number => { const k = JSON.stringify(a); let i = asgIndex.get(k); if (i === undefined) { i = asg.length; asg.push(a); asgIndex.set(k, i); } return i; };
  const plays: Record<string, Play> = {}, ai: Record<string, number[][]> = {};
  const formations: Formation[] = [];
  let nextCustom = CUSTOM_ID_BASE; const customIds = new Map<string, number>();
  for (const f of e.formations) {
    const src = books.get(f.from ?? e.base)!, form = src.formations.find((x) => x.id === f.id)!;
    const sets: SetDef[] = [];
    for (const s of f.sets) {
      const set = form.sets.find((x) => x.id === s.id)!;
      const ids: number[] = [];
      for (const r of s.plays) {
        if (isCustomRef(r)) {
          const built = opts.custom?.(r, e.custom[r]!, set); if (!built) continue;
          let id = customIds.get(r); if (id === undefined) { id = nextCustom++; customIds.set(r, id); plays[String(id)] = { ...built.play, id, a: built.asg.map(intern) }; }
          ids.push(id); continue;
        }
        const found = findPlay(books, r as number, src)!; const id = found.play.id;
        if (!plays[String(id)]) {
          plays[String(id)] = { ...found.play, a: found.play.a.map((i) => (i >= 0 && found.book.asg[i] ? intern(found.book.asg[i]!) : -1)) };
          for (const [grp, rows] of Object.entries(found.book.ai)) for (const row of rows) if (row[0] === id) (ai[grp] ??= []).push([id, row[1]!]);
        }
        if (!ids.includes(id)) ids.push(id);
      }
      sets.push({ id: set.id, n: set.n, slots: set.slots.map((sl): Slot => ({ ...sl })), plays: ids });
    }
    formations.push({ id: form.id, n: form.n, t: form.t, sets });
  }
  return { id: base.id, bgid: base.bgid, side: base.side, name: e.name, formations, plays, asg, ai };
}

// Which stock sets can take a play: the same set id in any loaded book (plays are drawn for one set's slots).
export function playsForSet(books: Map<number, Book>, setl: number): { book: Book; play: Play }[] {
  const out: { book: Book; play: Play }[] = [], seen = new Set<number>();
  for (const b of books.values()) for (const f of b.formations) for (const s of f.sets) if (s.id === setl) for (const id of s.plays) { const p = b.plays[String(id)]; if (p && !seen.has(id)) { seen.add(id); out.push({ book: b, play: p }); } }
  return out;
}
