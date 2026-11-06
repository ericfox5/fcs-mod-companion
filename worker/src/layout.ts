import { html, raw, page, type Raw } from './html.js';
import type { Dynasty, MemberRow } from './db/queries.js';
import type { AccountInfo } from './session.js';
import { weekLabel, seasonLabel } from './pages/common.js';

// Section links, grouped for the dynasty menu (key, label, group). The menu adds Members and All dynasties to League.
export const NAV: [string, string, string][] = [
  ['home', 'Home', 'Season'], ['schedule', 'Scores', 'Season'], ['standings', 'Standings', 'Season'], ['rankings', 'Rankings', 'Season'], ['bracket', 'Bracket', 'Season'], ['stats', 'Stats', 'Season'], ['awards', 'Awards', 'Season'],
  ['teams', 'Teams', 'Team'], ['rosters', 'Rosters', 'Team'], ['depth', 'Depth Chart', 'Team'], ['recruiting', 'Recruiting', 'Team'], ['transfers', 'Transfer Portal', 'Team'],
  ['stories', 'News Wire', 'League'],
];

export const DISCLAIMER = 'Fan passion project. Not affiliated with, endorsed by, or sponsored by Electronic Arts, EA SPORTS, ESPN, the NCAA, or any school or conference. Not monetized.';

// "2013 season · Week 4" (SEAI.SEWN is zero-based; week type 151 is the preseason stage before the first advance).
export const stageLabel = (d: Dynasty) => `${seasonLabel(d)} · ${d.week_type === 151 ? 'Preseason' : weekLabel(d.week ?? 0)}`;

// Sports-network style chrome: black global bar (brand, the dynasty title that opens the section menu, the account
// area), the week's scoreboard strip, white cards on a light grey page. No third-party marks: the brand is the FCS
// shield plus our own wordmark.
export function layout(opts: { title: string; siteName: string; dyn?: Dynasty; section?: string; body: Raw; wide?: boolean; strip?: Raw; member?: MemberRow | null; members?: MemberRow[]; path?: string; account?: AccountInfo | null; locked?: boolean }): Response {
  const d = opts.dyn;
  const base = d ? `/d/${d.slug}` : '';
  const viewer = opts.members?.[0]?.auth; // stamped by currentMember; pages only pass member/members
  const locked = opts.locked ?? viewer?.locked ?? false, account = opts.account ?? viewer?.account ?? null;
  const cur = opts.section ?? (opts.path?.split('/')[3] || '');
  // the account area: signed-in persona (team) · Sign out, or Sign in once the dynasty has accounts; before that the
  // persona <select> from the one-commissioner days. Shown in the bar on desktop and at the end of the menu on phones.
  const who = !d ? '' : locked
    ? (account
      ? html`<div class="who"><a class="who-me" href="${base}/members" title="Members and accounts">${opts.member ? html`${opts.member.persona}${opts.member.team_name ? html` <span class="who-team">(${opts.member.team_name})</span>` : ''}` : account.username}</a><span class="sep">·</span><form class="who-out" method="post" action="${base}/logout"><input type="hidden" name="back" value="${opts.path ?? base}"><button type="submit">Sign out</button></form></div>`
      : html`<div class="who"><a class="who-me" href="${base}/members" title="Members and accounts">Members</a><span class="sep">·</span><a class="who-in" href="${base}/login?back=${encodeURIComponent(opts.path ?? base)}">Sign in</a></div>`)
    : opts.members && opts.members.length ? html`<form class="who" method="post" action="${base}/member"><input type="hidden" name="back" value="${opts.path ?? base}"><label>You</label><select name="blaze_id" onchange="this.form.submit()">${opts.member ? '' : html`<option value="" selected>Pick a member</option>`}${opts.members.map((m) => html`<option value="${m.blaze_id}" ${opts.member?.blaze_id === m.blaze_id ? 'selected' : ''}>${m.persona}</option>`)}</select><a class="who-in" href="${base}/members" title="Members and accounts">Members</a></form>` : '';
  const link = (href: string, label: string, on: boolean) => html`<li><a href="${href}" ${on ? html`class="on" aria-current="page"` : ''}>${label}</a></li>`;
  const groups = [...new Set(NAV.map(([, , g]) => g))].map((g) => [g, NAV.filter(([, , x]) => x === g).map(([k, label]) => link(`${base}/${k}`, label, k === cur))] as const);
  // The dynasty title opens every section in a sheet under the bar: a <details>, so it works without script; site.js adds
  // outside-click / Esc closing and aria-expanded.
  const header = html`<header class="gh">
  <div class="wrap gh-inner">
    <a class="brand" href="${base || '/'}"><img class="fcs-mark" src="/img/fcs-logo.svg" alt="NCAA Division I FCS" width="38" height="36"><span class="brand-text"><span class="brand-top">Online Dynasty</span><span class="brand-sub">FCS</span></span></a>
    ${d ? html`<details class="dmenu">
      <summary class="dm-title" title="All sections"><span class="dm-text"><span class="dm-name">${d.name}</span><span class="dm-stage">${stageLabel(d)}</span></span><span class="dm-chev" aria-hidden="true"></span></summary>
      <nav class="dm-sheet" aria-label="Dynasty sections"><div class="wrap dm-grid">
        ${groups.map(([g, links], n) => html`<div class="dm-group"><p class="dm-h" id="dm-g${n}">${g}</p><ul aria-labelledby="dm-g${n}">${links}${g === 'League' ? html`${link(`${base}/members`, 'Members', cur === 'members')}${link('/', 'All dynasties', false)}` : ''}</ul></div>`)}
        ${who ? html`<div class="dm-group dm-acct"><p class="dm-h">Account</p>${who}</div>` : ''}
      </div></nav>
    </details>` : ''}
    <div class="gh-right">${d ? who : html`<span class="dyn-pill"><span class="dyn-stage">Fan revival of the NCAA 14 web app</span></span>`}</div>
  </div>
</header>`;
  return page(html`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title} | ${opts.siteName}</title>
<link rel="stylesheet" href="/css/base.css">
<link rel="icon" href="/img/fcs-logo.svg" type="image/svg+xml">
<script src="/js/site.js" defer></script>
</head>
<body>
${header}
${opts.strip ?? ''}
<main class="wrap main ${opts.wide ? 'wide' : ''}">
${opts.body}
</main>
<footer class="gf">
  <div class="wrap">
    <p class="disclaimer">${DISCLAIMER}</p>
    <p class="links"><a href="/">Dynasties</a> · Online dynasties are mirrored from the league's own dynasty server by ncaa-bridge; offline saves are decoded from the save file. Team logos belong to their schools; player photos come from the schools' public rosters.</p>
  </div>
</footer>
</body>
</html>`);
}

export const box = (title: string | Raw, body: Raw, cls = '') => html`<section class="box ${cls}"><h3>${title}</h3><div class="box-body">${body}</div></section>`;
export const two = (left: Raw, right: Raw) => html`<div class="cols"><div class="col-main">${left}</div><div class="col-side">${right}</div></div>`;
export const rec = (w: number, l: number) => `${w}-${l}`;
export { raw };
