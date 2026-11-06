// app.js — FCS Uniform Studio UI. Team-first: pick a team, see its uniforms and parts, edit textures. Files come from the
// local server (serve.mjs, automatic) or, when the page is opened on its own, from a folder picked with the File System
// Access API (Chrome/Edge) with downloads as the last resort. Codec functions come from codec.cjs (inlined).
'use strict';
(() => {
const C = globalThis.Codec;
const MAPPING = JSON.parse(document.getElementById('fcs-mapping').textContent);
const CONF_FOLDER = { UAC: 'FCS_DLC_UAC', SWAC: 'FCS_DLC_SWAC', 'Ivy League': 'FCS_DLC_IVY', CAA: 'FCS_DLC_CAA', Patriot: 'FCS_DLC_PATRIOT',
  Independents: 'FCS_DLC_MEAC', MEAC: 'FCS_DLC_MEAC', 'Big Sky': 'FCS_DLC_BIGSKY', 'BS-OVC': 'FCS_DLC_BSOVC', SoCon: 'FCS_DLC_SOCON',
  Generic: 'FCS_DLC_NEC', NEC: 'FCS_DLC_NEC', Southland: 'FCS_DLC_SOUTHLAND', MVFC: 'FCS_DLC_MVFC' };
const PART_OF = { HELMET: 'helmet', JERSEY: 'jersey', PANTSX: 'pants', SOCKSX: 'socks', SHOESX: 'shoes', GLOVES: 'gloves' };
const TYPE_ORDER = ['helmet', 'jersey', 'pants', 'socks', 'shoes', 'gloves'];
const GENERIC = [
  ['D1AANW', 'Wagner', [['D1AANW_HELMET_2007_RED_big', 'vanilla Northwest gold "NW" helmet'], ['D1AANW_HELMET_2007_GREEN_big', 'NOT vanilla: West Virginia gold/navy helmet'], ['D1AANW_JERSEY_2007_RED_big', 'vanilla green NORTHWEST jersey'], ['D1AANW_JERSEY_2007_WHITE_big', 'vanilla white NORTHWEST jersey'], ['D1AANW_JERSEY_2007_GREEN_big', 'plain dark green jersey'], ['D1AANW_PANTSX_2007_WHITE_big', 'white pants, red stripe'], ['D1AANW_PANTSX_2007_GREEN_big', 'green pants'], ['D1AANW_PANTSX_2007_RED_big', '']]],
  ['D1AAMW', 'Tuskegee', [['D1AAMW_HELMET_2007_GRAY_big', 'vanilla Midwest gray "MW" helmet'], ['D1AAMW_HELMET_2007_GOLD_big', 'NOT vanilla: navy helmet'], ['D1AAMW_JERSEY_2007_BLUE_big', 'NOT vanilla: plain red jersey'], ['D1AAMW_JERSEY_2007_GREEN_big', 'NOT vanilla: maroon jersey'], ['D1AAMW_JERSEY_2007_WHITE_big', 'NOT vanilla: black jersey'], ['D1AAMW_PANTSX_2007_GOLD_big', 'NOT vanilla: gray pants, 512x1024']]],
  ['D1AAEX', 'Mercyhurst', [['D1AAEX_HELMET_2007_WHITE_big', 'vanilla East purple "E" helmet'], ['D1AAEX_JERSEY_2007_BLUE_big', ''], ['D1AAEX_JERSEY_2007_WHITE_big', 'white jersey'], ['D1AAEX_PANTSX_2007_WHITE_big', 'NOT vanilla: purple pants']]],
  ['D1AASE', 'Delta State', [['D1AASE_HELMET_2007_WHITE_big', 'white helmet'], ['D1AASE_HELMET_2007_RED_big', 'reddish helmet'], ['D1AASE_JERSEY_2007_WHITE_big', 'white SOUTHEAST jersey, red trim'], ['D1AASE_JERSEY_2007_RED_big', ''], ['D1AASE_JERSEY_2007_YELLOW_big', ''], ['D1AASE_PANTSX_2007_WHITE_big', 'white pants, red stripes'], ['D1AASE_PANTSX_2007_BLACK_big', ''], ['D1AASE_PANTSX_2007_SILVER_big', '']]],
  ['D1AAWX', 'West Florida', [['D1AAWX_HELMET_2007_GOLD_big', ''], ['D1AAWX_HELMET_2007_BLACK_big', 'NOT vanilla: white Texas "150" helmet'], ['D1AAWX_JERSEY_2007_PURPLE_big', ''], ['D1AAWX_JERSEY_2007_WHITE_big', 'white jersey'], ['D1AAWX_JERSEY_2007_BLACK_big', ''], ['D1AAWX_PANTSX_2007_WHITE_big', 'white pants, purple stripe'], ['D1AAWX_PANTSX_2007_GOLD_big', '']]],
];
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === 'class') n.className = v; else if (k === 'html') n.innerHTML = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? '' : v); }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
  return n;
}
const logEl = $('#log');
function log(msg, cls = '') { const line = el('span', { class: cls }, `${new Date().toLocaleTimeString()}  ${msg}\n`); logEl.append(line); logEl.scrollTop = logEl.scrollHeight; (cls === 'err' ? console.error : console.log)(msg); }
let toastTimer = 0;
function toast(msg, cls = '') { const t = $('#toast'); t.textContent = msg; t.className = `toast show ${cls}`; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), cls === 'err' ? 6000 : 3200); }
const fmt = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`;
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { log(e.message || String(e), 'err'); toast(e.message || String(e), 'err'); console.error(e); } };
const FSA = typeof window.showDirectoryPicker === 'function';
$('#log-clear').onclick = () => { logEl.textContent = ''; };

const IO = { mode: 'none', cfg: null };
const S = { dir: null, dirName: '', files: [], subdirs: [], big: null, xml: null, arc: null, ns: { donors: [] }, team: null, thumbs: new Map(), bigs: new Map(), lastEvent: 0, open: new Set() };
const teamsBySlot = new Map(); for (const t of MAPPING.teams) { if (!teamsBySlot.has(t.slot)) teamsBySlot.set(t.slot, []); teamsBySlot.get(t.slot).push(t); }
const folderFor = (t) => (t.xml[0] ? t.xml[0].split('/')[0] : CONF_FOLDER[t.conf] || '');
const fileKind = (n) => /_mixandmatch\.xml$/i.test(n) ? 'xml' : /_big\.ast$/i.test(n) ? 'big' : /\.ast\.edat$/i.test(n) ? 'edat' : null;
const slotOf = (n) => { const m = /^([A-Z0-9]{6})_/i.exec(n); return m ? m[1].toUpperCase() : ''; };
const bigBase = (n) => n.replace(/\.(ast|big)$/i, '');
const typeOfBigfile = (name) => { const i = C.splitName(bigBase(name).replace(/_big$/i, '')); return i ? PART_OF[i.part.toUpperCase()] || null : null; };

// ---------- tabs / theme ----------
function showTab(id) { $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === id)); $$('section.tab').forEach((s) => s.classList.toggle('active', s.id === `tab-${id}`)); }
$$('#tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
const themes = ['auto', 'light', 'dark'];
function applyTheme(t) { if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = t; $('#theme-btn').textContent = `theme: ${t}`; }
let theme = 'auto'; try { theme = localStorage.getItem('fus-theme') || 'auto'; } catch {}
applyTheme(theme);
$('#theme-btn').onclick = () => { theme = themes[(themes.indexOf(theme) + 1) % 3]; applyTheme(theme); try { localStorage.setItem('fus-theme', theme); } catch {} };

// ---------- IO: server API, File System Access, or downloads ----------
const apiPath = (folder, name) => `/api/file/${encodeURIComponent(folder || '')}/${encodeURIComponent(name)}`;
async function refBytes(ref) {
  if (ref.api) { const r = await fetch(apiPath(ref.folder, ref.name), { cache: 'no-store' }); if (!r.ok) throw new Error(`cannot read ${ref.name}`); return new Uint8Array(await r.arrayBuffer()); }
  const f = ref.handle ? await ref.handle.getFile() : ref.file; return new Uint8Array(await f.arrayBuffer());
}
function download(name, bytes) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([bytes])); a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000); log(`downloaded ${name} (${fmt(bytes.length)})`); }
async function writeHandle(handle, bytes) { const w = await handle.createWritable(); await w.write(bytes); await w.close(); }
async function saveRef(ref, bytes) {
  if (ref.api) { const r = await fetch(apiPath(ref.folder, ref.name), { method: 'PUT', body: bytes }); if (!r.ok) throw new Error(`save failed: ${(await r.json()).error || r.status}`); ref.size = bytes.length; log(`saved ${ref.folder ? ref.folder + '/' : ''}${ref.name} (${fmt(bytes.length)})`, 'ok'); return ref; }
  if (ref.handle) { await writeHandle(ref.handle, bytes); ref.size = bytes.length; log(`saved ${ref.name} (${fmt(bytes.length)})`, 'ok'); return ref; }
  download(ref.name, bytes); return ref;
}
async function saveInto(folder, name, bytes) {
  const existing = S.files.find((f) => f.folder === folder && f.name.toLowerCase() === name.toLowerCase());
  if (existing) { await saveRef(existing, bytes); return existing; }
  if (IO.mode === 'api') { const ref = { name, folder, kind: fileKind(name), slot: slotOf(name), size: 0, api: true }; await saveRef(ref, bytes); S.files.push(ref); afterFilesChanged(); return ref; }
  if (IO.mode === 'fsa') {
    const sub = S.subdirs.find((d) => d.name === folder); const dh = sub ? sub.handle : S.dir;
    const h = await dh.getFileHandle(name, { create: true }); await writeHandle(h, bytes);
    const ref = { name, folder: sub ? folder : '', kind: fileKind(name), slot: slotOf(name), size: bytes.length, handle: h, dir: dh }; S.files.push(ref); afterFilesChanged(); log(`wrote ${folder ? folder + '/' : ''}${name}`, 'ok'); return ref;
  }
  download(name, bytes); return { name, folder, kind: fileKind(name), slot: slotOf(name), size: bytes.length, file: new File([bytes], name) };
}
async function saveAs(name, bytes) {
  if (window.showSaveFilePicker) { try { const h = await window.showSaveFilePicker({ suggestedName: name }); await writeHandle(h, bytes); log(`saved ${h.name}`, 'ok'); return { name: h.name, handle: h }; } catch (e) { if (e.name === 'AbortError') return null; throw e; } }
  download(name, bytes); return null;
}
async function archiveBytes(name) {
  const clean = bigBase(name).replace(/_big$/i, '') + '_BIG';
  if (IO.mode === 'api') { const r = await fetch(`/api/archive/${encodeURIComponent(clean.toUpperCase())}`, { cache: 'no-store' }); if (r.status === 404) return null; if (!r.ok) throw new Error('archive read failed'); return new Uint8Array(await r.arrayBuffer()); }
  if (S.arc) { const e = S.arc.map.get(C.hex64(C.fnv1a64(clean.toUpperCase()))); if (!e) return null; const raw = new Uint8Array(await S.arc.file.slice(e.off, e.off + e.csize).arrayBuffer()); return C.isZlib(raw) ? await C.zlibInflate(raw) : raw; }
  return null;
}
async function archiveHas(name) {
  const clean = bigBase(name).replace(/_big$/i, '') + '_BIG';
  if (IO.mode === 'api') { try { const r = await fetch(`/api/archive/${encodeURIComponent(clean.toUpperCase())}?probe=1`); return (await r.json()).found === true; } catch { return false; } }
  if (S.arc) return S.arc.map.has(C.hex64(C.fnv1a64(clean.toUpperCase())));
  return null; // unknown
}
async function archiveText(entryName) { const b = IO.mode === 'api' ? await (async () => { const r = await fetch(`/api/archive/${entryName}`); return r.ok ? new Uint8Array(await r.arrayBuffer()) : null; })() : S.arc ? await (async () => { const e = S.arc.map.get(C.hex64(C.fnv1a64(entryName))); if (!e) return null; const raw = new Uint8Array(await S.arc.file.slice(e.off, e.off + e.csize).arrayBuffer()); return C.isZlib(raw) ? await C.zlibInflate(raw) : raw; })() : null; return b ? new TextDecoder('latin1').decode(b) : null; }
function findBig(name, folder) {
  const want = `${bigBase(name)}.ast`.toLowerCase();
  return S.files.find((f) => f.kind === 'big' && f.folder === folder && f.name.toLowerCase() === want) || S.files.find((f) => f.kind === 'big' && f.name.toLowerCase() === want) || null;
}
function setSource(text, cls = '') { const s = $('#source-strip'); s.textContent = ''; s.append(el('span', { class: `pill ${cls}` }, IO.mode === 'api' ? 'local server' : IO.mode === 'fsa' ? 'folder access' : 'file only'), ' ', text); }
async function listApi() {
  const r = await fetch('/api/files', { cache: 'no-store' }); const j = await r.json();
  S.files = j.files.map((f) => ({ ...f, api: true, slot: slotOf(f.name) }));
  S.subdirs = [...new Set(S.files.map((f) => f.folder).filter(Boolean))].sort().map((name) => ({ name }));
  S.dirName = IO.cfg.dlcDir;
  afterFilesChanged();
}
function afterFilesChanged() {
  const bigs = S.files.filter((f) => f.kind === 'big').length, xmls = S.files.filter((f) => f.kind === 'xml').length;
  $('#folder-info').textContent = `${S.dirName}: ${bigs} bigfiles, ${xmls} mix-and-match XMLs${S.subdirs.length ? ` in ${S.subdirs.length} conference folders` : ''}`;
  renderFolder(); fillDonorSelects(); renderTeamList();
}
async function init() {
  $('#fsa-text').textContent = 'connecting';
  try { const r = await fetch('/api/config', { cache: 'no-store' }); if (r.ok) { IO.mode = 'api'; IO.cfg = await r.json(); } } catch {}
  if (IO.mode === 'api') {
    await listApi();
    $('#fsa-dot').className = 'dot on'; $('#fsa-text').textContent = 'saves into the game folder, backups kept';
    setSource(el('span', {}, el('code', {}, IO.cfg.dlcDir), ` · ${S.files.filter((f) => f.kind === 'big').length} bigfiles, ${S.files.filter((f) => f.kind === 'xml').length} uniform files · archive ${IO.cfg.archive ? 'connected' : 'not found'} · backups in `, el('code', {}, IO.cfg.backup)), 'ok');
    $('#open-folder').disabled = true; $('#open-folder').textContent = 'Folder loaded by the server'; $('#rescan-folder').disabled = false; $('#arc-find').disabled = false; $('#arc-info').textContent = `${IO.cfg.archive || 'archive not found'}`;
    log(`connected to ${IO.cfg.dlcDir} (${S.files.length} uniform files)`);
    pollEvents();
  } else if (FSA) {
    IO.mode = 'fsa'; $('#fsa-dot').className = 'dot warn'; $('#fsa-text').textContent = 'no server: pick the folder once';
    setSource(el('span', {}, 'Start ', el('code', {}, 'uniform-studio.cmd'), ' to load the folder automatically, or ', el('button', { class: 'small primary', onclick: openFolder }, 'Open your DLC folder…')), 'warn');
  } else {
    $('#fsa-dot').className = 'dot'; $('#fsa-text').textContent = 'read-only browser';
    setSource(el('span', {}, 'This browser cannot save into folders; use Chrome or Edge, or start ', el('code', {}, 'uniform-studio.cmd'), '. You can still ', el('button', { class: 'small', onclick: () => $('#pick-folder').click() }, 'open a folder read-only')), 'bad');
  }
  renderTeamList();
  const first = MAPPING.teams.find((t) => t.slot === 'D1AANW') || MAPPING.teams[0]; if (first && S.files.length) selectTeam(first);
}
async function pollEvents() {
  try {
    const r = await fetch(`/api/events?since=${S.lastEvent}`, { cache: 'no-store' }); const j = await r.json();
    for (const e of j.events) {
      S.lastEvent = e.id;
      if (e.type === 'repackaged') { log(e.msg, 'ok'); toast(`Repackaged ${e.entry} into ${e.big}`); invalidateBig(e.folder, e.big); }
      else if (e.type === 'error') { log(e.msg, 'err'); toast(e.msg, 'err'); }
      else if (e.type === 'dds-open') log(e.msg);
      else if (e.type === 'saved') { /* our own saves are logged already */ }
    }
    if (j.last !== undefined) S.lastEvent = Math.max(S.lastEvent, j.last);
  } catch {}
  setTimeout(pollEvents, 1500);
}
function invalidateBig(folder, name) {
  const key = `${folder}/${name}`.toLowerCase(); S.bigs.delete(key);
  for (const k of [...S.thumbs.keys()]) if (k.toLowerCase().startsWith(bigBase(name).toLowerCase())) S.thumbs.delete(k);
  const f = S.files.find((x) => x.folder === folder && x.name === name); if (f) f.mtime = Date.now();
  if (S.team) renderTeam();
}

// ---------- team list ----------
function renderTeamList() {
  const q = ($('#team-search').value || '').trim().toLowerCase(), conf = $('#team-conf').value, has = $('#team-xml').value;
  const box = $('#team-list'); box.textContent = '';
  for (const t of MAPPING.teams) {
    const own = S.files.some((f) => f.kind === 'xml' && f.slot === t.slot);
    if (conf && t.conf !== conf) continue; if (has === 'yes' && !own) continue; if (has === 'no' && own) continue;
    if (q && !`${t.name} ${t.nick} ${t.slot} ${t.conf} ${t.abbr}`.toLowerCase().includes(q)) continue;
    box.append(el('div', { class: `tl ${S.team?.team === t ? 'sel' : ''}`, onclick: () => selectTeam(t) }, el('span', {}, el('span', { class: 'n' }, t.name), ' ', el('span', { class: 's' }, t.slot)), el('span', { class: `pill ${own ? 'ok' : ''}` }, own ? 'file' : 'built-in')));
  }
}
{ const confs = [...new Set(MAPPING.teams.map((t) => t.conf))].sort(); for (const c of confs) $('#team-conf').append(el('option', { value: c }, c)); }
['#team-search', '#team-conf', '#team-xml'].forEach((s) => $(s).addEventListener('input', renderTeamList));

// ---------- team view ----------
const selectTeam = guard(async (team) => {
  S.team = { team, slot: team.slot, xmlRef: null, doc: null, source: 'none', folder: folderFor(team) };
  renderTeamList();
  $('#teampane').textContent = ''; $('#teampane').append(el('div', { class: 'card empty' }, `Loading ${team.name}…`));
  const xmls = S.files.filter((f) => f.kind === 'xml' && f.slot === team.slot).sort((a, b) => (/pack0/i.test(a.name) ? -1 : 1) - (/pack0/i.test(b.name) ? -1 : 1));
  if (xmls.length) { S.team.xmlRef = xmls[0]; S.team.folder = xmls[0].folder; S.team.source = 'folder'; S.team.text = new TextDecoder().decode(await refBytes(xmls[0])); }
  else { const t = await archiveText(`${team.slot}_MIXANDMATCH`); if (t) { S.team.text = t; S.team.source = 'archive'; } }
  if (S.team.text) { const doc = new DOMParser().parseFromString(S.team.text, 'text/xml'); if (doc.querySelector('parsererror')) throw new Error(`${team.slot}: ${doc.querySelector('parsererror').textContent.slice(0, 120)}`); S.team.doc = doc; }
  if (!S.team.folder && S.subdirs.length) S.team.folder = S.subdirs[0].name;
  renderTeam();
});
const xmlOfficialsOf = (doc) => $$('officialType', doc).map((n) => n.getAttribute('name'));
const partGet = (p, tag) => p.querySelector(tag)?.getAttribute('name') || '';
const partOfficials = (p) => $$('official', p).map((n) => n.getAttribute('name'));
function xmlTextOf(doc) { return `<?xml version="1.0" ?>${new XMLSerializer().serializeToString(doc.documentElement)}\n`; }
const saveTeamXml = guard(async () => {
  const T = S.team; if (!T?.doc) return;
  if (T.source !== 'folder') { toast('Copy the definition into the DLC folder first', 'err'); return; }
  await saveRef(T.xmlRef, new TextEncoder().encode(xmlTextOf(T.doc))); toast(`Saved ${T.xmlRef.name}`);
});
const copyToFolder = guard(async () => {
  const T = S.team; if (!T?.doc) return;
  const name = `${T.slot}_Pack0_MixAndMatch.XML`;
  T.xmlRef = await saveInto(T.folder, name, new TextEncoder().encode(xmlTextOf(T.doc))); T.source = 'folder';
  toast(`${name} written to ${T.folder || 'DLC'}; the team now uses it`); renderTeam(); renderTeamList();
});
function renderTeam() {
  const T = S.team; if (!T) return; const pane = $('#teampane'); pane.textContent = '';
  const t = T.team, teamsOnSlot = teamsBySlot.get(t.slot) || [];
  const head = el('div', { class: 'card' }, el('div', { class: 'team-head' },
    el('div', {}, el('h2', {}, t.name), el('div', { class: 'muted' }, t.nick)),
    el('div', { class: 'meta' }, el('span', { class: 'pill' }, `slot ${t.slot}`), el('span', { class: 'pill' }, t.conf), el('span', { class: 'pill' }, T.folder || 'DLC root'),
      T.source === 'folder' ? el('span', { class: 'pill ok', title: T.xmlRef.name }, `uniform file: ${T.xmlRef.name}`) : T.source === 'archive' ? el('span', { class: 'pill warn' }, 'built-in definition (read-only)') : el('span', { class: 'pill bad' }, 'no definition found'),
      teamsOnSlot.length > 1 ? el('span', { class: 'pill bad', title: teamsOnSlot.map((x) => x.name).join(', ') }, `${teamsOnSlot.length} teams share this slot`) : ''),
    el('span', { style: 'flex:1' }),
    el('div', { class: 'row tight' },
      T.source === 'archive' ? el('button', { class: 'primary', onclick: copyToFolder, title: 'write the built-in definition as a DLC file so it can be edited' }, 'Copy to DLC folder') : '',
      T.source === 'none' ? el('button', { class: 'primary', onclick: () => { $('#ns-team').value = t.slot; $('#ns-slot').value = t.slot; renderDonors(); showTab('newset'); } }, 'Create a set') : '',
      T.source === 'folder' ? el('button', { class: 'ghost', onclick: () => openXml(T.xmlRef) }, 'Raw XML') : '',
      IO.mode === 'api' ? el('button', { class: 'ghost', onclick: () => fetch('/api/open-folder', { method: 'POST', body: JSON.stringify({ folder: T.folder }) }) }, 'Open folder') : '')));
  pane.append(head);
  if (!T.doc) {
    pane.append(el('div', { class: 'card empty' }, T.source === 'none' && IO.mode !== 'api' && !S.arc ? 'No uniform file for this slot in the folder. Open qkl_fe2ig.ast in the Archive tab to read the built-in definition, or create a set.' : 'No definition for this slot anywhere: create a set.'));
    return;
  }
  const doc = T.doc, officials = xmlOfficialsOf(doc), parts = $$('part', doc), editable = T.source === 'folder';
  // uniforms
  const grid = el('div', { class: 'uni-grid' });
  officials.forEach((o, i) => {
    const card = el('div', { class: 'uni-card' }, el('h4', {}, el('span', {}, o, i === 0 ? el('span', { class: 'pill red', style: 'margin-left:8px' }, 'home') : i === 1 ? el('span', { class: 'pill red', style: 'margin-left:8px' }, 'away') : ''), el('span', { class: 'idx' }, `row ${i} `, editable ? el('button', { class: 'small ghost', style: 'color:#ddd;border-color:#555;min-height:20px;padding:0 5px', title: 'remove this uniform', onclick: () => { $$('officialType', doc)[i].remove(); $$('part official', doc).filter((n) => n.getAttribute('name') === o).forEach((n) => n.remove()); saveTeamXml(); renderTeam(); } }, '×') : '')));
    for (const type of TYPE_ORDER) {
      const candidates = parts.filter((p) => p.getAttribute('type') === type); if (!candidates.length && type !== 'helmet' && type !== 'jersey' && type !== 'pants') continue;
      const cur = candidates.find((p) => partOfficials(p).includes(o));
      const sel = el('select', { class: 'small', disabled: !editable, onchange: (e) => { candidates.forEach((p) => $$('official', p).filter((n) => n.getAttribute('name') === o).forEach((n) => n.remove())); const pick = candidates[Number(e.target.value)]; if (pick) { const n = doc.createElement('official'); n.setAttribute('name', o); const anchor = pick.querySelector('decalUV'); if (anchor) pick.insertBefore(n, anchor); else pick.append(n); } saveTeamXml(); renderTeam(); } },
        el('option', { value: '-1' }, candidates.length ? '— none —' : 'no parts of this type'), ...candidates.map((p, k) => el('option', { value: String(k), selected: p === cur }, `${p.getAttribute('name') || '?'} · ${partGet(p, 'bigfile')}`)));
      const thumb = cur ? thumbCanvas(partGet(cur, 'bigfile'), T.folder) : el('div', { class: 'ph' });
      card.append(el('div', { class: 'uni-part' }, thumb, el('div', {}, el('div', { class: 'pt' }, type), sel)));
    }
    grid.append(card);
  });
  const addOff = el('div', { class: 'row tight', style: 'margin-top:10px' }, el('input', { type: 'text', id: 'team-new-official', placeholder: 'add a uniform, e.g. Alt #1', style: 'width:220px', disabled: !editable }), el('button', { class: 'small', disabled: !editable, onclick: () => { const v = $('#team-new-official').value.trim(); if (!v) return; const n = doc.createElement('officialType'); n.setAttribute('name', v); const last = $$('officialType', doc).pop(); if (last) last.after(n); else doc.documentElement.prepend(n); saveTeamXml(); renderTeam(); } }, 'Add uniform'));
  pane.append(el('div', { class: 'card' }, el('h3', {}, `Uniforms (${officials.length})`), editable ? '' : el('p', { class: 'muted', style: 'font-size:12px;margin:0 0 8px' }, 'Built-in definition: copy it to the DLC folder to change anything.'), grid, addOff));
  // parts
  const table = el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, ''), el('th', {}, 'Part'), el('th', {}, 'Bigfile'), el('th', {}, 'Where'), el('th', {}, 'Used by'), el('th', {}, ''))));
  const tb = el('tbody', {}); table.append(tb);
  const sorted = parts.slice().sort((a, b) => TYPE_ORDER.indexOf(a.getAttribute('type')) - TYPE_ORDER.indexOf(b.getAttribute('type')));
  for (const p of sorted) {
    const big = partGet(p, 'bigfile'), key = `${T.slot}:${big}`, inFolder = findBig(big, T.folder);
    const where = el('span', { class: 'pill' }, '…');
    if (inFolder && inFolder.folder === T.folder) { where.className = 'pill ok'; where.textContent = 'in folder'; }
    else if (inFolder) { where.className = 'pill ok'; where.textContent = `in ${inFolder.folder}`; where.title = 'bigfiles are found in any FCS_DLC_* folder'; }
    else if (/^generic_/i.test(big)) { where.textContent = 'game generic'; }
    else archiveHas(big).then((h) => { if (h === true) { where.className = 'pill warn'; where.textContent = 'in game archive'; } else if (h === false) { where.className = 'pill bad'; where.textContent = 'MISSING (crashes the game)'; } else where.textContent = 'archive?'; });
    const used = partOfficials(p);
    const actions = el('div', { class: 'row tight' },
      el('button', { class: 'small primary', onclick: () => toggleTextures(p, key) }, S.open.has(key) ? 'Hide textures' : 'Textures'),
      !inFolder && !/^generic_/i.test(big) ? el('button', { class: 'small', title: 'copy the bigfile out of the game archive into this folder so it can be edited', onclick: guard(async () => { const b = await archiveBytes(big); if (!b) throw new Error(`${big} is not in the archive`); await saveInto(T.folder, `${bigBase(big)}.ast`, b); S.thumbs.delete(big); toast(`${big} pulled into ${T.folder}`); renderTeam(); }) }, 'Pull into folder') : '',
      el('button', { class: 'small ghost', disabled: !editable, onclick: () => { p.remove(); saveTeamXml(); renderTeam(); } }, 'Remove'));
    tb.append(el('tr', { class: 'part-row' }, el('td', {}, thumbCanvas(big, T.folder, 'thumb')), el('td', {}, el('strong', {}, p.getAttribute('type')), ' ', p.getAttribute('name') || '', p.getAttribute('shade') ? el('div', { class: 'muted', style: 'font-size:11px' }, p.getAttribute('shade')) : ''), el('td', { class: 'mono' }, big), el('td', {}, where), el('td', {}, used.length ? used.map((u) => el('span', { class: 'pill ok', style: 'margin:1px' }, u)) : el('span', { class: 'muted' }, 'unused')), el('td', {}, actions)));
    if (S.open.has(key)) { const sub = el('tr', { class: 'sub' }, el('td', { colspan: 6 }, el('div', { class: 'muted' }, 'loading textures…'))); tb.append(sub); renderTextures(sub.firstChild, p, big); }
  }
  const bigOptions = S.files.filter((f) => f.kind === 'big').sort((a, b) => (a.folder === T.folder ? -1 : 1) - (b.folder === T.folder ? -1 : 1) || a.name.localeCompare(b.name));
  const addSel = el('select', { id: 'team-add-big', style: 'min-width:280px' }, el('option', { value: '' }, 'choose a bigfile'), ...bigOptions.map((f) => el('option', { value: String(S.files.indexOf(f)) }, `${f.folder ? f.folder + '/' : ''}${f.name}`)));
  const addLabel = el('input', { type: 'text', id: 'team-add-label', placeholder: 'label (e.g. White)', style: 'width:140px' });
  const addRow = el('div', { class: 'row', style: 'margin-top:10px' },
    el('label', { class: 'f' }, 'Add an existing part', addSel), el('label', { class: 'f' }, 'Label', addLabel),
    el('button', { class: 'small', disabled: !editable, onclick: guard(async () => {
      const f = S.files[Number(addSel.value)]; if (!f) return; const scene = bigBase(f.name).replace(/_big$/i, ''); const type = typeOfBigfile(f.name); if (!type) throw new Error('cannot tell the part type from the name');
      const frag = new DOMParser().parseFromString(C.partTemplate(type, addLabel.value || (C.splitName(scene)?.color ?? 'Part'), `${scene}_big`, scene), 'text/xml').documentElement;
      doc.documentElement.append(doc.importNode(frag, true)); saveTeamXml(); renderTeam();
    }) }, 'Add part'),
    el('span', { class: 'muted', style: 'align-self:center' }, 'or'),
    el('button', { class: 'small', disabled: !editable, onclick: () => renderCloneBox(pane) }, 'Clone a part from another team…'));
  pane.append(el('div', { class: 'card' }, el('h3', {}, `Parts (${parts.length})`), el('div', { class: 'scroll' }, table), addRow, el('div', { id: 'clone-box' })));
}
function toggleTextures(p, key) { if (S.open.has(key)) S.open.delete(key); else S.open.add(key); renderTeam(); }
async function loadBigFor(big, folder) {
  const ref = findBig(big, folder); const key = ref ? `${ref.folder}/${ref.name}`.toLowerCase() : `archive:${big}`.toLowerCase();
  if (S.bigs.has(key)) return S.bigs.get(key);
  const p = (async () => {
    const bytes = ref ? await refBytes(ref) : await archiveBytes(big);
    if (!bytes) return null;
    const parsed = C.parseBigfile(bytes, ref ? ref.name : big); for (const e of parsed.entries) await C.loadEntry(e);
    return { ref, parsed, fromArchive: !ref };
  })();
  S.bigs.set(key, p); return p;
}
function thumbCanvas(big, folder, cls = '') {
  const cv = el('canvas', { class: cls, width: 8, height: 8, title: big });
  const key = `${big}`;
  const draw = (src) => { if (!src) return; cv.width = src.width; cv.height = src.height; cv.getContext('2d').drawImage(src, 0, 0); };
  if (S.thumbs.has(key)) { const v = S.thumbs.get(key); if (v && v.then) v.then(draw); else draw(v); return cv; }
  const p = (async () => {
    try {
      const b = await loadBigFor(big, folder); if (!b) return null;
      const texes = b.parsed.entries.filter((e) => C.entryKind(e.name) === 'texture');
      const e = texes.find((x) => /BAKED_COL$/i.test(x.name)) || texes.find((x) => /_COL$/i.test(x.name)) || texes[0]; if (!e) return null;
      const t = C.parseTexture(e.data, e.name); let L = 0; while (Math.max(t.width >> L, t.height >> L) > 128 && L < t.mips - 1) L++;
      const m = C.decodeMip(t, L); const c = el('canvas', { width: m.width, height: m.height }); c.getContext('2d').putImageData(new ImageData(m.rgba, m.width, m.height), 0, 0);
      S.thumbs.set(key, c); return c;
    } catch (err) { console.warn(big, err); S.thumbs.set(key, null); return null; }
  })();
  S.thumbs.set(key, p); p.then(draw);
  return cv;
}
let pendingImport = null;
async function renderTextures(box, part, big) {
  const T = S.team; const b = await loadBigFor(big, T.folder);
  box.textContent = '';
  if (!b) { box.append(el('span', { class: 'pill bad' }, `${big} was not found in the folder or the archive`)); return; }
  const list = el('div', { class: 'tex-list' });
  if (b.fromArchive) box.append(el('div', { class: 'muted', style: 'margin:4px 0' }, 'This bigfile lives in the game archive. Pull it into the folder to edit its textures.'));
  for (const e of b.parsed.entries) {
    const kind = C.entryKind(e.name);
    if (kind !== 'texture') { list.append(el('div', { class: 'tex' }, el('div', { class: 'muted', style: 'font-size:11px;text-align:center' }, kind), el('div', {}, el('div', { class: 'tn' }, e.name), el('div', { class: 'st' }, kind === 'scene' ? 'scene (geometry + texture references)' : 'kerning table')))); continue; }
    let t; try { t = C.parseTexture(e.data, e.name); } catch (err) { list.append(el('div', { class: 'tex' }, el('span', {}, '?'), el('div', { class: 'tn' }, e.name, ' ', el('span', { class: 'pill bad' }, err.message)))); continue; }
    const cv = el('canvas', { width: 8, height: 8 }); { let L = 0; while (Math.max(t.width >> L, t.height >> L) > 144 && L < t.mips - 1) L++; const m = C.decodeMip(t, L); cv.width = m.width; cv.height = m.height; cv.getContext('2d').putImageData(new ImageData(m.rgba, m.width, m.height), 0, 0); }
    const st = el('div', { class: 'st' }, `${t.fourcc} ${t.width}×${t.height}, ${t.mips} mips`);
    const editable = !b.fromArchive;
    const acts = el('div', { class: 'ta' },
      IO.mode === 'api' ? el('button', { class: 'small primary', disabled: !editable, title: 'write as DDS and open it in your DDS editor; saving there repackages the bigfile', onclick: guard(async () => { const r = await fetch('/api/dds/open', { method: 'POST', body: JSON.stringify({ folder: b.ref.folder, big: b.ref.name, entry: e.name }) }); const j = await r.json(); if (!r.ok) throw new Error(j.error); st.textContent = `editing in your DDS app · save there to repackage · ${j.path}`; toast(`${e.name} opened in your DDS editor`); }) }, 'Edit DDS') : el('button', { class: 'small primary', onclick: guard(async () => saveAs(`${e.name}.dds`, C.toDDS(t))) }, 'Export DDS'),
      el('button', { class: 'small', disabled: !editable, onclick: () => { pendingImport = { b, entry: e, team: true }; $('#pick-image').click(); } }, 'Import…'),
      el('button', { class: 'small', disabled: !editable, onclick: guard(async () => { await openBig(b.ref); openTexture(S.big.parsed.entries.find((x) => x.name === e.name)); }) }, 'Quick edit'),
      el('button', { class: 'small ghost', onclick: guard(async () => saveAs(`${e.name}.png`, await pngBytes(t))) }, 'PNG'),
      IO.mode === 'api' ? el('button', { class: 'small ghost', onclick: guard(async () => saveAs(`${e.name}.dds`, C.toDDS(t))) }, 'DDS') : '');
    list.append(el('div', { class: 'tex' }, cv, el('div', {}, el('div', { class: 'tn' }, e.name), st, acts)));
  }
  box.append(list);
}
function renderCloneBox(pane) {
  const T = S.team, box = $('#clone-box'); box.textContent = '';
  const donors = S.files.filter((f) => f.kind === 'big' && f.slot !== T.slot).sort((a, b) => a.name.localeCompare(b.name));
  const sel = el('select', { style: 'min-width:300px' }, el('option', { value: '' }, 'donor bigfile (another team, or one pulled from the archive)'), ...donors.map((f) => el('option', { value: String(S.files.indexOf(f)) }, `${(teamsBySlot.get(f.slot) || [])[0]?.name || f.slot}: ${f.name}`)));
  const color = el('input', { type: 'text', placeholder: 'colour', style: 'width:110px;text-transform:uppercase' });
  const year = el('input', { type: 'text', value: new Date().getFullYear() > 2013 ? String(new Date().getFullYear()) : '2025', maxlength: '4', style: 'width:80px' });
  const info = el('span', { class: 'muted' });
  sel.addEventListener('change', () => { const f = S.files[Number(sel.value)]; const i = f && C.splitName(bigBase(f.name).replace(/_big$/i, '')); if (i) { color.value = i.color; color.maxLength = i.color.length; info.textContent = `${i.part} ${i.year} · colour token must be ${i.color.length} characters`; } });
  const offs = xmlOfficialsOf(T.doc).map((o) => el('label', { style: 'margin-right:8px' }, el('input', { type: 'checkbox', value: o }), ` ${o}`));
  box.append(el('div', { class: 'card', style: 'margin-top:10px;background:var(--panel-2)' }, el('h3', {}, 'Clone a part into this team'),
    el('div', { class: 'row' }, el('label', { class: 'f' }, 'Donor', sel), el('label', { class: 'f' }, 'New colour', color), el('label', { class: 'f' }, 'Year', year), el('div', { class: 'f' }, el('span', { style: 'font-size:12px;color:var(--muted);text-transform:uppercase;font-weight:600' }, 'Use for'), el('div', {}, ...offs))),
    el('div', { class: 'row', style: 'margin-top:8px' }, el('button', { class: 'primary', onclick: guard(async () => {
      const f = S.files[Number(sel.value)]; if (!f) throw new Error('pick a donor');
      const big = C.parseBigfile(await refBytes(f), f.name); const scene = big.entries.find((e) => C.entryKind(e.name) === 'scene'); const i = C.splitName(scene.name);
      if (!i) throw new Error('donor name is not SLOT_PART_YEAR_COLOR'); const nc = color.value.toUpperCase(); if (nc.length !== i.color.length) throw new Error(`colour must be ${i.color.length} characters`);
      const map = [{ from: i.slot, to: T.slot }]; if (i.year !== year.value && /^\d{4}$/.test(year.value)) map.push({ from: i.year, to: year.value }); if (i.color.toUpperCase() !== nc) map.push({ from: i.color, to: nc });
      (await C.renameBigfile(big, map)).forEach((n) => log(`  ${n}`));
      const newScene = big.entries.find((e) => C.entryKind(e.name) === 'scene').name;
      await saveInto(T.folder, `${newScene}_big.ast`, await C.buildBigfile(big));
      const type = PART_OF[i.part.toUpperCase()]; const frag = new DOMParser().parseFromString(C.partTemplate(type, nc, `${newScene}_big`, newScene), 'text/xml').documentElement;
      const node = T.doc.importNode(frag, true); for (const o of offs.filter((l) => l.firstChild.checked).map((l) => l.firstChild.value)) { const n = T.doc.createElement('official'); n.setAttribute('name', o); const anchor = node.querySelector('decalUV'); if (anchor) node.insertBefore(n, anchor); else node.append(n); }
      T.doc.documentElement.append(node); await saveTeamXml(); toast(`${newScene} created from ${f.name}`); renderTeam();
    }) }, 'Clone'), el('button', { class: 'ghost', onclick: () => { box.textContent = ''; } }, 'Cancel'), info)));
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------- folder tab (manual mode) ----------
async function scanDir(dh, folder) {
  for await (const [name, h] of dh.entries()) {
    if (h.kind === 'directory') { if (!folder && /^FCS_DLC_/i.test(name)) { S.subdirs.push({ name, handle: h }); await scanDir(h, name); } continue; }
    const kind = fileKind(name); if (!kind) continue;
    const f = await h.getFile();
    S.files.push({ name, handle: h, dir: dh, folder, kind, size: f.size, slot: slotOf(name) });
  }
}
const openFolder = guard(async () => {
  if (IO.mode === 'api') return;
  if (FSA) {
    const dir = await window.showDirectoryPicker({ mode: 'readwrite' }).catch((e) => { if (e.name !== 'AbortError') throw e; }); if (!dir) return;
    S.dir = dir; S.dirName = dir.name; S.files = []; S.subdirs = []; await scanDir(dir, '');
    setSource(el('span', {}, el('code', {}, dir.name), ` · ${S.files.filter((f) => f.kind === 'big').length} bigfiles, ${S.files.filter((f) => f.kind === 'xml').length} uniform files`), 'ok');
    $('#rescan-folder').disabled = false; afterFilesChanged(); log(`opened ${dir.name}: ${S.files.length} uniform files`);
    if (S.team) selectTeam(S.team.team); else { const first = MAPPING.teams.find((t) => t.slot === 'D1AANW'); if (first) selectTeam(first); }
  } else $('#pick-folder').click();
});
$('#pick-folder').addEventListener('change', (ev) => {
  const files = [...ev.target.files]; S.dir = null; S.files = []; S.subdirs = []; S.dirName = files[0]?.webkitRelativePath.split('/')[0] || 'folder';
  for (const f of files) { const kind = fileKind(f.name); if (!kind) continue; const parts = f.webkitRelativePath.split('/'); const folder = parts.length > 2 && /^FCS_DLC_/i.test(parts[parts.length - 2]) ? parts[parts.length - 2] : ''; S.files.push({ name: f.name, file: f, dir: null, folder, kind, size: f.size, slot: slotOf(f.name) }); }
  S.subdirs = [...new Set(S.files.map((f) => f.folder).filter(Boolean))].map((name) => ({ name }));
  afterFilesChanged(); if (S.team) selectTeam(S.team.team);
});
$('#open-folder').onclick = openFolder;
$('#rescan-folder').onclick = guard(async () => { if (IO.mode === 'api') { S.bigs.clear(); S.thumbs.clear(); await listApi(); if (S.team) selectTeam(S.team.team); return; } S.files = []; S.subdirs = []; await scanDir(S.dir, ''); afterFilesChanged(); });
$('#folder-filter').addEventListener('input', renderFolder);
function renderFolder() {
  const q = $('#folder-filter').value.trim().toLowerCase(); const tb = $('#folder-table tbody'); tb.textContent = '';
  const rows = S.files.filter((f) => { if (!q) return true; const teams = (teamsBySlot.get(f.slot) || []).map((t) => t.name).join(' '); return `${f.slot} ${teams} ${f.name} ${f.folder}`.toLowerCase().includes(q); }).sort((a, b) => a.slot.localeCompare(b.slot) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  if (!rows.length) { tb.append(el('tr', {}, el('td', { colspan: 6, class: 'empty' }, S.files.length ? 'nothing matches' : 'no files loaded'))); return; }
  for (const f of rows) {
    const teams = (teamsBySlot.get(f.slot) || []).map((t) => t.name).join(', ');
    const act = f.kind === 'big' ? el('button', { class: 'small', onclick: () => openBig(f) }, 'Open') : f.kind === 'xml' ? el('button', { class: 'small', onclick: () => openXml(f) }, 'Edit XML') : el('span', { class: 'pill' }, 'encrypted');
    tb.append(el('tr', {}, el('td', {}, el('code', {}, f.slot)), el('td', {}, teams || el('span', { class: 'muted' }, '—')), el('td', { class: 'mono' }, f.folder ? `${f.folder}/` : '', f.name), el('td', {}, el('span', { class: `pill ${f.kind === 'xml' ? 'ok' : ''}` }, f.kind === 'big' ? 'bigfile' : f.kind === 'xml' ? 'mix & match' : 'edat')), el('td', {}, fmt(f.size)), el('td', {}, act)));
  }
}

// ---------- bigfile tab ----------
$('#open-big-file').onclick = guard(async () => {
  if (window.showOpenFilePicker) { const [h] = await window.showOpenFilePicker({ types: [{ description: 'bigfile', accept: { 'application/octet-stream': ['.ast', '.AST', '.big'] } }] }).catch((e) => { if (e.name !== 'AbortError') throw e; return []; }); if (h) await openBig({ name: h.name, handle: h, folder: '', kind: 'big', slot: slotOf(h.name) }); }
  else $('#pick-big').click();
});
$('#pick-big').addEventListener('change', (ev) => { const f = ev.target.files[0]; if (f) openBig({ name: f.name, file: f, folder: '', kind: 'big', slot: slotOf(f.name) }); ev.target.value = ''; });
const openBig = guard(async (ref) => {
  const bytes = await refBytes(ref); const parsed = C.parseBigfile(bytes, ref.name);
  S.big = { ref, parsed, name: ref.name }; for (const e of parsed.entries) await C.loadEntry(e);
  renderBig(); showTab('bigfile');
  const sceneName = parsed.entries.find((e) => C.entryKind(e.name) === 'scene')?.name || ''; const expect = bigBase(ref.name).replace(/_big$/i, '').toUpperCase();
  if (sceneName && sceneName.toUpperCase() !== expect) log(`${ref.name}: the file name says ${expect} but the scene inside is ${sceneName}`, 'warn');
  log(`opened ${ref.name}: ${parsed.entries.length} entries`);
});
function renderBig() {
  const b = S.big; const tb = $('#big-table tbody'); tb.textContent = '';
  $('#big-title').textContent = b ? b.name : ''; $('#big-info').textContent = b ? `${b.parsed.entries.length} entries · prefix ${b.parsed.prefix.map((x) => x.toString(16)).join(' ')} · ${fmt(b.parsed.size)}` : '';
  const dirty = !!b && b.parsed.entries.some((e) => e.dirty);
  $('#big-save').disabled = !b || !dirty || !(b.ref.api || b.ref.handle); $('#big-save-as').disabled = !b; $('#big-scene').hidden = true;
  if (!b) { tb.append(el('tr', {}, el('td', { colspan: 7, class: 'empty' }, 'open a bigfile from the Files tab or a team\'s part list'))); return; }
  for (const e of b.parsed.entries) {
    const kind = C.entryKind(e.name); const size = e.data ? e.data.length : e.csize + e.delta;
    const tdPrev = el('td', {}), tdFmt = el('td', {}), tdAct = el('td', {});
    if (kind === 'texture') {
      try {
        const t = C.parseTexture(e.data, e.name); e.tex = t;
        tdFmt.append(el('span', { class: 'mono' }, `${t.fourcc} ${t.width}×${t.height}, ${t.mips} mips`));
        const cv = el('canvas', { class: 'thumb' }); tdPrev.append(cv); drawThumb(cv, t);
        tdAct.append(el('button', { class: 'small primary', onclick: () => openTexture(e) }, 'Edit'), ' ', el('button', { class: 'small ghost', onclick: guard(async () => saveAs(`${e.name}.png`, await pngBytes(t))) }, 'PNG'), ' ', el('button', { class: 'small ghost', title: 'exact original DXT blocks', onclick: guard(async () => saveAs(`${e.name}.dds`, C.toDDS(t))) }, 'DDS'), ' ', el('button', { class: 'small ghost', onclick: () => { pendingImport = { entry: e, direct: true }; $('#pick-image').click(); } }, 'Replace…'));
      } catch (err) { tdFmt.append(el('span', { class: 'pill bad' }, err.message)); }
    } else if (kind === 'scene') { tdFmt.append(el('span', { class: 'muted' }, 'scene (RSF)')); tdAct.append(el('button', { class: 'small ghost', onclick: () => { $('#big-scene').hidden = false; $('#big-scene-text').textContent = sceneRefs(e.data).join('\n'); } }, 'References')); }
    else { tdFmt.append(el('span', { class: 'muted' }, 'kerning table (text)')); tdAct.append(el('button', { class: 'small ghost', onclick: () => { $('#big-scene').hidden = false; $('#big-scene-text').textContent = new TextDecoder('latin1').decode(e.data); } }, 'Show')); }
    tdAct.append(' ', el('button', { class: 'small ghost', onclick: guard(async () => saveAs(`${e.name}.bin`, e.data)) }, 'Raw'));
    tb.append(el('tr', {}, tdPrev, el('td', { class: 'mono' }, e.name, e.dirty ? ' ' : '', e.dirty ? el('span', { class: 'pill warn' }, 'edited') : ''), el('td', {}, kind), tdFmt, el('td', {}, fmt(size)), el('td', { class: 'mono' }, `0x${e.flags.toString(16)}`), tdAct));
  }
}
function sceneRefs(data) { const s = new TextDecoder('latin1').decode(data); return [...s.matchAll(/[A-Za-z]:[\\/][\x20-\x7e]{8,}/g)].map((m) => m[0]); }
function drawThumb(cv, t) { let L = 0; while (Math.max(t.width >> L, t.height >> L) > 256 && L < t.mips - 1) L++; const m = C.decodeMip(t, L); cv.width = m.width; cv.height = m.height; cv.getContext('2d').putImageData(new ImageData(m.rgba, m.width, m.height), 0, 0); }
async function pngBytes(t) { const m = C.decodeMip(t, 0); const cv = el('canvas', { width: m.width, height: m.height }); cv.getContext('2d').putImageData(new ImageData(m.rgba, m.width, m.height), 0, 0); const blob = await new Promise((r) => cv.toBlob(r, 'image/png')); return new Uint8Array(await blob.arrayBuffer()); }
async function saveBig(b) {
  const bytes = await C.buildBigfile(b.parsed); await saveRef(b.ref, bytes);
  b.parsed.entries.forEach((e) => { e.dirty = false; }); invalidateBig(b.ref.folder, b.ref.name); renderBig();
}
$('#big-save').onclick = guard(async () => saveBig(S.big));
$('#big-save-as').onclick = guard(async () => { const b = S.big; const bytes = await C.buildBigfile(b.parsed); const r = await saveAs(b.name, bytes); if (r && r.handle) { b.ref = { ...b.ref, handle: r.handle, name: r.name, api: false }; b.name = r.name; b.parsed.entries.forEach((e) => { e.dirty = false; }); renderBig(); } });

// ---------- texture editor ----------
const T = { entry: null, tex: null, work: null, ctx: null, zoom: 1, tool: 'brush', undo: [], redo: [], recolorSrc: null, stamp: null, drawing: false, last: null, pan: null };
const canvas = $('#tex-canvas'), stage = $('#stage');
function openTexture(entry) {
  const t = entry.tex || C.parseTexture(entry.data, entry.name); entry.tex = t; const m = C.decodeMip(t, 0);
  T.entry = entry; T.tex = t; T.undo = []; T.redo = []; T.recolorSrc = null; cancelStamp();
  T.work = el('canvas', { width: t.width, height: t.height }); T.ctx = T.work.getContext('2d', { willReadFrequently: true }); T.ctx.putImageData(new ImageData(m.rgba, m.width, m.height), 0, 0);
  canvas.width = t.width; canvas.height = t.height;
  $('#tex-title').textContent = entry.name; $('#tex-info').textContent = `${t.fourcc} ${t.width}×${t.height}, ${t.mips} mips · from ${S.big?.name || ''}`;
  const kv = $('#tex-kv'); kv.textContent = '';
  for (const [k, v] of [['bigfile', S.big?.name || ''], ['entry', entry.name], ['format', t.fourcc], ['size', `${t.width} × ${t.height}`], ['mips', t.mips], ['bytes', fmt(entry.data.length)], ['hash', C.hex64(entry.hash)]]) kv.append(el('dt', {}, k), el('dd', {}, String(v)));
  const mips = $('#tex-mips'); mips.textContent = ''; for (let i = 0; i < t.mips; i++) { const [w, h] = C.mipDims(t.width, t.height, i); mips.append(el('span', { class: 'pill' }, `L${i} ${w}×${h}`)); }
  ['#tex-undo', '#tex-redo', '#tex-revert', '#tex-export-png', '#tex-export-dds', '#tex-import', '#tex-apply'].forEach((s) => { $(s).disabled = false; }); $('#tex-undo').disabled = true; $('#tex-redo').disabled = true;
  showTab('texture'); setZoom('fit'); render();
}
function render() { const cx = canvas.getContext('2d'); cx.clearRect(0, 0, canvas.width, canvas.height); if (!$('#view-alpha').checked) { cx.fillStyle = '#000'; cx.fillRect(0, 0, canvas.width, canvas.height); } if (T.work) cx.drawImage(T.work, 0, 0); }
$('#view-alpha').addEventListener('change', render);
function setZoom(z) {
  if (!T.tex) return;
  if (z === 'fit') z = Math.min((stage.clientWidth - 4) / T.tex.width, (stage.clientHeight - 4) / T.tex.height, 8); else if (z === '+') z = T.zoom * 1.5; else if (z === '-') z = T.zoom / 1.5; else z = Number(z);
  T.zoom = Math.max(0.05, Math.min(32, z)); canvas.style.width = `${T.tex.width * T.zoom}px`; canvas.style.height = `${T.tex.height * T.zoom}px`; $('#zoom-v').textContent = `${(T.zoom * 100).toFixed(0)}%`; placeStampBox();
  canvas.style.imageRendering = T.zoom >= 1 ? 'pixelated' : 'auto'; // crisp texels when zoomed in; smooth (not aliased) when the texture is shrunk to fit
}
$$('[data-zoom]').forEach((b) => b.addEventListener('click', () => setZoom(b.dataset.zoom)));
stage.addEventListener('wheel', (e) => { if (!e.ctrlKey) return; e.preventDefault(); setZoom(e.deltaY < 0 ? '+' : '-'); }, { passive: false });
$$('#tool-buttons button').forEach((b) => b.addEventListener('click', () => { T.tool = b.dataset.tool; $$('#tool-buttons button').forEach((x) => x.classList.toggle('active', x === b)); $('#recolor-box').hidden = T.tool !== 'recolor'; canvas.style.cursor = T.tool === 'pan' ? 'grab' : 'crosshair'; }));
$('#tool-color').addEventListener('input', (e) => { $('#tool-hex').value = e.target.value; });
$('#tool-hex').addEventListener('change', (e) => { if (/^#[0-9a-f]{6}$/i.test(e.target.value)) $('#tool-color').value = e.target.value.toLowerCase(); });
for (const [id, out] of [['tool-size', 'tool-size-v'], ['tool-opacity', 'tool-opacity-v'], ['tool-tol', 'tool-tol-v']]) $(`#${id}`).addEventListener('input', (e) => { $(`#${out}`).textContent = e.target.value; });
const tool = () => ({ color: $('#tool-color').value, size: Number($('#tool-size').value), opacity: Number($('#tool-opacity').value) / 100, tol: Number($('#tool-tol').value) });
function pos(e) { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) / T.zoom, (e.clientY - r.top) / T.zoom]; }
function pushUndo() { T.undo.push(T.ctx.getImageData(0, 0, T.work.width, T.work.height)); if (T.undo.length > 20) T.undo.shift(); T.redo = []; $('#tex-undo').disabled = false; $('#tex-redo').disabled = true; }
function dab(x, y) { const { color, size, opacity } = tool(); const c = T.ctx; c.save(); c.globalCompositeOperation = T.tool === 'eraser' ? 'destination-out' : 'source-over'; c.globalAlpha = opacity; c.fillStyle = color; c.beginPath(); c.arc(x, y, size / 2, 0, Math.PI * 2); c.fill(); c.restore(); }
function stroke(x0, y0, x1, y1) { const { size } = tool(); const d = Math.hypot(x1 - x0, y1 - y0), step = Math.max(1, size / 4), n = Math.max(1, Math.ceil(d / step)); for (let i = 0; i <= n; i++) dab(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n); }
canvas.addEventListener('pointerdown', (e) => {
  if (!T.tex || T.stamp) return;
  if (e.button === 1) { T.pan = [e.clientX, e.clientY, stage.scrollLeft, stage.scrollTop]; canvas.setPointerCapture(e.pointerId); return; }
  const [x, y] = pos(e); canvas.setPointerCapture(e.pointerId);
  if (T.tool === 'pan') { T.pan = [e.clientX, e.clientY, stage.scrollLeft, stage.scrollTop]; return; }
  if (T.tool === 'picker' || T.tool === 'recolor') { const p = T.ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data; const hex = `#${[p[0], p[1], p[2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`; if (T.tool === 'picker') { $('#tool-color').value = hex; $('#tool-hex').value = hex; } else { T.recolorSrc = [p[0], p[1], p[2]]; $('#recolor-src').style.background = hex; $('#recolor-src-hex').textContent = hex; $('#recolor-apply').disabled = false; } return; }
  if (T.tool === 'fill') { pushUndo(); floodFill(Math.floor(x), Math.floor(y)); render(); return; }
  pushUndo(); T.drawing = true; T.last = [x, y]; dab(x, y); render();
});
canvas.addEventListener('pointermove', (e) => { if (T.pan) { stage.scrollLeft = T.pan[2] - (e.clientX - T.pan[0]); stage.scrollTop = T.pan[3] - (e.clientY - T.pan[1]); return; } if (!T.drawing) return; const [x, y] = pos(e); stroke(T.last[0], T.last[1], x, y); T.last = [x, y]; render(); });
const endStroke = () => { T.drawing = false; T.pan = null; };
canvas.addEventListener('pointerup', endStroke); canvas.addEventListener('pointercancel', endStroke);
function floodFill(sx, sy) {
  const { color, tol } = tool(); const w = T.work.width, h = T.work.height; const img = T.ctx.getImageData(0, 0, w, h), d = img.data;
  const o0 = (sy * w + sx) * 4, ref = [d[o0], d[o0 + 1], d[o0 + 2], d[o0 + 3]]; const rgb = [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16)];
  const seen = new Uint8Array(w * h); const stack = [sy * w + sx]; const t2 = tol * tol;
  while (stack.length) {
    const i = stack.pop(); if (seen[i]) continue; const o = i * 4;
    const dd = (d[o] - ref[0]) ** 2 + (d[o + 1] - ref[1]) ** 2 + (d[o + 2] - ref[2]) ** 2 + (d[o + 3] - ref[3]) ** 2; if (dd > t2) continue; seen[i] = 1;
    if (T.tool === 'eraser') d[o + 3] = 0; else { d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255; }
    const x = i % w, y = (i / w) | 0; if (x > 0) stack.push(i - 1); if (x < w - 1) stack.push(i + 1); if (y > 0) stack.push(i - w); if (y < h - 1) stack.push(i + w);
  }
  T.ctx.putImageData(img, 0, 0);
}
function rgb2hsl(r, g, b) { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2; if (mx === mn) return [0, 0, l]; const d = mx - mn, s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn); let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return [h / 6, s, l]; }
function hsl2rgb(h, s, l) { if (s === 0) return [l * 255, l * 255, l * 255]; const q = l < .5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q; const f = (t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < .5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; }; return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255]; }
$('#recolor-apply').onclick = () => {
  if (!T.recolorSrc) return; pushUndo();
  const { color, tol } = tool(); const tgt = rgb2hsl(parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16));
  const w = T.work.width, h = T.work.height, img = T.ctx.getImageData(0, 0, w, h), d = img.data, t2 = tol * tol, s = T.recolorSrc; let n = 0;
  for (let o = 0; o < d.length; o += 4) { const dd = (d[o] - s[0]) ** 2 + (d[o + 1] - s[1]) ** 2 + (d[o + 2] - s[2]) ** 2; if (dd > t2) continue; const l = rgb2hsl(d[o], d[o + 1], d[o + 2])[2]; const [r, g, b] = hsl2rgb(tgt[0], tgt[1], l); d[o] = r; d[o + 1] = g; d[o + 2] = b; n++; }
  T.ctx.putImageData(img, 0, 0); render(); log(`recolored ${n} pixels`);
};
$('#tex-undo').onclick = () => { if (!T.undo.length) return; T.redo.push(T.ctx.getImageData(0, 0, T.work.width, T.work.height)); T.ctx.putImageData(T.undo.pop(), 0, 0); $('#tex-undo').disabled = !T.undo.length; $('#tex-redo').disabled = false; render(); };
$('#tex-redo').onclick = () => { if (!T.redo.length) return; T.undo.push(T.ctx.getImageData(0, 0, T.work.width, T.work.height)); T.ctx.putImageData(T.redo.pop(), 0, 0); $('#tex-redo').disabled = !T.redo.length; $('#tex-undo').disabled = false; render(); };
$('#tex-revert').onclick = () => { if (!T.entry) return; pushUndo(); const m = C.decodeMip(T.tex, 0); T.ctx.putImageData(new ImageData(m.rgba, m.width, m.height), 0, 0); render(); };
$('#tex-export-png').onclick = guard(async () => { const blob = await new Promise((r) => T.work.toBlob(r, 'image/png')); await saveAs(`${T.entry.name}.png`, new Uint8Array(await blob.arrayBuffer())); });
$('#tex-export-dds').onclick = guard(async () => { await saveAs(`${T.entry.name}.dds`, C.toDDS(encodeCurrent())); });
function encodeCurrent() { const rgba = T.ctx.getImageData(0, 0, T.work.width, T.work.height).data; return C.encodeTexture(T.tex, rgba); }
$('#tex-apply').onclick = guard(async () => {
  $('#tex-apply').disabled = true; $('#tex-apply').textContent = 'Encoding…'; await new Promise((r) => setTimeout(r, 20));
  try {
    const enc = encodeCurrent(); const e = T.entry; e.data = enc.bytes; e.dirty = true; e.tex = C.parseTexture(enc.bytes, e.name); T.tex = e.tex;
    log(`${e.name}: re-encoded ${enc.fourcc} ${enc.width}×${enc.height} with ${enc.mips} mips`, 'ok');
    if (S.big && (S.big.ref.api || S.big.ref.handle)) { await saveBig(S.big); toast(`${e.name} saved into ${S.big.name}`); } else { renderBig(); toast('Applied; save the bigfile from the Bigfile tab'); }
  } finally { $('#tex-apply').disabled = false; $('#tex-apply').textContent = 'Apply & save'; }
});
$('#tex-import').onclick = () => { pendingImport = { entry: T.entry, direct: false }; $('#pick-image').click(); };
function resampleCanvas(rgba, w, h, dw, dh) { const src = el('canvas', { width: w, height: h }); src.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0); const dst = el('canvas', { width: dw, height: dh }); const cx = dst.getContext('2d'); cx.imageSmoothingQuality = 'high'; cx.drawImage(src, 0, 0, dw, dh); return cx.getImageData(0, 0, dw, dh).data; }
async function imageToRGBA(f) {
  if (/\.dds$/i.test(f.name)) { const dds = C.fromDDS(new Uint8Array(await f.arrayBuffer())); return { ...dds, label: `${dds.fourcc || '32-bit'} ${dds.width}×${dds.height}${dds.mips ? `, ${dds.mips} mips` : ''}` }; }
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error(`cannot read ${f.name}`)); i.src = URL.createObjectURL(f); });
  const w = img.naturalWidth, h = img.naturalHeight; const cv = el('canvas', { width: w, height: h }); cv.getContext('2d').drawImage(img, 0, 0); return { rgba: cv.getContext('2d').getImageData(0, 0, w, h).data, width: w, height: h, img, label: `${w}×${h}` };
}
$('#pick-image').addEventListener('change', guard(async (ev) => {
  const f = ev.target.files[0]; ev.target.value = ''; if (!f || !pendingImport) return;
  const job = pendingImport; pendingImport = null;
  const imp = await imageToRGBA(f); log(`imported ${f.name}: ${imp.label}`);
  if (job.team) { // team part texture: repackage straight away
    const b = job.b, e = job.entry, t = C.parseTexture(e.data, e.name);
    const { bytes, mode } = C.textureFromImport(t, imp, resampleCanvas); e.data = bytes; e.dirty = true;
    const out = await C.buildBigfile(b.parsed); await saveRef(b.ref, out); b.parsed.entries.forEach((x) => { x.dirty = false; });
    toast(`${e.name} replaced (${mode}) and ${b.ref.name} saved`); invalidateBig(b.ref.folder, b.ref.name); return;
  }
  if (T.entry !== job.entry) openTexture(job.entry);
  const w = imp.width, h = imp.height;
  const src = imp.img || (() => { const c = el('canvas', { width: w, height: h }); c.getContext('2d').putImageData(new ImageData(imp.rgba || C.decodeDXT(imp.data.subarray(0, C.mipBytes(w, h, imp.fourcc)), w, h, imp.fourcc), w, h), 0, 0); return c; })();
  if (job.direct || (w === T.tex.width && h === T.tex.height)) { pushUndo(); T.ctx.clearRect(0, 0, T.work.width, T.work.height); T.ctx.drawImage(src, 0, 0, T.tex.width, T.tex.height); render(); if (job.direct) $('#tex-apply').click(); return; }
  const scale = Math.min(T.tex.width / w, T.tex.height / h, 1);
  T.stamp = { img: src, x: 0, y: 0, w: Math.round(w * scale), h: Math.round(h * scale), ar: w / h };
  $('#stamp-box').hidden = false; $('#stamp').hidden = false; syncStampInputs(); placeStampBox(); showTab('texture');
}));
function syncStampInputs() { if (!T.stamp) return; $('#stamp-x').value = T.stamp.x; $('#stamp-y').value = T.stamp.y; $('#stamp-w').value = T.stamp.w; $('#stamp-h').value = T.stamp.h; }
function placeStampBox() { if (!T.stamp) return; const s = $('#stamp'); s.style.left = `${T.stamp.x * T.zoom}px`; s.style.top = `${T.stamp.y * T.zoom}px`; s.style.width = `${T.stamp.w * T.zoom}px`; s.style.height = `${T.stamp.h * T.zoom}px`; }
function cancelStamp() { T.stamp = null; $('#stamp').hidden = true; $('#stamp-box').hidden = true; }
$('#stamp-cancel').onclick = cancelStamp;
$('#stamp-place').onclick = () => { if (!T.stamp) return; pushUndo(); T.ctx.drawImage(T.stamp.img, T.stamp.x, T.stamp.y, T.stamp.w, T.stamp.h); cancelStamp(); render(); };
for (const k of ['x', 'y', 'w', 'h']) $(`#stamp-${k}`).addEventListener('input', (e) => { if (!T.stamp) return; const v = Number(e.target.value) || 0; T.stamp[k] = v; if ($('#stamp-lock').checked) { if (k === 'w') T.stamp.h = Math.round(v / T.stamp.ar); if (k === 'h') T.stamp.w = Math.round(v * T.stamp.ar); } syncStampInputs(); placeStampBox(); });
{ const box = $('#stamp'), handle = $('#stamp .h'); let drag = null;
  box.addEventListener('pointerdown', (e) => { if (!T.stamp) return; e.preventDefault(); box.setPointerCapture(e.pointerId); drag = { mode: e.target === handle ? 'size' : 'move', x: e.clientX, y: e.clientY, s: { ...T.stamp } }; });
  box.addEventListener('pointermove', (e) => { if (!drag) return; const dx = (e.clientX - drag.x) / T.zoom, dy = (e.clientY - drag.y) / T.zoom; if (drag.mode === 'move') { T.stamp.x = Math.round(drag.s.x + dx); T.stamp.y = Math.round(drag.s.y + dy); } else { T.stamp.w = Math.max(1, Math.round(drag.s.w + dx)); T.stamp.h = $('#stamp-lock').checked ? Math.max(1, Math.round(T.stamp.w / T.stamp.ar)) : Math.max(1, Math.round(drag.s.h + dy)); } syncStampInputs(); placeStampBox(); });
  const end = () => { drag = null; }; box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end); }

// ---------- new set ----------
{ const sel = $('#ns-team'); for (const t of MAPPING.teams) sel.append(el('option', { value: t.slot }, `${t.name} (${t.slot})`)); }
$('#ns-team').addEventListener('change', (e) => { $('#ns-slot').value = e.target.value; renderDonors(); });
$('#ns-slot').addEventListener('input', renderDonors); $('#ns-year').addEventListener('input', renderDonors); $('#ns-officials').addEventListener('input', renderDonors);
function fillDonorSelects() {
  const bigs = S.files.filter((f) => f.kind === 'big').sort((a, b) => a.name.localeCompare(b.name));
  for (const id of ['#ns-donor', '#xml-part-big']) { const s = $(id); s.textContent = ''; s.append(el('option', { value: '' }, bigs.length ? 'choose a bigfile' : 'no files loaded')); bigs.forEach((f) => s.append(el('option', { value: String(S.files.indexOf(f)) }, `${f.folder ? f.folder + '/' : ''}${f.name}`))); }
}
$('#ns-add').onclick = guard(async () => {
  const i = $('#ns-donor').value; if (i === '') return; const f = S.files[Number(i)];
  const parsed = C.parseBigfile(await refBytes(f), f.name); const scene = parsed.entries.find((e) => C.entryKind(e.name) === 'scene'); const info = scene && C.splitName(scene.name);
  if (!info) throw new Error(`${f.name}: cannot read SLOT_PART_YEAR_COLOR from its scene name`); if (!PART_OF[info.part.toUpperCase()]) throw new Error(`${f.name}: unknown part ${info.part}`);
  S.ns.donors.push({ file: f, info, newColor: info.color, officials: officialsList().slice(0, 1), type: PART_OF[info.part.toUpperCase()] }); renderDonors();
});
const officialsList = () => $('#ns-officials').value.split(',').map((s) => s.trim()).filter(Boolean);
function newName(d) { const slot = ($('#ns-slot').value || d.info.slot).toUpperCase(), year = $('#ns-year').value || d.info.year; return `${slot}_${d.info.part.toUpperCase()}_${year}_${d.newColor.toUpperCase()}`; }
function renderDonors() {
  const tb = $('#ns-table tbody'); tb.textContent = ''; const offs = officialsList(); $('#ns-empty').hidden = S.ns.donors.length > 0;
  S.ns.donors.forEach((d, i) => {
    const colorIn = el('input', { type: 'text', value: d.newColor, maxlength: String(d.info.color.length), style: 'width:100px;text-transform:uppercase', oninput: (e) => { d.newColor = e.target.value.toUpperCase(); renderDonors(); } });
    const bad = d.newColor.length !== d.info.color.length;
    tb.append(el('tr', {}, el('td', {}, el('strong', {}, d.type)), el('td', { class: 'mono' }, d.file.name), el('td', { class: 'mono' }, d.info.color, ` (${d.info.color.length})`), el('td', {}, colorIn, bad ? el('div', { class: 'pill bad' }, `needs ${d.info.color.length} chars`) : ''),
      el('td', {}, offs.map((o) => el('label', { style: 'margin-right:8px' }, el('input', { type: 'checkbox', checked: d.officials.includes(o), onchange: (e) => { d.officials = e.target.checked ? [...new Set([...d.officials, o])] : d.officials.filter((x) => x !== o); } }), ` ${o}`))),
      el('td', { class: 'mono' }, newName(d)), el('td', {}, el('button', { class: 'small ghost', onclick: () => { S.ns.donors.splice(i, 1); renderDonors(); } }, 'Remove'))));
  });
  const slot = $('#ns-slot').value.toUpperCase(), year = $('#ns-year').value;
  const ok = S.ns.donors.length > 0 && /^[A-Z0-9]{6}$/.test(slot) && /^\d{4}$/.test(year) && S.ns.donors.every((d) => d.newColor.length === d.info.color.length && /^[A-Z0-9]+$/.test(d.newColor));
  $('#ns-generate').disabled = !ok;
  $('#ns-status').textContent = ok ? `will write ${S.ns.donors.length} bigfile(s) and ${slot}_Pack${$('#ns-pack').value}_MixAndMatch.XML` : 'pick a slot (6 characters), a year and same-length colours';
}
$('#ns-generate').onclick = guard(async () => {
  const slot = $('#ns-slot').value.toUpperCase(), year = $('#ns-year').value, pack = $('#ns-pack').value || '0';
  const team = MAPPING.teams.find((t) => t.slot === slot); const folder = team ? folderFor(team) : (S.subdirs[0]?.name || '');
  $('#ns-generate').disabled = true; $('#ns-status').textContent = 'working…'; const parts = [];
  try {
    for (const d of S.ns.donors) {
      const big = C.parseBigfile(await refBytes(d.file), d.file.name); const map = [];
      if (d.info.slot.toUpperCase() !== slot) map.push({ from: d.info.slot, to: slot }); if (d.info.year !== year) map.push({ from: d.info.year, to: year }); if (d.info.color.toUpperCase() !== d.newColor) map.push({ from: d.info.color, to: d.newColor });
      (map.length ? await C.renameBigfile(big, map) : []).forEach((n) => log(`  ${n}`));
      const scene = big.entries.find((e) => C.entryKind(e.name) === 'scene').name;
      await saveInto(folder, `${scene}_big.ast`, await C.buildBigfile(big));
      parts.push({ type: d.type, name: d.newColor, bigfile: `${scene}_big`, scene, officials: d.officials });
    }
    const xmlName = `${slot}_Pack${pack}_MixAndMatch.XML`;
    if (S.files.find((f) => f.name.toLowerCase() === xmlName.toLowerCase())) log(`${xmlName} already existed; it was replaced`, 'warn');
    await saveInto(folder, xmlName, new TextEncoder().encode(C.xmlForSet(officialsList(), parts)));
    $('#ns-status').textContent = `done: ${parts.length} bigfile(s) + ${xmlName}${folder ? ` in ${folder}` : ''}`; toast(`New set written for ${team ? team.name : slot}`);
    log(`new set for ${slot} (${team ? team.name : 'unmapped slot'}) written`, 'ok');
    if (team) { showTab('teams'); selectTeam(team); }
  } finally { renderDonors(); }
});

// ---------- XML tab ----------
$('#xml-open').onclick = guard(async () => {
  if (window.showOpenFilePicker) { const [h] = await window.showOpenFilePicker({ types: [{ description: 'mix and match XML', accept: { 'text/xml': ['.xml', '.XML'] } }] }).catch((e) => { if (e.name !== 'AbortError') throw e; return []; }); if (h) await openXml({ name: h.name, handle: h, folder: '', kind: 'xml', slot: slotOf(h.name) }); }
  else $('#pick-xml').click();
});
$('#pick-xml').addEventListener('change', (ev) => { const f = ev.target.files[0]; if (f) openXml({ name: f.name, file: f, folder: '', kind: 'xml', slot: slotOf(f.name) }); ev.target.value = ''; });
const openXml = guard(async (ref) => {
  const text = new TextDecoder().decode(await refBytes(ref)); const doc = new DOMParser().parseFromString(text, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error(`${ref.name}: ${doc.querySelector('parsererror').textContent.slice(0, 120)}`);
  S.xml = { ref, doc, name: ref.name }; renderXml(); showTab('xml'); log(`opened ${ref.name}`);
});
function bigfileWhere(name, folder) {
  const inFolder = findBig(name, folder);
  if (inFolder && inFolder.folder === folder) return el('span', { class: 'pill ok' }, 'in folder');
  if (inFolder) return el('span', { class: 'pill ok', title: 'bigfiles are found in any FCS_DLC_* folder' }, `in ${inFolder.folder}`);
  if (/^generic_/i.test(name)) return el('span', { class: 'pill' }, 'game generic');
  if (!S.files.length) return el('span', { class: 'pill' }, 'no folder loaded');
  const p = el('span', { class: 'pill warn' }, 'archive?'); archiveHas(name).then((h) => { if (h === true) p.textContent = 'in game archive'; else if (h === false) { p.className = 'pill bad'; p.textContent = 'MISSING'; } }); return p;
}
function renderXml() {
  const x = S.xml; $('#xml-save').disabled = !x || !(x.ref.handle || x.ref.api); $('#xml-save-as').disabled = !x;
  $('#xml-title').textContent = x ? x.name : ''; const tb = $('#xml-table tbody'); tb.textContent = ''; $('#xml-officials').textContent = '';
  if (!x) { tb.append(el('tr', {}, el('td', { colspan: 7, class: 'empty' }, 'open a mix-and-match XML'))); return; }
  const offs = xmlOfficialsOf(x.doc); const teams = (teamsBySlot.get(slotOf(x.name)) || []).map((t) => t.name).join(', ');
  $('#xml-info').textContent = `${teams ? teams + ' · ' : ''}${offs.length} official uniforms · ${$$('part', x.doc).length} parts`;
  offs.forEach((o, i) => $('#xml-officials').append(el('span', { class: 'pill ok' }, `${i}: ${o} `, el('button', { class: 'small ghost', style: 'min-height:18px;padding:0 4px', title: 'remove', onclick: () => { $$('officialType', x.doc)[i].remove(); $$('part official', x.doc).filter((n) => n.getAttribute('name') === o).forEach((n) => n.remove()); renderXml(); } }, '×'))));
  for (const p of $$('part', x.doc)) {
    const bigIn = el('input', { type: 'text', value: partGet(p, 'bigfile'), class: 'mono', style: 'width:100%', onchange: (e) => { p.querySelector('bigfile')?.setAttribute('name', e.target.value); renderXml(); } });
    const sceneIn = el('input', { type: 'text', value: partGet(p, 'scene'), class: 'mono', style: 'width:100%', onchange: (e) => { p.querySelector('scene')?.setAttribute('name', e.target.value); renderXml(); } });
    const labelIn = el('input', { type: 'text', value: p.getAttribute('name') || '', style: 'width:110px', onchange: (e) => p.setAttribute('name', e.target.value) });
    const used = partOfficials(p);
    const offCells = offs.map((o) => el('label', { style: 'margin-right:8px;white-space:nowrap' }, el('input', { type: 'checkbox', checked: used.includes(o), onchange: (e) => { if (e.target.checked) { const n = x.doc.createElement('official'); n.setAttribute('name', o); const anchor = p.querySelector('decalUV'); if (anchor) p.insertBefore(n, anchor); else p.append(n); } else $$('official', p).filter((n) => n.getAttribute('name') === o).forEach((n) => n.remove()); renderXml(); } }), ` ${o}`));
    tb.append(el('tr', {}, el('td', {}, el('strong', {}, p.getAttribute('type') || '?'), p.getAttribute('shade') ? el('div', { class: 'muted' }, p.getAttribute('shade')) : ''), el('td', {}, labelIn), el('td', {}, bigIn), el('td', {}, sceneIn), el('td', {}, bigfileWhere(partGet(p, 'bigfile'), x.ref.folder)), el('td', {}, offCells), el('td', {}, el('button', { class: 'small ghost', onclick: () => { p.remove(); renderXml(); } }, 'Remove'))));
  }
  $('#xml-raw').value = xmlTextOf(x.doc);
}
$('#xml-add-official').onclick = () => { const v = $('#xml-new-official').value.trim(); if (!v || !S.xml) return; const n = S.xml.doc.createElement('officialType'); n.setAttribute('name', v); const last = $$('officialType', S.xml.doc).pop(); if (last) last.after(n); else S.xml.doc.documentElement.prepend(n); $('#xml-new-official').value = ''; renderXml(); };
$('#xml-part-add').onclick = () => {
  if (!S.xml) { log('open an XML first', 'warn'); return; } const i = $('#xml-part-big').value; if (i === '') return; const f = S.files[Number(i)];
  const scene = bigBase(f.name).replace(/_big$/i, ''); const info = C.splitName(scene); const type = info && PART_OF[info.part.toUpperCase()];
  if (!type) { log(`${f.name}: cannot tell the part type from the name`, 'err'); return; }
  const frag = new DOMParser().parseFromString(C.partTemplate(type, $('#xml-part-name').value || info.color, `${scene}_big`, scene), 'text/xml').documentElement;
  S.xml.doc.documentElement.append(S.xml.doc.importNode(frag, true)); renderXml();
};
$('#xml-raw-apply').onclick = guard(async () => { const doc = new DOMParser().parseFromString($('#xml-raw').value, 'text/xml'); if (doc.querySelector('parsererror')) throw new Error(doc.querySelector('parsererror').textContent.slice(0, 160)); S.xml.doc = doc; renderXml(); });
$('#xml-save').onclick = guard(async () => { await saveRef(S.xml.ref, new TextEncoder().encode(xmlTextOf(S.xml.doc))); toast(`Saved ${S.xml.name}`); if (S.team && S.team.xmlRef === S.xml.ref) selectTeam(S.team.team); });
$('#xml-save-as').onclick = guard(async () => { const r = await saveAs(S.xml.name, new TextEncoder().encode(xmlTextOf(S.xml.doc))); if (r?.handle) { S.xml.ref = { ...S.xml.ref, handle: r.handle, api: false }; S.xml.name = r.name; renderXml(); } });

// ---------- archive tab ----------
$('#arc-open').onclick = guard(async () => {
  let file;
  if (window.showOpenFilePicker) { const [h] = await window.showOpenFilePicker({ types: [{ description: 'EA archive', accept: { 'application/octet-stream': ['.ast', '.AST'] } }] }).catch((e) => { if (e.name !== 'AbortError') throw e; return []; }); if (!h) return; file = await h.getFile(); }
  else { $('#pick-archive').click(); return; }
  await openArchive(file);
});
$('#pick-archive').addEventListener('change', (ev) => { const f = ev.target.files[0]; if (f) openArchive(f); ev.target.value = ''; });
const openArchive = guard(async (file) => {
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer()); if (C.ascii(head, 0, 8) !== 'BGFA1.05') throw new Error(`${file.name} is not a BGFA 1.05 archive`);
  const dv = new DataView(head.buffer); const tocOff = dv.getUint32(16, true), tocSize = dv.getUint32(24, true);
  const parsed = C.parseBigfile(new Uint8Array(await file.slice(0, tocOff + tocSize).arrayBuffer()), file.name);
  const map = new Map(); parsed.entries.forEach((e, i) => map.set(C.hex64(e.hash), { ...e, i, raw: null }));
  S.arc = { file, name: file.name, map }; $('#arc-info').textContent = `${file.name}: ${parsed.entries.length} entries, ${fmt(file.size)}`; $('#arc-find').disabled = false;
  log(`opened archive ${file.name} (${parsed.entries.length} entries)`); renderGeneric(); if (S.team) selectTeam(S.team.team);
});
let arcHit = null;
$('#arc-find').onclick = guard(async () => {
  const r = $('#arc-result'); r.textContent = ''; const name = $('#arc-name').value.trim(); const bytes = name ? await archiveBytes(name) : null;
  arcHit = bytes ? { name: bigBase(name).replace(/_big$/i, '').toUpperCase(), bytes } : null;
  ['#arc-extract', '#arc-download', '#arc-open-big'].forEach((s) => { $(s).disabled = !arcHit; });
  if (!arcHit) { r.append(el('dt', {}, 'result'), el('dd', {}, 'no entry with that name (names hash case-insensitively with _BIG appended)')); return; }
  let inner = ''; try { inner = C.parseBigfile(bytes).entries.map((e) => e.name).join(', '); } catch { inner = '(not a bigfile)'; }
  for (const [k, v] of [['name', `${arcHit.name}_BIG`], ['bigfile', fmt(bytes.length)], ['contains', inner]]) r.append(el('dt', {}, k), el('dd', {}, String(v)));
});
const arcFileName = () => `${arcHit.name}_big.ast`;
$('#arc-extract').onclick = guard(async () => { if (!arcHit) return; const slot = arcHit.name.slice(0, 6); const team = MAPPING.teams.find((t) => t.slot === slot); const folder = team ? folderFor(team) : (S.subdirs[0]?.name || ''); await saveInto(folder, arcFileName(), arcHit.bytes); toast(`${arcFileName()} extracted into ${folder || 'DLC'}`); if (S.team) renderTeam(); });
$('#arc-download').onclick = () => { if (arcHit) download(arcFileName(), arcHit.bytes); };
$('#arc-open-big').onclick = () => { if (arcHit) openBig({ name: arcFileName(), file: new File([arcHit.bytes], arcFileName()), folder: '', kind: 'big', slot: arcHit.name.slice(0, 6) }); };
function renderGeneric() {
  const box = $('#arc-generic'); box.textContent = '';
  for (const [slot, team, names] of GENERIC) {
    const d = el('details', {}, el('summary', {}, el('code', {}, slot), ` ${team}`)); const t = el('table', {});
    for (const [n, note] of names) t.append(el('tr', {}, el('td', { class: 'mono' }, n), el('td', {}, note.startsWith('NOT') ? el('span', { class: 'pill bad' }, note) : note ? el('span', { class: 'pill ok' }, note) : ''), el('td', {}, el('button', { class: 'small ghost', onclick: () => { $('#arc-name').value = n; $('#arc-find').click(); } }, 'Find'))));
    d.append(t); box.append(d);
  }
}
renderGeneric();
globalThis.FUS = { S, T, C, IO, openBig, openXml, openArchive, openTexture, selectTeam, renderTeam, renderBig, renderXml, encodeCurrent, log };
init();
})();
