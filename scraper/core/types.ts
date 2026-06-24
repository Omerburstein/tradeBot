/**
 * Shared types for the periscope-scraper service.
 *
 * Panel values mirror the CHECK constraint on `periscope_snapshots.panel`
 * (migration 140). Keep these strings in sync with the SQL constraint.
 */

export type Panel = 'gamma' | 'charm' | 'vanna';

export interface SnapshotRow {
  /** ISO-8601 UTC timestamp; serialized to TIMESTAMPTZ in Postgres. */
  capturedAt: string;
  /** ISO-8601 date (YYYY-MM-DD); serialized to DATE in Postgres. */
  expiry: string;
  panel: Panel;
  strike: number;
  value: number;
  /**
   * UW slot label the row was actually captured from, e.g.
   * "09:10 - 09:20". Stored to the `timeframe` column added by
   * migration 141. Required for new rows so timeframe drift across
   * panels at one captured_at is visible to consumers, and the
   * scraper can realign subsequent Greek captures back to the
   * gamma anchor when UW publishes a new slot mid-cycle.
   */
  timeframe: string;
}

/**
 * One MM contracts position observation — call and put qty per strike,
 * persisted to the `positions` table (separate from periscope_snapshots).
 */
export interface PositionRow {
  /** ISO-8601 UTC timestamp; slot END time. */
  capturedAt: string;
  /** ISO-8601 date (YYYY-MM-DD). */
  expiry: string;
  strike: number;
  callQty: number;
  putQty: number;
  timeframe: string;
}

/**
 * One Market Tide observation (a 5-min-aligned point from UW's
 * `net-flow-ticks` series). Persisted to the `market_tide` table.
 */
export interface MarketTideRow {
  /** ISO-8601 UTC timestamp of the data point's own 5-min slot boundary. PK. */
  capturedAt: string;
  netCallPremium: number;
  netPutPremium: number;
  netVolume: number;
}

/**
 * The Cone (expected-move) for a trading day. Three price coordinates that
 * define the two yellow cone lines on the Periscope chart: the starting SPX
 * price and its upper/lower endpoints at end-of-day.
 *
 * Derived as: spxOpen from index_values.open, coneUpper = spxOpen + straddle,
 * coneLower = spxOpen - straddle. Persisted once per day to `cone_snapshots`.
 */
export interface ConeSnapshotRow {
  /** ISO-8601 UTC timestamp of when this was scraped. PK in Postgres. */
  capturedAt: string;
  /** SPX open price for the day — the cone's apex. */
  spxOpen: number;
  /** Upper cone endpoint (spxOpen + ATM straddle). */
  coneUpper: number;
  /** Lower cone endpoint (spxOpen − ATM straddle). */
  coneLower: number;
}
