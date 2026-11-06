// Node check of codec.js against real DLC bigfiles: parse -> rebuild byte-identical TOC, decode -> encode -> decode PSNR,
// DDS round trip, rename with rehash. usage: node test-codec.mjs <DLC folder> [bigfile name]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const C = require('./codec.cjs');
const dir = process.argv[2];
const pick = process.argv[3] || 'FCS_DLC_PATRIOT/HOLYCR_HELMET_2021_PURPL_big.AST';
const file = path.join(dir, pick);
const u8 = new Uint8Array(fs.readFileSync(file));
const big = C.parseBigfile(u8, pick);
console.log(`${pick}: ${big.entries.length} entries, prefix ${big.prefix.map((x) => x.toString(16)).join(',')}`);
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };
for (const e of big.entries) {
  check(C.fnv1a64(e.name) === e.hash, `hash of ${e.name} = ${C.hex64(e.hash)}`);
  await C.loadEntry(e);
  check(e.data.length === e.csize + e.delta, `${e.name}: inflated ${e.data.length} = csize+delta ${e.csize + e.delta}`);
}
// rebuild without changes: header/TOC fields must match (compressed bytes are reused, so the file must be identical)
const rebuilt = await C.buildBigfile(big);
check(rebuilt.length === u8.length && rebuilt.every((b, i) => b === u8[i]), `rebuild unchanged -> byte-identical (${rebuilt.length} B)`);
// texture round trip
for (const e of big.entries) {
  if (C.entryKind(e.name) !== 'texture') continue;
  const t = C.parseTexture(e.data, e.name);
  check(C.chainBytes(t.width, t.height, t.mips, t.fourcc) + 128 + t.trailer.length === e.data.length, `${e.name}: ${t.fourcc} ${t.width}x${t.height} ${t.mips} mips, trailer ${t.trailer.length} B, size matches`);
  const m0 = C.decodeMip(t, 0);
  const t2 = C.encodeTexture(t, m0.rgba);
  check(t2.bytes.length === e.data.length, `${e.name}: re-encoded size ${t2.bytes.length} = ${e.data.length}`);
  const m1 = C.decodeMip(t2, 0);
  let se = 0; for (let i = 0; i < m0.rgba.length; i++) se += (m0.rgba[i] - m1.rgba[i]) ** 2;
  const psnr = 10 * Math.log10(255 * 255 / (se / m0.rgba.length));
  check(psnr > 30, `${e.name}: decode->encode->decode PSNR ${psnr.toFixed(1)} dB`);
  const mLast = C.decodeMip(t, t.mips - 1);
  check(mLast.width >= 1 && mLast.height >= 1, `${e.name}: last mip ${mLast.width}x${mLast.height}`);
  const dds = C.toDDS(t); const back = C.fromDDS(dds);
  check(back.fourcc === t.fourcc && back.width === t.width && back.data.length === t.data.length && back.data.every((b, i) => b === t.data[i]), `${e.name}: DDS export/import round trip`);
  // compressed re-encode of an untouched texture should inflate back to the same bytes
  e.data = t2.bytes; e.dirty = true;
}
const rebuilt2 = await C.buildBigfile(big);
const big2 = C.parseBigfile(rebuilt2, 'rebuilt');
check(big2.entries.length === big.entries.length && big2.prefix.join() === big.prefix.join(), 'rebuilt with re-encoded textures parses, same prefix words');
for (const e of big2.entries) { await C.loadEntry(e); const o = big.entries.find((x) => x.name === e.name); check(e.data.length === o.data.length && e.hash === o.hash && e.flags === o.flags, `${e.name}: size/hash/flags kept`); }
// rename: HOLYCR -> WAGNER (same length), PURPL -> GREEN
const big3 = C.parseBigfile(u8, pick);
const info = C.splitName(big3.entries[0].name);
const map = [{ from: info.slot, to: 'WAGNER' }, { from: info.color, to: 'X'.repeat(info.color.length) }];
const log = await C.renameBigfile(big3, map);
console.log(log.join('\n'));
for (const e of big3.entries) check(C.fnv1a64(e.name) === e.hash && e.name.startsWith('WAGNER_'), `renamed ${e.name} hash ok`);
const scene = big3.entries.find((e) => C.entryKind(e.name) === 'scene');
const txt = Buffer.from(scene.data).toString('latin1');
check(!/holycr/i.test(txt) && /wagner/i.test(txt), 'scene paths patched (no old slot code left)');
const out = await C.buildBigfile(big3);
check(C.parseBigfile(out).entries.every((e) => C.fnv1a64(e.name) === e.hash), 'renamed bigfile rebuilds with consistent hashes');
console.log(C.xmlForSet(['Home', 'Away'], [{ type: 'helmet', name: 'Green', bigfile: 'WAGNER_HELMET_2021_GREEN_big', scene: 'WAGNER_HELMET_2021_GREEN', officials: ['Home', 'Away'] }]).slice(0, 400));
console.log(fails ? `${fails} FAILURE(S)` : 'all checks passed');
process.exit(fails ? 1 : 0);
