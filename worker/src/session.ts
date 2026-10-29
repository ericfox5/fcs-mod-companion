// Who is using the site: a persona chosen from the dynasty's online members, kept in a cookie. No passwords yet (the
// league is one commissioner today); invite codes and sessions come with the multi-user milestone.
import type { MemberRow } from './db/queries.js';
import { getMembers } from './db/queries.js';

export const MEMBER_COOKIE = 'od_member';

export function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get('cookie') ?? '';
  for (const part of raw.split(';')) { const [k, ...v] = part.trim().split('='); if (k === name) return decodeURIComponent(v.join('=')); }
  return null;
}

// The current member: the cookie's persona if it belongs to this dynasty, else the only member when there is just one.
export async function currentMember(req: Request, db: D1Database, dynastyId: number): Promise<{ member: MemberRow | null; members: MemberRow[] }> {
  const members = await getMembers(db, dynastyId);
  const want = Number(readCookie(req, MEMBER_COOKIE));
  const member = members.find((m) => m.blaze_id === want) ?? (members.length === 1 ? members[0]! : null);
  return { member, members };
}

export const memberCookie = (blazeId: number) => `${MEMBER_COOKIE}=${blazeId}; Path=/; Max-Age=31536000; SameSite=Lax`;
export const redirect = (to: string, headers: Record<string, string> = {}) => new Response(null, { status: 303, headers: { location: to, ...headers } });
