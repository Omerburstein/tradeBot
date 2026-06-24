import { getDb, isRthRow, MAX_ROWS_PER_INSERT } from './client.js';

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
  if (!isRthRow(capturedAt)) return;

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
  const spots = spotsAll.filter((s) => isRthRow(s.capturedAt));
  if (spots.length === 0) return 0;

  const sql = getDb();
  await sql(CREATE_SPOT_PRICES_TABLE, []);

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
