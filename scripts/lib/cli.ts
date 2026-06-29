/**
 * cli.ts — argument parsing shared by the price CLIs (`es-to-spx.ts`,
 * `ingest-prices.ts`). The flag getter and the options every CLI accepts live
 * here so a new shared option (or a changed default) is edited in one place.
 */

import {
  ANCHORS,
  DATE_FORMATS,
  DEFAULT_SPX_SYMBOL,
  DEFAULT_START,
  MARKET_TZ,
  todayIsoEt,
  type Anchor,
  type DateFormat,
} from './es-spx.js';

export type FlagGetter = (flag: string) => string | undefined;

export function makeFlagGetter(argv: string[]): FlagGetter {
  return (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
}

/** Options accepted by every price CLI (input source, window, calibration). */
export interface CommonArgs {
  tz: string;
  start: string;
  end: string;
  spxSymbol: string;
  dateFormat: DateFormat;
  anchor: Anchor;
}

/**
 * Parse + validate the common options. Exits the process with a message on
 * invalid enum input — these are CLI-fatal, matching how the callers treat a
 * bad `--es`.
 */
export function parseCommonArgs(get: FlagGetter): CommonArgs {
  const df = (get('--dateformat') ?? 'auto').toLowerCase();
  if (!DATE_FORMATS.includes(df as DateFormat)) {
    console.error(`ERROR: --dateformat must be ${DATE_FORMATS.join('|')} (got "${df}")`);
    process.exit(1);
  }
  const anchor = (get('--anchor') ?? 'close').toLowerCase();
  if (!ANCHORS.includes(anchor as Anchor)) {
    console.error(`ERROR: --anchor must be ${ANCHORS.join('|')} (got "${anchor}")`);
    process.exit(1);
  }
  return {
    tz: get('--tz') ?? MARKET_TZ,
    start: get('--start') ?? DEFAULT_START,
    end: get('--end') ?? todayIsoEt(),
    spxSymbol: get('--spx-symbol') ?? DEFAULT_SPX_SYMBOL,
    dateFormat: df as DateFormat,
    anchor: anchor as Anchor,
  };
}
