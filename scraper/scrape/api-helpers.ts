/**
 * Shared helpers for selecting the best API response from an ApiCaptures
 * bucket and persisting Cone / Market Tide. Both the live tick (panels.ts)
 * and all backfill paths (orchestrate.ts) import from here so any change to
 * response-selection logic or storage behavior applies once and propagates
 * to every scraping path automatically.
 */
import { insertMarketTide, insertConeSnapshot, coneSnapshotExists } from '../../db/index.js';
import { logger } from '../core/logger.js';
import type { ConeSnapshotRow } from '../core/types.js';
import { parseStraddle, netFlowToTideRows } from './api-transforms.js';
import type { ApiCaptures, ApiExposureResponse, ApiContractsResponse } from './api-types.js';

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
 * Persist Market Tide for `date` from captured net-flow-ticks responses.
 * `slotOnly: true` (live tick) inserts only the latest slot row; the default
 * (backfill) inserts all slots for the day.
 * Non-blocking — returns 0 and logs a warning rather than throwing.
 */
export async function storeMarketTide(
  caps: ApiCaptures,
  date: string,
  { slotOnly = false }: { slotOnly?: boolean } = {},
): Promise<number> {
  try {
    const tideResp =
      [...caps.tide].reverse().find(r => r.url.includes(`date=${date}`))
      ?? caps.tide[caps.tide.length - 1];
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
