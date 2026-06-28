/**
 * Environment validation and runtime constants for the scraper.
 *
 * Required env vars are read once at module load. Missing required vars throw
 * before the scheduler ever starts, so Railway logs show a clear boot failure
 * rather than a silent loop with no inserts.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

/**
 * Deployment environment. `staging` swaps the DB target to
 * STAGING_DATABASE_URL so test ticks never touch the production Neon
 * branch. Anything else (default) is treated as production.
 */
export const APP_ENV = process.env.APP_ENV ?? 'production';
export const IS_STAGING = APP_ENV === 'staging';

/**
 * Resolve the Neon connection string for the active environment.
 *   - production: DATABASE_URL (required, as before)
 *   - staging:    STAGING_DATABASE_URL (required when APP_ENV=staging)
 * Keeping them in separate vars means a stray `APP_ENV=staging` can never
 * silently fall back to the prod URL — a missing staging URL fails loudly.
 */
function resolveDatabaseUrl(): string {
  if (IS_STAGING) {
    const staging = process.env.STAGING_DATABASE_URL;
    if (staging === undefined || staging.trim() === '') {
      throw new Error(
        'APP_ENV=staging but STAGING_DATABASE_URL is unset — refusing to fall back to production DATABASE_URL',
      );
    }
    return staging;
  }
  return requireEnv('DATABASE_URL');
}

export const DATABASE_URL = resolveDatabaseUrl();
// SENTRY_DSN is optional — when empty, index.ts skips Sentry.init and
// errors land on stdout only. Useful for local dev runs without
// Sentry credentials.
export const SENTRY_DSN = process.env.SENTRY_DSN ?? '';

// Auth is via Playwright storageState, not a raw cookie. The path
// defaults to a Railway-volume location; locally, point it at the file
// scripts/periscope-probe.mjs --login wrote to your home directory.
export const UW_AUTH_STATE_PATH =
  process.env.UW_AUTH_STATE_PATH ?? '/data/uw-auth-state.json';

// Defaults to the Market Maker Exposures Table view confirmed in the
// Phase 0 probe. Production deploys can override via env if UW renames
// the route.
export const UW_PERISCOPE_URL =
  process.env.UW_PERISCOPE_URL ??
  'https://unusualwhales.com/dashboard/4';

export const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';

/**
 * 1 minute between tick wake-ups.
 *
 * The tick body is schedule-aware: it only invokes the Playwright
 * scrape when a new 10-min UW slot is expected (i.e., the most
 * recently closed 10-min window has not yet been captured). Outside
 * that "publish window" — and outside the active polling window
 * (09:21-16:14 ET) — the tick is a cheap no-op. See `runTick` in
 * index.ts and `expectedWindowEnd` in dates.ts.
 */
export const MS_PER_TICK = 60 * 1000;

// Re-exported so index.ts can keep its old single-import shape.
export { isInActivePollingWindow } from './dates.js';
