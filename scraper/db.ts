/**
 * Neon Postgres helpers for periscope_snapshots inserts.
 *
 * Uses a singleton serverless client and batches inserts (max 500 rows per
 * SQL call) per the parent repo's `feedback_batched_inserts.md` convention.
 * Per-row inserts in a loop are 50–100x slower on Neon serverless.
 */

import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import { DATABASE_URL } from './config.js';
import type { SnapshotRow, MarketTideRow, ConeSnapshotRow } from './types.js';

const MAX_ROWS_PER_INSERT = 500;

/**
 * Panels for which a value of exactly 0 is treated as noise and excluded
 * from the database. A zero charm/vanna/positions reading carries no
 * signal worth persisting, whereas gamma's zero is meaningful (it's the
 * anchor) and is always kept.
 */
const SKIP_ZERO_PANELS: ReadonlySet<SnapshotRow['panel']> = new Set([
  'charm',
  'vanna',
  'positions',
]);

let client: NeonQueryFunction<false, false> | null = null;

export function getDb(): NeonQueryFunction<false, false> {
  if (client === null) {
    client = neon(DATABASE_URL);
  }
  return client;
}

/**
 * Insert snapshot rows into `periscope_snapshots` in batches of 500.
 *
 * Uses ON CONFLICT DO NOTHING on the (captured_at, expiry, panel, strike)
 * unique key for idempotency on retry. Returns the count of rows submitted
 * (not necessarily inserted — conflicts are silently skipped).
 */
export async function insertSnapshots(rows: SnapshotRow[]): Promise<number> {
  // Drop charm/vanna/positions rows whose value is exactly 0 — they carry
  // no signal. Gamma zeros (the anchor) are retained.
  const insertable = rows.filter(
    (row) => !(SKIP_ZERO_PANELS.has(row.panel) && row.value === 0),
  );
  if (insertable.length === 0) return 0;

  const sql = getDb();
  let submitted = 0;

  for (let i = 0; i < insertable.length; i += MAX_ROWS_PER_INSERT) {
    const chunk = insertable.slice(i, i + MAX_ROWS_PER_INSERT);

    // Build a flat parameter list and a $1,$2,... VALUES list. The Neon
    // serverless driver's tagged-template form doesn't expand arrays into
    // VALUES tuples, so we use the (text, params) call form with explicit
    // positional parameters.
    const placeholders: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    for (const row of chunk) {
      placeholders.push(
        `($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`,
      );
      params.push(
        row.capturedAt,
        row.expiry,
        row.panel,
        row.strike,
        row.value,
        row.timeframe,
      );
    }

    const text =
      `INSERT INTO periscope_snapshots ` +
      `(captured_at, expiry, panel, strike, value, timeframe) ` +
      `VALUES ${placeholders.join(', ')} ` +
      `ON CONFLICT (captured_at, expiry, panel, strike) DO NOTHING`;

    // Neon v1 routes (text, params) call form through sql.query().
    await sql(text, params);
    submitted += chunk.length;
  }

  return submitted;
}

/**
 * Insert a spot price observation into `spot_prices`.
 *
 * The table is created lazily if it doesn't exist (migration-free).
 * Uses ON CONFLICT DO NOTHING so repeated inserts for the same
 * (captured_at, expiry) are idempotent.
 */
export async function insertSpotPrice(
  capturedAt: string,
  expiry: string,
  spot: number,
): Promise<void> {
  const sql = getDb();

  await sql(
    `CREATE TABLE IF NOT EXISTS spot_prices (
       captured_at TIMESTAMPTZ NOT NULL,
       date        DATE NOT NULL,
       spot        NUMERIC(10, 2) NOT NULL,
       PRIMARY KEY (captured_at, date)
     )`,
    [],
  );

  await sql(
    `INSERT INTO spot_prices (captured_at, date, spot)
     VALUES ($1, $2, $3)
     ON CONFLICT (captured_at, date) DO NOTHING`,
    [capturedAt, expiry, spot],
  );
}

/**
 * Batch-insert spot price observations into `spot_prices` (one per
 * 10-min slot). Same lazy table-create + idempotency as the single-row
 * `insertSpotPrice`, but folds a whole day's slots into 500-row chunks
 * so a backfill / read-all run doesn't pay one round-trip per slot.
 *
 * Returns the count of rows submitted (conflicts silently skipped).
 */
export async function insertSpotPrices(
  spots: ReadonlyArray<{ capturedAt: string; expiry: string; spot: number }>,
): Promise<number> {
  if (spots.length === 0) return 0;

  const sql = getDb();

  await sql(
    `CREATE TABLE IF NOT EXISTS spot_prices (
       captured_at TIMESTAMPTZ NOT NULL,
       date        DATE NOT NULL,
       spot        NUMERIC(10, 2) NOT NULL,
       PRIMARY KEY (captured_at, date)
     )`,
    [],
  );

  let submitted = 0;
  for (let i = 0; i < spots.length; i += MAX_ROWS_PER_INSERT) {
    const chunk = spots.slice(i, i + MAX_ROWS_PER_INSERT);

    const placeholders: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    for (const s of chunk) {
      placeholders.push(`($${p++}, $${p++}, $${p++})`);
      params.push(s.capturedAt, s.expiry, s.spot);
    }

    const text =
      `INSERT INTO spot_prices (captured_at, date, spot) ` +
      `VALUES ${placeholders.join(', ')} ` +
      `ON CONFLICT (captured_at, date) DO NOTHING`;

    await sql(text, params);
    submitted += chunk.length;
  }

  return submitted;
}

/**
 * Batch-insert Market Tide observations into `market_tide` (one per
 * 10-min slot). Lazy table-create + idempotent on captured_at.
 * Returns the count of rows submitted (conflicts silently skipped).
 */
export async function insertMarketTide(
  rows: ReadonlyArray<MarketTideRow>,
): Promise<number> {
  if (rows.length === 0) return 0;

  const sql = getDb();

  await sql(
    `CREATE TABLE IF NOT EXISTS market_tide (
       captured_at        TIMESTAMPTZ NOT NULL,
       date               DATE NOT NULL,
       net_call_premium   NUMERIC(18, 4) NOT NULL,
       net_put_premium    NUMERIC(18, 4) NOT NULL,
       net_volume         BIGINT NOT NULL,
       PRIMARY KEY (captured_at)
     )`,
    [],
  );

  let submitted = 0;
  for (let i = 0; i < rows.length; i += MAX_ROWS_PER_INSERT) {
    const chunk = rows.slice(i, i + MAX_ROWS_PER_INSERT);

    const placeholders: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    for (const r of chunk) {
      placeholders.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(
        r.capturedAt,
        r.date,
        r.netCallPremium,
        r.netPutPremium,
        r.netVolume,
      );
    }

    const text =
      `INSERT INTO market_tide ` +
      `(captured_at, date, net_call_premium, net_put_premium, net_volume) ` +
      `VALUES ${placeholders.join(', ')} ` +
      `ON CONFLICT (captured_at) DO NOTHING`;

    await sql(text, params);
    submitted += chunk.length;
  }

  return submitted;
}

/**
 * True if a Cone snapshot already exists for `date`. Used to skip
 * re-scraping/inserting the once-per-day cone param.
 *
 * Tolerates a missing table (returns false) so the first-ever run — when
 * `cone_snapshots` hasn't been lazily created yet — proceeds to scrape.
 */
export async function coneSnapshotExists(date: string): Promise<boolean> {
  const sql = getDb();
  try {
    const rows = (await sql(
      `SELECT 1 FROM cone_snapshots WHERE date = $1 LIMIT 1`,
      [date],
    )) as unknown[];
    return rows.length > 0;
  } catch {
    // Table doesn't exist yet (or transient) — treat as "not present".
    return false;
  }
}

/**
 * Insert the Cone (expected-move) param for a trading day into
 * `cone_snapshots`. Lazy table-create + idempotent on the date PK.
 * Returns true if a row was inserted (false if it already existed).
 */
export async function insertConeSnapshot(row: ConeSnapshotRow): Promise<boolean> {
  const sql = getDb();

  await sql(
    `CREATE TABLE IF NOT EXISTS cone_snapshots (
       date         DATE NOT NULL,
       straddle     NUMERIC(10, 2) NOT NULL,
       captured_at  TIMESTAMPTZ NOT NULL,
       PRIMARY KEY (date)
     )`,
    [],
  );

  const result = (await sql(
    `INSERT INTO cone_snapshots (date, straddle, captured_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (date) DO NOTHING
     RETURNING date`,
    [row.date, row.straddle, row.capturedAt],
  )) as unknown[];

  return result.length > 0;
}
