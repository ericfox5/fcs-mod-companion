import { html, raw, page, type Raw } from './html.js';
import type { Dynasty, MemberRow } from './db/queries.js';
import { weekLabel, seasonLabel } from './pages/common.js';

export const NAV: [string, string][] = [
  ['home', 'Home'], ['schedule', 'Scores'], ['teams', 'Teams'], ['standings', 'Standings'], ['rankings', 'Rankings'],
  ['stats', 'Stats'], ['rosters', 'Rosters'], ['recruiting', 'Recruiting'], ['awards', 'Awards'], ['stories', 'News Wire'],
];

export const DISCLAIMER = 'Fan passion project. Not affiliated with, endorsed by, or sponsored by Electronic Arts, EA SPORTS, ESPN, the NCAA, or any school or conference. Not monetized.';

// "2013 season · Week 4" (SEAI.SEWN is zero-based; week type 151 is the preseason stage before the first advance).
export const stageLabel = (d: Dynasty) => `${seasonLabel(d)} · ${d.week_type === 151 ? 'Preseason' : weekLabel(d.week ?? 0)}`;

// Sports-network style chrome: black global bar with the section nav, the week's scoreboard strip, white cards on a
// light grey page. No third-party marks: the brand is the FCS shield plus our own wordmark.
export function layout(opts: { title: string; siteName: string; dyn?: Dynasty; section?: string; body: Raw; wide?: boolean; strip?: Raw; member?: MemberRow | null; members?: MemberRow[]; path?: string }): Response {
  const d = opts.dyn;
  const base = d ? `/d/${d.slug}` : '';
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
<header class="gh">
  <div class="wrap gh-inner">
    <a class="brand" href="${base || '/'}"><img class="fcs-mark" src="/img/fcs-logo.svg" alt="NCAA Division I FCS" width="38" height="36"><span class="brand-text"><span class="brand-top">Online Dynasty</span><span class="brand-sub">FCS</span></span></a>
    <nav class="gnav">${d
      ? NAV.map(([k, label]) => html`<a class="${k === opts.section ? 'active' : ''}" href="${base}/${k}">${label}</a>`)
      : html`<a class="active" href="/">Dynasties</a>`}</nav>
    <div class="gh-right">${d && opts.members && opts.members.length ? html`<form class="who" method="post" action="${base}/member"><input type="hidden" name="back" value="${opts.path ?? base}"><label>You</label><select name="blaze_id" onchange="this.form.submit()">${opts.member ? '' : html`<option value="" selected>Pick a member</option>`}${opts.members.map((m) => html`<option value="${m.blaze_id}" ${opts.member?.blaze_id === m.blaze_id ? 'selected' : ''}>${m.persona}</option>`)}</select></form>` : ''}${d
      ? html`<a class="dyn-pill" href="/" title="Browse dynasties"><span class="dyn-name">${d.name}</span><span class="dyn-stage">${stageLabel(d)}</span></a>`
      : html`<span class="dyn-pill"><span class="dyn-stage">Fan revival of the NCAA 14 web app</span></span>`}</div>
  </div>
</header>
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
