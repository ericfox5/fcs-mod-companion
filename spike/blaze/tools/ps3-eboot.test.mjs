import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JERSEY_ZERO_WORDS, ROSTER_STRIDE_WORDS, ROSTER_CAPACITY_WORDS, ROSTER_TABLE_WORDS, LS_GROUP_WORDS, ROSTER_OFFSEASON_WORDS, GENERIC_HOST_WORDS, branch, elfSegments, fileOffset, parseOptions, patchBaseline, rosterStrideWords, rosterCapacityWords, rosterTableWords, lsGroupWords, rosterOffseasonWords, sha256 } from './ps3-eboot.mjs';
import { patchOntoAdapter } from './ps3-eboot-onto.mjs';

const originalPath = new URL('../private/EBOOT.elf', import.meta.url);
const available = fs.existsSync(originalPath);
const strideAvailable = available && fs.existsSync(ROSTER_STRIDE_WORDS);
// the RPCS3 yml, entry by entry: { "<name>": [[va, word], ...] }
function ymlEntries() {
  const yml = fs.readFileSync(new URL('../private/rpcs3-patches.yml', import.meta.url), 'utf8');
  const out = {}; let name = null;
  for (const line of yml.split('\n')) {
    const h = line.match(/^  "(.+)":\s*$/); if (h) { name = h[1]; out[name] = []; continue; }
    const w = line.match(/\[ be32, (0x[0-9a-f]+), (0x[0-9a-f]+) \]/); if (w && name) out[name].push([Number(w[1]), Number(w[2])]);
  }
  return out;
}
const BASE_ENTRIES = ['FCS mod: preseason All-Conference crash fix', 'Online Dynasty: commissioner of up to 5 dynasties', 'FCS mod: jersey #0'];
const STRIDE_ENTRY = 'FCS mod: 100-player rosters';

test('branch encoder refuses truncation and handles both signed boundaries', () => {
  assert.equal(branch(0x2000000, 0), 0x4a000000);
  assert.equal(branch(0, 0x1fffffc, true), 0x49fffffd);
  assert.throws(() => branch(0, 0x2000000));
  assert.throws(() => branch(0, 3));
});
test('address mapping excludes BSS and ambiguous segments', () => {
  const segments = [{ va: 0x10000, offset: 0, size: 100, memory: 200 }];
  assert.equal(fileOffset(segments, 0x10004), 4);
  assert.throws(() => fileOffset(segments, 0x10064));
  assert.throws(() => fileOffset([...segments, ...segments], 0x10004));
});
test('original ELF matches all 45 independently recorded RPCS3 patch words of the three base entries', { skip: !available }, () => {
  const input = fs.readFileSync(originalPath);
  const { output, manifest } = patchBaseline(input, { commissioner: true, jerseyZero: true });
  const entries = ymlEntries();
  const words = BASE_ENTRIES.flatMap(n => { assert.ok(entries[n], `yml entry ${n}`); return entries[n]; });
  assert.equal(words.length, 45);
  const segments = elfSegments(input), touched = new Set();
  for (const [va, value] of words) {
    const o = fileOffset(segments, va);
    assert.equal(output.readUInt32BE(o), value, va.toString(16));
    for (let i = o; i < o + 4; i++) touched.add(i);
  }
  for (let i = 0; i < input.length; i++) if (!touched.has(i)) assert.equal(output[i], input[i], `Unintended change at ${i}`);
  assert.equal(sha256(output), '4c359d8349d0062c0d4c023039a2f32128c7914d3e8247da08b2be9bb1f5ce8b');
  assert.equal(manifest.writes.length, 45);
  assert.equal(manifest.psnDependencyRemoved, false);
  assert.throws(() => patchBaseline(output), /SHA-256/);
  const corrupt = Buffer.from(input); corrupt[0x100] ^= 1;
  assert.throws(() => patchBaseline(corrupt), /SHA-256/);
});
test('offseason-only output leaves the commissioner instruction untouched', { skip: !available }, () => {
  const input = fs.readFileSync(originalPath), { output, manifest } = patchBaseline(input);
  assert.equal(manifest.writes.length, 38);
  assert.equal(output.readUInt32BE(fileOffset(elfSegments(input), 0x341460)), 0x3be00001);
  const segments = elfSegments(input);
  for (const [va, original] of JERSEY_ZERO_WORDS) assert.equal(output.readUInt32BE(fileOffset(segments, va)), original, va.toString(16));
  assert.equal(sha256(output), '6dd5d6e9acc74aef13ac9cd887bd691195f34a15efcc256415138683a0c827e1');
});
test('jersey #0 option swaps exactly its six words', { skip: !available }, () => {
  const input = fs.readFileSync(originalPath), { output, manifest } = patchBaseline(input, { jerseyZero: true });
  assert.equal(manifest.writes.length, 44);
  const segments = elfSegments(input);
  for (const [va, , value] of JERSEY_ZERO_WORDS) assert.equal(output.readUInt32BE(fileOffset(segments, va)), value, va.toString(16));
  assert.equal(output.readUInt32BE(fileOffset(segments, 0x341460)), 0x3be00001);
  assert.match(manifest.purpose, /jersey #0/);
});
test('roster stride words match the yml entry, expect the output as patched so far, and change nothing else', { skip: !strideAvailable }, () => {
  const input = fs.readFileSync(originalPath);
  const words = rosterStrideWords();
  const entry = ymlEntries()[STRIDE_ENTRY];
  assert.ok(entry && entry.length === words.length, 'yml entry present with the same word count');
  assert.deepEqual(entry.map(([va, v]) => [va, v]), words.map(([va, , v]) => [va, v]));
  const base = patchBaseline(input, { commissioner: true, jerseyZero: true }).output;
  const { output, manifest } = patchBaseline(input, { commissioner: true, jerseyZero: true, rosterStride: true });
  assert.equal(manifest.writes.length, 45 + words.length);
  const segments = elfSegments(input), touched = new Set();
  for (const [va, old, value] of words) {
    const o = fileOffset(segments, va);
    assert.equal(base.readUInt32BE(o), old, `expected word before the stride patch at ${va.toString(16)}`);
    assert.equal(output.readUInt32BE(o), value, va.toString(16));
    for (let i = o; i < o + 4; i++) touched.add(i);
  }
  for (let i = 0; i < input.length; i++) if (!touched.has(i)) assert.equal(output[i], base[i], `Unintended change at ${i}`);
  assert.match(manifest.purpose, /100-player/);
  assert.ok(words.some(([va]) => va === 0x453968), 'the All-Conference window word is part of the stride patch');
});
test('roster capacity words match their yml entry and apply on top of the stride entry', { skip: !(strideAvailable && fs.existsSync(ROSTER_CAPACITY_WORDS)) }, () => {
  const input = fs.readFileSync(originalPath);
  const words = rosterCapacityWords();
  const entry = ymlEntries()['FCS mod: 100-player rosters (capacity)'];
  assert.ok(entry && entry.length === words.length, 'yml entry present with the same word count');
  assert.deepEqual(entry.map(([va, v]) => [va, v]), words.map(([va, , v]) => [va, v]));
  const base = patchBaseline(input, { commissioner: true, jerseyZero: true, rosterStride: true }).output;
  const { output, manifest } = patchBaseline(input, { commissioner: true, jerseyZero: true, rosterStride: true, rosterCapacity: true });
  assert.equal(manifest.writes.length, 45 + rosterStrideWords().length + words.length);
  const segments = elfSegments(input), touched = new Set();
  for (const [va, old, value] of words) {
    const o = fileOffset(segments, va);
    assert.equal(base.readUInt32BE(o), old, `expected word before the capacity patch at ${va.toString(16)}`);
    assert.equal(output.readUInt32BE(o), value, va.toString(16));
    for (let i = o; i < o + 4; i++) touched.add(i);
  }
  for (let i = 0; i < input.length; i++) if (!touched.has(i)) assert.equal(output[i], base[i], `Unintended change at ${i}`);
  assert.throws(() => patchBaseline(input, { rosterCapacity: true }), /requires/);
});
test('roster player-table words match their yml entry, replace .text padding only and apply last', { skip: !(strideAvailable && fs.existsSync(ROSTER_CAPACITY_WORDS) && fs.existsSync(ROSTER_TABLE_WORDS)) }, () => {
  const input = fs.readFileSync(originalPath);
  const words = rosterTableWords();
  const entry = ymlEntries()['FCS mod: 100-player rosters (player table)'];
  assert.ok(entry && entry.length === words.length, 'yml entry present with the same word count');
  assert.deepEqual(entry.map(([va, v]) => [va, v]), words.map(([va, , v]) => [va, v]));
  const all = { commissioner: true, jerseyZero: true, rosterStride: true, rosterCapacity: true };
  const base = patchBaseline(input, all).output;
  const { output, manifest } = patchBaseline(input, { ...all, rosterTable: true });
  assert.equal(manifest.writes.length, 45 + rosterStrideWords().length + rosterCapacityWords().length + words.length);
  const segments = elfSegments(input), touched = new Set();
  // v2: two hooks (Rosters builder index call, new-dynasty PLAY index prep) that call a stub each; the rest is code
  // written over inter-function padding
  const hooks = words.slice(0, 2), routine = words.slice(2);
  const expected = [[0x4f417c, 0x4f237c], [0x4f5e9c, 0x4f4e44]];
  for (const [i, [site, callee]] of expected.entries()) {
    assert.equal(hooks[i][0], site); assert.equal(hooks[i][1], branch(site, callee, true), `${site.toString(16)} was bl ${callee.toString(16)}`);
    const stub = hooks[i][2] - 0x48000001 + site; // bl target
    const stubWords = routine.filter(([va]) => va >= stub && va < stub + 20);
    assert.equal(stubWords.length, 5, 'a 5-word stub at the hook target');
    assert.equal(stubWords[2][2] >>> 16, 0x3d60, 'stub loads the original callee into r11 (lis)');
    assert.equal(((stubWords[2][2] & 0xffff) << 16 | (stubWords[3][2] & 0xffff)) >>> 0, callee, 'stub passes the original callee');
  }
  for (const [va, old, value] of words) {
    const o = fileOffset(segments, va);
    assert.equal(base.readUInt32BE(o), old, `expected word before the player-table patch at ${va.toString(16)}`);
    assert.equal(output.readUInt32BE(o), value, va.toString(16));
    for (let i = o; i < o + 4; i++) touched.add(i);
  }
  // both parts replace inter-function padding inside .text (section headers: 0x10230-0x16d501c, SHF_EXECINSTR)
  for (const [va, old] of routine) { assert.ok(va >= 0x10230 && va < 0x16d501c); assert.ok(old === 0x48000000 || old === 0x60000000, 'the routine replaces "b ." / nop padding'); }
  for (let i = 0; i < input.length; i++) if (!touched.has(i)) assert.equal(output[i], base[i], `Unintended change at ${i}`);
  assert.throws(() => patchBaseline(input, { rosterStride: true, rosterTable: true }), /requires/);
  assert.match(manifest.purpose, /player table/);
});
test('long snapper fix rewrites only the list insert 0x50de60..0x50debc and works with or without the roster entries', { skip: !(available && fs.existsSync(LS_GROUP_WORDS)) }, () => {
  const input = fs.readFileSync(originalPath);
  const words = lsGroupWords();
  const entry = ymlEntries()['FCS mod: long snapper recruiting fix'];
  assert.ok(entry && entry.length === words.length, 'yml entry present with the same word count');
  assert.deepEqual(entry.map(([va, v]) => [va, v]), words.map(([va, , v]) => [va, v]));
  for (const [va, old] of words) { assert.ok(va >= 0x50de60 && va < 0x50dec0, va.toString(16)); assert.equal(input.readUInt32BE(fileOffset(elfSegments(input), va)), old); }
  const segments = elfSegments(input);
  assert.equal(input.readUInt32BE(fileOffset(segments, 0x50dec0)), 0x7c0802a6, 'the next function is untouched');
  for (const opts of [{}, { commissioner: true, jerseyZero: true, rosterStride: true, rosterCapacity: true, rosterTable: true }]) {
    const base = patchBaseline(input, opts).output, { output, manifest } = patchBaseline(input, { ...opts, lsGroup: true });
    const touched = new Set();
    for (const [va, , value] of words) { const o = fileOffset(segments, va); assert.equal(output.readUInt32BE(o), value); for (let i = o; i < o + 4; i++) touched.add(i); }
    for (let i = 0; i < input.length; i++) if (!touched.has(i)) assert.equal(output[i], base[i], `Unintended change at ${i}`);
    assert.match(manifest.purpose, /long snapper/);
  }
  const o = fileOffset(segments, 0x50de60), out = patchBaseline(input, { lsGroup: true }).output;
  assert.equal(out.readUInt32BE(o), 0x28050011, 'cmplwi r5,17 first'); assert.equal(out.readUInt32BE(o + 4), 0x4c800020, 'bgelr');
});
test('roster offseason words match their yml entry, apply after the player-table entry and touch only their sites', { skip: !(strideAvailable && fs.existsSync(ROSTER_OFFSEASON_WORDS) && fs.existsSync(ROSTER_TABLE_WORDS)) }, () => {
  const input = fs.readFileSync(originalPath);
  const words = rosterOffseasonWords();
  const entry = ymlEntries()['FCS mod: 100-player rosters (offseason)'];
  assert.ok(entry && entry.length === words.length, 'yml entry present with the same word count');
  assert.deepEqual(entry.map(([va, v]) => [va, v]), words.map(([va, , v]) => [va, v]));
  const all = { commissioner: true, jerseyZero: true, rosterStride: true, rosterCapacity: true, rosterTable: true, lsGroup: true };
  const base = patchBaseline(input, all).output, { output, manifest } = patchBaseline(input, { ...all, rosterOffseason: true });
  const segments = elfSegments(input), touched = new Set();
  for (const [va, old, value] of words) { const o = fileOffset(segments, va); assert.equal(base.readUInt32BE(o), old); assert.equal(output.readUInt32BE(o), value); for (let i = o; i < o + 4; i++) touched.add(i); }
  for (let i = 0; i < input.length; i++) if (!touched.has(i)) assert.equal(output[i], base[i], `Unintended change at ${i}`);
  assert.equal(output.readUInt32BE(fileOffset(segments, 0x49354c)), branch(0x49354c, 0x3046e4, true), 'training calls the grow-then-copy helper');
  assert.throws(() => patchBaseline(input, { rosterStride: true, rosterCapacity: true, rosterOffseason: true }), /requires/);
  assert.match(manifest.purpose, /offseason/);
});
test('generic opponents host words match their yml entry, expect the stock words and touch only their three sites', { skip: !available }, () => {
  const input = fs.readFileSync(originalPath), segments = elfSegments(input);
  const entry = ymlEntries()['FCS mod: generic opponents host'];
  assert.deepEqual(entry, GENERIC_HOST_WORDS.map(([va, , v]) => [va, v]));
  for (const [va, old] of GENERIC_HOST_WORDS) assert.equal(input.readUInt32BE(fileOffset(segments, va)), old, va.toString(16));
  const all = { commissioner: true, jerseyZero: true, rosterStride: true, rosterCapacity: true, rosterTable: true, lsGroup: true, rosterOffseason: true };
  const base = patchBaseline(input, all).output, { output, manifest } = patchBaseline(input, { ...all, genericHost: true });
  const touched = new Set();
  for (const [va, , value] of GENERIC_HOST_WORDS) { const o = fileOffset(segments, va); assert.equal(output.readUInt32BE(o), value); for (let i = o; i < o + 4; i++) touched.add(i); }
  for (let i = 0; i < input.length; i++) if (!touched.has(i)) assert.equal(output[i], base[i], `Unintended change at ${i}`);
  // no other entry writes these addresses
  const others = Object.entries(ymlEntries()).filter(([n]) => n !== 'FCS mod: generic opponents host').flatMap(([, w]) => w.map(([va]) => va));
  for (const [va] of GENERIC_HOST_WORDS) assert.ok(!others.includes(va));
  assert.match(manifest.purpose, /generic opponents host/);
});
test('extra words apply last against the output as patched so far and refuse a wrong original', { skip: !available }, () => {
  const input = fs.readFileSync(originalPath), segments = elfSegments(input);
  const [va, old, value] = GENERIC_HOST_WORDS[0];
  const { output, manifest } = patchBaseline(input, { extraWords: [{ name: 'test entry', words: [[va, old, value]] }] });
  assert.equal(output.readUInt32BE(fileOffset(segments, va)), value);
  assert.match(manifest.purpose, /test entry/);
  assert.throws(() => patchBaseline(input, { extraWords: [{ name: 'bad', words: [[va, old ^ 1, value]] }] }), /current bytes differ/);
  assert.throws(() => patchBaseline(input, { extraWords: [{ name: 'dup', words: [[va, old, value], [va, old, value]] }] }), /listed twice/);
  assert.deepEqual(parseOptions(['--commissioner', '--generic-host']), { extraWords: [], commissioner: true, genericHost: true });
  assert.equal(parseOptions(['--bogus']), null);
});
const adapterPath = new URL('../private/BLUS31159-1.02-no-psn-UNSIGNED-probe-a.elf', import.meta.url);
test('onto the adapter ELF: every entry, adapter bytes untouched, the rest equal to the stock-based build', { skip: !(strideAvailable && fs.existsSync(adapterPath)) }, () => {
  const stock = fs.readFileSync(originalPath), adapter = fs.readFileSync(adapterPath);
  const adapterManifest = JSON.parse(fs.readFileSync(new URL(adapterPath.href + '.manifest.json'), 'utf8'));
  const opts = { commissioner: true, jerseyZero: true, rosterStride: true, rosterCapacity: true, rosterTable: true, lsGroup: true, rosterOffseason: true, genericHost: true };
  const { output, manifest } = patchOntoAdapter(stock, adapter, adapterManifest, opts);
  const ref = patchBaseline(stock, opts).output, base = patchBaseline(stock, { commissioner: true }).output;
  let adapterBytes = 0;
  for (let i = 0; i < stock.length; i++) {
    if (adapter[i] !== base[i]) { adapterBytes++; assert.equal(output[i], adapter[i]); } else assert.equal(output[i], ref[i]);
  }
  assert.ok(adapterBytes > 1000, 'the adapter hooks and code are present');
  const cave = adapterManifest.codeOffset, caveEnd = cave + adapterManifest.codeSize;
  assert.ok(manifest.adapterRanges.some(r => r.offset >= cave && r.offset < caveEnd), 'the code cave is one of the adapter ranges');
  for (const w of manifest.writes) assert.ok(w.offset + 4 <= cave || w.offset >= caveEnd, 'no added word in the code cave');
  // every yml word is in the output (the All-Conference and commissioner words came with the adapter build)
  const segments = elfSegments(adapter);
  const last = new Map(), writers = new Map(); // yml order = application order; a later entry's word wins
  for (const [name, words] of Object.entries(ymlEntries())) for (const [va, v] of words) { last.set(va, [name, v]); writers.set(va, [...(writers.get(va) || []), name]); }
  for (const [va, [name, v]] of last) assert.equal(output.readUInt32BE(fileOffset(segments, va)), v, `${name} ${va.toString(16)}`);
  // the only address two entries share: the stride entry's word inside the All-Conference window
  assert.deepEqual([...writers].filter(([, n]) => n.length > 1).map(([va, n]) => [va, n]), [[0x453968, ['FCS mod: preseason All-Conference crash fix', 'FCS mod: 100-player rosters']]]);
  assert.equal(manifest.baselineWordsAlreadyPresent, 39);
  assert.ok(manifest.hooks && manifest.titleId === 'BLUS31159' && manifest.outputSha256 === sha256(output));
  assert.throws(() => patchOntoAdapter(stock, adapter, adapterManifest, { ...opts, commissioner: false }), /commissioner/);
  assert.throws(() => patchOntoAdapter(stock, output, adapterManifest, opts), /manifest/);
});
test('no external immediate branches enter the moved query block', { skip: !available }, () => {
  const input = fs.readFileSync(originalPath);
  const entries = [];
  for (const s of elfSegments(input).filter(s => s.flags & 1)) {
    for (let o = s.offset; o + 4 <= s.offset + s.size; o += 4) {
      const w = input.readUInt32BE(o), at = s.va + o - s.offset;
      if (at >= 0x453914 && at <= 0x4539a4) continue;
      const op = w >>> 26;
      if (op !== 18 && op !== 16) continue;
      const mask = op === 18 ? 0x3fffffc : 0xfffc;
      const sign = op === 18 ? 0x2000000 : 0x8000;
      let d = w & mask; if (d & sign) d -= sign * 2;
      const target = w & 2 ? d : at + d;
      if (target > 0x453914 && target <= 0x4539a4) entries.push({ at, target });
    }
  }
  assert.deepEqual(entries, []);
});
