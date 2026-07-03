/**
 * backfill-prices.ts — HISTORICAL SPX + ES 1-min backfill from Yahoo (TODO #7).
 *
 * The gap-filler between the live feed (`scripts/live-prices.ts`, capped at
 * Yahoo's ~8-day `range`) and the CSV ingest (`scripts/ingest-prices.ts`, which
 * needs a local ES file). This walks an arbitrary [start,end] window using
 * Yahoo's `period1/period2` chart API — the ONLY way to reach past days beyond
 * the live `range` window — and upserts both real feeds into the same tables:
 *
 *   • `ES=F`  → es_prices   (OHLCV, the traded instrument → P&L, TODO #3)
 *   • `^GSPC` → spot_prices (close as `spot`, the signal input, TODO #2)
 *
 * Like `live-prices.ts`, both feeds are real (no ES→SPX basis math) and the DB
 * writes are RTH-gated, idempotent upserts — so re-running CORRECTS existing bars
 * rather than duplicating them.
 *
 * YAHOO'S TWO 1-MIN LIMITS (both enforced here):
 *   1. History floor: 1-min data only exists for the last ~30 days. Chunks older
 *      than that return HTTP 422 — logged and skipped, not fatal, so the run
 *      still writes every reachable day.
 *   2. Span cap: a single request may span at most 8 days. We chunk the window
 *      into {@link CHUNK_DAYS}-day slices to stay under it.
 *
 *   node --env-file=.env --import=tsx/esm scripts/backfill-prices.ts \
 *     [--start 2025-12-29] [--end YYYY-MM-DD] [--es-symbol ES=F] \
 *     [--spx-symbol ^GSPC] [--dry-run]
 *   # or: npm run backfill-prices -- --dry-run
 *
 * OPTIONS
 *   --start <date>     ISO start date inclusive (default 2025-12-29, dataset floor).
 *   --end <date>       ISO end date inclusive (default today, ET).
 *   --es-symbol <s>    Yahoo futures symbol (default ES=F).
 *   --spx-symbol <s>   Yahoo cash-index symbol (default ^GSPC).
 *   --dry-run          Fetch + print per-day counts, write NOTHING to the DB.
 *   --help             Print this help.
 */

import {
  fetchYahoo1mByPeriod,
  etBarToUtcIso,
  todayIsoEt,
  DEFAULT_SPX_SYMBOL,
  DEFAULT_START,
  type Yahoo1mBar,
} from './lib/es-spx.js';
import { makeFlagGetter } from './lib/cli.js';

const DEFAULT_ES_SYMBOL = 'ES=F'; // Yahoo's continuous front-month future
const CHUNK_DAYS = 7; // stay safely under Yahoo's 8-day-per-request 1m cap
const MS_PER_DAY = 86_400_000;

interface Args {
  start: string;
  end: string;
  esSymbol: string;
  spxSymbol: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = makeFlagGetter(argv);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      [
        'backfill-prices — backfill historical ES + SPX 1-min bars from Yahoo.',
        '',
        'Usage: node --env-file=.env --import=tsx/esm scripts/backfill-prices.ts \\',
        '         [--start 2025-12-29] [--end YYYY-MM-DD] [--es-symbol ES=F] \\',
        '         [--spx-symbol ^GSPC] [--dry-run]',
        '',
        'NOTE: Yahoo only serves 1-min data for ~the last 30 days; older chunks',
        '      are skipped (HTTP 422). For earlier days use scripts/ingest-prices.ts',
        '      with an ES CSV.',
      ].join('\n'),
    );
    process.exit(0);
  }
  return {
    start: get('--start') ?? DEFAULT_START,
    end: get('--end') ?? todayIsoEt(),
    esSymbol: get('--es-symbol') ?? DEFAULT_ES_SYMBOL,
    spxSymbol: get('--spx-symbol') ?? DEFAULT_SPX_SYMBOL,
    dryRun: argv.includes('--dry-run'),
  };
}

/** Merge one chunk's per-day bars into the running accumulator (chunks don't
 *  overlap, so a plain set is safe; a re-seen day just overwrites identically). */
function mergeByDay(
  into: Map<string, Yahoo1mBar[]>,
  chunk: Map<string, Yahoo1mBar[]>,
): void {
  for (const [day, bars] of chunk) into.set(day, bars);
}

/**
 * Fetch both feeds across [start,end] in ≤CHUNK_DAYS windows. Chunks Yahoo
 * refuses (422 — older than the 1-min history floor) are logged and skipped so
 * the run still writes every reachable day. Returns each feed grouped by ET day.
 */
async function fetchWindow(
  args: Args,
): Promise<{ spx: Map<string, Yahoo1mBar[]>; es: Map<string, Yahoo1mBar[]>; skipped: string[] }> {
  const startMs = Date.parse(`${args.start}T00:00:00Z`);
  const endMs = Date.parse(`${args.end}T00:00:00Z`) + MS_PER_DAY; // inclusive end day
  const spx = new Map<string, Yahoo1mBar[]>();
  const es = new Map<string, Yahoo1mBar[]>();
  const skipped: string[] = [];

  for (let s = startMs; s < endMs; s += CHUNK_DAYS * MS_PER_DAY) {
    const e = Math.min(s + CHUNK_DAYS * MS_PER_DAY, endMs);
    const p1 = Math.floor(s / 1000);
    const p2 = Math.floor(e / 1000);
    const label = `${new Date(s).toISOString().slice(0, 10)}..${new Date(e - MS_PER_DAY).toISOString().slice(0, 10)}`;
    try {
      const [spxChunk, esChunk] = await Promise.all([
        fetchYahoo1mByPeriod(args.spxSymbol, p1, p2),
        fetchYahoo1mByPeriod(args.esSymbol, p1, p2),
      ]);
      mergeByDay(spx, spxChunk);
      mergeByDay(es, esChunk);
      const days = new Set([...spxChunk.keys(), ...esChunk.keys()]).size;
      console.error(`  chunk ${label}: ${days} trading day(s) fetched.`);
    } catch (err) {
      const msg = (err as Error).message;
      // HTTP 422 = older than Yahoo's 1-min history floor. Expected for the
      // early part of the dataset; skip and keep going.
      skipped.push(label);
      console.error(`  chunk ${label}: SKIPPED (${msg.includes('422') ? 'older than Yahoo 1m floor' : msg}).`);
    }
  }
  return { spx, es, skipped };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.error(
    `backfill-prices: ${args.esSymbol} → es_prices, ${args.spxSymbol} → spot_prices ` +
      `(${args.start} → ${args.end}${args.dryRun ? ', DRY-RUN' : ''}).`,
  );

  const { spx, es, skipped } = await fetchWindow(args);

  // Build rows exactly like live-prices: ^GSPC close IS the SPX spot (no basis),
  // ES=F carries full OHLCV. Each keyed on the bar's ET instant so both series
  // join the Greeks on captured_at.
  const esRows = [...es.values()].flat().map((b) => ({
    capturedAt: etBarToUtcIso(b.dateKey, b.minOfDay),
    date: b.dateKey,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  }));
  const spotRows = [...spx.values()].flat().map((b) => ({
    capturedAt: etBarToUtcIso(b.dateKey, b.minOfDay),
    expiry: b.dateKey, // spot_prices `date` column = ET trading day
    spot: Number(b.close.toFixed(2)),
  }));

  const esDays = [...es.keys()].sort();
  const spxDays = [...spx.keys()].sort();
  console.error('');
  console.error(
    `Fetched ${esRows.length} ES bars over ${esDays.length} day(s) ` +
      `(${esDays[0] ?? '-'} → ${esDays[esDays.length - 1] ?? '-'}), ` +
      `${spotRows.length} SPX bars over ${spxDays.length} day(s) ` +
      `(${spxDays[0] ?? '-'} → ${spxDays[spxDays.length - 1] ?? '-'}).`,
  );
  if (skipped.length) {
    console.error(
      `Skipped ${skipped.length} chunk(s) older than Yahoo's 1-min floor ` +
        `(use ingest-prices.ts + an ES CSV for those): ${skipped.join(', ')}`,
    );
  }

  if (args.dryRun) {
    console.error('--dry-run: nothing written. Sample rows:');
    if (esRows[0]) console.error('  es_prices[0]   :', JSON.stringify(esRows[0]));
    if (spotRows[0]) console.error('  spot_prices[0] :', JSON.stringify(spotRows[0]));
    return;
  }

  if (esRows.length === 0 && spotRows.length === 0) {
    console.error('Nothing to write (no bars in range — all chunks skipped?).');
    return;
  }

  // Imported here (not at top) so --dry-run / --help work without a DATABASE_URL.
  const { insertEsPrices, insertSpotPrices } = await import('../db/index.js');
  const [esWritten, spotWritten] = await Promise.all([
    esRows.length ? insertEsPrices(esRows) : Promise.resolve(0),
    spotRows.length ? insertSpotPrices(spotRows) : Promise.resolve(0),
  ]);

  console.error('');
  console.error(`✓ es_prices:   ${esWritten} rows written`);
  console.error(`✓ spot_prices: ${spotWritten} rows written`);
}

main().catch((e) => {
  console.error(`FATAL: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
