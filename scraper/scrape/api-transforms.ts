/**
 * Pure transforms from intercepted dashboard/4 API payloads into the
 * DB row shapes (SnapshotRow[], MarketTideRow[]) plus the small timestamp
 * helpers they need. No browser, no DB, no I/O — just data shaping, so
 * these are the easiest pieces of the engine to reason about and test.
 */
import type { Panel, SnapshotRow, MarketTideRow } from '../core/types.js';
import type {
  ApiExposureRow,
  ApiExposureResponse,
  ApiContractsResponse,
  ApiStraddleResponse,
  ApiNetFlowResponse,
} from './api-types.js';

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
): { rows: SnapshotRow[]; spot: number; timeframe: string; expiry: string; qualifyingStrikes: Set<number> } {
  const rows: SnapshotRow[] = [];
  const timeframe = apiTimestampToTimeframe(apiData.timestamp);
  const expiry = apiData.date; // YYYY-MM-DD
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
 * Convert an API contracts response into SnapshotRow[] for positions.
 * Each strike has a call row and a put row — we net them (call_qty + put_qty)
 * to produce one SnapshotRow per strike with panel='positions'.
 * Only includes strikes that appear in `qualifyingStrikes` (gamma-gated).
 */
export function contractsResponseToRows(
  apiData: ApiContractsResponse,
  capturedAt: string,
  qualifyingStrikes: ReadonlySet<number>,
): SnapshotRow[] {
  const timeframe = apiTimestampToTimeframe(apiData.timestamp);
  const expiry = apiData.date;

  // Aggregate net qty per strike (call + put).
  const netByStrike = new Map<number, number>();
  for (const row of apiData.data) {
    if (!qualifyingStrikes.has(row.strike)) continue;
    const prev = netByStrike.get(row.strike) ?? 0;
    netByStrike.set(row.strike, prev + row.qty);
  }

  const rows: SnapshotRow[] = [];
  for (const [strike, value] of netByStrike) {
    rows.push({
      capturedAt,
      expiry,
      panel: 'positions',
      strike,
      value,
      timeframe,
    });
  }
  return rows;
}

/** Parse the ATM straddle (cone param) from a straddle response. */
export function parseStraddle(body: ApiStraddleResponse): number | null {
  const v = Number.parseFloat(body.straddle);
  return Number.isFinite(v) ? v : null;
}

/**
 * Convert a net-flow-ticks response (1-min Market Tide series) into
 * 10-min-aligned MarketTideRow[]. UW timestamps carry a whole-hour ET
 * offset, so UTC minutes equal ET minutes — `getUTCMinutes() % 10`
 * cleanly selects the slot boundaries (09:30, 09:40, …, 16:00).
 */
export function netFlowToTideRows(body: ApiNetFlowResponse, date: string): MarketTideRow[] {
  const out: MarketTideRow[] = [];
  for (const pt of body.data ?? []) {
    const d = new Date(pt.timestamp);
    if (Number.isNaN(d.getTime())) continue;
    if (d.getUTCMinutes() % 10 !== 0) continue;
    const ncp = Number.parseFloat(pt.net_call_premium);
    const npp = Number.parseFloat(pt.net_put_premium);
    const nv = Number(pt.net_volume);
    if (!Number.isFinite(ncp) || !Number.isFinite(npp) || !Number.isFinite(nv)) {
      continue;
    }
    out.push({
      capturedAt: d.toISOString(),
      date: pt.date ?? date,
      netCallPremium: ncp,
      netPutPremium: npp,
      netVolume: nv,
    });
  }
  return out;
}
