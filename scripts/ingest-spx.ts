/**
 * ingest-spx.ts — load the EXACT SPX cash index (Polygon I:SPX 1-min bars) into
 * the spot_prices table.
 *
 * NOT part of the scraper loop. Run on demand:
 *
 *   node --env-file=.env --import=tsx/esm scripts/ingest-spx.ts \
 *     --csv docs/temp/spx-1min.csv --replace
 *   # or: npm run ingest-spx -- --csv docs/temp/spx-1min.csv --replace
 *
 * The companion to fetch_spx.py (which downloads I:SPX). Unlike ingest-prices.ts
 * (ES/SPY → SPX via a per-day basis calibration), this needs NO conversion: I:SPX
 * IS the S&P 500 index (== CBOE:SPX), so each bar's close is written straight to
 * spot_prices as the spot. This is the authoritative signal source — exact, with
 * no ETF tracking error or futures basis.
 *
 * --replace deletes every existing spot row in the ingested day range BEFORE
 * inserting, so a swap from a derived proxy (SPY×10 / ES-derived / Yahoo) to the
 * real index can't leave stale timestamps behind. Without it, rows are upserted
 * (existing bars corrected, others kept).
 *
 * OPTIONS
 *   --csv <path>    Input CSV (Datetime,Open,High,Low,Close,Volume). Default
 *                   docs/temp/spx-1min.csv.
 *   --tz <iana>     Timezone the CSV timestamps are in (default America/New_York).
 *   --start <date>  ISO start date inclusive (default 2025-12-29).
 *   --end <date>    ISO end date inclusive (default today, ET).
 *   --replace       Delete existing spot_prices in the ingested day range first.
 *   --dry-run       Parse + print counts, write NOTHING.
 *   --help          Print this help.
 */

import {
  parseEsCsv,
  etBarToUtcIso,
  todayIsoEt,
  DEFAULT_START,
  MARKET_TZ,
} from './lib/es-spx.js';
import { makeFlagGetter } from './lib/cli.js';

interface Args {
  csv: string;
  tz: string;
  start: string;
  end: string;
  replace: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = makeFlagGetter(argv);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      [
        'ingest-spx — load exact I:SPX 1-min bars into spot_prices (no conversion).',
        '',
        'Usage: node --env-file=.env --import=tsx/esm scripts/ingest-spx.ts \\',
        '         [--csv docs/temp/spx-1min.csv] [--tz America/New_York] \\',
        '         [--start 2025-12-29] [--end YYYY-MM-DD] [--replace] [--dry-run]',
      ].join('\n'),
    );
    process.exit(0);
  }
  return {
    csv: get('--csv') ?? 'docs/temp/spx-1min.csv',
    tz: get('--tz') ?? MARKET_TZ,
    start: get('--start') ?? DEFAULT_START,
    end: get('--end') ?? todayIsoEt(),
    replace: argv.includes('--replace'),
    dryRun: argv.includes('--dry-run'),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const fs = await import('node:fs/promises');

  console.error(`Reading SPX file: ${args.csv}`);
  let content: string;
  try {
    content = await fs.readFile(args.csv, 'utf8');
  } catch (e) {
    console.error(`ERROR: cannot read --csv file "${args.csv}": ${(e as Error).message}`);
    process.exit(1);
  }

  // Reuse the shared OHLC/RTH parser: it groups bars by ET day, drops off-RTH
  // minutes, and honours the input tz. The close of each bar is the SPX spot.
  const { bars, days, parseFailures } = parseEsCsv(content, {
    tz: args.tz,
    dateFormat: 'iso',
    start: args.start,
    end: args.end,
  });
  if (bars.length === 0) {
    console.error('ERROR: no RTH bars parsed. Check --csv, --tz, and the date range.');
    if (parseFailures > 0) console.error(`(${parseFailures} rows failed to parse)`);
    process.exit(1);
  }

  const spotRows = bars.map((b) => ({
    capturedAt: etBarToUtcIso(b.dateKey, b.minOfDay),
    expiry: b.dateKey, // spot_prices `date` column = ET trading day
    spot: Number(b.close.toFixed(2)),
  }));

  const firstDay = days[0]!;
  const lastDay = days[days.length - 1]!;
  console.error(
    `Parsed ${spotRows.length} RTH bars across ${days.length} days ` +
      `(${firstDay} → ${lastDay}) → spot_prices (I:SPX close, exact).`,
  );

  if (args.dryRun) {
    console.error('--dry-run: nothing written.');
    console.error(`  ${args.replace ? `WOULD DELETE spot_prices in [${firstDay}, ${lastDay}] first.` : 'upsert mode (no delete).'}`);
    console.error('  spot_prices[0]   :', JSON.stringify(spotRows[0]));
    console.error('  spot_prices[last]:', JSON.stringify(spotRows[spotRows.length - 1]));
    return;
  }

  // Imported here (not at top) so --dry-run / --help work without a DATABASE_URL.
  const { insertSpotPrices, deleteSpotPricesInRange } = await import('../db/index.js');
  if (args.replace) {
    const deleted = await deleteSpotPricesInRange(firstDay, lastDay);
    console.error(`Replaced: deleted ${deleted} existing spot rows in [${firstDay}, ${lastDay}].`);
  }
  const written = await insertSpotPrices(spotRows);

  console.error('');
  console.error(`✓ spot_prices: ${written} rows written (I:SPX close)`);
  if (parseFailures > 0) {
    console.error(`  (${parseFailures} input rows failed to parse and were skipped.)`);
  }
}

main().catch((e) => {
  console.error(`FATAL: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
