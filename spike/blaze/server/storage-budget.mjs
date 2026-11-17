// How much disk the league data may use, and who is using it.
//
//   stateBudget    one total for everything under the data folder (NCAA_PRIVATE): dynasties.json, table files, Locker
//                  files, game data, Dynasty Wire media. Off until configure() is called with a limit (cloud mode).
//                  Writers ask fits(extraBytes) before they store something and record what they stored; a full scan
//                  at start and every few minutes corrects for files other programs write (the site sync) or remove.
//   folderUsage    bytes and file count of ONE folder (not its sub-folders), cached and kept current by recordWrite /
//                  recordRemove: the per-dynasty and per-member table caps in dod.mjs.
//
// Nothing here throws at a caller: a folder that cannot be read counts as empty.
import fs from 'node:fs';
import path from 'node:path';

export const MB = 1024 * 1024;
export const fileSize = (file) => { try { return fs.statSync(file).size; } catch { return 0; } };
export const mb = (bytes) => (bytes / MB >= 10 ? Math.round(bytes / MB) : Math.round((bytes / MB) * 10) / 10);

// Total size of a folder tree (sync). Used at start; the periodic rescan uses the async walk below.
export function treeSize(dir) {
  let bytes = 0, files = 0;
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { bytes, files }; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const sub = treeSize(p); bytes += sub.bytes; files += sub.files; }
    else if (e.isFile()) { bytes += fileSize(p); files++; }
  }
  return { bytes, files };
}
async function treeSizeAsync(dir) {
  let bytes = 0;
  let entries; try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) bytes += await treeSizeAsync(p);
    else if (e.isFile()) { try { bytes += (await fs.promises.stat(p)).size; } catch { /* removed meanwhile */ } }
  }
  return bytes;
}

export class StorageBudget {
  constructor() { this.root = ''; this.maxBytes = 0; this.used = 0; this.log = () => {}; this.folders = new Map(); this.lastRefusal = 0; this.warned = false; this.timer = null; this.now = Date.now; }
  get enabled() { return this.maxBytes > 0; }
  // root: the data folder. maxBytes: the budget (0 = off). rescanMs: how often the total is measured again.
  configure({ root, maxBytes = 0, log = () => {}, rescanMs = 5 * 60 * 1000, now = Date.now } = {}) {
    clearInterval(this.timer); this.timer = null;
    this.root = root ? path.resolve(root) : ''; this.maxBytes = Math.max(0, Number(maxBytes) || 0); this.log = log; this.now = now;
    this.used = 0; this.warned = false; this.lastRefusal = 0;
    if (!this.enabled || !this.root) return this;
    this.used = treeSize(this.root).bytes;
    this.log(`league data uses ${mb(this.used)} MB of the ${mb(this.maxBytes)} MB allowed (NCAA_STATE_BUDGET_MB)`);
    this.#warnIfNearlyFull();
    if (rescanMs > 0) { this.timer = setInterval(() => { this.rescan().catch(() => {}); }, rescanMs); this.timer.unref?.(); }
    return this;
  }
  async rescan() {
    if (!this.enabled || !this.root) return this.used;
    this.used = await treeSizeAsync(this.root);
    this.#warnIfNearlyFull();
    return this.used;
  }
  #warnIfNearlyFull() {
    const nearly = this.used >= this.maxBytes * 0.8;
    if (nearly && !this.warned) this.log(`WARNING: league data is at ${mb(this.used)} MB, more than 80% of the ${mb(this.maxBytes)} MB allowed (NCAA_STATE_BUDGET_MB). Uploads are refused when it is full.`);
    this.warned = nearly;
  }
  // May `extra` more bytes be stored? Always true when the budget is off or the change frees space.
  fits(extra) { return !this.enabled || extra <= 0 || this.used + extra <= this.maxBytes; }
  // The clear line for the log when something is refused because the budget is full (at most one a minute).
  refused(what) {
    const t = this.now();
    if (t - this.lastRefusal < 60000) return;
    this.lastRefusal = t;
    this.log(`STORAGE FULL: league data is at ${mb(this.used)} MB of the ${mb(this.maxBytes)} MB allowed (NCAA_STATE_BUDGET_MB). Refused: ${what}. New uploads are refused until space is freed or the limit is raised.`);
  }
  // ---- per-folder usage -------------------------------------------------------------------------------------
  // { bytes, count, sizes: Map(name -> bytes) } for the files directly in `dir` (temp and backup files left out).
  folderUsage(dir) {
    const k = path.resolve(dir);
    let u = this.folders.get(k);
    if (!u) {
      u = { bytes: 0, count: 0, sizes: new Map() };
      try {
        for (const e of fs.readdirSync(k, { withFileTypes: true })) {
          if (!e.isFile() || e.name.endsWith('.tmp') || e.name.endsWith('.bak')) continue;
          const size = fileSize(path.join(k, e.name)); u.sizes.set(e.name, size); u.bytes += size; u.count++;
        }
      } catch { /* no folder yet: empty */ }
      if (this.folders.size >= 20000) this.folders.delete(this.folders.keys().next().value); // bounded cache
      this.folders.set(k, u);
    }
    return u;
  }
  // A file was written (size = its new size; before = its size before the write) or removed.
  recordWrite(file, size, before = 0) {
    this.used = Math.max(0, this.used + size - before);
    const u = this.folders.get(path.resolve(path.dirname(file)));
    if (u) { const name = path.basename(file), old = u.sizes.get(name); if (old === undefined) u.count++; u.bytes += size - (old ?? 0); u.sizes.set(name, size); }
    if (this.enabled) this.#warnIfNearlyFull();
  }
  recordRemove(file, before = 0) {
    this.used = Math.max(0, this.used - before);
    const u = this.folders.get(path.resolve(path.dirname(file)));
    if (u) { const name = path.basename(file), old = u.sizes.get(name); if (old !== undefined) { u.count--; u.bytes -= old; u.sizes.delete(name); } }
  }
  // A whole folder tree was removed (a deleted dynasty's tables): bytes = its size before the removal.
  recordTreeRemoved(dir, bytes) {
    this.used = Math.max(0, this.used - bytes);
    const k = path.resolve(dir);
    for (const f of this.folders.keys()) if (f === k || f.startsWith(k + path.sep)) this.folders.delete(f);
  }
  forgetFolders() { this.folders.clear(); }
}

// The one budget of this process (blaze.mjs configures it in cloud mode; everything else only asks it).
export const stateBudget = new StorageBudget();

// Thrown by a store that will not take more data; `reason` is a short, loggable sentence (never user content).
export class StorageRefused extends Error {
  constructor(reason, { budget = false } = {}) { super(reason); this.name = 'StorageRefused'; this.reason = reason; this.budget = budget; }
}
