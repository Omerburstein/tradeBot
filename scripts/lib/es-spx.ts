/**
 * es-spx.ts — shared, pure ES→SPX conversion library.
 *
 * This is the single source of truth for turning ES (S&P 500 futures) bars into
 * SPX (cash index) bars. Both the standalone CLI (`scripts/es-to-spx.ts`), the
 * DB ingest script (`scripts/ingest-prices.ts`), and the accuracy test
 * (`scripts/test-es-spx-conversion.ts`) import from here so the calibration math
 * lives in exactly one place.
 *
 * THE PRECISION STORY (why we calibrate against real SPX rather than carry):
 * -------------------------------------------------------------------------
 * ES (front-month future) is NOT "SPX + a constant". It trades at
 *
 *     ES = SPX * e^((r - q) * T)   ≈   SPX + basis
 *
 * where `basis` (fair value) depends on the risk-free rate r, the expected
 * dividend yield q, and time-to-expiry T. With SPX ~6000 the basis can be 40-60
 * pts early in a quarterly cycle, decaying toward ~0 at expiry. A pure
 * cost-of-carry model would drift 1-5 pts — too coarse for a <1 pt target.
 *
 * So instead we CALIBRATE the basis against the REAL SPX cash index (free daily
 * OHLC from Yahoo's `^GSPC`, the same value as CBOE:SPX). For each day we anchor
 * the basis to the true SPX open/close and either hold it flat (the clean
 * official close — `close` anchor, default) or linearly interpolate it across
 * the session (`openclose`). Error is ~0 at the anchors and stays well under
 * 1 pt in between on a normal day.
 */

export const MARKET_TZ = 'America/New_York';
export const RTH_OPEN_MIN = 9 * 60 + 30; // 09:30 ET
export const RTH_CLOSE_MIN = 16 * 60; // 16:00 ET

/** First trading day of the dataset window (the day after the Dec 2025 expiry). */
export const DEFAULT_START = '2025-12-29';
/** Yahoo ticker for the S&P 500 cash index (== CBOE:SPX). */
export const DEFAULT_SPX_SYMBOL = '^GSPC';

/** Yahoo chart endpoint + a desktop UA (Yahoo rejects the default fetch UA). */
export const YAHOO_CHART_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';
export const YAHOO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

// Valid CLI enum values doubling as the source of the corresponding union types,
// so a new option only has to be added in one place.
export const DATE_FORMATS = ['iso', 'us', 'eu', 'auto'] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];
export const ANCHORS = ['close', 'openclose'] as const;
export type Anchor = (typeof ANCHORS)[number];

// ---------------------------------------------------------------------------
// Timezone helpers (explicit-offset technique the scraper uses; never relies on
// the host/container TZ).
// ---------------------------------------------------------------------------

export interface WallParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

export function partsInZone(instantMs: number, tz: string): WallParts {
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
export function zonedWallToUtcMs(w: WallParts, tz: string): number {
  let probe = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  for (let pass = 0; pass < 2; pass += 1) {
    const got = partsInZone(probe, tz);
    const gotMs = Date.UTC(got.y, got.mo - 1, got.d, got.h, got.mi, got.s);
    const targetMs = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
    probe += targetMs - gotMs;
  }
  return probe;
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function todayIsoEt(): string {
  const w = partsInZone(Date.now(), MARKET_TZ);
  return `${w.y}-${pad2(w.mo)}-${pad2(w.d)}`;
}

/** UTC ISO-8601 instant for an ET wall-clock bar (date + minute-of-day). This is
 *  the `captured_at` form the DB layer expects. */
export function etBarToUtcIso(dateKey: string, minOfDay: number): string {
  const [y, mo, d] = dateKey.split('-').map((s) => Number.parseInt(s, 10));
  const w: WallParts = {
    y: y!,
    mo: mo!,
    d: d!,
    h: Math.floor(minOfDay / 60),
    mi: minOfDay % 60,
    s: 0,
  };
  return new Date(zonedWallToUtcMs(w, MARKET_TZ)).toISOString();
}

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

export function splitCsvLine(line: string): string[] {
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

export interface ColumnMap {
  dateIdx: number;
  timeIdx: number; // -1 if combined into dateIdx
  openIdx: number;
  highIdx: number;
  lowIdx: number;
  closeIdx: number;
  volumeIdx: number; // -1 if absent
}

export function detectColumns(header: string[]): ColumnMap {
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
  const volumeIdx = find('volume', 'vol');

  // Fallback: positional Date,Open,High,Low,Close[,Volume] if headers look
  // numeric / unrecognised.
  if (openIdx < 0 || highIdx < 0 || lowIdx < 0 || closeIdx < 0) {
    return {
      dateIdx: 0,
      timeIdx: -1,
      openIdx: 1,
      highIdx: 2,
      lowIdx: 3,
      closeIdx: 4,
      volumeIdx: 5,
    };
  }
  return { dateIdx, timeIdx, openIdx, highIdx, lowIdx, closeIdx, volumeIdx };
}

export function looksLikeHeader(cells: string[]): boolean {
  // A header row has at least one non-numeric, non-date-looking cell.
  return cells.some((c) => /[a-zA-Z]/.test(c) && !/^\d{4}-\d{2}-\d{2}/.test(c));
}

// ---------------------------------------------------------------------------
// Datetime parsing → ET wall parts
// ---------------------------------------------------------------------------

/** Pull numeric Y/M/D/h/m/s out of a raw datetime string, honouring dateFormat
 *  for ambiguous numeric dates. Returns wall parts AS WRITTEN (no tz applied). */
export function parseRawWall(
  dateStr: string,
  timeStr: string | null,
  dateFormat: DateFormat,
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

export interface EsBar {
  dateKey: string; // ET YYYY-MM-DD
  minOfDay: number; // ET minutes since midnight
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

export interface ParseEsOptions {
  tz: string;
  dateFormat: DateFormat;
  start: string; // ISO date inclusive
  end: string; // ISO date inclusive
}

export interface ParseEsResult {
  bars: EsBar[];
  byDay: Map<string, EsBar[]>; // each day's bars sorted by minOfDay
  days: string[]; // sorted ET date keys
  parseFailures: number;
}

/**
 * Parse a raw ES CSV string into RTH bars within [start,end], grouped & sorted
 * by ET date. Auto-detects header + column layout and the timezone the input
 * timestamps are written in (`tz`).
 */
export function parseEsCsv(content: string, opts: ParseEsOptions): ParseEsResult {
  const clean = content.replace(/^﻿/, '');
  const rawLines = clean.trim().split(/\r?\n/);
  const bars: EsBar[] = [];
  let parseFailures = 0;
  if (rawLines.length === 0 || (rawLines.length === 1 && rawLines[0] === '')) {
    return { bars, byDay: new Map(), days: [], parseFailures };
  }

  const firstCells = splitCsvLine(rawLines[0]!);
  const hasHeader = looksLikeHeader(firstCells);
  const cols = hasHeader
    ? detectColumns(firstCells)
    : { dateIdx: 0, timeIdx: -1, openIdx: 1, highIdx: 2, lowIdx: 3, closeIdx: 4, volumeIdx: 5 };
  const dataStart = hasHeader ? 1 : 0;
  const tzIsEt = opts.tz === MARKET_TZ;

  for (let i = dataStart; i < rawLines.length; i += 1) {
    const cells = splitCsvLine(rawLines[i]!);
    const dateStr = cells[cols.dateIdx];
    if (!dateStr) continue;
    const timeStr = cols.timeIdx >= 0 ? cells[cols.timeIdx] ?? null : null;
    const wall = parseRawWall(dateStr, timeStr, opts.dateFormat);
    if (!wall) {
      parseFailures += 1;
      continue;
    }
    // Convert the input-tz wall time to ET wall parts.
    const et = tzIsEt
      ? wall
      : partsInZone(zonedWallToUtcMs(wall, opts.tz), MARKET_TZ);
    const dateKey = `${et.y}-${pad2(et.mo)}-${pad2(et.d)}`;
    if (dateKey < opts.start || dateKey > opts.end) continue;
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
    const volRaw =
      cols.volumeIdx >= 0 ? Number.parseFloat(cells[cols.volumeIdx] ?? '') : NaN;
    const volume = Number.isFinite(volRaw) ? volRaw : null;
    bars.push({ dateKey, minOfDay, open, high, low, close, volume });
  }

  const byDay = new Map<string, EsBar[]>();
  for (const b of bars) {
    const arr = byDay.get(b.dateKey) ?? [];
    arr.push(b);
    byDay.set(b.dateKey, arr);
  }
  for (const arr of byDay.values()) arr.sort((a, b) => a.minOfDay - b.minOfDay);
  const days = [...byDay.keys()].sort();

  return { bars, byDay, days, parseFailures };
}

// ---------------------------------------------------------------------------
// SPX daily fetch (Yahoo chart API). Yahoo's `^GSPC` IS the S&P 500 cash index
// (same value as CBOE:SPX). The daily bar timestamp is the 09:30 ET open, so we
// map it to its ET calendar date.
// ---------------------------------------------------------------------------

export interface SpxDaily {
  open: number;
  close: number;
}

const SECONDS_PER_DAY = 86400;

export async function fetchSpxDaily(
  symbol: string,
  start: string,
  end: string,
): Promise<Map<string, SpxDaily>> {
  // Pad the window by a day on each side so boundary trading days are included
  // regardless of tz; we filter by ET date when mapping anyway.
  const p1 = Math.floor(Date.parse(`${start}T00:00:00Z`) / 1000) - SECONDS_PER_DAY;
  const p2 = Math.floor(Date.parse(`${end}T00:00:00Z`) / 1000) + 2 * SECONDS_PER_DAY;
  const url =
    `${YAHOO_CHART_BASE}${encodeURIComponent(symbol)}` +
    `?period1=${p1}&period2=${p2}&interval=1d`;
  const res = await fetch(url, { headers: { 'user-agent': YAHOO_UA } });
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
        `(error: ${JSON.stringify(json.chart?.error)}). Try a different symbol.`,
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
// Live 1-min bars (Yahoo chart API). Same endpoint as the daily fetch but at
// 1-min granularity, available only for a recent rolling window. Used by both
// the accuracy test (`ES=F` vs `^GSPC`) and the live ingest (`scripts/live-
// prices.ts`), so the fetch/parse lives here as the single source of truth.
// ---------------------------------------------------------------------------

export interface Yahoo1mBar {
  dateKey: string; // ET YYYY-MM-DD
  minOfDay: number; // ET minutes since midnight
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

/**
 * Fetch recent 1-min RTH bars for a Yahoo symbol, grouped & sorted by ET trading
 * day. `range` is Yahoo's lookback window (e.g. '1d' for just the live session,
 * '5d' to find the latest complete day). Off-RTH minutes are dropped so both the
 * cash index (RTH-only) and the future align on the same 09:30–16:00 ET grid.
 */
export async function fetchYahoo1mByDay(
  symbol: string,
  range = '5d',
): Promise<Map<string, Yahoo1mBar[]>> {
  const url =
    `${YAHOO_CHART_BASE}${encodeURIComponent(symbol)}` +
    `?range=${encodeURIComponent(range)}&interval=1m`;
  const res = await fetch(url, { headers: { 'user-agent': YAHOO_UA } });
  if (!res.ok) {
    throw new Error(`Yahoo 1m fetch failed: HTTP ${res.status} for ${symbol}`);
  }
  const json = (await res.json()) as {
    chart?: {
      result?: Array<{
        timestamp?: number[];
        indicators?: {
          quote?: Array<{
            open?: (number | null)[];
            high?: (number | null)[];
            low?: (number | null)[];
            close?: (number | null)[];
            volume?: (number | null)[];
          }>;
        };
      }>;
      error?: unknown;
    };
  };
  const result = json.chart?.result?.[0];
  const ts = result?.timestamp;
  const q = result?.indicators?.quote?.[0];
  if (!ts || !q?.open || !q?.high || !q?.low || !q?.close) {
    throw new Error(
      `Unexpected Yahoo 1m response for "${symbol}" (error: ${JSON.stringify(json.chart?.error)}).`,
    );
  }

  const byDay = new Map<string, Yahoo1mBar[]>();
  for (let i = 0; i < ts.length; i += 1) {
    const o = q.open[i];
    const h = q.high[i];
    const l = q.low[i];
    const c = q.close[i];
    if (o == null || h == null || l == null || c == null) continue;
    const et = partsInZone(ts[i]! * 1000, MARKET_TZ);
    const minOfDay = et.h * 60 + et.mi;
    if (minOfDay < RTH_OPEN_MIN || minOfDay > RTH_CLOSE_MIN) continue;
    const dateKey = `${et.y}-${pad2(et.mo)}-${pad2(et.d)}`;
    const arr = byDay.get(dateKey) ?? [];
    arr.push({
      dateKey,
      minOfDay,
      open: o,
      high: h,
      low: l,
      close: c,
      volume: q.volume?.[i] ?? null,
    });
    byDay.set(dateKey, arr);
  }
  for (const arr of byDay.values()) arr.sort((a, b) => a.minOfDay - b.minOfDay);
  return byDay;
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

export interface SpxBar {
  dateKey: string; // ET YYYY-MM-DD
  minOfDay: number; // ET minutes since midnight
  esOpen: number;
  esHigh: number;
  esLow: number;
  esClose: number;
  esVolume: number | null;
  spxOpen: number;
  spxHigh: number;
  spxLow: number;
  spxClose: number;
  basis: number;
}

export interface ConvertResult {
  bars: SpxBar[]; // flat, chronological across days
  maxSpread: number;
  maxSpreadDay: string;
  missingDays: number;
  thinDays: number;
  warnings: string[];
}

// Thin-liquidity guard: a day is flagged when its calibration anchors are
// untrustworthy — too few bars, or the first/last bar sits too far from the
// 09:30/16:00 bell (a back-month contract can barely trade).
const MIN_RTH_BARS_FOR_ANCHOR = 40;
const ANCHOR_EDGE_TOLERANCE_MIN = 15;

/**
 * Convert grouped ES bars to SPX bars by calibrating the per-day basis against
 * the real SPX daily open/close. Days with no SPX cash print (holidays) are
 * dropped; thin-coverage days are flagged in `warnings`.
 */
export function convertEsToSpx(
  byDay: Map<string, EsBar[]>,
  days: string[],
  spxDaily: Map<string, SpxDaily>,
  anchor: Anchor,
): ConvertResult {
  const bars: SpxBar[] = [];
  const warnings: string[] = [];
  let maxSpread = 0;
  let maxSpreadDay = '';
  let missingDays = 0;
  let thinDays = 0;

  for (const day of days) {
    const dayBars = byDay.get(day)!;
    const esOpen = dayBars[0]!.open;
    const esClose = dayBars[dayBars.length - 1]!.close;
    const openMin = dayBars[0]!.minOfDay;
    const closeMin = dayBars[dayBars.length - 1]!.minOfDay;

    // No real SPX print for this ET date → market holiday (SPX closed). There
    // is no "real" cash index to match, so drop the day rather than invent one.
    const truth = spxDaily.get(day);
    if (!truth) {
      missingDays += 1;
      warnings.push(`WARN ${day}: no SPX cash print (market holiday?) — dropped.`);
      continue;
    }
    const basisOpen = esOpen - truth.open;
    const basisClose = esClose - truth.close;

    if (
      dayBars.length < MIN_RTH_BARS_FOR_ANCHOR ||
      openMin > RTH_OPEN_MIN + ANCHOR_EDGE_TOLERANCE_MIN ||
      closeMin < RTH_CLOSE_MIN - ANCHOR_EDGE_TOLERANCE_MIN
    ) {
      thinDays += 1;
      warnings.push(
        `WARN ${day}: thin RTH coverage (${dayBars.length} bars, ` +
          `first ${pad2(Math.floor(openMin / 60))}:${pad2(openMin % 60)}, ` +
          `last ${pad2(Math.floor(closeMin / 60))}:${pad2(closeMin % 60)}) — ` +
          'anchors may be unreliable. Use the front-month contract for this day.',
      );
    }

    const spread = Math.abs(basisClose - basisOpen);
    if (spread > maxSpread) {
      maxSpread = spread;
      maxSpreadDay = day;
    }

    const span = closeMin - openMin || 1;
    for (const b of dayBars) {
      // close (default): flat basis anchored on the clean official close.
      // openclose: linear interpolation between the open and close anchors.
      const basis =
        anchor === 'openclose'
          ? basisOpen + ((b.minOfDay - openMin) / span) * (basisClose - basisOpen)
          : basisClose;
      bars.push({
        dateKey: day,
        minOfDay: b.minOfDay,
        esOpen: b.open,
        esHigh: b.high,
        esLow: b.low,
        esClose: b.close,
        esVolume: b.volume,
        spxOpen: b.open - basis,
        spxHigh: b.high - basis,
        spxLow: b.low - basis,
        spxClose: b.close - basis,
        basis,
      });
    }
  }

  return { bars, maxSpread, maxSpreadDay, missingDays, thinDays, warnings };
}
