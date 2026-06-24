import type { PositionRow } from '../scraper/core/types.js';
import { getDb, isRthRow, MAX_ROWS_PER_INSERT } from './client.js';

export async function insertPositions(
  rowsAll: ReadonlyArray<PositionRow>,
): Promise<number> {
  const rows = rowsAll.filter((r) => isRthRow(r.capturedAt));
  if (rows.length === 0) return 0;

  const sql = getDb();

  await sql(
    `CREATE TABLE IF NOT EXISTS positions (` +
    `captured_at  TIMESTAMPTZ NOT NULL, ` +
    `expiry       DATE NOT NULL, ` +
    `strike       NUMERIC(10, 2) NOT NULL, ` +
    `call_qty     BIGINT NOT NULL, ` +
    `put_qty      BIGINT NOT NULL, ` +
    `timeframe    TEXT NOT NULL, ` +
    `PRIMARY KEY (captured_at, expiry, strike)` +
    `)`,
    [],
  );

  let submitted = 0;
  for (let i = 0; i < rows.length; i += MAX_ROWS_PER_INSERT) {
    const chunk = rows.slice(i, i + MAX_ROWS_PER_INSERT);

    const placeholders: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    for (const r of chunk) {
      placeholders.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(r.capturedAt, r.expiry, r.strike, r.callQty, r.putQty, r.timeframe);
    }

    const text =
      `INSERT INTO positions ` +
      `(captured_at, expiry, strike, call_qty, put_qty, timeframe) ` +
      `VALUES ${placeholders.join(', ')} ` +
      `ON CONFLICT (captured_at, expiry, strike) DO NOTHING`;

    await sql(text, params);
    submitted += chunk.length;
  }

  return submitted;
}
