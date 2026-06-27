import { getDb, isRthInstant, MAX_ROWS_PER_INSERT } from './client.js';
import { logger } from '../scraper/core/logger.js';

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
  if (!isRthInstant(capturedAt)) return;

  const sql = getDb();
  await sql(CREATE_SPOT_PRICES_TABLE, []);
  await sql(
    `INSERT INTO spot_prices (captured_at, date, spot) ` +
    `VALUES ($1, $2, $3) ` +
    `ON CONFLICT (captured_at, date) DO NOTHING`,
    [capturedAt, expiry, spot],
  );
}

export async function insertSpotPrices(
  spotsAll: ReadonlyArray<{ capturedAt: string; expiry: string; spot: number }>,
): Promise<number> {
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

    // RETURNING lets us log how many rows were ACTUALLY inserted vs skipped by
    // ON CONFLICT (already present) — invaluable when debugging "nothing saved".
    const text =
      `INSERT INTO spot_prices (captured_at, date, spot) ` +
      `VALUES ${placeholders.join(', ')} ` +
      `ON CONFLICT (captured_at, date) DO NOTHING ` +
      `RETURNING captured_at`;

    try {
      const out = await sql(text, params);
      const newRows = Array.isArray(out) ? out.length : 0;
      inserted += newRows;
      logger.info(
        { chunkSize: chunk.length, newlyInserted: newRows, conflictsSkipped: chunk.length - newRows },
        'insertSpotPrices: chunk written',
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

  logger.info({ totalNewlyInserted: inserted }, 'insertSpotPrices: done');
  return inserted;
}
