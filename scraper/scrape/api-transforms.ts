/**
 * Pure transforms from intercepted dashboard/4 API payloads into the
 * DB row shapes (SnapshotRow[], MarketTideRow[]) plus the small timestamp
 * helpers they need. No browser, no DB, no I/O — just data shaping, so
 * these are the easiest pieces of the engine to reason about and test.
 */
import { GAMMA_MIN_ABS } from '../core/types.js';
import type { Panel, SnapshotRow, MarketTideRow, PositionRow } from '../core/types.js';
import type {
  ApiPeriscopeExposuresResponse,
  ApiPeriscopePositionsResponse,
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
const ONE_MIN_MS = 60 * 1000;

/** Greeks present in the API response, in capture order. `delta` also
 *  arrives from the new endpoint but is not persisted (DB `panel` CHECK). */
const GREEKS_TO_CAPTURE: ReadonlyArray<{ panel: Panel; key: 'gamma' | 'charm' | 'vanna' }> = [
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
 * Derive a UW-style timeframe label from an API snapshot instant.
 * The new periscope endpoints publish one snapshot per MINUTE, and the
 * timestamp is the minute's END instant, so the label spans one minute:
 * e.g. "09:29 - 09:30" (ET) for the instant "…T13:30:00Z" (EDT).
 * (The pre-2026-07 endpoints published 10-min slots — old DB rows carry
 * "09:20 - 09:30"-style labels; parseSlotEnd handles both.)
 */
export function apiTimestampToTimeframe(utcIso: string): string {
  const endHhmm = utcToETHhmm(utcIso);
  const d = new Date(utcIso);
  d.setMinutes(d.getMinutes() - 1);
  const startHhmm = utcToETHhmm(d.toISOString());
  return `${startHhmm} - ${endHhmm}`;
}

/**
 * Convert a periscope/exposures response into SnapshotRow[] for all three
 * persisted Greeks. `expiry` is REQUIRED: the new response carries no
 * date/expiry field, so rows are stamped with the `expiries=` filter the
 * request was made with.
 */
export function exposuresToRows(
  apiData: ApiPeriscopeExposuresResponse,
  capturedAt: string,
  expiry: string,
): { rows: SnapshotRow[]; timeframe: string; qualifyingStrikes: Set<number> } {
  const rows: SnapshotRow[] = [];
  const timeframe = apiTimestampToTimeframe(capturedAt);

  // Defensive: dashboard/4 serves the market_maker participant only, but
  // keep the filter explicit in case UW adds buckets to this endpoint.
  const dataRows = (apiData.data ?? []).filter(
    (r) => r.participant == null || r.participant === 'market_maker',
  );

  // Gamma is the anchor: only persist strikes whose gamma magnitude exceeds
  // the threshold. Charm/Vanna for a strike are kept only when that same
  // strike's gamma qualifies — i.e. a strike is all-or-nothing across Greeks.
  const qualifyingStrikes = new Set<number>();
  for (const row of dataRows) {
    const gamma = Number(row.gamma);
    if (Number.isFinite(gamma) && Math.abs(gamma) > GAMMA_MIN_ABS) {
      qualifyingStrikes.add(row.strike);
    }
  }

  for (const greek of GREEKS_TO_CAPTURE) {
    for (const row of dataRows) {
      if (!qualifyingStrikes.has(row.strike)) continue;
      const value = Number(row[greek.key]);
      if (!Number.isFinite(value)) continue;
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

  return { rows, timeframe, qualifyingStrikes };
}

/**
 * Convert a periscope/positions response into PositionRow[] — one row per
 * strike with separate call_qty and put_qty columns (from the row's
 * `market_maker` net quantity). Only includes strikes that appear in
 * `qualifyingStrikes` (gamma-gated). `expiry` is required for the same
 * reason as in exposuresToRows.
 */
export function positionsToRows(
  apiData: ApiPeriscopePositionsResponse,
  capturedAt: string,
  qualifyingStrikes: ReadonlySet<number>,
  expiry: string,
): PositionRow[] {
  const timeframe = apiTimestampToTimeframe(capturedAt);

  const callByStrike = new Map<number, number>();
  const putByStrike = new Map<number, number>();
  for (const row of apiData.data ?? []) {
    if (!qualifyingStrikes.has(row.strike)) continue;
    const qty = Number(row.market_maker);
    if (!Number.isFinite(qty)) continue;
    if (row.option_type === 'call') {
      callByStrike.set(row.strike, (callByStrike.get(row.strike) ?? 0) + qty);
    } else {
      putByStrike.set(row.strike, (putByStrike.get(row.strike) ?? 0) + qty);
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
  // Two-level map: ET date → (snapped slot instant → row). The inner map is
  // keyed by the snapped timestamp so two candles landing in the same 5-min
  // slot collapse to one row (last write wins), keeping the series clean.
  const byDate = new Map<string, Map<string, SpotRow>>();
  for (const c of candles) {
    const t = new Date(c.start).getTime();
    if (Number.isNaN(t)) continue; // skip unparseable timestamps
    const spot = Number.parseFloat(c.o); // `o` (open) = spot at candle start
    if (!Number.isFinite(spot) || spot <= 0) continue; // skip junk prices
    // Snap the off-grid candle start to the nearest 5-min boundary so the row
    // lines up with the Market Tide / Greeks slot instants.
    const snapped = new Date(Math.round(t / FIVE_MIN_MS) * FIVE_MIN_MS);
    const capturedAt = snapped.toISOString();
    const date = etDateOf(snapped); // ET trading date this slot belongs to
    let slots = byDate.get(date);
    if (slots === undefined) {
      slots = new Map<string, SpotRow>();
      byDate.set(date, slots);
    }
    slots.set(capturedAt, { capturedAt, expiry: date, spot });
  }
  // Flatten each date's slot map to a chronologically sorted row array.
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
 * Bucket intraday 1-MIN SPX index candles into per-minute spot rows, keyed by
 * ET trading date. Unlike the 5-min series — whose OHLC is misaligned to its
 * label (UW's 5m aggregation scrambles a bar's open/close across its window, so
 * the stored open and close belong to different minutes) — the 1m candles are
 * clean, on-grid, and match TradingView.
 *
 * Each row is keyed at the candle's START minute (how TradingView labels a bar)
 * with value = the candle CLOSE (the minute's settle). That pairing is exactly
 * what the algo's `spotAtClose` join wants: for a Greek slot ending at T it
 * reads the spot row keyed at T−1min, i.e. the bar that CLOSES at T.
 *
 * This is only a FALLBACK for backfill spot: the authoritative source is the
 * Yahoo ^GSPC feed ingested by scripts/backfill-prices.ts (Yahoo's 1-min data
 * reaches ~30 days back; this UW endpoint is server-capped to ~6 trading days
 * back). Both use the identical bar-start/close convention, so they agree.
 */
export function candles1mToSpotRowsByDate(
  candles: ReadonlyArray<ApiIntradayCandle>,
): Map<string, SpotRow[]> {
  const byDate = new Map<string, Map<string, SpotRow>>();

  for (const c of candles) {
    const t = new Date(c.start).getTime();
    if (Number.isNaN(t)) continue; // skip unparseable timestamps
    const close = Number.parseFloat(c.c); // `c` (close) = the minute's settle
    if (!Number.isFinite(close) || close <= 0) continue; // skip junk prices
    // 1m candles are already on the minute grid; snap defensively so a stray
    // sub-minute offset can't spawn a duplicate off-grid key.
    const snapped = new Date(Math.round(t / ONE_MIN_MS) * ONE_MIN_MS);
    const capturedAt = snapped.toISOString();
    const date = etDateOf(snapped);

    let slots = byDate.get(date);
    if (slots === undefined) {
      slots = new Map<string, SpotRow>();
      byDate.set(date, slots);
    }
    slots.set(capturedAt, { capturedAt, expiry: date, spot: close });
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
