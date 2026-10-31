export interface Env {
  DB: D1Database;
  SAVES: R2Bucket;
  ASSETS: Fetcher;
  SITE_NAME: string;
  BASE_YEAR: string;
  BRIDGE_TOKEN?: string;
  SUPERSIM_ENABLED?: string; // 'true' once the console adapter is live
  SUPERSIM_QUARTER_SECONDS?: string; // fallback quarter length; the dynasty's QTR setting wins
  SUPERSIM_SESSION_SECRET?: string; // unused: identity comes from the site's own sessions
}
