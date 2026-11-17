export interface Env {
  DB: D1Database;
  SAVES: R2Bucket;
  ASSETS: Fetcher;
  SITE_NAME: string;
  BASE_YEAR: string;
  BRIDGE_TOKEN?: string; // secret: the bridge API (imports, invites, photos, Supersim, the member list ...)
  REGISTRY_TOKEN?: string; // secret, optional: accepted ONLY on GET /api/bridge/league-registry (the member list the league server pulls)
  SUPERSIM_ENABLED?: string; // 'true' once the console adapter is live
  SUPERSIM_QUARTER_SECONDS?: string; // fallback quarter length; the dynasty's QTR setting wins
  SUPERSIM_SESSION_SECRET?: string; // unused: identity comes from the site's own sessions
  // Open sign-up and the public league server (pages/account.ts, league.ts, security.ts)
  OPEN_SIGNUP?: string; // 'false' closes /signup (invites keep working); anything else, or unset, leaves it open
  LEAGUE_SERVER_HOST?: string; // the address written into member profiles; default play.fcs-mod.online
  SETUP_DOWNLOAD_URL?: string; // where "Download the setup wizard" points; default the GitHub releases page
  ADMIN_ACCOUNT_IDS?: string; // comma-separated account numbers (shown on each /account page) that may disable league members on /admin/members; the preferred way to name admins
  ADMIN_USERNAMES?: string; // comma-separated site usernames with the same right, for accounts that already exist; a listed name can never be registered (account-rules.ts)
  SIGNUP_DAILY_CAP?: string; // accounts created per day at which the site counts as busy (sign-up stays open, more carefully: security.ts); default 200
  SIGNUP_HARD_CAP?: string; // accounts created per day at which sign-up pauses for everyone until the next day; default 2000
  TURNSTILE_SITE_KEY?: string; // with TURNSTILE_SECRET_KEY (a secret) set too, the sign-up form shows Cloudflare Turnstile
  TURNSTILE_SECRET_KEY?: string;
}
