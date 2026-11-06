// NCAA 14 Story Center containers, the stories of the in-game Dynasty Wire (reverse engineered from the 1.02 EBOOT:
// Container 0x30c600-0x310600, Story classes 0x37d000-0x381900). A story is one XMS media of type MEDIA_CONTAINER:
//   <name>         the story header: 3-hex-digit fields, then free text. Field 0 = story type (0a0 GameRecapStory,
//                  0a1 WeeklyRecapStory, 0a2 UserStory), field 1 = week (SEAI.SEWN); a UserStory's title starts at
//                  offset 6 (Story slot 13, 0x38185c). StoryCenterMgr derives SEARCH_KEY_1 from field 1 (0x37ed70).
//                  A console game recap (2026-10-31, Brown at Princeton, week 12) continues with field 2 = game number
//                  (SCHD.SGNM 44), 3 = home TGID (11), 4 = away TGID (40), then 11 more fields not decoded yet.
//   <description>  the headline.
//   attributes     CONTAINER_GROUP = online dynasty id (MOIN.MIMI, "%d"), CONTAINER_GUID, CAPTION (<= 81 chars),
//                  MEDIA_ID_0..14 / MEDIA_TYPE_0..14 (attached photos/videos: XMS media id + the media's type; the
//                  console's game recap leaves them empty), SEARCH_KEY_1 = week, SEARCH_KEY_2 = season index
//                  (SEAI.SSYE), both decimal. The Wire searches CONTAINER_GROUP + SEARCH_KEY_2, plus SEARCH_KEY_1 for
//                  one week.
//   binary         "container" (type CONTAINER): an XML document written by Container::StartContainerXML
//                  <?xml version='1.0'?><story_data><story_media type="T"><![CDATA[...]]></story_media>...</story_data>
//                  T 0 = packed game tables (unpacked into the console's DB by Container::UnpackTables),
//                  T 1 = text blocks in order (index 0 = the body, read into Story+0x2a94, at most 5,120 bytes).
// The game's own reveal/test UserStory (0x3816c8) is the model for buildUserStory: name "0a2" + team + title, headline
// in <description>, a caption, and one type-1 body block.
export const STORY_TYPES = { 0xa0: 'game-recap', 0xa1: 'weekly-recap', 0xa2: 'user-story' };
export const MAX = { title: 80, headline: 200, caption: 80, body: 5000 };

const hex3 = (n) => (Math.max(0, Math.min(0xfff, Number(n) || 0))).toString(16).padStart(3, '0');

// The console's text is single-byte; keep printable ASCII (typographic quotes and dashes folded) and newlines.
export function consoleText(s, max) {
  const t = String(s ?? '').replace(/\r\n?/g, '\n').replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, '-').replace(/…/g, '...').replace(/ /g, ' ').normalize('NFKD').replace(/[^\n\x20-\x7e]/g, '');
  return t.length > max ? t.slice(0, max - 3).replace(/\s+\S*$/, '') + '...' : t;
}

const cdata = (s) => `<![CDATA[${String(s).split(']]>').join(']] >')}]]>`;
export function containerXml(blocks) {
  return `<?xml version='1.0'?>\n<story_data>${blocks.map((b) => `<story_media type="${b.type}">${cdata(b.text)}</story_media>`).join('')}</story_data>`;
}

// A UserStory as the site publishes it. photo = { id, type } of an XMS screenshot media to attach, or null.
export function buildUserStory({ group, week, season, title, headline, caption, body, photo = null, guid }) {
  const attributes = { CONTAINER_GROUP: String(group), CONTAINER_GUID: guid, CAPTION: consoleText(caption ?? '', MAX.caption) };
  for (let i = 0; i < 15; i++) { attributes[`MEDIA_ID_${i}`] = ''; attributes[`MEDIA_TYPE_${i}`] = ''; }
  if (photo) { attributes.MEDIA_ID_0 = String(photo.id); attributes.MEDIA_TYPE_0 = photo.type; }
  attributes.SEARCH_KEY_1 = String(Number(week) || 0); attributes.SEARCH_KEY_2 = String(Number(season) || 0);
  return {
    type: 'MEDIA_CONTAINER',
    name: `${hex3(0xa2)}${hex3(week)}${consoleText(title, MAX.title)}`,
    description: consoleText(headline, MAX.headline),
    attributes,
    binaries: [{ name: 'container', type: 'CONTAINER', bytes: Buffer.from(containerXml([{ type: 1, text: consoleText(body, MAX.body) }]), 'latin1') }],
  };
}

const unescapeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// Reads any container the console uploaded: header fields, title, text blocks, and how many table blocks it carries.
export function parseContainer(media, bytes) {
  const name = String(media?.name ?? '');
  const isUser = /^0a2/i.test(name); // a UserStory has two fields, then its title (which may itself look like hex)
  const fields = []; for (let i = 0; i + 3 <= name.length && /^[0-9a-f]{3}$/i.test(name.slice(i, i + 3)) && fields.length < (isUser ? 2 : 16); i += 3) fields.push(parseInt(name.slice(i, i + 3), 16));
  const storyType = fields[0] ?? null;
  const blocks = []; const xml = bytes ? Buffer.from(bytes).toString('latin1') : '';
  const re = /<story_media\b[^>]*\btype\s*=\s*["']?(-?\d+)["']?[^>]*>([\s\S]*?)<\/story_media>/g;
  for (let m; (m = re.exec(xml));) {
    const raw = m[2]; const c = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
    blocks.push({ type: Number(m[1]), text: c ? c[1] : unescapeXml(raw) });
  }
  const texts = blocks.filter((b) => b.type === 1).map((b) => b.text);
  const a = media?.attributes ?? {};
  const mediaRefs = []; for (let i = 0; i < 15; i++) if (a[`MEDIA_ID_${i}`]) mediaRefs.push({ id: Number(a[`MEDIA_ID_${i}`]), type: a[`MEDIA_TYPE_${i}`] ?? '' });
  return {
    storyType, kind: STORY_TYPES[storyType] ?? 'unknown', fields, week: fields[1] ?? (a.SEARCH_KEY_1 ? Number(a.SEARCH_KEY_1) : null),
    gameNum: storyType === 0xa0 ? fields[2] ?? null : null, homeTgid: storyType === 0xa0 ? fields[3] ?? null : null, awayTgid: storyType === 0xa0 ? fields[4] ?? null : null,
    title: storyType === 0xa2 ? name.slice(6) : name.replace(/^([0-9a-f]{3})+/i, ''), headline: media?.description ?? '', caption: a.CAPTION ?? '',
    group: a.CONTAINER_GROUP ?? null, guid: a.CONTAINER_GUID ?? null, season: a.SEARCH_KEY_2 != null && a.SEARCH_KEY_2 !== '' ? Number(a.SEARCH_KEY_2) : null,
    body: texts[0] ?? '', texts, tableBlocks: blocks.filter((b) => b.type === 0).length, otherBlocks: blocks.filter((b) => b.type !== 0 && b.type !== 1).map((b) => ({ type: b.type, bytes: b.text.length })),
    mediaRefs, xmlBytes: xml.length,
  };
}

// Replaces the text of the n-th type-1 block (the body when n = 0) in place, leaving every other byte of the console's
// container (packed tables included) untouched; appends a block when the container has none.
export function replaceTextBlock(bytes, text, n = 0) {
  const xml = Buffer.from(bytes).toString('latin1');
  const re = /(<story_media\b[^>]*\btype\s*=\s*["']?1["']?[^>]*>)([\s\S]*?)(<\/story_media>)/g;
  let i = 0, out = null;
  out = xml.replace(re, (all, open, _inner, close) => (i++ === n ? open + cdata(text) + close : all));
  if (i <= n) out = xml.replace(/<\/story_data>\s*$/, `<story_media type="1">${cdata(text)}</story_media></story_data>`);
  return Buffer.from(out, 'latin1');
}
