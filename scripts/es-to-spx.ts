/**
 * es-to-spx.ts — Standalone ES (S&P 500 futures) → SPX (cash index) converter.
 *
 * NOT part of the scraper. Run on demand with `tsx`.
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
 *   --help             Print this help.
 *
 * INPUT FORMAT (auto-detected)
 *   Header row with columns matching: date[+time] | datetime | timestamp,
 *   and open / high / low / close (volume optional). Falls back to positional
 *   order Date,Open,High,Low,Close,Volume if headers aren't recognised.
 */

const MARKET_TZ = 'America/New_York';
const DEFAULT_START = '2025-12-29';
const RTH_OPEN_MIN = 9 * 60 + 30; // 09:30 ET
const RTH_CLOSE_MIN = 16 * 60; // 16:00 ET

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

interface Args {
  es: string;
  out: string;
  tz: string;
  start: string;
  end: string;
  spxSymbol: string;
  dateFormat: 'iso' | 'us' | 'eu' | 'auto';
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
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
  const df = (get('--dateformat') ?? 'auto').toLowerCase();
  if (!['iso', 'us', 'eu', 'auto'].includes(df)) {
    console.error(`ERROR: --dateformat must be iso|us|eu|auto (got "${df}")`);
    process.exit(1);
  }
  const base = es.replace(/\.[^.\\/]+$/, '');
  return {
    es,
    out: get('--out') ?? `${base}.spx.csv`,
    tz: get('--tz') ?? MARKET_TZ,
    start: get('--start') ?? DEFAULT_START,
    end: get('--end') ?? todayIsoEt(),
    spxSymbol: get('--spx-symbol') ?? '^GSPC',
    dateFormat: df as Args['dateFormat'],
  };
}

function printHelp(): void {
  console.log(
    [
      'es-to-spx — convert ES futures bars to SPX cash-index bars (RTH).',
      '',
      'Usage: npx tsx scripts/es-to-spx.ts --es <path.csv> [--out o.csv]',
      '       [--tz America/New_York] [--start 2025-12-29] [--end YYYY-MM-DD]',
      '       [--spx-symbol ^spx] [--dateformat iso|us|eu|auto]',
      '',
      'Note: for RTH-only SPX you can also just download ^GSPC/SPX directly',
      '(exact). This tool is for when ES is your only source.',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Timezone helpers (same explicit-offset technique the scraper uses; never
// relies on the host/container TZ).
// ---------------------------------------------------------------------------

interface WallParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function partsInZone(instantMs: number, tz: string): WallParts {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instantMs));
  const g = (t: string) =>
    Number.parseInt(p.find((x) => x.type === t)?.value ?? '0', 10);
  return {
    y: g('year'),
    mo: g('month'),
    d: g('day'),
    h: g('hour'),
    mi: g('minute'),
    s: g('second'),
  };
}

/** Interpret wall-clock parts as being in `tz`, return the UTC instant (ms). */
function zonedWallToUtcMs(w: WallParts, tz: string): number {
  let probe = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  for (let pass = 0; pass < 2; pass += 1) {
    const got = partsInZone(probe, tz);
    const gotMs = Date.UTC(got.y, got.mo - 1, got.d, got.h, got.mi, got.s);
    const targetMs = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
    probe += targetMs - gotMs;
  }
  return probe;
}

function todayIsoEt(): string {
  const w = partsInZone(Date.now(), MARKET_TZ);
  return `${w.y}-${pad2(w.mo)}-${pad2(w.d)}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

interface ColumnMap {
  dateIdx: number;
  timeIdx: number; // -1 if combined into dateIdx
  openIdx: number;
  highIdx: number;
  lowIdx: number;
  closeIdx: number;
}

function detectColumns(header: string[]): ColumnMap {
  const lc = header.map((h) => h.toLowerCase().replace(/[^a-z]/g, ''));
  const find = (...names: string[]) =>
    lc.findIndex((h) => names.some((n) => h === n || h.includes(n)));

  let dateIdx = find('datetime', 'timestamp');
  let timeIdx = -1;
  if (dateIdx < 0) {
    dateIdx = find('date');
    timeIdx = find('time');
    if (timeIdx === dateIdx) timeIdx = -1;
  }

  const openIdx = find('open');
  const highIdx = find('high');
  const lowIdx = find('low');
  const closeIdx = find('close', 'last');

  // Fallback: positional Date,Open,High,Low,Close[,Volume] if headers look
  // numeric / unrecognised.
  if (openIdx < 0 || highIdx < 0 || lowIdx < 0 || closeIdx < 0) {
    return { dateIdx: 0, timeIdx: -1, openIdx: 1, highIdx: 2, lowIdx: 3, closeIdx: 4 };
  }
  return { dateIdx, timeIdx, openIdx, highIdx, lowIdx, closeIdx };
}

function looksLikeHeader(cells: string[]): boolean {
  // A header row has at least one non-numeric, non-date-looking cell.
  return cells.some((c) => /[a-zA-Z]/.test(c) && !/^\d{4}-\d{2}-\d{2}/.test(c));
}

// ---------------------------------------------------------------------------
// Datetime parsing → ET wall parts
// ---------------------------------------------------------------------------

/** Pull numeric Y/M/D/h/m/s out of a raw datetime string, honouring dateFormat
 *  for ambiguous numeric dates. Returns wall parts AS WRITTEN (no tz applied). */
function parseRawWall(
  dateStr: string,
  timeStr: string | null,
  dateFormat: Args['dateFormat'],
): WallParts | null {
  const raw = timeStr ? `${dateStr} ${timeStr}` : dateStr;
  // ISO-ish: YYYY-MM-DD[ T]HH:MM[:SS]
  let m = raw.match(
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?/,
  );
  if (m) {
    return {
      y: +m[1]!,
      mo: +m[2]!,
      d: +m[3]!,
      h: +m[4]!,
      mi: +m[5]!,
      s: m[6] ? +m[6] : 0,
    };
  }
  // Numeric A/B/YYYY [HH:MM[:SS]] — order depends on dateFormat.
  m = raw.match(
    /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/,
  );
  if (m) {
    const a = +m[1]!;
    const b = +m[2]!;
    let mo: number;
    let d: number;
    if (dateFormat === 'eu') {
      d = a;
      mo = b;
    } else if (dateFormat === 'us') {
      mo = a;
      d = b;
    } else {
      // auto: disambiguate by value, else assume US (most US futures CSVs)
      if (a > 12) {
        d = a;
        mo = b;
      } else if (b > 12) {
        mo = a;
        d = b;
      } else {
        mo = a;
        d = b;
      }
    }
    return {
      y: +m[3]!,
      mo,
      d,
      h: m[4] ? +m[4]! : 0,
      mi: m[5] ? +m[5]! : 0,
      s: m[6] ? +m[6]! : 0,
    };
  }
  // Date-only ISO
  m = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) {
    return { y: +m[1]!, mo: +m[2]!, d: +m[3]!, h: 0, mi: 0, s: 0 };
  }
  return null;
}

interface EsBar {
  dateKey: string; // ET YYYY-MM-DD
  minOfDay: number; // ET minutes since midnight
  open: number;
  high: number;
  low: number;
  close: number;
}

// ---------------------------------------------------------------------------
// SPX daily fetch (Yahoo chart API). Yahoo's `^GSPC` IS the S&P 500 cash index
// (same value as CBOE:SPX). The daily bar timestamp is the 09:30 ET open, so we
// map it to its ET calendar date.
// ---------------------------------------------------------------------------

interface SpxDaily {
  open: number;
  close: number;
}

async function fetchSpxDaily(
  symbol: string,
  start: string,
  end: string,
): Promise<Map<string, SpxDaily>> {
  // Pad the window by a day on each side so boundary trading days are included
  // regardless of tz; we filter by ET date when mapping anyway.
  const p1 = Math.floor(Date.parse(`${start}T00:00:00Z`) / 1000) - 86400;
  const p2 = Math.floor(Date.parse(`${end}T00:00:00Z`) / 1000) + 2 * 86400;
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?period1=${p1}&period2=${p2}&interval=1d`;
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  });
  if (!res.ok) {
    throw new Error(`Yahoo fetch failed: HTTP ${res.status} for ${url}`);
  }
  const json = (await res.json()) as {
    chart?: {
      result?: Array<{
        timestamp?: number[];
        indicators?: { quote?: Array<{ open?: (number | null)[]; close?: (number | null)[] }> };
      }>;
      error?: unknown;
    };
  };
  const result = json.chart?.result?.[0];
  const ts = result?.timestamp;
  const quote = result?.indicators?.quote?.[0];
  if (!ts || !quote?.open || !quote?.close) {
    throw new Error(
      `Unexpected Yahoo response for symbol "${symbol}" ` +
        `(error: ${JSON.stringify(json.chart?.error)}). Try a different --spx-symbol.`,
    );
  }
  const map = new Map<string, SpxDaily>();
  for (let i = 0; i < ts.length; i += 1) {
    const open = quote.open[i];
    const close = quote.close[i];
    if (open == null || close == null) continue;
    const et = partsInZone(ts[i]! * 1000, MARKET_TZ);
    const dateKey = `${et.y}-${pad2(et.mo)}-${pad2(et.d)}`;
    map.set(dateKey, { open, close });
  }
  return map;
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
  content = content.replace(/^﻿/, '');
  const rawLines = content.trim().split(/\r?\n/);
  if (rawLines.length === 0) {
    console.error('ERROR: ES file is empty.');
    process.exit(1);
  }

  const firstCells = splitCsvLine(rawLines[0]!);
  const hasHeader = looksLikeHeader(firstCells);
  const cols = hasHeader
    ? detectColumns(firstCells)
    : { dateIdx: 0, timeIdx: -1, openIdx: 1, highIdx: 2, lowIdx: 3, closeIdx: 4 };
  const dataStart = hasHeader ? 1 : 0;

  // Parse ES bars, convert each timestamp to ET, keep RTH bars in [start,end].
  const bars: EsBar[] = [];
  let parseFailures = 0;
  const tzIsEt = args.tz === MARKET_TZ;
  for (let i = dataStart; i < rawLines.length; i += 1) {
    const cells = splitCsvLine(rawLines[i]!);
    const dateStr = cells[cols.dateIdx];
    if (!dateStr) continue;
    const timeStr = cols.timeIdx >= 0 ? cells[cols.timeIdx] ?? null : null;
    const wall = parseRawWall(dateStr, timeStr, args.dateFormat);
    if (!wall) {
      parseFailures += 1;
      continue;
    }
    // Convert the input-tz wall time to ET wall parts.
    let et: WallParts;
    if (tzIsEt) {
      et = wall;
    } else {
      et = partsInZone(zonedWallToUtcMs(wall, args.tz), MARKET_TZ);
    }
    const dateKey = `${et.y}-${pad2(et.mo)}-${pad2(et.d)}`;
    if (dateKey < args.start || dateKey > args.end) continue;
    const minOfDay = et.h * 60 + et.mi;
    if (minOfDay < RTH_OPEN_MIN || minOfDay > RTH_CLOSE_MIN) continue;

    const open = Number.parseFloat(cells[cols.openIdx] ?? '');
    const high = Number.parseFloat(cells[cols.highIdx] ?? '');
    const low = Number.parseFloat(cells[cols.lowIdx] ?? '');
    const close = Number.parseFloat(cells[cols.closeIdx] ?? '');
    if (![open, high, low, close].every(Number.isFinite)) {
      parseFailures += 1;
      continue;
    }
    bars.push({ dateKey, minOfDay, open, high, low, close });
  }

  if (bars.length === 0) {
    console.error(
      'ERROR: no RTH bars parsed. Check --tz (ES timestamps may be in ' +
        'America/Chicago or UTC), --dateformat, and the date range.',
    );
    if (parseFailures > 0) console.error(`(${parseFailures} rows failed to parse)`);
    process.exit(1);
  }

  // Group by ET date, sort each day chronologically.
  const byDay = new Map<string, EsBar[]>();
  for (const b of bars) {
    const arr = byDay.get(b.dateKey) ?? [];
    arr.push(b);
    byDay.set(b.dateKey, arr);
  }
  for (const arr of byDay.values()) arr.sort((a, b) => a.minOfDay - b.minOfDay);
  const days = [...byDay.keys()].sort();

  console.error(
    `Parsed ${bars.length} RTH bars across ${days.length} days ` +
      `(${days[0]} → ${days[days.length - 1]}). Fetching SPX daily…`,
  );

  const spx = await fetchSpxDaily(args.spxSymbol, args.start, args.end);

  // Build output + per-day diagnostics.
  const outRows: string[] = [
    'datetime_et,spx_open,spx_high,spx_low,spx_close,es_close,basis',
  ];
  let lastKnownBasis: { open: number; close: number } | null = null;
  let maxSpread = 0;
  let maxSpreadDay = '';
  let missingDays = 0;

  for (const day of days) {
    const dayBars = byDay.get(day)!;
    const esOpen = dayBars[0]!.open;
    const esClose = dayBars[dayBars.length - 1]!.close;
    const openMin = dayBars[0]!.minOfDay;
    const closeMin = dayBars[dayBars.length - 1]!.minOfDay;

    const truth = spx.get(day);
    let basisOpen: number;
    let basisClose: number;
    if (truth) {
      basisOpen = esOpen - truth.open;
      basisClose = esClose - truth.close;
      lastKnownBasis = { open: basisOpen, close: basisClose };
    } else if (lastKnownBasis) {
      // No cash-index print yet (e.g. today before EOD) — carry last basis.
      basisOpen = lastKnownBasis.open;
      basisClose = lastKnownBasis.close;
      missingDays += 1;
      console.error(
        `WARN ${day}: no SPX daily yet — carrying prior basis ` +
          `(open ${basisOpen.toFixed(2)}, close ${basisClose.toFixed(2)}).`,
      );
    } else {
      missingDays += 1;
      console.error(`WARN ${day}: no SPX daily and no prior basis — skipped.`);
      continue;
    }

    const spread = Math.abs(basisClose - basisOpen);
    if (spread > maxSpread) {
      maxSpread = spread;
      maxSpreadDay = day;
    }

    const span = closeMin - openMin || 1;
    for (const b of dayBars) {
      const f = (b.minOfDay - openMin) / span;
      const basis = basisOpen + f * (basisClose - basisOpen);
      const hh = pad2(Math.floor(b.minOfDay / 60));
      const mm = pad2(b.minOfDay % 60);
      outRows.push(
        [
          `${day} ${hh}:${mm}`,
          (b.open - basis).toFixed(2),
          (b.high - basis).toFixed(2),
          (b.low - basis).toFixed(2),
          (b.close - basis).toFixed(2),
          b.close.toFixed(2),
          basis.toFixed(3),
        ].join(','),
      );
    }
  }

  await fs.writeFile(args.out, `${outRows.join('\n')}\n`, 'utf8');

  console.error('');
  console.error(`✓ Wrote ${outRows.length - 1} SPX bars → ${args.out}`);
  console.error(
    `  Max intraday basis spread (open→close): ${maxSpread.toFixed(2)} pt on ${maxSpreadDay}`,
  );
  if (maxSpread > 1) {
    console.error(
      '  ⚠ Spread > 1 pt on at least one day — mid-session bars there may ' +
        'exceed 1 pt of error. Open/close bars remain exact.',
    );
  } else {
    console.error('  ✓ All days < 1 pt spread → interpolation error stays sub-point.');
  }
  if (missingDays > 0) {
    console.error(`  (${missingDays} day(s) had no SPX daily print; see WARN above.)`);
  }
  if (parseFailures > 0) {
    console.error(`  (${parseFailures} input rows failed to parse and were skipped.)`);
  }
}

main().catch((e) => {
  console.error(`FATAL: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
