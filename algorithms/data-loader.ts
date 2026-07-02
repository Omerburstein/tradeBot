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
 * Apply each 10-min Greek slot from its slot START (default ON — TODO #9). UW
 * publishes a frame's Greeks at the START of the frame; the frame END is only the
 * label/timestamp UW stamps the window with (the `[11:40,11:50]` frame is
 * timestamped 11:50 even though its data is the 11:40 reading). So applying the
 * slot's Greeks from its START is the causal, live-realistic timing — the data
 * existed at that instant.
 *
 * Set `LOOKAHEAD_GREEKS_FROM_SLOT_START=false` to instead key each slot to its END
 * label (the raw UW timestamp). The env var keeps its historical name.
 */
const LOOKAHEAD_GREEKS_FROM_SLOT_START =
  (process.env.LOOKAHEAD_GREEKS_FROM_SLOT_START ?? 'true').trim().toLowerCase() !== 'false';

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
      sd = { strike, gamma: 0, charm: 0, vanna: 0, positions: 0 };
      group.strikes.set(strike, sd);
    }

    const panel = String(row.panel) as GreekPanel;
    sd[panel] = Number(row.value);
  }

  // Overlay net MM positions (from the positions table) onto the Greek strikes,
  // joined on the exact captured_at + strike. Strikes that appear only in the
  // positions table (no gamma/charm/vanna) are ignored — the algo scores the
  // Greek strikes and positions only add a directional weight to those.
  for (const [capturedAt, group] of byTime) {
    const perStrike = positionRows.get(capturedAt);
    if (!perStrike) continue;
    for (const sd of group.strikes.values()) {
      const net = perStrike.get(sd.strike!);
      if (net !== undefined) sd.positions = net;
    }
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

    const es = esRows.get(capturedAt) ?? null;

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

  // Re-stamp each slot to its START (where UW publishes the frame) before
  // densifying so the Greeks are applied from the start of their window
  // (default ON — see flag).
  const decisionSnapshots = LOOKAHEAD_GREEKS_FROM_SLOT_START
    ? shiftGreeksToSlotStart(snapshots, spotRows, esRows)
    : snapshots;

  // Densify to a 5-minute decision cadence using the live 1-minute price feed.
  return densifyDecisions(decisionSnapshots, spotRows, esRows, DECISION_INTERVAL_MINUTES);
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
      const es = esMap.get(key) ?? null;
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
 * Re-stamp each real Greek snapshot from its slot END label to its slot START (one
 * {@link GREEK_SLOT_MINUTES} slot earlier) and re-price spot/ES at that instant,
 * so densifyDecisions then carries the slot's Greeks across [start, end). UW
 * publishes each frame at its START, so this is the causal timing; the END is just
 * the label UW timestamps the window with. Default ON (TODO #9); set
 * `LOOKAHEAD_GREEKS_FROM_SLOT_START=false` to key slots to the END label instead.
 *
 * Only the price sources (spx/es) are re-evaluated at the shifted instant; the
 * Greeks, positions and cone (all keyed to the original slot) ride along
 * unchanged, so `present.gex`/`present.positions` are preserved. A slot whose
 * start instant has no spot bar is dropped (never fabricate a price).
 */
function shiftGreeksToSlotStart(
  snapshots: Snapshot[],
  spotMap: Map<string, number>,
  esMap: Map<string, number>,
): Snapshot[] {
  const shiftMs = GREEK_SLOT_MINUTES * 60_000;
  const out: Snapshot[] = [];
  let dropped = 0;
  for (const snap of snapshots) {
    const startKey = priceKey(new Date(snap.capturedAt).getTime() - shiftMs);
    const spot = spotMap.get(startKey);
    if (spot === undefined) {
      dropped += 1;
      continue; // no price bar at the slot-start instant — never fabricate
    }
    const es = esMap.get(startKey) ?? null;
    out.push({
      ...snap,
      capturedAt: startKey,
      spot,
      es,
      present: {
        spx: true,
        es: es != null,
        gex: snap.present?.gex ?? true,
        positions: snap.present?.positions ?? false,
      },
    });
  }
  out.sort((a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime());
  if (dropped > 0) {
    console.warn(
      `[data-loader] applied ${out.length} Greek slot(s) from their START instant; ` +
        `${dropped} dropped (no slot-start price bar).`,
    );
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
 * Load net MM positions for a day from the dedicated `positions` table (keyed
 * by captured_at + expiry + strike, with call_qty/put_qty). Net contracts per
 * strike = call_qty + put_qty, matching {@link StrikeData.positions}.
 *
 * 0DTE only — same expiry + ET-session predicate as loadDay, so positions join
 * the Greek strikes on the exact captured_at instant. Returns both the per-slot
 * per-strike net map AND the set of slots that carried ANY positions row (the
 * "positions present" signal for the completeness gate, TODO #6). Returns empty
 * structures if the table doesn't exist yet.
 */
async function loadPositions(
  date: string,
): Promise<{ net: Map<string, Map<number, number>>; slots: Set<string> }> {
  const sql = getDb();
  const net = new Map<string, Map<number, number>>();
  const slots = new Set<string>();

  try {
    const rows = await sql(
      // Same captured_at rendering as loadDay so the join keys match exactly.
      `SELECT to_char(captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS captured_at,
              strike, call_qty, put_qty
       FROM positions
       WHERE expiry = $1
         AND (captured_at AT TIME ZONE 'America/New_York')::date = $1::date
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
      perStrike.set(Number(row.strike), Number(row.call_qty) + Number(row.put_qty));
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
