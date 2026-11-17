// Open sign-up, league credentials and the registry the league server pulls (pages/account.ts, league.ts,
// security.ts, api/league-registry.ts, migration 0030). Requests go through the Worker's own fetch handler against an
// in-memory SQLite with the real migrations (sqlite-d1.ts); a small cookie-keeping client plays the browser. The
// registry and the issued credential are also checked with the league server's own validateRegistry / authenticate
// (spike/blaze/server/league-auth.mjs), which is the contract the two sides share.
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import worker from '../src/index.js';
import type { Env } from '../src/env.js';
import { newTicket, ticketSha256, buildProfile, joinCode, parseJoinCode, onlineIdProblem, isReservedName, enrollPlayer, registryPlayers, TICKET_BYTES, USER_ID_BASE, type MemberProfile } from '../src/league.js';
import { timingSafeEqual, rateHit, rateBlocked, LIMITS, LOGIN_GUESSED_PER_IP, WEB_PLAYERS_MAX, OPEN_INVITES_MAX, clientIp, clientNet, ipv6Groups, csrfToken, csrfOk, sameSiteRequest, CSRF_COOKIE } from '../src/security.js';
import { passwordProblem, isAdmin, signupCaps } from '../src/pages/account.js';
import { attemptLogin } from '../src/pages/login.js';
import { safeBack, sessionToken, SESSION_COOKIE, LEGACY_SESSION_COOKIE, LEGACY_SESSION_CUTOFF_MS } from '../src/session.js';
import { SqliteD1, asD1, migrationFiles, migrationText } from './sqlite-d1.js';
// @ts-expect-error plain .mjs from the league server, no types
import { validateRegistry, authenticate } from '../../spike/blaze/server/league-auth.mjs';

const ORIGIN = 'https://fcs.test';
const TOKEN = 'bridge-token-for-the-tests';
const PASSWORD = 'a long enough pass phrase';

let db: SqliteD1;
let env: Env;
beforeEach(() => {
  db = new SqliteD1();
  env = { DB: asD1(db), SAVES: {} as R2Bucket, ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher, SITE_NAME: 'Test Site', BASE_YEAR: '2013', BRIDGE_TOKEN: TOKEN, ADMIN_USERNAMES: 'boss' };
});
afterEach(() => { vi.unstubAllGlobals(); });

// A browser: keeps cookies, sends Origin on posts, reads the CSRF token out of the form it was served.
class Client {
  cookies = new Map<string, string>();
  constructor(public ip = '203.0.113.10') {}
  private headers(extra: Record<string, string> = {}) {
    const h: Record<string, string> = { 'cf-connecting-ip': this.ip, ...extra };
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    return h;
  }
  private keep(res: Response) {
    for (const c of res.headers.getSetCookie()) { const [pair] = c.split(';'); const i = pair!.indexOf('='); const k = pair!.slice(0, i), v = pair!.slice(i + 1); if (v === '' || /max-age=0/i.test(c)) this.cookies.delete(k); else this.cookies.set(k, v); }
    return res;
  }
  async get(path: string) { return this.keep(await worker.fetch(new Request(ORIGIN + path, { headers: this.headers() }), env)); }
  async post(path: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
    const body = new URLSearchParams(fields);
    return this.keep(await worker.fetch(new Request(ORIGIN + path, { method: 'POST', body, headers: this.headers({ origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', ...headers }) }), env));
  }
  async csrf(path: string) { const m = /name="csrf" value="([0-9a-f]{64})"/.exec(await (await this.get(path)).text()); if (!m) throw new Error(`no csrf field on ${path}`); return m[1]!; }
  async signup(username: string, extra: Record<string, string> = {}) {
    return this.post('/signup', { csrf: await this.csrf('/signup'), username, password: PASSWORD, confirm: PASSWORD, agree: '1', website: '', ...extra });
  }
  async login(username: string, password = PASSWORD) { return this.post('/login', { csrf: await this.csrf('/login'), username, password }); }
  // picks the in-game name; returns the response and, when a join code was issued, the profile inside it
  async pickName(name: string) {
    const res = await this.post('/account/name', { csrf: await this.csrf('/account'), online_id: name });
    return { res, ...(res.status === 200 ? await reveal(res) : { profile: null, html: '' }) };
  }
  async regenerate(password = PASSWORD) {
    const res = await this.post('/account/regenerate', { csrf: await this.csrf('/account/regenerate'), password });
    return { res, ...(res.status === 200 ? await reveal(res) : { profile: null, html: '' }) };
  }
}
async function reveal(res: Response): Promise<{ profile: MemberProfile | null; html: string }> {
  const html = await res.text();
  const m = /<textarea id="join-code"[^>]*>(FCS1-[A-Za-z0-9_-]+)<\/textarea>/.exec(html);
  return { profile: m ? parseJoinCode(m[1]!) : null, html };
}
// a signed-up member with an in-game name
async function member(username: string, name: string, ip?: string) {
  const c = new Client(ip ?? `198.51.100.${1 + Math.floor(Math.random() * 250)}`);
  expect((await c.signup(username)).headers.get('location')).toBe('/account?welcome=1');
  const { profile } = await c.pickName(name);
  expect(profile).not.toBeNull();
  return { c, profile: profile! };
}
const registry = (headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) => worker.fetch(new Request(`${ORIGIN}/api/bridge/league-registry`, { headers }), env);
const fromHex = (h: string) => Buffer.from(h, 'hex');

describe('league credential and profile formats', () => {
  it('makes a 72-byte ticket: FCSNP001 + 64 random bytes', async () => {
    const a = newTicket(), b = newTicket();
    expect(a.length).toBe(TICKET_BYTES); expect(TICKET_BYTES).toBe(72);
    expect(Buffer.from(a.subarray(0, 8)).toString('ascii')).toBe('FCSNP001');
    expect(Buffer.from(a.subarray(8)).equals(Buffer.from(b.subarray(8)))).toBe(false);
    expect(new Set(a.subarray(8)).size).toBeGreaterThan(16); // not a constant fill
    expect(await ticketSha256(a)).toMatch(/^[a-f0-9]{64}$/);
  });
  it('builds the profile league-enroll.mjs writes, plus server, and a join code that decodes back to it', () => {
    const t = newTicket(), p = buildProfile(800000, 'Coach_K', t, 1_700_000_000_000, 'play.fcs-mod.online');
    expect(Object.keys(p)).toEqual(['version', 'userId', 'onlineId', 'ticketHex', 'issuedMs', 'expiresMs', 'server']);
    expect(p.version).toBe(1); expect(p.ticketHex).toBe(Buffer.from(t).toString('hex')); expect(p.ticketHex).toHaveLength(144);
    expect(p.expiresMs).toBe(p.issuedMs + 3650 * 86400_000);
    const code = joinCode(p);
    expect(code).toMatch(/^FCS1-[A-Za-z0-9_-]+$/); // base64url, no padding
    expect(JSON.parse(Buffer.from(code.slice(5), 'base64url').toString('utf8'))).toEqual(p); // what a Node wizard does
    expect(parseJoinCode(code)).toEqual(p);
    expect(parseJoinCode('nope')).toBeNull();
  });
  it('enforces the in-game name rules and the reserved list', () => {
    for (const ok of ['abc', 'Coach_K', 'x-Y_z-123', 'A234567890123456']) expect(onlineIdProblem(ok)).toBeNull();
    for (const bad of ['ab', 'A2345678901234567', 'has space', 'dot.name', 'émile', '', 'semi;colon']) expect(onlineIdProblem(bad)).toBe('format');
    for (const r of ['admin', 'ADMIN', 'Ad-min', 'ea', 'E_A', 'system', 'FCSProbeA', 'fcsprobeZ9', 'Player', 'Administrator', 'EA_Sports', 'moderator1']) { expect(isReservedName(r)).toBe(true); if (r.length >= 3) expect(onlineIdProblem(r)).toBe('reserved'); }
    expect(isReservedName('Eagle')).toBe(false); expect(isReservedName('Seahawk')).toBe(false);
  });
});

describe('sign-up, in-game name and join code', () => {
  it('walks create account -> pick name -> join code, and stores only the hash', async () => {
    const c = new Client();
    const res = await c.signup('alice');
    expect(res.status).toBe(303); expect(res.headers.get('location')).toBe('/account?welcome=1');
    const cookie = res.headers.getSetCookie().find((x) => x.startsWith('__Host-od_session='))!;
    expect(cookie).toMatch(/HttpOnly/); expect(cookie).toMatch(/Secure/); expect(cookie).toMatch(/SameSite=Lax/); expect(cookie).toMatch(/Path=\//);
    expect(await (await c.get('/account')).text()).toContain('Step 2 of 3');

    const { res: issued, profile, html } = await c.pickName('Alice_QB');
    expect(issued.status).toBe(200);
    expect(issued.headers.get('cache-control')).toBe('no-store');
    expect(profile).toMatchObject({ version: 1, userId: USER_ID_BASE, onlineId: 'Alice_QB', server: 'play.fcs-mod.online' });
    expect(html).toContain('download="fcs-online-profile.json"');
    const file = /href="data:application\/json;base64,([A-Za-z0-9+/=]+)"/.exec(html)![1]!;
    expect(JSON.parse(Buffer.from(file, 'base64').toString('utf8'))).toEqual(profile); // the download is the same profile

    const ticket = fromHex(profile!.ticketHex);
    expect(ticket.length).toBe(72); expect(ticket.subarray(0, 8).toString('ascii')).toBe('FCSNP001');
    const row = db.rows<{ user_id: number; ticket_sha256: string; online_id: string }>('SELECT * FROM league_players')[0]!;
    expect(row.ticket_sha256).toBe(await ticketSha256(ticket)); expect(row.user_id).toBe(800000);
    // the plaintext credential is nowhere in the database
    const secret = profile!.ticketHex, tail = secret.slice(16);
    for (const t of db.tables()) for (const r of db.rows(`SELECT * FROM "${t}"`)) for (const v of Object.values(r)) { const s = String(v); expect(s.includes(secret) || s.includes(tail)).toBe(false); }
    // and the account page never shows it again
    const again = await (await c.get('/account')).text();
    expect(again).toContain('Alice_QB'); expect(again).not.toContain('FCS1-'); expect(again).not.toContain(tail);
    // the new league id is the account's console persona, so the site recognises the member in dynasties joined on the server
    expect(db.rows<{ blaze_id: number }>("SELECT blaze_id FROM accounts WHERE username = 'alice'")[0]!.blaze_id).toBe(800000);
    expect(db.rows<{ action: string }>('SELECT action FROM league_audit ORDER BY id').map((a) => a.action)).toEqual(['signup', 'credential_issue']);
  });

  it('uses LEAGUE_SERVER_HOST for the profile server', async () => {
    env.LEAGUE_SERVER_HOST = 'league.example.org';
    expect((await member('hosty', 'Hosty')).profile.server).toBe('league.example.org');
  });

  it('allocates user ids from 800000 upward and never reuses one', async () => {
    const a = await member('user-a', 'NameA'), b = await member('user-b', 'NameB');
    expect([a.profile.userId, b.profile.userId]).toEqual([800000, 800001]);
    db.exec('DELETE FROM league_players WHERE user_id = 800001'); db.exec("DELETE FROM league_user_ids WHERE account_id = (SELECT id FROM accounts WHERE username = 'user-b')"); // even a hand-deleted member's id stays retired
    expect((await member('user-c', 'NameC')).profile.userId).toBe(800002);
    for (const p of [a.profile, b.profile]) expect(p.userId).toBeLessThanOrEqual(0x7fffffff);
  });
  it('refuses to enroll past the 31-bit user id ceiling', async () => {
    db.exec("INSERT INTO accounts (username, pass_hash, salt) VALUES ('big', 'x', 'y')");
    db.exec(`INSERT INTO league_user_ids (id, account_id) VALUES (${0x7fffffff - USER_ID_BASE + 2}, 1)`);
    expect(await enrollPlayer(asD1(db), 1, 'TooBig', 'a'.repeat(64), 1, 2)).toEqual({ ok: false, reason: 'full' });
    expect(db.rows('SELECT * FROM league_players')).toHaveLength(0);
  });

  it('keeps in-game names unique whatever the case, and refuses reserved and badly formed ones', async () => {
    await member('first', 'Gridiron');
    const c = new Client(); await c.signup('second');
    for (const [name, err] of [['gridiron', 'nametaken'], ['GRIDIRON', 'nametaken'], ['admin', 'namereserved'], ['FCSProbeA', 'namereserved'], ['no spaces', 'nameformat'], ['ab', 'nameformat']] as const) {
      const { res } = await c.pickName(name);
      expect(res.status).toBe(303); expect(new URL(res.headers.get('location')!, ORIGIN).searchParams.get('err')).toBe(err);
    }
    expect(db.rows('SELECT * FROM league_players')).toHaveLength(1);
    expect(() => db.exec("INSERT INTO league_players (account_id, user_id, online_id, ticket_sha256, issued_ms, expires_ms) VALUES (99, 900000, 'GRIDIRON', '" + 'b'.repeat(64) + "', 1, 2)")).toThrow(/UNIQUE/); // the table itself refuses too
    const { profile } = await c.pickName('Gridiron2');
    expect(profile?.onlineId).toBe('Gridiron2');
    // one identity per account: a second name is not issued
    const more = await c.post('/account/name', { csrf: await c.csrf('/account/regenerate'), online_id: 'Another' });
    expect(more.status).toBe(303); expect(db.rows('SELECT * FROM league_players')).toHaveLength(2);
  });
  it('refuses the name of a console member already playing in a mirrored dynasty', async () => {
    db.exec("INSERT INTO dynasties (slug, name) VALUES ('d1', 'D1')");
    db.exec("INSERT INTO od_members (dynasty_id, blaze_id, persona, ncid, tgid, ccid, commissioner, team_file_id) VALUES (1, 55, 'OldTimer', 0, 1, 0, 1, 0)");
    const c = new Client(); await c.signup('newbie');
    expect(new URL((await c.pickName('oldtimer')).res.headers.get('location')!, ORIGIN).searchParams.get('err')).toBe('nametaken');
  });

  it('validates the sign-up form', async () => {
    const c = new Client();
    const err = async (fields: Record<string, string>, username = 'valid-name') => new URL((await c.signup(username, fields)).headers.get('location')!, ORIGIN).searchParams.get('err');
    expect(await err({}, 'a')).toBe('username');
    expect(await err({}, 'has space')).toBe('username');
    expect(await err({}, 'Admin')).toBe('reserved');
    expect(await err({}, 'BOSS')).toBe('reserved'); // nobody may register a name listed in ADMIN_USERNAMES
    expect(await err({ password: 'short', confirm: 'short' })).toBe('pwshort');
    expect(await err({ password: 'password123', confirm: 'password123' })).toBe('pweasy');
    expect(await err({ confirm: 'something else entirely' })).toBe('match');
    expect(await err({ agree: '' })).toBe('agree');
    expect(await err({ website: 'http://spam.example' })).toBe('human'); // the honeypot
    expect(db.rows('SELECT * FROM accounts')).toHaveLength(0);
    expect(passwordProblem('Valid-Name2026!', 'valid-name')).toBe('pweasy'); expect(passwordProblem('zzzzzzzzzzzz', 'u')).toBe('pweasy'); expect(passwordProblem('x'.repeat(300), 'u')).toBe('pwlong'); expect(passwordProblem(PASSWORD, 'u')).toBeNull();
    expect((await c.signup('valid-name')).headers.get('location')).toBe('/account?welcome=1');
    expect(new URL((await new Client('203.0.113.99').signup('VALID-NAME')).headers.get('location')!, ORIGIN).searchParams.get('err')).toBe('taken');
    const stored = db.rows<{ pass_hash: string; salt: string }>('SELECT pass_hash, salt FROM accounts')[0]!;
    expect(stored.pass_hash).toMatch(/^pbkdf2-sha256\$100000\$[0-9a-f]{64}$/); expect(stored.salt).toMatch(/^[0-9a-f]{32}$/); expect(JSON.stringify(stored)).not.toContain(PASSWORD);
  });
  it('closes sign-up with OPEN_SIGNUP=false', async () => {
    const c = new Client(); const token = await c.csrf('/signup');
    env.OPEN_SIGNUP = 'false';
    expect(await (await c.get('/signup')).text()).toContain('Sign-ups are closed');
    const res = await c.post('/signup', { csrf: token, username: 'late', password: PASSWORD, confirm: PASSWORD, agree: '1', website: '' });
    expect(res.headers.get('location')).toContain('err=closed'); expect(db.rows('SELECT * FROM accounts')).toHaveLength(0);
  });
  it('requires Turnstile only when both keys are set', async () => {
    env.TURNSTILE_SITE_KEY = 'site-key'; // no secret: still off
    expect(await (await new Client().get('/signup')).text()).not.toContain('cf-turnstile');
    const page = await (await new Client().get('/signup')).text();
    expect(page).toContain('Before you join'); expect(page).toContain('<li><b>This is a free fan project.</b>'); expect(page).toContain('We will never ask you for money');
    env.TURNSTILE_SECRET_KEY = 'secret-key';
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: { body: FormData }) => { calls.push(`${url} ${init.body.get('response')} ${init.body.get('secret')}`); return new Response(JSON.stringify({ success: init.body.get('response') === 'good' })); });
    const c = new Client();
    expect(await (await c.get('/signup')).text()).toContain('class="cf-turnstile" data-sitekey="site-key"');
    expect((await c.signup('turn1')).headers.get('location')).toContain('err=human'); // no token: refused without calling out
    expect(calls).toHaveLength(0);
    expect((await c.signup('turn1', { 'cf-turnstile-response': 'bad' })).headers.get('location')).toContain('err=human');
    expect((await c.signup('turn1', { 'cf-turnstile-response': 'good' })).headers.get('location')).toBe('/account?welcome=1');
    expect(calls).toEqual(['https://challenges.cloudflare.com/turnstile/v0/siteverify bad secret-key', 'https://challenges.cloudflare.com/turnstile/v0/siteverify good secret-key']);
  });
});

describe('regenerating a join code', () => {
  it('asks for the password, issues a new credential and revokes the old one', async () => {
    const { c, profile: first } = await member('regen', 'Regen');
    const page = await (await c.get('/account/regenerate')).text();
    expect(page).toContain('old join code stops working'); expect(page).toContain('Yes, make a new join code');
    const wrong = await c.regenerate('not my password');
    expect(wrong.res.headers.get('location')).toBe('/account/regenerate?err=password');
    expect(db.rows<{ ticket_sha256: string }>('SELECT ticket_sha256 FROM league_players')[0]!.ticket_sha256).toBe(await ticketSha256(fromHex(first.ticketHex)));

    const { profile: second } = await c.regenerate();
    expect(second).toMatchObject({ userId: first.userId, onlineId: 'Regen' }); // same identity
    expect(second!.ticketHex).not.toBe(first.ticketHex);
    const reg = await (await registry()).json() as { players: { ticketSha256: string }[] };
    expect(reg.players).toHaveLength(1);
    expect(reg.players[0]!.ticketSha256).toBe(await ticketSha256(fromHex(second!.ticketHex)));
    // the league server's own check: the new credential logs in, the old one is unknown
    expect(authenticate(fromHex(second!.ticketHex), reg)).toMatchObject({ userId: first.userId, onlineId: 'Regen', leagueAuthenticated: true });
    expect(() => authenticate(fromHex(first.ticketHex), reg)).toThrow(/Unknown or revoked/);
    expect(db.rows<{ action: string }>('SELECT action FROM league_audit ORDER BY id').map((a) => a.action)).toEqual(['signup', 'credential_issue', 'credential_regenerate']);
    expect(db.rows<{ ip_hash: string }>('SELECT ip_hash FROM league_audit')[0]!.ip_hash).toMatch(/^[0-9a-f]{32}$/); // a hash, not the address
  });
  it('needs a signed-in account with an in-game name', async () => {
    expect((await new Client().get('/account/regenerate')).headers.get('location')).toBe('/login?back=%2Faccount%2Fregenerate');
    expect((await new Client().get('/account')).headers.get('location')).toBe('/login?back=%2Faccount');
    const c = new Client(); await c.signup('noname');
    expect((await c.get('/account/regenerate')).headers.get('location')).toBe('/account?err=noplayer');
  });
  it('limits join codes to 5 a day per account', async () => {
    const { c } = await member('greedy', 'Greedy'); // 1 used
    for (let i = 0; i < 4; i++) expect((await c.regenerate()).profile).not.toBeNull();
    const over = await c.regenerate();
    expect(over.res.headers.get('location')).toBe('/account/regenerate?err=credlimit');
    expect(db.rows('SELECT * FROM league_audit WHERE action = ?', 'credential_regenerate')).toHaveLength(4);
  });
  it('changes the password and signs other devices out', async () => {
    const { c } = await member('pwuser', 'PwUser');
    const other = new Client(); await other.login('pwuser');
    expect((await other.get('/account')).status).toBe(200);
    const next = 'another long pass phrase';
    expect((await c.post('/account/password', { csrf: await c.csrf('/account'), current: 'wrong', password: next, confirm: next })).headers.get('location')).toBe('/account?err=password');
    expect((await c.post('/account/password', { csrf: await c.csrf('/account'), current: PASSWORD, password: next, confirm: next })).headers.get('location')).toBe('/account?pw=1');
    expect((await c.get('/account')).status).toBe(200); expect((await other.get('/account')).status).toBe(303);
    expect((await new Client().login('pwuser', PASSWORD)).headers.get('location')).toContain('err=login');
    expect((await new Client().login('pwuser', next)).headers.get('location')).toBe('/account');
  });
});

describe('GET /api/bridge/league-registry', () => {
  it('needs the bridge bearer token', async () => {
    for (const h of [{}, { authorization: 'Bearer wrong' }, { authorization: TOKEN }, { authorization: `Basic ${TOKEN}` }, { authorization: `Bearer ${TOKEN}x` }] as Record<string, string>[]) {
      const res = await registry(h); expect(res.status).toBe(401); expect(await res.json()).toEqual({ error: 'unauthorized' });
    }
    delete env.BRIDGE_TOKEN; // an unset secret never authorises anyone
    expect((await registry()).status).toBe(401); expect((await registry({ authorization: 'Bearer ' })).status).toBe(401);
  });
  it('returns the agreed shape, which the league server accepts', async () => {
    const empty = await registry();
    expect(empty.status).toBe(200); expect(await empty.json()).toMatchObject({ version: 1, players: [] });
    const a = await member('reg-a', 'RegA'), b = await member('reg-b', 'RegB');
    const res = await registry(); const body = await res.json() as { version: number; generatedAt: string; players: Record<string, unknown>[] };
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(Object.keys(body)).toEqual(['version', 'generatedAt', 'players']);
    expect(body.version).toBe(1); expect(new Date(body.generatedAt).toISOString()).toBe(body.generatedAt);
    expect(body.players).toEqual([
      { userId: 800000, onlineId: 'RegA', ticketSha256: await ticketSha256(fromHex(a.profile.ticketHex)), joinDynasties: [], disabled: false },
      { userId: 800001, onlineId: 'RegB', ticketSha256: await ticketSha256(fromHex(b.profile.ticketHex)), joinDynasties: [], disabled: false },
    ]);
    expect(() => validateRegistry(body)).not.toThrow();
    expect(authenticate(fromHex(b.profile.ticketHex), body)).toMatchObject({ userId: 800001, onlineId: 'RegB', personaId: 800001 });
    expect(JSON.stringify(body)).not.toContain(a.profile.ticketHex); // hashes only
    // an account without an in-game name has no credential and is absent
    await new Client().signup('lurker');
    expect(((await (await registry()).json()) as { players: unknown[] }).players).toHaveLength(2);
  });
  it('answers If-None-Match with 304 until something changes', async () => {
    const { c } = await member('etag', 'Etag');
    const first = await registry(); const etag = first.headers.get('etag')!;
    expect(etag).toMatch(/^"[0-9a-f]{40}"$/);
    const again = await registry({ authorization: `Bearer ${TOKEN}`, 'if-none-match': etag });
    expect(again.status).toBe(304); expect(await again.text()).toBe(''); expect(again.headers.get('etag')).toBe(etag);
    expect((await registry({ authorization: `Bearer ${TOKEN}`, 'if-none-match': `W/${etag}` })).status).toBe(304);
    expect((await registry({ authorization: `Bearer ${TOKEN}`, 'if-none-match': `"other", ${etag}` })).status).toBe(304);
    expect((await registry({ authorization: `Bearer ${TOKEN}`, 'if-none-match': '"stale"' })).status).toBe(200);
    expect((await registry({ 'if-none-match': etag })).status).toBe(401); // the ETag is no way round the token
    await c.regenerate();
    const changed = await registry({ authorization: `Bearer ${TOKEN}`, 'if-none-match': etag });
    expect(changed.status).toBe(200); expect(changed.headers.get('etag')).not.toBe(etag);
    const post = await worker.fetch(new Request(`${ORIGIN}/api/bridge/league-registry`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } }), env);
    expect(post.status).toBe(405);
  });
  it('marks an expired credential disabled', async () => {
    await member('old', 'Oldie');
    expect((await registryPlayers(asD1(db), Date.now() + 3651 * 86400_000))[0]!.disabled).toBe(true);
  });
});

describe('admin: turning a member off', () => {
  it('is only there for ADMIN_USERNAMES, and flips disabled in the registry', async () => {
    const victim = await member('rowdy', 'Rowdy');
    expect((await victim.c.get('/admin/members')).status).toBe(404); // not an admin: no such page
    expect((await new Client().get('/admin/members')).status).toBe(404);
    expect((await victim.c.post('/admin/members/800000/disable', { csrf: await victim.c.csrf('/account'), reason: 'x' })).status).toBe(404);
    expect(db.rows<{ disabled: number }>('SELECT disabled FROM league_players')[0]!.disabled).toBe(0);

    db.exec("INSERT INTO accounts (username, pass_hash, salt) SELECT 'Boss', pass_hash, salt FROM accounts WHERE username = 'rowdy'"); // the admin's account predates open sign-up
    const boss = new Client(); expect((await boss.login('boss')).headers.get('location')).toBe('/account');
    const list = await (await boss.get('/admin/members')).text();
    expect(list).toContain('Rowdy'); expect(list).toContain('/admin/members/800000/disable');
    const etag = (await registry()).headers.get('etag')!;
    expect((await boss.post('/admin/members/800000/disable', { csrf: 'f'.repeat(64), reason: 'no' })).headers.get('location')).toBe('/admin/members?err=1'); // CSRF
    const off = await boss.post('/admin/members/800000/disable', { csrf: await boss.csrf('/admin/members'), reason: 'quit  mid-game  repeatedly' });
    expect(off.headers.get('location')).toBe('/admin/members?done=off');

    const res = await registry({ authorization: `Bearer ${TOKEN}`, 'if-none-match': etag });
    expect(res.status).toBe(200); // the change invalidates the ETag
    const reg = await res.json() as { players: { disabled: boolean }[] };
    expect(reg.players[0]!.disabled).toBe(true);
    expect(() => validateRegistry(reg)).not.toThrow();
    expect(() => authenticate(fromHex(victim.profile.ticketHex), reg)).toThrow(/Unknown or revoked/);
    // the member sees why, and cannot make a new join code
    expect(await (await victim.c.get('/account')).text()).toContain('quit mid-game repeatedly');
    expect((await victim.c.get('/account/regenerate')).headers.get('location')).toBe('/account?err=disabled');
    expect((await victim.c.post('/account/regenerate', { csrf: await victim.c.csrf('/account'), password: PASSWORD })).headers.get('location')).toBe('/account?err=disabled');
    expect(db.rows<{ ticket_sha256: string }>('SELECT ticket_sha256 FROM league_players')[0]!.ticket_sha256).toBe(await ticketSha256(fromHex(victim.profile.ticketHex)));

    expect((await boss.post('/admin/members/800000/enable', { csrf: await boss.csrf('/admin/members') })).headers.get('location')).toBe('/admin/members?done=on');
    expect(((await (await registry()).json()) as { players: { disabled: boolean }[] }).players[0]!.disabled).toBe(false);
    const log = db.rows<{ action: string; actor_account_id: number; account_id: number; user_id: number; detail: string | null }>("SELECT * FROM league_audit WHERE action LIKE 'member_%' ORDER BY id");
    expect(log.map((a) => a.action)).toEqual(['member_disable', 'member_enable']);
    expect(log[0]).toMatchObject({ user_id: 800000, detail: 'quit mid-game repeatedly' }); expect(log[0]!.actor_account_id).not.toBe(log[0]!.account_id);
  });
});

describe('rate limits', () => {
  it('counts in fixed windows', async () => {
    const d = asD1(db), l = { scope: 't', max: 2, windowSec: 60 };
    expect(await rateHit(d, l, 'x', 1000)).toBe(true); expect(await rateBlocked(d, l, 'x', 1000)).toBe(false);
    expect(await rateHit(d, l, 'x', 2000)).toBe(true); expect(await rateBlocked(d, l, 'x', 2000)).toBe(true);
    expect(await rateHit(d, l, 'x', 3000)).toBe(false);
    expect(await rateHit(d, l, 'y', 3000)).toBe(true); // another subject is untouched
    expect(await rateHit(d, l, 'x', 61_001)).toBe(true); expect(await rateBlocked(d, l, 'x', 61_001)).toBe(false); // a new window
    expect(db.rows<{ key: string }>('SELECT key FROM rate_limits').every((r) => /^t:[0-9a-f]{32}$/.test(r.key))).toBe(true); // subjects are hashed
  });
  it('allows 3 new accounts a day from one address', async () => {
    const ip = '192.0.2.44';
    for (const u of ['one', 'two', 'three']) expect((await new Client(ip).signup(`acct-${u}`)).headers.get('location')).toBe('/account?welcome=1');
    expect((await new Client(ip).signup('acct-four')).headers.get('location')).toContain('err=slow');
    expect((await new Client('192.0.2.45').signup('acct-four')).headers.get('location')).toBe('/account?welcome=1');
    expect(db.rows('SELECT * FROM accounts')).toHaveLength(4);
  });
  it('stops a flood of sign-up posts from one address', async () => {
    const c = new Client('192.0.2.50'); const token = await c.csrf('/signup');
    const post = () => c.post('/signup', { csrf: token, username: '!', password: PASSWORD, confirm: PASSWORD, agree: '1', website: '' });
    for (let i = 0; i < LIMITS.signupTryIp.max; i++) expect((await post()).headers.get('location')).toContain('err=username');
    expect((await post()).headers.get('location')).toContain('err=slow');
  });
  it('pauses sign-up for everyone only at the hard cap', async () => { // the busy mark (SIGNUP_DAILY_CAP) is covered under "E. sign-up limits"
    env.SIGNUP_DAILY_CAP = '2'; env.SIGNUP_HARD_CAP = '2';
    expect((await new Client('192.0.2.61').signup('cap-1')).headers.get('location')).toBe('/account?welcome=1');
    expect((await new Client('192.0.2.62').signup('cap-2')).headers.get('location')).toBe('/account?welcome=1');
    expect((await new Client('192.0.2.63').signup('cap-3')).headers.get('location')).toContain('err=full');
  });
  it('locks sign-in after 8 wrong passwords, the same way for a username that does not exist', async () => {
    await member('target', 'Target');
    for (const name of ['target', 'nobody-here']) {
      const c = new Client(name === 'target' ? '192.0.2.70' : '192.0.2.71');
      const answers = new Set<string>();
      for (let i = 0; i < LIMITS.loginUserIp.max; i++) answers.add((await c.login(name, 'wrong password')).headers.get('location')!);
      expect([...answers]).toEqual(['/login?err=login&back=%2Faccount']); // one answer, no hint whether the account exists
      expect((await c.login(name, name === 'target' ? PASSWORD : 'x')).headers.get('location')).toBe('/login?err=limited&back=%2Faccount'); // even the right password now waits
    }
    expect((await new Client('192.0.2.72').login('target')).headers.get('location')).toBe('/account'); // the owner, elsewhere, still gets in
  }, 120_000);
});

describe('CSRF and cross-site requests', () => {
  it('refuses a post without the token, with a wrong token, or with another browser\'s token', async () => {
    const c = new Client(); await c.get('/signup');
    const fields = { username: 'csrf-user', password: PASSWORD, confirm: PASSWORD, agree: '1', website: '' };
    expect((await c.post('/signup', fields)).headers.get('location')).toContain('err=csrf');
    expect((await c.post('/signup', { ...fields, csrf: 'a'.repeat(64) })).headers.get('location')).toContain('err=csrf');
    expect((await c.post('/signup', { ...fields, csrf: await new Client().csrf('/signup') })).headers.get('location')).toContain('err=csrf');
    expect((await new Client().post('/signup', { ...fields, csrf: await c.csrf('/signup') })).headers.get('location')).toContain('err=csrf'); // right token, no cookie
    expect(db.rows('SELECT * FROM accounts')).toHaveLength(0);

    const { c: m, profile } = await member('csrf-member', 'CsrfMember');
    const stranger = await member('stranger', 'Stranger');
    const stolen = await stranger.c.csrf('/account/regenerate');
    expect((await m.post('/account/regenerate', { password: PASSWORD })).headers.get('location')).toBe('/account/regenerate?err=csrf');
    expect((await m.post('/account/regenerate', { password: PASSWORD, csrf: stolen })).headers.get('location')).toBe('/account/regenerate?err=csrf');
    expect((await m.post('/account/password', { current: PASSWORD, password: 'changed by an attacker', confirm: 'changed by an attacker' })).headers.get('location')).toBe('/account?err=csrf');
    expect((await m.post('/logout', {})).headers.get('location')).toBe('/account'); expect((await m.get('/account')).status).toBe(200); // still signed in
    expect(db.rows<{ ticket_sha256: string }>("SELECT ticket_sha256 FROM league_players WHERE online_id = 'CsrfMember'")[0]!.ticket_sha256).toBe(await ticketSha256(fromHex(profile.ticketHex)));
    expect((await m.post('/logout', { csrf: await m.csrf('/account') })).headers.get('location')).toBe('/'); expect((await m.get('/account')).status).toBe(303);
  });
  it('blocks state-changing requests that come from another site, everywhere but the token-authenticated API', async () => {
    const { c } = await member('xsite', 'XSite'); const token = await c.csrf('/account/regenerate');
    for (const h of [{ origin: 'https://evil.example' }, { origin: 'https://play.fcs.test' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }] as Record<string, string>[]) {
      expect((await c.post('/account/regenerate', { csrf: token, password: PASSWORD }, h)).status).toBe(403);
      expect((await c.post('/d/anything/logout', {}, h)).status).toBe(403); // the older dynasty forms are covered too
    }
    expect((await c.post('/account/regenerate', { csrf: token, password: PASSWORD }, { 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    expect(db.rows('SELECT * FROM league_audit WHERE action = ?', 'credential_regenerate')).toHaveLength(1);
    const url = new URL(ORIGIN);
    expect(sameSiteRequest(new Request(ORIGIN, { method: 'POST' }), url)).toBe(true);
    expect(sameSiteRequest(new Request(ORIGIN, { method: 'POST', headers: { origin: 'null' } }), url)).toBe(false);
  });
  it('derives the token from a secret cookie: the session when signed in, a __Host- cookie before that', async () => {
    const anon = await csrfToken(new Request(ORIGIN));
    expect(anon.setCookie).toMatch(new RegExp(`^${CSRF_COOKIE}=[0-9a-f]{64}; Path=/; Max-Age=\\d+; HttpOnly; Secure; SameSite=Lax$`));
    const secret = anon.setCookie!.split(';')[0]!.split('=')[1]!;
    expect(anon.token).not.toBe(secret); // the cookie value itself is never put in a page
    const req = (cookie: string, origin = ORIGIN) => new Request(ORIGIN, { method: 'POST', headers: { cookie, origin } });
    const form = (t: string) => { const f = new FormData(); f.set('csrf', t); return f; };
    expect(await csrfOk(req(`${CSRF_COOKIE}=${secret}`), new URL(ORIGIN), form(anon.token))).toBe(true);
    expect(await csrfOk(req(`${CSRF_COOKIE}=${'0'.repeat(64)}`), new URL(ORIGIN), form(anon.token))).toBe(false);
    expect(await csrfOk(req(`${CSRF_COOKIE}=${secret}`, 'https://evil.example'), new URL(ORIGIN), form(anon.token))).toBe(false);
    const signedIn = await csrfToken(new Request(ORIGIN, { headers: { cookie: `__Host-od_session=${'1'.repeat(64)}; ${CSRF_COOKIE}=${secret}` } }));
    expect(signedIn.setCookie).toBeUndefined(); expect(signedIn.token).not.toBe(anon.token);
  });
});

describe('security headers and the bridge token', () => {
  it('sends the headers on pages, API answers and assets', async () => {
    for (const path of ['/', '/signup', '/api/health', '/css/base.css', '/no-such-page']) {
      const res = await new Client().get(path);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
      expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
      expect(res.headers.get('strict-transport-security')).toContain('max-age=');
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
    }
    const csp = (await new Client().get('/signup')).headers.get('content-security-policy')!;
    expect(csp).toContain("default-src 'self'"); expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com"); expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    const page = await (await new Client().get('/signup')).text();
    expect(page).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/); expect(page).not.toMatch(/\son[a-z]+="/); // nothing inline for the policy to block
  });
  it('compares in constant time, lengths included', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true); expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false); expect(timingSafeEqual('abcd', 'abc')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true); expect(timingSafeEqual('a', '')).toBe(false); expect(timingSafeEqual('', 'a')).toBe(false);
  });
  it('still answers the other bridge routes with the token', async () => {
    const res = await worker.fetch(new Request(`${ORIGIN}/api/bridge/ping`, { headers: { authorization: `Bearer ${TOKEN}` } }), env);
    expect(res.status).toBe(200); expect(await res.json()).toMatchObject({ ok: true });
  });
});

describe('existing accounts keep working', () => {
  it('lets an invite-era account sign in on the dynasty page, with the same limits', async () => {
    await member('veteran', 'Veteran');
    db.exec("INSERT INTO dynasties (slug, name) VALUES ('d1', 'D1')");
    const c = new Client('192.0.2.90');
    const ok = await c.post('/d/d1/login', { username: 'veteran', password: PASSWORD, back: '/d/d1' });
    expect(ok.headers.get('location')).toBe('/d/d1'); expect(ok.headers.getSetCookie().some((x) => x.startsWith('__Host-od_session='))).toBe(true);
    const bad = new Client('192.0.2.91');
    for (let i = 0; i < LIMITS.loginUserIp.max; i++) expect((await bad.post('/d/d1/login', { username: 'veteran', password: 'nope' })).headers.get('location')).toContain('err=1');
    expect((await bad.post('/d/d1/login', { username: 'veteran', password: PASSWORD })).headers.get('location')).toContain('err=2');
  }, 120_000);
  it('links a league member to a dynasty the bridge syncs', async () => {
    const { c } = await member('linker', 'Linker');
    const body = { slug: 'open-league', name: 'Open League', od: { id: 7, members: [{ blazeId: 800000, persona: 'Linker', team: 3, commissioner: true }], games: {} } };
    const res = await worker.fetch(new Request(`${ORIGIN}/api/bridge/dynasties`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }), env);
    expect(res.status).toBe(200);
    expect(db.rows('SELECT * FROM account_members')).toMatchObject([{ blaze_id: 800000 }]);
    expect(await (await c.get('/d/open-league/members')).text()).toContain('Signed in as <b>linker</b> (Linker)');
  });
});

describe('migration 0030', () => {
  it('only creates tables and indexes (remote D1 rejects create-then-write in one file, error 7403)', () => {
    const file = migrationFiles().find((f) => f.startsWith('0030_'))!;
    const sql = migrationText(file).replace(/--.*$/gm, '');
    const statements = sql.split(';').map((s) => s.trim()).filter(Boolean);
    expect(statements.length).toBeGreaterThan(0);
    for (const s of statements) expect(s).toMatch(/^CREATE (TABLE|INDEX) /);
    expect(migrationFiles().at(-1)).toBe(file); // numbering continues from 0029
    expect(db.tables()).toEqual(expect.arrayContaining(['league_user_ids', 'league_players', 'league_audit', 'rate_limits']));
  });
});

// ---- Review findings A to J ------------------------------------------------------------------------------------------
const errOf = (res: Response) => new URL(res.headers.get('location')!, ORIGIN).searchParams.get('err');
const loginReq = (ip: string) => new Request(`${ORIGIN}/login`, { method: 'POST', headers: { 'cf-connecting-ip': ip } });
// A dynasty the bridge mirrors, with a league member ("Chief") as its commissioner and ten free teams. Returns the
// commissioner's browser.
async function league(): Promise<Client> {
  const chief = await member('chief-acct', 'Chief');
  const body = { slug: 'open-league', name: 'Open League', od: { id: 7, members: [{ blazeId: chief.profile.userId, persona: 'Chief', team: 3, commissioner: true }], games: {} } };
  const res = await worker.fetch(new Request(`${ORIGIN}/api/bridge/dynasties`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }), env);
  expect(res.status).toBe(200);
  for (let t = 10; t < 20; t++) db.exec(`INSERT INTO teams (dynasty_id, tgid, snapshot_id, name, conf_label) VALUES (1, ${t}, 0, 'Team ${t}', 'Conf')`);
  return chief.c;
}
const addWeb = (c: Client, persona: string, tgid: number) => c.post('/d/open-league/members/web', { persona, tgid: String(tgid) });
const inviteFor = (persona: string) => db.rows<{ code: string }>('SELECT i.code FROM invites i JOIN od_members m ON m.dynasty_id = i.dynasty_id AND m.blaze_id = i.blaze_id WHERE m.persona = ? AND i.used_at IS NULL', persona)[0]!.code;
const join = (c: Client, code: string, username: string, extra: Record<string, string> = {}) => c.post('/d/open-league/join', { code, username, password: PASSWORD, confirm: PASSWORD, ...extra });

describe('dynasty settings from the bridge', () => {
  it('never stores the dynasty join password or its hash', async () => {
    const body = { slug: 'pw-league', name: 'PW League', od: { id: 9, settings: { NAME: 'PW League', PASS: 'hunter22', passwordHash: 'scrypt$x', MHUM: 12 }, members: [], games: {} } };
    const res = await worker.fetch(new Request(`${ORIGIN}/api/bridge/dynasties`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }), env);
    expect(res.status).toBe(200);
    const row = db.rows<{ settings_json: string }>('SELECT settings_json FROM dynasties WHERE slug = ?', 'pw-league')[0]!;
    expect(row.settings_json).not.toContain('hunter22'); expect(row.settings_json).not.toContain('scrypt');
    expect(JSON.parse(row.settings_json)).toEqual({ NAME: 'PW League', MHUM: 12 });
  });
});

describe('A. accounts made from an invite link', () => {
  it('apply the sign-up rules for usernames and passwords', async () => {
    const chief = await league();
    expect((await addWeb(chief, 'Sideline Sam', 10)).headers.get('location')).toBe('/d/open-league/members?webadded=1');
    const code = inviteFor('Sideline Sam'), c = new Client('192.0.2.150');
    expect(await (await c.get(`/d/open-league/join?code=${code}`)).text()).toContain('minlength="10"');
    expect(errOf(await join(c, code, 'sam', { password: '12345678', confirm: '12345678' }))).toContain('at least 10 characters'); // 8 used to be enough here
    expect(errOf(await join(c, code, 'sam', { password: 'password123', confirm: 'password123' }))).toContain('too easy to guess');
    expect(errOf(await join(c, code, 'sam', { password: 'sam-2026!!!!', confirm: 'sam-2026!!!!' }))).toContain('too easy to guess'); // the username with decorations
    for (const name of ['League_Admin', 'FCS_Staff', 'moderator', 'Boss', 'B0SS', 'b.o.s.s']) expect(errOf(await join(c, code, name))).toBe('That username is not available. Please pick another one.');
    expect(errOf(await join(c, code, 'x'))).toContain('3 to 24 characters');
    expect(db.rows("SELECT * FROM accounts WHERE username <> 'chief-acct'")).toHaveLength(0);
    const ok = await join(c, code, 'sam-web');
    expect(ok.headers.get('location')).toBe('/d/open-league/members?joined=1');
    expect(ok.headers.getSetCookie().some((x) => x.startsWith('__Host-od_session='))).toBe(true);
    expect(await (await c.get('/d/open-league/members')).text()).toContain('Signed in as <b>sam-web</b> (Sideline Sam)');
    expect(db.rows<{ action: string; ip_hash: string }>("SELECT * FROM league_audit WHERE action = 'invite_signup'")).toMatchObject([{ detail: 'dynasty open-league' }]);
  });
  it('ask for Turnstile when it is configured', async () => {
    const chief = await league(); await addWeb(chief, 'Turn Tina', 10);
    env.TURNSTILE_SITE_KEY = 'site-key'; env.TURNSTILE_SECRET_KEY = 'secret-key';
    vi.stubGlobal('fetch', async (_url: string, init: { body: FormData }) => new Response(JSON.stringify({ success: init.body.get('response') === 'good' })));
    const code = inviteFor('Turn Tina'), c = new Client('192.0.2.151');
    expect(await (await c.get(`/d/open-league/join?code=${code}`)).text()).toContain('class="cf-turnstile" data-sitekey="site-key"');
    expect(errOf(await join(c, code, 'tina-web'))).toContain('could not confirm you are a person');
    expect(errOf(await join(c, code, 'tina-web', { 'cf-turnstile-response': 'bad' }))).toContain('could not confirm you are a person');
    expect((await join(c, code, 'tina-web', { 'cf-turnstile-response': 'good' })).headers.get('location')).toBe('/d/open-league/members?joined=1');
  });
  it('limit accounts per network per day, and an existing account can still take an invite', async () => {
    const chief = await league();
    for (let i = 0; i <= LIMITS.inviteOkIp.max; i++) expect((await addWeb(chief, `Web Player ${i}`, 10 + i)).headers.get('location')).toContain('webadded=1');
    const ip = '192.0.2.152';
    for (let i = 0; i < LIMITS.inviteOkIp.max; i++) expect((await join(new Client(ip), inviteFor(`Web Player ${i}`), `web-${i}`)).headers.get('location')).toBe('/d/open-league/members?joined=1');
    const last = inviteFor(`Web Player ${LIMITS.inviteOkIp.max}`);
    expect(errOf(await join(new Client(ip), last, 'web-last'))).toContain('Several accounts were created from your connection today');
    expect(db.rows("SELECT * FROM accounts WHERE username = 'web-last'")).toHaveLength(0);
    // someone at that address who already has an account takes the invite with it: no new account, no limit
    const friend = new Client(ip); await friend.login('web-0');
    expect((await friend.post('/d/open-league/join', { code: last, link: '1' })).headers.get('location')).toBe('/d/open-league/members?joined=1');
  });
  it('limit form posts per address', async () => {
    const chief = await league(); await addWeb(chief, 'Flood Fred', 10);
    const code = inviteFor('Flood Fred'), c = new Client('192.0.2.153');
    for (let i = 0; i < LIMITS.inviteTryIp.max; i++) expect(errOf(await join(c, code, '!'))).toContain('3 to 24 characters');
    expect(errOf(await join(c, code, 'fred-web'))).toContain('Too many tries');
  });
  it('cap the web players and the open invites of a dynasty', async () => {
    const chief = await league();
    expect((await addWeb(chief, 'First Web', 10)).headers.get('location')).toContain('webadded=1');
    const first = db.rows<{ blaze_id: number }>("SELECT blaze_id FROM od_members WHERE persona = 'First Web'")[0]!.blaze_id;
    for (let i = 0; i < WEB_PLAYERS_MAX - 1; i++) db.exec(`INSERT INTO od_members (dynasty_id, blaze_id, persona, ncid, tgid, ccid, commissioner, team_file_id, web_only) VALUES (1, ${-100 - i}, 'Filler ${i}', 0, 1023, 0, 0, 0, 1)`);
    expect(errOf(await addWeb(chief, 'One Too Many', 11))).toBe(`A dynasty can have at most ${WEB_PLAYERS_MAX} web players.`);
    db.exec("DELETE FROM od_members WHERE persona LIKE 'Filler %'");
    for (let i = 0; i < OPEN_INVITES_MAX - 1; i++) db.exec(`INSERT INTO invites (code, dynasty_id, blaze_id) VALUES ('FILL-${i}', 1, ${-500 - i})`);
    expect(errOf(await addWeb(chief, 'No Room', 11))).toContain(`already has ${OPEN_INVITES_MAX} open invites`);
    expect(db.rows("SELECT * FROM od_members WHERE persona = 'No Room'")).toHaveLength(0); // not added without an invite
    expect(errOf(await chief.post('/d/open-league/members/invite', { blaze_id: String(first) }))).toContain(`already has ${OPEN_INVITES_MAX} open invites`);
    db.exec("DELETE FROM invites WHERE code LIKE 'FILL-%'");
    expect((await chief.post('/d/open-league/members/invite', { blaze_id: String(first) })).headers.get('location')).toBe('/d/open-league/members?invited=1'); // back under the cap: works
    expect((await addWeb(chief, 'Room Again', 11)).headers.get('location')).toContain('webadded=1');
  });
  it('removing a web player deletes only that web player\'s own account', async () => {
    const chief = await league();
    const bystander = new Client('192.0.2.154'); await bystander.signup('bystander'); // signed up, no in-game name, no dynasty yet
    await addWeb(chief, 'Temp Tom', 10);
    await join(new Client('192.0.2.155'), inviteFor('Temp Tom'), 'tom-web');
    const tom = db.rows<{ blaze_id: number }>("SELECT blaze_id FROM od_members WHERE persona = 'Temp Tom'")[0]!.blaze_id;
    expect((await chief.post(`/d/open-league/members/web/${tom}`, { action: 'remove' })).headers.get('location')).toBe('/d/open-league/members?removed=1');
    expect(db.rows<{ username: string }>('SELECT username FROM accounts ORDER BY id').map((a) => a.username)).toEqual(['chief-acct', 'bystander']);
    expect((await bystander.get('/account')).status).toBe(200);
  });
});

describe('B. admin identity', () => {
  it('never lets anyone register a listed admin name or a look-alike, by sign-up or by invite', async () => {
    env.ADMIN_USERNAMES = 'boss, Head.Coach_1'; // neither is registered yet
    const chief = await league(); await addWeb(chief, 'Wants Power', 10);
    const code = inviteFor('Wants Power');
    let n = 0;
    for (const name of ['boss', 'BOSS', 'Boss', 'B0SS', 'b055', 'b.o.s.s', 'Boss_', '-boss-', 'head.coach_1', 'HeadCoach1', 'headcoachl', 'HEAD-C0ACH-I']) {
      expect(errOf(await new Client(`192.0.2.${160 + (n++ % 20)}`).signup(name)), name).toBe('reserved');
      expect(errOf(await join(new Client(`192.0.3.${n}`), code, name)), name).toBe('That username is not available. Please pick another one.');
    }
    expect(db.rows("SELECT * FROM accounts WHERE username <> 'chief-acct'")).toHaveLength(0);
    // an ordinary name that merely contains the letters is fine
    expect((await new Client('192.0.2.190').signup('bossanova')).headers.get('location')).toBe('/account?welcome=1');

  });
  it('recognises admins by account number, and by username only for an account that exists', async () => {
    env.ADMIN_USERNAMES = '';
    const first = await member('rowdy', 'Rowdy'), second = await member('quiet', 'Quiet');
    expect(await (await first.c.get('/account')).text()).toContain('account number 1');
    expect((await first.c.get('/admin/members')).status).toBe(404);
    env.ADMIN_ACCOUNT_IDS = ' 2 , x, -1, 0, 2.5';
    expect((await second.c.get('/admin/members')).status).toBe(200); expect((await first.c.get('/admin/members')).status).toBe(404);
    expect(await (await second.c.get('/account')).text()).toContain('/admin/members');
    expect((await second.c.post('/admin/members/800000/disable', { csrf: await second.c.csrf('/admin/members'), reason: 'test' })).headers.get('location')).toBe('/admin/members?done=off');
    // nobody may register a look-alike of that admin's username, or play under it
    expect(errOf(await new Client('192.0.2.191').signup('Qu1et'))).toBe('reserved'); expect(errOf(await new Client('192.0.2.191').signup('q.u.i.e.t'))).toBe('reserved');
    const c = new Client('192.0.2.192'); await c.signup('newcomer');
    env.ADMIN_USERNAMES = 'boss';
    expect(errOf((await c.pickName('B0ss')).res)).toBe('namereserved');
    // the username list keeps working for the account that has the name
    env.ADMIN_ACCOUNT_IDS = ''; env.ADMIN_USERNAMES = 'ROWDY';
    expect((await first.c.get('/admin/members')).status).toBe(200); expect((await second.c.get('/admin/members')).status).toBe(404);
  });
  it('compares names in ASCII only and ignores entries that are not plain usernames or numbers', () => {
    const e = (ids: string, names: string) => ({ ...env, ADMIN_ACCOUNT_IDS: ids, ADMIN_USERNAMES: names });
    const acct = (id: number, username: string) => ({ id, username, blazeId: null });
    expect(isAdmin(e('', 'Boss'), acct(5, 'bOSS'))).toBe(true);
    expect(isAdmin(e('', 'boss'), acct(5, 'boſs'))).toBe(false); // long s
    expect(isAdmin(e('', 'kim'), acct(5, 'Kim'))).toBe(false); // Kelvin sign, which lower-cases to k
    expect(isAdmin(e('', 'bоss'), acct(5, 'boss'))).toBe(false); expect(isAdmin(e('', 'bоss'), acct(5, 'bоss'))).toBe(false); // a Cyrillic o in the list
    expect(isAdmin(e('', ''), acct(5, ''))).toBe(false); expect(isAdmin(e('', ' , '), acct(5, 'boss'))).toBe(false); expect(isAdmin(e('', 'boss'), null)).toBe(false);
    expect(isAdmin(e('5', ''), acct(5, 'whoever'))).toBe(true); expect(isAdmin(e('05, 5x, 5.0, -5, +5', ''), acct(5, 'whoever'))).toBe(false); expect(isAdmin(e('4,6', ''), acct(5, 'whoever'))).toBe(false);
  });
});

describe('C. redirect after sign-in', () => {
  it('safeBack only returns paths on this site', () => {
    for (const ok of ['/', '/account', '/d/league/members?x=1#members', '/d/a/recruiting?team=5&pos=QB', '/a/b/../c']) expect(safeBack(ok, '/dflt', ORIGIN)).toBe(new URL(ok, ORIGIN).pathname + new URL(ok, ORIGIN).search + new URL(ok, ORIGIN).hash);
    expect(safeBack('/a/b/../c', '/dflt', ORIGIN)).toBe('/a/c');
    for (const bad of ['//example.com/x', '/\\example.com/x', '/\\/example.com', '\\\\example.com', '/\t/example.com', '/\n/example.com', '/\r/example.com', '/\u0000/example.com', '/x\\y', '/a\tb',
      'https://example.com/', 'http://fcs.test/', '//fcs.test/', 'javascript:alert(1)', 'account', '', ' /account', '/ /example.com', '/.//example.com', '/a/..//example.com', `/${'a'.repeat(3000)}`]) {
      expect(safeBack(bad, '/dflt', ORIGIN), JSON.stringify(bad)).toBe('/dflt'); expect(safeBack(bad, '/dflt'), JSON.stringify(bad)).toBe('/dflt');
    }
    for (const notText of [null, undefined, 5, {}, ['/account']]) expect(safeBack(notText, '/dflt', ORIGIN)).toBe('/dflt');
    for (const s of ['/account', '/\\example.com', '/\t/example.com', '//example.com', '/.//example.com']) expect(new URL(safeBack(s, '/dflt', ORIGIN), ORIGIN).origin).toBe(ORIGIN); // whatever comes back stays here
  });
  it('is applied wherever a form names the page to go back to', async () => {
    const { c } = await member('backer', 'Backer');
    db.exec("INSERT INTO dynasties (slug, name) VALUES ('d1', 'D1')");
    db.exec("INSERT INTO od_members (dynasty_id, blaze_id, persona, ncid, tgid, ccid, commissioner, team_file_id) VALUES (1, 55, 'OldTimer', 0, 1, 0, 1, 0)");
    for (const back of ['/\\example.com/x', '/\t/example.com', '//example.com', 'https://example.com/']) {
      const fresh = new Client(`192.0.2.${200 + Math.floor(Math.random() * 50)}`);
      expect((await fresh.post('/login', { csrf: await fresh.csrf('/login'), username: 'backer', password: PASSWORD, back })).headers.get('location'), back).toBe('/account');
      expect((await c.get(`/login?back=${encodeURIComponent(back)}`)).headers.get('location'), back).toBe('/account'); // already signed in: straight back
      expect((await new Client().post('/d/d1/login', { username: 'backer', password: PASSWORD, back })).headers.get('location'), back).toBe('/d/d1');
      expect((await c.post('/d/d1/logout', { back })).headers.get('location'), back).toBe('/d/d1'); await c.login('backer');
      expect((await new Client().post('/d/d1/member', { blaze_id: '55', back })).headers.get('location'), back).toBe('/d/d1'); // the persona picker
      expect((await new Client().post('/d/d1/ready', { ready: '1', back })).headers.get('location'), back).toMatch(/^\/d\/d1\?err=/);
      expect((await new Client().post('/d/d1/recruiting/board', { tgid: '2', back })).headers.get('location'), back).toMatch(/^\/d\/d1\/recruiting\?team=2&err=/);
    }
    expect((await new Client().post('/d/d1/member', { blaze_id: '55', back: '/d/d1/teams?x=1' })).headers.get('location')).toBe('/d/d1/teams?x=1');
  }, 120_000);
});

describe('D. sign-in limits cannot lock the owner out', () => {
  it('lets the owner in with the right password however many wrong guesses others make, and slows the guessing', async () => {
    await member('target', 'Target');
    const d = asD1(db);
    for (let i = 0; i < LIMITS.loginUser.max + 1; i++) expect(await attemptLogin(d, loginReq(`203.0.113.${i + 1}`), 'target', 'a wrong guess')).toBe('fail'); // a crowd of addresses guessing
    expect(await attemptLogin(d, loginReq('198.18.0.1'), 'Target', PASSWORD)).toHaveProperty('cookie'); // the owner, from an address never seen before
    expect(await attemptLogin(d, loginReq('198.18.0.1'), 'target', PASSWORD)).toHaveProperty('cookie'); // and again: a success does not use the address up
    // while the name is being guessed at, each address gets fewer tries, and the next one is refused without a password check
    const answers: unknown[] = [];
    for (let i = 0; i <= LOGIN_GUESSED_PER_IP; i++) answers.push(await attemptLogin(d, loginReq('203.0.113.200'), 'target', 'another guess'));
    expect(answers).toEqual([...Array(LOGIN_GUESSED_PER_IP).fill('fail'), 'limited']);
    expect(await attemptLogin(d, loginReq('203.0.113.200'), 'target', PASSWORD)).toBe('limited'); // that address has used its tries, right password or not
    expect(await attemptLogin(d, loginReq('198.18.0.2'), 'target', PASSWORD)).toHaveProperty('cookie'); // everyone else is unaffected
  }, 120_000);
  it('takes a slot before checking the password, so parallel requests cannot exceed the limit', async () => {
    await member('target', 'Target');
    const d = asD1(db), ip = '203.0.113.77';
    const results = await Promise.all(Array.from({ length: 20 }, () => attemptLogin(d, loginReq(ip), 'target', 'a wrong guess')));
    expect(results.filter((r) => r === 'fail')).toHaveLength(LIMITS.loginUserIp.max); expect(results.filter((r) => r === 'limited')).toHaveLength(20 - LIMITS.loginUserIp.max);
    expect(await attemptLogin(d, loginReq(ip), 'target', PASSWORD)).toBe('limited');
    expect(await attemptLogin(d, loginReq('203.0.113.78'), 'target', PASSWORD)).toHaveProperty('cookie');
    // a success hands the address its tries back
    for (let i = 0; i < LIMITS.loginUserIp.max - 1; i++) expect(await attemptLogin(d, loginReq('203.0.113.79'), 'target', 'typo')).toBe('fail');
    expect(await attemptLogin(d, loginReq('203.0.113.79'), 'target', PASSWORD)).toHaveProperty('cookie');
    expect(await attemptLogin(d, loginReq('203.0.113.79'), 'target', 'typo')).toBe('fail');
  }, 120_000);
});

describe('E. sign-up limits', () => {
  it('keys IPv6 by /64 for per-address limits and by /48 for accounts per network', () => {
    const from = (ip: string) => new Request(ORIGIN, { headers: { 'cf-connecting-ip': ip } });
    expect(clientIp(from('2001:db8:1:2:3:4:5:6'))).toBe('2001:db8:1:2::/64'); expect(clientNet(from('2001:db8:1:2:3:4:5:6'))).toBe('2001:db8:1::/48');
    expect(clientIp(from('2001:DB8:1:2::9'))).toBe('2001:db8:1:2::/64'); expect(clientNet(from('2001:db8:1:ffff::9'))).toBe('2001:db8:1::/48');
    expect(clientIp(from('2001:db8::5'))).toBe('2001:db8:0:0::/64'); expect(clientIp(from('2001:db8::7:0:0:0:5'))).toBe('2001:db8:0:7::/64'); // "::" is expanded first
    expect(clientNet(from('2001:0db8:0001:0000:0000:0000:0000:0001'))).toBe('2001:db8:1::/48');
    expect(clientIp(from('::ffff:192.0.2.7'))).toBe('192.0.2.7'); expect(clientNet(from('::ffff:c000:207'))).toBe('192.0.2.7'); expect(clientNet(from('192.0.2.7'))).toBe('192.0.2.7');
    expect(clientIp(new Request(ORIGIN))).toBe('unknown'); expect(clientNet(from('not:an:address'))).toBe('not:an:address'); expect(ipv6Groups('1::2::3')).toBeNull(); expect(ipv6Groups('::1')).toEqual(['0', '0', '0', '0', '0', '0', '0', '1']);
  });
  it('counts a whole IPv6 /48 as one network for new accounts', async () => {
    for (let i = 0; i < LIMITS.signupOkIp.max; i++) expect((await new Client(`2001:db8:77:${i + 1}::1`).signup(`v6-${i}`)).headers.get('location')).toBe('/account?welcome=1');
    expect(errOf(await new Client('2001:db8:77:ffff:1:2:3:4').signup('v6-more'))).toBe('slow'); // another /64 of the same /48
    expect((await new Client('2001:db8:78::1').signup('v6-other')).headers.get('location')).toBe('/account?welcome=1');
  });
  it('past the busy mark stays open, one account per network; only the hard cap pauses sign-up', async () => {
    env.SIGNUP_DAILY_CAP = '2'; env.SIGNUP_HARD_CAP = '5';
    expect(signupCaps(env)).toEqual({ busy: 2, hard: 5 }); expect(signupCaps({ ...env, SIGNUP_DAILY_CAP: 'x', SIGNUP_HARD_CAP: '' })).toEqual({ busy: 200, hard: 2000 }); expect(signupCaps({ ...env, SIGNUP_DAILY_CAP: '5000', SIGNUP_HARD_CAP: '10' })).toEqual({ busy: 5000, hard: 5000 });
    expect((await new Client('192.0.2.61').signup('cap-1')).headers.get('location')).toBe('/account?welcome=1');
    expect((await new Client('192.0.2.61').signup('cap-2')).headers.get('location')).toBe('/account?welcome=1'); // not busy yet: 3 per network
    expect((await new Client('192.0.2.62').signup('cap-3')).headers.get('location')).toBe('/account?welcome=1'); // busy now, and still open
    expect(errOf(await new Client('192.0.2.62').signup('cap-3b'))).toBe('busy'); // but one per network
    expect(errOf(await new Client('192.0.2.61').signup('cap-3c'))).toBe('busy');
    expect(await (await new Client().get('/signup?err=busy')).text()).toContain('each internet connection can create one account a day');
    expect((await new Client('192.0.2.63').signup('cap-4')).headers.get('location')).toBe('/account?welcome=1');
    expect((await new Client('192.0.2.64').signup('cap-5')).headers.get('location')).toBe('/account?welcome=1');
    expect(errOf(await new Client('192.0.2.65').signup('cap-6'))).toBe('full'); // the hard cap
    expect(db.rows('SELECT * FROM accounts')).toHaveLength(5);
  });
  it('with Turnstile configured, a busy day keeps the normal allowance: the check does the work', async () => {
    env.SIGNUP_DAILY_CAP = '1'; env.TURNSTILE_SITE_KEY = 'site-key'; env.TURNSTILE_SECRET_KEY = 'secret-key';
    vi.stubGlobal('fetch', async (_url: string, init: { body: FormData }) => new Response(JSON.stringify({ success: init.body.get('response') === 'good' })));
    const ip = '192.0.2.66';
    for (let i = 0; i < LIMITS.signupOkIp.max; i++) expect((await new Client(ip).signup(`ts-${i}`, { 'cf-turnstile-response': 'good' })).headers.get('location')).toBe('/account?welcome=1');
    expect(errOf(await new Client(ip).signup('ts-more', { 'cf-turnstile-response': 'good' }))).toBe('slow');
    expect(errOf(await new Client('192.0.2.67').signup('ts-bot'))).toBe('human');
  });
});

describe('F. reserved names', () => {
  it('catches staff-sounding and project names however they are dressed up', () => {
    for (const r of ['League_Admin', 'FCS_Staff', 'Commish1', 'Adm1n', '4dm1n', 'ADM1N1STRAT0R', 'xXAdminXx', 'The-Moderator', 'M0derat0r', 'm0d', 'Mod_Mike', 'ModMike', 'League_Mod', 'leaguemod', 'Mods', 'Official_Mike', '0ff1c1al',
      'Commissioner', 'C0mm1ss10ner', 'The_Commish', 'commish_22', 'Staff', 'St4ff', 'staff_2026', 'FcsStaff', 'Site.Owner', 'Owner_1', 'Support', 'FCS_Support', 'Tech-Support', 'Sys0p', 'EA_Mike', 'EASports14', 'ea-sports',
      'FCS', 'fcs_14', 'FCS-Mod', 'fcsmod_online', 'FCS_Online', 'NCAA', 'NcaaOnline', 'Online_Dynasty', 'League', 'LeagueServer', 'Server', 'System', 'Root', 'Guest22', 'Player1', 'Te5t', 'b0t', 'webmaster', 'Help_Desk', 'Developer']) expect(isReservedName(r), r).toBe(true);
  });
  it('leaves ordinary names alone', () => {
    for (const ok of ['Eagle', 'Seahawk', 'Coach_K', 'Alice_QB', 'Stafford', 'MattStafford9', 'Flagstaff_AZ', 'Badminton', 'Modesto', 'Modern_QB', 'Browner', 'Downer', 'Supporter', 'Sea_Hawk', 'Reagan', 'Mike_34', 'QB_E4', 'Hostile', 'Ghost', 'Rooter',
      'Leaguer', 'Players_Club', 'Field', 'Devin', 'Dev', 'Helper', 'Allen', 'Alley', 'Botha', 'Usher', 'Gridiron2', 'x-Y_z-123', 'A234567890123456', 'bossanova', 'TheCommodore', 'Admiral']) expect(isReservedName(ok), ok).toBe(false);
  });
  it('checks sign-up usernames and in-game names with the same list', async () => {
    const c = new Client('192.0.2.210');
    for (const name of ['League_Admin', 'FCS_Staff', 'Commish1', 'Adm1n']) expect(errOf(await c.signup(name)), name).toBe('reserved');
    await c.signup('plain-name');
    for (const name of ['League_Admin', 'FCS_Staff', 'Commish1', 'Adm1n']) expect(errOf((await c.pickName(name)).res), name).toBe('namereserved');
    expect((await c.pickName('Stafford_9')).profile?.onlineId).toBe('Stafford_9');
  });
  it('keeps in-game names apart whatever the separators', async () => {
    await member('first', 'Coach_K');
    const c = new Client('192.0.2.211'); await c.signup('second');
    for (const name of ['CoachK', 'coach-k', 'COACH_K', 'C_o_a_c_h_K']) expect(errOf((await c.pickName(name)).res), name).toBe('nametaken');
    expect((await c.pickName('Coach_K2')).profile?.onlineId).toBe('Coach_K2');
  });
  it('keeps web-player display names and in-game names from imitating each other', async () => {
    const chief = await league(); await member('rival', 'Rival_QB');
    expect(errOf(await addWeb(chief, 'FCS Staff', 10))).toBe('That name is reserved. Please pick another one.');
    expect(errOf(await addWeb(chief, 'League Admin', 10))).toBe('That name is reserved. Please pick another one.');
    expect(errOf(await addWeb(chief, 'B0SS', 10))).toBe('That name is reserved. Please pick another one.'); // the admin's username (ADMIN_USERNAMES)
    expect(errOf(await addWeb(chief, 'Lеague Fan', 10))).toContain('letters, numbers, spaces'); // a Cyrillic letter
    expect(errOf(await addWeb(chief, 'x', 10))).toContain('2 to 24 characters');
    expect(errOf(await addWeb(chief, 'rival qb', 10))).toContain("somebody's in-game name"); expect(errOf(await addWeb(chief, 'Rival.QB', 10))).toContain("somebody's in-game name");
    expect(errOf(await addWeb(chief, 'chief', 10))).toBe('There is already a member called chief.');
    expect(db.rows('SELECT * FROM od_members WHERE web_only = 1')).toHaveLength(0);
    expect((await addWeb(chief, "Sam O'Neil", 10)).headers.get('location')).toContain('webadded=1');
    expect(errOf(await addWeb(chief, 'sam_o-neil', 11))).toContain('already a member called');
    // nobody else can take the web player's name as an in-game name; the web player can
    const other = new Client('192.0.2.212'); await other.signup('copycat');
    expect(errOf((await other.pickName('SamONeil')).res)).toBe('nametaken'); expect(errOf((await other.pickName('sam_o_neil')).res)).toBe('nametaken');
    const sam = new Client('192.0.2.213'); await join(sam, inviteFor("Sam O'Neil"), 'sam-web');
    expect((await sam.pickName('Sam_ONeil')).profile?.onlineId).toBe('Sam_ONeil');
  });
});

describe('G. a token for the member list only', () => {
  const REG = 'registry-only-token';
  const call = (path: string, token: string, init: RequestInit = {}) => worker.fetch(new Request(`${ORIGIN}/api/bridge/${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }), env);
  it('REGISTRY_TOKEN reads the league registry and nothing else', async () => {
    await member('reg-a', 'RegA');
    expect((await call('league-registry', REG)).status).toBe(401); // not set yet
    env.REGISTRY_TOKEN = REG;
    const res = await call('league-registry', REG);
    expect(res.status).toBe(200); expect(((await res.json()) as { players: unknown[] }).players).toHaveLength(1);
    expect((await call('league-registry', REG, { method: 'HEAD' })).status).toBe(200);
    expect((await call('league-registry', TOKEN)).status).toBe(200); // the full token keeps working there
    for (const [path, init] of [['ping', {}], ['invites?od=7', {}], ['invites', { method: 'POST', body: '{"od":7,"blazeId":1}' }], ['dynasties', { method: 'POST', body: '{"slug":"x","od":{"id":9}}' }], ['league-registry/extra', {}], ['league-registry/../ping', {}], ['supersim', {}], ['photos', {}]] as [string, RequestInit][]) {
      const r = await call(path, REG); expect(r.status, path).toBe(401); expect(await r.json()).toEqual({ error: 'unauthorized' });
    }
    expect(db.rows('SELECT * FROM dynasties')).toHaveLength(0);
    expect((await call('ping', TOKEN)).status).toBe(200);
    for (const bad of [`${REG}x`, REG.slice(0, -1), REG.toUpperCase(), '', 'unset']) expect((await call('league-registry', bad)).status, bad).toBe(401);
    expect((await worker.fetch(new Request(`${ORIGIN}/api/bridge/league-registry`, { headers: { authorization: REG } }), env)).status).toBe(401);
  });
  it('an unset or empty REGISTRY_TOKEN authorises nobody', async () => {
    for (const v of [undefined, '']) {
      env.REGISTRY_TOKEN = v;
      for (const t of ['', 'unset', 'undefined', 'null']) expect((await call('league-registry', t)).status).toBe(401);
      expect((await call('league-registry', TOKEN)).status).toBe(200);
    }
    delete env.BRIDGE_TOKEN; env.REGISTRY_TOKEN = REG; // the narrow token does not need the full one to be set
    expect((await call('league-registry', REG)).status).toBe(200); expect((await call('ping', REG)).status).toBe(401); expect((await call('league-registry', 'unset')).status).toBe(401);
  });
});

describe('H. the error page', () => {
  it('shows a reference instead of the exception, and logs the detail', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
    try {
      const broken = { ...env, DB: { prepare() { throw new Error('D1_ERROR: no such table: secret_internal_table'); } } as unknown as D1Database };
      for (const path of ['/', '/d/some-league']) {
        const res = await worker.fetch(new Request(ORIGIN + path), broken);
        const text = await res.text();
        expect(res.status).toBe(500); expect(res.headers.get('cache-control')).toBe('no-store'); expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(text).not.toMatch(/D1_ERROR|secret_internal_table|no such table|\.ts\b|stack/i);
        const ref = /reference: ([0-9a-f]{8})\b/.exec(text)?.[1];
        expect(ref).toBeDefined();
        expect(logged.some((l) => l.includes(`ref=${ref}`) && l.includes('secret_internal_table') && l.includes(path))).toBe(true);
      }
    } finally { spy.mockRestore(); }
  });
});

describe('I. the session cookie', () => {
  it('is set with the __Host- prefix, and sign-out clears both names', async () => {
    const c = new Client('192.0.2.220');
    const set = (await c.signup('hosty')).headers.getSetCookie().filter((x) => /od_session=/.test(x));
    expect(set).toHaveLength(1);
    expect(set[0]).toMatch(/^__Host-od_session=[0-9a-f]{64}; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$/); // Secure, Path=/, no Domain: what the prefix requires
    expect(SESSION_COOKIE).toBe('__Host-od_session'); expect(LEGACY_SESSION_COOKIE).toBe('od_session');
    const out = (await c.post('/logout', { csrf: await c.csrf('/account') })).headers.getSetCookie();
    expect(out).toEqual(['__Host-od_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax', 'od_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax']);
    db.exec("INSERT INTO dynasties (slug, name) VALUES ('d1', 'D1')");
    expect((await c.post('/d/d1/logout', {})).headers.getSetCookie().map((x) => x.split('=')[0])).toEqual(['__Host-od_session', 'od_session']);
  });
  it('keeps a browser signed in that still holds the old-name cookie, and moves it to the new name', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(LEGACY_SESSION_CUTOFF_MS - 86400_000); // the day before the cutoff
    try {
      const chief = await league();
      const token = chief.cookies.get('__Host-od_session')!;
      db.exec("UPDATE sessions SET created_at = '2026-11-01 00:00:00', expires_at = '2999-01-01 00:00:00'"); // a session from before the rename
      const upgraded = `__Host-od_session=${token}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`;
      const old = () => { const c = new Client('192.0.2.221'); c.cookies.set('od_session', token); return c; };
      const page = await old().get('/account');
      expect(page.status).toBe(200); expect(await page.text()).toContain('Chief'); expect(page.headers.getSetCookie()).toContain(upgraded);
      const dyn = await old().get('/d/open-league/members');
      expect(await dyn.text()).toContain('Signed in as <b>chief-acct</b> (Chief)'); expect(dyn.headers.getSetCookie()).toContain(upgraded);
      // forms keep working during the move (the CSRF token comes from the same session token under either name)
      const c = old();
      expect((await c.post('/account/password', { csrf: await c.csrf('/account'), current: 'wrong', password: 'x', confirm: 'x' })).headers.get('location')).toBe('/account?err=password');
      expect(c.cookies.get('__Host-od_session')).toBe(token);
      // signing out with only the old cookie really signs out
      const leaving = old();
      expect((await leaving.post('/d/open-league/logout', {})).headers.getSetCookie()).toHaveLength(2); expect(leaving.cookies.size).toBe(0);
      expect((await old().get('/account')).status).toBe(303);
    } finally { vi.useRealTimers(); }
  });
  it('does not accept a newer session, or any session after the transition, under the old name', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(LEGACY_SESSION_CUTOFF_MS - 86400_000);
    try {
      const c = new Client('192.0.2.222'); await c.signup('newer');
      const token = c.cookies.get('__Host-od_session')!;
      const withCookie = (name: string) => { const x = new Client('192.0.2.223'); x.cookies.set(name, token); return x; };
      db.exec("UPDATE sessions SET created_at = '2027-06-01 00:00:00', expires_at = '2999-01-01 00:00:00'"); // made after the cutoff: only ever handed out as __Host-
      expect((await withCookie('od_session').get('/account')).status).toBe(303); // planted under the old name by a sibling subdomain: ignored
      expect((await withCookie('__Host-od_session').get('/account')).status).toBe(200);
      db.exec("UPDATE sessions SET created_at = '2026-11-01 00:00:00'");
      expect((await withCookie('od_session').get('/account')).status).toBe(200); // an old session, inside the transition
      vi.setSystemTime(LEGACY_SESSION_CUTOFF_MS + 30 * 86400_000); // one session lifetime after the cutoff the old name is no longer read at all
      expect((await withCookie('od_session').get('/account')).status).toBe(303);
      expect((await withCookie('__Host-od_session').get('/account')).status).toBe(200);
      const req = (cookie: string) => new Request(ORIGIN, { headers: { cookie } });
      expect(sessionToken(req(`od_session=${token}`))).toBeNull(); expect(sessionToken(req(`od_session=${token}`), LEGACY_SESSION_CUTOFF_MS)).toEqual({ token, legacy: true });
      expect(sessionToken(req(`od_session=${'a'.repeat(64)}; __Host-od_session=${token}`), 0)).toEqual({ token, legacy: false }); // the __Host- cookie wins
    } finally { vi.useRealTimers(); }
  });
});

describe('J. join code wording', () => {
  it('tells the member never to use someone else\'s code or share their own', async () => {
    const c = new Client('192.0.2.230'); await c.signup('reader');
    const { html } = await c.pickName('Reader');
    expect(html).toContain('Never use a join code that someone else sent you, and never give yours to anyone:');
    expect(html).toContain('whoever holds a join code plays as the member it belongs to.');
    expect((await c.regenerate()).html).toContain('Never use a join code that someone else sent you');
  });
});
