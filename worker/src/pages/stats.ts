import type { PageCtx } from '../index.js';
import { html } from '../html.js';
import { layout, box } from '../layout.js';
import { getTeams, getPlayerSeasonStats, teamMap } from '../db/queries.js';
import { playerLink, pos, teamLogo, headshot, seasonLabel } from './common.js';

// Season stat columns (codes inside PSOF/PSDE/PSKI/PSKP/PSOL). Labels are our reading of the data; verify against in-game screens.
const CATS: { title: string; kind: string; cols: [string, string][]; sort: string }[] = [
  { title: 'Passing', kind: 'PSOF', cols: [['sacm', 'Cmp'], ['saat', 'Att'], ['saya', 'Yds'], ['satd', 'TD'], ['sain', 'INT']], sort: 'saya' },
  { title: 'Rushing', kind: 'PSOF', cols: [['suat', 'Att'], ['suya', 'Yds'], ['sutd', 'TD'], ['subt', 'BTK'], ['sufu', 'Fum']], sort: 'suya' },
  { title: 'Receiving', kind: 'PSOF', cols: [['scca', 'Rec'], ['scya', 'Yds'], ['sctd', 'TD'], ['scyc', 'YAC'], ['scdr', 'Drp']], sort: 'scya' },
  { title: 'Defense', kind: 'PSDE', cols: [['sdta', 'Tkl'], ['sdtl', 'TFL'], ['slsk', 'Sck'], ['ssin', 'INT'], ['sdpd', 'PD'], ['slff', 'FF']], sort: 'sdta' },
  { title: 'Kicking', kind: 'PSKI', cols: [['skfm', 'FGM'], ['skfa', 'FGA'], ['skfL', 'Lng'], ['skem', 'XPM'], ['skea', 'XPA']], sort: 'skfm' },
  { title: 'Punting', kind: 'PSKI', cols: [['spat', 'Punts'], ['spya', 'Yds'], ['splN', 'Lng']], sort: 'spya' },
  { title: 'Kick returns', kind: 'PSKP', cols: [['srka', 'Ret'], ['srky', 'Yds'], ['srkt', 'TD'], ['srkL', 'Lng']], sort: 'srky' },
  { title: 'Punt returns', kind: 'PSKP', cols: [['srpa', 'Ret'], ['srpy', 'Yds'], ['srpt', 'TD'], ['srpL', 'Lng']], sort: 'srpy' },
  { title: 'Blocking', kind: 'PSOL', cols: [['sopa', 'Pancakes'], ['sosa', 'Sacks allowed']], sort: 'sopa' },
];

export async function statsPage(ctx: PageCtx) {
  const { env, dyn, url } = ctx;
  const db = env.DB, d = dyn.id, y = dyn.season_year;
  const teams = teamMap(await getTeams(db, d));
  const limit = Number(url.searchParams.get('n') ?? 10);
  const kinds = [...new Set(CATS.map((c) => c.kind))];
  const data = new Map(await Promise.all(kinds.map(async (k) => [k, (await getPlayerSeasonStats(db, d, y, k)).map((r) => ({ ...r, s: JSON.parse(r.stats_json) as Record<string, number> }))] as const)));
  const blocks = CATS.map((c) => {
    const rows = (data.get(c.kind) ?? []).filter((r) => (r.s[c.sort] ?? 0) > 0).sort((a, b) => (b.s[c.sort] ?? 0) - (a.s[c.sort] ?? 0)).slice(0, limit);
    return box(c.title, rows.length ? html`<table class="list stats"><tr><th>Player</th><th>Team</th><th>Pos</th>${c.cols.map(([, l]) => html`<th>${l}</th>`)}</tr>
      ${rows.map((r) => html`<tr><td>${headshot(r)} ${playerLink(dyn.slug, r as any)}</td><td class="logo-cell">${teamLogo(teams.get(r.tgid), 'sm')}</td><td>${pos(r.pos)}</td>${c.cols.map(([k]) => html`<td class="num">${r.s[k] ?? ''}</td>`)}</tr>`)}</table>` : html`<p class="muted">No stats yet.</p>`);
  });
  const body = html`<h2>Stat leaders · ${seasonLabel(dyn)}</h2><p class="muted">Columns are decoded from the save's season-stat tables; labels are best-effort until verified in-game.</p><div class="grid2">${blocks}</div>`;
  return layout({ strip: ctx.strip, member: ctx.member, members: ctx.members, path: ctx.url.pathname, title: 'Stats', siteName: env.SITE_NAME, dyn, section: 'stats', body, wide: true });
}
