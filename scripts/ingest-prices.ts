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
} from './lib/es-spx.js';
import { makeFlagGetter, parseCommonArgs, type CommonArgs } from './lib/cli.js';

interface Args extends CommonArgs {
  es: string;
  dryRun: boolean;
  scale: number;
  writeEs: boolean;
  writeSpot: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = makeFlagGetter(argv);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      [
        'ingest-prices — load ES (or SPY) + derived SPX bars into Postgres.',
        '',
        'Usage: node --env-file=.env --import=tsx/esm scripts/ingest-prices.ts \\',
        '         --es <path.csv> [--tz America/New_York] [--start 2025-12-29] \\',
        '         [--end YYYY-MM-DD] [--spx-symbol ^GSPC] [--dateformat auto] \\',
        '         [--anchor close] [--scale 1] [--es-only|--spot-only] [--dry-run]',
        '',
        '--scale N     multiply input bars before calibration (default 1 = ES).',
        '              Pass 10 for a SPY CSV (SPX ≈ SPY×10); implies --spot-only',
        '              since SPY×10 is NOT the futures series (never written to es_prices).',
        '--es-only     write only es_prices (skip the derived spot_prices).',
        '--spot-only   write only spot_prices (skip es_prices).',
      ].join('\n'),
    );
    process.exit(0);
  }
  const es = get('--es');
  if (!es) {
    console.error('ERROR: --es <path> is required.');
    process.exit(1);
  }
  const scale = Number.parseFloat(get('--scale') ?? '1');
  if (!Number.isFinite(scale) || scale <= 0) {
    console.error(`ERROR: --scale must be a positive number (got "${get('--scale')}")`);
    process.exit(1);
  }
  const esOnly = argv.includes('--es-only');
  const spotOnly = argv.includes('--spot-only');
  if (esOnly && spotOnly) {
    console.error('ERROR: --es-only and --spot-only are mutually exclusive.');
    process.exit(1);
  }
  if (scale !== 1 && esOnly) {
    console.error(
      'ERROR: --scale is for a non-ES source (e.g. SPY) whose scaled values are ' +
        'not the futures series, so it can only write spot_prices — --es-only is invalid with it.',
    );
    process.exit(1);
  }
  // A scaled (SPY) source never populates es_prices: SPY×10 is a cash-index
  // proxy, not the traded future. Force spot-only so a stray flag can't mislabel it.
  const writeEs = scale === 1 && !spotOnly;
  const writeSpot = !esOnly;
  return {
    es,
    dryRun: argv.includes('--dry-run'),
    scale,
    writeEs,
    writeSpot,
    ...parseCommonArgs(get),
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

  // --scale lets a non-ES source (SPY, SPX ≈ SPY×10) reuse the same additive
  // basis calibration: scale in place so the per-day basis becomes
  // (SPY_close×10 − SPX_close) and recon = SPY×10 − basis = SPX. Mirrors es-to-spx.
  if (args.scale !== 1) {
    for (const arr of byDay.values()) {
      for (const b of arr) {
        b.open *= args.scale;
        b.high *= args.scale;
        b.low *= args.scale;
        b.close *= args.scale;
      }
    }
  }

  console.error(
    `Parsed ${bars.length} RTH bars across ${days.length} days ` +
      `(${days[0]} → ${days[days.length - 1]})` +
      `${args.scale !== 1 ? `, scaled ×${args.scale}` : ''}. Fetching SPX daily…`,
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

  const targets = [args.writeEs ? 'es_prices' : null, args.writeSpot ? 'spot_prices' : null]
    .filter(Boolean)
    .join(' + ');
  console.error(
    `Converted ${result.bars.length} bars → ${targets}, anchor=${args.anchor}.`,
  );

  if (args.dryRun) {
    console.error('--dry-run: nothing written. Sample rows:');
    if (args.writeEs) console.error('  es_prices[0]   :', JSON.stringify(esRows[0]));
    if (args.writeSpot) console.error('  spot_prices[0] :', JSON.stringify(spotRows[0]));
    return;
  }

  // Imported here (not at top) so --dry-run / --help work without a DATABASE_URL
  // — db/index.js → config.ts validates DATABASE_URL at module load.
  const { insertEsPrices, insertSpotPrices } = await import('../db/index.js');
  const esWritten = args.writeEs ? await insertEsPrices(esRows) : 0;
  const spotWritten = args.writeSpot ? await insertSpotPrices(spotRows) : 0;

  console.error('');
  if (args.writeEs) console.error(`✓ es_prices:   ${esWritten} rows written`);
  if (args.writeSpot) console.error(`✓ spot_prices: ${spotWritten} rows written (SPX close)`);
  if (parseFailures > 0) {
    console.error(`  (${parseFailures} input rows failed to parse and were skipped.)`);
  }
}

main().catch((e) => {
  console.error(`FATAL: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
