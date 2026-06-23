/**
 * read-all entry point — pull ALL available history from UW Periscope.
 *
 * Distinct from the `start` (continuous polling loop) and `tick`
 * (FORCE_TICK one-shot) entry points: this script starts at the latest
 * trading day and walks BACKWARDS one session at a time, scraping +
 * inserting each day, until UW runs out of history (N consecutive
 * empty/failed days). There is no fixed start date — the history floor
 * is discovered at runtime, so it keeps working as UW's available range
 * slides (today the oldest available date is ~2025-12-22, but that moves).
 *
 * Run:
 *   npm run read-all
 *
 * Optional env overrides (defaults match the live cron's analyzable
 * window and a glitch-tolerant stop):
 *   READ_ALL_START      slot-start HH:MM ET (default 09:20)
 *   READ_ALL_END        slot-start HH:MM ET (default 15:50)
 *   READ_ALL_MAX_EMPTY  stop after N consecutive empty/failed days (default 3)
 *   READ_ALL_FLOOR      hard lower-bound date YYYY-MM-DD (optional safety stop)
 *
 * Inserts are per-day and idempotent (ON CONFLICT DO NOTHING), so a kill
 * mid-walk leaves prior days durably in the DB and a re-run just
 * re-confirms them — safe to stop and resume.
 */

import * as Sentry from '@sentry/node';
import pino from 'pino';

// Sentry must initialize from raw process.env BEFORE importing ./config
// (which throws on missing required vars at module load), so a boot
// failure is captured rather than crashing silently. Same pattern as
// index.ts.
const rawSentryDsn = process.env.SENTRY_DSN;
if (rawSentryDsn != null && rawSentryDsn.trim() !== '') {
  Sentry.init({ dsn: rawSentryDsn, tracesSampleRate: 0 });
}

// Seed the Playwright storageState file from a base64 env var BEFORE
// loading config (which validates UW_AUTH_STATE_PATH). No-op locally
// when UW_AUTH_STATE_B64 is unset — the existing file on disk is used.
{
  const b64 = (process.env.UW_AUTH_STATE_B64 ?? '').trim();
  if (b64 !== '') {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    const target = process.env.UW_AUTH_STATE_PATH ?? '/data/uw-auth-state.json';
    try {
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, decoded, { mode: 0o600 });
      console.log(`auth-state seed: wrote ${decoded.length} bytes to ${target}`);
    } catch (err) {
      console.error('auth-state seed failed:', err);
    }
  }
}

const { LOG_LEVEL } = await import('../core/config.js');
const { scrapeWalkBack } = await import('../scrape/index.js');

const logger = pino({ level: LOG_LEVEL });

const startHhmm = (process.env.READ_ALL_START ?? '').trim() || '09:20';
const endHhmm = (process.env.READ_ALL_END ?? '').trim() || '15:50';
const maxEmptyRaw = (process.env.READ_ALL_MAX_EMPTY ?? '').trim();
const maxConsecutiveEmpty =
  maxEmptyRaw !== '' && Number.isFinite(Number(maxEmptyRaw))
    ? Number(maxEmptyRaw)
    : 3;
const floorDate = (process.env.READ_ALL_FLOOR ?? '').trim() || undefined;

logger.info(
  { startHhmm, endHhmm, maxConsecutiveEmpty, floorDate: floorDate ?? null },
  'read-all: starting walk-back from latest trading day',
);

const startedAt = Date.now();
try {
  const summary = await scrapeWalkBack({
    startHhmm,
    endHhmm,
    maxConsecutiveEmpty,
    floorDate,
  });
  logger.info(
    { ...summary, totalMs: Date.now() - startedAt },
    'read-all: complete',
  );
} catch (err) {
  Sentry.captureException(err);
  logger.error(
    { err, ms: Date.now() - startedAt },
    'read-all: failed at top level',
  );
}

await Sentry.flush(2000);
process.exit(0);
