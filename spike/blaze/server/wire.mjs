// Dynasty Wire bridge between the in-game Story Center (the XMS store in easw.mjs) and the companion site:
//   site -> console  member News Wire stories become UserStory containers (story.mjs) under the online dynasty id, which
//                    is what the console's Wire search filters on (CONTAINER_GROUP = MOIN.MIMI); the story photo rides
//                    along as a SCREENSHOT media (JPEG, 640 px wide, 160 px thumbnail) named in MEDIA_ID_0. Edits
//                    replace both, deleted stories are removed. Receipts: POST /api/bridge/wire/<id>/delivered.
//   recaps           a coach's "side of the story" written on the site replaces the text block of the console's game recap
//                    (the packed box-score tables stay as uploaded); receipt POST /api/bridge/wire/recap/<id>/delivered.
//   console -> site  photos the console uploads (SCREENSHOT / GR_SCREENSHOT) become captures for the story photo picker
//                    (PUT /api/bridge/captures), story containers it uploads (game recaps, user stories) are posted to
//                    PUT /api/bridge/console-stories with their text and attached photo. Blank frames (under RPCS3 the
//                    game's photo pass comes out white or one flat colour unless the game carries
//                    tools/photo-watermark-patch.mjs) are kept on the console side only. The console's
//                    game recap names no photos, so the site recap gets the game's own photos uploaded just before it.
// State: private/xms/wire-sync.json { site: { <storyId>: { containerId, photoId, version } }, mirrored: { <mediaId>: at },
//        range: { <mediaId>: brightness spread, -1 = not an image } }.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { log } from './log.mjs';
import { siteConfig } from './supersim.mjs';
import { xmsEvents, addMedia, removeMedia, getMedia, allMedia, readBinary, replaceBinary } from './easw.mjs';
import { buildUserStory, parseContainer, replaceTextBlock, consoleText, MAX } from './story.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(process.env.NCAA_XMS_DIR || path.join(HERE, '..', 'private', 'xms'), 'wire-sync.json');
const TO_JPEG = path.join(HERE, '..', '..', '..', 'bridge', 'scripts', 'to-jpeg.ps1');
const state = (() => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { site: {}, mirrored: {} }; } })();
const saveState = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 1));

// JPEG re-encode through the Windows drawing classes (bridge/scripts/to-jpeg.ps1). Returns null when it cannot decode.
// check = true only measures the picture: { width, height, range } (range = brightness spread, <= BLANK on a flat frame).
function toJpeg(bytes, maxWidth, check = false) {
  const tmp = path.join(os.tmpdir(), `ncaa-wire-${crypto.randomBytes(6).toString('hex')}`);
  try {
    fs.writeFileSync(tmp + '.in', bytes);
    const args = check ? ['-Check'] : ['-Out', tmp + '.jpg', '-MaxWidth', String(maxWidth)];
    const dims = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', TO_JPEG, '-In', tmp + '.in', ...args], { encoding: 'utf8', windowsHide: true }).trim();
    const [w, h, range] = dims.split(/\s+/).map(Number);
    return { bytes: check ? null : fs.readFileSync(tmp + '.jpg'), width: w, height: h, range };
  } catch (e) { log('wire', `image conversion failed: ${String(e.message).split('\n')[0]}`); return null; }
  finally { for (const f of [tmp + '.in', tmp + '.jpg']) fs.rmSync(f, { force: true }); }
}
const isJpeg = (b) => b?.length > 3 && b[0] === 0xff && b[1] === 0xd8;
const isPng = (b) => b?.length > 8 && b.readUInt32BE(0) === 0x89504e47;
const BLANK = 6;

// A console photo that is one flat colour: under RPCS3 the watermark the game draws over each photo can cover it with
// near-solid white or one colour (NOTES 2026-11-01; tools/photo-watermark-patch.mjs removes it).
function blankPhoto(m) {
  if (state.range?.[m.id] == null) {
    const b = readBinary(m, 0); const info = b && (isJpeg(b) || isPng(b)) ? toJpeg(b, 0, true) : null;
    (state.range ??= {})[m.id] = Number.isFinite(info?.range) ? info.range : -1; saveState();
  }
  return state.range[m.id] >= 0 && state.range[m.id] <= BLANK;
}

// The game's own photos of the game a recap covers: uploaded by the same coach shortly before the recap, with the two
// team ids among the recap's header fields.
function gamePhotos(rec, s) {
  const t = Date.parse(rec.serverDate);
  const sameGame = (m) => { const h = Number(m.attributes?.HomeTeamID), a = Number(m.attributes?.AwayTeamID); return !Number.isFinite(h) || !Number.isFinite(a) || (s.fields.includes(h) && s.fields.includes(a)); };
  return allMedia().filter((m) => m.origin === 'console' && /SCREENSHOT/i.test(m.type) && String(m.ownerId) === String(rec.ownerId)
    && t - Date.parse(m.serverDate) >= 0 && t - Date.parse(m.serverDate) < 30 * 60e3 && sameGame(m)).sort((a, b) => Date.parse(a.serverDate) - Date.parse(b.serverDate));
}

// Bumped when the containers the site publishes change shape; published stories are then sent again (see tick).
const LAYOUT = 2; // 2: header field 1 / SEARCH_KEY_1 = week (was the team id)

// Which dynasty a console upload belongs to: the container says so; a photo goes to the dynasty its uploader is in.
function dynastyOf(store, rec) {
  const g = Number(rec.attributes?.CONTAINER_GROUP);
  if (g && store.dynasties[g]) return store.dynasties[g];
  const mine = Object.values(store.dynasties).filter((d) => d.fileId && (d.members ?? []).some((m) => String(m.blazeId) === String(rec.ownerId)));
  return mine.sort((a, b) => (b.fileSavedAt ?? 0) - (a.fileSavedAt ?? 0))[0] ?? null;
}

export function startWireSync({ store, loadTable }, { intervalMs = 20000 } = {}) {
  const site = siteConfig();
  if (!site) { log('wire', 'no ~/.ncaa-bridge/config.json (workerUrl + token): the Dynasty Wire is not synced with the site'); return () => {}; }
  const missing = new Set(); // endpoints the deployed Worker does not have yet (logged once)
  const call = async (p, method = 'GET', body, raw = false) => {
    const res = await fetch(site.workerUrl + p, { method, headers: { authorization: `Bearer ${site.token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 404 && !missing.has(p.split('?')[0])) { missing.add(p.split('?')[0]); log('wire', `${method} ${p.split('?')[0]} -> 404 (deploy the Worker to enable)`); }
    if (!res.ok) throw Object.assign(new Error(`${method} ${p} -> ${res.status}`), { status: res.status });
    return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
  };

  // console -> site
  const mirror = async (rec) => {
    if (rec.origin !== 'console' || state.mirrored[rec.id] === rec.serverDate) return;
    const d = dynastyOf(store, rec); if (!d) { log('wire', `media ${rec.id}: no dynasty for owner ${rec.ownerId}`); return; }
    if (/SCREENSHOT/i.test(rec.type)) {
      const bin = readBinary(rec, 0); if (!bin) return;
      const jpg = isJpeg(bin) ? { bytes: bin } : isPng(bin) ? toJpeg(bin, 1280) : null;
      if (!jpg) { log('wire', `photo ${rec.id}: binary is neither JPEG nor PNG (${bin.subarray(0, 8).toString('hex')}); kept locally only`); state.mirrored[rec.id] = rec.serverDate; saveState(); return; }
      if (blankPhoto(rec)) { log('wire', `photo ${rec.id} "${rec.description || rec.name}": blank frame (brightness spread ${state.range[rec.id]}), the console captured no picture; not sent to the site`); state.mirrored[rec.id] = rec.serverDate; saveState(); return; }
      await call('/api/bridge/captures', 'PUT', { od: d.id, name: `xms-${rec.id}`, b64: jpg.bytes.toString('base64'), type: 'image/jpeg', width: jpg.width ?? null, height: jpg.height ?? null, takenAt: rec.date, playText: rec.description || rec.name || null });
      log('wire', `photo ${rec.id} -> site captures (DID ${d.id}, ${jpg.bytes.length} B)`);
    } else if (rec.type === 'MEDIA_CONTAINER') {
      const s = parseContainer(rec, readBinary(rec, 0));
      let ref = s.mediaRefs.map((r) => getMedia(r.id)).find((m) => m && /SCREENSHOT/i.test(m.type) && !blankPhoto(m));
      if (!ref && s.kind === 'game-recap') ref = gamePhotos(rec, s).find((m) => !blankPhoto(m)) ?? null; // the console attaches none
      const pic = ref ? readBinary(ref, 0) : null; const jpg = pic ? (isJpeg(pic) ? { bytes: pic } : toJpeg(pic, 1280)) : null;
      // the coach's team: the uploader's team in this dynasty (for a recap, whichever side of the game it is)
      const mine = (d.members ?? []).find((m) => String(m.blazeId) === String(rec.ownerId))?.team ?? null;
      const teamTgid = s.kind === 'game-recap' ? ([s.homeTgid, s.awayTgid].includes(mine) ? mine : s.awayTgid ?? s.homeTgid) : mine;
      await call('/api/bridge/console-stories', 'PUT', {
        od: d.id, xmsId: rec.id, storyType: s.storyType, kind: s.kind, teamTgid, week: s.week, season: s.season, title: s.title, headline: s.headline, caption: s.caption,
        body: s.body, texts: s.texts, tableBlocks: s.tableBlocks, author: rec.owner, authorBlazeId: rec.ownerId, createdAt: rec.date, photoB64: jpg ? jpg.bytes.toString('base64') : null,
      });
      log('wire', `story ${rec.id} (${s.kind}, "${s.title || s.headline}") -> site (DID ${d.id}${ref ? `, photo ${ref.id}` : ''})`);
    } else return;
    state.mirrored[rec.id] = rec.serverDate; saveState();
  };

  // site -> console
  const publish = async (d, st) => {
    const prev = state.site[st.id];
    if (prev) { removeMedia(prev.containerId); if (prev.photoId) removeMedia(prev.photoId); }
    let photo = null;
    if (st.hasImage) {
      try {
        const img = await call(`/api/bridge/wire/${st.id}/image?od=${d.id}`, 'GET', undefined, true);
        const big = toJpeg(img, 640), small = big ? toJpeg(img, 160) : null;
        if (big) {
          const rec = addMedia({ type: 'SCREENSHOT', name: consoleText(st.title, MAX.caption), description: consoleText(st.caption || st.title, MAX.headline), binaries: [{ name: 'screen_jpg', type: 'JPEG_SCREENSHOT', bytes: big.bytes }], thumb: small?.bytes ?? null, ownerId: st.authorBlazeId, owner: st.author, origin: 'site', extra: { siteStoryId: st.id, width: big.width, height: big.height } });
          photo = { id: rec.id, type: 'SCREENSHOT' };
        }
      } catch (e) { log('wire', `story ${st.id}: photo skipped (${e.message})`); }
    }
    const guid = `${d.id}-site-${st.id}-${crypto.randomBytes(4).toString('hex')}`;
    const seai = loadTable?.(d.id, 'SEAI')?.rows?.[0];
    const season = Number(seai?.SSYE ?? 0); // SEARCH_KEY_2 is the season index
    const week = st.week ?? Number(seai?.SEWN ?? 0); // SEARCH_KEY_1: the week the story was written in
    const c = buildUserStory({ group: d.id, week, season, title: st.title, headline: st.headline || st.title, caption: st.caption || st.title, body: st.body, photo, guid });
    const rec = addMedia({ ...c, ownerId: st.authorBlazeId, owner: st.author, origin: 'site', date: st.createdAt ? new Date(st.createdAt.replace(' ', 'T') + 'Z').toISOString() : undefined, extra: { siteStoryId: st.id } });
    state.site[st.id] = { containerId: rec.id, photoId: photo?.id ?? null, version: st.version, did: d.id, layout: LAYOUT }; saveState();
    await call(`/api/bridge/wire/${st.id}/delivered?od=${d.id}`, 'POST', { xmsId: rec.id, version: st.version });
    log('wire', `site story ${st.id} "${st.title}" -> Dynasty Wire media ${rec.id}${photo ? ` + photo ${photo.id}` : ''} (DID ${d.id})`);
  };

  let busy = false;
  const tick = async () => {
    if (busy) return; busy = true;
    try {
      for (const d of Object.values(store.dynasties)) {
        if (!d.fileId) continue;
        // stories published with an older container layout: mark them stale on the site so they come back as pending
        for (const [id, s] of Object.entries(state.site)) {
          if (s.did !== d.id || s.layout === LAYOUT) continue;
          try { await call(`/api/bridge/wire/${id}/delivered?od=${d.id}`, 'POST', { xmsId: s.containerId, version: `layout<${LAYOUT}` }); s.layout = LAYOUT; saveState(); log('wire', `site story ${id}: republishing with container layout ${LAYOUT}`); }
          catch (e) { log('wire', `site story ${id}: ${e.message}`); }
        }
        let list;
        try { list = await call(`/api/bridge/wire?od=${d.id}`); } catch (e) { if (e.status !== 404) log('wire', `DID ${d.id}: ${e.message}`); continue; }
        for (const st of list.pending ?? []) { try { await publish(d, st); } catch (e) { log('wire', `site story ${st.id}: ${e.message}`); } }
        for (const r of list.recaps ?? []) { // the coach's side of the story replaces the console's recap prompt
          try {
            const rec = getMedia(r.xmsId);
            if (!rec || rec.type !== 'MEDIA_CONTAINER') { log('wire', `recap ${r.xmsId}: no such story on this server`); continue; }
            replaceBinary(rec.id, 0, replaceTextBlock(readBinary(rec, 0) ?? Buffer.from(''), consoleText(r.text, MAX.body)));
            state.mirrored[rec.id] = rec.serverDate; saveState(); // our own edit: nothing to mirror back
            await call(`/api/bridge/wire/recap/${rec.id}/delivered?od=${d.id}`, 'POST', { at: r.at });
            log('wire', `recap ${rec.id}: the coach's side of the story is on the Dynasty Wire (${r.text.length} chars)`);
          } catch (e) { log('wire', `recap ${r.xmsId}: ${e.message}`); }
        }
        const live = new Set((list.live ?? []).map(String));
        for (const [id, s] of Object.entries(state.site)) {
          if (s.did !== d.id || live.has(id)) continue;
          removeMedia(s.containerId); if (s.photoId) removeMedia(s.photoId); delete state.site[id]; saveState();
          log('wire', `site story ${id} deleted -> removed from the Dynasty Wire`);
        }
      }
      if (state.consoleLayout !== LAYOUT) { // console stories sent with an older reading of the header: send them again
        for (const rec of allMedia()) if (rec.origin === 'console' && rec.type === 'MEDIA_CONTAINER') delete state.mirrored[rec.id];
        state.consoleLayout = LAYOUT; saveState();
      }
      for (const rec of allMedia()) if (rec.origin === 'console' && state.mirrored[rec.id] !== rec.serverDate) { try { await mirror(rec); } catch (e) { if (e.status !== 404) log('wire', `media ${rec.id}: ${e.message}`); } }
    } catch (e) { log('wire', `sync failed: ${e.message}`); }
    finally { busy = false; }
  };
  xmsEvents.on('stored', () => setTimeout(tick, 500));
  const timer = setInterval(tick, intervalMs); timer.unref?.();
  log('wire', `syncing the Dynasty Wire with ${site.workerUrl} every ${intervalMs / 1000}s`);
  tick();
  return () => clearInterval(timer);
}
