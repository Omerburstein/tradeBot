/**
 * Entry point for the periscope-scraper Railway service.
 *
 * Lifecycle:
 *   1. Initialize Sentry first (so any later boot error is captured).
 *   2. Initialize pino logger.
 *   3. Validate env (importing ./config triggers required-var checks).
 *   4. Run one tick immediately — Railway restarts shouldn't lose a slot.
 *   5. setInterval every MS_PER_TICK (1 min); each tick is a no-op
 *      outside the active polling window OR when the expected slot
 *      has already been captured.
 *   6. SIGTERM handler clears the interval, flushes Sentry, exits 0.
 *
 * Per-minute capture (2026-07 UW redesign):
 *   UW now publishes a Greeks/positions snapshot every MINUTE (the old
 *   10-min slot cadence is gone), and the new periscope API is fetched
 *   directly — no widget driving — so every tick is a FULL scrape
 *   (Greeks + positions + price + Market Tide + Cone) via scrapeAllPanels.
 *   The old 5-min "light" price/tide tick is obsolete: the full tick now
 *   runs every minute and captures price + tide along the way.
 *
 * Schedule-aware dedup:
 *   - The scraper wakes every minute during 09:00-16:14 ET (Mon-Fri).
 *   - `lastFullWindowEnd` tracks the end-time (e.g. "10:07") of the last
 *     1-min snapshot captured. When the current minute's snapshot is
 *     already captured, the tick is a no-op; when UW hasn't published the
 *     current minute yet, the scrape returns the latest published minute
 *     and the tick retries next minute. Resets on leaving the window.
 *
 * Webhook cadence:
 *   The auto-playbook webhook stays at the historical ~10-min cadence:
 *   it fires once per 10-min window (on the first captured snapshot whose
 *   end-time falls in a new window), NOT once per minute — the Vercel
 *   app triggers a Claude run per invocation, so firing 390×/day instead
 *   of ~39×/day would 10× that cost.
 *
 * One-shot test mode: set FORCE_TICK=true to bypass the window gate,
 * run a single tick, and exit. Useful for verifying auth + selectors
 * locally before the next market open without waiting for the
 * schedule. The loop is NOT started in this mode.
 */

import * as Sentry from '@sentry/node';
import pino from 'pino';

// Sentry must initialize from raw process.env BEFORE importing ./config,
// because config.ts calls requireEnv() at module load and throws on
// missing DATABASE_URL / SENTRY_DSN / UW_SESSION_COOKIE. If we imported
// config first those throws would crash the process with no Sentry
// breadcrumb — exactly the boot failure we most want visibility into.
const rawSentryDsn = process.env.SENTRY_DSN;
if (rawSentryDsn != null && rawSentryDsn.trim() !== '') {
  Sentry.init({ dsn: rawSentryDsn, tracesSampleRate: 0 });
}

// Seed the Playwright storageState file from a base64 env var BEFORE
// loading config (which validates UW_AUTH_STATE_PATH). Pattern: encode
// the local ~/.periscope-probe-auth.json with `base64 -i ...` and set
// the result as Railway env var UW_AUTH_STATE_B64; this block decodes
// it to UW_AUTH_STATE_PATH on every container start. Idempotent — if
// the env var is unset (e.g., when running locally), this is a no-op
// and the existing file on disk (if any) is used.
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
      console.log(
        `auth-state seed: wrote ${decoded.length} bytes to ${target}`,
      );
    } catch (err) {
      console.error('auth-state seed failed:', err);
    }
  }
}

// Now safe to load config (and capture its throws via the Sentry above).
const { LOG_LEVEL, MS_PER_TICK, isInActivePollingWindow, APP_ENV, IS_STAGING } =
  await import('./core/config.js');
const { expectedWindowEnd, parseSlotEnd, isPersistableSlot } = await import('./core/dates.js');
const { insertSnapshots, insertSpotPrice, insertPositions } = await import('../db/index.js');
const { scrapeAllPanels, scrapeBackfill, scrapeBackfillRange, scrapeBackfillDates } =
  await import('./scrape/index.js');
const { loadWebhookConfig, postPlaybookWebhook } = await import('./core/webhook.js');

const logger = pino({ level: LOG_LEVEL });

// Webhook config loaded once at boot. When either var is missing, the
// helper short-circuits with `skipped: true` — lets us deploy code first
// and arm the webhook later by setting Railway env vars.
const webhookConfig = loadWebhookConfig();
if (webhookConfig.baseUrl == null || webhookConfig.secret == null) {
  logger.warn(
    {
      hasBaseUrl: webhookConfig.baseUrl != null,
      hasSecret: webhookConfig.secret != null,
    },
    'auto-playbook webhook DISABLED — VERCEL_BASE_URL or PERISCOPE_WEBHOOK_SECRET not set',
  );
} else {
  logger.info(
    { baseUrl: webhookConfig.baseUrl },
    'auto-playbook webhook armed',
  );
}

/** Max time to wait for Sentry to drain queued events during shutdown. */
const SENTRY_FLUSH_TIMEOUT_MS = 2_000;
/** Grace period before force-exiting a one-shot run whose event loop won't drain. */
const HARD_EXIT_FALLBACK_MS = 2_000;

let intervalHandle: NodeJS.Timeout | null = null;
let tickInFlight = false;

// Dedup watermark: the end-time (HH:MM, ET) of the last 1-min snapshot we
// successfully captured (e.g. "10:07"). Resets to null when we leave the
// active polling window so the next trading day starts fresh. Used by
// runTick to short-circuit ticks where the current minute is already
// captured.
let lastFullWindowEnd: string | null = null;

// The 10-min window ("HH:M0") the auto-playbook webhook last fired for.
// The webhook fires once per 10-min window — on the first captured
// snapshot whose end-time lands in a new window — preserving the
// pre-redesign ~39 invocations/day despite the 1-min capture cadence.
let lastWebhookWindow: string | null = null;

// Consecutive scrape-returned-0-rows counter. Fires a single Sentry
// message after 3 in a row to surface UW session-logout / rendering
// outages without spamming. Resets on any non-empty scrape.
let consecutiveEmptyScrapes = 0;
const EMPTY_SCRAPE_ALERT_THRESHOLD = 3;

async function runTick(
  opts: { bypassMarketHours?: boolean } = {},
): Promise<void> {
  if (tickInFlight) {
    logger.warn('previous tick still running, skipping');
    return;
  }

  const now = new Date();
  const bypass = opts.bypassMarketHours === true;
  const inWindow = isInActivePollingWindow(now);

  // Reset dedup state on transitions out of the active window
  // (overnight, weekend, post-close). The next trading day will start
  // with clean watermarks. Bypassed ticks (FORCE_TICK / backfill) don't
  // touch state.
  if (!bypass && !inWindow && (lastFullWindowEnd !== null || lastWebhookWindow !== null)) {
    logger.info(
      { lastFullWindowEnd, lastWebhookWindow },
      'left active polling window — resetting dedup state',
    );
    lastFullWindowEnd = null;
    lastWebhookWindow = null;
  }

  if (!bypass && !inWindow) {
    logger.debug('outside active polling window, skipping tick');
    return;
  }

  // Skip only when the current minute's snapshot is already captured
  // (UW publishes per minute now, so a fresh minute ⇒ scrape). A bypassed
  // tick (FORCE_TICK) always scrapes.
  if (!bypass) {
    const cur1 = expectedWindowEnd(now, 1);
    if (cur1 === null || cur1 === lastFullWindowEnd) {
      logger.debug(
        { cur1, lastFullWindowEnd },
        'current minute already captured — skipping scrape',
      );
      return;
    }
  }

  tickInFlight = true;
  const startedAt = Date.now();
  try {
    await doFullScrape(startedAt);
  } catch (err) {
    Sentry.captureException(err);
    logger.error({ err, ms: Date.now() - startedAt }, 'tick failed');
  } finally {
    tickInFlight = false;
  }
}

/**
 * The 10-min window an ET "HH:MM" slot end falls in, e.g. "10:07" →
 * "10:00". Drives the once-per-window webhook gating. Returns null on
 * unparseable input.
 */
function tenMinWindowOf(hhmm: string): string | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (m == null) return null;
  const floored = Math.floor(Number.parseInt(m[2]!, 10) / 10) * 10;
  return `${m[1]}:${String(floored).padStart(2, '0')}`;
}

/**
 * Full tick: capture Greeks + positions + price + Market Tide + Cone via
 * scrapeAllPanels, persist them, advance `lastFullWindowEnd`, and fire the
 * auto-playbook webhook when the captured snapshot opens a new 10-min
 * window (once per window, not once per minute).
 */
async function doFullScrape(startedAt: number): Promise<void> {
  {
    const scrapeResult = await scrapeAllPanels();
    const rows = scrapeResult.rows;

    if (rows.length === 0) {
      consecutiveEmptyScrapes += 1;
      logger.info(
        {
          ms: Date.now() - startedAt,
          consecutiveEmptyScrapes,
        },
        'tick: scrape returned 0 rows — retry next minute',
      );
      if (consecutiveEmptyScrapes === EMPTY_SCRAPE_ALERT_THRESHOLD) {
        // One-shot Sentry message at the threshold so a UW session
        // logout / rendering outage surfaces without flooding events.
        // Resets on the next non-empty tick.
        Sentry.captureMessage(
          `periscope-scraper: ${EMPTY_SCRAPE_ALERT_THRESHOLD} consecutive empty scrapes — UW session may be logged out`,
          {
            level: 'warning',
            tags: { service: 'periscope-scraper', stage: 'scrape-empty' },
          },
        );
      }
      return;
    }
    consecutiveEmptyScrapes = 0;

    const anchor = rows[0]!;
    const capturedEnd = parseSlotEnd(anchor.timeframe);

    // Ignore non-persisted slots entirely: don't insert, don't advance
    // dedup, don't fire the webhook. This covers premarket, postmarket,
    // AND the opening 09:20-09:30 slot, leaving the DB and the auto-playbook
    // anchored to the last persisted (09:40-16:00 ET) slot. The DB-layer
    // filter (db/snapshots.ts) is the backstop for backfill paths; this guard
    // additionally protects the tick's dedup + webhook side effects, which
    // run off the captured slot before any insert.
    if (!isPersistableSlot(new Date(anchor.capturedAt))) {
      logger.info(
        {
          slot: anchor.timeframe,
          capturedAt: anchor.capturedAt,
          ms: Date.now() - startedAt,
        },
        'tick: slot outside persisted window (premarket/postmarket/open) — skipping insert + webhook',
      );
      return;
    }

    // Dedup: if UW still serves the same latest minute we already
    // captured, it hasn't published a new snapshot yet. Skip DB insert +
    // webhook (would just generate conflicts) and retry next minute.
    // Only short-circuits when we have a previous capture AND the parse
    // succeeded; an unparseable timeframe falls through to the normal
    // insert path so nothing silently drops.
    if (
      lastFullWindowEnd !== null &&
      capturedEnd !== null &&
      capturedEnd === lastFullWindowEnd
    ) {
      logger.info(
        {
          slot: anchor.timeframe,
          ms: Date.now() - startedAt,
        },
        'tick: UW has not rolled to a new slot — retry next minute',
      );
      return;
    }

    const inserted = await insertSnapshots(rows);
    const positionsInserted = await insertPositions(scrapeResult.positionRows);

    // Persist spot price for the algorithm pipeline.
    if (scrapeResult.spot !== null) {
      try {
        await insertSpotPrice(anchor.capturedAt, anchor.expiry, scrapeResult.spot);
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'insertSpotPrice failed — non-blocking',
        );
      }
    }

    logger.info(
      {
        rows: rows.length,
        inserted,
        positionsInserted,
        spot: scrapeResult.spot,
        ms: Date.now() - startedAt,
        slot: anchor.timeframe,
      },
      'tick complete',
    );

    if (capturedEnd !== null) {
      lastFullWindowEnd = capturedEnd;
    } else {
      // Unparseable timeframe (label format changed, leading whitespace,
      // etc.). Without a fallback the dedup-skip never engages. Anchor to
      // the current wall-clock minute so the schedule-aware skip still
      // works; alert Sentry so we notice the format change. The data did
      // insert correctly — the parse is only needed for dedup.
      lastFullWindowEnd = expectedWindowEnd(new Date(), 1);
      Sentry.captureMessage(
        'periscope-scraper: unparseable timeframe label — UW format may have changed',
        {
          level: 'warning',
          tags: { service: 'periscope-scraper', stage: 'parse-timeframe' },
          extra: {
            timeframe: anchor.timeframe,
            fallbackWindowEnd: lastFullWindowEnd,
          },
        },
      );
      logger.warn(
        {
          timeframe: anchor.timeframe,
          fallbackWindowEnd: lastFullWindowEnd,
        },
        'tick: timeframe label unparseable — anchored dedup to wall clock',
      );
    }

    // Auto-playbook webhook (Phase 3 of periscope-auto-playbook spec).
    // Fires once per 10-MIN WINDOW (on the first captured snapshot whose
    // end lands in a new window), not once per 1-min capture — the Vercel
    // app runs Claude per invocation, so per-minute firing would 10× that
    // cost. Failures Sentry-captured but never block the next tick (and
    // don't re-fire within the window, matching the old once-per-slot
    // behavior). Skipped silently when env vars unset.
    const webhookWindow = capturedEnd !== null ? tenMinWindowOf(capturedEnd) : null;
    if (webhookWindow !== null && webhookWindow === lastWebhookWindow) {
      logger.debug(
        { slot: anchor.timeframe, webhookWindow },
        'auto-playbook webhook already fired for this 10-min window — skipping',
      );
      return;
    }
    if (webhookWindow !== null) {
      lastWebhookWindow = webhookWindow;
    }
    const tradingDate = anchor.capturedAt.slice(0, 10);
    const result = await postPlaybookWebhook(
      {
        tradingDate,
        capturedAt: anchor.capturedAt,
        slotKey: anchor.timeframe,
      },
      webhookConfig,
    );
    if (result.skipped) {
      logger.debug(
        { tradingDate, slotKey: anchor.timeframe },
        'auto-playbook webhook skipped (config disabled)',
      );
    } else if (!result.ok) {
      Sentry.captureException(
        new Error(`auto-playbook webhook failed: ${result.error ?? '?'}`),
        {
          tags: {
            service: 'periscope-scraper-webhook',
            status: String(result.status ?? 'null'),
            attempts: String(result.attempts),
          },
          extra: {
            tradingDate,
            capturedAt: anchor.capturedAt,
            slotKey: anchor.timeframe,
          },
        },
      );
      logger.warn(
        {
          tradingDate,
          slotKey: anchor.timeframe,
          status: result.status,
          attempts: result.attempts,
          error: result.error,
        },
        'auto-playbook webhook failed',
      );
    } else {
      logger.info(
        {
          tradingDate,
          slotKey: anchor.timeframe,
          status: result.status,
          attempts: result.attempts,
        },
        'auto-playbook webhook posted',
      );
    }
  }
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutdown requested');
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  try {
    await Sentry.flush(SENTRY_FLUSH_TIMEOUT_MS);
  } catch (err) {
    logger.error({ err }, 'sentry flush failed');
  }
  process.exit(0);
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

/**
 * Exit a one-shot run (FORCE_TICK / backfill) without slamming the event
 * loop. Calling process.exit() immediately after Playwright + libuv
 * teardown can race on Windows — uv_async_send fires on an already-closing
 * handle, crashing with "Assertion failed: !(handle->flags &
 * UV_HANDLE_CLOSING), src\\win\\async.c". Flushing telemetry then letting
 * the loop drain naturally (with an unref'd hard-exit fallback so we still
 * always terminate) sidesteps the race.
 */
async function gracefulExit(code: number): Promise<void> {
  try {
    await Sentry.close(SENTRY_FLUSH_TIMEOUT_MS);
  } catch {
    // never block exit on telemetry teardown
  }
  process.exitCode = code;
  // Safety net: if some handle keeps the loop alive, force-exit shortly.
  setTimeout(() => process.exit(code), HARD_EXIT_FALLBACK_MS).unref();
}

logger.info({ appEnv: APP_ENV, staging: IS_STAGING }, 'periscope-scraper starting');

const forceTick =
  (process.env.FORCE_TICK ?? '').trim().toLowerCase() === 'true';

const backfillDate = (process.env.BACKFILL_DATE ?? '').trim();
// BACKFILL_START/END bound the captured instants (ET HH:MM of captured_at,
// inclusive) since the 2026-07 per-minute API. Defaults cover the persisted
// window: 09:31 (first full post-bell minute) through the 16:00 close.
// (Pre-redesign these were slot-START bounds, defaulting to 09:20/15:50.)
const backfillStart = (process.env.BACKFILL_START ?? '').trim() || '09:31';
const backfillEnd = (process.env.BACKFILL_END ?? '').trim() || '16:00';
const backfillDateStart = (process.env.BACKFILL_DATE_START ?? '').trim();
const backfillDateEnd = (process.env.BACKFILL_DATE_END ?? '').trim();
// Explicit comma/space-separated list of YYYY-MM-DD trading days to backfill.
// Unlike the range path this scrapes ONLY the listed days — used to fill
// sparse coverage gaps without re-scraping days that already have data.
const backfillDates = (process.env.BACKFILL_DATES ?? '')
  .split(/[\s,]+/)
  .map((d) => d.trim())
  .filter((d) => d !== '');

if (backfillDates.length > 0) {
  logger.info(
    { count: backfillDates.length, first: backfillDates[0], last: backfillDates[backfillDates.length - 1], backfillStart, backfillEnd },
    'BACKFILL_DATES set — backfilling an explicit list of days then exiting',
  );
  // Default ON for the explicit-list path: it's the retry path for days that
  // failed a shared-session range pass. A fresh browser context per day starts
  // at Expiry="All" and avoids the localStorage expiry-pin that strands the
  // dropdown on the wrong frame. Set BACKFILL_FRESH_CONTEXT=false to disable.
  const freshContextEachDay =
    (process.env.BACKFILL_FRESH_CONTEXT ?? 'true').trim().toLowerCase() !== 'false';
  const startedAt = Date.now();
  try {
    const summary = await scrapeBackfillDates(
      backfillDates,
      backfillStart,
      backfillEnd,
      { freshContextEachDay },
    );
    logger.info(
      { ...summary, totalMs: Date.now() - startedAt },
      'backfill dates complete',
    );
  } catch (err) {
    Sentry.captureException(err);
    logger.error(
      { err, ms: Date.now() - startedAt },
      'backfill dates failed at top level',
    );
  }
  await gracefulExit(0);
} else if (backfillDateStart !== '' && backfillDateEnd !== '') {
  logger.info(
    {
      backfillDateStart,
      backfillDateEnd,
      backfillStart,
      backfillEnd,
    },
    'BACKFILL_DATE_START + BACKFILL_DATE_END set — running multi-day range backfill',
  );
  const startedAt = Date.now();
  try {
    const summary = await scrapeBackfillRange(
      backfillDateStart,
      backfillDateEnd,
      backfillStart,
      backfillEnd,
    );
    logger.info(
      { ...summary, totalMs: Date.now() - startedAt },
      'backfill range complete',
    );
  } catch (err) {
    Sentry.captureException(err);
    logger.error(
      { err, ms: Date.now() - startedAt },
      'backfill range failed at top level',
    );
  }
  await gracefulExit(0);
} else if (backfillDate !== '') {
  logger.info(
    { backfillDate, backfillStart, backfillEnd },
    'BACKFILL_DATE set — running historical backfill then exiting',
  );
  const startedAt = Date.now();
  try {
    // scrapeBackfill now scrapes AND persists everything for the day
    // (snapshots, spot, Market Tide, Cone) and returns a summary.
    const summary = await scrapeBackfill(backfillDate, backfillStart, backfillEnd);
    logger.info(
      { ...summary, ms: Date.now() - startedAt },
      'backfill complete',
    );
  } catch (err) {
    Sentry.captureException(err);
    logger.error({ err, ms: Date.now() - startedAt }, 'backfill failed');
  }
  await gracefulExit(0);
} else if (forceTick) {
  logger.info(
    'FORCE_TICK=true — running one tick (RTH gate bypassed) then exiting',
  );
  await runTick({ bypassMarketHours: true });
  await gracefulExit(0);
} else {
  // Fire one tick immediately so a Railway restart mid-session resumes promptly.
  await runTick();

  intervalHandle = setInterval(() => {
    void runTick();
  }, MS_PER_TICK);
}
