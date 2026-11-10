// Playbook edits over HTTP (pages/playbook-edit.ts): the request body is rebuilt field by field, the composed-book JSON
// falls back to the stock book, saving is gated (same origin, membership, the team) and validated against the stock
// books, a save changes what the .json serves and what Supersim's loadTeamBook composes, the bridge's web-edits ack marks
// the row delivered, and a reset puts the stock book back. Drives the handlers against an in-memory D1 (fake-d1.ts) and
// the real playbooks (the book-dependent tests are skipped when they are absent: run `npx tsx tools/playbooks-extract.mts`).
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { parseEditsBody, parseSide, playbookJsonUrl, playbookBookJson, playbookEditAction, MAX_EDITS_BODY } from '../src/pages/playbook-edit.js';
import { handleBridge } from '../src/api/bridge.js';
import { loadTeamBook } from '../src/supersim/coach/books.js';
import { listPlaybookEditTeams, listPendingPlaybookEdits, type Dynasty, type MemberRow } from '../src/db/queries.js';
import type { PageCtx } from '../src/index.js';
import type { Env } from '../src/env.js';
import type { Book, BookIndex } from '../src/supersim/coach/types.js';
import { stockEdits, type BookEdits } from '@ncaa/ncaa14';
import { FakeD1, type Row } from './fake-d1.js';

const dir = new URL('../public/data/playbooks/', import.meta.url);
const have = existsSync(new URL('index.json', dir));
const ORIGIN = 'https://league.test';
const TOKEN = 'bridge-token-for-the-tests';
const DYN = { id: 1, slug: 'test', name: 'Test League', season_year: 2025, week: 3, stage: 0, week_type: 0, current_snapshot_id: 1, updated_at: null, od_id: 77, abbr: 'TL', description: null, state: 1, od_file_id: 1, od_file_saved_at: null, od_created_at: null, settings_json: '{}' } as unknown as Dynasty;
const member = (blaze_id: number, persona: string, tgid: number, extra: Partial<MemberRow> = {}): MemberRow & Row => ({ dynasty_id: 1, blaze_id, persona, ncid: 0, tgid, ccid: 0, commissioner: 0, team_file_id: 0, web_only: 0, ...extra } as MemberRow & Row);
const alice = member(101, 'Alice', 1, { commissioner: 1 }), bob = member(102, 'Bob', 2);
const teamRow = (tgid: number, name: string, raw: Record<string, number>): Row => ({ dynasty_id: 1, tgid, snapshot_id: 1, name, long_name: name, mascot: 'Bears', abbr: name.slice(0, 3).toUpperCase(), conf_label: '', cgid: 0, dgid: 0, team_type: 0, asset_slot: '', stadium_id: 0, wins: 0, losses: 0, conf_wins: 0, conf_losses: 0, streak: 0, rank_bcs: 0, rank_coaches: 0, rank_media: 0, prestige: 3, overall: 70, logo_key: null, raw_json: JSON.stringify(raw) });
const assets = { fetch: async (req: Request) => { const path = new URL(req.url).pathname; const file = new URL(path.slice('/data/playbooks/'.length), dir); if (!path.startsWith('/data/playbooks/') || !existsSync(file)) return new Response('not found', { status: 404 }); return new Response(readFileSync(file), { headers: { 'content-type': 'application/json' } }); } };
const readBook = (id: number): Book => JSON.parse(readFileSync(new URL(`${id}.json`, dir), 'utf8')) as Book;

// a well-formed save body: one formation of one set with one stock play
const sample = (over: Record<string, unknown> = {}) => ({ edits: { v: 1, base: 115, name: 'Mine', formations: [{ id: 5, sets: [{ id: 9, plays: [101, 'c1'] }] }], custom: { c1: { n: 'Drawn', t: 1, set: 9, slots: [{ k: 'route', p: [[0, 5], [3, 12]] }] } }, ...over } });

describe('playbook edit requests: the pure parts', () => {
  it('parses sides and builds the composed-book URL', () => {
    expect(parseSide('off')).toBe('off'); expect(parseSide('def')).toBe('def'); expect(parseSide('off.json')).toBeNull(); expect(parseSide(undefined)).toBeNull();
    expect(playbookJsonUrl('fcs-dynasty', 18, 'off')).toBe('/d/fcs-dynasty/playbook/18/off.json');
  });
  it('rebuilds the edits from the body, dropping unknown keys', () => {
    const r = parseEditsBody({ ...sample(), note: '  keep this  ', junk: 1 });
    expect(typeof r).not.toBe('string'); if (typeof r === 'string') return;
    expect(r.reset).toBe(false); if (r.reset) return;
    expect(r.note).toBe('keep this');
    expect(r.edits).toEqual({ v: 1, base: 115, name: 'Mine', formations: [{ id: 5, sets: [{ id: 9, plays: [101, 'c1'] }] }], custom: { c1: { n: 'Drawn', t: 1, set: 9, slots: [{ k: 'route', p: [[0, 5], [3, 12]] }] } } });
    expect(Object.keys(r.edits)).toEqual(['v', 'base', 'name', 'formations', 'custom']);
    const from = parseEditsBody(sample({ formations: [{ id: 5, from: 148, sets: [], extra: true }], custom: undefined })) as { edits: BookEdits };
    expect(from.edits.formations).toEqual([{ id: 5, from: 148, sets: [] }]); expect(from.edits.custom).toEqual({});
    expect(parseEditsBody({ reset: true })).toEqual({ reset: true });
    expect((parseEditsBody({ ...sample(), note: 'x'.repeat(500) }) as { note: string }).note).toHaveLength(200);
  });
  it('names what is wrong with a body', () => {
    expect(parseEditsBody(null)).toMatch(/JSON object/); expect(parseEditsBody([])).toMatch(/JSON object/); expect(parseEditsBody({})).toMatch(/edits missing/);
    expect(parseEditsBody(sample({ v: 2 }))).toMatch(/version/); expect(parseEditsBody(sample({ base: '115' }))).toMatch(/base/); expect(parseEditsBody(sample({ name: 5 }))).toMatch(/name/);
    expect(parseEditsBody(sample({ formations: Array.from({ length: 16 }, (_, i) => ({ id: i, sets: [] })) }))).toMatch(/at most 15/);
    expect(parseEditsBody(sample({ formations: [{ id: 5 }] }))).toMatch(/formation needs/); expect(parseEditsBody(sample({ formations: [{ id: 5, from: 'x', sets: [] }] }))).toMatch(/from must be/);
    expect(parseEditsBody(sample({ formations: [{ id: 5, sets: [{ id: 9, plays: ['x1'] }] }] }))).toMatch(/plays must be/); expect(parseEditsBody(sample({ formations: [{ id: 5, sets: [{ id: 9, plays: [1.5] }] }] }))).toMatch(/plays must be/);
    expect(parseEditsBody(sample({ custom: [] }))).toMatch(/custom must be/); expect(parseEditsBody(sample({ custom: { x1: { n: 'a', t: 1, set: 9, slots: [] } } }))).toMatch(/not c<n>/);
    expect(parseEditsBody(sample({ custom: { c1: { n: 'a', t: 1, set: 9 } } }))).toMatch(/custom play c1 needs/); expect(parseEditsBody(sample({ custom: { c1: { n: 'a', t: 1, set: 9, slots: [{}] } } }))).toMatch(/needs a kind/);
    expect(parseEditsBody(sample({ custom: { c1: { n: 'a', t: 1, set: 9, slots: [{ k: 'route', p: [[1]] }] } } }))).toMatch(/path/); expect(parseEditsBody(sample({ custom: { c1: { n: 'a', t: 1, set: 9, slots: [], sit: 'x' } } }))).toMatch(/sit must be/);
  });
});

describe.skipIf(!have)('playbook edits over HTTP against the real books', () => {
  const index = have ? (JSON.parse(readFileSync(new URL('index.json', dir), 'utf8')) as BookIndex) : { generated: '', books: [] };
  // team 1's stock books: an offense book with formations to drop and a defense book, both named by bgid as TEAM.TOPB / TDPB are
  const offStock = index.books.find((b) => b.side === 'off' && b.name !== 'Multiple' && b.formations.length >= 3)!, defStock = index.books.find((b) => b.side === 'def' && b.name !== '4-3')!;
  const otherOff = index.books.find((b) => b.side === 'off' && b.id !== offStock?.id && b.formations.length >= 2)!;
  const db = new FakeD1({ dynasties: [{ ...(DYN as unknown as Row) }], od_members: [alice, bob], teams: [teamRow(1, 'Alder', { TOPB: offStock?.bgid ?? 0, TDPB: defStock?.bgid ?? 0 }), teamRow(2, 'Birch', {})] });
  const env = { DB: db as unknown as D1Database, ASSETS: assets as unknown as Fetcher, SITE_NAME: 't', BASE_YEAR: '2013', BRIDGE_TOKEN: TOKEN } as unknown as Env;
  const ctx = (who: MemberRow | null, req: Request, o: { locked?: boolean; account?: boolean } = {}): PageCtx => ({ env, dyn: DYN, url: new URL(req.url), req, member: who, members: [alice, bob], account: o.account ? { id: 1, username: 'who', blazeId: who?.blaze_id ?? null } : null, locked: o.locked ?? false });
  const getJson = async (tgid: number, side: string) => { const req = new Request(`${ORIGIN}/d/test/playbook/${tgid}/${side}.json`); const res = await playbookBookJson(ctx(null, req), tgid, side); return { status: res.status, kind: res.headers.get('x-playbook'), cache: res.headers.get('cache-control'), book: res.status === 200 ? ((await res.json()) as Book) : null }; };
  const JSON_HEADERS = { origin: ORIGIN, 'content-type': 'application/json' };
  const send = async (who: MemberRow | null, method: 'POST' | 'DELETE', tgid: number, side: string, body?: unknown, headers: Record<string, string> = JSON_HEADERS, o: { locked?: boolean; account?: boolean } = {}) => {
    const req = new Request(`${ORIGIN}/d/test/playbook/${tgid}/${side}`, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const res = await playbookEditAction(ctx(who, req, o), tgid, side); return { status: res.status, data: (await res.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const rows = () => db.table('web_playbook_edits');
  const team1 = { tgid: 1, raw_json: String(db.table('teams')[0]!.raw_json) };

  it('serves the stock book when nothing is saved, 404 for an unknown team or side', async () => {
    const off = await getJson(1, 'off'); expect(off.status).toBe(200); expect(off.kind).toBe('stock'); expect(off.cache).toBe('private, no-store'); expect(off.book!.id).toBe(offStock.id); expect(off.book!.side).toBe('off');
    const def = await getJson(1, 'def'); expect(def.book!.id).toBe(defStock.id); expect(def.book!.side).toBe('def');
    const dflt = await getJson(2, 'off'); expect(dflt.status).toBe(200); expect(dflt.book!.name).toBe('Multiple'); // no TOPB: the fallback book
    expect((await getJson(99, 'off')).status).toBe(404); expect((await getJson(1, 'run')).status).toBe(404); expect((await getJson(300, 'off')).status).toBe(404);
  });
  it('gates saving: same origin, a member of the dynasty, the team\'s coach or a commissioner', async () => {
    const edits = stockEdits(readBook(offStock.id));
    expect((await send(alice, 'POST', 1, 'off', { edits }, { 'content-type': 'application/json' })).status).toBe(403); // no Origin
    expect((await send(alice, 'POST', 1, 'off', { edits }, { origin: ORIGIN })).status).toBe(403); // not JSON
    expect((await send(alice, 'POST', 1, 'off', { edits }, { origin: 'https://elsewhere.test', 'content-type': 'application/json' })).status).toBe(403);
    expect((await send(null, 'POST', 1, 'off', { edits })).status).toBe(403);
    expect((await send(null, 'POST', 1, 'off', { edits }, JSON_HEADERS, { locked: true })).status).toBe(401); // locked: sign in first
    expect((await send(null, 'POST', 1, 'off', { edits }, JSON_HEADERS, { locked: true, account: true })).status).toBe(403); // signed in, not a member
    const notHis = await send(bob, 'POST', 1, 'off', { edits }); expect(notHis.status).toBe(403); expect(notHis.data.error).toMatch(/own team/);
    expect((await send(alice, 'POST', 1, 'run', { edits })).status).toBe(404); expect((await send(alice, 'POST', 99, 'off', { edits })).status).toBe(404);
    expect((await send(alice, 'DELETE', 1, 'off', undefined, { origin: 'https://elsewhere.test' })).status).toBe(403);
    expect(rows()).toHaveLength(0);
  });
  it('rejects edits that do not validate, with the problems', async () => {
    expect((await send(alice, 'POST', 1, 'off', '{not json')).status).toBe(400);
    const shape = await send(alice, 'POST', 1, 'off', { edits: { v: 1 } }); expect(shape.status).toBe(400); expect(shape.data.error).toMatch(/base/);
    const side = await send(alice, 'POST', 1, 'off', { edits: stockEdits(readBook(defStock.id)) }); expect(side.status).toBe(400); expect(side.data.problems).toEqual([`book ${defStock.id} is not an offense book`]);
    const unknown = await send(alice, 'POST', 1, 'off', { edits: { ...stockEdits(readBook(offStock.id)), formations: [{ id: 999999, sets: [] }] } }); expect(unknown.status).toBe(400); expect(unknown.data.problems).toEqual([`formation 999999 is not in book ${offStock.id}`]);
    const missing = await send(alice, 'POST', 1, 'off', { edits: { ...stockEdits(readBook(offStock.id)), formations: [{ id: 1, from: 99999, sets: [] }] } }); expect(missing.status).toBe(400); expect(missing.data.problems).toEqual(['book 99999 is not an offense book']);
    const big = await send(alice, 'POST', 1, 'off', `{"edits":{"name":"${'x'.repeat(MAX_EDITS_BODY)}"}}`); expect(big.status).toBe(413);
    expect(rows()).toHaveLength(0);
  });
  it('saves, serves the composed book, lists the team, acks delivery, resets', async () => {
    const stock = readBook(offStock.id); const edits = stockEdits(stock);
    const dropped = edits.formations.pop()!; // one formation fewer than stock, one taken from another book
    const taken = readBook(otherOff.id).formations.find((f) => !stock.formations.some((x) => x.id === f.id))!;
    edits.formations.push({ id: taken.id, from: otherOff.id, sets: taken.sets.map((s) => ({ id: s.id, plays: [...s.plays] })) }); edits.name = 'Alder Spread';
    const saved = await send(alice, 'POST', 1, 'off', { edits, note: 'one formation out, one in' }); expect(saved.status, saved.data.error).toBe(200); expect(saved.data.ok).toBe(true); expect(typeof saved.data.updatedAt).toBe('string');
    expect(rows()).toHaveLength(1); const row = rows()[0]!; expect(row.id).toBe(1); expect(row.side).toBe('off'); expect(row.note).toBe('one formation out, one in'); expect(row.updated_by).toBe(101); expect(row.delivered_at).toBeNull();
    expect(JSON.parse(String(row.edits_json))).toEqual(edits);
    const got = await getJson(1, 'off'); expect(got.kind).toBe('custom'); expect(got.book!.name).toBe('Alder Spread'); expect(got.book!.id).toBe(offStock.id);
    expect(got.book!.formations.map((f) => f.id)).toEqual(edits.formations.map((f) => f.id)); expect(got.book!.formations.some((f) => f.id === dropped.id)).toBe(false);
    for (const id of taken.sets.flatMap((s) => s.plays)) expect(got.book!.plays[String(id)]).toBeTruthy();
    expect((await getJson(1, 'def')).kind).toBe('stock'); // the other side is untouched
    expect(await listPlaybookEditTeams(env.DB, 1)).toEqual([{ tgid: 1, side: 'off', updated_at: row.updated_at }]);
    const tb = await loadTeamBook(env, ORIGIN, 1, team1, 'off'); expect(tb.custom).toBe(true); expect(tb.edits).toEqual(edits); expect(tb.book.formations).toHaveLength(edits.formations.length);
    // a second save replaces the row (one per team and side) and the served book follows at once
    edits.name = 'Alder Spread II'; const again = await send(alice, 'POST', 1, 'off', { edits }); expect(again.status).toBe(200); expect(rows()).toHaveLength(1); expect(rows()[0]!.note).toBeNull();
    expect((await getJson(1, 'off')).book!.name).toBe('Alder Spread II'); expect((await loadTeamBook(env, ORIGIN, 1, team1, 'off')).book.name).toBe('Alder Spread II');
    // the bridge acks delivery with the sha of what it wrote; a later save is pending again and keeps that sha
    expect(await listPendingPlaybookEdits(env.DB, 1)).toHaveLength(1);
    const pulled = await (await handleBridge(new Request(`${ORIGIN}/api/bridge/web-edits?od=77`, { headers: { authorization: `Bearer ${TOKEN}` } }), env, ['web-edits'])).json() as { playbooks: { id: number; tgid: number; side: string; edits: unknown }[]; playbookTeams: { tgid: number; side: string }[] };
    expect(pulled.playbooks.map((p) => [p.id, p.tgid, p.side])).toEqual([[1, 1, 'off']]); expect(pulled.playbooks[0]!.edits).toEqual(edits); expect(pulled.playbookTeams).toEqual([{ tgid: 1, side: 'off' }]);
    const ack = await handleBridge(new Request(`${ORIGIN}/api/bridge/web-edits/1/delivered?kind=playbook`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ sha: 'abc123' }) }), env, ['web-edits', '1', 'delivered']);
    expect(ack.status).toBe(200); expect(rows()[0]!.delivered_at).toBeTruthy(); expect(rows()[0]!.delivered_sha).toBe('abc123'); expect(await listPendingPlaybookEdits(env.DB, 1)).toHaveLength(0);
    expect((await handleBridge(new Request(`${ORIGIN}/api/bridge/web-edits/1/delivered?kind=playbook`, { method: 'POST' }), env, ['web-edits', '1', 'delivered'])).status).toBe(401);
    expect((await send(alice, 'POST', 1, 'off', { edits })).status).toBe(200); expect(rows()[0]!.delivered_at).toBeNull(); expect(rows()[0]!.delivered_sha).toBe('abc123'); expect(await listPendingPlaybookEdits(env.DB, 1)).toHaveLength(1);
    // the commissioner may edit another team's book; a web-only member's team too
    const bobs = await send(alice, 'POST', 2, 'def', { edits: stockEdits(readBook(defStock.id)) }); expect(bobs.status, bobs.data.error).toBe(200); expect(rows()).toHaveLength(2);
    expect((await listPlaybookEditTeams(env.DB, 1)).map((r) => `${r.tgid}:${r.side}`)).toEqual(['1:off', '2:def']);
    // reset: DELETE or { reset: true }; the stock book is back
    expect((await send(bob, 'DELETE', 1, 'off', undefined, { origin: ORIGIN })).status).toBe(403);
    const del = await send(alice, 'DELETE', 1, 'off', undefined, { origin: ORIGIN }); expect(del.status).toBe(200); expect(del.data).toEqual({ ok: true }); expect(rows()).toHaveLength(1);
    expect((await getJson(1, 'off')).kind).toBe('stock'); expect((await loadTeamBook(env, ORIGIN, 1, team1, 'off')).custom).toBe(false);
    const reset = await send(bob, 'POST', 2, 'def', { reset: true }); expect(reset.status).toBe(200); expect(rows()).toHaveLength(0);
    expect((await send(bob, 'POST', 2, 'def', { reset: true })).status).toBe(200); // nothing to discard is fine
  });
});
