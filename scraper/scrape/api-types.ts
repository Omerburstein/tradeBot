/**
 * Type definitions for the dashboard/4 JSON API responses the scraper
 * intercepts, plus the public ScrapeResult and the ApiCaptures bucket
 * grouping. Pure types — no runtime code — so every engine module can
 * import them without pulling in browser or DB dependencies.
 */
import type { SnapshotRow, PositionRow } from '../core/types.js';

/** Result of a single slot capture: rows + metadata for the caller. */
export interface ScrapeResult {
  rows: SnapshotRow[];
  /** Positions (call/put qty per strike) — persisted to the `positions` table. */
  positionRows: PositionRow[];
  /** SPX spot price at capture time (from the API index_values or page header). */
  spot: number | null;
}

/**
 * Result of a light tick — the cheap 5-min capture that reads only the
 * price + Market Tide (which refresh every 5 min) and skips the expensive
 * Greeks/positions navigation (which only refresh every 10 min). Market Tide
 * is persisted inside the scrape; the caller persists the spot price.
 */
export interface LightScrapeResult {
  /** SPX spot price read from the page header, or null when unavailable. */
  spot: number | null;
  /** Trading date scraped (YYYY-MM-DD). */
  date: string;
  /** ET HH:MM end of the latest captured Market Tide slot, or null. Drives 5-min dedup. */
  tideSlotEnd: string | null;
  /** ISO instant of that tide slot (used as the spot price captured_at), or null. */
  tideCapturedAt: string | null;
  /** Number of Market Tide rows inserted by this tick. */
  tideInserted: number;
}

/**
 * Shape of a single row in the UW `market_maker_exposures` API response.
 * The `data` field is an object keyed by index (0, 1, 2, ...) containing
 * these rows.
 */
export interface ApiExposureRow {
  count: number;
  timestamp: string;
  gamma: string;
  strike: number;
  vanna: string;
  charm: string;
}

/**
 * Shape of the `market_maker_exposures` API response body.
 */
export interface ApiExposureResponse {
  data: Record<string, ApiExposureRow>;
  timestamp: string; // e.g. "2026-06-18T20:00:00Z"
  date: string;      // e.g. "2026-06-18"
  index_values: {
    close: number;
    high: number;
    low: number;
    open: number;
  };
  prev?: ApiExposureRow[];
  prev2?: ApiExposureRow[];
  prev3?: ApiExposureRow[];
}

/**
 * Shape of a single row in the UW `market_maker_contracts` API response.
 * Each strike appears twice — once for "call" and once for "put".
 */
export interface ApiContractsRow {
  count: number;
  timestamp: string;
  type: 'call' | 'put';
  strike: number;
  qty: number;
}

/**
 * Shape of the `market_maker_contracts` API response body.
 */
export interface ApiContractsResponse {
  data: ApiContractsRow[];
  timestamp: string;
  date: string;
  index_values: {
    close: number;
    high: number;
    low: number;
    open: number;
  };
}

/**
 * Shape of the `bsoc/SPX/straddle?date=...` response — the ATM straddle
 * price for the day (the Cone / expected-move param). e.g. {"straddle":"40.90"}
 */
export interface ApiStraddleResponse {
  straddle: string;
}

/**
 * One entry from the `index_candles/SPX/1d?interval=...` response —
 * daily OHLC for SPX. The `o` field is the raw opening print, which spikes
 * before settling; it is only a *fallback* cone apex (the real apex is the
 * first one-minute bar's close). Note: field names are single-char shorthands.
 */
export interface ApiCandleEntry {
  date: string; // "YYYY-MM-DD"
  o: string;    // open
  h: string;    // high
  l: string;    // low
  c: string;    // close
}

/**
 * Shape of the `index_ticks/SPX/one_minute_ticks?date=...` response body.
 * `data[0].close` is the SPX *settled* open — the cone's apex. `prev_close`
 * is the prior session's close (not the apex; kept for reference).
 */
export interface ApiSpxTickResponse {
  prev_close: string;
  data: Array<{
    start_time: string;
    open: string;
    close: string;
    high: string;
    low: string;
  }>;
}

/**
 * Shape of a single `net-flow-ticks` data point (one per minute).
 */
export interface ApiNetFlowRow {
  timestamp: string; // e.g. "2026-06-18T09:30:00-04:00"
  date: string;      // e.g. "2026-06-18"
  net_call_premium: string;
  net_put_premium: string;
  net_volume: number;
}

/**
 * Shape of the `net-flow-ticks?date=...` response body (Market Tide).
 * `data` is the full trading day at 1-min granularity (~390 points).
 */
export interface ApiNetFlowResponse {
  data: ApiNetFlowRow[];
  prices?: unknown;
}

/**
 * All intercepted dashboard/4 JSON responses we care about, grouped by
 * endpoint. One listener fills every bucket so each scrape path attaches
 * interception identically instead of duplicating the response handler.
 */
export interface ApiCaptures {
  mme: Array<{ url: string; body: ApiExposureResponse }>;
  mmc: Array<{ url: string; body: ApiContractsResponse }>;
  straddle: Array<{ url: string; body: ApiStraddleResponse }>;
  tide: Array<{ url: string; body: ApiNetFlowResponse }>;
  /** Daily OHLC for SPX — fires once on page load. Fallback cone apex (`o`) when ticks are missing. */
  candles: Array<{ url: string; body: ApiCandleEntry[] }>;
  /** Per-minute SPX ticks — `data[0].close` is the cone apex (SPX settled open). */
  ticks: Array<{ url: string; body: ApiSpxTickResponse }>;
}
