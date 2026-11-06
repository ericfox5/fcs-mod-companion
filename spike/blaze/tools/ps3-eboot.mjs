// Reproducible physical-console ELF patches. No SELF signing or live installation.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const INPUT_SHA256 = '144dee9040da9cb1e8337844fbb685a0f06e560b8fee8d9ba1eac87b9e300c1c';
export const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
export function elfSegments(b) {
  if (b.length < 64 || b.subarray(0, 6).toString('hex') !== '7f454c460202' || b.readUInt16BE(18) !== 21)
    throw new Error('Expected ELF64 big-endian PowerPC64');
  const ph = Number(b.readBigUInt64BE(32)), stride = b.readUInt16BE(54), count = b.readUInt16BE(56);
  if (stride !== 56 || ph + stride * count > b.length) throw new Error('Invalid program headers');
  return Array.from({ length: count }, (_, i) => {
    const p = ph + i * stride;
    return { type: b.readUInt32BE(p), flags: b.readUInt32BE(p + 4),
      offset: Number(b.readBigUInt64BE(p + 8)), va: Number(b.readBigUInt64BE(p + 16)),
      size: Number(b.readBigUInt64BE(p + 32)), memory: Number(b.readBigUInt64BE(p + 40)) };
  }).filter(s => s.type === 1 && s.size);
}
export function fileOffset(segments, va, length = 4) {
  const matches = segments.filter(s => s.va <= va && va + length <= s.va + s.size);
  if (matches.length !== 1) throw new Error(`Unmapped or ambiguous VA 0x${va.toString(16)}`);
  return matches[0].offset + va - matches[0].va;
}
export function branch(at, target, link = false) {
  const d = target - at;
  if (at % 4 || target % 4 || d < -0x2000000 || d > 0x1fffffc) throw new Error('PPC branch alignment/reach');
  return (0x48000000 | (d & 0x3fffffc) | Number(link)) >>> 0;
}
export function patchBaseline(input, { commissioner = false } = {}) {
  if (sha256(input) !== INPUT_SHA256) throw new Error('Unsupported or already modified ELF: SHA-256 mismatch');
  const segments = elfSegments(input), output = Buffer.from(input), writes = [];
  const word = va => input.readUInt32BE(fileOffset(segments, va));
  const expect = (va, value) => { if (word(va) !== value) throw new Error(`Original bytes differ at ${va.toString(16)}`); };
  const put = (va, expected, value, reason) => {
    expect(va, expected);
    if (writes.some(w => w.va === va)) throw new Error('Overlapping patch');
    const offset = fileOffset(segments, va);
    if (!segments.some(s => (s.flags & 1) && s.va <= va && va + 4 <= s.va + s.size)) throw new Error('Not executable');
    output.writeUInt32BE(value >>> 0, offset);
    writes.push({ va, offset, original: expected.toString(16).padStart(8, '0'), replacement: (value >>> 0).toString(16).padStart(8, '0'), reason });
  };
  expect(0x453914, 0x3c6001c8); expect(0x453918, 0x3e0001c8);
  expect(0x45391c, 0x80635da8); expect(0x4539a0, 0x38600000);
  expect(0x4539a4, 0x82410074); expect(0x4539b4, 0x7e5207b4);
  put(0x453914, word(0x453914), word(0x453918), 'Use r16 for profiler base');
  put(0x453918, word(0x453918), 0x80705da8, 'Load profiler pointer via r16');
  for (let va = 0x453920; va < 0x4539a0; va += 4) {
    let w = word(va);
    if (w >>> 26 === 18) {
      if (w & 2) throw new Error('Unexpected absolute branch');
      let d = w & 0x3fffffc; if (d & 0x2000000) d -= 0x4000000;
      w = branch(va - 4, va + d, Boolean(w & 1));
    }
    put(va - 4, word(va - 4), w, 'Move query block; relocate relative calls');
  }
  put(0x45399c, word(0x45399c), 0x82410074, 'Read CGID');
  put(0x4539a0, word(0x4539a0), 0x2812000d, 'Unsigned CGID <= 13');
  put(0x4539a4, word(0x4539a4), 0x4181ff5c, 'Invalid CGID: next candidate at 0x453900');
  put(0x4539b4, word(0x4539b4), 0x38600000, 'Move li r3,0; valid CGID needs no sign extension');
  if (commissioner) put(0x341460, 0x3be00001, 0x3be00005, 'Optional existing five-dynasty limit patch');
  return { output, manifest: { format: 1, titleId: 'BLUS31159', update: '01.02',
    purpose: 'All-Conference fix' + (commissioner ? ' + five-dynasty limit' : ''),
    psnDependencyRemoved: false, selfSigned: false, hardwareValidated: false,
    inputSha256: INPUT_SHA256, outputSha256: sha256(output), segments, writes } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [inputPath, outputPath, ...opts] = process.argv.slice(2);
    if (!inputPath || !outputPath || opts.some(x => x !== '--commissioner'))
      throw new Error('Usage: node ps3-eboot.mjs ORIGINAL.elf NEW.elf [--commissioner]');
    if (path.resolve(inputPath) === path.resolve(outputPath)) throw new Error('Refusing in-place patch');
    const manifestPath = outputPath + '.manifest.json';
    if (fs.existsSync(outputPath) || fs.existsSync(manifestPath)) throw new Error('Output already exists');
    const { output, manifest } = patchBaseline(fs.readFileSync(inputPath), { commissioner: opts.includes('--commissioner') });
    fs.writeFileSync(outputPath, output, { flag: 'wx' });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ outputPath, sha256: manifest.outputSha256, writes: manifest.writes.length,
      warning: 'ELF only; PSN dependency remains; not a HEN-ready EBOOT' }, null, 2));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
