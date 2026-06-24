/**
 * Shared helpers for selecting the best API response from an ApiCaptures
 * bucket and persisting Cone / Market Tide. Both the live tick (panels.ts)
 * and all backfill paths (orchestrate.ts) import from here so any change to
 * response-selection logic or storage behavior applies once and propagates
 * to every scraping path automatically.
 */
import { type Page } from 'playwright';
import { insertMarketTide, insertConeSnapshot, coneSnapshotExists } from '../../db/index.js';
import { logger } from '../core/logger.js';
import type { ConeSnapshotRow, MarketTideRow } from '../core/types.js';
import { parseStraddle, netFlowToTideRows } from './api-transforms.js';
import type {
  ApiCaptures,
  ApiExposureResponse,
  ApiContractsResponse,
  ApiNetFlowResponse,
  ApiSpxTickResponse,
} from './api-types.js';

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
  const rows = netFlowToTideRows(tideResp.body);
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
 * param is swapped for `date`; page.request shares the context cookies, so
 * the call is authenticated. Non-blocking — logs a warning on any failure.
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
  const url = /[?&]date=/.test(templateUrl)
    ? templateUrl.replace(/([?&]date=)[^&]*/, `$1${date}`)
    : `${templateUrl}${templateUrl.includes('?') ? '&' : '?'}date=${date}`;
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
  } catch (err) {
    logger.warn(
      { date, err: err instanceof Error ? err.message : String(err) },
      'net-flow-ticks fetch failed — non-blocking',
    );
  }
}

/**
 * Resolve the one_minute_ticks URL template used to re-fetch the intraday
 * SPX series per backfill day. Prefers a template actually observed on page
 * load, but the cone/ticks panel can lazy-load AFTER the load-time capture
 * window — in which case `caps.ticks` is still empty and relying on the
 * observed URL alone would leave the per-slot spot pinned to the constant
 * index_values.close. So fall back to synthesizing the URL from the
 * net-flow-ticks origin (same phx API host, stable endpoint path), which is
 * captured reliably. Returns undefined only when neither source is available.
 */
export function resolveTicksTemplate(
  caps: ApiCaptures,
  tideUrlTemplate: string | undefined,
): string | undefined {
  const observed = caps.ticks[caps.ticks.length - 1]?.url;
  if (observed) return observed;
  if (!tideUrlTemplate) return undefined;
  try {
    return `${new URL(tideUrlTemplate).origin}/api/index_ticks/SPX/one_minute_ticks`;
  } catch {
    return undefined;
  }
}

/**
 * Directly fetch the one-minute SPX ticks series for `date` through the
 * authenticated page context and push it into `caps.ticks`.
 *
 * Why this is needed: like net-flow-ticks, the one_minute_ticks endpoint
 * fires ONLY for today on page load and does NOT refetch when the Greeks
 * chart date changes. Without this, a backfill day has no intraday SPX
 * price series, so the per-slot spot would collapse to the constant
 * index_values.close and the cone apex would fall back to the daily candle.
 * `templateUrl` is a one_minute_ticks URL observed at page load whose `date`
 * param is swapped for `date`; page.request shares the context cookies, so
 * the call is authenticated. Non-blocking — logs a warning on any failure.
 */
export async function captureTicksForDate(
  page: Page,
  caps: ApiCaptures,
  date: string,
  templateUrl: string | undefined,
): Promise<void> {
  if (!templateUrl) {
    logger.warn(
      { date },
      'no one_minute_ticks URL template captured — cannot fetch SPX ticks for backfill date',
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
        'one_minute_ticks fetch non-OK — skipping SPX ticks for this date',
      );
      return;
    }
    const body = (await resp.json()) as ApiSpxTickResponse;
    caps.ticks.push({ url, body });
    logger.info(
      { date, bars: body.data?.length ?? 0 },
      'one_minute_ticks fetched for backfill date',
    );
  } catch (err) {
    logger.warn(
      { date, err: err instanceof Error ? err.message : String(err) },
      'one_minute_ticks fetch failed — non-blocking',
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
      logger.warn({ date }, 'no net-flow-ticks (Market Tide) response captured');
      return 0;
    }
    const rows = netFlowToTideRows(tideResp.body);
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
      capturedAt: new Date().toISOString(),
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
