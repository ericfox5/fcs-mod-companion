// Bakes the RPCS3 patch words into an adapter ELF (ps3-np-adapter.py output, which already carries the All-Conference fix
// and the five-dynasty limit from patchBaseline(stock, { commissioner: true })). No signing, no installation.
//
//   node ps3-eboot-onto.mjs STOCK.elf ADAPTER.elf NEW.elf [ps3-eboot.mjs options] [--extra-words FILE.json ...]
//
// Checks: the stock ELF is the supported original; the adapter ELF matches its manifest and contains every baseline word;
// the same options applied to the stock ELF (patchBaseline) give the reference words, and each word written here expects
// the reference's "before" word in the output as patched so far; no written byte falls inside what the adapter changed
// (adapter ELF vs the baseline-only ELF: hooks, code cave, program headers); and the result equals the stock-based
// reference everywhere outside the adapter's bytes and the adapter everywhere inside them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INPUT_SHA256, elfSegments, fileOffset, patchBaseline, parseOptions, sha256 } from './ps3-eboot.mjs';

export function adapterRanges(base, adapter) {
  if (base.length !== adapter.length) throw new Error('Adapter ELF size differs from the stock ELF');
  const ranges = [];
  for (let i = 0; i < base.length; i++) {
    if (base[i] === adapter[i]) continue;
    let j = i; while (j < base.length && base[j] !== adapter[j]) j++;
    ranges.push([i, j]); i = j;
  }
  return ranges;
}

export function patchOntoAdapter(stock, adapter, adapterManifest, options) {
  if (sha256(stock) !== INPUT_SHA256) throw new Error('Unsupported stock ELF: SHA-256 mismatch');
  if (!adapterManifest || adapterManifest.inputSha256 !== INPUT_SHA256 || adapterManifest.outputSha256 !== sha256(adapter) || !adapterManifest.baselineIncluded)
    throw new Error('Adapter ELF does not match its manifest (input = stock ELF, output = this file, baseline included)');
  if (!options.commissioner) throw new Error('The adapter ELF carries the five-dynasty limit: pass --commissioner');
  // what the adapter build already contains
  const base = patchBaseline(stock, { commissioner: true });
  for (const w of base.manifest.writes)
    if (adapter.readUInt32BE(w.offset) !== parseInt(w.replacement, 16)) throw new Error(`Adapter ELF lacks baseline word at 0x${w.va.toString(16)}`);
  const ranges = adapterRanges(base.output, adapter);
  const inAdapter = new Uint8Array(stock.length);
  for (const [s, e] of ranges) inAdapter.fill(1, s, e);
  // reference: the same options on the stock ELF
  const ref = patchBaseline(stock, options);
  const n = base.manifest.writes.length;
  ref.manifest.writes.slice(0, n).forEach((w, i) => {
    const b = base.manifest.writes[i];
    if (w.va !== b.va || w.replacement !== b.replacement) throw new Error('Reference does not start with the adapter baseline');
  });
  const added = ref.manifest.writes.slice(n);
  // the adapter's segments (its RX segment grew over the code cave) must map every added word the same way
  const segs = elfSegments(adapter), output = Buffer.from(adapter), writes = [];
  for (const w of added) {
    if (fileOffset(segs, w.va) !== w.offset) throw new Error(`VA 0x${w.va.toString(16)} maps differently in the adapter ELF`);
    if (!segs.some(s => (s.flags & 1) && s.va <= w.va && w.va + 4 <= s.va + s.size)) throw new Error('Not executable in the adapter ELF');
    for (let i = w.offset; i < w.offset + 4; i++) if (inAdapter[i]) throw new Error(`0x${w.va.toString(16)} overlaps the adapter's changes`);
    const now = output.readUInt32BE(w.offset), before = parseInt(w.original, 16);
    if (now !== before) throw new Error(`${w.reason}: expected ${w.original} at 0x${w.va.toString(16)}, found ${now.toString(16).padStart(8, '0')}`);
    output.writeUInt32BE(parseInt(w.replacement, 16), w.offset);
    writes.push(w);
  }
  for (let i = 0; i < output.length; i++)
    if (output[i] !== (inAdapter[i] ? adapter[i] : ref.output[i])) throw new Error(`Result differs from the reference at file offset 0x${i.toString(16)}`);
  const m = adapterManifest;
  return { output, manifest: { format: 1, titleId: 'BLUS31159', version: m.version || '01.02',
    artifact: 'UNSIGNED EXPERIMENTAL no-PSN adapter ELF + RPCS3 patch words',
    purpose: ref.manifest.purpose, stockSha256: INPUT_SHA256, inputSha256: INPUT_SHA256, adapterSha256: m.outputSha256,
    referenceSha256: sha256(ref.output), outputSha256: sha256(output),
    userId: m.userId, onlineId: m.onlineId, credentialSha256: m.credentialSha256, hooks: m.hooks, stateVa: m.stateVa, codeVa: m.codeVa, codeSize: m.codeSize,
    adapterRanges: ranges.map(([s, e]) => ({ offset: s, length: e - s })), baselineWordsAlreadyPresent: n,
    writes, baselineIncluded: true, emulatorTested: false, hardwareTested: false, selfSigned: false } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [stockPath, adapterPath, outputPath, ...opts] = process.argv.slice(2);
    const options = parseOptions(opts);
    if (!stockPath || !adapterPath || !outputPath || !options)
      throw new Error('Usage: node ps3-eboot-onto.mjs STOCK.elf ADAPTER.elf NEW.elf --commissioner [--jersey-zero] [--roster-stride ...] [--generic-host] [--extra-words FILE.json ...]');
    const manifestPath = outputPath + '.manifest.json';
    if ([stockPath, adapterPath].some(p => path.resolve(p) === path.resolve(outputPath))) throw new Error('Refusing in-place patch');
    if (fs.existsSync(outputPath) || fs.existsSync(manifestPath)) throw new Error('Output already exists');
    const adapter = fs.readFileSync(adapterPath);
    const { output, manifest } = patchOntoAdapter(fs.readFileSync(stockPath), adapter, JSON.parse(fs.readFileSync(adapterPath + '.manifest.json', 'utf8')), options);
    fs.writeFileSync(outputPath, output, { flag: 'wx' });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ outputPath, sha256: manifest.outputSha256, added: manifest.writes.length, adapterRanges: manifest.adapterRanges.length,
      warning: 'ELF only; sign with package-np-self.py and verify before any install' }, null, 2));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
