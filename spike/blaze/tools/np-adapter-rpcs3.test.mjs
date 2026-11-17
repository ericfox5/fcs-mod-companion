// node --test spike/blaze/tools/np-adapter-rpcs3.test.mjs
// The first group runs anywhere (made-up addresses, made-up credential). The second needs the private stock ELF and
// Python: it proves the words are exactly what ps3-np-adapter.py bakes into a personalized ELF.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOOKS, RETAIN, adapterWords, assemble, checkProfile, checkTemplate, decodeByteStores, extractTemplate, jump } from './np-adapter-rpcs3.mjs';
import { patchBaseline, elfSegments, fileOffset } from './ps3-eboot.mjs';
import { fakeProfile, fakeTemplate, fakeTicket } from './np-adapter-fixture.mjs';

const digest = (words) => crypto.createHash('sha256').update(words.map(([va, w]) => `${va.toString(16)}=${w.toString(16)}`).join('\n')).digest('hex');

test('same profile, same words; the fixed fake profile gives the recorded output', () => {
  const a = adapterWords(fakeTemplate(), fakeProfile()), b = adapterWords(fakeTemplate(), fakeProfile());
  assert.deepEqual(a, b);
  assert.equal(a.length, 1005);
  assert.equal(digest(a), 'fddc3e06f98c33f75fbddc0bd0ec2ce3010e25b1a596c317c5127e97df171582');
  assert.equal(a.length, new Set(a.map(([va]) => va)).size, 'no address written twice');
  for (const [va, w] of a) { assert.equal(va % 4, 0); assert.ok(Number.isInteger(w) && w >= 0 && w <= 0xffffffff); }
});

test('the credential bytes are what GetTicket stores, in order, and nowhere else', () => {
  const t = fakeTemplate(), p = fakeProfile(), a = assemble(t, p), ticket = fakeTicket();
  const run = (range) => a.code.filter(([va]) => va >= range[0] && va < range[1]).map(([, w]) => w);
  assert.ok(a.hooks.GetTicket < a.ticketStore[0] && a.ticketStore[1] < a.hooks.GetTicketParam, 'inside the GetTicket hook');
  assert.deepEqual(decodeByteStores(run(a.ticketStore)), ticket);
  assert.deepEqual(decodeByteStores(run(a.digestStore)), crypto.createHash('sha256').update(ticket).digest().subarray(0, 20));
  assert.equal(a.credentialSha256, crypto.createHash('sha256').update(ticket).digest('hex'));
  // a second credential with the same byte-repeat structure (every byte differs from the first): the only words that
  // change are inside the two stores
  const other = { ...p, ticketHex: Buffer.concat([ticket.subarray(0, 8), Buffer.from(ticket.subarray(8).map((v) => v ^ 0x5a))]).toString('hex') };
  const b = assemble(t, other);
  assert.equal(a.code.length, b.code.length);
  const inStores = (va) => (va >= a.ticketStore[0] && va < a.ticketStore[1]) || (va >= a.digestStore[0] && va < a.digestStore[1]);
  const changed = a.code.filter(([va, w], i) => b.code[i][1] !== w).map(([va]) => va);
  assert.ok(changed.length >= 64);
  assert.ok(changed.every(inStores), 'a credential change stays inside the ticket and digest stores');
  assert.deepEqual(a.patches, b.patches);
  // outside the stores no four consecutive credential bytes appear in any word, and no word carries the hex text
  const secret = ticket.subarray(8);
  for (const [va, w] of a.code) {
    if (inStores(va)) continue;
    const bytes = Buffer.alloc(4); bytes.writeUInt32BE(w);
    assert.equal(secret.indexOf(bytes), -1, `word at 0x${va.toString(16)} repeats credential bytes`);
  }
});

test('identity lands in the right hooks; call sites and the retained completion are redirected', () => {
  const t = fakeTemplate(), p = fakeProfile(2), a = assemble(t, p);
  const body = (name, next) => a.code.filter(([va]) => va >= a.hooks[name] + 8 && va < a.hooks[next] - 8).map(([, w]) => w); // after cmpwi/beq, before li r3,0; blr
  assert.equal(decodeByteStores(body('GetNpId', 'GetOnlineId')).toString('latin1').replace(/\0+$/, ''), p.onlineId);
  assert.equal(decodeByteStores(body('GetOnlineId', 'GetSigninId')).length, 20);
  assert.deepEqual(decodeByteStores(body('GetStatus', 'GetNpId')), Buffer.from([0, 0, 0, 3]));
  assert.equal(a.patches.length, HOOKS.reduce((n, [, c]) => n + c, 0) + 1);
  for (const [name] of HOOKS) for (const va of t.sites[name]) {
    const [, word, original] = a.patches.find(([x]) => x === va);
    assert.equal(word, jump(va, a.hooks[name], true)); assert.equal(original, jump(va, t.stubs[name], true));
  }
  assert.deepEqual(a.patches.at(-1), [RETAIN.va, 0x60000000, 0x987f00e5]);
  assert.equal(a.code[0][0], t.codeVa); assert.ok(a.code.at(-1)[0] + 4 <= t.codeLimit);
  // the state is only addressed, never written by a patch word
  assert.ok(adapterWords(t, p).every(([va]) => va < t.stateVa || va >= t.stateVa + 128));
});

test('bad profiles and templates are refused without quoting the credential', () => {
  const t = fakeTemplate(), p = fakeProfile();
  for (const bad of [{ ...p, userId: 0 }, { ...p, userId: 2 ** 31 }, { ...p, onlineId: 'ab' }, { ...p, onlineId: 'has space' }, { ...p, ticketHex: p.ticketHex.slice(2) },
    { ...p, ticketHex: `00${p.ticketHex.slice(2)}` }, { ...p, expiresMs: p.issuedMs }, { ...p, issuedMs: 1.5 }]) {
    assert.throws(() => checkProfile(bad), (e) => !e.message.includes(p.ticketHex.slice(16, 40)));
  }
  assert.throws(() => checkTemplate({ ...t, sites: { ...t.sites, GetTicket: t.sites.GetTicket.slice(1) } }), /GetTicket/);
  assert.throws(() => assemble({ ...t, codeLimit: t.codeVa + 64 }, p), /does not fit/);
  assert.throws(() => assemble({ ...t, rtcClock: 0x8000000 }, p), /branch reach/);
});

// ---- against the real executable and the Python builder (private files; skipped when they are not on this PC) --------
const here = path.dirname(fileURLToPath(import.meta.url));
const ELF = path.join(here, '..', 'private', 'EBOOT.elf');
const python = [process.env.FCS_PYTHON, 'python', 'python3', path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe')]
  .find((p) => p && spawnSync(p, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)']).status === 0);

test('stock 1.02 ELF: template addresses', { skip: !fs.existsSync(ELF) && 'private/EBOOT.elf not on this PC' }, () => {
  const elf = fs.readFileSync(ELF), t = extractTemplate(elf);
  assert.equal(t.codeVa, 0x1bc26f0); assert.equal(t.stateVa, 0x1d61150); assert.equal(t.codeLimit, 0x1bd0000);
  assert.equal(Object.values(t.sites).flat().length, 50);
  checkTemplate(t);
  // RPCS3 maps PT_LOAD segments in 64 KB pages: code and state sit in the tail pages of the RX and RW segments
  const [rx, rw] = elfSegments(elf);
  assert.ok(t.codeVa >= rx.va + rx.memory && t.codeLimit <= Math.ceil((rx.va + rx.memory) / 0x10000) * 0x10000);
  assert.ok(t.stateVa >= rw.va + rw.memory && t.stateVa + 128 <= Math.ceil((rw.va + rw.memory) / 0x10000) * 0x10000);
});

test('stock 1.02 ELF: words equal the personalized ELF from ps3-np-adapter.py', { skip: (!fs.existsSync(ELF) && 'private/EBOOT.elf not on this PC') || (!python && 'no Python 3') }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-adapter-test-'));
  try {
    const elf = fs.readFileSync(ELF), profile = fakeProfile(3), template = extractTemplate(elf);
    fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify(profile));
    const r = spawnSync(python, [path.join(here, 'ps3-np-adapter.py'), ELF, path.join(dir, 'profile.json'), path.join(dir, 'out.elf')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const built = fs.readFileSync(path.join(dir, 'out.elf')), manifest = JSON.parse(fs.readFileSync(path.join(dir, 'out.elf.manifest.json'), 'utf8'));
    const a = assemble(template, profile), words = adapterWords(template, profile);
    assert.deepEqual(a.hooks, manifest.hooks);
    assert.equal(a.code.length * 4, manifest.codeSize);
    assert.equal(a.credentialSha256, manifest.credentialSha256);
    // every word we would have RPCS3 write is the word the ELF holds at that address (the code sits past the stock
    // segment's file size, at the same file offset rule the builder used)
    const segs = elfSegments(elf), rx = segs[0];
    const at = (va) => (va >= template.codeVa ? rx.offset + va - rx.va : fileOffset(segs, va));
    for (const [va, w] of words) assert.equal(built.readUInt32BE(at(va)), w, `0x${va.toString(16)}`);
    // and the ELF holds nothing else on top of the mod's own baseline, except the three program-header sizes RPCS3 does
    // not need (it maps whole 64 KB pages)
    const base = patchBaseline(elf, { commissioner: true }).output, ours = new Set(words.map(([va]) => at(va)));
    const headerWrites = new Set(manifest.headerWrites.flatMap((h) => Array.from({ length: 8 }, (_, i) => h.offset + i)));
    for (let o = 0; o < built.length; o++) if (built[o] !== base[o]) assert.ok(ours.has(o & ~3) || headerWrites.has(o), `unexpected difference at file offset 0x${o.toString(16)}`);
    // stock words at the call sites are the calls the template says they are
    for (const [va, , original] of a.patches) assert.equal(elf.readUInt32BE(fileOffset(segs, va)), original);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- the contract with the league server: what the game presents is what registry mode authenticates -------------------
test('the ticket the adapter hands the game authenticates against a registry that holds only its SHA-256', async () => {
  const { authenticate } = await import('../server/league-auth.mjs');
  const p = fakeProfile(4), a = assemble(fakeTemplate(), p);
  const presented = decodeByteStores(a.code.filter(([va]) => va >= a.ticketStore[0] && va < a.ticketStore[1]).map(([, w]) => w));
  const registry = { version: 1, players: [{ userId: p.userId, onlineId: p.onlineId, ticketSha256: a.credentialSha256, joinDynasties: [] }] };
  const session = authenticate(presented, registry);
  assert.equal(session.userId, p.userId); assert.equal(session.onlineId, p.onlineId); assert.equal(session.leagueAuthenticated, true);
  assert.throws(() => authenticate(fakeTicket(5), registry), /Unknown or revoked/);
});
