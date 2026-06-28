/**
 * Data loader: fetches periscope_snapshots from Neon Postgres and
 * pivots per-panel rows into unified Snapshot objects for the algo.
 *
 * Also provides a spot-price loader (from the spot_prices table added
 * by the pipeline extension) and a fallback that extracts spot from
 * the gamma panel's header if the dedicated table doesn't exist yet.
 */

import { getDb } from '../db/index.js';
import type { ConeEndpoints, Snapshot, StrikeData } from './types.js';

/**
 * Load snapshots for a single trading day, joining gamma/charm/vanna
 * rows at each captured_at into unified Snapshot objects.
 *
 * @param date  YYYY-MM-DD trading day
 * @param strikeWindow  Only include strikes within this range of spot
 * @returns Snapshots sorted by captured_at ascending
 */
export async function loadDay(
  date: string,
  strikeWindow: number = 120,
): Promise<Snapshot[]> {
  const sql = getDb();

  // Step 1: Get all snapshot rows for this expiry date across the panels.
  // expiry is a DATE column; cast it to text so the Neon driver returns a
  // clean "YYYY-MM-DD" string rather than a JS Date (whose String() form is
  // host-timezone-dependent and breaks re-casts on non-UTC machines).
  const rows = await sql(
    `SELECT to_char(captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS captured_at,
            expiry::text AS expiry, panel, strike, value, timeframe
     FROM periscope_snapshots
     WHERE expiry = $1
       AND panel IN ('gamma', 'charm', 'vanna', 'positions')
     ORDER BY captured_at, strike`,
    [date],
  );

  if (rows.length === 0) return [];

  // Step 2: Try to get spot prices from dedicated table, plus the day's cone
  const spotRows = await loadSpotPrices(date);
  const cone = await loadCone(date);

  // Step 3: Group rows by captured_at
  const byTime = new Map<string, { timeframe: string; expiry: string; strikes: Map<number, Partial<StrikeData>> }>();

  type GreekPanel = 'gamma' | 'charm' | 'vanna' | 'positions';

  for (const row of rows) {
    const capturedAt = String(row.captured_at);
    let group = byTime.get(capturedAt);
    if (!group) {
      group = {
        timeframe: String(row.timeframe),
        expiry: String(row.expiry),
        strikes: new Map(),
      };
      byTime.set(capturedAt, group);
    }

    const strike = Number(row.strike);
    let sd = group.strikes.get(strike);
    if (!sd) {
      sd = { strike, gamma: 0, charm: 0, vanna: 0, positions: 0 };
      group.strikes.set(strike, sd);
    }

    const panel = String(row.panel) as GreekPanel;
    sd[panel] = Number(row.value);
  }

  // Step 4: Build Snapshot objects
  const snapshots: Snapshot[] = [];

  for (const [capturedAt, group] of byTime) {
    // Get spot price: prefer dedicated table, fall back to estimation
    const spot = spotRows.get(capturedAt) ?? estimateSpotFromStrikes(group.strikes);
    if (spot === null) continue; // Can't build snapshot without spot

    // Filter strikes to within strikeWindow of spot
    const strikes: StrikeData[] = [];
    for (const sd of group.strikes.values()) {
      if (Math.abs(sd.strike! - spot) <= strikeWindow) {
        strikes.push(sd as StrikeData);
      }
    }

    // Require at least some gamma data to consider this a valid snapshot
    const hasGamma = strikes.some((s) => s.gamma !== 0);
    if (!hasGamma) continue;

    snapshots.push({
      capturedAt,
      expiry: group.expiry,
      timeframe: group.timeframe,
      spot,
      strikes: strikes.sort((a, b) => a.strike - b.strike),
      cone,
    });
  }

  return snapshots.sort(
    (a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime(),
  );
}

/**
 * Load spot prices from the dedicated spot_prices table.
 * Returns a Map of captured_at → spot price.
 * Returns empty map if the table doesn't exist yet.
 */
async function loadSpotPrices(date: string): Promise<Map<string, number>> {
  const sql = getDb();
  const map = new Map<string, number>();

  try {
    const rows = await sql(
      // Same captured_at rendering as loadDay so the join keys match exactly.
      `SELECT to_char(captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS captured_at, spot
       FROM spot_prices
       WHERE date = $1
       ORDER BY captured_at`,
      [date],
    );
    for (const row of rows) {
      map.set(String(row.captured_at), Number(row.spot));
    }
  } catch {
    // Table doesn't exist yet — caller will use fallback
  }

  return map;
}

/**
 * Load the day's expected-move cone from the `cone_snapshots` table.
 * Returns the three stored points (apex + two end-of-day endpoints) or `null`
 * when no cone was captured for the day (or the table doesn't exist yet).
 *
 * Matched by ET date — mirrors the `AT TIME ZONE 'America/New_York'` predicate
 * the scraper uses in `db/cone.ts`, since the cone row is keyed at 09:30 ET.
 */
export async function loadCone(date: string): Promise<ConeEndpoints | null> {
  const sql = getDb();
  try {
    const rows = await sql(
      `SELECT spx_open, cone_upper, cone_lower
       FROM cone_snapshots
       WHERE (captured_at AT TIME ZONE 'America/New_York')::date = $1::date
       LIMIT 1`,
      [date],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      spxOpen: Number(r.spx_open),
      coneUpper: Number(r.cone_upper),
      coneLower: Number(r.cone_lower),
    };
  } catch {
    // cone_snapshots table may not exist yet — cone simply unavailable.
    return null;
  }
}

/**
 * Fallback spot estimation: use the median strike that has gamma data.
 * This is a rough approximation — the ATM strike (highest absolute gamma)
 * is typically near spot. Returns null if no strikes have data.
 */
function estimateSpotFromStrikes(
  strikes: Map<number, Partial<StrikeData>>,
): number | null {
  // The strike with the highest absolute gamma is typically closest to spot
  let maxAbsGamma = 0;
  let spotEstimate: number | null = null;

  for (const sd of strikes.values()) {
    const absGamma = Math.abs(sd.gamma ?? 0);
    if (absGamma > maxAbsGamma) {
      maxAbsGamma = absGamma;
      spotEstimate = sd.strike!;
    }
  }

  return spotEstimate;
}

/**
 * Load snapshots for a date range (for backtesting).
 * Returns a flat array sorted by captured_at across all days.
 */
export async function loadDateRange(
  startDate: string,
  endDate: string,
  strikeWindow: number = 120,
): Promise<Snapshot[]> {
  const sql = getDb();

  // Get distinct trading days in range that have data. Cast expiry to text
  // (see loadDay) so `day` is a plain "YYYY-MM-DD" string when fed back into
  // per-day queries — a JS Date here would re-serialize with the host TZ and
  // make `$1::date` casts fail on non-UTC machines.
  const dayRows = await sql(
    `SELECT DISTINCT expiry::text AS expiry
     FROM periscope_snapshots
     WHERE expiry >= $1 AND expiry <= $2
       AND panel = 'gamma'
     ORDER BY expiry`,
    [startDate, endDate],
  );

  const allSnapshots: Snapshot[] = [];
  for (const dayRow of dayRows) {
    const day = String(dayRow.expiry);
    const daySnapshots = await loadDay(day, strikeWindow);
    allSnapshots.push(...daySnapshots);
  }

  return allSnapshots;
}

/**
 * Get all available trading dates with data.
 */
export async function getAvailableDates(): Promise<string[]> {
  const sql = getDb();
  const rows = await sql(
    `SELECT DISTINCT expiry::text AS expiry
     FROM periscope_snapshots
     WHERE panel = 'gamma'
     ORDER BY expiry`,
  );
  return rows.map((r) => String(r.expiry));
}
