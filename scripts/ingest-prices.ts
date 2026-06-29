/**
 * ingest-prices.ts — load ES + SPX price series into Neon Postgres.
 *
 * NOT part of the scraper loop. Run on demand:
 *
 *   node --env-file=.env --import=tsx/esm scripts/ingest-prices.ts --es <es.csv>
 *   # or: npm run ingest -- --es <es.csv>
 *
 * Takes ONE ES CSV as input. It:
 *   1. parses the ES 1-min RTH bars (reusing scripts/lib/es-spx.ts),
 *   2. derives the SPX cash series from those bars via the Yahoo-anchored basis
 *      calibration (the same converter `es-to-spx.ts` and the accuracy test use),
 *   3. writes ES OHLCV into the `es_prices` table, and
 *   4. writes the derived SPX close into the existing `spot_prices` table
 *      (keyed by captured_at + trading day), so the algo can read real SPX as
 *      its signal input (TODO #2) and real ES for P&L (TODO #3).
 *
 * OPTIONS (same surface as es-to-spx.ts, plus --dry-run)
 *   --es <path>        ES input CSV (required).
 *   --tz <iana>        Timezone the ES timestamps are in (default America/New_York).
 *   --start <date>     ISO start date inclusive (default 2025-12-29).
 *   --end <date>       ISO end date inclusive (default today, ET).
 *   --spx-symbol <s>   Yahoo symbol for the cash index (default ^GSPC).
 *   --dateformat <f>   iso | us | eu | auto (default auto).
 *   --anchor <mode>    close (default) | openclose. See es-to-spx.ts.
 *   --dry-run          Parse + convert, print row counts, write NOTHING to DB.
 *   --help             Print this help.
 */

import {
  convertEsToSpx,
  etBarToUtcIso,
  fetchSpxDaily,
  parseEsCsv,
  todayIsoEt,
  type Anchor,
  type DateFormat,
} from './lib/es-spx.js';

const DEFAULT_START = '2025-12-29';

interface Args {
  es: string;
  tz: string;
  start: string;
  end: string;
  spxSymbol: string;
  dateFormat: DateFormat;
  anchor: Anchor;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      [
        'ingest-prices — load ES + derived SPX bars into Postgres.',
        '',
        'Usage: node --env-file=.env --import=tsx/esm scripts/ingest-prices.ts \\',
        '         --es <path.csv> [--tz America/New_York] [--start 2025-12-29] \\',
        '         [--end YYYY-MM-DD] [--spx-symbol ^GSPC] [--dateformat auto] \\',
        '         [--anchor close] [--dry-run]',
      ].join('\n'),
    );
    process.exit(0);
  }
  const es = get('--es');
  if (!es) {
    console.error('ERROR: --es <path> is required.');
    process.exit(1);
  }
  const df = (get('--dateformat') ?? 'auto').toLowerCase();
  if (!['iso', 'us', 'eu', 'auto'].includes(df)) {
    console.error(`ERROR: --dateformat must be iso|us|eu|auto (got "${df}")`);
    process.exit(1);
  }
  const anchor = (get('--anchor') ?? 'close').toLowerCase();
  if (!['close', 'openclose'].includes(anchor)) {
    console.error(`ERROR: --anchor must be close|openclose (got "${anchor}")`);
    process.exit(1);
  }
  return {
    es,
    tz: get('--tz') ?? 'America/New_York',
    start: get('--start') ?? DEFAULT_START,
    end: get('--end') ?? todayIsoEt(),
    spxSymbol: get('--spx-symbol') ?? '^GSPC',
    dateFormat: df as DateFormat,
    anchor: anchor as Anchor,
    dryRun: argv.includes('--dry-run'),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const fs = await import('node:fs/promises');

  console.error(`Reading ES file: ${args.es}`);
  let content: string;
  try {
    content = await fs.readFile(args.es, 'utf8');
  } catch (e) {
    console.error(`ERROR: cannot read --es file "${args.es}": ${(e as Error).message}`);
    process.exit(1);
  }

  const { bars, byDay, days, parseFailures } = parseEsCsv(content, {
    tz: args.tz,
    dateFormat: args.dateFormat,
    start: args.start,
    end: args.end,
  });
  if (bars.length === 0) {
    console.error(
      'ERROR: no RTH bars parsed. Check --tz, --dateformat, and the date range.',
    );
    if (parseFailures > 0) console.error(`(${parseFailures} rows failed to parse)`);
    process.exit(1);
  }

  console.error(
    `Parsed ${bars.length} RTH bars across ${days.length} days ` +
      `(${days[0]} → ${days[days.length - 1]}). Fetching SPX daily…`,
  );

  const spx = await fetchSpxDaily(args.spxSymbol, args.start, args.end);
  const result = convertEsToSpx(byDay, days, spx, args.anchor);
  for (const w of result.warnings) console.error(w);

  // Both series come from the same converted bar list, so ES and SPX rows are
  // aligned on captured_at and holidays are already dropped.
  const esRows = result.bars.map((b) => ({
    capturedAt: etBarToUtcIso(b.dateKey, b.minOfDay),
    date: b.dateKey,
    open: b.esOpen,
    high: b.esHigh,
    low: b.esLow,
    close: b.esClose,
    volume: b.esVolume,
  }));
  const spotRows = result.bars.map((b) => ({
    capturedAt: etBarToUtcIso(b.dateKey, b.minOfDay),
    expiry: b.dateKey, // spot_prices `date` column = ET trading day
    spot: Number(b.spxClose.toFixed(2)),
  }));

  console.error(
    `Converted ${result.bars.length} bars → es_prices (ES OHLCV) + ` +
      `spot_prices (SPX close), anchor=${args.anchor}.`,
  );

  if (args.dryRun) {
    console.error('--dry-run: nothing written. Sample rows:');
    console.error('  es_prices[0]   :', JSON.stringify(esRows[0]));
    console.error('  spot_prices[0] :', JSON.stringify(spotRows[0]));
    return;
  }

  // Imported here (not at top) so --dry-run / --help work without a DATABASE_URL
  // — db/index.js → config.ts validates DATABASE_URL at module load.
  const { insertEsPrices, insertSpotPrices } = await import('../db/index.js');
  const esWritten = await insertEsPrices(esRows);
  const spotWritten = await insertSpotPrices(spotRows);

  console.error('');
  console.error(`✓ es_prices:   ${esWritten} rows written`);
  console.error(`✓ spot_prices: ${spotWritten} rows written (SPX close)`);
  if (parseFailures > 0) {
    console.error(`  (${parseFailures} input rows failed to parse and were skipped.)`);
  }
}

main().catch((e) => {
  console.error(`FATAL: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
