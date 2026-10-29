export interface Env {
  DB: D1Database;
  SAVES: R2Bucket;
  ASSETS: Fetcher;
  SITE_NAME: string;
  BASE_YEAR: string;
  BRIDGE_TOKEN?: string;
}
