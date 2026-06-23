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
 * One Market Tide observation (a 10-min-aligned point from UW's
 * `net-flow-ticks` series). Persisted to the `market_tide_ticks` table.
 */
export interface MarketTideRow {
  /**
   * ISO-8601 UTC timestamp of the data point itself — the 10-min slot
   * boundary the premiums/volume belong to. Stored to `tick_at`.
   */
  tickAt: string;
  /** Trading date (YYYY-MM-DD); DATE in Postgres. */
  date: string;
  netCallPremium: number;
  netPutPremium: number;
  netVolume: number;
  /**
   * ISO-8601 UTC timestamp of when this row was scraped (wall-clock at
   * capture). Distinct from `tickAt`, which is the data point's own time.
   * Stored to `captured_at`.
   */
  capturedAt: string;
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
