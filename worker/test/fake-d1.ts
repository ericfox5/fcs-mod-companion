// A tiny in-memory stand-in for D1 covering the SQL the Supersim handler runs (routes.ts and the db/queries.ts
// helpers it calls): SELECT / INSERT / UPDATE / DELETE over one table with `col = ?` AND-chains (one level of OR in
// parentheses), literal comparisons, IS NULL, json_extract columns, ORDER BY, the supersim_schedule view, the
// final's INSERT ... SELECT and the web_* edit tables' upsert (INSERT ... ON CONFLICT DO UPDATE SET, autoincrement ids).
// Anything else throws, so a new statement in the handler is noticed by the tests.
export type Row = Record<string, unknown>;
export interface FakeTables { [table: string]: Row[] }
const KEYS: Record<string, string[]> = { supersim_live: ['dynasty_id', 'season_year', 'week', 'game_no'], supersim_games: ['dynasty_id', 'season_year', 'week', 'game_no'] };
const DEFAULTS: Record<string, () => Row> = {
  supersim_live: () => ({ status: 'live', version: 1, created_at: now(), updated_at: now() }),
  supersim_games: () => ({ status: 'pending', created_at: now(), accepted_at: null, synced_at: null, receipt_json: null }),
};
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

export class FakeD1 {
  log: string[] = [];
  constructor(public tables: FakeTables = {}) {}
  prepare(sql: string) { return new FakeStmt(this, sql.replace(/\s+/g, ' ').trim()); }
  batch(stmts: FakeStmt[]) { return Promise.all(stmts.map((s) => s.run())); }
  table(name: string): Row[] { return (this.tables[name] ??= []); }
  nextId(name: string): number { return Math.max(0, ...this.table(name).map((r) => Number(r.id) || 0)) + 1; } // AUTOINCREMENT (ids of deleted rows may be reused here)
  // the supersim_schedule view: games with an official Supersim result laid over them (migration 0017)
  view(name: string): Row[] {
    if (name !== 'supersim_schedule') return this.table(name);
    return this.table('games').map((g) => {
      const s = this.table('supersim_games').find((r) => KEYS.supersim_games!.every((k) => r[k] === g[k]));
      if (!s || (Number(g.status) >= 2)) return { ...g };
      const res = JSON.parse(String(s.result_json)) as { winner: number | null; score: [number, number]; overtime: number };
      return { ...g, status: res.winner === 1 ? 3 : 2, home_score: res.score[1], away_score: res.score[0], overtime: res.overtime > 0 ? 1 : 0, user_played: 1, source: 'supersim' };
    });
  }
}

// split on a separator at parenthesis depth 0
function splitTop(s: string, sep: string): string[] {
  const out: string[] = []; let depth = 0, start = 0, quote = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!; if (c === "'") quote = !quote; if (quote) continue;
    if (c === '(') depth++; else if (c === ')') depth--;
    else if (depth === 0 && s.startsWith(sep, i)) { out.push(s.slice(start, i)); i += sep.length - 1; start = i + 1; }
  }
  out.push(s.slice(start)); return out;
}
const bare = (col: string) => col.replace(/^\w+\./, '');
const cmp = (a: unknown, op: string, b: unknown): boolean => {
  if (a == null || b == null) return false;
  switch (op) { case '=': return a === b || String(a) === String(b); case '<>': return a !== b; case '<': return (a as number) < (b as number); case '<=': return (a as number) <= (b as number); case '>': return (a as number) > (b as number); case '>=': return (a as number) >= (b as number); }
  throw new Error(`fake D1: operator ${op}`);
};
type Pred = (r: Row) => boolean;
function term(t: string, params: unknown[], pi: { i: number }): Pred {
  t = t.trim(); let m: RegExpExecArray | null;
  if (t.startsWith('(') && t.endsWith(')')) { const ps = splitTop(t.slice(1, -1), ' OR ').map((o) => term(o, params, pi)); return (r) => ps.some((p) => p(r)); }
  if ((m = /^([\w.]+)\s*(=|<>|<=|>=|<|>)\s*\?$/.exec(t))) { const col = bare(m[1]!), op = m[2]!, v = params[pi.i++]; return (r) => cmp(r[col], op, v); }
  if ((m = /^([\w.]+)\s*(=|<>|<=|>=|<|>)\s*('[^']*'|-?\d+)$/.exec(t))) { const col = bare(m[1]!), op = m[2]!; const v = m[3]!.startsWith("'") ? m[3]!.slice(1, -1) : Number(m[3]); return (r) => cmp(r[col], op, v); }
  if ((m = /^([\w.]+) IS NULL$/.exec(t))) { const col = bare(m[1]!); return (r) => r[col] == null; }
  if ((m = /^([\w.]+) IS NOT NULL$/.exec(t))) { const col = bare(m[1]!); return (r) => r[col] != null; }
  throw new Error(`fake D1: unsupported WHERE term "${t}"`);
}
const where = (clause: string | undefined, params: unknown[], pi: { i: number }): Pred => { if (!clause) return () => true; const ps = splitTop(clause, ' AND ').map((t) => term(t, params, pi)); return (r) => ps.every((p) => p(r)); };
// one item of a select list: *, col, col AS alias, json_extract(col,'$.a.b[0]') AS alias
type Col = { out: string; get: (r: Row) => unknown };
function column(item: string): Col | '*' {
  item = item.trim(); if (item === '*') return '*'; let m: RegExpExecArray | null;
  if ((m = /^json_extract\(\s*([\w.]+)\s*,\s*'\$\.([^']+)'\s*\)(?: AS (\w+))?$/i.exec(item))) {
    const col = bare(m[1]!); const path = m[2]!.split(/\.|\[|\]/).filter(Boolean).map((p) => (/^\d+$/.test(p) ? Number(p) : p)); const out = m[3] ?? item;
    return { out, get: (r) => { let v: unknown = JSON.parse(String(r[col] ?? 'null')); for (const p of path) { if (v == null) return null; v = (v as Record<string | number, unknown>)[p]; } return v ?? null; } };
  }
  if ((m = /^([\w.]+)(?: AS (\w+))?$/i.exec(item))) { const col = bare(m[1]!); return { out: m[2] ?? col, get: (r) => r[col] ?? null }; }
  throw new Error(`fake D1: unsupported select item "${item}"`);
}
function orderBy(spec: string | undefined, rows: Row[]): Row[] {
  if (!spec) return rows;
  const keys = spec.split(',').map((k) => { const [col, dir] = k.trim().split(/\s+/); return { col: bare(col!), desc: /desc/i.test(dir ?? '') }; });
  return [...rows].sort((a, b) => { for (const k of keys) { const x = a[k.col] as number | string, y = b[k.col] as number | string; if (x === y) continue; const c = x == null ? -1 : y == null ? 1 : x < y ? -1 : 1; return k.desc ? -c : c; } return 0; });
}

export class FakeStmt {
  private params: unknown[] = [];
  constructor(private db: FakeD1, private sql: string) {}
  bind(...p: unknown[]) { this.params = p; return this; }
  async first<T = Row>(col?: string): Promise<T | null> { const r = this.select()[0]; if (!r) return null; return (col ? r[col] : r) as T; }
  async all<T = Row>() { return { results: this.select() as T[], success: true as const, meta: { changes: 0 } }; }
  async run() { return { success: true as const, meta: { changes: this.write() } }; }
  async raw() { return this.select().map((r) => Object.values(r)); }

  private select(): Row[] {
    this.db.log.push(this.sql);
    const m = /^SELECT (.+?) FROM (\w+)(?: WHERE (.+?))?(?: ORDER BY (.+?))?(?: LIMIT (\d+|\?))?$/i.exec(this.sql);
    if (!m) throw new Error(`fake D1: unsupported statement "${this.sql}"`);
    const pi = { i: 0 }; const pred = where(m[3], this.params, pi);
    let rows = orderBy(m[4], this.db.view(m[2]!).filter(pred));
    if (m[5]) rows = rows.slice(0, m[5] === '?' ? Number(this.params[pi.i++]) : Number(m[5]));
    const cols = splitTop(m[1]!, ',').map(column);
    if (cols.length === 1 && cols[0] === '*') return rows.map((r) => ({ ...r }));
    return rows.map((r) => { const out: Row = {}; for (const c of cols) { if (c === '*') Object.assign(out, r); else out[c.out] = c.get(r); } return out; });
  }
  private write(): number {
    this.db.log.push(this.sql); const sql = this.sql; let m: RegExpExecArray | null;
    if ((m = /^INSERT INTO supersim_games\((.+?)\) SELECT /i.exec(sql))) return this.insertFinal();
    // INSERT [OR IGNORE] INTO t (cols) VALUES (?, 'lit', NULL, datetime('now'), ...) [ON CONFLICT(keys) DO UPDATE SET col = excluded.col | datetime('now') | NULL | ?]
    if ((m = /^INSERT( OR IGNORE)? INTO (\w+)\s*\(([^)]*)\)\s*VALUES\s*\((.+?)\)(?: ON CONFLICT\s*\(([^)]*)\)\s*DO UPDATE SET (.+))?$/i.exec(sql))) {
      const table = m[2]!, cols = m[3]!.split(',').map((c) => c.trim()); const vals = splitTop(m[4]!, ',').map((v) => v.trim()); let pi = 0;
      const lit = (v: string): unknown => (v === '?' ? this.params[pi++] : v.startsWith("'") ? v.slice(1, -1) : v === 'NULL' ? null : /^datetime\('now'\)$/i.test(v) ? now() : Number(v));
      const row: Row = { ...(DEFAULTS[table]?.() ?? {}) };
      cols.forEach((c, i) => { row[c] = lit(vals[i]!); });
      const keys = m[5] ? m[5].split(',').map((k) => k.trim()) : KEYS[table]; const rows = this.db.table(table);
      const dup = keys ? rows.find((r) => keys.every((k) => r[k] === row[k])) : undefined;
      if (dup) {
        if (m[1]) return 0;
        if (!m[6]) throw new Error(`fake D1: UNIQUE constraint failed: ${table}`);
        for (const a of splitTop(m[6], ',')) { const [col, expr] = a.split('=').map((s) => s.trim()) as [string, string]; const ex = /^excluded\.(\w+)$/i.exec(expr); if (ex) dup[col] = row[ex[1]!]; else if (/^datetime\('now'\)$/i.test(expr)) dup[col] = now(); else if (expr === 'NULL') dup[col] = null; else if (expr === '?') dup[col] = this.params[pi++]; else throw new Error(`fake D1: unsupported upsert SET "${a}"`); }
        return 1;
      }
      if (table.startsWith('web_') && row.id === undefined) row.id = this.db.nextId(table);
      rows.push(row); return 1;
    }
    if ((m = /^UPDATE (\w+) SET (.+?) WHERE (.+)$/i.exec(sql))) {
      const pi = { i: 0 }; const sets = splitTop(m[2]!, ',').map((a) => { const [col, expr] = a.split('=').map((s) => s.trim()) as [string, string]; if (expr === '?') { const v = this.params[pi.i++]; return (r: Row) => { r[col] = v; }; } if (expr === `${col}+1`) return (r: Row) => { r[col] = Number(r[col]) + 1; }; if (/^CURRENT_TIMESTAMP$|^datetime\('now'\)$/i.test(expr)) return (r: Row) => { r[col] = now(); }; if (expr === 'NULL') return (r: Row) => { r[col] = null; }; throw new Error(`fake D1: unsupported SET "${a}"`); });
      const pred = where(m[3], this.params, pi); let n = 0;
      for (const r of this.db.table(m[1]!)) if (pred(r)) { for (const s of sets) s(r); n++; }
      return n;
    }
    if ((m = /^DELETE FROM (\w+) WHERE (.+)$/i.exec(sql))) {
      const pred = where(m[2], this.params, { i: 0 }); const rows = this.db.table(m[1]!); const keep = rows.filter((r) => !pred(r)); const n = rows.length - keep.length; rows.splice(0, rows.length, ...keep); return n;
    }
    throw new Error(`fake D1: unsupported statement "${sql}"`);
  }
  // the official result (routes.ts): INSERT INTO supersim_games(...) SELECT ?,d.id,d.season_year,d.week,g.game_no,?,?,?,g.home_tgid,g.away_tgid,?,?,?,?
  // FROM dynasties d JOIN games g ... WHERE d.id=? AND d.season_year=? AND d.week=? AND g.game_no=? AND g.status<2 AND g.home_tgid=? AND g.away_tgid=? ON CONFLICT DO NOTHING
  private insertFinal(): number {
    const [id, snapshot_id, blaze_id, owned_tgid, seed, input_json, result_json, envelope_json, dynId, year, week, gameNo, home, away] = this.params;
    const d = this.db.table('dynasties').find((r) => r.id === dynId && r.season_year === year && r.week === week); if (!d) return 0;
    const g = this.db.table('games').find((r) => r.dynasty_id === d.id && r.season_year === d.season_year && r.week === d.week && r.game_no === gameNo && Number(r.status) < 2 && r.home_tgid === home && r.away_tgid === away); if (!g) return 0;
    const rows = this.db.table('supersim_games');
    if (rows.some((r) => r.dynasty_id === d.id && r.season_year === d.season_year && r.week === d.week && r.game_no === gameNo)) return 0;
    rows.push({ ...DEFAULTS.supersim_games!(), id, dynasty_id: d.id, season_year: d.season_year, week: d.week, game_no: gameNo, snapshot_id, blaze_id, owned_tgid, home_tgid: g.home_tgid, away_tgid: g.away_tgid, seed, input_json, result_json, envelope_json });
    return 1;
  }
}
