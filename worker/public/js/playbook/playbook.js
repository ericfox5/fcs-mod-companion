// Playbook page: the editor for a team's book. The page hands over the team, the side, the stock book id, the saved edits
// (if any) and the URLs in #pb's data attributes; everything else is fetched (the playbook index, book JSON files, the
// composed book). The edits follow packages/ncaa14/src/playbook/model.ts (BookEdits: formations in order, each with its
// sets in order, each with its plays in order; a formation taken from another stock book carries `from`). Plays keep
// the game's own ids, so a play from another book's copy of the same set is just its id. Saving POSTs the edits as
// JSON; the server validates and composes them (Supersim reads the composed book at once). Vanilla ES module.
import { h, FAM_LABEL, fam, diagram } from './art.js';
import { openCreator, previewBook, drawFromPlay, blankDraw, familyOf } from './creator.js';

const root = document.getElementById('pb'); if (!root) throw new Error('no #pb');
const D = root.dataset;
const LIMITS = { formations: 15, sets: 41, plays: 419, nameChars: 31 };

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ---- state -------------------------------------------------------------------------------------------------------
const S = {
  side: D.side === 'def' ? 'def' : 'off', editable: D.editable === '1', stock: Number(D.stock), index: null, books: new Map(), // id -> Book
  edits: null, saved: '', // JSON of the last saved edits (dirty = current != saved)
  sel: { f: 0, s: 0, play: null }, picker: null, // picker: { kind: 'formation' | 'set' | 'play', book?: id, status?: string }
  busy: false, msg: null,
};
let E = {};

// ---- data --------------------------------------------------------------------------------------------------------
async function getJson(url) { const r = await fetch(url, { credentials: 'same-origin' }); if (!r.ok) throw new Error(`${url} → ${r.status}`); return r.json(); }
async function loadBook(id) {
  if (S.books.has(id)) return S.books.get(id);
  const b = await getJson(`${D.books}${id}.json`); S.books.set(id, b); return b;
}
// the edits that reproduce a stock book: the starting point when the team has none saved
const stockEdits = (base) => ({ v: 1, base: base.id, name: base.name, formations: base.formations.map((f) => ({ id: f.id, sets: f.sets.map((s) => ({ id: s.id, plays: [...s.plays] })) })), custom: {} });
const booksNeeded = (e) => [...new Set([e.base, ...e.formations.map((f) => f.from).filter((b) => typeof b === 'number')])];
const isCustom = (r) => typeof r === 'string';
// where a formation / play of the edits is read from: the formation's source book, else the base, else any loaded book
const srcBook = (f) => S.books.get(f.from ?? S.edits.base) || S.books.get(S.edits.base);
function srcForm(f) { const b = srcBook(f); return { book: b, form: b?.formations.find((x) => x.id === f.id) || null }; }
function srcPlay(id, prefer) {
  if (prefer?.plays?.[String(id)]) return { book: prefer, play: prefer.plays[String(id)] };
  for (const b of S.books.values()) if (b.plays?.[String(id)]) return { book: b, play: b.plays[String(id)] };
  return null;
}
const counts = () => { let sets = 0, plays = 0; for (const f of S.edits.formations) for (const s of f.sets) { sets++; plays += s.plays.length; } return { formations: S.edits.formations.length, sets, plays }; };
const dirty = () => JSON.stringify(S.edits) !== S.saved;

// ---- rendering ---------------------------------------------------------------------------------------------------
function render() {
  const old = E; E = {};
  root.replaceChildren(...[bar(), panes(), S.picker ? picker() : null, E.msg = h('div', { class: 'pb-msg', role: 'status' }, S.msg || '')].filter(Boolean));
  if (old.nameInput && document.activeElement === old.nameInput) E.nameInput?.focus();
}
function bar() {
  const c = counts(), over = c.formations > LIMITS.formations || c.sets > LIMITS.sets || c.plays > LIMITS.plays;
  const stockName = S.index?.books.find((b) => b.id === S.stock)?.name || `book ${S.stock}`;
  const status = S.busy ? 'Saving…' : dirty() ? 'Unsaved changes' : D.updated ? `Saved ${D.updated} · Supersim uses it now; consoles get it in the next release` : `Stock book, as the game has it`;
  return h('div', { class: 'pb-bar' },
    h('div', { class: 'pb-barl' },
      h('label', { class: 'pb-field' }, h('span', {}, 'Book name'), E.nameInput = h('input', { type: 'text', maxlength: String(LIMITS.nameChars), value: S.edits.name, disabled: !S.editable, oninput: (e) => { S.edits.name = e.target.value; renderBarOnly(); } })),
      h('span', { class: 'pb-stock' }, 'Stock book: ', h('b', {}, stockName)),
      h('span', { class: `pb-counts${over ? ' over' : ''}`, title: `Limits: ${LIMITS.formations} formations, ${LIMITS.sets} sets, ${LIMITS.plays} plays (the biggest stock books)` }, `${c.formations}/${LIMITS.formations} formations · ${c.sets}/${LIMITS.sets} sets · ${c.plays}/${LIMITS.plays} plays`)),
    h('div', { class: 'pb-barr' },
      h('span', { class: `pb-status${dirty() ? ' dirty' : ''}` }, status),
      S.editable ? [
        h('button', { class: 'btn', type: 'button', disabled: !dirty() || S.busy || over, onclick: save }, 'Save'),
        h('button', { class: 'btn light', type: 'button', disabled: !dirty() || S.busy, onclick: () => { S.edits = JSON.parse(S.saved); S.sel = { f: 0, s: 0, play: null }; render(); } }, 'Discard changes'),
        D.updated ? h('button', { class: 'btn light', type: 'button', disabled: S.busy, onclick: resetToStock }, 'Back to the stock book') : null,
      ] : h('span', { class: 'muted' }, 'Sign in as this team\'s coach (or the commissioner) to edit.')));
}
function renderBarOnly() { const b = root.querySelector('.pb-bar'); if (b) { const n = bar(); b.replaceWith(n); const inp = n.querySelector('input'); if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); } } }

function panes() {
  const fs = S.edits.formations; if (S.sel.f >= fs.length) S.sel.f = Math.max(0, fs.length - 1);
  const f = fs[S.sel.f]; const sets = f?.sets || []; if (S.sel.s >= sets.length) S.sel.s = Math.max(0, sets.length - 1);
  const s = sets[S.sel.s];
  return h('div', { class: 'pb-panes' }, formationsPane(fs, f), setsPane(f, s), playsPane(f, s), detailPane(f, s));
}
const upDown = (list, i, onMove) => S.editable ? [h('button', { class: 'pb-ib', type: 'button', title: 'Move up', 'aria-label': 'Move up', disabled: i === 0, onclick: (e) => { e.stopPropagation(); onMove(-1); } }, '▲'), h('button', { class: 'pb-ib', type: 'button', title: 'Move down', 'aria-label': 'Move down', disabled: i === list.length - 1, onclick: (e) => { e.stopPropagation(); onMove(1); } }, '▼')] : null;
const removeBtn = (title, onRemove) => S.editable ? h('button', { class: 'pb-ib del', type: 'button', title, 'aria-label': title, onclick: (e) => { e.stopPropagation(); onRemove(); } }, '✕') : null;
const move = (arr, i, d) => { const j = i + d; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; };

function formationsPane(fs, cur) {
  return h('section', { class: 'pb-pane pb-forms' }, h('h4', {}, 'Formations', h('small', {}, `${fs.length}`)),
    h('ol', { class: 'pb-list' }, fs.map((f, i) => { const { form, book } = srcForm(f); const plays = f.sets.reduce((a, s) => a + s.plays.length, 0);
      return h('li', { class: f === cur ? 'on' : '', onclick: () => { S.sel = { f: i, s: 0, play: null }; render(); } },
        h('div', { class: 'pb-item' }, h('b', {}, form?.n || `Formation ${f.id}`), h('small', {}, `${plural(f.sets.length, 'set')} · ${plural(plays, 'play')}${f.from && f.from !== S.edits.base ? ` · from ${book?.name || f.from}` : ''}`)),
        h('div', { class: 'pb-ctl' }, upDown(fs, i, (d) => { move(fs, i, d); S.sel.f = i + d; render(); }), removeBtn('Remove this formation from the book', () => { fs.splice(i, 1); render(); }))); })),
    S.editable ? h('button', { class: 'btn light sm pb-add', type: 'button', onclick: () => openPicker('formation') }, '+ Add a formation') : null);
}
function setsPane(f, cur) {
  if (!f) return h('section', { class: 'pb-pane pb-sets' }, h('h4', {}, 'Sets'), h('p', { class: 'muted pb-empty' }, 'No formation.'));
  const { form } = srcForm(f); const missing = (form?.sets || []).filter((s) => !f.sets.some((x) => x.id === s.id));
  return h('section', { class: 'pb-pane pb-sets' }, h('h4', {}, form?.n || 'Sets', h('small', {}, `${plural(f.sets.length, 'set')}`)),
    h('ol', { class: 'pb-list' }, f.sets.map((s, i) => { const set = form?.sets.find((x) => x.id === s.id);
      return h('li', { class: s === cur ? 'on' : '', onclick: () => { S.sel.s = i; S.sel.play = null; render(); } },
        h('div', { class: 'pb-item' }, h('b', {}, set?.n || `Set ${s.id}`), h('small', {}, plural(s.plays.length, 'play'))),
        h('div', { class: 'pb-ctl' }, upDown(f.sets, i, (d) => { move(f.sets, i, d); S.sel.s = i + d; render(); }), removeBtn('Remove this set', () => { f.sets.splice(i, 1); render(); }))); })),
    S.editable && missing.length ? h('button', { class: 'btn light sm pb-add', type: 'button', onclick: () => openPicker('set') }, `+ Add a set (${missing.length} more in this formation)`) : null);
}
function playsPane(f, s) {
  if (!f || !s) return h('section', { class: 'pb-pane pb-plays' }, h('h4', {}, 'Plays'), h('p', { class: 'muted pb-empty' }, 'No set.'));
  const { form, book } = srcForm(f); const set = form?.sets.find((x) => x.id === s.id);
  return h('section', { class: 'pb-pane pb-plays' }, h('h4', {}, set?.n || 'Plays', h('small', {}, plural(s.plays.length, 'play'))),
    h('ol', { class: 'pb-tiles' }, s.plays.map((ref, i) => {
      if (isCustom(ref)) { const d = S.edits.custom[ref]; const pv = d && set ? previewBook(d, set) : null; const fm = d ? familyOf(d) : 'other';
        return h('li', { class: `pb-tile custom${S.sel.play === ref ? ' on' : ''}`, onclick: () => { S.sel.play = ref; render(); } }, pv ? diagram(pv.book, pv.play, set) : null,
          h('div', { class: 'pb-tile-text' }, h('b', {}, d?.n || ref), h('small', {}, FAM_LABEL[fm] ? h('span', { class: `ss-ptag f-${fm}` }, FAM_LABEL[fm]) : null, ' drawn here')),
          h('div', { class: 'pb-ctl' }, upDown(s.plays, i, (d) => { move(s.plays, i, d); render(); }), removeBtn('Remove this play', () => { s.plays.splice(i, 1); delete S.edits.custom[ref]; render(); }))); }
      const hit = srcPlay(ref, book); if (!hit) return h('li', { class: 'pb-tile missing' }, h('div', { class: 'pb-tile-text' }, h('b', {}, `Play ${ref}`), h('small', {}, 'not in any loaded book')), h('div', { class: 'pb-ctl' }, removeBtn('Remove this play', () => { s.plays.splice(i, 1); render(); })));
      const fm = fam(hit.book, hit.play);
      return h('li', { class: `pb-tile${S.sel.play === ref ? ' on' : ''}`, onclick: () => { S.sel.play = ref; render(); } },
        set ? diagram(hit.book, hit.play, set) : null,
        h('div', { class: 'pb-tile-text' }, h('b', {}, hit.play.n), h('small', {}, FAM_LABEL[fm] ? h('span', { class: `ss-ptag f-${fm}` }, FAM_LABEL[fm]) : null, hit.book.id !== S.edits.base ? ` from ${hit.book.name}` : '')),
        h('div', { class: 'pb-ctl' }, upDown(s.plays, i, (d) => { move(s.plays, i, d); render(); }), removeBtn('Remove this play', () => { s.plays.splice(i, 1); render(); })));
    })),
    S.editable ? h('div', { class: 'pb-addrow' }, h('button', { class: 'btn light sm pb-add', type: 'button', onclick: () => openPicker('play') }, '+ Add a play to this set'),
      S.side === 'off' && set ? [h('button', { class: 'btn sm pb-add', type: 'button', onclick: () => draw(s, set, blankDraw(set, 'pass'), 'Draw a pass') }, '✎ Draw a pass'), h('button', { class: 'btn sm pb-add', type: 'button', onclick: () => draw(s, set, blankDraw(set, 'run'), 'Draw a run') }, '✎ Draw a run')] : h('span', { class: 'muted' }, S.side === 'def' ? 'Drawing defensive plays comes later.' : '')) : null);
}
// open the creator for a set; on save the drawing joins the edits (a new c<n>, or the one being edited) and the set's list
function draw(s, set, drawing, title, cid) {
  openCreator({ set, draw: drawing, title, onSave: (d) => {
    const id = cid || `c${1 + Math.max(0, ...Object.keys(S.edits.custom).map((k) => Number(k.slice(1)) || 0))}`;
    S.edits.custom[id] = d; if (!s.plays.includes(id)) s.plays.push(id); S.sel.play = id; S.msg = `"${d.n}" is in the book; Save to keep it. Supersim runs it at once after saving.`; render(); } });
}
function detailPane(f, s) {
  const ref = S.sel.play; if (ref == null || !f || !s) return h('section', { class: 'pb-pane pb-detail' }, h('h4', {}, 'Play'), h('p', { class: 'muted pb-empty' }, 'Pick a play to see it large.'));
  const { form, book } = srcForm(f); const set = form?.sets.find((x) => x.id === s.id); if (!set) return h('section', { class: 'pb-pane pb-detail' });
  if (isCustom(ref)) {
    const d = S.edits.custom[ref]; if (!d) return h('section', { class: 'pb-pane pb-detail' });
    const pv = previewBook(d, set); const fm = familyOf(d);
    const prog = (d.prog || []).map(([slot]) => `${POS[set.slots[slot]?.pos] ?? slot}${set.slots[slot] ? set.slots[slot].depth + 1 : ''}`).join(' → ');
    return h('section', { class: 'pb-pane pb-detail' }, h('h4', {}, d.n, h('small', {}, FAM_LABEL[fm] || fm)),
      h('div', { class: 'pb-big' }, diagram(pv.book, pv.play, set)),
      h('dl', { class: 'pb-facts' }, h('div', {}, h('dt', {}, 'Formation · set'), h('dd', {}, `${form?.n || ''} · ${set.n}`)), h('div', {}, h('dt', {}, 'Drawn on the site'), h('dd', {}, 'Compiled into the game\'s step language when the book is saved; Supersim runs it at once, consoles get it in the next release.')),
        prog ? h('div', {}, h('dt', {}, 'Progression'), h('dd', {}, prog)) : null,
        h('div', {}, h('dt', {}, 'Assignments'), h('dd', {}, h('ul', { class: 'pb-asg' }, set.slots.map((sl, i) => h('li', {}, h('b', {}, `${POS[sl.pos] ?? sl.pos}${sl.depth + 1}`), ' ', d.slots[i]?.k || '—')))))),
      S.editable ? h('div', { class: 'pb-detailctl' }, h('button', { class: 'btn sm', type: 'button', onclick: () => draw(s, set, d, `Edit ${d.n}`, ref) }, '✎ Edit this play')) : null);
  }
  const hit = srcPlay(ref, book); if (!hit) return h('section', { class: 'pb-pane pb-detail' });
  const p = hit.play, fm = fam(hit.book, p);
  const slots = set.slots.map((sl, i) => { const a = hit.book.asg?.[p.a?.[i]]; return { sl, a }; });
  const prog = (p.prog || []).map(([slot, pct]) => `${POS[set.slots[slot]?.pos] ?? slot}${set.slots[slot] ? set.slots[slot].depth + 1 : ''} ${pct}%`).join(' → ');
  return h('section', { class: 'pb-pane pb-detail' }, h('h4', {}, p.n, h('small', {}, FAM_LABEL[fm] || '')),
    h('div', { class: 'pb-big' }, diagram(hit.book, p, set)),
    h('dl', { class: 'pb-facts' },
      h('div', {}, h('dt', {}, 'Formation · set'), h('dd', {}, `${form?.n || ''} · ${set.n}`)),
      h('div', {}, h('dt', {}, 'Type'), h('dd', {}, `${FAM_LABEL[fm] || 'Other'} (PLYT ${p.t})`)),
      prog ? h('div', {}, h('dt', {}, 'Progression'), h('dd', {}, prog)) : null,
      p.h != null ? h('div', {}, h('dt', {}, 'Run hole'), h('dd', {}, String(p.h))) : null,
      h('div', {}, h('dt', {}, 'Assignments'), h('dd', {}, h('ul', { class: 'pb-asg' }, slots.map(({ sl, a }) => h('li', {}, h('b', {}, `${POS[sl.pos] ?? sl.pos}${sl.depth + 1}`), ' ', a ? `${a.k}${a.p ? ` · ${a.p.length - 1} leg${a.p.length - 1 === 1 ? '' : 's'}` : ''}` : '—')))))),
    S.editable && S.side === 'off' && !['kick', 'punt', 'kneel', 'spike'].includes(fm) ? h('div', { class: 'pb-detailctl' }, h('button', { class: 'btn sm', type: 'button', onclick: () => draw(s, set, drawFromPlay(hit.book, p, set), `Start from ${p.n}`) }, '✎ Start a new play from this one')) : null);
}
const POS = ['QB', 'HB', 'FB', 'WR', 'TE', 'LT', 'LG', 'C', 'RG', 'RT', 'LE', 'RE', 'DT', 'LLB', 'MLB', 'RLB', 'CB', 'FS', 'SS', 'K', 'P', 'KR', 'PR', 'KO', 'LS'];

// ---- pickers: a formation from any stock book, a set of the current formation, a play from any book's copy of the set
function openPicker(kind) { S.picker = { kind, book: S.edits.base, status: '' }; render(); }
function picker() {
  const P = S.picker, close = () => { S.picker = null; render(); };
  const booksOfSide = (S.index?.books || []).filter((b) => b.side === S.side);
  const bookSelect = h('select', { onchange: async (e) => { P.book = Number(e.target.value); P.status = 'Loading…'; render(); try { await loadBook(P.book); P.status = ''; } catch (err) { P.status = err.message; } render(); } }, booksOfSide.map((b) => h('option', { value: String(b.id), selected: b.id === P.book }, `${b.name} (${b.plays} plays)`)));
  let body;
  if (P.kind === 'formation') {
    const src = S.books.get(P.book);
    body = [h('p', { class: 'pb-pickhead' }, 'From the book ', bookSelect, h('span', { class: 'muted' }, P.status)),
      src ? h('ul', { class: 'pb-picklist' }, src.formations.filter((f) => f.sets.length).map((f) => { const have = S.edits.formations.some((x) => x.id === f.id); const sameName = !have && S.edits.formations.some((x) => srcForm(x).form?.n === f.n);
        return h('li', {}, h('button', { class: 'pb-pick', type: 'button', disabled: have, onclick: () => { S.edits.formations.push({ id: f.id, ...(src.id !== S.edits.base ? { from: src.id } : {}), sets: f.sets.map((s) => ({ id: s.id, plays: [...s.plays] })) }); S.sel = { f: S.edits.formations.length - 1, s: 0, play: null }; S.picker = null; render(); } },
          h('b', {}, f.n), h('small', {}, `${plural(f.sets.length, 'set')} · ${plural(f.sets.reduce((a, s) => a + s.plays.length, 0), 'play')}${have ? ' · already in the book' : sameName ? ' · the book already has a formation with this name (a different one)' : ''}`))); })) : null];
  } else if (P.kind === 'set') {
    const f = S.edits.formations[S.sel.f]; const { form } = srcForm(f); const missing = (form?.sets || []).filter((s) => !f.sets.some((x) => x.id === s.id));
    body = [h('p', { class: 'pb-pickhead' }, `Sets of ${form?.n || 'this formation'} not in the book`),
      h('ul', { class: 'pb-picklist' }, missing.map((s) => h('li', {}, h('button', { class: 'pb-pick', type: 'button', onclick: () => { f.sets.push({ id: s.id, plays: [...s.plays] }); S.sel.s = f.sets.length - 1; S.picker = null; render(); } }, h('b', {}, s.n), h('small', {}, plural(s.plays.length, 'play'))))))];
  } else {
    const f = S.edits.formations[S.sel.f], s = f?.sets[S.sel.s]; const { form } = srcForm(f); const set = form?.sets.find((x) => x.id === s.id);
    // every loaded book's copy of this set: plays not yet in it
    const seen = new Set(s.plays), options = [];
    for (const b of S.books.values()) for (const bf of b.formations) for (const bs of bf.sets) if (bs.id === s.id) for (const id of bs.plays) { if (seen.has(id)) continue; const p = b.plays?.[String(id)]; if (!p) continue; seen.add(id); options.push({ b, p, bs }); }
    body = [h('p', { class: 'pb-pickhead' }, 'Plays other books run from this set. Pull in another book: ', bookSelect, h('span', { class: 'muted' }, P.status)),
      options.length ? h('ul', { class: 'pb-picklist tiles' }, options.map(({ b, p }) => { const fm = fam(b, p); return h('li', {}, h('button', { class: 'pb-pick tile', type: 'button', onclick: () => { s.plays.push(p.id); S.sel.play = p.id; S.picker = null; render(); } }, set ? diagram(b, p, set) : null, h('span', { class: 'pb-tile-text' }, h('b', {}, p.n), h('small', {}, FAM_LABEL[fm] ? h('span', { class: `ss-ptag f-${fm}` }, FAM_LABEL[fm]) : null, b.id !== S.edits.base ? ` ${b.name}` : '')))); })) : h('p', { class: 'muted' }, 'Every play the loaded books run from this set is already in it. Pull in another book above.')];
  }
  return h('div', { class: 'pb-overlay', onclick: (e) => { if (e.target === e.currentTarget) close(); } }, h('div', { class: 'pb-dialog', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'pb-dlghead' }, h('h3', {}, P.kind === 'formation' ? 'Add a formation' : P.kind === 'set' ? 'Add a set' : 'Add a play'), h('button', { class: 'pb-ib', type: 'button', 'aria-label': 'Close', onclick: close }, '✕')), body));
}

// ---- save / reset ------------------------------------------------------------------------------------------------
async function save() {
  S.busy = true; S.msg = null; render();
  try {
    const r = await fetch(D.saveUrl, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ edits: S.edits }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ? `${j.error}${j.problems ? ': ' + j.problems.join('; ') : ''}` : `Save failed (${r.status})`);
    S.saved = JSON.stringify(S.edits); D.updated = j.updatedAt || 'just now'; S.msg = 'Saved. Supersim uses this book now; the console gets it in the next FCS-online release.';
  } catch (e) { S.msg = e.message; }
  S.busy = false; render();
}
async function resetToStock() {
  if (!confirm('Drop this team\'s edits and go back to the stock book? Supersim switches back at once.')) return;
  S.busy = true; render();
  try { const r = await fetch(D.saveUrl, { method: 'DELETE', credentials: 'same-origin' }); if (!r.ok) throw new Error(`Reset failed (${r.status})`); location.reload(); }
  catch (e) { S.msg = e.message; S.busy = false; render(); }
}
window.addEventListener('beforeunload', (e) => { if (S.edits && dirty() && !S.busy) { e.preventDefault(); e.returnValue = ''; } });

// ---- boot ----------------------------------------------------------------------------------------------------------
(async () => {
  root.replaceChildren(h('p', { class: 'muted pb-loading' }, 'Loading the playbook…'));
  try {
    S.index = await getJson(D.index);
    let edits = null; try { edits = D.edits ? JSON.parse(D.edits) : null; } catch { edits = null; }
    const base = await loadBook(edits?.base ?? S.stock);
    S.edits = edits || stockEdits(base);
    await Promise.all(booksNeeded(S.edits).map((id) => loadBook(id).catch(() => null)));
    S.saved = JSON.stringify(edits || S.edits); // the stock book counts as saved: nothing to send until something changes
    render();
  } catch (e) { root.replaceChildren(h('p', { class: 'flash err' }, `The playbook could not be loaded: ${e.message}`)); }
})();
