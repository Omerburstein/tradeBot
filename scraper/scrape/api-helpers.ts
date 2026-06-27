/**
 * Shared helpers for selecting the best API response from an ApiCaptures
 * bucket and persisting Cone / Market Tide. Both the live tick (panels.ts)
 * and all backfill paths (orchestrate.ts) import from here so any change to
 * response-selection logic or storage behavior applies once and propagates
 * to every scraping path automatically.
 */
import { type Page } from 'playwright';
import {
  insertMarketTide,
  insertConeSnapshot,
  coneSnapshotExists,
  insertSpotPrices,
} from '../../db/index.js';
import { computeCapturedAt } from '../core/dates.js';
import { logger } from '../core/logger.js';
import type { ConeSnapshotRow, MarketTideRow } from '../core/types.js';
import {
  parseStraddle,
  netFlowToTideRows,
  candles5mToSpotRowsByDate,
  dailyCloseSpotRow,
  type SpotRow,
} from './api-transforms.js';
import type {
  ApiCaptures,
  ApiExposureResponse,
  ApiContractsResponse,
  ApiNetFlowResponse,
  ApiStraddleResponse,
  ApiIntradayCandle,
} from './api-types.js';

/**
 * How many market days back the net-flow-ticks (Market Tide) endpoint is asked
 * to return via its `market_day_timeframe` param. The endpoint IGNORES its
 * `date` param and instead serves the last `market_day_timeframe` sessions, so
 * the dashboard's default of 1 can only ever supply *today's* tide — which is
 * why backfilling a viewed date used to store nothing. Widening it to 30 makes
 * the last ~month of sessions available, so any date within that window finds
 * its own day's tide. The multi-day payload is then filtered down to the
 * requested date by netFlowToTideRows, and storeMarketTide stores nothing when
 * the date isn't present — never another day's data.
 */
const MARKET_TIDE_LOOKBACK_DAYS = 30;

/**
 * Three-tier best-response selection for market_maker_exposures.
 * Prefers the most-recent response whose URL matches `expiry=<targetExpiry>`,
 * then any non-"all" expiry response, then the last response as a last resort.
 * Returns null when the array is empty.
 */
export function pickBestMme(
  responses: Array<{ url: string; body: ApiExposureResponse }>,
  targetExpiry: string,
): ApiExposureResponse | null {
  const rev = [...responses].reverse();
  return (
    rev.find(r => r.url.includes(`expiry=${targetExpiry}`))?.body
    ?? rev.find(r => !r.url.includes('expiry=all'))?.body
    ?? (responses.length > 0 ? responses[responses.length - 1]!.body : null)
  );
}

/**
 * Three-tier best-response selection for market_maker_contracts.
 * Same tier order as pickBestMme: exact expiry match → non-"all" → last.
 */
export function pickBestMmc(
  responses: Array<{ url: string; body: ApiContractsResponse }>,
  targetExpiry: string,
): ApiContractsResponse | null {
  const rev = [...responses].reverse();
  return (
    rev.find(r => r.url.includes(`expiry=${targetExpiry}`))?.body
    ?? rev.find(r => !r.url.includes('expiry=all'))?.body
    ?? (responses.length > 0 ? responses[responses.length - 1]!.body : null)
  );
}

/**
 * Pick the net-flow-ticks (Market Tide) response for `date` from the
 * captures: the most-recent response whose URL matches `date=<date>`, else
 * the last response captured. Returns null when nothing was captured.
 * Single source of truth for tide-response selection (used by both the
 * full-day insert and the latest-slot helper below).
 */
function pickTideResponse(caps: ApiCaptures, date: string) {
  return (
    [...caps.tide].reverse().find(r => r.url.includes(`date=${date}`))
    ?? caps.tide[caps.tide.length - 1]
    ?? null
  );
}

/**
 * Return the latest 5-min-aligned Market Tide row for `date`, or null when
 * no usable response was captured. Used by the light (price + Market Tide)
 * tick to drive its 5-min dedup and align the spot price to the same instant.
 */
export function latestTideRow(caps: ApiCaptures, date: string): MarketTideRow | null {
  const tideResp = pickTideResponse(caps, date);
  if (!tideResp) return null;
  const rows = netFlowToTideRows(tideResp.body, date);
  return rows.length > 0 ? rows[rows.length - 1]! : null;
}

/**
 * Directly fetch the net-flow-ticks (Market Tide) series for `date` through
 * the authenticated page context and push it into `caps.tide`, so the
 * shared `storeMarketTide` can persist it as usual.
 *
 * Why this is needed: the Market Tide widget fires net-flow-ticks ONLY for
 * today on page load, and does NOT refetch when the Greeks chart date
 * changes. So every backfill day (whose target date differs from the page's
 * default) would otherwise capture no tide at all and store 0 rows.
 * `templateUrl` is a net-flow-ticks URL observed at page load whose `date`
 * param is swapped for `date` and whose `market_day_timeframe` is widened to
 * MARKET_TIDE_LOOKBACK_DAYS so the response spans the last ~month — any date
 * within that window then has its own session present (older dates still come
 * back without it and store nothing). page.request shares the context cookies,
 * so the call is authenticated. Non-blocking — logs a warning on any failure.
 */
export async function captureTideForDate(
  page: Page,
  caps: ApiCaptures,
  date: string,
  templateUrl: string | undefined,
): Promise<void> {
  if (!templateUrl) {
    logger.warn(
      { date },
      'no net-flow-ticks URL template captured — cannot fetch Market Tide for backfill date',
    );
    return;
  }
  // Swap the date param, then widen market_day_timeframe so the response spans
  // the last ~month of sessions (the endpoint ignores `date` and returns the
  // last market_day_timeframe days — see MARKET_TIDE_LOOKBACK_DAYS).
  const withDate = /[?&]date=/.test(templateUrl)
    ? templateUrl.replace(/([?&]date=)[^&]*/, `$1${date}`)
    : `${templateUrl}${templateUrl.includes('?') ? '&' : '?'}date=${date}`;
  const url = /[?&]market_day_timeframe=/.test(withDate)
    ? withDate.replace(/([?&]market_day_timeframe=)[^&]*/, `$1${MARKET_TIDE_LOOKBACK_DAYS}`)
    : `${withDate}&market_day_timeframe=${MARKET_TIDE_LOOKBACK_DAYS}`;
  try {
    const resp = await page.request.get(url);
    if (!resp.ok()) {
      logger.warn(
        { date, status: resp.status() },
        'net-flow-ticks fetch non-OK — skipping Market Tide for this date',
      );
      return;
    }
    const body = (await resp.json()) as ApiNetFlowResponse;
    caps.tide.push({ url, body });
    logger.info(
      {
        date,
        url,
        points: body.data?.length ?? 0,
        returnedDate: body.data?.[0]?.date ?? null,
        dateMatches: (body.data?.[0]?.date ?? null) === date,
      },
      'captureTideForDate: fetched net-flow-ticks',
    );
  } catch (err) {
    logger.warn(
      { date, err: err instanceof Error ? err.message : String(err) },
      'net-flow-ticks fetch failed — non-blocking',
    );
  }
}

/**
 * Fetch intraday 5-min SPX candles (index_candles/SPX/5m) ONCE and bucket them
 * into clean 5-min spot rows per ET date. This is the only source of
 * *historical* intraday SPX price — the date-keyed tick endpoints
 * (net-flow-ticks, one_minute_ticks) ignore their `date` param and always
 * return the latest session, and the MME index_values is only a daily close.
 *
 * The endpoint counts back `lookbackDays` from today and caps at ~2500 rows
 * (~30 trading days of 5-min candles), so older backfill days aren't covered
 * and the caller falls back to the daily close. Fetch this once per run (it
 * spans many days) and look up each day's rows. `originUrl` is any phx API URL
 * observed on load (the daily-candles URL, else the tide URL); we reuse its
 * origin. Non-blocking — returns an empty map on any failure.
 */
export async function fetchSpotCandles5m(
  page: Page,
  originUrl: string | undefined,
  lookbackDays = 40,
): Promise<Map<string, SpotRow[]>> {
  const empty = new Map<string, SpotRow[]>();
  if (!originUrl) {
    logger.warn('no candles origin URL — cannot fetch intraday spot candles');
    return empty;
  }
  let origin: string;
  try {
    origin = new URL(originUrl).origin;
  } catch {
    return empty;
  }
  const url = `${origin}/api/index_candles/SPX/5m?interval=${lookbackDays}d`;
  try {
    const resp = await page.request.get(url);
    if (!resp.ok()) {
      logger.warn({ status: resp.status() }, 'index_candles 5m non-OK — no intraday spot');
      return empty;
    }
    const body = (await resp.json()) as { data?: ApiIntradayCandle[] };
    const map = candles5mToSpotRowsByDate(body.data ?? []);
    const dates = [...map.keys()].sort();
    logger.info(
      { days: map.size, from: dates[0] ?? null, to: dates[dates.length - 1] ?? null },
      'intraday 5-min spot candles fetched (recent window)',
    );
    return map;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'index_candles 5m fetch failed — non-blocking',
    );
    return empty;
  }
}

/**
 * Resolve the bsoc/SPX/straddle URL template used to re-fetch the Cone's ATM
 * straddle per backfill day: prefer a template observed on page load, else
 * synthesize it from the net-flow-ticks origin (same phx API host, stable
 * endpoint path). Returns undefined only when neither source is available.
 */
export function resolveStraddleTemplate(
  caps: ApiCaptures,
  tideUrlTemplate: string | undefined,
): string | undefined {
  const observed = caps.straddle[caps.straddle.length - 1]?.url;
  if (observed) return observed;
  if (!tideUrlTemplate) return undefined;
  try {
    return `${new URL(tideUrlTemplate).origin}/api/bsoc/SPX/straddle`;
  } catch {
    return undefined;
  }
}

/**
 * Directly fetch the ATM straddle (Cone param) for `date` through the
 * authenticated page context and push it into `caps.straddle`, so the shared
 * `storeCone` reads THIS day's straddle.
 *
 * Why this is needed: like net-flow-ticks and one_minute_ticks, the straddle
 * endpoint fires ONLY for today on page load and does NOT refetch when the
 * Greeks chart date changes. Without this, a backfill day has no straddle for
 * its date — so the cone is either skipped (caps.straddle empty after the
 * per-day clear) or, via the `?? last` fallback, built from TODAY's straddle
 * and filed under the scraped day. `templateUrl` is a straddle URL whose
 * `date` param is swapped for `date`. Non-blocking — warns on any failure.
 */
export async function captureStraddleForDate(
  page: Page,
  caps: ApiCaptures,
  date: string,
  templateUrl: string | undefined,
): Promise<void> {
  if (!templateUrl) {
    logger.warn(
      { date },
      'no bsoc/SPX/straddle URL template captured — cannot fetch Cone straddle for backfill date',
    );
    return;
  }
  const url = /[?&]date=/.test(templateUrl)
    ? templateUrl.replace(/([?&]date=)[^&]*/, `$1${date}`)
    : `${templateUrl}${templateUrl.includes('?') ? '&' : '?'}date=${date}`;
  try {
    const resp = await page.request.get(url);
    if (!resp.ok()) {
      logger.warn(
        { date, status: resp.status() },
        'bsoc/SPX/straddle fetch non-OK — skipping Cone straddle for this date',
      );
      return;
    }
    const body = (await resp.json()) as ApiStraddleResponse;
    caps.straddle.push({ url, body });
  } catch (err) {
    logger.warn(
      { date, err: err instanceof Error ? err.message : String(err) },
      'bsoc/SPX/straddle fetch failed — non-blocking',
    );
  }
}

/**
 * Persist Market Tide for `date` from captured net-flow-ticks responses.
 * `slotOnly: true` (live tick) inserts only the latest 5-min slot row; the
 * default (backfill) inserts all 5-min slots for the day.
 * Non-blocking — returns 0 and logs a warning rather than throwing.
 */
export async function storeMarketTide(
  caps: ApiCaptures,
  date: string,
  { slotOnly = false }: { slotOnly?: boolean } = {},
): Promise<number> {
  try {
    const tideResp = pickTideResponse(caps, date);
    if (!tideResp) {
      logger.warn(
        { date, tideResponsesCaptured: caps.tide.length },
        'no net-flow-ticks (Market Tide) response captured',
      );
      return 0;
    }
    const rows = netFlowToTideRows(tideResp.body, date);
    logger.info(
      {
        date,
        url: tideResp.url,
        rawPoints: tideResp.body.data?.length ?? 0,
        returnedDate: tideResp.body.data?.[0]?.date ?? null,
        rowsForDate: rows.length,
        sample: rows.slice(0, 2),
      },
      'storeMarketTide: candidate tide rows',
    );
    if (rows.length === 0 && (tideResp.body.data?.length ?? 0) > 0) {
      // The endpoint returned data, but none of it is for `date` — it ignores
      // its `date` param and serves the latest session. Storing it would file
      // the wrong session's tide under this day, so skip (no historical tide
      // is available for this date from this endpoint).
      const returnedDate = tideResp.body.data?.[0]?.date ?? null;
      logger.warn(
        { date, returnedDate },
        'net-flow-ticks returned a different session — skipping Market Tide for this date',
      );
      return 0;
    }
    const inserted = await insertMarketTide(slotOnly ? rows.slice(-1) : rows);
    logger.info({ date, inserted }, 'Market Tide stored');
    return inserted;
  } catch (err) {
    logger.warn(
      { date, err: err instanceof Error ? err.message : String(err) },
      'Market Tide store failed — non-blocking',
    );
    return 0;
  }
}

/**
 * Persist the intraday SPX spot series for `date`. UW exposes only two usable
 * spot sources, so there are two tiers:
 *
 *  1. Real 5-min index candles (true SPX scale) — but `index_candles/SPX/5m`
 *     caps at ~30 trading days back, pre-fetched into `intradaySpotByDate`.
 *     Gives genuine 5-min spot, used for recent days.
 *  2. Else a single daily-close row from the 1d candles (full history). For
 *     days older than the 5m window this is ALL UW has — there is no historical
 *     intraday price endpoint (net-flow-ticks, the Market Tide source, ignores
 *     its date param and returns the latest session, so it can't supply spot
 *     for a past day either).
 *
 * caps.candles holds the daily candle (fires once on load, covers the range).
 * Non-blocking — returns the inserted count, 0 on failure.
 */
export async function storeSpot(
  caps: ApiCaptures,
  date: string,
  intradaySpotByDate: Map<string, SpotRow[]>,
): Promise<number> {
  try {
    // Tier 1: real intraday 5-min SPX candles (recent ~30 trading days).
    const intraday = intradaySpotByDate.get(date) ?? [];
    if (intraday.length > 0) {
      logger.info(
        { date, source: '5m-candles', rows: intraday.length, sample: intraday.slice(0, 2) },
        'storeSpot: candidate spot rows',
      );
      const inserted = await insertSpotPrices(intraday);
      logger.info({ date, inserted }, 'spot stored (intraday 5-min candles)');
      return inserted;
    }

    // Tier 2: single daily close (older days — no intraday source exists).
    const dailyCandles = caps.candles.flatMap(r => r.body);
    const closeRows = dailyCloseSpotRow(
      dailyCandles,
      date,
      computeCapturedAt(date, '16:00'),
    );
    logger.info(
      {
        date,
        source: 'daily-close',
        candleDays: dailyCandles.length,
        haveCandleForDate: dailyCandles.some(e => e.date === date),
        rows: closeRows,
      },
      'storeSpot: candidate spot rows (no intraday for this date)',
    );
    const inserted = await insertSpotPrices(closeRows);
    logger.info({ date, inserted }, 'spot stored (daily close — no intraday for this date)');
    return inserted;
  } catch (err) {
    logger.warn(
      { date, err: err instanceof Error ? err.message : String(err) },
      'spot store failed — non-blocking',
    );
    return 0;
  }
}

/**
 * Persist the Cone for `date` if not already stored.
 * Returns `{ inserted: true }` when a new row is written, `{ skipped: true }`
 * when the DB already has a cone for this date, or `{}` when data is missing.
 * Non-blocking — logs a warning rather than throwing on error.
 *
 * Cone apex = SPX *settled* open = first RTH one-minute bar's CLOSE.
 * Do NOT use daily candle `o` (raw opening spike) or `prev_close` (prior
 * session) — both place the apex in the wrong spot. The candle `o` fallback
 * only fires when ticks are unavailable (e.g. backfill of older dates).
 */
export async function storeCone(
  caps: ApiCaptures,
  date: string,
): Promise<{ inserted: boolean; skipped: boolean }> {
  try {
    if (await coneSnapshotExists(date)) return { inserted: false, skipped: true };
    const straddleResp =
      [...caps.straddle].reverse().find(r => r.url.includes(`date=${date}`))
      ?? caps.straddle[caps.straddle.length - 1];
    const straddle = straddleResp ? parseStraddle(straddleResp.body) : null;
    // Cone apex = the SPX *settled* open = first RTH one-minute bar's CLOSE.
    // Verified against chart axis labels: midpoint of cone bounds == data[0].close.
    const tickResp = caps.ticks.find(r => r.url.includes(`date=${date}`));
    const firstBar = tickResp?.body.data?.[0];
    const candleEntry = caps.candles.flatMap(r => r.body).find(e => e.date === date);
    const spxOpen = firstBar
      ? Number.parseFloat(firstBar.close)
      : candleEntry ? Number.parseFloat(candleEntry.o) : null;
    if (straddle == null || spxOpen == null) {
      logger.warn({ date, straddle, spxOpen }, 'missing cone data — skipping');
      return { inserted: false, skipped: false };
    }
    const cone: ConeSnapshotRow = {
      // Stamp the cone at the trading day's session open (09:30 ET = the
      // apex instant), NOT wall-clock now(). Using now() filed a backfilled
      // cone under the day the backfill RAN, not the day it describes, which
      // also defeated the coneSnapshotExists(date) dedup (keyed on the ET
      // date of captured_at).
      capturedAt: computeCapturedAt(date, '09:30'),
      spxOpen,
      coneUpper: spxOpen + straddle,
      coneLower: spxOpen - straddle,
    };
    const inserted = await insertConeSnapshot(cone);
    logger.info({ date, spxOpen, straddle, inserted }, 'Cone stored');
    return { inserted, skipped: false };
  } catch (err) {
    logger.warn(
      { date, err: err instanceof Error ? err.message : String(err) },
      'Cone store failed — non-blocking',
    );
    return { inserted: false, skipped: false };
  }
}
