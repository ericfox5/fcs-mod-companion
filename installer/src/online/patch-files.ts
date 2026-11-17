// RPCS3's two patch files as text in, text out (no file access here, so every rewrite can be tested on samples):
//   patches/imported_patch.yml    "Version: 1.2", then one top-level key per executable hash (PPU-<sha1>:) holding the
//                                 patch entries at two-space indent
//   config/patch_config.yml       hash -> entry name -> game title -> serial -> app version -> Enabled
// Only the section of the given hash is touched; other games' sections, comments and the file's line endings stay as
// they are.
export interface PatchEntry { name: string; block: string }

interface Node { head: string; body: string[]; rewritten?: boolean }   // a top-level line and the lines under it
interface Doc { pre: string[]; nodes: Node[]; eol: string }
function parse(text: string): Doc {
  const eol = text.includes('\r\n') ? '\r\n' : '\n', lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const doc: Doc = { pre: [], nodes: [], eol }; let cur: Node | null = null;
  for (const l of lines) {
    if (/^[^\s#]/.test(l)) { cur = { head: l, body: [] }; doc.nodes.push(cur); } else if (cur) cur.body.push(l); else doc.pre.push(l);
  }
  return doc;
}
const trimBlank = (lines: string[]) => { const out = [...lines]; while (out.length && !out.at(-1)!.trim()) out.pop(); return out; };
function print(doc: Doc): string {
  const lines = [...doc.pre];
  doc.nodes.forEach((n, i) => { lines.push(n.head, ...n.body); if (n.rewritten && i < doc.nodes.length - 1) lines.push(''); }); // a rewritten section lost its trailing blank line
  return trimBlank(lines).join(doc.eol) + doc.eol;
}
const isHash = (n: Node, hash: string) => n.head.replace(/\s+$/, '') === `${hash}:`;
// the entries of one section: a key at exactly two spaces starts one; lines before the first belong to the section
const keyRe = /^  ("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"][^#]*?):\s*$/;
const keyName = (raw: string) => (raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(["\\])/g, '$1') : raw.startsWith("'") ? raw.slice(1, -1).replace(/''/g, "'") : raw);
function entriesOf(n: Node): { lead: string[]; order: string[]; blocks: Map<string, string[]> } {
  const lead: string[] = [], order: string[] = [], blocks = new Map<string, string[]>(); let cur: string[] | null = null;
  for (const l of n.body) {
    const m = keyRe.exec(l);
    if (m) { const name = keyName(m[1]!); cur = [l]; if (!blocks.has(name)) order.push(name); blocks.set(name, cur); } else if (cur) cur.push(l); else lead.push(l);
  }
  for (const [k, v] of blocks) blocks.set(k, trimBlank(v));
  return { lead: trimBlank(lead), order, blocks };
}
const setEntries = (n: Node, e: { lead: string[]; order: string[]; blocks: Map<string, string[]> }) => { n.body = [...e.lead, ...e.order.flatMap((k) => e.blocks.get(k)!)]; n.rewritten = true; };
const blockLines = (block: string) => trimBlank(block.split(/\r?\n/));
const same = (a: string[] | undefined, b: string[]) => !!a && a.length === b.length && a.every((l, i) => l === b[i]);

// ---- patches/imported_patch.yml --------------------------------------------------------------------------------------
// Adds or replaces the named entries in the hash's section (created at the end of the file when missing).
export function mergePatchEntries(text: string | null, hash: string, entries: PatchEntry[]): { text: string; changed: string[]; kept: string[] } {
  const doc = parse(text && text.trim() ? text : 'Version: 1.2\n');
  let node = doc.nodes.find((n) => isHash(n, hash));
  if (!node) {
    const prev = doc.nodes.at(-1); if (prev && (!prev.body.length || prev.body.at(-1)!.trim())) prev.body.push('');
    node = { head: `${hash}:`, body: [] }; doc.nodes.push(node);
  }
  const e = entriesOf(node), changed: string[] = [], kept: string[] = [];
  for (const p of entries) {
    const want = blockLines(p.block);
    if (same(e.blocks.get(p.name), want)) { kept.push(p.name); continue; }
    if (!e.blocks.has(p.name)) e.order.push(p.name);
    e.blocks.set(p.name, want); changed.push(p.name);
  }
  if (!changed.length && text !== null) return { text, changed, kept };
  setEntries(node, e);
  return { text: print(doc), changed, kept };
}
export function removePatchEntry(text: string, hash: string, name: string): { text: string; removed: boolean } {
  const doc = parse(text), node = doc.nodes.find((n) => isHash(n, hash));
  if (!node) return { text, removed: false };
  const e = entriesOf(node); if (!e.blocks.has(name)) return { text, removed: false };
  e.blocks.delete(name); e.order = e.order.filter((k) => k !== name); setEntries(node, e);
  return { text: print(doc), removed: true };
}
// 'missing' | 'current' | 'different' against the block we would install
export function patchEntryState(text: string | null, hash: string, entry: PatchEntry): 'missing' | 'current' | 'different' {
  const have = patchEntryBlock(text, hash, entry.name);
  return have === null ? 'missing' : same(blockLines(have), blockLines(entry.block)) ? 'current' : 'different';
}
export function patchEntryBlock(text: string | null, hash: string, name: string): string | null {
  if (!text) return null;
  const node = parse(text).nodes.find((n) => isHash(n, hash)); if (!node) return null;
  const b = entriesOf(node).blocks.get(name);
  return b ? b.join('\n') + '\n' : null;
}

// ---- config/patch_config.yml ---------------------------------------------------------------------------------------
export const enabledBlock = (name: string, title: string, serial: string, versions: string[]) =>
  [`  "${name}":`, `    ${title}:`, `      ${serial}:`, ...versions.flatMap((v) => [`        ${v}:`, '          Enabled: true'])];
export function enablePatchEntries(text: string | null, hash: string, names: string[], game = { title: 'NCAA Football 14', serial: 'BLUS31159', versions: ['01.00', '01.02'] }): { text: string; changed: string[] } {
  const doc = parse(text ?? '');
  let node = doc.nodes.find((n) => isHash(n, hash));
  if (!node) { node = { head: `${hash}:`, body: [] }; doc.nodes.push(node); }
  const e = entriesOf(node), changed: string[] = [];
  for (const name of names) {
    const want = enabledBlock(name, game.title, game.serial, game.versions);
    if (same(e.blocks.get(name), want)) continue;
    if (!e.blocks.has(name)) e.order.push(name);
    e.blocks.set(name, want); changed.push(name);
  }
  if (!changed.length && text !== null) return { text, changed };
  setEntries(node, e);
  return { text: print(doc), changed };
}
export function removeEnabledEntry(text: string, hash: string, name: string): { text: string; removed: boolean } { return removePatchEntry(text, hash, name); }
export function isPatchEnabled(text: string | null, hash: string, name: string): boolean {
  if (!text) return false;
  const node = parse(text).nodes.find((n) => isHash(n, hash)); if (!node) return false;
  const b = entriesOf(node).blocks.get(name);
  return !!b && b.some((l) => /^\s+Enabled:\s*true\s*$/.test(l)) && !b.some((l) => /^\s+Enabled:\s*false\s*$/.test(l));
}
