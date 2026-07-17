/**
 * Frame quality: detect Greek snapshots whose Greeks are internally
 * inconsistent with the underlying price.
 *
 * WHY THIS EXISTS — the 2026-05-26 incident. UW's periscope/exposures endpoint
 * served, for the first ~2 hours of that session, gamma computed against a
 * STALE underlying (the prior session's close, ~7480, after a long-weekend gap
 * up to ~7515). The frames were live and evolving, the requested minute and
 * expiry were correct, and `periscope/positions` matched byte-for-byte — only
 * the Greeks were wrong. Nothing downstream could notice: the numbers were
 * plausible, self-consistent, and silently produced phantom gamma walls ~35-60
 * points from spot, which the algo then scored and the tuner trained on.
 *
 * THE INVARIANT — an option's PER-CONTRACT gamma is maximal at the money and
 * decays monotonically away from it. This holds for any expiry, any IV, any
 * skew: it is a property of the Black-Scholes gamma kernel, not of positioning.
 *
 * Gamma EXPOSURE (what UW publishes) is per-contract gamma × net position, so
 * exposure alone says nothing about moneyness — open interest can pile up
 * anywhere (on 2026-05-26 the largest |exposure| strike was legitimately 40+
 * points from spot). Dividing exposure by that strike's net position cancels
 * the positioning and recovers the per-contract kernel, whose peak MUST sit at
 * spot. That is the only cheap, positioning-independent probe of "were these
 * Greeks computed against the right underlying".
 *
 * Do NOT replace this with "the max-|gamma| strike should be near spot" — that
 * check fails on healthy data (see above) and was the first thing that looked
 * wrong on 05-26 for the wrong reason.
 */

/** One strike's gamma exposure and the net MM position it was computed over. */
export interface FrameStrike {
  strike: number;
  /** Gamma EXPOSURE at this strike (per-contract gamma × net position). */
  gamma: number;
  /** Net MM contracts at this strike (call_qty + put_qty). */
  net: number;
}

/**
 * A strike's |net| must reach this before its gamma/net ratio is trusted.
 * The ratio's denominator is the net position, so a strike holding a handful of
 * contracts produces a wild ratio from rounding alone and would dominate the
 * argmax. (This is a real bug I hit while investigating: an unguarded ratio put
 * the "peak" on a 2-contract strike.)
 */
export const MIN_NET_FOR_RATIO = 200;

/** Fewer usable strikes than this and the curve can't locate a peak. */
export const MIN_STRIKES_FOR_ATM = 8;

/**
 * How many top-ratio strikes vote on the ATM estimate. The median of the top-K
 * is used rather than a bare argmax so one noisy strike can't move the answer.
 */
export const ATM_VOTE_K = 5;

/**
 * Max |impliedAtm − spot| (index points) before a frame is considered corrupt.
 *
 * Calibrated over 2026-05-01..2026-07-16 (~1,900 slots, 49 sessions): across
 * every healthy session the worst deviation observed was 22.1 and the median
 * ~3, while corrupt slots land at 25.3-63.9. At 25 the detector flags 28 slots,
 * all of them independently confirmed corrupt (their gamma disagrees with a
 * re-fetch from UW), and zero healthy slots.
 *
 * The floor on this threshold is real, not slack: the estimator is quantized to
 * the 5-point strike grid and the per-contract gamma peak is genuinely broad
 * near expiry, so a healthy frame can legitimately read ~20 points off.
 */
export const MAX_ATM_DEVIATION = 25;

export interface FrameCheck {
  ok: boolean;
  /** Strike where per-contract gamma peaks — the frame's own implied ATM. */
  impliedAtm: number | null;
  /** impliedAtm − spot, in index points. null when undeterminable. */
  deviation: number | null;
  /** How many strikes cleared MIN_NET_FOR_RATIO. */
  usableStrikes: number;
  /** Machine-readable outcome; 'ok' | 'insufficient-data' | 'atm-mismatch'. */
  reason: 'ok' | 'insufficient-data' | 'atm-mismatch';
}

/**
 * The frame's implied at-the-money strike: where per-contract gamma
 * (|gamma| / |net|) peaks. Returns null when too few strikes carry enough net
 * position to form a curve.
 */
export function impliedAtmStrike(strikes: readonly FrameStrike[]): number | null {
  const usable = strikes
    .filter((s) => Number.isFinite(s.gamma) && Number.isFinite(s.net) && Math.abs(s.net) >= MIN_NET_FOR_RATIO)
    .map((s) => ({ strike: s.strike, ratio: Math.abs(s.gamma) / Math.abs(s.net) }))
    .filter((s) => Number.isFinite(s.ratio));

  if (usable.length < MIN_STRIKES_FOR_ATM) return null;

  const top = usable.sort((a, b) => b.ratio - a.ratio).slice(0, ATM_VOTE_K);
  const votes = top.map((t) => t.strike).sort((a, b) => a - b);
  return votes[Math.floor(votes.length / 2)]!;
}

/**
 * Check one frame's Greeks against the underlying price they should have been
 * computed at. `spot` must come from an independent source (spot_prices /
 * cone apex) — never from the frame itself, or the check is circular.
 */
export function checkFrameAgainstSpot(
  strikes: readonly FrameStrike[],
  spot: number,
  maxDeviation: number = MAX_ATM_DEVIATION,
): FrameCheck {
  const usableStrikes = strikes.filter(
    (s) => Number.isFinite(s.gamma) && Number.isFinite(s.net) && Math.abs(s.net) >= MIN_NET_FOR_RATIO,
  ).length;

  const impliedAtm = impliedAtmStrike(strikes);
  if (impliedAtm === null) {
    return { ok: true, impliedAtm: null, deviation: null, usableStrikes, reason: 'insufficient-data' };
  }

  const deviation = impliedAtm - spot;
  const ok = Math.abs(deviation) <= maxDeviation;
  return {
    ok,
    impliedAtm,
    deviation,
    usableStrikes,
    reason: ok ? 'ok' : 'atm-mismatch',
  };
}
