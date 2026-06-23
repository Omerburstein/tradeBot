/**
 * Multi-day orchestration — the shared per-day scraper (`scrapeAndStoreDay`)
 * plus the three entry points that drive it: single-date backfill, a fixed
 * date-range backfill, and the descending walk-back that discovers UW's
 * history floor. Also the `discoverEndpoints` dev helper that dumps raw
 * JSON XHRs for new-panel reverse-engineering. Scrape + insert behavior
 * for a whole day lives here in one place.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type Page } from 'playwright';
import { UW_PERISCOPE_URL } from '../core/config.js';
import {
  insertSnapshots,
  insertSpotPrices,
  insertPositions,
  insertMarketTide,
  insertConeSnapshot,
  coneSnapshotExists,
} from '../core/db.js';
import { computeCapturedAt } from '../core/dates.js';
import { logger } from '../core/logger.js';
import type { SnapshotRow, PositionRow, ConeSnapshotRow } from '../core/types.js';
import { withBrowser } from './browser.js';
import { attachApiCaptures } from './captures.js';
import { clickZoomOut, waitForChartReady } from './chart.js';
import { setExpirySingle, walkDateToTarget } from './navigation.js';
import {
  advanceTimeframeOneSlot,
  nextTimeframe,
  normalizeHhmm,
  walkTimeframeToTarget,
} from './timeframe.js';
import {
  apiResponseToRows,
  contractsResponseToRows,
  netFlowToTideRows,
  parseStraddle,
} from './api-transforms.js';
import {
  latestTradingDay,
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
 * Scrape one trading day AND persist everything for it: navigate the
 * chart to `date`, set Expiry=Single, iterate 10-min slots from
 * `startNorm`..`endNorm` capturing Greeks/positions + per-slot spot,
 * then store Market Tide (per 10-min slot) and the Cone param
 * (straddle, once/day — skipped if already in the DB).
 *
 * This is THE shared per-day scraper: scrapeBackfill (single date),
 * scrapeBackfillRange (fixed list), and scrapeWalkBack (descending walk)
 * all route through it, so scrape + insert behavior lives in one place.
 * Throws if the date can't be selected (callers decide if that's fatal
 * or just "no more history").
 */
async function scrapeAndStoreDay(
  page: Page,
  date: string,
  startNorm: string,
  endNorm: string,
  caps: ApiCaptures,
): Promise<DayStoreSummary> {
  // Drop any responses left over from the previous day so the `?? last`
  // fallbacks below can't read stale data for this date.
  caps.mme.length = 0;
  caps.mmc.length = 0;
  caps.straddle.length = 0;
  caps.tide.length = 0;

  await walkDateToTarget(page, date);
  await page.waitForTimeout(1_500);
  const ok = await setExpirySingle(page, date);
  if (!ok) {
    throw new Error(
      `setExpirySingle(${date}) failed — date may be outside Single-mode dropdown for this chart frame`,
    );
  }
  await waitForChartReady(page);
  await walkTimeframeToTarget(page, startNorm);
  await page.waitForTimeout(1_500);

  const dayRows: SnapshotRow[] = [];
  const dayPositions: PositionRow[] = [];
  const daySpots: Array<{ capturedAt: string; expiry: string; spot: number }> = [];
  let currentStart = startNorm;
  let slotsScanned = 0;

  while (currentStart <= endNorm) {
    const slotEnd = nextTimeframe(currentStart);
    const capturedAt = computeCapturedAt(date, slotEnd);

    // Wait for API response
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.waitForTimeout(1_000);

    const latestMme = [...caps.mme]
      .reverse()
      .find(r => r.url.includes(`expiry=${date}`))
      ?? caps.mme[caps.mme.length - 1];

    if (latestMme) {
      const { rows, qualifyingStrikes, spot, expiry } = apiResponseToRows(latestMme.body, capturedAt);
      dayRows.push(...rows);

      // Record this slot's SPX spot (one observation per 10-min window).
      if (Number.isFinite(spot) && spot > 0) {
        daySpots.push({ capturedAt, expiry, spot });
      }

      const latestMmc = [...caps.mmc]
        .reverse()
        .find(r => r.url.includes(`expiry=${date}`))
        ?? caps.mmc[caps.mmc.length - 1];
      if (latestMmc) {
        dayPositions.push(...contractsResponseToRows(latestMmc.body, capturedAt, qualifyingStrikes));
      }
    }

    slotsScanned += 1;

    const nextStart = nextTimeframe(currentStart);
    if (nextStart > endNorm) break;

    // Clear only the per-slot Greek responses — straddle/tide are
    // fetched once per day and must survive the whole slot loop.
    caps.mme.length = 0;
    caps.mmc.length = 0;
    await advanceTimeframeOneSlot(page);
    await page.waitForTimeout(1_500);
    currentStart = nextStart;
  }

  // ── Persist Greeks + positions + per-slot spot ──
  const snapshotsInserted = await insertSnapshots(dayRows);
  const positionsInserted = await insertPositions(dayPositions);
  const spotsInserted = await insertSpotPrices(daySpots);

  // ── Market Tide: one net-flow-ticks call covers the whole day ──
  const tideResp =
    [...caps.tide].reverse().find(r => r.url.includes(`date=${date}`))
    ?? caps.tide[caps.tide.length - 1];
  let tidePointsInserted = 0;
  if (tideResp) {
    tidePointsInserted = await insertMarketTide(netFlowToTideRows(tideResp.body));
  } else {
    logger.warn({ date }, 'scrapeAndStoreDay: no net-flow-ticks (Market Tide) response captured');
  }

  // ── Cone (once/day): skip entirely if already stored for this date ──
  let coneInserted = false;
  let coneSkipped = false;
  if (await coneSnapshotExists(date)) {
    coneSkipped = true;
  } else {
    const straddleResp =
      [...caps.straddle].reverse().find(r => r.url.includes(`date=${date}`))
      ?? caps.straddle[caps.straddle.length - 1];
    const straddle = straddleResp ? parseStraddle(straddleResp.body) : null;
    if (straddle != null) {
      const cone: ConeSnapshotRow = {
        date,
        straddle,
        capturedAt: new Date().toISOString(),
      };
      coneInserted = await insertConeSnapshot(cone);
    } else {
      logger.warn({ date }, 'scrapeAndStoreDay: no straddle (Cone) value captured');
    }
  }

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
      { targetDate, startHhmm: startNorm, endHhmm: endNorm, url: UW_PERISCOPE_URL },
      'backfill: starting — navigating to periscope',
    );
    await page.goto(UW_PERISCOPE_URL, { waitUntil: 'networkidle' });
    await waitForChartReady(page);

    // Collapse the left nav sidebar to maximize chart area.
    await clickZoomOut(page);

    const summary = await scrapeAndStoreDay(page, targetDate, startNorm, endNorm, caps);

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
  const startNorm = normalizeHhmm(startHhmm);
  const endNorm = normalizeHhmm(endHhmm);
  const dates = tradingDaysBetween(startDate, endDate);

  return await withBrowser(async (_browser, page) => {
    const caps = attachApiCaptures(page);

    logger.info(
      {
        startDate,
        endDate,
        totalDays: dates.length,
        startHhmm: startNorm,
        endHhmm: endNorm,
      },
      'backfill range: starting',
    );
    if (dates.length === 0) {
      logger.warn(
        { startDate, endDate },
        'backfill range: no trading days in range',
      );
      return {
        totalRowsInserted: 0,
        daysScanned: 0,
        daysFailed: [],
        totalDays: 0,
      };
    }

    logger.info({ url: UW_PERISCOPE_URL }, 'navigating to periscope');
    await page.goto(UW_PERISCOPE_URL, { waitUntil: 'networkidle' });
    await waitForChartReady(page);

    // Collapse the left nav sidebar to maximize chart area.
    await clickZoomOut(page);

    let totalRowsInserted = 0;
    let daysScanned = 0;
    const daysFailed: string[] = [];

    for (const [idx, date] of dates.entries()) {
      const dayStarted = Date.now();
      const progress = `${idx + 1}/${dates.length}`;
      logger.info({ date, progress }, 'backfill range: starting day');

      try {
        const summary = await scrapeAndStoreDay(page, date, startNorm, endNorm, caps);
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

    logger.info({ url: UW_PERISCOPE_URL }, 'navigating to periscope');
    await page.goto(UW_PERISCOPE_URL, { waitUntil: 'networkidle' });
    await waitForChartReady(page);

    // Collapse the left nav sidebar to maximize chart area.
    await clickZoomOut(page);

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
        const summary = await scrapeAndStoreDay(page, date, startNorm, endNorm, caps);
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

/**
 * Discovery helper — open dashboard/4 and dump EVERY JSON XHR/fetch
 * response (URL + full body) to docs/temp/, so we can identify the exact
 * endpoints and JSON shapes for panels we don't parse yet (The Cone,
 * Market Tide) BEFORE writing parsers against them. No DB writes.
 *
 * The Cone + Market Tide panels load on dashboard/4, so simply opening
 * the page fires their API calls. Run headed during RTH so intraday
 * panels actually have data, and use SETUP_PAUSE_MS to hold the window
 * open for manual clicking if a panel is lazy-loaded:
 *
 *   HEADLESS=false SETUP_PAUSE_MS=30000 npm run discover
 *
 * Output: docs/temp/endpoints-<ts>/ with one <NNN>_<sanitized-url>.json
 * per unique endpoint plus an _index.json manifest. docs/temp/ is
 * gitignored, so nothing sensitive is committed.
 */
export async function discoverEndpoints(): Promise<{
  outDir: string;
  endpoints: Array<{ url: string; status: number; bytes: number; file: string }>;
}> {
  return await withBrowser(async (_browser, page) => {
    const captured: Array<{ url: string; status: number; body: string }> = [];

    page.on('response', (response) => {
      const ct = response.headers()['content-type'] ?? '';
      if (!ct.includes('json')) return;
      const url = response.url();
      const status = response.status();
      response
        .text()
        .then((body) => {
          captured.push({ url, status, body });
        })
        .catch(() => undefined);
    });

    logger.info({ url: UW_PERISCOPE_URL }, 'discover: navigating to dashboard/4');
    await page.goto(UW_PERISCOPE_URL, { waitUntil: 'networkidle' });
    await waitForChartReady(page);
    await clickZoomOut(page);

    // Hold the page so lazy panels (Cone / Market Tide) finish loading.
    // In headed mode this is also the window for manual interaction.
    const pauseRaw = Number.parseInt((process.env.SETUP_PAUSE_MS ?? '').trim(), 10);
    const pauseMs = Number.isFinite(pauseRaw) && pauseRaw > 0 ? pauseRaw : 8_000;
    logger.info({ pauseMs }, 'discover: settling — interact now if headed');
    await page.waitForTimeout(pauseMs);
    await page.waitForLoadState('networkidle').catch(() => undefined);

    // Keep the largest body per unique URL (later/full payloads win over
    // empty pre-flight responses for the same endpoint).
    const byUrl = new Map<string, { url: string; status: number; body: string }>();
    for (const c of captured) {
      const prev = byUrl.get(c.url);
      if (prev == null || c.body.length > prev.body.length) byUrl.set(c.url, c);
    }

    const outDir = resolve('docs/temp', `endpoints-${Date.now()}`);
    await mkdir(outDir, { recursive: true });

    const endpoints: Array<{ url: string; status: number; bytes: number; file: string }> = [];
    const sorted = [...byUrl.values()].sort((a, b) => a.url.localeCompare(b.url));
    let idx = 0;
    for (const { url, status, body } of sorted) {
      const safe = url
        .replace(/^https?:\/\//, '')
        .replace(/[^\w.-]+/g, '_')
        .slice(0, 120);
      const file = resolve(outDir, `${String(idx).padStart(3, '0')}_${safe}.json`);
      await writeFile(file, body, 'utf8').catch(() => undefined);
      endpoints.push({ url, status, bytes: body.length, file });
      idx += 1;
    }

    await writeFile(
      resolve(outDir, '_index.json'),
      JSON.stringify(endpoints, null, 2),
      'utf8',
    ).catch(() => undefined);

    logger.info(
      { outDir, endpointCount: endpoints.length },
      'discover: captured JSON endpoints — inspect docs/temp',
    );
    for (const e of endpoints) {
      logger.info({ bytes: e.bytes, status: e.status }, e.url);
    }

    return { outDir, endpoints };
  });
}
