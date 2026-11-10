// One stored entry of a game archive (a BGFA qkl_*.ast) rewritten in place, with a way back. The entry is found by hash
// (stda.ts archiveToc), must be stored uncompressed and keeps its exact length, so the TOC is never touched and only the
// entry's bytes change. Before anything is written the original bytes go to <backupDir>/<archive>.<offset>.orig and a
// line is appended to <backupDir>/manifest.json (archive, hash, offset, length, sha256 before / after); the written
// entry is read back and must match, else the original is put straight back. `restoreEntries` walks a manifest and
// puts every entry back, refusing one that changed since the rewrite unless forced.
// This is the pattern swap/install.ts rewriteDb and stda.ts rekeyStdaArchive each use for their one entry, made generic
// so new experiments (ncaa-bridge playbook) do not copy it a third time.
// A second way, for an entry that must GROW (a compiled playbook with plays added): `appendEntry` writes the new bytes at
// the end of the archive and repoints the entry's TOC record (offset, csize, usize), leaving the old bytes where they
// were as dead space. The manifest keeps the old record and the old file length, so `restoreEntries` puts the record
// back and truncates the file to its old length when nothing else was appended after. Entry offsets carry no alignment
// in the stock archives (gcd 1), so the appended entry is only 16-aligned for tidiness.
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, ftruncateSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync, writeSync } from 'node:fs';
import { basename, join } from 'node:path';
import { STDA_BACKUP_ROOT, archiveLayout, archiveToc, type ArchiveEntry } from './stda.js';

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const hex = (h: bigint): string => h.toString(16).padStart(16, '0');

export interface EntryTarget { archive: string; hash: bigint }
export interface EntryManifestItem {
  archive: string; entryHash: string; offset: number; length: number; backupFile: string; shaBefore: string; shaAfter: string; note?: string;
  // an appended (grown) entry: where the new bytes went, the TOC record before and after (hex), the file length before
  kind?: 'rewrite' | 'append'; newOffset?: number; newLength?: number; recordOffset?: number; recordBefore?: string; recordAfter?: string; fileLengthBefore?: number;
}
export interface EntryManifest { created: string; tool: string; items: EntryManifestItem[] }
export type EntryOutcome = { status: 'written' | 'already' | 'skipped'; note: string; item?: EntryManifestItem };
// a fresh backup folder under the bridge's backup root: <stamp>-<label>, so `restore` can pick the newest by label
export const newEntryBackupDir = (label: string, root = STDA_BACKUP_ROOT): string => join(root, `${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}-${label}`);

// the entry's TOC record, checked to be stored (not compressed) and inside the file
function locateEntry(fd: number, t: EntryTarget): ArchiveEntry {
  const e = archiveToc(fd).find((x) => x.hash === t.hash);
  if (!e) throw new Error(`${t.archive}: no entry ${hex(t.hash)}`);
  if (e.csize !== e.usize) throw new Error(`${t.archive}: entry ${hex(t.hash)} is stored compressed (${e.csize} of ${e.usize} bytes): not rewritable in place`);
  if (e.off + e.csize > fstatSync(fd).size) throw new Error(`${t.archive}: entry ${hex(t.hash)} runs past the end of the file`);
  return e;
}
const readAt = (fd: number, off: number, len: number): Buffer => { const b = Buffer.alloc(len); readSync(fd, b, 0, len, off); return b; };

// The entry as the archive holds it now (throws when it is missing or compressed).
export function readEntry(t: EntryTarget): { off: number; bytes: Buffer; sha: string } {
  const fd = openSync(t.archive, 'r');
  try { const e = locateEntry(fd, t); const bytes = readAt(fd, e.off, e.csize); return { off: e.off, bytes, sha: sha256(bytes) }; } finally { closeSync(fd); }
}

// Replace the entry's bytes with `bytes` (same length, or this throws). `already` when the entry holds them; `skipped`
// when `replaces` is given and the entry's current sha is not one of them (something else changed it first).
export function rewriteEntry(t: EntryTarget, bytes: Uint8Array, backupDir: string, opts: { replaces?: readonly string[]; tool?: string; note?: string } = {}): EntryOutcome {
  const fd = openSync(t.archive, 'r+');
  try {
    const e = locateEntry(fd, t);
    if (bytes.length !== e.csize) throw new Error(`${t.archive}: entry ${hex(t.hash)} is ${e.csize} bytes; the rewrite is ${bytes.length} (an entry must keep its length)`);
    const cur = readAt(fd, e.off, e.csize), shaBefore = sha256(cur), shaAfter = sha256(bytes);
    if (shaBefore === shaAfter) return { status: 'already', note: `entry at ${e.off} already holds these bytes (sha ${shaAfter.slice(0, 12)})` };
    if (opts.replaces && !opts.replaces.includes(shaBefore)) return { status: 'skipped', note: `entry at ${e.off} holds sha ${shaBefore.slice(0, 12)}, not one this rewrite replaces` };
    // backup and manifest first
    mkdirSync(backupDir, { recursive: true });
    const backupFile = join(backupDir, `${basename(t.archive)}.${e.off}.orig`);
    if (existsSync(backupFile)) throw new Error(`${backupFile} exists; use a new backup folder`);
    writeFileSync(backupFile, cur);
    const item: EntryManifestItem = { archive: t.archive, entryHash: hex(t.hash), offset: e.off, length: e.csize, backupFile, shaBefore, shaAfter, ...(opts.note ? { note: opts.note } : {}) };
    const mf = join(backupDir, 'manifest.json');
    const manifest: EntryManifest = existsSync(mf) ? JSON.parse(readFileSync(mf, 'utf8')) : { created: new Date().toISOString(), tool: opts.tool ?? 'ncaa-bridge', items: [] };
    manifest.items.push(item); writeFileSync(mf, JSON.stringify(manifest, null, 1));
    // write, then read the whole entry back
    writeSync(fd, bytes, 0, bytes.length, e.off);
    if (sha256(readAt(fd, e.off, e.csize)) !== shaAfter) {
      writeSync(fd, cur, 0, cur.length, e.off);
      throw new Error(`${t.archive}: the entry read back does not match the rewrite; the original bytes were written back`);
    }
    let changed = 0; for (let i = 0; i < cur.length; i++) if (cur[i] !== bytes[i]) changed++;
    return { status: 'written', note: `entry at ${e.off} rewritten (${e.csize} bytes, ${changed} changed)`, item };
  } finally { closeSync(fd); }
}

// a TOC record's offset / csize / usize-csize fields, little endian, in the archive's widths
function tocRecord(fd: number, e: ArchiveEntry, off: number, csize: number, usize: number): Buffer {
  const L = archiveLayout(fd); const rec = Buffer.alloc(e.recordLength); readSync(fd, rec, 0, e.recordLength, e.recordOffset);
  const put = (o: number, n: number, v: number) => { if (v < 0 || v >= 2 ** (8 * n)) throw new Error(`${v} does not fit a ${n}-byte TOC field`); for (let i = 0; i < n; i++) rec[o + i] = Math.floor(v / 2 ** (8 * i)) & 255; };
  const o = 2 + L.hashW; put(o, L.offW, off); put(o + L.offW, L.csW, csize); put(o + L.offW + L.csW, L.usW, usize - csize);
  return rec;
}

// Replace the entry with `bytes` of any length: same length -> rewriteEntry; otherwise the bytes are appended to the
// archive (16-aligned) and the TOC record repointed. Backup = the old entry bytes + the old record in the manifest.
export function appendEntry(t: EntryTarget, bytes: Uint8Array, backupDir: string, opts: { replaces?: readonly string[]; tool?: string; note?: string } = {}): EntryOutcome {
  const fd0 = openSync(t.archive, 'r'); let e: ArchiveEntry; try { e = locateEntry(fd0, t); } finally { closeSync(fd0); }
  if (bytes.length === e.csize) return rewriteEntry(t, bytes, backupDir, opts);
  const fd = openSync(t.archive, 'r+');
  try {
    const cur = readAt(fd, e.off, e.csize), shaBefore = sha256(cur), shaAfter = sha256(bytes);
    if (opts.replaces && !opts.replaces.includes(shaBefore)) return { status: 'skipped', note: `entry at ${e.off} holds sha ${shaBefore.slice(0, 12)}, not one this rewrite replaces` };
    const fileLengthBefore = fstatSync(fd).size, newOffset = Math.ceil(fileLengthBefore / 16) * 16;
    const recordBefore = readAt(fd, e.recordOffset, e.recordLength), recordAfter = tocRecord(fd, e, newOffset, bytes.length, bytes.length);
    mkdirSync(backupDir, { recursive: true });
    const backupFile = join(backupDir, `${basename(t.archive)}.${e.off}.orig`);
    if (existsSync(backupFile)) throw new Error(`${backupFile} exists; use a new backup folder`);
    writeFileSync(backupFile, cur);
    const item: EntryManifestItem = { archive: t.archive, entryHash: hex(t.hash), offset: e.off, length: e.csize, backupFile, shaBefore, shaAfter, ...(opts.note ? { note: opts.note } : {}), kind: 'append', newOffset, newLength: bytes.length, recordOffset: e.recordOffset, recordBefore: recordBefore.toString('hex'), recordAfter: recordAfter.toString('hex'), fileLengthBefore };
    const mf = join(backupDir, 'manifest.json');
    const manifest: EntryManifest = existsSync(mf) ? JSON.parse(readFileSync(mf, 'utf8')) : { created: new Date().toISOString(), tool: opts.tool ?? 'ncaa-bridge', items: [] };
    manifest.items.push(item); writeFileSync(mf, JSON.stringify(manifest, null, 1));
    // the new bytes first (padding zeros up to the aligned offset), read back, then the record
    if (newOffset > fileLengthBefore) writeSync(fd, Buffer.alloc(newOffset - fileLengthBefore), 0, newOffset - fileLengthBefore, fileLengthBefore);
    writeSync(fd, bytes, 0, bytes.length, newOffset);
    if (sha256(readAt(fd, newOffset, bytes.length)) !== shaAfter) { ftruncateSync(fd, fileLengthBefore); throw new Error(`${t.archive}: the appended entry does not read back; the file was truncated back to ${fileLengthBefore} bytes`); }
    writeSync(fd, recordAfter, 0, recordAfter.length, e.recordOffset);
    const now = archiveToc(fd).find((x) => x.hash === t.hash);
    if (!now || now.off !== newOffset || now.csize !== bytes.length || now.usize !== bytes.length) { writeSync(fd, recordBefore, 0, recordBefore.length, e.recordOffset); ftruncateSync(fd, fileLengthBefore); throw new Error(`${t.archive}: the TOC record does not read back; record and length were put back`); }
    return { status: 'written', note: `entry moved from ${e.off} (${e.csize} bytes) to ${newOffset} (${bytes.length} bytes) at the end of the archive; TOC record at ${e.recordOffset} repointed`, item };
  } finally { closeSync(fd); }
}

// Put every entry of a backup folder back. An entry is only overwritten when it still holds what the rewrite wrote
// (or `force`); one that already holds the original is left alone. An appended entry gets its old TOC record back and
// the file is cut to its old length when the appended bytes are still the last thing in it.
export function restoreEntries(backupDir: string, opts: { force?: boolean } = {}): string[] {
  const manifest = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8')) as EntryManifest;
  const notes: string[] = [];
  for (const it of manifest.items) {
    const orig = readFileSync(it.backupFile);
    if (orig.length !== it.length || sha256(orig) !== it.shaBefore) throw new Error(`${it.backupFile} does not match its manifest entry`);
    const fd = openSync(it.archive, 'r+');
    try {
      if (it.kind === 'append') {
        const e = archiveToc(fd).find((x) => x.hash === BigInt(`0x${it.entryHash}`));
        if (!e) throw new Error(`${it.archive}: no entry ${it.entryHash}`);
        const rec = readAt(fd, it.recordOffset!, e.recordLength).toString('hex');
        if (rec === it.recordBefore && e.off === it.offset) { notes.push(`${it.archive}: entry ${it.entryHash} already points at the original`); continue; }
        if (rec !== it.recordAfter && !opts.force) throw new Error(`${it.archive}: the TOC record of ${it.entryHash} changed since the append; pass --force to restore anyway`);
        if (sha256(readAt(fd, it.offset, it.length)) !== it.shaBefore) throw new Error(`${it.archive}: the original bytes at ${it.offset} are no longer there; not restoring`);
        writeSync(fd, Buffer.from(it.recordBefore!, 'hex'), 0, e.recordLength, it.recordOffset!);
        const size = fstatSync(fd).size, tailEnd = it.newOffset! + it.newLength!;
        if (size === tailEnd || size === Math.ceil(tailEnd / 16) * 16) { ftruncateSync(fd, it.fileLengthBefore!); notes.push(`${it.archive}: entry ${it.entryHash} points at ${it.offset} again; file cut back to ${it.fileLengthBefore} bytes`); }
        else notes.push(`${it.archive}: entry ${it.entryHash} points at ${it.offset} again; ${size - it.fileLengthBefore!} bytes appended later were left in place`);
        continue;
      }
      const e = archiveToc(fd).find((x) => x.hash === BigInt(`0x${it.entryHash}`));
      if (!e || e.off !== it.offset || e.csize !== it.length) throw new Error(`${it.archive}: entry ${it.entryHash} moved or changed size since the backup; not restoring`);
      const now = sha256(readAt(fd, e.off, e.csize));
      if (now === it.shaBefore) { notes.push(`${it.archive}: entry at ${e.off} is already the original`); continue; }
      if (now !== it.shaAfter && !opts.force) throw new Error(`${it.archive}: entry at ${e.off} changed since the rewrite (sha ${now.slice(0, 12)}); pass --force to restore anyway`);
      writeSync(fd, orig, 0, orig.length, e.off);
      if (sha256(readAt(fd, e.off, e.csize)) !== it.shaBefore) throw new Error(`${it.archive}: the restored entry does not read back as the original`);
      notes.push(`${it.archive}: entry at ${e.off} restored (${it.length} bytes)`);
    } finally { closeSync(fd); }
  }
  return notes;
}
