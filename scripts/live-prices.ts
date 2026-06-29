/**
 * live-prices.ts — LIVE SPX + ES feed into Neon Postgres (TODO #7).
 *
 * The companion to the historical CSV ingest (`scripts/ingest-prices.ts`): where
 * that backfills a one-off ES CSV, this pulls the CURRENT session's 1-min bars
 * straight from Yahoo's chart API and upserts them into the SAME tables, so the
 * live series sits alongside the backfilled data and the algo can read current
 * prices during an active session.
 *
 *   node --env-file=.env --import=tsx/esm scripts/live-prices.ts [--loop 60]
 *   # or: npm run live -- --loop 60
 *
 * WHY NO ES→SPX CONVERSION HERE (unlike the CSV ingest)
 * ----------------------------------------------------
 * The CSV ingest only has ES, so it DERIVES SPX via the Yahoo-anchored basis
 * calibration (`scripts/lib/es-spx.ts`). Live, we have BOTH real feeds — Yahoo's
 * `^GSPC` IS the S&P 500 cash index (== CBOE:SPX) — so SPX is written directly
 * from `^GSPC` (exact, 0 pt error) and ES OHLCV from `ES=F`. No basis math, no
 * accuracy gate needed.
 *
 *   • `ES=F`  → es_prices   (OHLCV, the traded instrument → P&L, TODO #3)
 *   • `^GSPC` → spot_prices (close as `spot`, the signal input, TODO #2)
 *
 * Both inserts are RTH-gated + idempotent upserts in the DB layer, so re-polling
 * the same minute corrects the in-progress bar rather than duplicating it.
 *
 * OPTIONS
 *   --loop <seconds>   Poll forever every N seconds (min 5). Omit = one-shot.
 *   --es-symbol <s>    Yahoo futures symbol (default ES=F).
 *   --spx-symbol <s>   Yahoo cash-index symbol (default ^GSPC).
 *   --day <YYYY-MM-DD> ET trading day to write (default: latest day in the feed).
 *   --range <r>        Yahoo lookback window (default 1d; '5d' to catch a gap).
 *   --dry-run          Fetch + print row counts, write NOTHING to the DB.
 *   --help             Print this help.
 */

import {
  fetchYahoo1mByDay,
  etBarToUtcIso,
  todayIsoEt,
  DEFAULT_SPX_SYMBOL,
  type Yahoo1mBar,
} from './lib/es-spx.js';
import { makeFlagGetter } from './lib/cli.js';

const DEFAULT_ES_SYMBOL = 'ES=F'; // Yahoo's continuous front-month future
const MIN_LOOP_SECONDS = 5; // don't hammer Yahoo (it rate-limits)

interface Args {
  loopSeconds: number | null; // null = one-shot
  esSymbol: string;
  spxSymbol: string;
  day: string | null; // null = latest day present in the feed
  range: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = makeFlagGetter(argv);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      [
        'live-prices — poll live ES + SPX 1-min bars into Postgres.',
        '',
        'Usage: node --env-file=.env --import=tsx/esm scripts/live-prices.ts \\',
        '         [--loop 60] [--es-symbol ES=F] [--spx-symbol ^GSPC] \\',
        '         [--day YYYY-MM-DD] [--range 1d] [--dry-run]',
      ].join('\n'),
    );
    process.exit(0);
  }

  const loopRaw = get('--loop');
  let loopSeconds: number | null = null;
  if (loopRaw !== undefined) {
    const n = Number.parseInt(loopRaw, 10);
    if (!Number.isFinite(n) || n < MIN_LOOP_SECONDS) {
      console.error(`ERROR: --loop must be an integer >= ${MIN_LOOP_SECONDS} (got "${loopRaw}")`);
      process.exit(1);
    }
    loopSeconds = n;
  }

  return {
    loopSeconds,
    esSymbol: get('--es-symbol') ?? DEFAULT_ES_SYMBOL,
    spxSymbol: get('--spx-symbol') ?? DEFAULT_SPX_SYMBOL,
    day: get('--day') ?? null,
    range: get('--range') ?? '1d',
    dryRun: argv.includes('--dry-run'),
  };
}

/** Latest ET day present in either feed (the live session during RTH). */
function pickDay(
  explicit: string | null,
  esByDay: Map<string, Yahoo1mBar[]>,
  spxByDay: Map<string, Yahoo1mBar[]>,
): string | null {
  if (explicit) return explicit;
  const days = new Set([...esByDay.keys(), ...spxByDay.keys()]);
  if (days.size === 0) return null;
  return [...days].sort().at(-1) ?? null;
}

// DB writers, imported lazily so --dry-run / --help work without a DATABASE_URL.
type DbWriters = {
  insertEsPrices: typeof import('../db/index.js').insertEsPrices;
  insertSpotPrices: typeof import('../db/index.js').insertSpotPrices;
};

/**
 * One poll: fetch both feeds, write the chosen day's bars whose minute is newer
 * than `cursor` (re-including the latest written minute so the in-progress bar
 * settles). Returns the high-water minute-of-day actually seen, or `cursor`
 * unchanged when there was nothing new.
 */
async function pollOnce(args: Args, cursor: number, db: DbWriters | null): Promise<number> {
  const [esByDay, spxByDay] = await Promise.all([
    fetchYahoo1mByDay(args.esSymbol, args.range),
    fetchYahoo1mByDay(args.spxSymbol, args.range),
  ]);

  const day = pickDay(args.day, esByDay, spxByDay);
  if (!day) {
    console.error(`${new Date().toISOString()} no bars in either feed yet (market closed?).`);
    return cursor;
  }

  const esBars = (esByDay.get(day) ?? []).filter((b) => b.minOfDay >= cursor);
  const spxBars = (spxByDay.get(day) ?? []).filter((b) => b.minOfDay >= cursor);
  const latestMin = Math.max(
    cursor,
    ...esBars.map((b) => b.minOfDay),
    ...spxBars.map((b) => b.minOfDay),
  );

  const esRows = esBars.map((b) => ({
    capturedAt: etBarToUtcIso(b.dateKey, b.minOfDay),
    date: b.dateKey,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  }));
  // ^GSPC is the cash index directly — its close IS the SPX spot, no basis.
  const spotRows = spxBars.map((b) => ({
    capturedAt: etBarToUtcIso(b.dateKey, b.minOfDay),
    expiry: b.dateKey, // spot_prices `date` column = ET trading day
    spot: Number(b.close.toFixed(2)),
  }));

  const stamp = new Date().toISOString();
  if (args.dryRun || !db) {
    console.error(
      `${stamp} ${day}: ${esRows.length} ES + ${spotRows.length} SPX new bars ` +
        `(--dry-run, nothing written).`,
    );
    if (esRows[0]) console.error('  es_prices[0]   :', JSON.stringify(esRows[0]));
    if (spotRows[0]) console.error('  spot_prices[0] :', JSON.stringify(spotRows[0]));
    return latestMin;
  }

  const [esWritten, spotWritten] = await Promise.all([
    esRows.length ? db.insertEsPrices(esRows) : Promise.resolve(0),
    spotRows.length ? db.insertSpotPrices(spotRows) : Promise.resolve(0),
  ]);
  console.error(
    `${stamp} ${day}: es_prices +${esWritten}, spot_prices +${spotWritten} ` +
      `(through minute ${Math.floor(latestMin / 60)}:${String(latestMin % 60).padStart(2, '0')} ET).`,
  );
  return latestMin;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const db: DbWriters | null = args.dryRun
    ? null
    : await import('../db/index.js').then((m) => ({
        insertEsPrices: m.insertEsPrices,
        insertSpotPrices: m.insertSpotPrices,
      }));

  console.error(
    `live-prices: ${args.esSymbol} → es_prices, ${args.spxSymbol} → spot_prices ` +
      `(day=${args.day ?? 'latest'}, range=${args.range}` +
      `${args.loopSeconds ? `, loop=${args.loopSeconds}s` : ', one-shot'}` +
      `${args.dryRun ? ', DRY-RUN' : ''}).`,
  );

  if (args.loopSeconds === null) {
    await pollOnce(args, 0, db);
    return;
  }

  // Loop forever; a single failed poll (Yahoo blip) logs and retries next tick
  // rather than killing the feed. Reset the cursor at each new ET day so a long-
  // running process keeps writing after the session rolls over.
  let cursor = 0;
  let activeDay = args.day ?? todayIsoEt();
  for (;;) {
    const today = args.day ?? todayIsoEt();
    if (today !== activeDay) {
      activeDay = today;
      cursor = 0;
    }
    try {
      cursor = await pollOnce(args, cursor, db);
    } catch (e) {
      console.error(`${new Date().toISOString()} poll failed (will retry): ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, args.loopSeconds! * 1000));
  }
}

main().catch((e) => {
  console.error(`FATAL: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
