// node --import tsx --test installer/test/online.test.ts
// The online-league half of FCS-online.exe: join codes, profile checks, the personal patch entry, RPCS3's patch and
// config files as text, the connection check against ports opened here, whose profile it is, server names, how programs
// are started, the checksum file, and the whole wizard (the bundle) on a throwaway RPCS3 folder. Made-up credentials
// only; nothing outside a temporary folder is written.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import dgram from 'node:dgram';
import { createHash } from 'node:crypto';
import * as rawChildProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';
// @ts-expect-error plain .mjs fixture without types
import { fakeProfile, fakeTemplate, fakeTicket } from '../../spike/blaze/tools/np-adapter-fixture.mjs';
// @ts-expect-error plain .mjs build helper without types
import { readChecksum, verifyChecksum, writeChecksum } from '../checksum.mjs';
import { assemble, decodeByteStores, type AdapterTemplate } from '../../spike/blaze/tools/np-adapter-rpcs3.mjs';
import { OWN_CODE_RULE, ProfileError, credentialFingerprint, describeProfile, findDownloadedProfiles, forgetProfile, identityOf, inheritAccess, isOfficialServer, isPunycodeName, loadInstallNote, loadStoredProfile, parseJoinCode, profileChange, profileWarnings, readProfileFile, readProfileInput, readProfileText, restrictToUser, saveInstallNote, saveProfile, serverNameProblem, shownPath, validateProfile, type OnlineProfile } from '../src/online/profile.js';
import { RefusedCommand, browserUrl, exec, execFileSync, findOnPath, openInBrowser, resolveCommand, spawn, spawnSync, systemDir, systemRoot, systemTool } from '../src/online/system.js';
import { CREDENTIAL_PATCH, adapterConflicts, credentialPatchEntry, patchAddresses } from '../src/online/np-patch.js';
import { enablePatchEntries, isPatchEnabled, mergePatchEntries, patchEntryBlock, patchEntryState, removePatchEntry } from '../src/online/patch-files.js';
import { applyOnlineNet, configureOnlineNet, customConfigPath, readNetState, setYamlKey } from '../src/online/rpcs3-config.js';
import { FIX_COMMAND, addressDrift, checkServer, verdict, type PortSpec } from '../src/online/netcheck.js';

const NOW = 1_800_000_000_000; // inside the fake profile's lifetime
const profile = (seed = 1): OnlineProfile => fakeProfile(seed);
const template = (): AdapterTemplate => fakeTemplate();
const joinCode = (p: unknown) => `FCS1-${Buffer.from(JSON.stringify(p), 'utf8').toString('base64url')}`;
const codeOf = (fn: () => unknown) => { try { fn(); } catch (e) { assert.ok(e instanceof ProfileError, String(e)); return e.code; } return 'no error'; };
const secretHex = fakeTicket(1).subarray(8).toString('hex');
const noSecret = (text: string) => { assert.ok(!text.toLowerCase().includes(secretHex.slice(0, 24)), 'credential hex in output'); assert.ok(!text.includes(fakeTicket(1).toString('base64url').slice(12, 40)), 'credential base64 in output'); };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fcs-online-test-'));
const win = process.platform === 'win32';
// the access list of a file as Windows prints it (icacls by full path, through the wizard's own launcher)
const aclOf = (file: string) => String(spawnSync('icacls', [file], { encoding: 'utf8' }).stdout);
const userOnly = (file: string) => { const acl = aclOf(file); return acl.includes(os.userInfo().username) && !/Everyone|BUILTIN\\Users|Authenticated Users|\(I\)/.test(acl); };
// neither made-up credential, as hex or base64, and no join code
const noSecrets = (text: string, ...profiles: OnlineProfile[]) => {
  for (const p of profiles) {
    const raw = Buffer.from(p.ticketHex, 'hex');
    assert.ok(!text.toLowerCase().includes(p.ticketHex.slice(16, 48)), 'credential hex in output');
    assert.ok(!text.includes(raw.toString('base64url').slice(12, 40)) && !text.includes(raw.toString('base64').slice(12, 40)), 'credential base64 in output');
    assert.ok(!text.includes(joinCode(p).slice(0, 40)) && !text.includes(joinCode(p).slice(-40)), 'join code in output');
  }
};

// ---- join code ------------------------------------------------------------------------------------------------------
test('join code: round trip, and the wrapping a chat app or a console adds', () => {
  const p = profile(), code = joinCode(p);
  assert.deepEqual(validateProfile(parseJoinCode(code), NOW), p);
  assert.deepEqual(validateProfile(parseJoinCode(`  "${code.slice(0, 40)}\r\n${code.slice(40, 90)} ${code.slice(90)}"\n`), NOW), p);
  assert.deepEqual(readProfileInput(`fcs1-${code.slice(5)}`, NOW).profile, p, 'prefix case does not matter');
  assert.deepEqual(readProfileInput(`${code}==`, NOW).profile, p, 'padding is accepted');
  assert.equal(readProfileInput(code, NOW).source, 'code');
});
test('join code: a truncated paste is called truncated, at every cut', () => {
  const code = joinCode(profile());
  for (let n = 6; n < code.length; n += 7) assert.equal(codeOf(() => validateProfile(parseJoinCode(code.slice(0, n)), NOW)), 'truncated', `cut at ${n}`);
  assert.equal(codeOf(() => parseJoinCode('FCS1-')), 'truncated');
  try { parseJoinCode(code.slice(0, 200)); } catch (e) { assert.match((e as Error).message, /cut off: 200 characters/); noSecret((e as Error).message); }
});
test('join code: wrong things pasted', () => {
  const code = joinCode(profile());
  assert.equal(codeOf(() => parseJoinCode('')), 'empty');
  assert.equal(codeOf(() => parseJoinCode('   \n')), 'empty');
  assert.equal(codeOf(() => parseJoinCode('hello there')), 'not-a-code');
  assert.equal(codeOf(() => parseJoinCode(code.slice(5))), 'not-a-code'); // the prefix was not copied
  assert.equal(codeOf(() => parseJoinCode(`FCS2-${code.slice(5)}`)), 'code-version');
  assert.equal(codeOf(() => parseJoinCode(`${code.slice(0, 50)}!${code.slice(51)}`)), 'bad-characters');
  assert.equal(codeOf(() => parseJoinCode(`FCS1-${Buffer.from('[1,2').toString('base64url')}`)), 'not-a-profile');
  assert.equal(codeOf(() => validateProfile(parseJoinCode(`FCS1-${Buffer.from('[1,2]').toString('base64url')}`), NOW)), 'not-a-profile');
});

// ---- profile ----------------------------------------------------------------------------------------------------------
test('profile: each broken field has its own message, and none quotes the credential', () => {
  const p = profile(), bad = (change: Record<string, unknown>) => { try { validateProfile({ ...p, ...change }, NOW); } catch (e) { assert.ok(e instanceof ProfileError); noSecret(e.message); return e.code; } return 'no error'; };
  assert.equal(bad({ version: 2 }), 'profile-version');
  assert.equal(bad({ version: '1' }), 'profile-version');
  assert.equal(bad({ version: undefined }), 'profile-version');
  assert.equal(bad({ server: undefined, expiresMs: null }), 'missing-fields');
  assert.equal(bad({ userId: 0 }), 'bad-identity'); assert.equal(bad({ userId: 2 ** 31 }), 'bad-identity'); assert.equal(bad({ userId: '700101' }), 'bad-identity');
  assert.equal(bad({ onlineId: 'ab' }), 'bad-identity'); assert.equal(bad({ onlineId: 'seventeen_chars__' }), 'bad-identity'); assert.equal(bad({ onlineId: 'no spaces' }), 'bad-identity');
  assert.equal(bad({ ticketHex: p.ticketHex.slice(0, 142) }), 'bad-credential');
  assert.equal(bad({ ticketHex: `${p.ticketHex}00` }), 'bad-credential');
  assert.equal(bad({ ticketHex: `ff${p.ticketHex.slice(2)}` }), 'bad-credential'); // not FCSNP001
  assert.equal(bad({ ticketHex: p.ticketHex.replace(/.$/, 'g') }), 'bad-credential');
  assert.equal(bad({ issuedMs: p.expiresMs }), 'bad-lifetime'); assert.equal(bad({ expiresMs: 1.5 }), 'bad-lifetime'); assert.equal(bad({ issuedMs: -1 }), 'bad-lifetime');
  for (const server of ['http://play.example.test', 'play.example.test:42127', 'play.example.test/x', 'play example', '', '-bad.example', 'a..b']) assert.equal(bad({ server }), 'bad-server', server);
  assert.equal(codeOf(() => validateProfile(p, p.expiresMs)), 'expired');
  assert.equal(codeOf(() => validateProfile(p, p.expiresMs + 1)), 'expired');
  try { validateProfile(p, p.expiresMs + 1); } catch (e) { assert.match((e as Error).message, /expired on 2033-05-18/); }
});
test('profile: accepted values are normalised; extra fields are dropped', () => {
  const p = profile(), v = validateProfile({ ...p, server: 'Play.Example.Test', ticketHex: p.ticketHex.toUpperCase(), extra: 'x' }, NOW);
  assert.deepEqual(v, p);
  assert.deepEqual(validateProfile({ ...p, server: '203.0.113.7' }, NOW).server, '203.0.113.7');
  assert.equal(credentialFingerprint(p), createHash('sha256').update(fakeTicket(1)).digest('hex').slice(0, 8));
  noSecret(describeProfile(p, NOW)); assert.match(describeProfile(p, NOW), /^TestUser1 on play\.example\.test \(valid until 2033-05-18; key fingerprint [0-9a-f]{8}\)$/);
  assert.deepEqual(profileWarnings(p, NOW), []);
  assert.match(profileWarnings(p, p.expiresMs - 3 * 86400000)[0]!, /runs out in 3 day/);
  assert.match(profileWarnings(p, p.issuedMs - 5 * 86400000)[0]!, /check the PC clock/);
});
test('profile: from a file, from pasted JSON, stored for this user only', () => {
  const dir = tmp();
  try {
    const p = profile(), file = path.join(dir, 'fcs-online-profile.json');
    fs.writeFileSync(file, `﻿${JSON.stringify(p, null, 2)}`);
    assert.deepEqual(readProfileFile(file, NOW), p);
    assert.deepEqual(readProfileInput(`"${file}"`, NOW), { profile: p, source: 'file' });
    assert.deepEqual(readProfileInput(JSON.stringify(p), NOW), { profile: p, source: 'json' });
    fs.writeFileSync(path.join(dir, 'cut.json'), JSON.stringify(p).slice(0, 80));
    assert.equal(codeOf(() => readProfileFile(path.join(dir, 'cut.json'), NOW)), 'truncated');
    assert.equal(codeOf(() => readProfileFile(path.join(dir, 'missing.json'), NOW)), 'no-file');
    fs.writeFileSync(path.join(dir, 'code.txt'), joinCode(p));
    assert.deepEqual(readProfileFile(path.join(dir, 'code.txt'), NOW), p);
    // storage
    const store = path.join(dir, 'store');
    assert.equal(loadStoredProfile(store), null);
    const s = saveProfile(p, store);
    assert.equal(s.file, path.join(store, 'fcs-online-profile.json'));
    assert.deepEqual(loadStoredProfile(store), p);
    assert.deepEqual(fs.readdirSync(store), ['fcs-online-profile.json'], 'no temporary file left');
    if (process.platform === 'win32') {
      assert.equal(s.restricted, true);
      assert.ok(userOnly(s.file), 'profile ACL is not user-only');
    } else assert.equal(fs.statSync(s.file).mode & 0o777, 0o600);
    assert.equal(forgetProfile(store), true); assert.equal(forgetProfile(store), false); assert.equal(loadStoredProfile(store), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- the personal patch entry -------------------------------------------------------------------------------------------
test('patch entry: fixed output for the fixed fake profile, RPCS3 be32 lines only', () => {
  const e = credentialPatchEntry(template(), profile()), again = credentialPatchEntry(template(), profile());
  assert.equal(e.block, again.block);
  assert.equal(e.name, CREDENTIAL_PATCH); assert.equal(e.words, 1005);
  assert.equal(createHash('sha256').update(e.block).digest('hex'), createHash('sha256').update(again.block).digest('hex'));
  const lines = e.block.split('\n');
  assert.equal(lines[0], `  "${CREDENTIAL_PATCH}":`);
  assert.deepEqual(lines.slice(1, 5), ['    Games:', '      "NCAA Football 14":', '        BLUS31159: [ 01.00, 01.02 ]', '    Author: "football-sim-project"']);
  assert.match(lines[5]!, /^    Notes: "[^"]*TestUser1[^"]*"$/);
  assert.deepEqual(lines.slice(6, 8), ['    Patch Version: 1.0', '    Patch:']);
  const words = lines.slice(8, -1);
  assert.equal(words.length, 1005); assert.equal(lines.at(-1), '');
  for (const l of words) assert.match(l, /^      - \[ be32, 0x[0-9a-f]{8}, 0x[0-9a-f]{8} \]$/);
  const addrs = patchAddresses(e.block);
  assert.deepEqual(addrs, [...addrs].sort((a, b) => a - b)); assert.equal(new Set(addrs).size, addrs.length);
  assert.equal(createHash('sha256').update(e.block).digest('hex'), '76ddb2bcb424d26574b5354c9283a519f28d6fe6b538ff0e66d9c5db0172645d');
});
test('patch entry: the credential is exactly what the GetTicket lines store, and appears nowhere else', () => {
  const t = template(), p = profile(), e = credentialPatchEntry(t, p), a = assemble(t, p);
  const written = new Map([...e.block.matchAll(/be32, (0x[0-9a-f]{8}), (0x[0-9a-f]{8})/g)].map((m) => [Number(m[1]), Number(m[2])]));
  const run = (range: [number, number]) => { const out: number[] = []; for (let va = range[0]; va < range[1]; va += 4) out.push(written.get(va)!); return out; };
  assert.deepEqual(decodeByteStores(run(a.ticketStore)), fakeTicket(1), 'the 72 bytes GetTicket copies out');
  assert.equal(e.credentialSha256, createHash('sha256').update(fakeTicket(1)).digest('hex'));
  noSecret(e.block); // not as text (hex or base64) anywhere, the notes included
  // everything outside the ticket store and the digest store is identical for a different credential of the same shape
  const other = credentialPatchEntry(t, { ...p, ticketHex: Buffer.concat([fakeTicket(1).subarray(0, 8), Buffer.from(fakeTicket(1).subarray(8).map((v: number) => v ^ 0x5a))]).toString('hex') });
  const la = e.block.split('\n'), lb = other.block.split('\n'); assert.equal(la.length, lb.length);
  const inStore = (va: number) => (va >= a.ticketStore[0] && va < a.ticketStore[1]) || (va >= a.digestStore[0] && va < a.digestStore[1]);
  let differing = 0;
  la.forEach((l, i) => { if (l !== lb[i]) { differing++; assert.ok(inStore(Number(/be32, (0x[0-9a-f]{8})/.exec(l)![1])), `line ${i} differs outside the credential stores`); } });
  assert.ok(differing >= 64);
  // the state area is never written by the patch (RPCS3 maps it zero-filled)
  assert.ok([...written.keys()].every((va) => va < t.stateVa || va >= t.stateVa + 128));
});
test('patch entry: a mod patch that touches the adapter is reported', () => {
  const t = template();
  assert.deepEqual(adapterConflicts(t, [{ name: 'fine', block: '      - [ be32, 0x00453914, 0x3e0001c8 ]\n' }]), []);
  assert.equal(adapterConflicts(t, [{ name: 'site', block: `      - [ be32, 0x${t.sites.GetTicket![0]!.toString(16).padStart(8, '0')}, 0x60000000 ]\n` }]).length, 1);
  assert.equal(adapterConflicts(t, [{ name: 'cave', block: `      - [ be32, 0x${(t.codeVa + 0x100).toString(16).padStart(8, '0')}, 0x60000000 ]\n` }]).length, 1);
  assert.equal(adapterConflicts(t, [{ name: 'retain', block: '      - [ be32, 0x00719560, 0x60000000 ]\n' }]).length, 1);
});

// ---- RPCS3's patch files, as samples ------------------------------------------------------------------------------------------
const HASH = 'PPU-62e25ebc1957382b34f2778554943e40d6d84e3c', OTHER = 'PPU-0000000000000000000000000000000000000001';
const modEntry = (name: string, word = '0x3e0001c8') => ({ name, block: `  "${name}":\n    Games:\n      "NCAA Football 14":\n        BLUS31159: [ 01.00, 01.02 ]\n    Author: "football-sim-project"\n    Notes: "test"\n    Patch Version: 1.0\n    Patch:\n      - [ be32, 0x00453914, ${word} ]\n` });
const otherGame = `${OTHER}:\n  "Some other game: 60 FPS":\n    Games:\n      "Other":\n        BLES00000: [ All ]\n    Author: "someone"\n    Patch Version: 1.0\n    Patch:\n      - [ be32, 0x00010000, 0x60000000 ]\n`;
test('imported_patch.yml: created, merged by name, idempotent, written the way the wizard always wrote it', () => {
  const a = modEntry('FCS mod: jersey #0'), b = modEntry('FCS mod: 100-player rosters'), cred = credentialPatchEntry(template(), profile());
  const first = mergePatchEntries(null, HASH, [a, b]);
  assert.equal(first.text, `Version: 1.2\n\n${HASH}:\n${a.block}${b.block}`);
  assert.deepEqual(first.changed, [a.name, b.name]);
  const second = mergePatchEntries(first.text, HASH, [a, b]);
  assert.equal(second.text, first.text); assert.deepEqual(second.changed, []); assert.deepEqual(second.kept, [a.name, b.name]);
  const third = mergePatchEntries(first.text, HASH, [a, b, cred]);
  assert.equal(third.text, first.text + cred.block); assert.deepEqual(third.changed, [CREDENTIAL_PATCH]);
  assert.equal(patchEntryState(third.text, HASH, cred), 'current');
  assert.equal(patchEntryState(third.text, HASH, credentialPatchEntry(template(), profile(2))), 'different');
  assert.equal(patchEntryState(first.text, HASH, cred), 'missing');
  // a new profile replaces the entry in place: one entry, the new one
  const fourth = mergePatchEntries(third.text, HASH, [a, b, credentialPatchEntry(template(), profile(2))]);
  assert.equal(fourth.text.split(`"${CREDENTIAL_PATCH}"`).length, 2);
  assert.equal(patchEntryState(fourth.text, HASH, credentialPatchEntry(template(), profile(2))), 'current');
  noSecret(fourth.text);
  // an updated mod entry is replaced, the others keep their place
  const fifth = mergePatchEntries(third.text, HASH, [modEntry(a.name, '0x60000000'), b]);
  assert.deepEqual(fifth.changed, [a.name]);
  assert.equal(fifth.text, `Version: 1.2\n\n${HASH}:\n${modEntry(a.name, '0x60000000').block}${b.block}${cred.block}`);
});
test('imported_patch.yml: other games\' sections, comments and CRLF survive; removal takes only the personal entry', () => {
  const a = modEntry('FCS mod: jersey #0'), cred = credentialPatchEntry(template(), profile());
  const before = `Version: 1.2\n\n# my patches\n${HASH}:\n${a.block}\n${otherGame}`;
  const merged = mergePatchEntries(before, HASH, [a, cred]);
  assert.equal(merged.text, `Version: 1.2\n\n# my patches\n${HASH}:\n${a.block}${cred.block}\n${otherGame}`);
  // our section comes after another game's, and the file has no section for us yet
  const appended = mergePatchEntries(`Version: 1.2\n\n${otherGame}`, HASH, [a]);
  assert.equal(appended.text, `Version: 1.2\n\n${otherGame}\n${HASH}:\n${a.block}`);
  // CRLF file stays CRLF
  const crlf = mergePatchEntries(before.replace(/\n/g, '\r\n'), HASH, [a, cred]);
  assert.equal(crlf.text, merged.text.replace(/\n/g, '\r\n'));
  // removal: what a backup copy and signout hold
  const removed = removePatchEntry(merged.text, HASH, CREDENTIAL_PATCH);
  assert.equal(removed.removed, true); assert.equal(removed.text, before);
  assert.equal(patchEntryBlock(removed.text, HASH, CREDENTIAL_PATCH), null);
  noSecret(removed.text); assert.ok(!removed.text.includes('league sign-in'));
  assert.deepEqual(removePatchEntry(removed.text, HASH, CREDENTIAL_PATCH), { text: removed.text, removed: false });
  assert.equal(patchEntryBlock(merged.text, OTHER, 'Some other game: 60 FPS'), otherGame.split('\n').slice(1).join('\n'));
});
test('patch_config.yml: entries enabled in this game\'s section only; a ticked-off entry is ticked again', () => {
  const names = ['FCS mod: jersey #0', CREDENTIAL_PATCH];
  const block = (n: string) => `  "${n}":\n    NCAA Football 14:\n      BLUS31159:\n        01.00:\n          Enabled: true\n        01.02:\n          Enabled: true\n`;
  const fresh = enablePatchEntries(null, HASH, names);
  assert.equal(fresh.text, `${HASH}:\n${block(names[0]!)}${block(names[1]!)}`);
  assert.deepEqual(enablePatchEntries(fresh.text, HASH, names), { text: fresh.text, changed: [] });
  const other = `${OTHER}:\n  "Some other game: 60 FPS":\n    Other:\n      BLES00000:\n        All:\n          Enabled: true\n`;
  const off = `${other}${HASH}:\r\n${block(names[0]!).replace('01.02:\n          Enabled: true', '01.02:\n          Enabled: false')}`.replace(/\r?\n/g, '\r\n');
  assert.equal(isPatchEnabled(off, HASH, names[0]!), false); assert.equal(isPatchEnabled(off, HASH, names[1]!), false);
  const on = enablePatchEntries(off, HASH, names);
  assert.deepEqual(on.changed, names);
  assert.equal(on.text, `${other}${HASH}:\n${block(names[0]!)}${block(names[1]!)}`.replace(/\n/g, '\r\n'));
  assert.equal(isPatchEnabled(on.text, HASH, names[0]!), true); assert.equal(isPatchEnabled(on.text, HASH, names[1]!), true);
  assert.equal(isPatchEnabled(on.text, OTHER, 'Some other game: 60 FPS'), true);
  assert.equal(isPatchEnabled(removePatchEntry(on.text, HASH, CREDENTIAL_PATCH).text, HASH, CREDENTIAL_PATCH), false);
});

// ---- the game's custom config -------------------------------------------------------------------------------------------------
const CONFIG = ['Core:', '  PPU Decoder: Recompiler (LLVM)', '  PPU Threads: 2', 'Net:', '  Internet enabled: Connected', '  IP address: 0.0.0.0', '  Bind address: 0.0.0.0', '  DNS address: 8.8.8.8',
  '  IP swap list: "gosredirector.ea.com=192.168.1.20&&*.ea.com=192.168.1.20"', '  UPNP Enabled: false', '  PSN status: RPCN', '  PSN Country: us', 'Miscellaneous:', '  Automatically start games after boot: true', ''].join('\n');
test('custom config: the three Net settings change, nothing else does', () => {
  const out = applyOnlineNet(CONFIG, '203.0.113.7');
  const want = CONFIG.replace('192.168.1.20&&*.ea.com=192.168.1.20', '203.0.113.7&&*.ea.com=203.0.113.7').replace('PSN status: RPCN', 'PSN status: Disconnected');
  assert.equal(out, want);
  assert.equal(applyOnlineNet(out, '203.0.113.7'), out, 'second run changes nothing');
  assert.equal(applyOnlineNet(CONFIG.replace(/\n/g, '\r\n'), '203.0.113.7'), want.replace(/\n/g, '\r\n'), 'CRLF kept');
  assert.equal(applyOnlineNet(CONFIG, '203.0.113.7', 'Simulated'), want.replace('PSN status: Disconnected', 'PSN status: Simulated'));
  assert.deepEqual(readNetState(out), { exists: true, internet: 'Connected', psn: 'Disconnected', swap: 'gosredirector.ea.com=203.0.113.7&&*.ea.com=203.0.113.7', serverIp: '203.0.113.7' });
  // RPCS3 reads the right-hand side with inet_pton: a host name must never be written there
  assert.throws(() => applyOnlineNet(CONFIG, 'play.example.test'), /IPv4/);
  assert.throws(() => applyOnlineNet(CONFIG, '203.0.113.700'), /IPv4/);
});
test('custom config: disabled network, missing keys, missing section', () => {
  const off = CONFIG.replace('Internet enabled: Connected', 'Internet enabled: Disconnected').replace('  IP swap list: "gosredirector.ea.com=192.168.1.20&&*.ea.com=192.168.1.20"\n', '').replace('  PSN status: RPCN\n', '');
  const s = readNetState(applyOnlineNet(off, '198.51.100.9'));
  assert.deepEqual([s.internet, s.psn, s.serverIp], ['Connected', 'Disconnected', '198.51.100.9']);
  assert.ok(applyOnlineNet(off, '198.51.100.9').includes('Miscellaneous:\n  Automatically start games after boot: true\n'));
  const none = applyOnlineNet('Core:\n  PPU Threads: 2\n', '198.51.100.9');
  assert.ok(none.startsWith('Core:\n  PPU Threads: 2\nNet:\n')); assert.equal(readNetState(none).serverIp, '198.51.100.9'); assert.equal(readNetState(none).psn, 'Disconnected');
  assert.equal(readNetState(applyOnlineNet('', '198.51.100.9')).internet, 'Connected');
  assert.equal(setYamlKey('Net:\n  PSN status: RPCN\nNetwork Extra:\n  PSN status: keep\n', 'Net', 'PSN status', 'Disconnected'), 'Net:\n  PSN status: Disconnected\nNetwork Extra:\n  PSN status: keep\n');
});
test('custom config on disk: existing file backed up and rewritten; a missing one is made from the global settings', () => {
  const dir = tmp();
  try {
    const backups: string[] = [], backup = (f: string) => { const b = `${f}.bak-test`; fs.copyFileSync(f, b); backups.push(b); return b; };
    fs.mkdirSync(path.join(dir, 'config', 'custom_configs'), { recursive: true });
    fs.writeFileSync(customConfigPath(dir), CONFIG);
    const r = configureOnlineNet(dir, '203.0.113.7', 'Disconnected', backup);
    assert.deepEqual([r.created, r.changed, r.before.psn, r.before.serverIp], ['no', true, 'RPCN', '192.168.1.20']);
    assert.equal(fs.readFileSync(backups[0]!, 'utf8'), CONFIG);
    assert.equal(readNetState(fs.readFileSync(customConfigPath(dir), 'utf8')).psn, 'Disconnected');
    const again = configureOnlineNet(dir, '203.0.113.7', 'Disconnected', backup);
    assert.equal(again.changed, false); assert.equal(backups.length, 1);
    // no custom config yet, global config.yml present
    fs.rmSync(customConfigPath(dir)); fs.writeFileSync(path.join(dir, 'config', 'config.yml'), CONFIG.replace('PPU Threads: 2', 'PPU Threads: 3'));
    const made = configureOnlineNet(dir, '203.0.113.7', 'Disconnected', backup);
    assert.equal(made.created, 'from-global'); assert.ok(fs.readFileSync(customConfigPath(dir), 'utf8').includes('PPU Threads: 3'));
    assert.equal(fs.readFileSync(path.join(dir, 'config', 'config.yml'), 'utf8').includes('PSN status: RPCN'), true, 'the global settings are not touched');
    // nothing at all
    fs.rmSync(path.join(dir, 'config'), { recursive: true });
    assert.equal(configureOnlineNet(dir, '203.0.113.7', 'Disconnected', backup).created, 'minimal');
    assert.equal(fs.readFileSync(customConfigPath(dir), 'utf8'), 'Net:\n  IP swap list: "gosredirector.ea.com=203.0.113.7&&*.ea.com=203.0.113.7"\n  PSN status: Disconnected\n  Internet enabled: Connected\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- connection check, against ports opened here ----------------------------------------------------------------------------------
const listenTcp = () => new Promise<net.Server>((resolve) => { const s = net.createServer((c) => c.destroy()); s.listen(0, '127.0.0.1', () => resolve(s)); });
const closedTcpPort = async () => { const s = await listenTcp(), port = (s.address() as net.AddressInfo).port; await new Promise((r) => s.close(r)); return port; };
const listenQos = (answer: boolean) => new Promise<dgram.Socket>((resolve) => {
  const s = dgram.createSocket('udp4');
  s.on('message', (msg, r) => { if (!answer) return; const out = Buffer.alloc(30); msg.copy(out, 0, 0, 20); s.send(out, r.port, r.address); }); // the reply shape of server/qos.mjs
  s.bind(0, '127.0.0.1', () => resolve(s));
});
const portOf = (s: net.Server | dgram.Socket) => (s.address() as net.AddressInfo).port;
test('connection check: every port answers -> ready; an optional port that is off does not matter', async () => {
  const a = await listenTcp(), b = await listenTcp(), q = await listenQos(true), off = await closedTcpPort();
  try {
    const ports: PortSpec[] = [{ proto: 'tcp', port: portOf(a), what: 'sign-in directory', required: true }, { proto: 'tcp', port: portOf(b), what: 'league server', required: true },
      { proto: 'udp', port: portOf(q), what: 'QoS ping', required: true }, { proto: 'tcp', port: off, what: 'Dynasty Wire', required: false }];
    const c = await checkServer('localhost', { ports, timeoutMs: 1500, lookup: async () => '127.0.0.1' }), v = verdict(c);
    assert.equal(c.ip, '127.0.0.1'); assert.deepEqual(c.probes.map((p) => p.ok), [true, true, true, false]);
    assert.equal(v.ready, true); assert.match(v.headline, /^YOU'RE READY/); assert.match(v.fix!, /Dynasty Wire is switched off/);
    assert.equal(v.lines.length, 4); assert.match(v.lines[3]!, /^off/);
  } finally { a.close(); b.close(); q.close(); }
});
test('connection check: each failure gets its own fix', async () => {
  const a = await listenTcp(), q = await listenQos(true), silent = await listenQos(false), closed = await closedTcpPort(), closed2 = await closedTcpPort();
  const spec = (proto: 'tcp' | 'udp', port: number): PortSpec => ({ proto, port, what: `${proto} service`, required: true });
  try {
    // UDP gets no reply, TCP fine
    let v = verdict(await checkServer('127.0.0.1', { ports: [spec('tcp', portOf(a)), spec('udp', portOf(silent))], timeoutMs: 900 }));
    assert.equal(v.ready, false); assert.match(v.headline, new RegExp(`UDP ${portOf(silent)} gets no reply`)); assert.match(v.fix!, /UDP is being blocked/);
    // one TCP service down on a server that is up
    v = verdict(await checkServer('127.0.0.1', { ports: [spec('tcp', portOf(a)), spec('tcp', closed), spec('udp', portOf(q))], timeoutMs: 6000 }));
    assert.equal(v.ready, false); assert.match(v.headline, new RegExp(`part of it is not running \\(TCP ${closed}\\)`)); assert.match(v.fix!, /Nothing to fix on this PC/);
    assert.match(v.lines[1]!, /^FAILED  TCP \d+\s+tcp service: nothing is listening there$/);
    // nothing listening at all
    v = verdict(await checkServer('127.0.0.1', { ports: [spec('tcp', closed), spec('tcp', closed2)], timeoutMs: 6000 }));
    assert.equal(v.ready, false); assert.match(v.headline, /the league server is not running on it/);
    // the name does not resolve
    const c = await checkServer('play.example.test', { ports: [spec('tcp', portOf(a))], timeoutMs: 900, lookup: async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); } });
    assert.equal(c.ip, null); assert.equal(c.probes.length, 0);
    v = verdict(c); assert.equal(v.ready, false); assert.match(v.headline, /play\.example\.test could not be looked up \(ENOTFOUND\)/); assert.match(v.fix!, /on the internet/);
    // an IPv4 literal needs no lookup
    assert.equal((await checkServer('127.0.0.1', { ports: [spec('tcp', portOf(a))], timeoutMs: 900, lookup: async () => { throw new Error('must not be called'); } })).ip, '127.0.0.1');
  } finally { a.close(); q.close(); silent.close(); }
});
test('connection check: verdict wording for a firewall that drops everything, and for a partial block', () => {
  const p = (proto: 'tcp' | 'udp', port: number, ok: boolean, failure?: 'timeout' | 'refused' | 'unreachable') => ({ proto, port, what: 'x', required: true, ok, ms: 1, ...(failure ? { failure } : {}) });
  let v = verdict({ host: 'h', ip: '203.0.113.7', probes: [p('tcp', 42127, false, 'timeout'), p('tcp', 33152, false, 'timeout'), p('udp', 17502, false, 'timeout')] });
  assert.match(v.headline, /nothing at h \(203\.0\.113\.7\) answers/); assert.match(v.fix!, /VPN/);
  v = verdict({ host: 'h', ip: '203.0.113.7', probes: [p('tcp', 42127, true), p('tcp', 17503, false, 'timeout'), p('udp', 17502, true)] });
  assert.match(v.headline, /not on TCP 17503/);
  v = verdict({ host: 'h', ip: '203.0.113.7', probes: [p('tcp', 42127, false, 'unreachable'), p('udp', 17502, false, 'unreachable')] });
  assert.match(v.headline, /no route to the internet/);
});
test('server moved: said plainly, with the one command that fixes it', () => {
  assert.equal(addressDrift('play.example.test', '203.0.113.7', '203.0.113.7'), null);
  assert.equal(addressDrift('play.example.test', null, '203.0.113.7'), null, 'the name does not resolve: the lookup verdict covers it');
  assert.equal(addressDrift('play.example.test', '203.0.113.7', null), null, 'the game has no address yet: not a move');
  const d = addressDrift('play.example.test', '203.0.113.9', '203.0.113.7')!;
  assert.equal(d.headline, 'NOT READY: the league server has moved. play.example.test is now at 203.0.113.9, but the game on this PC is still set to the old address 203.0.113.7.');
  assert.equal(d.fix, 'Run this to fix it (close RPCS3 first): FCS-online.exe join'); assert.equal(FIX_COMMAND, 'FCS-online.exe join');
  assert.match(addressDrift('203.0.113.9', '203.0.113.9', '203.0.113.7')!.headline, /Its address is 203\.0\.113\.9, but the game on this PC is still set to the old address 203\.0\.113\.7/);
});

// ---- whose profile it is ------------------------------------------------------------------------------------------------
test('identity: the name and member number are shown, a replaced profile is named, the key never is', () => {
  const a = profile(1), b = profile(2);
  assert.equal(identityOf(a), 'TestUser1 (member number 700101)');
  assert.match(OWN_CODE_RULE, /your own account page/); assert.ok(!OWN_CODE_RULE.includes('\n'), 'one plain sentence');
  assert.deepEqual(profileChange(null, a), { kind: 'none' });
  assert.deepEqual(profileChange(a, { ...a }), { kind: 'same' });
  const other = profileChange(a, b);
  assert.equal(other.kind, 'different');
  assert.match(other.line!, /^This PC is set up for TestUser1 \(member number 700101\)\. Continuing REPLACES that profile with TestUser2 \(member number 700102\)/);
  const renewed = profileChange(a, { ...a, ticketHex: b.ticketHex });
  assert.equal(renewed.kind, 'renewed'); assert.match(renewed.line!, /same member \(TestUser1 \(member number 700101\), key fingerprint [0-9a-f]{8}\) with the new one \(key fingerprint [0-9a-f]{8}\)/);
  const renamed = profileChange(a, { ...a, onlineId: 'NewName1' });
  assert.equal(renamed.kind, 'renewed'); assert.match(renamed.line!, /now named NewName1/);
  // the same name on another member number is another member
  assert.equal(profileChange(a, { ...a, userId: a.userId + 1 }).kind, 'different');
  for (const line of [other.line!, renewed.line!, renamed.line!, identityOf(a), describeProfile(b, NOW)]) noSecrets(line, a, b);
});

// ---- the server name ------------------------------------------------------------------------------------------------------
test('server names: only the league\'s own name counts as official; look-alikes, punycode, dots, credentials and ports do not', () => {
  const site = 'fcs-mod.online';
  for (const ok of ['fcs-mod.online', 'play.fcs-mod.online', 'PLAY.FCS-MOD.ONLINE', 'Play.Fcs-Mod.Online', 'a.b.fcs-mod.online']) assert.equal(isOfficialServer(ok, site), true, ok);
  assert.equal(isOfficialServer('play.FCS-MOD.online', 'FCS-mod.Online'), true, 'both sides are compared in lower case');
  const no = [
    'fcs-mod.online.', 'play.fcs-mod.online.', '.fcs-mod.online',                                 // dots
    'evilfcs-mod.online', 'fcs-mod.online.evil.example', 'fcs-mod.onl1ne', 'fcs-mod.online-x.example', 'mod.online', 'online',
    'xn--fcs-md-abc.online', 'xn--play-abc.fcs-mod.online', 'play.XN--fcsmod-abc.online', 'a.xn--b.fcs-mod.online', // punycode, anywhere
    'fcs-m\u043ed.online', 'pl\u0430y.fcs-mod.online', '\uff46cs-mod.online', 'fcs-mod\u3002online', 'fcs\u2010mod.online', 'play.fcs-mod.online\u200b', // look-alike letters and dots
    'play.fcs-mod.online:42127', 'user@fcs-mod.online', 'user:pw@play.fcs-mod.online', 'fcs-mod.online@evil.example', 'fcs-mod.online:pw@evil.example',
    'http://fcs-mod.online', '//fcs-mod.online', 'fcs-mod.online/x', 'evil.example/.fcs-mod.online', 'evil.example#.fcs-mod.online', 'evil.example?.fcs-mod.online', 'evil.example\\.fcs-mod.online',
    ' fcs-mod.online', 'fcs-mod.online ', 'fcs-mod.online\n', 'fcs-mod.online\t', 'evil.example\0.fcs-mod.online', '',
    '203.0.113.7', '127.0.0.1',
  ];
  for (const host of no) assert.equal(isOfficialServer(host, site), false, JSON.stringify(host));
  assert.equal(isPunycodeName('a.XN--b.example'), true); assert.equal(isPunycodeName('axn--b.example'), false);
  // what a profile (or --server) may hold at all: a plain host name or an ordinary IPv4 address
  for (const fine of ['play.example.test', 'PLAY.example.test', '203.0.113.7', 'xn--play-abc.example.test']) assert.equal(serverNameProblem(fine), null, fine);
  for (const bad of ['play.example.test.', 'user@play.example.test', 'play.example.test:42127', 'pl\u0430y.example.test', '\u212Aplay.example.test', '2130706433', '0x7f000001', '127.1', '1.2.3.256', 'a.b.0x10', 'http://x', 'a b', '', '-a.example', 'a..b', 7, null, undefined]) assert.equal(typeof serverNameProblem(bad), 'string', JSON.stringify(bad));
  // the profile check uses the same rules, and never lets a look-alike letter turn into a plain one
  const p = profile(), bad = (server: unknown) => codeOf(() => validateProfile({ ...p, server }, NOW));
  for (const server of ['play.example.test.', 'user@play.example.test', 'user:pw@play.example.test', 'pl\u0430y.example.test', '\u212Aplay.example.test', '2130706433', '0x7f.1']) assert.equal(bad(server), 'bad-server', JSON.stringify(server));
  assert.equal(validateProfile({ ...p, server: 'XN--play-abc.Example.Test' }, NOW).server, 'xn--play-abc.example.test', 'kept as a name, but never official');
});

// ---- what reaches a message, a file name or a command ----------------------------------------------------------------------------
test('input: a join code is never taken as a path or repeated in a message; oversized and linked files are left alone', () => {
  const p = profile(), code = joinCode(p), dir = tmp();
  try {
    assert.deepEqual(readProfileText(code, NOW), { profile: p, source: 'code' });
    assert.deepEqual(readProfileText(JSON.stringify(p), NOW), { profile: p, source: 'json' });
    assert.equal(codeOf(() => readProfileText(path.join(dir, 'fcs-online-profile.json'), NOW)), 'not-a-code', '--code and standard input take no file path');
    assert.equal(codeOf(() => readProfileText(`FCS1-${'A'.repeat(70000)}`, NOW)), 'not-a-code');
    // a code typed where a file name belongs (--profile FCS1-..., or the path prompt)
    for (const wrong of [code, `${code}.json`, `C:\\Users\\me\\${code}`, JSON.stringify(p), p.ticketHex]) {
      try { readProfileFile(wrong, NOW); assert.fail('read a file that is not there'); }
      catch (e) { assert.ok(e instanceof ProfileError, String(e)); assert.equal(e.code, 'no-file'); assert.match(e.message, /Cannot read that file/); noSecrets(e.message, p); }
      assert.equal(shownPath(wrong), 'that file');
    }
    assert.equal(shownPath('C:\\Users\\me\\Downloads\\fcs-online-profile (2).json'), 'C:\\Users\\me\\Downloads\\fcs-online-profile (2).json');
    assert.equal(shownPath('a\u001b[2Jb.json'), 'that file', 'no console control characters');
    assert.equal(shownPath('x'.repeat(201)), 'that file');
    // downloaded profiles: ordinary small files only
    fs.writeFileSync(path.join(dir, 'fcs-online-profile.json'), JSON.stringify(p));
    fs.writeFileSync(path.join(dir, 'fcs-online-profile (1).json'), ' '.repeat(70000) + JSON.stringify(p));
    fs.mkdirSync(path.join(dir, 'fcs-online-profile (2).json'));
    fs.writeFileSync(path.join(dir, 'fcs-online-profile.json.exe'), 'x');
    assert.deepEqual(findDownloadedProfiles([dir, path.join(dir, 'missing')]), [path.join(dir, 'fcs-online-profile.json')]);
    assert.equal(codeOf(() => readProfileFile(path.join(dir, 'fcs-online-profile (1).json'), NOW)), 'no-file', 'far too big to be a profile');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('storage: no temporary file survives, the note about the last join holds no key and is checked when read', () => {
  const dir = tmp(), store = path.join(dir, 'store');
  try {
    const p = profile();
    fs.mkdirSync(store); fs.writeFileSync(path.join(store, 'fcs-online-profile.json.tmp'), JSON.stringify(profile(2))); fs.writeFileSync(path.join(store, 'fcs-online-profile.json.0123abcd.tmp'), 'left over');
    saveProfile(p, store);
    assert.deepEqual(fs.readdirSync(store), ['fcs-online-profile.json'], 'temporary files of an interrupted run are removed');
    assert.deepEqual(loadStoredProfile(store), p);
    saveProfile(profile(2), store); assert.deepEqual(loadStoredProfile(store), profile(2), 'a new profile replaces the saved one'); assert.deepEqual(fs.readdirSync(store), ['fcs-online-profile.json']);
    assert.equal(loadInstallNote(store), null);
    saveInstallNote({ rpcs3: dir, server: 'Play.Example.Test', ip: '203.0.113.7', at: 5 }, store);
    assert.deepEqual(loadInstallNote(store), { rpcs3: dir, server: 'play.example.test', ip: '203.0.113.7', at: 5 });
    noSecrets(fs.readFileSync(path.join(store, 'last-join.json'), 'utf8'), p, profile(2));
    for (const bad of [{ rpcs3: 'relative\\rpcs3', server: 'play.example.test', ip: '203.0.113.7' }, { rpcs3: dir, server: 'play.example.test:1', ip: '203.0.113.7' }, { rpcs3: dir, server: 'play.example.test', ip: 'play.example.test' }, { rpcs3: dir, server: 'pl\u0430y.example.test', ip: '203.0.113.7' }, [1]]) {
      fs.writeFileSync(path.join(store, 'last-join.json'), JSON.stringify(bad)); assert.equal(loadInstallNote(store), null, JSON.stringify(bad));
    }
    fs.writeFileSync(path.join(store, 'last-join.json'), '{'); assert.equal(loadInstallNote(store), null);
    assert.equal(forgetProfile(store), true); assert.deepEqual(fs.readdirSync(store), [], 'signout leaves nothing behind');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- programs the wizard starts -----------------------------------------------------------------------------------------------
test('programs: Windows tools by full path under the system folder; a bare name, a relative path and a shell are refused', { skip: !win }, () => {
  const root = systemRoot();
  assert.match(root, /^[A-Za-z]:\\[^\\]/); assert.ok(fs.existsSync(path.join(root, 'System32')));
  assert.equal(systemRoot({ SystemRoot: 'D:\\Win' }, (r) => r === 'D:\\Win'), 'D:\\Win');
  assert.equal(systemRoot({ windir: 'D:\\Win\\' }, () => true), 'D:\\Win', 'windir is the second choice');
  assert.equal(systemRoot({}, () => true), 'C:\\Windows', 'no variable: the fallback');
  assert.equal(systemRoot({ SystemRoot: 'D:\\Gone' }, () => false), 'C:\\Windows', 'not a Windows folder: the fallback');
  for (const bad of ['.', 'Windows', '..\\Windows', '\\\\server\\share\\Windows', '\\Windows', 'C:Windows', 'C:\\Win"dows', 'C:\\Windows;D:\\x', 'C:\\Win\ndows', 'C:\\a|b']) assert.equal(systemRoot({ SystemRoot: bad }, () => true), 'C:\\Windows', bad);
  assert.equal(systemDir().toLowerCase(), path.join(root, 'System32').toLowerCase());
  const icacls = systemTool('icacls')!;
  assert.equal(icacls.toLowerCase(), path.join(root, 'System32', 'icacls.exe').toLowerCase()); assert.ok(fs.statSync(icacls).isFile());
  assert.equal(systemTool('ICACLS.EXE'), icacls);
  for (const name of ['cmd', 'cmd.exe', 'notepad', 'node', 'where', '']) assert.equal(systemTool(name), null, name);
  assert.deepEqual(resolveCommand('tasklist'), { file: path.win32.join(systemDir(), 'tasklist.exe'), system: true });
  assert.match(resolveCommand('powershell').file, /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
  assert.deepEqual(resolveCommand(process.execPath), { file: path.win32.normalize(process.execPath), system: false });
  for (const bad of ['cmd', 'cmd.exe', 'node', 'npm', 'npm.cmd', 'icacls.cmd', '.\\icacls.exe', 'sub\\icacls.exe', '..\\icacls.exe', '/icacls', 'C:icacls.exe', 'C:\\no\\such\\folder\\icacls.exe', 'ica"cls', '']) assert.throws(() => resolveCommand(bad), RefusedCommand, JSON.stringify(bad));
  // the launchers: nothing starts for a refused name, a shell command line never starts, shell: true is dropped
  assert.throws(() => spawnSync('cmd', ['/c', 'echo', 'x']), RefusedCommand);
  assert.throws(() => spawn('node', ['--version']), RefusedCommand);
  assert.throws(() => execFileSync('whoami', []), RefusedCommand);
  assert.throws(() => exec('dir'), RefusedCommand);
  const r = spawnSync('tasklist', ['/?', '&', 'echo', 'SHELL-RAN'], { encoding: 'utf8', shell: true, cwd: os.tmpdir() });
  assert.ok(!/^SHELL-RAN\s*$/m.test(String(r.stdout)), 'no shell read the arguments: "& echo" stayed plain text for tasklist');
  assert.notEqual(r.status, 0, 'tasklist itself rejects them');
  assert.match(String(execFileSync('tasklist', ['/?'], { encoding: 'utf8' })), /TASKLIST/i);
});
test('programs: a file named like a Windows tool in the current folder is not what runs', { skip: !win }, () => {
  const dir = tmp(), was = process.cwd();
  try {
    // "icacls" planted where the wizard is started from: another real program under that name, and a script
    fs.copyFileSync(path.join(systemDir(), 'hostname.exe'), path.join(dir, 'icacls.exe'));
    fs.writeFileSync(path.join(dir, 'icacls.cmd'), '@echo PLANTED> "%~dp0planted-ran.txt"\r\n@exit /b 0\r\n');
    fs.writeFileSync(path.join(dir, 'icacls.bat'), '@echo PLANTED> "%~dp0planted-ran.txt"\r\n@exit /b 0\r\n');
    const target = path.join(dir, 'secret.txt'); fs.writeFileSync(target, 'x');
    process.chdir(dir);
    assert.equal(resolveCommand('icacls').file.toLowerCase(), path.join(systemRoot(), 'System32', 'icacls.exe').toLowerCase());
    assert.equal(restrictToUser(target, false), true, 'the real icacls ran');
    assert.ok(userOnly(target), 'and the access list really changed');
    assert.equal(inheritAccess(target), true); assert.match(aclOf(target), /\(I\)/, 'signout: back to the folder\'s own access');
    assert.ok(!fs.existsSync(path.join(dir, 'planted-ran.txt')), 'the planted script did not run');
  } finally { process.chdir(was); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('programs: Node for `host` is looked up on PATH by full folders only; the browser gets http(s) addresses only', () => {
  const dir = tmp(), was = process.cwd();
  try {
    fs.writeFileSync(path.join(dir, 'tool.exe'), ''); fs.mkdirSync(path.join(dir, 'rel')); fs.writeFileSync(path.join(dir, 'rel', 'tool.exe'), '');
    process.chdir(dir);
    assert.equal(findOnPath('tool.exe', { PATH: ['', '.', 'rel', `"${dir}"`].join(path.delimiter) }), path.join(dir, 'tool.exe'), 'only the full folder counts');
    assert.equal(findOnPath('tool.exe', { PATH: ['', '.', 'rel', '.\\rel'].join(path.delimiter) }), null, 'the current folder and relative entries are never searched');
    assert.equal(findOnPath('tool.exe', {}), null);
    assert.equal(findOnPath(`rel${path.sep}tool.exe`, { PATH: dir }), null, 'a name, not a path');
  } finally { process.chdir(was); fs.rmSync(dir, { recursive: true, force: true }); }
  assert.equal(browserUrl('https://fcs-mod.online'), 'https://fcs-mod.online/');
  assert.equal(browserUrl('http://127.0.0.1:5173/?a=1&b=%20x'), 'http://127.0.0.1:5173/?a=1&b=%20x');
  for (const bad of ['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'ms-settings:', 'C:\\Windows\\System32\\calc.exe', 'calc.exe', '\\\\server\\share\\x.exe', 'https://user:pw@fcs-mod.online/', 'https://fcs-mod.online/" & calc', 'https://fcs-mod.online/ x', 'https://fcs-mod.online/\nx', `https://fcs-mod.online/${'a'.repeat(2000)}`, '']) assert.equal(browserUrl(bad), null, JSON.stringify(bad));
  const calls: unknown[][] = [];
  const fake = ((command: string, args: readonly string[]) => { calls.push([command, [...args]]); return { on() { /* no error */ }, unref() { /* detached */ } }; }) as unknown as typeof spawn;
  assert.equal(openInBrowser('file:///C:/x.exe', fake), false); assert.equal(openInBrowser('calc.exe', fake), false); assert.equal(calls.length, 0, 'nothing is started for a refused address');
  if (win) { assert.equal(openInBrowser('http://127.0.0.1:5173/?a=1&b=2', fake), true); assert.deepEqual(calls, [['rundll32', ['url.dll,FileProtocolHandler', 'http://127.0.0.1:5173/?a=1&b=2']]], 'one argument, no shell in between'); }
});

// ---- the download's checksum ------------------------------------------------------------------------------------------------------
test('checksum: the SHA-256 file written next to the exe matches it, and a changed exe is noticed', () => {
  const dir = tmp();
  try {
    const exe = path.join(dir, 'FCS-online.exe'), bytes = Buffer.from(Array.from({ length: 3 * 1048576 + 17 }, (_, i) => (i * 31) & 255));
    fs.writeFileSync(exe, bytes);
    const sha = createHash('sha256').update(bytes).digest('hex'), r = writeChecksum(exe);
    assert.deepEqual(r, { file: `${exe}.sha256`, sha256: sha });
    assert.equal(fs.readFileSync(r.file, 'utf8'), `${sha} *FCS-online.exe\n`);
    assert.deepEqual(verifyChecksum(exe), { ok: true, expected: sha, actual: sha });
    assert.equal(readChecksum(`${sha.toUpperCase()}  FCS-online.exe\r\n`, 'FCS-online.exe'), sha, 'the text-mode form and upper case are read too');
    assert.equal(readChecksum(`${sha} *other.exe\n`, 'FCS-online.exe'), null); assert.equal(readChecksum('not a checksum', 'FCS-online.exe'), null);
    fs.appendFileSync(exe, 'x');
    const changed = verifyChecksum(exe); assert.equal(changed.ok, false); assert.equal(changed.expected, sha); assert.notEqual(changed.actual, sha);
    fs.rmSync(r.file); assert.deepEqual(verifyChecksum(exe), { ok: false, expected: null, actual: changed.actual });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- the whole wizard: the bundle build.mjs makes, on a throwaway RPCS3 folder --------------------------------------------------------
// Runs installer/dist/fcs-online.cjs (node installer/build.mjs --no-exe) with LOCALAPPDATA and USERPROFILE pointed into
// a temporary folder, started from a folder that holds planted "icacls" / "tasklist" / "powershell" files. Made-up
// profiles whose server is 203.0.113.7 (a documentation address nothing answers on); no league server is contacted.
const here = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.join(here, '..', 'dist', 'fcs-online.cjs');
const sources = [path.join(here, '..', 'src', 'main.ts'), ...fs.readdirSync(path.join(here, '..', 'src', 'online')).map((f) => path.join(here, '..', 'src', 'online', f))];
const bundleIsCurrent = fs.existsSync(BUNDLE) && sources.every((f) => fs.statSync(f).mtimeMs <= fs.statSync(BUNDLE).mtimeMs);
test('wizard, end to end: identity shown and confirmed, standard input, refusals, the moved server, signout', { skip: !win ? 'Windows only' : bundleIsCurrent ? false : 'installer/dist/fcs-online.cjs is missing or older than the sources: run node installer/build.mjs --no-exe first' }, () => {
  const root = tmp(), rpcs3 = path.join(root, 'rpcs3'), start = path.join(root, 'Downloads'), local = path.join(root, 'local'), store = path.join(local, 'ncaa-bridge', 'online');
  const patch = path.join(rpcs3, 'patches', 'imported_patch.yml'), config = path.join(rpcs3, 'config', 'custom_configs', 'config_BLUS31159.yml');
  try {
    fs.mkdirSync(path.join(rpcs3, 'dev_hdd0'), { recursive: true }); fs.writeFileSync(path.join(rpcs3, 'rpcs3.exe'), '');
    fs.mkdirSync(start); fs.mkdirSync(local);
    for (const name of ['icacls', 'tasklist', 'powershell', 'rundll32', 'cmd']) {
      fs.copyFileSync(path.join(systemDir(), 'hostname.exe'), path.join(start, `${name}.exe`));
      fs.writeFileSync(path.join(start, `${name}.cmd`), '@echo PLANTED> "%~dp0planted-ran.txt"\r\n');
    }
    const env = { ...process.env, LOCALAPPDATA: local, USERPROFILE: root, HOME: root };
    const p1: OnlineProfile = { ...profile(1), server: '203.0.113.7' }, p2: OnlineProfile = { ...profile(2), server: '203.0.113.7' };
    const run = (args: string[], input = '') => {
      const r = rawChildProcess.spawnSync(process.execPath, [BUNDLE, ...args], { env, input, encoding: 'utf8', cwd: start, timeout: 120000 });
      const out = `${r.stdout}${r.stderr}`; noSecrets(out, p1, p2);
      return { code: r.status, out };
    };
    const base = ['--rpcs3', rpcs3, '--skip-check'];
    const savedId = () => loadStoredProfile(store)?.onlineId ?? null;

    // help: how to hand over a code, and why not on the command line
    let r = run(['help']);
    assert.equal(r.code, 0); assert.match(r.out, /--code -\s+the join code is read from standard input/); assert.match(r.out, /AVOID IT: the code is then visible in the process list/); assert.match(r.out, /--profile FILE/); assert.match(r.out, /own account page/);
    assert.equal(run(['--help']).out, r.out);

    // a profile whose server is not the league's: refused without --trust-server, and nothing is written
    r = run(['join', ...base, '--code', '-', '--yes'], `${joinCode(p1)}\n`);
    assert.equal(r.code, 2); assert.match(r.out, /REFUSED: this profile points the game at 203\.0\.113\.7, which is not the league's server/); assert.match(r.out, /--trust-server/);
    assert.match(r.out, /play online as TestUser1 \(member number 700101\)/, 'whose code it is comes first');
    assert.ok(!fs.existsSync(patch) && !fs.existsSync(config) && savedId() === null, 'nothing was changed');

    // the code from standard input, non-interactive
    r = run(['join', ...base, '--code', '-', '--yes', '--trust-server'], `${joinCode(p1)}\n`);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /This sets the game on this PC up to play online as TestUser1 \(member number 700101\)\./);
    assert.ok(r.out.includes(OWN_CODE_RULE)); assert.match(r.out, /Accepted because of --trust-server/); assert.ok(!/command line can be read/.test(r.out));
    assert.match(r.out, /saved for this Windows account only: /); assert.ok(!/could not/.test(r.out), r.out);
    assert.equal(savedId(), 'TestUser1'); assert.ok(userOnly(path.join(store, 'fcs-online-profile.json')), 'the saved profile is this user\'s only');
    assert.match(fs.readFileSync(patch, 'utf8'), /league sign-in \(personal, do not share\)/); assert.ok(userOnly(patch), 'the patch file holds the key: this user only');
    assert.deepEqual(loadInstallNote(store), { rpcs3, server: '203.0.113.7', ip: '203.0.113.7', at: loadInstallNote(store)!.at });
    assert.match(fs.readFileSync(config, 'utf8'), /IP swap list: "gosredirector\.ea\.com=203\.0\.113\.7&&\*\.ea\.com=203\.0\.113\.7"/);

    // another member's profile, with --yes: installed, and both are named. --code on the command line is called out.
    r = run(['join', ...base, '--code', joinCode(p2), '--yes', '--trust-server']);
    assert.equal(r.code, 0, r.out); assert.match(r.out, /a join code on the command line can be read by other programs/);
    assert.match(r.out, /This PC is set up for TestUser1 \(member number 700101\)\. Continuing REPLACES that profile with TestUser2 \(member number 700102\)/);
    assert.equal(savedId(), 'TestUser2');
    const backups = fs.readdirSync(path.dirname(patch)).filter((f) => f !== 'imported_patch.yml');
    assert.ok(backups.length >= 1); for (const b of backups) assert.ok(!fs.readFileSync(path.join(path.dirname(patch), b), 'utf8').includes('league sign-in'), `${b} keeps the old sign-in`);

    // interactive (answers piped in): the question about replacing another member defaults to No, and No changes nothing
    const file = path.join(start, 'fcs-online-profile.json'); fs.writeFileSync(file, JSON.stringify(p1));
    const before = fs.readFileSync(patch, 'utf8');
    r = run(['join', ...base, '--profile', file, '--trust-server'], '\n');
    assert.equal(r.code, 2, r.out); assert.match(r.out, /Replace it and play as TestUser1\? Say yes only if TestUser1 is your own account on fcs-mod\.online \[y\/N\]/); assert.match(r.out, /Stopped; nothing was changed/);
    assert.equal(savedId(), 'TestUser2'); assert.equal(fs.readFileSync(patch, 'utf8'), before);
    // no answer at all (the input ended): an error, never a silent yes
    r = run(['join', ...base, '--profile', file, '--trust-server'], '');
    assert.equal(r.code, 1); assert.match(r.out, /needs an answer and there is no more input/); assert.equal(savedId(), 'TestUser2');
    // yes: replaced; the downloaded file is offered for deletion (kept here)
    r = run(['join', ...base, '--profile', file, '--trust-server'], 'y\nn\n');
    assert.equal(r.code, 0, r.out); assert.equal(savedId(), 'TestUser1'); assert.ok(fs.existsSync(file)); assert.match(r.out, /works like a password: delete it when you are done/);
    // a join code typed where a file or a mode belongs is not repeated
    r = run(['join', ...base, '--profile', joinCode(p2), '--yes']); assert.equal(r.code, 2); assert.match(r.out, /Cannot read that file/);
    r = run([joinCode(p2)]); assert.equal(r.code, 1); assert.match(r.out, /unknown mode that;/);
    // a look-alike or malformed --server is refused
    r = run(['join', ...base, '--yes', '--server', 'play.fcs-mod.online.']); assert.equal(r.code, 2); assert.match(r.out, /--server .* cannot be used: it ends with a dot/);
    r = run(['check', '--server', 'user@fcs-mod.online']); assert.equal(r.code, 2); assert.match(r.out, /cannot be used: it has a user name or password in it/);

    // the server moves: the game's settings still hold the old address
    fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replaceAll('203.0.113.7', '203.0.113.99'));
    r = run(['check', '--check-timeout', '500']);
    assert.equal(r.code, 2); assert.match(r.out, /NOT READY: the league server has moved\. Its address is 203\.0\.113\.7, but the game on this PC is still set to the old address 203\.0\.113\.99\./);
    assert.match(r.out, /Run this to fix it \(close RPCS3 first\): FCS-online\.exe join/); assert.ok(!/YOU'RE READY/.test(r.out));
    r = run(['status', '--rpcs3', rpcs3, '--check-timeout', '500']);
    assert.equal(r.code, 2); assert.match(r.out, /league server: NOT READY: the league server has moved\./); assert.match(r.out, /Run this to fix it \(close RPCS3 first\): FCS-online\.exe join/);
    assert.match(r.out, /online profile on this PC: TestUser1 on 203\.0\.113\.7/);
    // the one command fixes it (with the profile saved on this PC)
    r = run(['join', ...base, '--yes', '--trust-server']); assert.equal(r.code, 0, r.out);
    assert.match(fs.readFileSync(config, 'utf8'), /gosredirector\.ea\.com=203\.0\.113\.7&&/);
    r = run(['status', '--rpcs3', rpcs3, '--no-check']); assert.equal(r.code, 0); assert.match(r.out, /league sign-in: installed, enabled, matches the profile saved on this PC/);

    // signout: the entry, every copy of it, the saved profile and the note are gone; the patch file is ordinary again
    fs.copyFileSync(patch, path.join(path.dirname(patch), 'imported_patch - Copy.yml'));
    r = run(['signout', '--rpcs3', rpcs3, '--yes']);
    assert.equal(r.code, 0, r.out); assert.match(r.out, /also removed from 1 other copy/);
    for (const f of fs.readdirSync(path.dirname(patch))) assert.ok(!fs.readFileSync(path.join(path.dirname(patch), f), 'utf8').includes('league sign-in'), `${f} still holds the sign-in`);
    assert.match(aclOf(patch), /\(I\)/); assert.deepEqual(fs.readdirSync(store), []);
    assert.ok(!fs.existsSync(path.join(start, 'planted-ran.txt')), 'no planted program ran');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
