/**
 * Multi-day orchestration — the shared per-day scraper (`scrapeAndStoreDay`)
 * plus the three entry points that drive it: single-date backfill, a fixed
 * date-range backfill, and the descending walk-back that discovers UW's
 * history floor. Scrape + insert behavior for a whole day lives here in
 * one place. (The `discoverEndpoints` dev helper lives in discovery.ts.)
 */
import { type Page } from 'playwright';
import { BACKFILL_STEP_MIN, UW_PERISCOPE_URL } from '../core/config.js';
import {
  insertSnapshots,
  insertPositions,
} from '../../db/index.js';
import { logger } from '../core/logger.js';
import type { SnapshotRow, PositionRow } from '../core/types.js';
import { withBrowser } from './browser.js';
import { attachApiCaptures } from './captures.js';
import { waitForChartReady } from './chart.js';
import { normalizeHhmm } from './timeframe.js';
import {
  exposuresToRows,
  positionsToRows,
  utcToETHhmm,
  type SpotRow,
} from './api-transforms.js';
import {
  fetchPeriscopeTimestamps,
  fetchPeriscopeSlot,
  storeMarketTide,
  storeSpot,
  storeCone,
  captureTideForDate,
  fetchSpotCandles5m,
  captureStraddleForDate,
  resolveStraddleTemplate,
} from './api-helpers.js';
import {
  latestTradingDay,
  nextTradingDay,
  prevTradingDay,
  tradingDaysBetween,
} from './trading-calendar.js';
import type { ApiCaptures } from './api-types.js';

/** Outcome of scraping + persisting one trading day. */
interface DayStoreSummary {
  /** Greek snapshot rows parsed (0 ⇒ likely past history floor). */
  rowsParsed: number;
  snapshotsInserted: number;
  positionsInserted: number;
  spotsInserted: number;
  tidePointsInserted: number;
  /** A new cone row was written. */
  coneInserted: boolean;
  /** Cone skipped because a snapshot already existed for this date. */
  coneSkipped: boolean;
  slotsScanned: number;
}

/**
 * Scrape one trading day AND persist everything for it: list the day's
 * published snapshot minutes (periscope/timestamps), fetch each selected
 * minute's Greeks + positions directly from the periscope API for both the
 * session expiry (0DTE) and the next trading day (1DTE), then store the
 * 5-min spot series, Market Tide (5-min) and the Cone param (straddle,
 * once/day — skipped if already in the DB).
 *
 * `startNorm`..`endNorm` bound the captured instants (ET HH:MM, inclusive)
 * and BACKFILL_STEP_MIN (default 10) selects every Nth minute — 10 keeps
 * the historical 10-min cadence/volume; 1 backfills full minute resolution.
 *
 * This is THE shared per-day scraper: scrapeBackfill (single date),
 * scrapeBackfillRange (fixed list), and scrapeWalkBack (descending walk)
 * all route through it, so scrape + insert behavior lives in one place.
 *
 * A Greeks fetch failure (or a date past UW's history floor, where the
 * timestamps list comes back empty) is NON-FATAL: it's logged and the day
 * still persists its per-date Market Tide / spot / Cone, returning
 * rowsParsed=0. Callers treat rowsParsed=0 as "empty" (the walk-back stop
 * condition still works) while the API-sourced datasets are saved regardless.
 */
async function scrapeAndStoreDay(
  page: Page,
  date: string,
  startNorm: string,
  endNorm: string,
  caps: ApiCaptures,
  tideUrlTemplate: string | undefined,
  straddleUrlTemplate: string | undefined,
  intradaySpotByDate: Map<string, SpotRow[]>,
): Promise<DayStoreSummary> {
  // Drop any responses left over from the previous day so the `?? last`
  // fallbacks below can't read stale data for this date.
  caps.exposures.length = 0;
  caps.positions.length = 0;
  caps.straddle.length = 0;
  caps.tide.length = 0;
  caps.ticks.length = 0;
  // caps.candles and caps.timestamps are NOT cleared — candles fire once on
  // page load and cover all dates; timestamps responses are keyed by their
  // URL's date param so stale entries can never match another day.

  // Fetch THIS day's ATM straddle (Cone param) too — same reason: the
  // straddle endpoint only auto-fires for today on load, so without this the
  // cone would be skipped (no straddle for the date) or built from today's
  // straddle. Non-blocking.
  await captureStraddleForDate(page, caps, date, straddleUrlTemplate);
  // Market Tide is a direct per-date net-flow-ticks fetch too — capture it
  // here, BEFORE any chart navigation, so it still persists even if the Greeks
  // navigation below fails for this date. (storeMarketTide will skip it anyway
  // when the endpoint serves the latest session instead of this past day.)
  await captureTideForDate(page, caps, date, tideUrlTemplate);

  const dayRows: SnapshotRow[] = [];
  const dayPositions: PositionRow[] = [];
  let slotsScanned = 0;

  // ── Greeks + positions (direct periscope API fetches per instant) ──
  // The 2026-07 endpoints key snapshots by (timestamp, expiries) query
  // params, so a backfill day needs NO chart navigation: list the day's
  // published minutes, filter to [startNorm..endNorm] at BACKFILL_STEP_MIN
  // granularity, and fetch each snapshot pair for the session expiry (0DTE)
  // and the next trading day (1DTE). Any failure is NON-FATAL: the per-date
  // Market Tide / spot / Cone (captured above + stored below) don't depend
  // on the Greeks, so we log, skip, and still persist those datasets.
  const stepMin = BACKFILL_STEP_MIN;
  try {
    const stamps = await fetchPeriscopeTimestamps(page, caps, date);

    // Select the instants to capture: within the requested ET window and on
    // the step grid (e.g. step 10 → :00/:10/:20/… boundaries only).
    const slots: Array<{ iso: string; ms: number }> = [];
    for (const s of stamps) {
      const ms = Date.parse(s);
      if (!Number.isFinite(ms)) continue;
      const hhmm = utcToETHhmm(s);
      if (hhmm < startNorm || hhmm > endNorm) continue;
      const totalMin =
        Number.parseInt(hhmm.slice(0, 2), 10) * 60 + Number.parseInt(hhmm.slice(3), 10);
      if (totalMin % stepMin !== 0) continue;
      slots.push({ iso: new Date(ms).toISOString(), ms });
    }
    logger.info(
      { date, stepMin, publishedMinutes: stamps.length, slotsSelected: slots.length },
      'scrapeAndStoreDay: slot instants resolved',
    );

    const nextExpiry = nextTradingDay(date);
    for (const slot of slots) {
      for (const expiry of [date, nextExpiry]) {
        const { exposures, positions } = await fetchPeriscopeSlot(page, caps, {
          timestampMs: slot.ms,
          expiry,
        });
        if (exposures) {
          const parsed = exposuresToRows(exposures, slot.iso, expiry);
          dayRows.push(...parsed.rows);
          if (positions) {
            dayPositions.push(
              ...positionsToRows(positions, slot.iso, parsed.qualifyingStrikes, expiry),
            );
          }
        }
        await page.waitForTimeout(200); // pacing between API fetches // anti-bot
      }
      slotsScanned += 1;
    }
  } catch (err) {
    logger.warn(
      { date, err: err instanceof Error ? err.message : String(err) },
      'scrapeAndStoreDay: Greeks scrape failed — storing Market Tide/spot/Cone only',
    );
  }

  // ── Persist Greeks + positions (empty when the Greeks scrape was skipped) ──
  const snapshotsInserted = await insertSnapshots(dayRows);
  const positionsInserted = await insertPositions(dayPositions);

  // ── Spot: real 5-min index_candles for recent days (within the ~30-day 5m
  // window), else a single daily close for older days. See storeSpot — UW has
  // no historical intraday price source beyond that window.
  const spotsInserted = await storeSpot(caps, date, intradaySpotByDate);

  // ── Market Tide: the per-date net-flow-ticks captured above (5-min slots).
  // Skipped for past days the endpoint can't serve (latest-session only).
  const tidePointsInserted = await storeMarketTide(caps, date);

  // ── Cone (once/day): skip entirely if already stored for this date ──
  const { inserted: coneInserted, skipped: coneSkipped } = await storeCone(caps, date);

  return {
    rowsParsed: dayRows.length,
    snapshotsInserted,
    positionsInserted,
    spotsInserted,
    tidePointsInserted,
    coneInserted,
    coneSkipped,
    slotsScanned,
  };
}

/** Request templates + intraday spot map every scrapeAndStoreDay call needs. */
interface DayRunContext {
  /** net-flow-ticks URL observed on load; its date param is swapped per day. */
  tideUrlTemplate: string | undefined;
  /** bsoc/SPX/straddle URL template (observed or synthesized from the tide origin). */
  straddleUrlTemplate: string | undefined;
  /** ~30 trading days of 5-min spot rows, keyed by ET date. */
  intradaySpotByDate: Map<string, SpotRow[]>;
}

/**
 * Shared per-run prep for every multi-day path: load dashboard/4, wait for
 * the Exposures window, then resolve the per-date request templates the
 * day scraper needs. The tide/straddle endpoints fire only for TODAY on
 * page load and don't refetch on navigation, so their URLs are captured
 * once here and re-dated per day; the 5-min spot candles span the whole
 * recent window, so they're fetched once per run. One place so the three
 * backfill entry points can't drift.
 */
async function openDashboardAndResolveContext(
  page: Page,
  caps: ApiCaptures,
): Promise<DayRunContext> {
  logger.info({ url: UW_PERISCOPE_URL }, 'navigating to periscope');
  await page.goto(UW_PERISCOPE_URL, { waitUntil: 'networkidle' });
  await waitForChartReady(page);
  // Settle for the trailing on-load XHRs (tide, straddle, candles). // anti-bot
  await page.waitForTimeout(1_500);
  const tideUrlTemplate = caps.tide[caps.tide.length - 1]?.url;
  const straddleUrlTemplate = resolveStraddleTemplate(caps, tideUrlTemplate);
  const intradaySpotByDate = await fetchSpotCandles5m(
    page,
    caps.candles[caps.candles.length - 1]?.url ?? tideUrlTemplate,
  );
  return { tideUrlTemplate, straddleUrlTemplate, intradaySpotByDate };
}

/**
 * Backfill mode: scrape + persist a single historical date. A thin
 * wrapper around the shared `scrapeAndStoreDay` (the same per-day scraper
 * used by the range + walk-back paths) so single-date runs capture and
 * store Greeks, spot, Market Tide, and the Cone identically.
 *
 * The captured_at on each row is computed from the slot's END time
 * (e.g. a "09:20 - 09:30" ET slot stamps captured_at=09:30 ET) so a
 * backfilled day reproduces the live cron's row stamping.
 */
export async function scrapeBackfill(
  targetDate: string,
  startHhmm: string,
  endHhmm: string,
): Promise<DayStoreSummary> {
  const startNorm = normalizeHhmm(startHhmm);
  const endNorm = normalizeHhmm(endHhmm);

  return await withBrowser(async (_browser, page) => {
    const caps = attachApiCaptures(page);

    logger.info(
      { targetDate, startHhmm: startNorm, endHhmm: endNorm },
      'backfill: starting',
    );
    const ctx = await openDashboardAndResolveContext(page, caps);

    const summary = await scrapeAndStoreDay(
      page,
      targetDate,
      startNorm,
      endNorm,
      caps,
      ctx.tideUrlTemplate,
      ctx.straddleUrlTemplate,
      ctx.intradaySpotByDate,
    );

    logger.info({ targetDate, ...summary }, 'backfill: complete');
    return summary;
  });
}

/**
 * Scrape every trading day in [startDate, endDate], skipping weekends
 * and US-market holidays. Inserts rows per-day so progress is durable
 * — a process kill mid-loop leaves prior days in the DB intact.
 *
 * Returns a summary; rows are NOT returned (they're already inserted).
 * Errors on any single day log + continue to the next day.
 */
export async function scrapeBackfillRange(
  startDate: string,
  endDate: string,
  startHhmm: string,
  endHhmm: string,
): Promise<{
  totalRowsInserted: number;
  daysScanned: number;
  daysFailed: string[];
  totalDays: number;
}> {
  const dates = tradingDaysBetween(startDate, endDate);
  logger.info(
    { startDate, endDate, totalDays: dates.length },
    'backfill range: resolved trading days',
  );
  return await scrapeBackfillDates(dates, startHhmm, endHhmm);
}

/**
 * Scrape an explicit list of trading days (already weekend/holiday-filtered
 * by the caller). Same per-day path, browser lifecycle, and durable per-day
 * inserts as the range backfill — `scrapeBackfillRange` is a thin wrapper
 * that resolves a [start, end] range to a list and delegates here. Use this
 * directly to backfill a sparse set of dates (e.g. only the gaps) without
 * re-scraping days that already have data.
 *
 * `opts.freshContextEachDay` scrapes each date in its OWN browser context
 * (delegating to `scrapeBackfill`) instead of sharing one session. A shared
 * session pins the Single-mode Expiry selection in page localStorage, which
 * survives a page reload; once pinned to date D, `walkDateToTarget` to an
 * earlier date can't get that date listed in the (now D-anchored) Expiry
 * dropdown, so it fails (the alternating success/failure pattern across a
 * long run). A fresh context starts at Expiry="All" — the proven-reliable
 * single-date path. Costs one browser launch (~10s) per day; use it to
 * retry days that failed a shared-session pass.
 */
export async function scrapeBackfillDates(
  dates: string[],
  startHhmm: string,
  endHhmm: string,
  opts: { freshContextEachDay?: boolean } = {},
): Promise<{
  totalRowsInserted: number;
  daysScanned: number;
  daysFailed: string[];
  totalDays: number;
}> {
  const startNorm = normalizeHhmm(startHhmm);
  const endNorm = normalizeHhmm(endHhmm);

  if (opts.freshContextEachDay) {
    let totalRowsInserted = 0;
    let daysScanned = 0;
    const daysFailed: string[] = [];
    logger.info(
      { totalDays: dates.length, startHhmm: startNorm, endHhmm: endNorm },
      'backfill dates: starting (fresh context per day)',
    );
    for (const [idx, date] of dates.entries()) {
      const dayStarted = Date.now();
      const progress = `${idx + 1}/${dates.length}`;
      logger.info({ date, progress }, 'backfill dates: starting day');
      try {
        // scrapeBackfill owns its own browser context → clean Expiry="All".
        const summary = await scrapeBackfill(date, startNorm, endNorm);
        totalRowsInserted += summary.snapshotsInserted;
        daysScanned += 1;
        logger.info(
          { date, progress, ...summary, totalRowsInserted, ms: Date.now() - dayStarted },
          'backfill dates: day complete',
        );
      } catch (err) {
        daysFailed.push(date);
        logger.error(
          { date, progress, err: err instanceof Error ? err.message : String(err), ms: Date.now() - dayStarted },
          'backfill dates: day failed — continuing to next',
        );
      }
    }
    logger.info(
      { totalRowsInserted, daysScanned, daysFailed, totalDays: dates.length },
      'backfill dates: complete',
    );
    return { totalRowsInserted, daysScanned, daysFailed, totalDays: dates.length };
  }

  return await withBrowser(async (_browser, page) => {
    const caps = attachApiCaptures(page);

    logger.info(
      {
        totalDays: dates.length,
        startHhmm: startNorm,
        endHhmm: endNorm,
      },
      'backfill range: starting',
    );
    if (dates.length === 0) {
      logger.warn({}, 'backfill range: no trading days to scrape');
      return {
        totalRowsInserted: 0,
        daysScanned: 0,
        daysFailed: [],
        totalDays: 0,
      };
    }

    const ctx = await openDashboardAndResolveContext(page, caps);

    let totalRowsInserted = 0;
    let daysScanned = 0;
    const daysFailed: string[] = [];

    for (const [idx, date] of dates.entries()) {
      const dayStarted = Date.now();
      const progress = `${idx + 1}/${dates.length}`;
      logger.info({ date, progress }, 'backfill range: starting day');

      try {
        const summary = await scrapeAndStoreDay(
          page,
          date,
          startNorm,
          endNorm,
          caps,
          ctx.tideUrlTemplate,
          ctx.straddleUrlTemplate,
          ctx.intradaySpotByDate,
        );
        totalRowsInserted += summary.snapshotsInserted;
        daysScanned += 1;

        logger.info(
          {
            date,
            progress,
            ...summary,
            totalRowsInserted,
            daysFailed: daysFailed.length,
            ms: Date.now() - dayStarted,
          },
          'backfill range: day complete',
        );
      } catch (err) {
        daysFailed.push(date);
        logger.error(
          {
            date,
            progress,
            err: err instanceof Error ? err.message : String(err),
            ms: Date.now() - dayStarted,
          },
          'backfill range: day failed — continuing to next',
        );
        // Try to escape any stuck modal/popover state before next day.
        await page.keyboard.press('Escape').catch(() => undefined);
        await page.keyboard.press('Escape').catch(() => undefined);
      }
    }

    logger.info(
      { totalRowsInserted, daysScanned, daysFailed, totalDays: dates.length },
      'backfill range: complete',
    );
    return {
      totalRowsInserted,
      daysScanned,
      daysFailed,
      totalDays: dates.length,
    };
  });
}

/**
 * Read-all mode: start at the latest trading day and walk BACKWARDS one
 * trading session at a time, scraping + inserting each day, until UW
 * runs out of history. Unlike scrapeBackfillRange there is no fixed
 * start date — the script discovers the history floor itself, so it
 * keeps working as UW's available range slides.
 *
 * Stop condition: `maxConsecutiveEmpty` consecutive days that either
 * produced 0 rows or failed to scrape (e.g. the date is no longer in
 * the Single-mode Expiry dropdown). A single transient glitch won't
 * stop the walk — the counter resets on the next non-empty day — but a
 * genuine end-of-history (or repeated failure) terminates cleanly.
 *
 * Rows are inserted per-day (idempotent via ON CONFLICT DO NOTHING), so
 * a kill mid-walk leaves all prior days durably in the DB and a re-run
 * just re-confirms them. An optional `floorDate` is a hard lower bound
 * (inclusive) for safety / partial runs.
 */
export async function scrapeWalkBack(opts: {
  startHhmm: string;
  endHhmm: string;
  maxConsecutiveEmpty?: number;
  floorDate?: string;
}): Promise<{
  totalRowsInserted: number;
  daysScanned: number;
  daysWithData: number;
  daysEmpty: string[];
  daysFailed: string[];
  oldestDateWithData: string | null;
  newestDateScanned: string | null;
}> {
  const startNorm = normalizeHhmm(opts.startHhmm);
  const endNorm = normalizeHhmm(opts.endHhmm);
  const maxEmpty = opts.maxConsecutiveEmpty ?? 3;

  return await withBrowser(async (_browser, page) => {
    const caps = attachApiCaptures(page);

    const firstDate = latestTradingDay();
    logger.info(
      { firstDate, startHhmm: startNorm, endHhmm: endNorm, maxEmpty, floorDate: opts.floorDate ?? null },
      'walk-back: starting from latest trading day',
    );

    const ctx = await openDashboardAndResolveContext(page, caps);

    let date: string = firstDate;
    let consecutiveEmpty = 0;
    let totalRowsInserted = 0;
    let daysScanned = 0;
    let daysWithData = 0;
    const daysEmpty: string[] = [];
    const daysFailed: string[] = [];
    let oldestDateWithData: string | null = null;
    let stopReason = 'unknown';

    while (true) {
      if (opts.floorDate != null && date < opts.floorDate) {
        stopReason = `reached floorDate ${opts.floorDate}`;
        break;
      }

      const dayStarted = Date.now();
      logger.info({ date, consecutiveEmpty }, 'walk-back: starting day');

      try {
        const summary = await scrapeAndStoreDay(
          page,
          date,
          startNorm,
          endNorm,
          caps,
          ctx.tideUrlTemplate,
          ctx.straddleUrlTemplate,
          ctx.intradaySpotByDate,
        );
        totalRowsInserted += summary.snapshotsInserted;
        daysScanned += 1;

        if (summary.rowsParsed === 0) {
          consecutiveEmpty += 1;
          daysEmpty.push(date);
          logger.info(
            { date, ...summary, consecutiveEmpty, ms: Date.now() - dayStarted },
            'walk-back: day returned 0 rows (likely past history floor)',
          );
        } else {
          consecutiveEmpty = 0;
          daysWithData += 1;
          oldestDateWithData = date; // walking backwards → each success is older
          logger.info(
            {
              date,
              ...summary,
              totalRowsInserted,
              ms: Date.now() - dayStarted,
            },
            'walk-back: day complete',
          );
        }
      } catch (err) {
        consecutiveEmpty += 1;
        daysFailed.push(date);
        logger.error(
          {
            date,
            consecutiveEmpty,
            err: err instanceof Error ? err.message : String(err),
            ms: Date.now() - dayStarted,
          },
          'walk-back: day failed — counting toward stop threshold',
        );
        // Escape any stuck modal/popover state before the next day.
        await page.keyboard.press('Escape').catch(() => undefined);
        await page.keyboard.press('Escape').catch(() => undefined);
      }

      if (consecutiveEmpty >= maxEmpty) {
        stopReason = `${consecutiveEmpty} consecutive empty/failed days — history floor reached`;
        break;
      }

      date = prevTradingDay(date);
    }

    logger.info(
      {
        stopReason,
        totalRowsInserted,
        daysScanned,
        daysWithData,
        daysEmpty: daysEmpty.length,
        daysFailed,
        oldestDateWithData,
        newestDateScanned: firstDate,
      },
      'walk-back: complete',
    );

    return {
      totalRowsInserted,
      daysScanned,
      daysWithData,
      daysEmpty,
      daysFailed,
      oldestDateWithData,
      newestDateScanned: firstDate,
    };
  });
}

