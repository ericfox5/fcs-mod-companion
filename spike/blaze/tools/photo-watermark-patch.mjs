// Replay photo / video highlight fix (NOTES 2026-11-01): the game's post-effects script InGame.pus (a zlib entry in
// qkl_boot.ast) draws the replay photo as "copy the frame (TransferShader tecNoAlpha), then a watermark over it
// (VideoWaterMarkRam, DecalOverlayShader)", and the highlight video frame the same way (plus a sponsor overlay,
// VideoOverLayRam, when presentation doVideoOverlay is set). Under RPCS3 a DecalOverlayShader pass covers the whole
// picture (near-solid white or one flat colour), so this removes every DecalOverlayShader draw from those two blocks.
// --vram-copy also reroutes the photo: it is drawn into the 640x360 bloom surface (EmbeddedTexture0, VRAM) and copied
// to PhotoBufferRam with "transferimage ... local2main". RPCS3 writes a render target in RAM (the original target) back
// to memory only with "Write Color Buffers" on; a transfer destination in RAM is flushed when the game reads it, so the
// photo no longer needs that setting. The bloom surface is free here: every later pass renders it before reading it.
// The entry is rewritten in place at the same uncompressed length (the removed lines and the banner comments become
// spaces so the new stream fits the old slot); the TOC record keeps its offset and gets the new compressed size.
// TOC record: {u16 flags, u64 hash, u32 offset, u32 csize, u32 usize - csize}. Nothing from the archive is stored here.
// Usage (game stopped in RPCS3): node photo-watermark-patch.mjs check|apply|restore [--vram-copy] [--archive <ast>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const args = process.argv.slice(2);
const mode = args[0] ?? 'check';
const vramCopy = args.includes('--vram-copy');
const ai = args.indexOf('--archive');
const archive = ai >= 0 ? args[ai + 1] : 'C:/Users/efoxo/OneDrive/Desktop/desktop2/Desktop1/rpcs3-v0.0.29-15767-57324f17_win64/dev_hdd0/disc/BLUS31159-[NCAA Football 14]/PS3_GAME/USRDIR/qkl_boot.ast';
const backup = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'ncaa-bridge', 'backups', 'qkl_boot.ast.orig');

if (mode === 'restore') {
  if (!fs.existsSync(backup)) throw new Error(`no backup at ${backup}`);
  fs.copyFileSync(backup, archive);
  console.log(`restored ${archive} from ${backup}`);
  process.exit(0);
}

const fd = fs.openSync(archive, mode === 'apply' ? 'r+' : 'r');
const read = (off, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, off); return b; };
const head = read(0, 0x40);
if (head.toString('latin1', 0, 8) !== 'BGFA1.05') throw new Error('not a BGFA 1.05 archive');
const tocOff = head.readUInt32LE(0x10), tocSize = head.readUInt32LE(0x18), prefixWords = head.readUInt32LE(0x28), nameW = head.readUInt32LE(0x2c);
const toc = read(tocOff, tocSize), rec = 22 + nameW;
const entries = [];
for (let p = prefixWords * 4; p + rec <= tocSize; p += rec) entries.push({ i: entries.length, p, off: toc.readUInt32LE(p + 10), csize: toc.readUInt32LE(p + 14), usize: toc.readUInt32LE(p + 14) + toc.readUInt32LE(p + 18) });

// find InGame.pus by content: a text entry with the photo block
let entry = null;
for (const e of entries) {
  if (e.csize > 200_000) continue;
  const raw = read(e.off, e.csize);
  if (raw[0] !== 0x78) continue;
  let text; try { text = zlib.inflateSync(raw).toString('latin1'); } catch { continue; }
  if (text.includes('# draw to photo target') && text.includes('PhotoBufferRam')) { entry = { ...e, text }; break; }
}
if (!entry) throw new Error('InGame.pus (photo block) not found');
// the room this entry may use: up to the next entry in the file (entries are packed back to back)
const slot = Math.min(fs.fstatSync(fd).size, ...entries.filter((e) => e.off > entry.off).map((e) => e.off)) - entry.off;

// the two blocks, each from its first line up to (not including) the line that publishes the result
const BLOCKS = [
  { name: 'replay photo', start: /# draw to photo target/, end: /settexture\s+static photoSource PhotoBufferRam/ },
  { name: 'video highlight', start: /^\s*if presentation doVideoEncoding/, end: /settexture\s+static videoSource VEncode/ },
];
const lines = entry.text.split('\n');
const drop = new Set(), state = {}, span = {};
for (const b of BLOCKS) {
  const s = lines.findIndex((l) => b.start.test(l)), e = lines.findIndex((l, k) => k > s && b.end.test(l));
  if (s < 0 || e < 0) throw new Error(`${b.name} block not found`);
  span[b.name] = [s, e];
  let closeIf = false;
  for (let k = s; k < e; k++) {
    const l = lines[k];
    if (/^\s*if presentation doVideoOverlay/.test(l)) { drop.add(k); closeIf = true; }
    else if (closeIf && /^\s*endif/.test(l)) { drop.add(k); closeIf = false; }
    else if (/settexture\s+static texture0 (VideoWaterMarkRam|VideoOverLayRam)/.test(l) || /setshader\s+DecalOverlayShader/.test(l)
      || (/^\s*renderquad/.test(l) && /DecalOverlayShader/.test(lines[k - 1]))) drop.add(k);
  }
  state[b.name] = lines.slice(s, e).some((l) => /DecalOverlayShader/.test(l)) ? 'overlay present (original)' : 'overlay removed (patched)';
}
const [ps, pe] = span['replay photo'];
const rerouted = lines.slice(ps, pe).some((l) => /transferimage\s+PhotoBufferRam\s+EmbeddedSurface0\s+local2main/.test(l));
state['photo copy'] = rerouted ? 'VRAM + local2main copy (patched)' : 'render to RAM target (original)';
console.log(`InGame.pus = entry #${entry.i} (offset ${entry.off}, ${entry.csize} -> ${entry.usize} bytes, slot ${slot})`);
for (const [name, s] of Object.entries(state)) console.log(`  ${name}: ${s}`);
if (mode === 'check') process.exit(0);
if (mode !== 'apply') throw new Error(`unknown mode ${mode}`);
const wanted = Object.entries(state).filter(([name]) => vramCopy || name !== 'photo copy');
if (wanted.every(([, s]) => s.includes('patched'))) { console.log('nothing to do'); process.exit(0); }

const blank = (l) => l.replace(/\S.*/, (s) => '#' + ' '.repeat(s.length - 1));
const out = lines.map((l, k) => (drop.has(k) || (k < 12 && /^#[/*]/.test(l)) ? blank(l) : l));
if (vramCopy && !rerouted) {
  const t = out.findIndex((l, k) => k > ps && k < pe && /settarget\s+0 PhotoBufferRam PhotoBufferRam/.test(l));
  const q = out.findIndex((l, k) => k > t && k < pe && /setshader\s+TransferShader tecNoAlpha/.test(l));
  if (t < 0 || q < 0 || !/^\s*renderquad\s*$/.test(out[q + 1]) || !/^\s*#\s*$/.test(out[q + 2])) throw new Error('photo block layout not as expected');
  out[t] = out[t].replace('PhotoBufferRam PhotoBufferRam', 'EmbeddedTexture0 EmbeddedTexture0');
  out[q + 2] = out[q + 1].replace('renderquad', 'transferimage   PhotoBufferRam EmbeddedSurface0 local2main');
  // keep the uncompressed length: take the difference out of the blanked banner lines (CRLF there, LF elsewhere)
  let delta = out.join('\n').length - entry.text.length;
  for (let k = 0; k < 12 && delta > 0; k++) {
    const m = /^(# +)(\r?)$/.exec(out[k]);
    if (m) { const cut = Math.min(delta, m[1].length - 1); out[k] = m[1].slice(0, m[1].length - cut) + m[2]; delta -= cut; }
  }
  if (delta !== 0) throw new Error(`cannot keep the length (${delta} B left over)`);
}
const text = out.join('\n');
if (text.length !== entry.text.length) throw new Error('length changed');
const data = zlib.deflateSync(Buffer.from(text, 'latin1'), { level: 9 });
if (data.length > slot) throw new Error(`new stream ${data.length} B does not fit the ${slot} B slot`);

fs.writeSync(fd, Buffer.concat([data, Buffer.alloc(slot - data.length)]), 0, slot, entry.off); // zero the unused rest
const r = Buffer.alloc(8); r.writeUInt32LE(data.length, 0); r.writeUInt32LE(entry.usize - data.length, 4);
fs.writeSync(fd, r, 0, 8, tocOff + entry.p + 14);
const again = zlib.inflateSync(read(entry.off, data.length)).toString('latin1');
if (again !== text) throw new Error('verify failed: restore from the backup');
console.log(`patched: ${drop.size} overlay lines removed${vramCopy && !rerouted ? ', photo copy rerouted through VRAM' : ''} (${data.length} B stream); undo with "restore"`);
