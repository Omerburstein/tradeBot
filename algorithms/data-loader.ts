/**
 * Data loader: fetches periscope_snapshots from Neon Postgres and
 * pivots per-panel rows into unified Snapshot objects for the algo.
 *
 * 0DTE ONLY: every query is restricted to snapshots whose ET capture
 * session equals the expiry (true 0DTE). The scraper also stores
 * forward-expiry (1DTE+) captures — e.g. the 2026-02-12 expiry captured
 * on 2026-02-11 — whose `captured_at` instants live on a different day
 * than their `expiry`. Mixing those in silently mis-joined them against
 * the wrong day's prices, so they are filtered out here.
 *
 * Spot/ES come from the dedicated spot_prices / es_prices tables, joined
 * on the exact `captured_at` instant. A snapshot with no matching price
 * row is skipped with a loud warning — never back-filled from strikes.
 */

import { getDb } from '../db/index.js';
import type { ConeEndpoints, Snapshot, StrikeData } from './types.js';

/**
 * Cadence (minutes) of the Greek panels the scraper captures — one snapshot per
 * 10-minute slot. Used as the upper bound for how far a slot's Greeks may be
 * carried forward when densifying, so a missing slot never extrapolates Greeks
 * more than one slot ahead.
 */
const GREEK_SLOT_MINUTES = 10;

/**
 * How often the algo re-decides entry/exit. The Greeks only refresh every
 * {@link GREEK_SLOT_MINUTES}, but spot/ES prices exist at 1-minute granularity
 * (live Yahoo feed → spot_prices/es_prices), so we insert an intermediate
 * price tick at this spacing inside each slot. 5 → decide every 5 minutes.
 */
const DECISION_INTERVAL_MINUTES = 5;

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
  // 0DTE only: the ET capture session must equal the expiry, so a snapshot's
  // captured_at instant lands on the same trading day as its prices. This drops
  // forward-expiry (1DTE+) captures whose captured_at is an earlier session.
  const rows = await sql(
    `SELECT to_char(captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS captured_at,
            expiry::text AS expiry, panel, strike, value, timeframe
     FROM periscope_snapshots
     WHERE expiry = $1
       AND (captured_at AT TIME ZONE 'America/New_York')::date = $1::date
       AND panel IN ('gamma', 'charm', 'vanna', 'positions')
     ORDER BY captured_at, strike`,
    [date],
  );

  if (rows.length === 0) return [];

  // Step 2: Try to get spot (SPX) + ES prices from their tables, plus the day's cone.
  // SPX drives the signal; ES is the traded instrument used for P&L (TODO #3).
  const spotRows = await loadSpotPrices(date);
  const esRows = await loadEsPrices(date);
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
  let unmatched = 0;

  for (const [capturedAt, group] of byTime) {
    // Spot comes strictly from the dedicated spot_prices table, joined on the
    // exact captured_at instant. A snapshot with no matching price row is a real
    // data gap — skip it and count it (warned below). Never fabricate spot from
    // strikes: that silently masked a >100pt join bug across half the dataset.
    const spot = spotRows.get(capturedAt);
    if (spot === undefined) {
      unmatched += 1;
      continue;
    }

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
      es: esRows.get(capturedAt) ?? null,
      strikes: strikes.sort((a, b) => a.strike - b.strike),
      cone,
    });
  }

  if (unmatched > 0) {
    console.warn(
      `[data-loader] ${date}: skipped ${unmatched}/${byTime.size} snapshot(s) with no ` +
        `matching spot_prices row — is spot_prices populated for this session?`,
    );
  }

  snapshots.sort(
    (a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime(),
  );

  // Densify to a 5-minute decision cadence using the live 1-minute price feed.
  return densifyDecisions(snapshots, spotRows, esRows, DECISION_INTERVAL_MINUTES);
}

/** Render a UTC epoch (ms) as the `YYYY-MM-DDTHH:MM:SSZ` key the price maps use
 *  (matches loadDay/loadSpotPrices' to_char format — no milliseconds). */
function priceKey(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 19) + 'Z';
}

/**
 * Expand 10-minute Greek snapshots into a finer decision cadence so the algo can
 * re-evaluate entry/exit on the CURRENT stock price every `intervalMin` minutes
 * (instead of only once per Greek slot).
 *
 * For each slot, an intermediate *price tick* is inserted at every `intervalMin`
 * offset up to the next snapshot (capped at one {@link GREEK_SLOT_MINUTES} slot
 * so a missing slot never extrapolates Greeks far ahead). A tick reuses the
 * preceding slot's Greeks (`strikes`/`cone`/`timeframe`) but takes the spot/ES
 * price at the tick instant — and only when a real price bar exists there (price
 * is never fabricated, matching the spot-join policy above). Ticks are flagged
 * `greeksStale` so the signal generator reuses the latest Greek score rather
 * than recomputing it. With no 1-minute feed for a day, no ticks are added and
 * the day decides at the original 10-minute cadence.
 *
 * @param snapshots  Real Greek snapshots for one day, sorted ascending.
 */
function densifyDecisions(
  snapshots: Snapshot[],
  spotMap: Map<string, number>,
  esMap: Map<string, number>,
  intervalMin: number,
): Snapshot[] {
  if (intervalMin <= 0 || snapshots.length === 0) return snapshots;

  const stepMs = intervalMin * 60_000;
  const slotMs = GREEK_SLOT_MINUTES * 60_000;
  const out: Snapshot[] = [];

  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i]!;
    out.push(snap);

    const baseMs = new Date(snap.capturedAt).getTime();
    const nextMs =
      i + 1 < snapshots.length ? new Date(snapshots[i + 1]!.capturedAt).getTime() : Infinity;
    // Carry this slot's Greeks forward at most one slot, and never past the next
    // real snapshot.
    const boundMs = Math.min(nextMs, baseMs + slotMs);

    for (let t = baseMs + stepMs; t < boundMs; t += stepMs) {
      const key = priceKey(t);
      const spot = spotMap.get(key);
      if (spot === undefined) continue; // no real price bar — never fabricate spot
      out.push({
        ...snap,
        capturedAt: key,
        spot,
        es: esMap.get(key) ?? null,
        greeksStale: true,
      });
    }
  }

  return out;
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
 * Load ES (futures) close prices from the dedicated `es_prices` table.
 * Returns a Map of captured_at → ES close. ES and SPX rows share the same
 * `captured_at` instants (both written from one converted bar list by the
 * ingest pipeline), so this map keys join the snapshots exactly like spot does.
 * Returns an empty map if the table doesn't exist yet (P&L falls back to SPX).
 */
async function loadEsPrices(date: string): Promise<Map<string, number>> {
  const sql = getDb();
  const map = new Map<string, number>();

  try {
    const rows = await sql(
      // Same captured_at rendering as loadDay so the join keys match exactly.
      `SELECT to_char(captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS captured_at, close
       FROM es_prices
       WHERE date = $1
       ORDER BY captured_at`,
      [date],
    );
    for (const row of rows) {
      map.set(String(row.captured_at), Number(row.close));
    }
  } catch {
    // Table doesn't exist yet — caller will fall back to SPX spot for P&L
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
       AND (captured_at AT TIME ZONE 'America/New_York')::date = expiry
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
       AND (captured_at AT TIME ZONE 'America/New_York')::date = expiry
     ORDER BY expiry`,
  );
  return rows.map((r) => String(r.expiry));
}
