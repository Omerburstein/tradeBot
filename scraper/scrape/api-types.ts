/**
 * Type definitions for the dashboard/4 JSON API responses the scraper
 * intercepts, plus the public ScrapeResult and the ApiCaptures bucket
 * grouping. Pure types — no runtime code — so every engine module can
 * import them without pulling in browser or DB dependencies.
 *
 * ENDPOINT GENERATION (2026-07): UW rebuilt Periscope. The old
 * `market_maker_exposures` / `market_maker_contracts` endpoints were
 * replaced by `periscope/exposures` / `periscope/positions`, keyed by an
 * epoch-ms `timestamp` query param (one snapshot per MINUTE) and an
 * `expiries=<YYYY-MM-DD>` filter param, plus a new `periscope/timestamps`
 * endpoint that lists every published minute for a date. The scraper now
 * fetches these directly (authenticated page.request) instead of driving
 * the removed Timeframe widget.
 */
import type { SnapshotRow, PositionRow } from '../core/types.js';

/** Result of a single slot capture: rows + metadata for the caller. */
export interface ScrapeResult {
  rows: SnapshotRow[];
  /** Positions (call/put qty per strike) — persisted to the `positions` table. */
  positionRows: PositionRow[];
  /** SPX spot price at capture time (page header, else latest 1-min tick close). */
  spot: number | null;
}

/**
 * One row of the `periscope/exposures` response `data`/`prev*` arrays.
 * Greeks arrive as numbers (the old endpoint sent strings). `delta` is new
 * with this endpoint generation and not yet persisted (the DB `panel`
 * CHECK allows gamma/charm/vanna only).
 */
export interface ApiPeriscopeExposureRow {
  ticker_id: number;
  /** UTC ISO minute instant of the snapshot, e.g. "2026-07-02T20:00:00Z". */
  timestamp: string;
  strike: number;
  /** Participant bucket — "market_maker" on dashboard/4. */
  participant: string;
  gamma: number;
  charm: number;
  vanna: number;
  delta: number;
}

/**
 * Shape of the `periscope/exposures?ticker=SPX&timestamp=<ms>&...` response.
 * `prev`/`prev2`/`prev3` mirror `data` at the `prev_minutes` offsets the
 * dashboard requests (10,20) — the scraper ignores them.
 */
export interface ApiPeriscopeExposuresResponse {
  data: ApiPeriscopeExposureRow[];
  prev?: ApiPeriscopeExposureRow[] | null;
  prev2?: ApiPeriscopeExposureRow[] | null;
  prev3?: ApiPeriscopeExposureRow[] | null;
}

/**
 * One row of the `periscope/positions` response `data` array. The
 * market-maker net position per (strike, option_type); the other
 * participant columns are null on dashboard/4.
 */
export interface ApiPeriscopePositionRow {
  ticker_id: number;
  strike: number;
  option_type: 'call' | 'put';
  /** UTC ISO minute instant of the snapshot. */
  timestamp: string;
  market_maker: number | null;
  firm_long: number | null;
  firm_short: number | null;
  broker_dealer_long: number | null;
  broker_dealer_short: number | null;
  customer_long: number | null;
  customer_short: number | null;
  pro_long: number | null;
  pro_short: number | null;
}

/** Shape of the `periscope/positions?ticker=SPX&timestamp=<ms>&...` response. */
export interface ApiPeriscopePositionsResponse {
  data: ApiPeriscopePositionRow[];
  prev?: ApiPeriscopePositionRow[] | null;
  prev2?: ApiPeriscopePositionRow[] | null;
  prev3?: ApiPeriscopePositionRow[] | null;
}

/**
 * Shape of the `periscope/timestamps?date=YYYY-MM-DD` response — every
 * minute instant UW has a snapshot for on that date (UTC ISO strings,
 * covering the full session including pre/post market, ~04:00 ET to
 * ~24:00 ET). The live tick picks the latest instant ≤ now; backfill
 * iterates the list at BACKFILL_STEP_MIN granularity.
 */
export interface ApiPeriscopeTimestampsResponse {
  data: string[];
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
 * One entry from the `index_candles/SPX/5m?interval=Nd` response — an intraday
 * 5-minute SPX candle. This is the only source of *historical* intraday SPX
 * price (the date-keyed tick endpoints ignore their date param). `start`/`end`
 * are UTC ISO instants; `start` is offset from the wall-clock 5-min grid, so
 * callers snap it to the nearest boundary. `c` (close) is used as the spot.
 * The endpoint caps at ~2500 rows (~30 trading days back from today).
 */
export interface ApiIntradayCandle {
  start: string; // UTC ISO, e.g. "2026-06-23T13:34:00Z"
  end: string;   // UTC ISO
  o: string;     // open
  h: string;     // high
  l: string;     // low
  c: string;     // close
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
 * NOTE: the endpoint ignores its `date` param and always returns the LATEST
 * session, so it cannot supply historical Market Tide or spot for a past day.
 */
export interface ApiNetFlowResponse {
  data: ApiNetFlowRow[];
  prices?: unknown;
}

/**
 * All intercepted dashboard/4 JSON responses we care about, grouped by
 * endpoint. One listener fills every bucket so each scrape path attaches
 * interception identically instead of duplicating the response handler.
 * The exposures/positions/timestamps buckets are also fed by the direct
 * `page.request` fetch helpers in api-helpers.ts.
 */
export interface ApiCaptures {
  /**
   * Request headers the PAGE sent on its own periscope/* XHRs (filtered to
   * auth-relevant ones — authorization, origin, referer, x-*). The phx API
   * rejects bare cookie-auth requests to the periscope endpoints with 403,
   * so the direct fetch helpers replay these headers to stay
   * indistinguishable from the dashboard's own traffic.
   */
  periscopeHeaders: Record<string, string> | null;
  exposures: Array<{ url: string; body: ApiPeriscopeExposuresResponse }>;
  positions: Array<{ url: string; body: ApiPeriscopePositionsResponse }>;
  /** Available snapshot minutes per date — fires on page load for the viewed date. */
  timestamps: Array<{ url: string; body: ApiPeriscopeTimestampsResponse }>;
  straddle: Array<{ url: string; body: ApiStraddleResponse }>;
  tide: Array<{ url: string; body: ApiNetFlowResponse }>;
  /** Daily OHLC for SPX — fires once on page load. Fallback cone apex (`o`) when ticks are missing. */
  candles: Array<{ url: string; body: ApiCandleEntry[] }>;
  /** Per-minute SPX ticks — `data[0].close` is the cone apex (SPX settled open). */
  ticks: Array<{ url: string; body: ApiSpxTickResponse }>;
}
