/**
 * Pure transforms from intercepted dashboard/4 API payloads into the
 * DB row shapes (SnapshotRow[], MarketTideRow[]) plus the small timestamp
 * helpers they need. No browser, no DB, no I/O — just data shaping, so
 * these are the easiest pieces of the engine to reason about and test.
 */
import type { Panel, SnapshotRow, MarketTideRow, PositionRow } from '../core/types.js';
import type {
  ApiExposureRow,
  ApiExposureResponse,
  ApiContractsResponse,
  ApiStraddleResponse,
  ApiNetFlowResponse,
  ApiIntradayCandle,
  ApiCandleEntry,
} from './api-types.js';

/** A single SPX spot observation ready for insertSpotPrices. */
export interface SpotRow {
  capturedAt: string;
  expiry: string;
  spot: number;
}

const FIVE_MIN_MS = 5 * 60 * 1000;

/**
 * Minimum gamma magnitude (|gamma|) for a strike to be persisted. Strikes
 * whose gamma is within ±this value are dropped entirely, along with their
 * charm/vanna rows — gamma is the anchor that gates the whole strike.
 */
const GAMMA_MIN_ABS = 150;

/** Greeks present in the API response, in capture order. */
const GREEKS_TO_CAPTURE: ReadonlyArray<{ panel: Panel; key: keyof Pick<ApiExposureRow, 'gamma' | 'charm' | 'vanna'> }> = [
  { panel: 'gamma', key: 'gamma' },
  { panel: 'charm', key: 'charm' },
  { panel: 'vanna', key: 'vanna' },
];

/**
 * Convert a UTC ISO timestamp (from the API response) to an ET HH:MM
 * string. Used to derive the timeframe label for DB rows so it matches
 * exactly what the UW dashboard shows (Eastern Time).
 */
export function utcToETHhmm(utcIso: string): string {
  const d = new Date(utcIso);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${hour}:${minute}`;
}

/**
 * Derive a UW-style timeframe label from an API timestamp.
 * The API timestamp represents the slot END time.
 * Returns e.g. "09:20 - 09:30" (ET) from the end time "09:30".
 */
export function apiTimestampToTimeframe(utcIso: string): string {
  const endHhmm = utcToETHhmm(utcIso);
  // Slot start is 10 minutes before end
  const d = new Date(utcIso);
  d.setMinutes(d.getMinutes() - 10);
  const startHhmm = utcToETHhmm(d.toISOString());
  return `${startHhmm} - ${endHhmm}`;
}

/**
 * Convert an API exposure response into SnapshotRow[] for all three Greeks.
 * Each row in the API data has gamma, charm, vanna as string fields — we
 * parse them into numeric values and emit one SnapshotRow per (strike, greek).
 */
export function apiResponseToRows(
  apiData: ApiExposureResponse,
  capturedAt: string,
  expiryOverride?: string,
): { rows: SnapshotRow[]; spot: number; timeframe: string; expiry: string; qualifyingStrikes: Set<number> } {
  const rows: SnapshotRow[] = [];
  const timeframe = apiTimestampToTimeframe(apiData.timestamp);
  // apiData.date is the trading-SESSION date, which equals the expiry only
  // for 0DTE. For a non-0DTE expiry the caller passes expiryOverride (the
  // expiry selected in the Expiry filter / URL param).
  const expiry = expiryOverride ?? apiData.date; // YYYY-MM-DD
  const spot = apiData.index_values.close;

  const dataRows = Object.values(apiData.data);

  // Gamma is the anchor: only persist strikes whose gamma magnitude exceeds
  // the threshold. Charm/Vanna for a strike are kept only when that same
  // strike's gamma qualifies — i.e. a strike is all-or-nothing across Greeks.
  const qualifyingStrikes = new Set<number>();
  for (const row of dataRows) {
    const gamma = Number.parseFloat(row.gamma);
    if (Number.isFinite(gamma) && Math.abs(gamma) > GAMMA_MIN_ABS) {
      qualifyingStrikes.add(row.strike);
    }
  }

  for (const greek of GREEKS_TO_CAPTURE) {
    for (const row of dataRows) {
      if (!qualifyingStrikes.has(row.strike)) continue;
      const valueStr = row[greek.key];
      const value = Number.parseFloat(valueStr);
      if (!Number.isFinite(value)) continue;
      // Skip rows where all Greeks are zero (noise at extreme strikes)
      // Keep zero values though since they can be meaningful at specific strikes
      rows.push({
        capturedAt,
        expiry,
        panel: greek.panel,
        strike: row.strike,
        value,
        timeframe,
      });
    }
  }

  return { rows, spot, timeframe, expiry, qualifyingStrikes };
}

/**
 * Convert an API contracts response into PositionRow[] — one row per strike
 * with separate call_qty and put_qty columns. Only includes strikes that
 * appear in `qualifyingStrikes` (gamma-gated).
 */
export function contractsResponseToRows(
  apiData: ApiContractsResponse,
  capturedAt: string,
  qualifyingStrikes: ReadonlySet<number>,
  expiryOverride?: string,
): PositionRow[] {
  const timeframe = apiTimestampToTimeframe(apiData.timestamp);
  // apiData.date is the trading-SESSION date (== expiry only for 0DTE).
  const expiry = expiryOverride ?? apiData.date;

  const callByStrike = new Map<number, number>();
  const putByStrike = new Map<number, number>();
  for (const row of apiData.data) {
    if (!qualifyingStrikes.has(row.strike)) continue;
    if (row.type === 'call') {
      callByStrike.set(row.strike, (callByStrike.get(row.strike) ?? 0) + row.qty);
    } else {
      putByStrike.set(row.strike, (putByStrike.get(row.strike) ?? 0) + row.qty);
    }
  }

  const strikes = new Set([...callByStrike.keys(), ...putByStrike.keys()]);
  const rows: PositionRow[] = [];
  for (const strike of strikes) {
    const callQty = callByStrike.get(strike) ?? 0;
    const putQty = putByStrike.get(strike) ?? 0;
    if (callQty === 0 && putQty === 0) continue;
    rows.push({ capturedAt, expiry, strike, callQty, putQty, timeframe });
  }
  return rows;
}

/** ET calendar date (YYYY-MM-DD) of a UTC instant. */
export function etDateOf(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/**
 * Bucket intraday 5-min SPX index candles into clean 5-min spot rows, keyed by
 * ET trading date. This is the ONLY source of *historical* intraday SPX price:
 * the date-keyed tick endpoints (net-flow-ticks, one_minute_ticks) ignore their
 * `date` param and always return the latest session, while the MME
 * `index_values.close` is the session's settled close (constant all day).
 *
 * The candle `start` is offset from the wall-clock grid (e.g. 13:34Z), so we
 * snap it to the nearest 5-min boundary (→ 13:35Z) to align with the Market
 * Tide cadence; `o` (open) is the spot — the price AT the candle's start, so
 * it lines up with that boundary timestamp (the slot instant the Greeks /
 * Market Tide rows are stamped at). Using the close instead would store the
 * price ~5 min later under the start's label. After-hours points survive here
 * but are dropped by the RTH filter at insert time. The 5m endpoint only
 * reaches ~30 trading days back (a server row cap), so older days aren't
 * returned and the caller falls back to the daily close.
 */
export function candles5mToSpotRowsByDate(
  candles: ReadonlyArray<ApiIntradayCandle>,
): Map<string, SpotRow[]> {
  const byDate = new Map<string, Map<string, SpotRow>>();
  for (const c of candles) {
    const t = new Date(c.start).getTime();
    if (Number.isNaN(t)) continue;
    const spot = Number.parseFloat(c.o);
    if (!Number.isFinite(spot) || spot <= 0) continue;
    const snapped = new Date(Math.round(t / FIVE_MIN_MS) * FIVE_MIN_MS);
    const capturedAt = snapped.toISOString();
    const date = etDateOf(snapped);
    let slots = byDate.get(date);
    if (slots === undefined) {
      slots = new Map<string, SpotRow>();
      byDate.set(date, slots);
    }
    slots.set(capturedAt, { capturedAt, expiry: date, spot });
  }
  const out = new Map<string, SpotRow[]>();
  for (const [date, slots] of byDate) {
    out.set(
      date,
      [...slots.values()].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt)),
    );
  }
  return out;
}

/**
 * Single daily-close spot row for `date` from the daily SPX candles, stamped at
 * `capturedAt` (the session close, 16:00 ET). Backfill fallback for days older
 * than the intraday 5-min window, where only daily OHLC is available
 * historically. Returns [] when the date isn't in the candle set.
 */
export function dailyCloseSpotRow(
  candles: ReadonlyArray<ApiCandleEntry>,
  date: string,
  capturedAt: string,
): SpotRow[] {
  const entry = candles.find((e) => e.date === date);
  if (entry === undefined) return [];
  const spot = Number.parseFloat(entry.c);
  if (!Number.isFinite(spot) || spot <= 0) return [];
  return [{ capturedAt, expiry: date, spot }];
}

/** Parse the ATM straddle (cone param) from a straddle response. */
export function parseStraddle(body: ApiStraddleResponse): number | null {
  const v = Number.parseFloat(body.straddle);
  return Number.isFinite(v) ? v : null;
}

/**
 * Convert a net-flow-ticks response (1-min Market Tide series) into
 * 5-min-aligned MarketTideRow[]. UW timestamps carry a whole-hour ET
 * offset, so UTC minutes equal ET minutes — `getUTCMinutes() % 5`
 * cleanly selects the slot boundaries (09:30, 09:35, 09:40, …, 16:00).
 * Market Tide (and spot) refresh every 5 min, twice as often as the
 * 10-min Greeks/positions cadence, so we keep every 5-min point.
 *
 * `expectedDate` (YYYY-MM-DD, ET) gates the rows by each point's own `date`
 * field. This is essential for backfill: the net-flow-ticks endpoint IGNORES
 * its `date` query param and always returns the LATEST session, so a backfill
 * day would otherwise persist today's tide stamped at today's instants — rows
 * whose captured_at is unrelated to the day being scraped. When omitted, no
 * date gate is applied (callers that genuinely want whatever was returned).
 */
export function netFlowToTideRows(
  body: ApiNetFlowResponse,
  expectedDate?: string,
): MarketTideRow[] {
  const out: MarketTideRow[] = [];
  for (const pt of body.data ?? []) {
    if (expectedDate != null && pt.date !== expectedDate) continue;
    const d = new Date(pt.timestamp);
    if (Number.isNaN(d.getTime())) continue;
    if (d.getUTCMinutes() % 5 !== 0) continue;
    const ncp = Number.parseFloat(pt.net_call_premium);
    const npp = Number.parseFloat(pt.net_put_premium);
    const nv = Number(pt.net_volume);
    if (!Number.isFinite(ncp) || !Number.isFinite(npp) || !Number.isFinite(nv)) {
      continue;
    }
    out.push({
      capturedAt: d.toISOString(),
      netCallPremium: ncp,
      netPutPremium: npp,
      netVolume: nv,
    });
  }
  return out;
}
