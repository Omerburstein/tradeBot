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
 * daily OHLC for SPX. The `o` field is the session open price, which is
 * the cone's apex (start point). Note: field names are single-char shorthands.
 */
export interface ApiCandleEntry {
  date: string; // "YYYY-MM-DD"
  o: string;    // open
  h: string;    // high
  l: string;    // low
  c: string;    // close
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
  /** Daily OHLC for SPX — fires once on page load. Used for cone apex (spxOpen). */
  candles: Array<{ url: string; body: ApiCandleEntry[] }>;
}
