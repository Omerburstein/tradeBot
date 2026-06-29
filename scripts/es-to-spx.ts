/**
 * es-to-spx.ts — Standalone ES (S&P 500 futures) → SPX (cash index) converter.
 *
 * NOT part of the scraper. Run on demand with `tsx`. Thin CLI over the shared
 * conversion library in `scripts/lib/es-spx.ts` (which the DB ingest script and
 * the accuracy test reuse — the calibration math lives in one place there).
 *
 * WHY THIS EXISTS / THE PRECISION STORY
 * -------------------------------------
 * ES (front-month future) is NOT "SPX + a constant". It trades at:
 *
 *     ES = SPX * e^((r - q) * T)   ≈   SPX + basis
 *
 * where `basis` (a.k.a. fair value) depends on the risk-free rate r, the
 * expected dividend yield q, and time-to-expiry T. With SPX ~6000 the basis
 * can be 40-60 pts early in a quarterly cycle, decaying toward ~0 at expiry.
 * A pure cost-of-carry model would drift 1-5 pts — too coarse for the <1 pt
 * target.
 *
 * Since the requirement is RTH-only values, we instead CALIBRATE the basis
 * against the REAL SPX cash index (free daily OHLC from Yahoo's `^GSPC`, which
 * is the same S&P 500 index value as CBOE:SPX). For each day we
 * anchor the basis to the true SPX open & close and linearly interpolate it
 * across the 5-min session. Error is 0 at the open/close anchors and stays
 * well under 1 pt in between (the intraday basis moves only a fraction of a
 * point on a normal day).
 *
 *   NOTE: If you only need RTH SPX, you don't strictly need ES at all — you can
 *   download SPX/^GSPC directly (exact, 0 pt error). This script is for when ES
 *   is the source you have. See the README banner printed with `--help`.
 *
 * USAGE
 * -----
 *   npx tsx scripts/es-to-spx.ts --es <path-to-es.csv> [options]
 *
 * OPTIONS
 *   --es <path>        ES input CSV (required).
 *   --out <path>       Output CSV (default: <es-basename>.spx.csv next to input).
 *   --tz <iana>        Timezone the ES timestamps are expressed in.
 *                      Default: America/New_York. Common alternatives:
 *                      America/Chicago (CME exchange time) or UTC.
 *   --start <date>     ISO start date (inclusive), default 2025-12-29.
 *   --end <date>       ISO end date (inclusive), default today.
 *   --spx-symbol <s>   Yahoo symbol for the cash index (default: ^GSPC).
 *   --dateformat <f>   iso | us | eu  (default: auto-detect). Controls how
 *                      ambiguous numeric dates are read (us=MM/DD, eu=DD/MM).
 *   --anchor <mode>    close (default) | openclose. How the daily basis is set:
 *                        close     → flat basis = ES_close − SPX_close. Robust;
 *                                    <1 pt for ~all bars. The SPX cash OPEN lags
 *                                    the futures (constituents open staggered),
 *                                    so the first few minutes on gap days are
 *                                    the only place this can exceed 1 pt.
 *                        openclose → linear basis from the SPX open anchor to
 *                                    the close anchor. Matches the (laggy) cash
 *                                    open/close exactly but can be ~10-20 pt off
 *                                    midday on volatile days. Not recommended.
 *   --help             Print this help.
 *
 * INPUT FORMAT (auto-detected)
 *   Header row with columns matching: date[+time] | datetime | timestamp,
 *   and open / high / low / close (volume optional). Falls back to positional
 *   order Date,Open,High,Low,Close,Volume if headers aren't recognised.
 */

import { convertEsToSpx, fetchSpxDaily, parseEsCsv, pad2 } from './lib/es-spx.js';
import { makeFlagGetter, parseCommonArgs, type CommonArgs } from './lib/cli.js';

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

interface Args extends CommonArgs {
  es: string;
  out: string;
  scale: number;
}

function parseArgs(argv: string[]): Args {
  const get = makeFlagGetter(argv);
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    process.exit(0);
  }
  const es = get('--es');
  if (!es) {
    printHelp();
    console.error('\nERROR: --es <path> is required.');
    process.exit(1);
  }
  const scale = Number.parseFloat(get('--scale') ?? '1');
  if (!Number.isFinite(scale) || scale <= 0) {
    console.error(`ERROR: --scale must be a positive number (got "${get('--scale')}")`);
    process.exit(1);
  }
  const base = es.replace(/\.[^.\\/]+$/, '');
  return {
    es,
    out: get('--out') ?? `${base}.spx.csv`,
    scale,
    ...parseCommonArgs(get),
  };
}

function printHelp(): void {
  console.log(
    [
      'es-to-spx — convert ES futures bars to SPX cash-index bars (RTH).',
      '',
      'Usage: npx tsx scripts/es-to-spx.ts --es <path.csv> [--out o.csv]',
      '       [--tz America/New_York] [--start 2025-12-29] [--end YYYY-MM-DD]',
      '       [--spx-symbol ^spx] [--dateformat iso|us|eu|auto] [--scale N]',
      '',
      '--scale N: multiply input bars before calibration (default 1 = ES).',
      '          Pass 10 to convert a SPY CSV (SPX ≈ SPY×10) — far tighter',
      '          intraday than ES since the ETF is arbitraged to spot.',
      '',
      'Note: for RTH-only SPX you can also just download ^GSPC/SPX directly',
      '(exact). This tool is for when ES/SPY is your only source.',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

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
      'ERROR: no RTH bars parsed. Check --tz (ES timestamps may be in ' +
        'America/Chicago or UTC), --dateformat, and the date range.',
    );
    if (parseFailures > 0) console.error(`(${parseFailures} rows failed to parse)`);
    process.exit(1);
  }

  // --scale lets a non-ES instrument reuse the same additive basis calibration.
  // Default 1 = ES. Pass 10 for SPY (SPX ≈ SPY×10), so the per-day basis becomes
  // (SPY_close×10 − SPX_close) and recon = SPY×10 − basis = SPX.
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

  const outRows: string[] = [
    'datetime_et,spx_open,spx_high,spx_low,spx_close,es_close,basis',
  ];
  for (const b of result.bars) {
    const hh = pad2(Math.floor(b.minOfDay / 60));
    const mm = pad2(b.minOfDay % 60);
    outRows.push(
      [
        `${b.dateKey} ${hh}:${mm}`,
        b.spxOpen.toFixed(2),
        b.spxHigh.toFixed(2),
        b.spxLow.toFixed(2),
        b.spxClose.toFixed(2),
        b.esClose.toFixed(2),
        b.basis.toFixed(3),
      ].join(','),
    );
  }

  await fs.writeFile(args.out, `${outRows.join('\n')}\n`, 'utf8');

  console.error('');
  console.error(`✓ Wrote ${outRows.length - 1} SPX bars → ${args.out} (anchor: ${args.anchor})`);
  console.error(
    `  Largest open-vs-close basis gap: ${result.maxSpread.toFixed(2)} pt on ${result.maxSpreadDay}`,
  );
  if (args.anchor === 'close') {
    console.error(
      '  (flat-close anchor) Body of each session is < 1 pt. That gap is the ' +
        'cash-open lag — the first few minutes of the gappiest day may deviate ' +
        'by up to that much vs published SPX cash; the rest stays sub-point.',
    );
  } else if (result.maxSpread > 1) {
    console.error(
      '  ⚠ (openclose anchor) Open/close match exactly but midday on that day ' +
        `may be off by up to ~${(result.maxSpread / 2).toFixed(0)} pt. Prefer --anchor close.`,
    );
  }
  if (result.thinDays > 0) {
    console.error(
      `  ⚠ ${result.thinDays} day(s) had thin RTH coverage — likely a back-month ` +
        'contract. Use the rolled front-month series for accurate values.',
    );
  }
  if (result.missingDays > 0) {
    console.error(`  (${result.missingDays} day(s) dropped — no SPX cash print / holiday.)`);
  }
  if (parseFailures > 0) {
    console.error(`  (${parseFailures} input rows failed to parse and were skipped.)`);
  }
}

main().catch((e) => {
  console.error(`FATAL: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
