// In-game Dynasty Wire: member stories still to be delivered to the console (the league server builds them into Story
// Center containers, spike/blaze/server/wire.mjs), and the stories the console uploaded itself (migration 0012).
const all = async <T>(stmt: D1PreparedStatement): Promise<T[]> => (await stmt.all<T>()).results;

// A story is current on the console when the delivered version matches its last edit and photo.
const VERSION = "COALESCE(updated_at, created_at) || '|' || COALESCE(image_key, '')";

export interface WireStoryRow { id: number; title: string; body: string; tgid: number | null; week: number; season_year: number; author_persona: string; author_blaze_id: number; created_at: string; image_key: string | null; version: string }
export const listPendingWireStories = (db: D1Database, d: number) =>
  all<WireStoryRow>(db.prepare(`SELECT id, title, body, tgid, week, season_year, author_persona, author_blaze_id, created_at, image_key, ${VERSION} AS version FROM web_stories
    WHERE dynasty_id = ? AND (wire_version IS NULL OR wire_version != ${VERSION}) ORDER BY id`).bind(d));
export const listLiveWebStoryIds = async (db: D1Database, d: number) => (await all<{ id: number }>(db.prepare('SELECT id FROM web_stories WHERE dynasty_id = ?').bind(d))).map((r) => r.id);
export const getWebStoryImageKey = (db: D1Database, d: number, id: number) => db.prepare('SELECT image_key FROM web_stories WHERE dynasty_id = ? AND id = ?').bind(d, id).first<{ image_key: string | null }>();
export const markWireDelivered = (db: D1Database, d: number, id: number, xmsId: number | null, version: string) =>
  db.prepare("UPDATE web_stories SET wire_version = ?, wire_xms_id = ?, wire_delivered_at = datetime('now') WHERE dynasty_id = ? AND id = ?").bind(version, xmsId, d, id).run();

// The first sentence of the body (the in-game headline under the title).
export function wireHeadline(body: string, max = 200): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  const m = /^(.{20,}?[.!?])(\s|$)/.exec(flat);
  const s = m ? m[1]! : flat;
  return s.length > max ? s.slice(0, max - 3).replace(/\s+\S*$/, '') + '...' : s;
}

export const STORY_KINDS: Record<string, string> = { 'game-recap': 'Game recap', 'weekly-recap': 'Weekly recap', 'user-story': 'In-game story', unknown: 'Story' };
export interface ConsoleStory { id: number; dynasty_id: number; xms_id: number; story_type: number | null; kind: string; team_tgid: number | null; season: number | null; week: number | null; title: string | null; headline: string | null; caption: string | null; body: string | null; texts_json: string | null; table_blocks: number | null; photo_key: string | null; author_persona: string | null; author_blaze_id: number | null; created_at: string | null; received_at: string; recap_text: string | null; recap_by: string | null; recap_at: string | null; recap_delivered_at: string | null }
export const upsertConsoleStory = (db: D1Database, s: Omit<ConsoleStory, 'id' | 'received_at' | 'recap_text' | 'recap_by' | 'recap_at' | 'recap_delivered_at'>) =>
  db.prepare(`INSERT INTO console_stories (dynasty_id, xms_id, story_type, kind, team_tgid, season, week, title, headline, caption, body, texts_json, table_blocks, photo_key, author_persona, author_blaze_id, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(dynasty_id, xms_id) DO UPDATE SET story_type = excluded.story_type, kind = excluded.kind, team_tgid = excluded.team_tgid,
    season = excluded.season, title = excluded.title, headline = excluded.headline, caption = excluded.caption, body = excluded.body, texts_json = excluded.texts_json,
    table_blocks = excluded.table_blocks, photo_key = COALESCE(excluded.photo_key, console_stories.photo_key), author_persona = excluded.author_persona, author_blaze_id = excluded.author_blaze_id`)
    .bind(s.dynasty_id, s.xms_id, s.story_type, s.kind, s.team_tgid, s.season, s.week, s.title, s.headline, s.caption, s.body, s.texts_json, s.table_blocks, s.photo_key, s.author_persona, s.author_blaze_id, s.created_at).run();
// The game recap prompt the console writes until the coach tells their side of the story on the site.
export const RECAP_PROMPT = 'Tell everyone your side of the story.';
export const getConsoleStory = (db: D1Database, d: number, xmsId: number) => db.prepare('SELECT * FROM console_stories WHERE dynasty_id = ? AND xms_id = ?').bind(d, xmsId).first<ConsoleStory>();
export const setRecapText = (db: D1Database, d: number, xmsId: number, text: string, by: string) =>
  db.prepare("UPDATE console_stories SET recap_text = ?, recap_by = ?, recap_at = datetime('now') WHERE dynasty_id = ? AND xms_id = ?").bind(text, by, d, xmsId).run();
export const listPendingRecaps = (db: D1Database, d: number) =>
  all<{ xms_id: number; recap_text: string; recap_at: string }>(db.prepare('SELECT xms_id, recap_text, recap_at FROM console_stories WHERE dynasty_id = ? AND recap_text IS NOT NULL AND (recap_delivered_at IS NULL OR recap_delivered_at < recap_at)').bind(d));
export const markRecapDelivered = (db: D1Database, d: number, xmsId: number, at: string) =>
  db.prepare('UPDATE console_stories SET recap_delivered_at = ? WHERE dynasty_id = ? AND xms_id = ? AND recap_at = ?').bind(at, d, xmsId, at).run();
export const listConsoleStories = (db: D1Database, d: number, limit = 50) => all<ConsoleStory>(db.prepare('SELECT * FROM console_stories WHERE dynasty_id = ? ORDER BY id DESC LIMIT ?').bind(d, limit));
