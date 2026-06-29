import { getDb, isRthInstant, MAX_ROWS_PER_INSERT } from './client.js';
import { logger } from '../scraper/core/logger.js';

/**
 * ES (S&P 500 e-mini futures) price bars — the instrument actually traded, so
 * realized P&L in the backtest/tune is measured off this series (TODO #3).
 *
 * One row per 1-min RTH bar, keyed by the bar's `captured_at` UTC instant. `date`
 * is the ET trading day (denormalised for cheap per-day range scans, same shape
 * as `spot_prices`). Volume is nullable — some ES exports omit it.
 *
 * Distinct from `spot_prices` (which holds the SPX cash index): ES is futures
 * and carries a basis over SPX, so the two series are stored separately. The
 * ingest pipeline derives SPX from ES (see `scripts/lib/es-spx.ts`) and writes
 * the cash series into `spot_prices`.
 */

export interface EsPriceRow {
  capturedAt: string; // UTC ISO-8601 — the bar's ET instant
  date: string; // ET trading day, YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

const CREATE_ES_PRICES_TABLE =
  `CREATE TABLE IF NOT EXISTS es_prices (` +
  `captured_at TIMESTAMPTZ NOT NULL, ` +
  `date        DATE NOT NULL, ` +
  `open        NUMERIC(10, 2) NOT NULL, ` +
  `high        NUMERIC(10, 2) NOT NULL, ` +
  `low         NUMERIC(10, 2) NOT NULL, ` +
  `close       NUMERIC(10, 2) NOT NULL, ` +
  `volume      BIGINT, ` +
  `PRIMARY KEY (captured_at)` +
  `)`;

// `date` is the natural per-day filter for the P&L loader; index it so range
// scans over a trading day don't seq-scan the whole table.
const CREATE_ES_PRICES_DATE_INDEX =
  `CREATE INDEX IF NOT EXISTS es_prices_date_idx ON es_prices (date)`;

/**
 * Bulk-upsert ES bars. RTH-gated (09:30–16:00 ET) via `isRthInstant`, mirroring
 * the spot/Market-Tide paths. Upserts (not DO NOTHING) so a re-ingest CORRECTS
 * an existing bar (e.g. switching to a cleaner front-month contract) rather than
 * pinning stale values. Returns the number of rows written (inserted + updated).
 */
export async function insertEsPrices(
  rowsAll: ReadonlyArray<EsPriceRow>,
): Promise<number> {
  const rows = rowsAll.filter((r) => isRthInstant(r.capturedAt));
  const droppedByRth = rowsAll.length - rows.length;
  logger.info(
    {
      received: rowsAll.length,
      keptAfterRthFilter: rows.length,
      droppedByRthFilter: droppedByRth,
    },
    'insertEsPrices: rows to write (post RTH filter)',
  );
  if (rows.length === 0) {
    logger.warn(
      { received: rowsAll.length },
      'insertEsPrices: nothing to write (0 rows after RTH filter)',
    );
    return 0;
  }

  const sql = getDb();
  await sql(CREATE_ES_PRICES_TABLE, []);
  await sql(CREATE_ES_PRICES_DATE_INDEX, []);

  let written = 0;
  for (let i = 0; i < rows.length; i += MAX_ROWS_PER_INSERT) {
    const chunk = rows.slice(i, i + MAX_ROWS_PER_INSERT);

    const placeholders: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    for (const r of chunk) {
      placeholders.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(r.capturedAt, r.date, r.open, r.high, r.low, r.close, r.volume);
    }

    const text =
      `INSERT INTO es_prices (captured_at, date, open, high, low, close, volume) ` +
      `VALUES ${placeholders.join(', ')} ` +
      `ON CONFLICT (captured_at) DO UPDATE SET ` +
      `date = EXCLUDED.date, open = EXCLUDED.open, high = EXCLUDED.high, ` +
      `low = EXCLUDED.low, close = EXCLUDED.close, volume = EXCLUDED.volume ` +
      `RETURNING (xmax = 0) AS inserted`;

    try {
      const out = await sql(text, params);
      const outRows = Array.isArray(out) ? out : [];
      const newlyInserted = outRows.filter(
        (r) => r.inserted === true || r.inserted === 't',
      ).length;
      written += outRows.length;
      logger.info(
        { chunkSize: chunk.length, newlyInserted, updated: outRows.length - newlyInserted },
        'insertEsPrices: chunk upserted',
      );
    } catch (err) {
      logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
          chunkSize: chunk.length,
          sampleParams: params.slice(0, 7),
        },
        'insertEsPrices: DB write FAILED',
      );
      throw err;
    }
  }

  logger.info({ totalWritten: written }, 'insertEsPrices: done');
  return written;
}
