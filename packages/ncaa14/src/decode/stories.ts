import type { TdbFile } from '@ncaa/tdb';

export interface Story {
  index: number;
  week: number; // SEWN
  gameNo: number; // SGNM
  headline: string; // MHTX
  text: string; // MCTX
  tgid: number;
  pgid: number;
  layout: number; // MLAY
  storyWeek: number; // SWEK
  raw: Record<string, number | string>;
}

export function decodeStories(file: TdbFile): Story[] {
  if (!file.hasTable('MCOV')) return [];
  const t = file.table('MCOV');
  const out: Story[] = [];
  let i = 0;
  for (const r of t.rows()) {
    const headline = (r['MHTX'] as string) ?? '';
    if (headline) out.push({ index: i, week: r['SEWN'] as number, gameNo: r['SGNM'] as number, headline, text: (r['MCTX'] as string) ?? '', tgid: r['TGID'] as number, pgid: r['PGID'] as number, layout: r['MLAY'] as number, storyWeek: r['SWEK'] as number, raw: r });
    i++;
  }
  return out;
}
