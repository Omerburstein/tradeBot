/**
 * Shared types for the periscope-scraper service.
 *
 * Panel values mirror the CHECK constraint on `periscope_snapshots.panel`
 * (migration 140). Keep these strings in sync with the SQL constraint.
 */

export type Panel = 'gamma' | 'charm' | 'vanna' | 'positions';

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
 * One Market Tide observation (a 10-min-aligned point from UW's
 * `net-flow-ticks` series). Persisted to the `market_tide` table.
 */
export interface MarketTideRow {
  /** ISO-8601 UTC timestamp of the tick; TIMESTAMPTZ in Postgres. */
  capturedAt: string;
  /** Trading date (YYYY-MM-DD); DATE in Postgres. */
  date: string;
  netCallPremium: number;
  netPutPremium: number;
  netVolume: number;
}

/**
 * The Cone (expected-move) param for a trading day — UW's ATM straddle
 * price. Persisted once per day to the `cone_snapshots` table.
 */
export interface ConeSnapshotRow {
  /** Trading date (YYYY-MM-DD); DATE primary key in Postgres. */
  date: string;
  /** ATM straddle price (= expected move in SPX points). */
  straddle: number;
  /** ISO-8601 UTC timestamp of when this was scraped. */
  capturedAt: string;
}
