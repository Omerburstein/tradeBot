/**
 * Data-completeness gate (TODO #6).
 *
 * The algo may only make an entry/exit decision for a slot when ALL FOUR of its
 * required data sources are present: SPX spot, ES future, GEX (gamma Greeks), and
 * net MM positions. When any is missing the signal generator emits a structured
 * error (a {@link DataGap}) and skips the decision rather than trading on partial
 * information — a half-covered slot must never move the book.
 *
 * This module is the single source of truth for what "present" means per source.
 * The data loader stamps {@link Snapshot.present} from what it actually joined;
 * when that stamp is absent (e.g. hand-built test snapshots) presence is derived
 * from the snapshot's own fields so the two definitions can never drift.
 *
 * The `spec` table below documents the DB origin of each source and is rendered
 * into `docs/data-coverage.md` by the coverage-report tool, so the completeness
 * requirements live in exactly one place.
 */

import type { DataSource, SourcePresence, Snapshot } from './types.js';

/**
 * Every source a decision requires, in a stable order (used for deterministic
 * error messages and report columns). Missing ANY one blocks the decision.
 */
export const REQUIRED_SOURCES: readonly DataSource[] = ['spx', 'es', 'gex', 'positions'];

/** Human-readable spec for each source — its DB origin and "present" rule. */
export interface SourceSpec {
  source: DataSource;
  /** DB table the source is loaded from. */
  table: string;
  /** Column(s) that carry the value. */
  columns: string;
  /** What counts as "present" for one slot. */
  presentWhen: string;
}

export const SOURCE_SPECS: readonly SourceSpec[] = [
  {
    source: 'spx',
    table: 'spot_prices',
    columns: 'spot',
    presentWhen: 'a spot_prices row exists at the slot captured_at (a finite SPX price).',
  },
  {
    source: 'es',
    table: 'es_prices',
    columns: 'close',
    presentWhen: 'an es_prices row exists at the slot captured_at (a finite ES close).',
  },
  {
    source: 'gex',
    table: 'periscope_snapshots (panel = gamma)',
    columns: 'value',
    presentWhen: 'at least one in-window strike carries a non-zero gamma at the slot.',
  },
  {
    source: 'positions',
    table: 'positions',
    columns: 'call_qty + put_qty',
    presentWhen: 'at least one positions row exists at the slot captured_at (net MM contracts).',
  },
];

/** Result of assessing one slot against {@link REQUIRED_SOURCES}. */
export interface CoverageAssessment {
  present: SourcePresence;
  /** Sources missing for this slot, in {@link REQUIRED_SOURCES} order. */
  missing: DataSource[];
  /** True iff nothing is missing — the slot is actionable. */
  complete: boolean;
}

/**
 * Derive presence directly from a snapshot's fields — the fallback used when the
 * loader did not stamp {@link Snapshot.present}. Mirrors the loader's own rules so
 * stamped and derived presence agree.
 */
function derivePresence(snap: Snapshot): SourcePresence {
  return {
    spx: Number.isFinite(snap.spot),
    es: snap.es != null && Number.isFinite(snap.es),
    gex: snap.strikes.some((s) => s.gamma !== 0),
    // Test the LEGS, not their sum: a strike holding +500 calls against −500 puts
    // sums to 0 and would read as "no positions data" even though both legs are
    // present. Only genuinely empty legs count as absent.
    positions: snap.strikes.some((s) => s.callQty !== 0 || s.putQty !== 0),
  };
}

/** Assess one slot's data completeness. Prefers the loader's stamped presence. */
export function assessCoverage(snap: Snapshot): CoverageAssessment {
  const present = snap.present ?? derivePresence(snap);
  const missing = REQUIRED_SOURCES.filter((s) => !present[s]);
  return { present, missing, complete: missing.length === 0 };
}

/**
 * A structured record of a slot the algo refused to decide on because one or
 * more required sources were missing. Collected by the signal generator and
 * emitted at error level, and aggregated into the coverage summary.
 */
export interface DataGap {
  /** Slot end instant (UTC ISO-8601). */
  capturedAt: string;
  /** Trading-day expiry the slot belongs to. */
  expiry: string;
  /** Sources missing for this slot. */
  missing: DataSource[];
  /** True when the slot is an intermediate price tick, not a real Greek slot. */
  isTick: boolean;
}

/** Build the structured gap record for an incomplete slot. */
export function coverageGap(snap: Snapshot, assessment: CoverageAssessment): DataGap {
  return {
    capturedAt: snap.capturedAt,
    expiry: snap.expiry,
    missing: assessment.missing,
    isTick: snap.greeksStale === true,
  };
}

/**
 * Error form of an incomplete slot, for callers that prefer to throw rather than
 * skip. The signal generator does NOT throw (a single gap must not abort a
 * multi-day backtest) — it logs a {@link DataGap} and holds — but this is exported
 * for strict callers (e.g. a live path that should hard-stop on missing data).
 */
export class IncompleteSlotError extends Error {
  readonly gap: DataGap;
  constructor(gap: DataGap) {
    super(
      `Incomplete slot ${gap.capturedAt} (${gap.expiry}): missing ${gap.missing.join(', ')} — ` +
        `refusing to decide on partial data`,
    );
    this.name = 'IncompleteSlotError';
    this.gap = gap;
  }
}

/** Throw {@link IncompleteSlotError} unless every required source is present. */
export function requireFullData(snap: Snapshot): void {
  const assessment = assessCoverage(snap);
  if (!assessment.complete) throw new IncompleteSlotError(coverageGap(snap, assessment));
}

/** Aggregate stats over a set of gaps, for the end-of-run coverage summary. */
export interface CoverageSummary {
  totalGaps: number;
  /** How many gaps were missing each source (a slot can miss several). */
  bySource: Record<DataSource, number>;
  /** Gaps grouped by trading day. */
  byDay: Record<string, number>;
}

export function summarizeGaps(gaps: readonly DataGap[]): CoverageSummary {
  const bySource: Record<DataSource, number> = { spx: 0, es: 0, gex: 0, positions: 0 };
  const byDay: Record<string, number> = {};
  for (const g of gaps) {
    for (const s of g.missing) bySource[s] += 1;
    byDay[g.expiry] = (byDay[g.expiry] ?? 0) + 1;
  }
  return { totalGaps: gaps.length, bySource, byDay };
}
