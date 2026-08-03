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
import { CAPTURED_AT_ET_DATE, CAPTURED_AT_UTC_ISO } from './db-sql.js';
import { etMinutesSinceMidnight } from './et-time.js';
import type { ConeEndpoints, Snapshot, StrikeData } from './types.js';

/**
 * ET market open (09:30) in minutes since midnight. Frames captured BEFORE this
 * are pre-market: they carry no SPX print (the index has no pre-open quote, so
 * `spot_prices` starts at the bell), so they can never be scored and are dropped
 * outright. Frames at or after it are decision snapshots.
 */
const RTH_OPEN_MINUTES = 9 * 60 + 30;

/**
 * Fallback Greek cadence (minutes) when a day is too short to measure its own
 * (< 2 snapshots). The real cadence is detected per day by
 * {@link detectCadenceMinutes} — 1 for the post-2026-07 per-minute periscope
 * feed, 10 for the historical backfill — and used as the upper bound for how
 * far a slot's Greeks may be carried forward when densifying, so a missing slot
 * never extrapolates Greeks more than one cadence step ahead.
 */
const FALLBACK_GREEK_CADENCE_MINUTES = 10;

/**
 * The two signed market-maker position legs at one strike, kept apart on the way
 * out of the `positions` table. See {@link loadPositions} for why they are never
 * summed before reaching the score engine.
 */
interface PositionLegs {
  call: number;
  put: number;
}

/**
 * How often the algo re-decides entry/exit. The Greeks refresh at the data's own
 * cadence (1-min live feed, 10-min historical backfill), but spot/ES prices can
 * exist at finer granularity, so we insert an intermediate price tick at this
 * spacing between Greek slots. 1 → decide every minute (full 1-min resolution);
 * a tick is only added where a real price bar exists, so the effective cadence
 * never outruns the price feed (a 5-min feed still decides every 5 minutes).
 */
const DECISION_INTERVAL_MINUTES = 1;

/**
 * Load snapshots for a single trading day, joining gamma/charm/vanna
 * rows at each captured_at into unified Snapshot objects.
 *
 * PRE-MARKET (before 09:30 ET) frames are DROPPED: SPX has no pre-open print, so
 * they carry no spot and cannot be scored. The dGamma/dPositions baselines
 * therefore start cold at the bell and read exactly 0 on the day's first scored
 * slot (see {@link MomentumState.initialized} in types.ts).
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
    `SELECT ${CAPTURED_AT_UTC_ISO} AS captured_at,
            expiry::text AS expiry, panel, strike, value, timeframe
     FROM periscope_snapshots
     WHERE expiry = $1
       AND ${CAPTURED_AT_ET_DATE} = $1::date
       AND panel IN ('gamma', 'charm', 'vanna')
     ORDER BY captured_at, strike`,
    [date],
  );

  if (rows.length === 0) return [];

  // Step 2: Try to get spot (SPX) + ES prices from their tables, plus positions
  // and the day's cone. SPX drives the signal; ES is the traded instrument used
  // for P&L (TODO #3); positions (net MM contracts) is one of the four sources
  // the completeness gate requires (TODO #6). Note positions live in their OWN
  // table (call_qty/put_qty), NOT as a periscope_snapshots panel — the query
  // above only pulls the three Greek panels.
  const spotRows = await loadSpotPrices(date);
  const esRows = await loadEsPrices(date);
  const { net: positionRows, slots: positionSlots } = await loadPositions(date);
  const cone = await loadCone(date);

  // Step 3: Group rows by captured_at
  const byTime = new Map<string, { timeframe: string; expiry: string; strikes: Map<number, Partial<StrikeData>> }>();

  type GreekPanel = 'gamma' | 'charm' | 'vanna';

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
      sd = { strike, gamma: 0, charm: 0, vanna: 0, positions: 0, callQty: 0, putQty: 0 };
      group.strikes.set(strike, sd);
    }

    const panel = String(row.panel) as GreekPanel;
    sd[panel] = Number(row.value);
  }

  // Overlay net MM positions (from the positions table) onto the Greek strikes,
  // joined on the exact captured_at + strike. Strikes that appear only in the
  // positions table (no gamma/charm/vanna) are ignored — the algo scores the
  // Greek strikes and positions only add a directional weight to those.
  //
  // BOTH LEGS are carried separately: a call and a put of the same sign point in
  // OPPOSITE directions (see the leg/sign table in score-engine.ts), so the sum
  // alone cannot be scored. `positions` (the sum) is retained for the coverage
  // gate only — see {@link StrikeData.positions}.
  for (const [capturedAt, group] of byTime) {
    const perStrike = positionRows.get(capturedAt);
    if (!perStrike) continue;
    for (const sd of group.strikes.values()) {
      const legs = perStrike.get(sd.strike!);
      if (legs !== undefined) {
        sd.callQty = legs.call;
        sd.putQty = legs.put;
        sd.positions = legs.call + legs.put;
      }
    }
  }

  // Step 4: Build Snapshot objects
  const snapshots: Snapshot[] = [];
  let unmatched = 0;

  for (const [capturedAt, group] of byTime) {
    // Pre-market frame (before the 09:30 bell)? Dropped. It has no SPX print to
    // be scored against — every scored factor needs spot (side of spot, the
    // distance weight, the gamma gate) — so it can never become a decision
    // snapshot. Skipped explicitly rather than falling through to the spot join
    // below, so it is NOT counted as a missing-spot gap, which is what it would
    // otherwise look like.
    if (etMinutesSinceMidnight(capturedAt) < RTH_OPEN_MINUTES) continue;

    // Spot comes strictly from the dedicated spot_prices table, using the candle
    // that CLOSES at this slot's instant (no look-ahead — see spotAtClose). A
    // snapshot with no matching price row is a real data gap — skip it and count
    // it (warned below). Never fabricate spot from strikes: that silently masked
    // a >100pt join bug across half the dataset.
    const slotMs = new Date(capturedAt).getTime();
    const spot = spotAtClose(spotRows, slotMs);
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

    const es = esAtClose(esRows, slotMs) ?? null;

    snapshots.push({
      capturedAt,
      expiry: group.expiry,
      timeframe: group.timeframe,
      spot,
      es,
      strikes: strikes.sort((a, b) => a.strike - b.strike),
      cone,
      // Per-source presence for the completeness gate (TODO #6). spx is always
      // true here (a snapshot only exists with a matching spot row); gex is true
      // (hasGamma above); es/positions vary by what was joined. positions
      // presence is "a positions row existed for this slot" (positionSlots),
      // independent of whether any net landed on an in-window strike.
      present: {
        spx: true,
        es: es != null,
        gex: true,
        positions: positionSlots.has(capturedAt),
      },
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

  // Densify to a per-minute decision cadence using the finer price feed. Greeks
  // stay keyed to their slot END (captured_at) — the instant UW actually
  // publishes the frame — so a slot is only applied once it exists (no
  // look-ahead). The carry-forward bound is the day's own detected Greek cadence
  // (1-min live, 10-min historical) so a slot's Greeks never extrapolate past the
  // next expected frame.
  const cadence = detectCadenceMinutes(snapshots);
  return densifyDecisions(snapshots, spotRows, esRows, DECISION_INTERVAL_MINUTES, cadence);
}

/**
 * Infer a day's Greek snapshot cadence (minutes) from the modal gap between
 * consecutive real snapshots: 1 for the post-2026-07 per-minute periscope feed,
 * 10 for the historical backfill. Falls back to
 * {@link FALLBACK_GREEK_CADENCE_MINUTES} when a day has fewer than two snapshots
 * (no gap to measure) — harmless, since such a day has nothing to densify.
 *
 * @param snapshots  Real Greek snapshots for one day, sorted ascending.
 */
function detectCadenceMinutes(snapshots: Snapshot[]): number {
  if (snapshots.length < 2) return FALLBACK_GREEK_CADENCE_MINUTES;
  const counts = new Map<number, number>();
  for (let i = 1; i < snapshots.length; i++) {
    const gapMin = Math.round(
      (new Date(snapshots[i]!.capturedAt).getTime() -
        new Date(snapshots[i - 1]!.capturedAt).getTime()) /
        60_000,
    );
    if (gapMin > 0) counts.set(gapMin, (counts.get(gapMin) ?? 0) + 1);
  }
  let best = FALLBACK_GREEK_CADENCE_MINUTES;
  let bestCount = 0;
  for (const [gapMin, count] of counts) {
    if (count > bestCount) {
      best = gapMin;
      bestCount = count;
    }
  }
  return best;
}

/** Render a UTC epoch (ms) as the `YYYY-MM-DDTHH:MM:SSZ` key the price maps use
 *  (matches loadDay/loadSpotPrices' to_char format — no milliseconds). */
function priceKey(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 19) + 'Z';
}

const MIN_MS = 60_000;

/**
 * Price for a decision at instant `tMs`, using the candle that CLOSES at `tMs` —
 * never the still-forming candle that STARTS at `tMs` (that would be look-ahead).
 *
 * Bars are stored START-labelled and hold the bar's CLOSE, so the candle closing
 * at T is the one labelled `T − barDuration`. For a 10:35 decision that means the
 * 10:34 spot (1-min) bar and the 10:30 ES (5-min) bar — both carry the last price
 * at 10:35.
 *
 * SPX (^GSPC) is uniformly 1-min → look up `T − 1min`. ES is 5-min in the older
 * data and 1-min in the recent feed; the bar closing at T is labelled `T − 1min`
 * (1-min) or `T − 5min` (5-min), so try the finer key first, then the 5-min key.
 * A final `T` fallback covers the rare missing prior bar (e.g. the 09:30 open,
 * where no earlier candle exists) rather than dropping the decision.
 */
function spotAtClose(map: Map<string, number>, tMs: number): number | undefined {
  return map.get(priceKey(tMs - MIN_MS)) ?? map.get(priceKey(tMs));
}

function esAtClose(map: Map<string, number>, tMs: number): number | undefined {
  return (
    map.get(priceKey(tMs - MIN_MS)) ??
    map.get(priceKey(tMs - 5 * MIN_MS)) ??
    map.get(priceKey(tMs))
  );
}

/**
 * Expand Greek snapshots into a finer decision cadence so the algo can
 * re-evaluate entry/exit on the CURRENT stock price every `intervalMin` minutes
 * (instead of only once per Greek slot).
 *
 * For each slot, an intermediate *price tick* is inserted at every `intervalMin`
 * offset up to the next snapshot (capped at one `cadenceMin` step so a missing
 * slot never extrapolates Greeks far ahead). A tick reuses the preceding slot's
 * Greeks (`strikes`/`cone`/`timeframe`) but takes the spot/ES price at the tick
 * instant — and only when a real price bar exists there (price is never
 * fabricated, matching the spot-join policy above). Ticks are flagged
 * `greeksStale` so the signal generator reuses the latest Greek score rather
 * than recomputing it. When the Greek feed is already per-minute (`cadenceMin`
 * = 1) the carry window collapses and no ticks are added — the day already
 * decides every minute off its real snapshots.
 *
 * @param snapshots  Real Greek snapshots for one day, sorted ascending.
 * @param cadenceMin The day's detected Greek cadence (carry-forward bound).
 */
function densifyDecisions(
  snapshots: Snapshot[],
  spotMap: Map<string, number>,
  esMap: Map<string, number>,
  intervalMin: number,
  cadenceMin: number,
): Snapshot[] {
  if (intervalMin <= 0 || snapshots.length === 0) return snapshots;

  const stepMs = intervalMin * 60_000;
  const slotMs = cadenceMin * 60_000;
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
      // Use the candle CLOSING at this tick instant, not the one opening at it
      // (no look-ahead — see spotAtClose/esAtClose).
      const spot = spotAtClose(spotMap, t);
      if (spot === undefined) continue; // no real price bar — never fabricate spot
      const es = esAtClose(esMap, t) ?? null;
      out.push({
        ...snap,
        capturedAt: key,
        spot,
        es,
        greeksStale: true,
        // gex/positions carry from the parent Greek slot (Greeks are reused on a
        // tick); spx/es reflect this tick instant. Keeps the completeness gate
        // (TODO #6) honest on ticks — a tick with no ES bar is still incomplete.
        present: {
          spx: true,
          es: es != null,
          gex: snap.present?.gex ?? true,
          positions: snap.present?.positions ?? false,
        },
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
      `SELECT ${CAPTURED_AT_UTC_ISO} AS captured_at, spot
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
      `SELECT ${CAPTURED_AT_UTC_ISO} AS captured_at, close
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
 * Load net MM positions for a day from the dedicated `positions` table (keyed
 * by captured_at + expiry + strike, with call_qty/put_qty).
 *
 * The two legs are returned SEPARATELY, not summed: under the leg/sign table in
 * score-engine.ts a positive call is bearish while a positive put is bullish, so
 * `call_qty + put_qty` nets two opposite-pointing quantities into a number with
 * no directional meaning. The caller derives `StrikeData.positions` (the sum)
 * from these for the coverage gate only.
 *
 * 0DTE only — same expiry + ET-session predicate as loadDay, so positions join
 * the Greek strikes on the exact captured_at instant. Returns both the per-slot
 * per-strike leg map AND the set of slots that carried ANY positions row (the
 * "positions present" signal for the completeness gate, TODO #6). Returns empty
 * structures if the table doesn't exist yet.
 */
async function loadPositions(
  date: string,
): Promise<{ net: Map<string, Map<number, PositionLegs>>; slots: Set<string> }> {
  const sql = getDb();
  const net = new Map<string, Map<number, PositionLegs>>();
  const slots = new Set<string>();

  try {
    const rows = await sql(
      `SELECT ${CAPTURED_AT_UTC_ISO} AS captured_at,
              strike, call_qty, put_qty
       FROM positions
       WHERE expiry = $1
         AND ${CAPTURED_AT_ET_DATE} = $1::date
       ORDER BY captured_at, strike`,
      [date],
    );
    for (const row of rows) {
      const capturedAt = String(row.captured_at);
      slots.add(capturedAt);
      let perStrike = net.get(capturedAt);
      if (!perStrike) {
        perStrike = new Map();
        net.set(capturedAt, perStrike);
      }
      perStrike.set(Number(row.strike), {
        call: Number(row.call_qty),
        put: Number(row.put_qty),
      });
    }
  } catch {
    // positions table may not exist yet — positions simply unavailable.
  }

  return { net, slots };
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
       WHERE ${CAPTURED_AT_ET_DATE} = $1::date
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
       AND ${CAPTURED_AT_ET_DATE} = expiry
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
       AND ${CAPTURED_AT_ET_DATE} = expiry
     ORDER BY expiry`,
  );
  return rows.map((r) => String(r.expiry));
}
