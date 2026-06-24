import type { MarketTideRow } from '../scraper/core/types.js';
import { getDb, isRthRow, MAX_ROWS_PER_INSERT } from './client.js';

export async function insertMarketTide(
  rowsAll: ReadonlyArray<MarketTideRow>,
): Promise<number> {
  const rows = rowsAll.filter((r) => isRthRow(r.capturedAt));
  if (rows.length === 0) return 0;

  const sql = getDb();

  await sql(
    `CREATE TABLE IF NOT EXISTS market_tide (` +
    `captured_at        TIMESTAMPTZ NOT NULL, ` +
    `net_call_premium   NUMERIC(18, 4) NOT NULL, ` +
    `net_put_premium    NUMERIC(18, 4) NOT NULL, ` +
    `net_volume         BIGINT NOT NULL, ` +
    `PRIMARY KEY (captured_at)` +
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
      placeholders.push(`($${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(r.capturedAt, r.netCallPremium, r.netPutPremium, r.netVolume);
    }

    const text =
      `INSERT INTO market_tide ` +
      `(captured_at, net_call_premium, net_put_premium, net_volume) ` +
      `VALUES ${placeholders.join(', ')} ` +
      `ON CONFLICT (captured_at) DO NOTHING`;

    await sql(text, params);
    submitted += chunk.length;
  }

  return submitted;
}
