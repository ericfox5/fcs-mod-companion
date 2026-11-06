import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { branch, elfSegments, fileOffset, patchBaseline, sha256 } from './ps3-eboot.mjs';

const originalPath = new URL('../private/EBOOT.elf', import.meta.url);
const available = fs.existsSync(originalPath);
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
test('original ELF matches all 39 independently recorded RPCS3 patch words', { skip: !available }, () => {
  const input = fs.readFileSync(originalPath);
  const { output, manifest } = patchBaseline(input, { commissioner: true });
  const yml = fs.readFileSync(new URL('../private/rpcs3-patches.yml', import.meta.url), 'utf8');
  const words = [...yml.matchAll(/\[ be32, (0x[0-9a-f]+), (0x[0-9a-f]+) \]/g)];
  assert.equal(words.length, 39);
  const segments = elfSegments(input), touched = new Set();
  for (const [, va, value] of words) {
    const o = fileOffset(segments, Number(va));
    assert.equal(output.readUInt32BE(o), Number(value), va);
    for (let i = o; i < o + 4; i++) touched.add(i);
  }
  for (let i = 0; i < input.length; i++) if (!touched.has(i)) assert.equal(output[i], input[i], `Unintended change at ${i}`);
  assert.equal(sha256(output), '046e5546f89ec7819d3cb8af05bad5a8167c7b78b30112e8f082d2f8f42639c5');
  assert.equal(manifest.psnDependencyRemoved, false);
  assert.throws(() => patchBaseline(output), /SHA-256/);
  const corrupt = Buffer.from(input); corrupt[0x100] ^= 1;
  assert.throws(() => patchBaseline(corrupt), /SHA-256/);
});
test('offseason-only output leaves the commissioner instruction untouched', { skip: !available }, () => {
  const input = fs.readFileSync(originalPath), { output, manifest } = patchBaseline(input);
  assert.equal(manifest.writes.length, 38);
  assert.equal(output.readUInt32BE(fileOffset(elfSegments(input), 0x341460)), 0x3be00001);
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
