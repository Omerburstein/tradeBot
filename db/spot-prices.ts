import { getDb, isRthInstant, MAX_ROWS_PER_INSERT } from './client.js';
import { logger } from '../scraper/core/logger.js';

/**
 * Master kill-switch for spot writes — DISABLED for now.
 *
 * UW's API exposes no historical intraday SPX that matches the Periscope price
 * chart for a backfilled date: the only date-respecting source
 * (index_candles/SPX/5m?interval) is a coarser, time-shifted series whose
 * open/close don't equal the chart's, and every 1-minute / date-param endpoint
 * ignores the requested day and returns only the live session. So backfilled
 * spot can't be made chart-accurate. Until we decide how to handle that, skip
 * spot writes entirely (the insert logic below is intact — flip this to `true`
 * to re-enable). Live-tick spot reads the page header, which DOES match the
 * chart, so this can be re-enabled for live-only capture later.
 */
const SPOT_WRITES_ENABLED = true;

const CREATE_SPOT_PRICES_TABLE =
  `CREATE TABLE IF NOT EXISTS spot_prices (` +
  `captured_at TIMESTAMPTZ NOT NULL, ` +
  `date        DATE NOT NULL, ` +
  `spot        NUMERIC(10, 2) NOT NULL, ` +
  `PRIMARY KEY (captured_at, date)` +
  `)`;

export async function insertSpotPrice(
  capturedAt: string,
  expiry: string,
  spot: number,
): Promise<void> {
  if (!SPOT_WRITES_ENABLED) return;
  if (!isRthInstant(capturedAt)) return;

  const sql = getDb();
  await sql(CREATE_SPOT_PRICES_TABLE, []);
  await sql(
    `INSERT INTO spot_prices (captured_at, date, spot) ` +
    `VALUES ($1, $2, $3) ` +
    // Upsert (not DO NOTHING): a re-run must be able to CORRECT an existing
    // row's spot when the source/derivation changes (e.g. close → open),
    // otherwise stale values are pinned forever.
    `ON CONFLICT (captured_at, date) DO UPDATE SET spot = EXCLUDED.spot`,
    [capturedAt, expiry, spot],
  );
}

export async function insertSpotPrices(
  spotsAll: ReadonlyArray<{ capturedAt: string; expiry: string; spot: number }>,
): Promise<number> {
  if (!SPOT_WRITES_ENABLED) {
    logger.info(
      { received: spotsAll.length },
      'insertSpotPrices: SKIPPED — spot writes disabled (SPOT_WRITES_ENABLED=false)',
    );
    return 0;
  }
  const spots = spotsAll.filter((s) => isRthInstant(s.capturedAt));
  const droppedByRth = spotsAll.filter((s) => !isRthInstant(s.capturedAt));
  logger.info(
    {
      received: spotsAll.length,
      keptAfterRthFilter: spots.length,
      droppedByRthFilter: droppedByRth.length,
      droppedSample: droppedByRth.slice(0, 3),
      rows: spots,
    },
    'insertSpotPrices: rows to write (post RTH filter)',
  );
  if (spots.length === 0) {
    logger.warn(
      { received: spotsAll.length },
      'insertSpotPrices: nothing to write (0 rows after RTH filter)',
    );
    return 0;
  }

  const sql = getDb();
  await sql(CREATE_SPOT_PRICES_TABLE, []);

  let inserted = 0;
  for (let i = 0; i < spots.length; i += MAX_ROWS_PER_INSERT) {
    const chunk = spots.slice(i, i + MAX_ROWS_PER_INSERT);

    const placeholders: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    for (const s of chunk) {
      placeholders.push(`($${p++}, $${p++}, $${p++})`);
      params.push(s.capturedAt, s.expiry, s.spot);
    }

    // Upsert so a re-run CORRECTS existing rows (e.g. close → open) instead of
    // pinning stale values. `RETURNING (xmax = 0)` flags each row as a fresh
    // insert (xmax 0) vs an in-place update, so the logs still distinguish
    // them — invaluable when debugging "the value didn't change".
    const text =
      `INSERT INTO spot_prices (captured_at, date, spot) ` +
      `VALUES ${placeholders.join(', ')} ` +
      `ON CONFLICT (captured_at, date) DO UPDATE SET spot = EXCLUDED.spot ` +
      `RETURNING (xmax = 0) AS inserted`;

    try {
      const out = await sql(text, params);
      const rows = Array.isArray(out) ? out : [];
      const newlyInserted = rows.filter(
        (r) => r.inserted === true || r.inserted === 't',
      ).length;
      const updated = rows.length - newlyInserted;
      inserted += rows.length;
      logger.info(
        { chunkSize: chunk.length, newlyInserted, updated },
        'insertSpotPrices: chunk upserted',
      );
    } catch (err) {
      logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
          chunkSize: chunk.length,
          sampleParams: params.slice(0, 3),
        },
        'insertSpotPrices: DB write FAILED',
      );
      throw err;
    }
  }

  logger.info({ totalWritten: inserted }, 'insertSpotPrices: done');
  return inserted;
}
