// The SHA-256 of a built file, written next to it as <file>.sha256 in the usual one-line form
//   <64 hex digits> *<file name>
// FCS-online.exe is not code-signed, so this line is what a member (or the site's download page) compares against:
//   certutil -hashfile FCS-online.exe SHA256            (Command Prompt)
//   Get-FileHash FCS-online.exe -Algorithm SHA256       (PowerShell)
// build.mjs writes it after every exe build; release.mjs publishes it with the exe.
//   node installer/checksum.mjs [file]            write <file>.sha256 (default: installer/dist/FCS-online.exe)
//   node installer/checksum.mjs --verify [file]   compare the file with its .sha256; exit code 1 when they differ
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function sha256File(file) {
  const h = createHash('sha256'), fd = fs.openSync(file, 'r'), buf = Buffer.alloc(1 << 20);
  try { for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest('hex');
}
export const checksumPath = (file) => `${file}.sha256`;
export function writeChecksum(file) {
  const sha256 = sha256File(file), out = checksumPath(file);
  fs.writeFileSync(out, `${sha256} *${path.basename(file)}\n`);
  return { file: out, sha256 };
}
// the digest a checksum file names for `name` (null when it has no well-formed line for it)
export function readChecksum(text, name) {
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim());
    if (m && m[2] === name) return m[1].toLowerCase();
  }
  return null;
}
export function verifyChecksum(file) {
  const actual = sha256File(file);
  let expected = null; try { expected = readChecksum(fs.readFileSync(checksumPath(file), 'utf8'), path.basename(file)); } catch { /* no checksum file */ }
  return { ok: expected === actual, expected, actual };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), verify = args.includes('--verify');
  const file = path.resolve(args.find((a) => !a.startsWith('--')) ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist', 'FCS-online.exe'));
  if (!fs.existsSync(file)) { console.error(`${file} not found`); process.exit(1); }
  if (verify) {
    const r = verifyChecksum(file);
    console.log(r.ok ? `ok: ${path.basename(file)} matches ${path.basename(checksumPath(file))} (${r.actual})` : `MISMATCH: ${path.basename(file)} is ${r.actual}, ${path.basename(checksumPath(file))} says ${r.expected ?? 'nothing for this file'}`);
    process.exit(r.ok ? 0 : 1);
  }
  const r = writeChecksum(file);
  console.log(`${r.file}: ${r.sha256}`);
}
