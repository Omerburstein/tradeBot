import type { SnapshotRow } from '../scraper/core/types.js';
import { getDb, isRthRow, MAX_ROWS_PER_INSERT } from './client.js';

const GAMMA_MIN_VALUE = 150;

/** Identity of a single strike observation, shared across the three panels. */
function strikeKey(row: SnapshotRow): string {
  return `${row.capturedAt}|${row.expiry}|${row.strike}`;
}

/** True for a gamma row whose magnitude clears the persistence threshold. */
function isQualifyingGamma(row: SnapshotRow): boolean {
  return row.panel === 'gamma' && Math.abs(row.value) > GAMMA_MIN_VALUE;
}

/**
 * Pure batch-level filter applied before every DB insert.
 * Exported so unit tests can exercise filtering without a live DB connection.
 *
 * Rules (a row must pass ALL):
 *   1. capturedAt falls within the persisted RTH window (09:40–16:00 ET).
 *   2. gamma rows survive only when |value| > GAMMA_MIN_VALUE.
 *   3. charm/vanna rows survive only when value !== 0 AND the same
 *      (capturedAt, expiry, strike) carries a qualifying gamma in the batch.
 *      Gamma is the anchor: a Greek reading at a strike with no meaningful
 *      gamma carries no signal worth persisting.
 */
export function filterInsertable(rows: SnapshotRow[]): SnapshotRow[] {
  const rthRows = rows.filter((row) => isRthRow(row.capturedAt));

  const qualifyingGammaStrikes = new Set<string>();
  for (const row of rthRows) {
    if (isQualifyingGamma(row)) qualifyingGammaStrikes.add(strikeKey(row));
  }

  return rthRows.filter((row) => {
    if (row.panel === 'gamma') return isQualifyingGamma(row);
    return row.value !== 0 && qualifyingGammaStrikes.has(strikeKey(row));
  });
}

export async function insertSnapshots(rows: SnapshotRow[]): Promise<number> {
  const insertable = filterInsertable(rows);
  if (insertable.length === 0) return 0;

  const sql = getDb();
  let submitted = 0;

  for (let i = 0; i < insertable.length; i += MAX_ROWS_PER_INSERT) {
    const chunk = insertable.slice(i, i + MAX_ROWS_PER_INSERT);

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

    await sql(text, params);
    submitted += chunk.length;
  }

  return submitted;
}
