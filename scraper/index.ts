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
 * Two-cadence capture:
 *   UW refreshes the Greeks (Gamma/Charm/Vanna) and positions only every
 *   10 min, but the SPX price and Market Tide every 5 min. So each tick
 *   does as little work as the clock allows:
 *     - On a 10-min boundary → FULL scrape (Greeks + positions + price +
 *       Market Tide + Cone) via scrapeAllPanels.
 *     - On a 5-min-but-not-10-min boundary → LIGHT scrape (price + Market
 *       Tide only) via scrapeMarketTideAndPrice — skips the expensive,
 *       anti-bot-sensitive navigation the full scrape does.
 *   e.g. 10:00 → full, 10:05 → light, 10:10 → full, 10:15 → light, …
 *
 * Schedule-aware dedup (two independent watermarks):
 *   - The scraper wakes every minute during 09:21-16:14 ET (Mon-Fri).
 *   - `lastFullWindowEnd` tracks the end-time (e.g. "10:10") of the last
 *     10-min Greeks slot captured; `lastTideWindowEnd` tracks the last
 *     5-min price/Market-Tide slot captured.
 *   - Each tick first ensures the most recently CLOSED 10-min window is
 *     captured (full scrape); otherwise it ensures the most recently
 *     CLOSED 5-min window is captured (light scrape); otherwise no-op.
 *   - When UW hasn't rolled to the expected slot yet, the tick logs +
 *     retries next minute. Both watermarks reset on leaving the window.
 *
 * This pattern absorbs UW's 1-3 min publication lag without polling
 * blindly, and ensures the first analyzable slot ("09:20 - 09:30")
 * and the debrief slot ("15:50 - 16:00") are captured as soon as UW
 * publishes them, rather than later on the next boundary.
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
const { scrapeAllPanels, scrapeMarketTideAndPrice, scrapeBackfill, scrapeBackfillRange, scrapeBackfillDates } =
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

let intervalHandle: NodeJS.Timeout | null = null;
let tickInFlight = false;

// Dedup watermarks: the end-time (HH:MM) of the last slot we successfully
// captured on each cadence. `lastFullWindowEnd` is the 10-min Greeks slot
// (e.g. "10:10"); `lastTideWindowEnd` is the 5-min price/Market-Tide slot
// (e.g. "10:05"). Both reset to null when we leave the active polling
// window so the next trading day starts fresh. Used by runTick to
// short-circuit ticks where the expected window has already been captured.
let lastFullWindowEnd: string | null = null;
let lastTideWindowEnd: string | null = null;

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
  if (!bypass && !inWindow && (lastFullWindowEnd !== null || lastTideWindowEnd !== null)) {
    logger.info(
      { lastFullWindowEnd, lastTideWindowEnd },
      'left active polling window — resetting dedup state',
    );
    lastFullWindowEnd = null;
    lastTideWindowEnd = null;
  }

  if (!bypass && !inWindow) {
    logger.debug('outside active polling window, skipping tick');
    return;
  }

  // Decide what (if anything) this tick needs to scrape. A bypassed tick
  // (FORCE_TICK) always runs the full scrape so it exercises every selector.
  // Otherwise: ensure the most recently CLOSED 10-min Greeks window is
  // captured first (full scrape); else ensure the most recently CLOSED
  // 5-min price/Market-Tide window is captured (light scrape); else no-op.
  let action: 'full' | 'light' | 'skip';
  const cur5 = expectedWindowEnd(now, 5);
  if (bypass) {
    action = 'full';
  } else {
    const cur10 = expectedWindowEnd(now, 10);
    if (cur10 != null && cur10 !== lastFullWindowEnd) {
      action = 'full';
    } else if (
      cur5 != null &&
      cur5 !== lastTideWindowEnd &&
      cur5 !== lastFullWindowEnd
    ) {
      action = 'light';
    } else {
      action = 'skip';
    }
    if (action === 'skip') {
      logger.debug(
        { cur10, cur5, lastFullWindowEnd, lastTideWindowEnd },
        'expected windows already captured — skipping scrape',
      );
      return;
    }
  }

  tickInFlight = true;
  const startedAt = Date.now();
  try {
    if (action === 'light') {
      await doLightScrape(startedAt);
    } else {
      await doFullScrape(startedAt);
    }
  } catch (err) {
    Sentry.captureException(err);
    logger.error({ err, ms: Date.now() - startedAt }, 'tick failed');
  } finally {
    tickInFlight = false;
  }
}

/**
 * Light tick: capture only the SPX price + Market Tide (5-min cadence) and
 * advance `lastTideWindowEnd`. No Greeks/positions, no webhook. Spot is
 * inserted at the same instant as the latest Market Tide slot so the two
 * series stay aligned.
 */
async function doLightScrape(startedAt: number): Promise<void> {
  const result = await scrapeMarketTideAndPrice();

  // Persist spot at the tide slot's instant (Market Tide itself is stored
  // inside the scrape). Non-blocking — a spot failure must not stall dedup.
  if (result.spot !== null && result.tideCapturedAt !== null) {
    try {
      await insertSpotPrice(result.tideCapturedAt, result.date, result.spot);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'insertSpotPrice failed (light tick) — non-blocking',
      );
    }
  }

  // Advance the 5-min watermark to the slot we actually captured. When UW
  // hasn't published the expected 5-min point yet, tideSlotEnd lags the
  // boundary and the next minute retries.
  if (result.tideSlotEnd !== null) {
    lastTideWindowEnd = result.tideSlotEnd;
  }

  logger.info(
    {
      spot: result.spot,
      tideSlotEnd: result.tideSlotEnd,
      tideInserted: result.tideInserted,
      ms: Date.now() - startedAt,
    },
    'light tick complete',
  );
}

/**
 * Full tick: capture Greeks + positions + price + Market Tide + Cone via
 * scrapeAllPanels, persist them, advance `lastFullWindowEnd`, and fire the
 * auto-playbook webhook on a genuinely new 10-min slot.
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

    // Dedup: if UW's "Latest" panel still shows the same slot we
    // already captured, UW hasn't rolled to the next window yet. Skip
    // DB insert + webhook (would just generate 422s) and retry next
    // minute. Only short-circuits when we have a previous capture AND
    // the parse succeeded; an unparseable timeframe falls through to
    // the normal insert path so nothing silently drops.
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
      // Unparseable timeframe (UW renamed the label, leading whitespace
      // changed, etc.). Without a fallback the dedup-skip never engages
      // and the scraper does a full Playwright run every minute for the
      // rest of the day. Anchor to wall-clock so the schedule-aware skip
      // still works; alert Sentry so we notice the format change. The
      // data did insert correctly — the parse is only needed for dedup.
      lastFullWindowEnd = expectedWindowEnd(new Date());
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
    // Fires once per new-slot capture. Failures Sentry-captured but
    // never block the next tick. Skipped silently when env vars unset.
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
    await Sentry.flush(2000);
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
    await Sentry.close(2000);
  } catch {
    // never block exit on telemetry teardown
  }
  process.exitCode = code;
  // Safety net: if some handle keeps the loop alive, force-exit shortly.
  setTimeout(() => process.exit(code), 2_000).unref();
}

logger.info({ appEnv: APP_ENV, staging: IS_STAGING }, 'periscope-scraper starting');

const forceTick =
  (process.env.FORCE_TICK ?? '').trim().toLowerCase() === 'true';

const backfillDate = (process.env.BACKFILL_DATE ?? '').trim();
const backfillStart = (process.env.BACKFILL_START ?? '').trim() || '09:20';
const backfillEnd = (process.env.BACKFILL_END ?? '').trim() || '15:50';
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
  const startedAt = Date.now();
  try {
    const summary = await scrapeBackfillDates(
      backfillDates,
      backfillStart,
      backfillEnd,
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
