import type { Env } from '../env.js';
import { html } from '../html.js';
import { layout, box, stageLabel } from '../layout.js';
import type { Dynasty } from '../db/queries.js';

export function landingPage(env: Env, dynasties: Dynasty[]) {
  const body = html`
<div class="landing">
  <div class="featured">
    <h1>NCAA Online Dynasty FCS</h1>
    <p class="lede">The companion site EA shut down, rebuilt for RPCS3 leagues: the console plays its Online Dynasty against the league's own server, and every advance and uploaded result shows up here.</p>
  </div>
  ${box('Browse Dynasties', dynasties.length ? html`<table class="list"><tr><th>Dynasty</th><th>Stage</th><th>Members</th><th>Updated (UTC)</th></tr>
    ${dynasties.map((d) => html`<tr><td><a href="/d/${d.slug}">${d.name}</a>${d.od_id !== null ? html` <span class="tag">ONLINE</span>` : ''}</td><td>${stageLabel(d)}</td><td>${d.member_count ?? 0}</td><td>${d.updated_at ?? ''}</td></tr>`)}</table>`
    : html`<p class="muted">No dynasties yet. Create one from the console's Online Dynasty menu; <code>ncaa-bridge od watch</code> mirrors it here.</p>`)}
  <div class="cols">
    ${box('Dynasty Hub', html`<p>Members, this week's user games, scores, polls and the News Wire, straight from the dynasty the console is playing.</p>`)}
    ${box('Power Recruiting', html`<p>Boards, pitches and class rankings for every member team.</p>`)}
    ${box('Advance Week', html`<p>The console advances; the site shows the new week within seconds of the upload.</p>`)}
  </div>
</div>`;
  return layout({ title: 'Home', siteName: env.SITE_NAME, body });
}
