// A D1 stand-in backed by Node's built-in SQLite (node:sqlite), with the real schema: every file in worker/migrations
// is applied in order, so the tests run the same SQL, constraints and collations production does. Covers the part of
// the D1 API the Worker uses: prepare / bind / first / all / run / raw, and batch as one transaction.
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';

const MIGRATIONS = new URL('../migrations/', import.meta.url);
export const migrationFiles = () => readdirSync(MIGRATIONS).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
export const migrationText = (file: string) => readFileSync(new URL(file, MIGRATIONS), 'utf8');

type Param = string | number | bigint | null | Uint8Array;
const toParam = (v: unknown): Param => {
  if (v === undefined) throw new Error('D1_TYPE_ERROR: undefined is not a bindable value');
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v as Param;
};

class Stmt {
  constructor(private db: DatabaseSync, private sql: string, private params: Param[] = []) {}
  bind(...p: unknown[]) { return new Stmt(this.db, this.sql, p.map(toParam)); }
  runSync() { const r = this.db.prepare(this.sql).run(...this.params); return { success: true as const, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; }
  async first<T = Record<string, unknown>>(col?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (col ? row[col] : { ...row }) as T;
  }
  async all<T = Record<string, unknown>>() { return { success: true as const, results: this.db.prepare(this.sql).all(...this.params).map((r) => ({ ...r })) as T[], meta: { changes: 0, last_row_id: 0 } }; }
  async run() { return this.runSync(); }
  async raw() { return this.db.prepare(this.sql).all(...this.params).map((r) => Object.values(r as object)); }
}

export class SqliteD1 {
  readonly sqlite = new DatabaseSync(':memory:');
  constructor() { for (const f of migrationFiles()) this.sqlite.exec(migrationText(f)); }
  prepare(sql: string) { return new Stmt(this.sqlite, sql); }
  async batch(stmts: Stmt[]) {
    this.sqlite.exec('BEGIN');
    try { const out = stmts.map((s) => s.runSync()); this.sqlite.exec('COMMIT'); return out; }
    catch (e) { this.sqlite.exec('ROLLBACK'); throw e; }
  }
  // test conveniences
  rows<T = Record<string, unknown>>(sql: string, ...params: Param[]): T[] { return this.sqlite.prepare(sql).all(...params).map((r) => ({ ...r })) as T[]; }
  exec(sql: string) { this.sqlite.exec(sql); }
  tables(): string[] { return this.rows<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").map((r) => r.name); }
}
export const asD1 = (db: SqliteD1) => db as unknown as D1Database;
