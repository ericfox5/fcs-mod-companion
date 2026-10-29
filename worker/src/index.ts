import type { Env } from './env.js';
import { handleBridge } from './api/bridge.js';
import { json, notFound } from './html.js';
import { servePhoto, serveLogo, serveStoryImage } from './api/photos.js';
import { getDynasty, listDynasties } from './db/queries.js';
import { landingPage } from './pages/landing.js';
import { scoreStrip, stripTiles } from './pages/common.js';
import { homePage } from './pages/home.js';
import { teamsPage, teamPage } from './pages/teams.js';
import { schedulePage } from './pages/schedule.js';
import { standingsPage } from './pages/standings.js';
import { rankingsPage } from './pages/rankings.js';
import { rostersPage, playerPage } from './pages/rosters.js';
import { statsPage } from './pages/stats.js';
import { storiesPage, storyFormPage, storyAction } from './pages/stories.js';
import { awardsPage } from './pages/awards.js';
import { recruitingPage } from './pages/recruiting.js';
import { gamePage } from './pages/game.js';
import { boardAction, top300Page } from './pages/recruiting.js';
import { playerEditAction } from './pages/player-edit.js';
import { currentMember, memberCookie, redirect } from './session.js';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      if (parts[0] === 'api') {
        if (parts[1] === 'bridge') return handleBridge(req, env, parts.slice(2));
        if (parts[1] === 'health') return json({ ok: true });
        return json({ error: 'not found' }, 404);
      }
      if (parts[0] === 'img' && (parts[1] === 'players' || parts[1] === 'faces') && parts[2]) return servePhoto(env, `photos/${parts[1]}/${decodeURIComponent(parts[2])}`);
      if (parts[0] === 'img' && parts[1] === 'logos' && parts[2] && parts[3]) return serveLogo(env, `logos/${parts[2]}/${decodeURIComponent(parts[3])}`, url.searchParams.get('t') ?? '');
      if (parts[0] === 'img' && parts[1] === 'stories' && parts[2] && parts[3]) return serveStoryImage(env, `stories/${parts[2]}/${decodeURIComponent(parts[3])}`);
      if (parts[0] === 'css' || parts[0] === 'js' || parts[0] === 'img' || parts[0] === 'favicon.ico') return env.ASSETS.fetch(req);
      if (parts.length === 0) return landingPage(env, await listDynasties(env.DB));
      if (parts[0] === 'd' && parts[1]) {
        const dyn = await getDynasty(env.DB, parts[1]);
        if (!dyn) return notFound('No such dynasty');
        if (parts[2] === 'strip') { const w = Number(url.searchParams.get('week') ?? dyn.week ?? 0); return new Response((await stripTiles(env, dyn, Number.isFinite(w) ? w : (dyn.week ?? 0))).html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60' } }); }
        const section = parts[2] ?? 'home';
        const { member, members } = await currentMember(req, env.DB, dyn.id);
        if (req.method === 'POST') {
          if (parts[2] === 'member') { const form = await req.formData(); const id = Number(form.get('blaze_id')); const back = String(form.get('back') ?? `/d/${dyn.slug}`); return redirect(back.startsWith('/') ? back : `/d/${dyn.slug}`, members.some((m) => m.blaze_id === id) ? { 'set-cookie': memberCookie(id) } : {}); }
          if (parts[2] === 'recruiting' && parts[3] === 'board') return boardAction({ env, dyn, url, req, member, members }, await req.formData());
          if (parts[2] === 'player' && parts[3] && parts[4] === 'edit') return playerEditAction({ env, dyn, url, req, member, members }, Number(parts[3]), await req.formData());
          if (parts[2] === 'stories' && parts[3]) return storyAction({ env, dyn, url, req, member, members }, parts[3], parts[4]);
          return json({ error: 'not found' }, 404);
        }
        const ctx = { env, dyn, url, req, member, members, strip: await scoreStrip(env, dyn) };
        switch (section) {
          case 'home': return homePage(ctx);
          case 'teams': return teamsPage(ctx);
          case 'team': return teamPage(ctx, Number(parts[3]));
          case 'schedule': return schedulePage(ctx);
          case 'game': return gamePage(ctx, Number(parts[3]), Number(parts[4]));
          case 'standings': return standingsPage(ctx);
          case 'rankings': return rankingsPage(ctx);
          case 'rosters': return rostersPage(ctx, parts[3] ? Number(parts[3]) : undefined);
          case 'player': return playerPage(ctx, Number(parts[3]));
          case 'stats': return statsPage(ctx);
          case 'stories': return parts[3] === 'new' ? storyFormPage(ctx) : parts[3] && parts[4] === 'edit' ? storyFormPage(ctx, Number(parts[3])) : storiesPage(ctx);
          case 'awards': return awardsPage(ctx);
          case 'recruiting': return parts[3] === 'top300' ? top300Page(ctx) : recruitingPage(ctx);
        }
      }
      return notFound();
    } catch (e: any) {
      console.error(e?.stack ?? e);
      return new Response(`Server error: ${e?.message ?? e}`, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;

export interface PageCtx { env: Env; dyn: import('./db/queries.js').Dynasty; url: URL; req?: Request; member?: import('./db/queries.js').MemberRow | null; members?: import('./db/queries.js').MemberRow[]; strip?: import('./html.js').Raw }
