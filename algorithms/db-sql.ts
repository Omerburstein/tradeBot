/**
 * Shared SQL fragments for the algorithm's DB reads.
 *
 * The data loader and the coverage reporter join `periscope_snapshots`,
 * `positions`, `spot_prices`, and `es_prices` on the exact `captured_at`
 * instant, and both restrict to true 0DTE (ET capture session == expiry). Those
 * two expressions MUST render identically everywhere or the joins silently
 * mis-key, so they live here as the single source of truth rather than being
 * retyped per query.
 */

/**
 * `captured_at` rendered as the UTC ISO key the joins use, e.g.
 * `2026-05-21T18:50:00Z` (no milliseconds). Append ` AS <alias>` at the call
 * site — the loader uses `captured_at`, the reporter uses `t`.
 */
export const CAPTURED_AT_UTC_ISO =
  `to_char(captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

/**
 * The snapshot's ET calendar date — the left-hand side of the 0DTE session
 * predicate. Compare against `$1::date` (a bound day) or `expiry` to keep only
 * captures whose ET session lands on the trading day they belong to.
 */
export const CAPTURED_AT_ET_DATE =
  `(captured_at AT TIME ZONE 'America/New_York')::date`;
