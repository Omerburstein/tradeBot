/**
 * Neon Postgres helpers for periscope_snapshots inserts.
 *
 * Uses a singleton serverless client and batches inserts (max 500 rows per
 * SQL call) per the parent repo's `feedback_batched_inserts.md` convention.
 * Per-row inserts in a loop are 50–100x slower on Neon serverless.
 */

import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import { DATABASE_URL } from './config.js';
import type { SnapshotRow } from './types.js';

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
