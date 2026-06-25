import type { MarketTideRow } from '../scraper/core/types.js';
import { getDb, isRthRow, MAX_ROWS_PER_INSERT } from './client.js';
import { logger } from '../scraper/core/logger.js';

export async function insertMarketTide(
  rowsAll: ReadonlyArray<MarketTideRow>,
): Promise<number> {
  const rows = rowsAll.filter((r) => isRthRow(r.capturedAt));
  const droppedByRth = rowsAll.filter((r) => !isRthRow(r.capturedAt));
  logger.info(
    {
      received: rowsAll.length,
      keptAfterRthFilter: rows.length,
      droppedByRthFilter: droppedByRth.length,
      rows,
    },
    'insertMarketTide: rows to write (post RTH filter)',
  );
  if (rows.length === 0) {
    logger.warn(
      { received: rowsAll.length },
      'insertMarketTide: nothing to write (0 rows after RTH filter)',
    );
    return 0;
  }

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

  let inserted = 0;
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
      `ON CONFLICT (captured_at) DO NOTHING ` +
      `RETURNING captured_at`;

    try {
      const out = await sql(text, params);
      const newRows = Array.isArray(out) ? out.length : 0;
      inserted += newRows;
      logger.info(
        { chunkSize: chunk.length, newlyInserted: newRows, conflictsSkipped: chunk.length - newRows },
        'insertMarketTide: chunk written',
      );
    } catch (err) {
      logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
          chunkSize: chunk.length,
          sampleParams: params.slice(0, 4),
        },
        'insertMarketTide: DB write FAILED',
      );
      throw err;
    }
  }

  logger.info({ totalNewlyInserted: inserted }, 'insertMarketTide: done');
  return inserted;
}
