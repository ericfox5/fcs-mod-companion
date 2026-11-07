import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JERSEY_ZERO_WORDS, ROSTER_STRIDE_WORDS, ROSTER_CAPACITY_WORDS, branch, elfSegments, fileOffset, patchBaseline, rosterStrideWords, rosterCapacityWords, sha256 } from './ps3-eboot.mjs';

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
test('original ELF matches all 44 independently recorded RPCS3 patch words of the three base entries', { skip: !available }, () => {
  const input = fs.readFileSync(originalPath);
  const { output, manifest } = patchBaseline(input, { commissioner: true, jerseyZero: true });
  const entries = ymlEntries();
  const words = BASE_ENTRIES.flatMap(n => { assert.ok(entries[n], `yml entry ${n}`); return entries[n]; });
  assert.equal(words.length, 44);
  const segments = elfSegments(input), touched = new Set();
  for (const [va, value] of words) {
    const o = fileOffset(segments, va);
    assert.equal(output.readUInt32BE(o), value, va.toString(16));
    for (let i = o; i < o + 4; i++) touched.add(i);
  }
  for (let i = 0; i < input.length; i++) if (!touched.has(i)) assert.equal(output[i], input[i], `Unintended change at ${i}`);
  assert.equal(sha256(output), 'c98b9e455082d5477660569ef8e3459cd520decdf046c5e1e1731431457462f7');
  assert.equal(manifest.writes.length, 44);
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
test('jersey #0 option swaps exactly its five words', { skip: !available }, () => {
  const input = fs.readFileSync(originalPath), { output, manifest } = patchBaseline(input, { jerseyZero: true });
  assert.equal(manifest.writes.length, 43);
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
  assert.equal(manifest.writes.length, 44 + words.length);
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
  assert.equal(manifest.writes.length, 44 + rosterStrideWords().length + words.length);
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
