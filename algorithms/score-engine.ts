/**
 * Score engine: computes the composite directional score from a snapshot.
 *
 * Factors (user requirements):
 *   1. Gamma exposure (GEX) — directional gamma pressure per strike. The gamma
 *      LEVEL is taken as an absolute magnitude: + and - gamma both add
 *      same-direction pressure (no netting between opposite-sign strikes);
 *      direction comes from the strike's position vs spot. Positive gamma is
 *      weighted slightly higher than negative via positiveGammaBias.
 *   2. Net MM positions — directional positioning pressure per strike, gated
 *      by gamma: a strike's positions count only where its gamma is strong at
 *      the SAME strike (a THRESHOLD, not a multiplier — once the gate passes,
 *      positions enter at full magnitude with no gamma-strength weighting). The
 *      positions LEVEL is taken as a RAW absolute magnitude (no netting, no
 *      per-strike power) — exactly like gamma's level; the only compression is
 *      the log applied at the normalize step. Direction comes from position vs
 *      spot (no positive bias — gamma only).
 *   3. dGamma/dt — rate of change of gamma, measured as the current gamma level
 *      against a TIME-DECAYED BASELINE of that strike's recent levels (not just
 *      the immediately previous snapshot). Its SIZE is the distance the value
 *      actually travelled from the baseline (|Δgamma|, so a sign flip counts as
 *      the full trip through zero) and its SIGN is momentum — a wall building vs
 *      bleeding, including a negative-gamma strike shrinking toward zero. See
 *      {@link signedDelta}. Then pointed by the strike's side of spot.
 *   4. dPositions/dt — rate of change of net MM positions (same gamma gate —
 *      threshold only, no gamma-strength weighting), against its own decayed
 *      positions baseline, via the same {@link signedDelta}: flip-aware size,
 *      build-vs-bleed sign. Then pointed by the side of spot.
 *
 *      The baseline is a per-strike EWMA in WALL-CLOCK time (half-life
 *      `momentumHalfLifeMin`): the current snapshot enters at full weight, so a
 *      large last-minute move registers at once, while the preceding ~2–3
 *      half-lives of history decay in behind it — a steady build accumulates, a
 *      one-slot blip reverts as the baseline catches up. See {@link MomentumState}
 *      and {@link decayedDelta}. It is cadence-invariant (ρ is derived from the
 *      real Δt) and cannot ramp (a bounded difference of two levels).
 *   5. Distance weighting — further strikes contribute MORE score
 *   6. Cone — handled separately in cone.ts (trigger gate, not a score factor)
 *
 * Gamma carries the most weight. Charm and vanna are intentionally excluded
 * from the composite score; the signal is built from gamma and net
 * market-maker positions and their respective rates of change.
 *
 * NORMALIZATION IS NOT A Z-SCORE. Every factor is divided by the mean absolute
 * magnitude of a recent history, shaped by its exponent, and log-compressed —
 * history sets the SCALE only, and never re-centers the reading (see
 * normalizeToScale). The `…Z` field names are retained for continuity but no
 * standard deviation is involved. Each normalized value therefore keeps its raw
 * factor's sign.
 *
 * NET SIGNAL, GROSS-MAGNITUDE SCALE. Each factor's numerator is its NET raw
 * (above/below-spot strikes offset — the directional signal); its denominator is
 * the mean of its own recent GROSS magnitude — the sum of |per-strike
 * contribution|, where above and below never cancel. So the scale is sign-blind
 * and never collapses on a balanced day, and the reading (net / gross) is the
 * DIRECTIONAL COHERENCE of the activity: ~1 when one-sided, ~0 on a balanced
 * pinning day. All four factors share this anchor, so the weights are directly
 * comparable. See {@link ScoreComponents} gross fields and normalizeToScale.
 *
 * ALL NON-LINEARITY LIVES AT NORMALIZE (R5/R6). Per-strike accumulation is
 * linear in the data (abs + the geometric weights sign/dWeight, plus gammaBias
 * on gamma). Each factor's shaping exponent — pGamma, pDGamma, pPositions,
 * pDPositions — is applied once, to the whole aggregated factor, inside the log
 * at the normalize step, NOT per strike.
 *
 * For a from-scratch explanation of what each of the four contributors means,
 * why it was chosen, how it is computed, and how the weights combine into the
 * composite, see docs/composite-score.md.
 */

import type {
  AlgoConfig,
  FactorContributions,
  MomentumState,
  ScoreComponents,
  Snapshot,
  StrikeData,
} from './types.js';

/** Fresh, empty day-scoped {@link MomentumState}. One per SignalGenerator. */
export function createMomentumState(): MomentumState {
  return { gamma: new Map(), positions: new Map(), lastAt: null };
}

/** Fallback half-life (min) if a config predates `momentumHalfLifeMin`. */
const DEFAULT_MOMENTUM_HALF_LIFE_MIN = 10;
/**
 * Δt clamp (minutes) for the baseline decay. Floors a zero/negative gap so ρ
 * stays finite; caps a large gap so ρ→0 (the baseline forgets and reseeds to
 * the current level) rather than underflowing — the right behaviour after a
 * long hole in the feed.
 */
const MIN_DELTA_MINUTES = 0.05;
const MAX_DELTA_MINUTES = 120;

/**
 * Break a composite score into each factor's weighted contribution
 * (weight × z-score). The four parts sum to {@link ScoreComponents.composite},
 * so this is the single source of truth for "how much did each var drive the
 * decision" — used by the trade log / entry/exit logs.
 */
export function factorContributions(
  score: ScoreComponents,
  config: AlgoConfig,
): FactorContributions {
  return {
    gex: config.wGex * score.gexZ,
    dGamma: config.wDGamma * score.dGammaZ,
    positions: config.wPositions * score.positionsZ,
    dPositions: config.wDPositions * score.dPositionsZ,
  };
}

/**
 * Compute the composite directional score for a single snapshot.
 *
 * @param current   The current snapshot (strikes pre-filtered to window)
 * @param previous  The previous Greek snapshot, or null if first of day
 * @param history   Past ScoreComponents for z-score normalization
 * @param config    Algorithm configuration
 * @param momentum  Day-scoped {@link MomentumState}, read and updated in place so
 *                  the rate-of-change baseline spans many snapshots. When omitted
 *                  (direct/unit callers) the baseline collapses to `previous`, so
 *                  each rate of change is exactly the single-step delta.
 */
export function computeScore(
  current: Snapshot,
  previous: Snapshot | null,
  history: ScoreComponents[],
  config: AlgoConfig,
  momentum?: MomentumState,
): ScoreComponents {
  const { spot, strikes } = current;

  // Per-step decay for the momentum baseline, derived from the REAL Δt since the
  // last Greek snapshot so the half-life means the same wall-clock memory at any
  // cadence. Before the first snapshot (or with no momentum state) ρ = 0, so the
  // baseline simply seeds to the current level and the first delta is 0.
  const halfLife =
    Number.isFinite(config.momentumHalfLifeMin) && config.momentumHalfLifeMin > 0
      ? config.momentumHalfLifeMin
      : DEFAULT_MOMENTUM_HALF_LIFE_MIN;
  const currentMs = new Date(current.capturedAt).getTime();
  let rho = 0;
  if (momentum && momentum.lastAt !== null) {
    const dtMin = Math.min(
      MAX_DELTA_MINUTES,
      Math.max(MIN_DELTA_MINUTES, (currentMs - momentum.lastAt) / 60_000),
    );
    rho = Math.pow(0.5, dtMin / halfLife);
  }

  let gexRaw = 0;
  let dGammaRaw = 0;
  let positionsRaw = 0;
  let dPositionsRaw = 0;

  // GROSS magnitudes: the sum of each strike's ABSOLUTE contribution, WITHOUT the
  // above/below-spot (`sign`) cancellation the net `…Raw` sums have. These are the
  // normalization SCALE only — never the signal. Pairing net numerator with gross
  // denominator means a balanced day (net ≈ 0, gross large) reads ~0 rather than a
  // self-normalized flip, while a one-sided day (net ≈ gross) still reads ~1.
  let gexGross = 0;
  let dGammaGross = 0;
  let positionsGross = 0;
  let dPositionsGross = 0;

  // Build a lookup for previous snapshot's strikes for dGamma/dPositions computation
  const prevByStrike = new Map<number, StrikeData>();
  if (previous) {
    for (const s of previous.strikes) {
      prevByStrike.set(s.strike, s);
    }
  }

  // Pre-pass: largest |gamma| in the window. Positions are only meaningful
  // where gamma is strong, so each strike's positions contribution is gated
  // and weighted by its gamma strength relative to this max.
  let maxAbsGamma = 0;
  for (const s of strikes) {
    if (Math.abs(s.strike - spot) > config.strikeWindow) continue;
    const ag = Math.abs(s.gamma);
    if (ag > maxAbsGamma) maxAbsGamma = ag;
  }

  for (const s of strikes) {
    const distance = s.strike - spot;
    const absDistance = Math.abs(distance);
    if (absDistance > config.strikeWindow) continue;

    // Directional sign: +1 above spot, -1 below, 0 at-the-money
    const sign = distance > 0 ? 1 : distance < 0 ? -1 : 0;

    // Factor 5: Distance weighting — further strikes get MORE weight.
    // Non-linear ramp: ATM gets 1.0x, edge of window gets (1 + span)x,
    // curved by pDistance.
    const dWeight =
      1.0 + config.distanceWeightSpan * Math.pow(absDistance / config.strikeWindow, config.pDistance);

    // Factor 1: Gamma exposure (GEX)
    // Absolute magnitude: + and - gamma both add same-direction pressure (no
    // netting between opposite-sign strikes); direction comes from `sign`
    // (strike position vs spot). Positive gamma is weighted slightly higher
    // than negative via positiveGammaBias. The per-strike term is LINEAR in the
    // gamma magnitude (R6) — only `Math.abs` plus the multiplicative geometric
    // factors (gammaBias, sign, dWeight). Non-linear shaping is deferred to the
    // normalize step, where `pGamma` is applied to the whole aggregated factor.
    const gammaBias = s.gamma >= 0 ? config.positiveGammaBias : 1.0;
    gexRaw += Math.abs(s.gamma) * gammaBias * sign * dWeight;
    gexGross += Math.abs(s.gamma) * gammaBias * dWeight; // |contribution|, no side cancellation

    // Factor 2: Net MM positions exposure — GATED by gamma, not weighted by it.
    // A strike's positions count only when its gamma is strong relative to the
    // window max (|gamma| ≥ positionsGammaGate·maxAbsGamma); gamma is a pure
    // threshold here — once the gate passes, the strike's positions enter at
    // full magnitude, with no gamma-strength multiplier folded into the value.
    // The per-strike magnitude is taken RAW (linear, no power) — like every
    // factor (R6). Shaping (its `pPositions` exponent) and compression (the log)
    // happen together at the normalize step (normalizeToScale), so a large print
    // is tamed at the aggregate scale rather than saturated strike-by-strike.
    const gammaStrength = maxAbsGamma > 0 ? Math.abs(s.gamma) / maxAbsGamma : 0;
    const positionsCounts = gammaStrength >= config.positionsGammaGate;

    if (positionsCounts) {
      // Absolute magnitude (no netting): position size adds pressure regardless
      // of its own sign; direction comes from `sign`. No positive bias here —
      // the bias is gamma-only.
      positionsRaw += Math.abs(s.positions) * sign * dWeight;
      positionsGross += Math.abs(s.positions) * dWeight; // |contribution|, no side cancellation
    }

    // Factors 3 & 4: rate-of-change of gamma and positions vs a decayed baseline.
    // The baseline is this strike's time-decayed average level; the delta is the
    // CURRENT level measured against it (full weight on the present), via the
    // flip-aware {@link signedDelta} — a wall building is positive momentum, a
    // wall bleeding off (incl. a negative-gamma strike shrinking toward zero) is
    // negative, and a sign flip travels the full trip through zero. `sign` points
    // it by the strike's side of spot; `pDGamma`/`pDPositions` shaping is deferred
    // to the normalize step. `decayedDelta` also folds the current level into the
    // baseline for next time (in place), so the baseline reaches ~2–3 half-lives
    // back. Absent a prior baseline the seed is `prev`, so the first move off a
    // fresh strike is exactly the single-step delta.
    const prev = prevByStrike.get(s.strike);
    const deltaGamma = decayedDelta(momentum?.gamma, s.strike, s.gamma, prev?.gamma, rho);
    dGammaRaw += deltaGamma * sign * dWeight;
    dGammaGross += Math.abs(deltaGamma) * dWeight; // |contribution|, no side cancellation

    // The positions baseline is kept fresh for EVERY in-window strike (so a strike
    // crossing the gamma gate mid-day already has a warm baseline), but only a
    // gated strike's delta enters the score — mirroring the positions LEVEL gate.
    const deltaPositions = decayedDelta(momentum?.positions, s.strike, s.positions, prev?.positions, rho);
    if (positionsCounts) {
      dPositionsRaw += deltaPositions * sign * dWeight;
      dPositionsGross += Math.abs(deltaPositions) * dWeight; // |contribution|, no side cancellation
    }
  }

  // The baseline decay consumed this snapshot; advance the clock so the next
  // snapshot derives ρ from the true Δt. (Skipped when running stateless.)
  if (momentum) momentum.lastAt = currentMs;

  // Magnitude-ratio normalization using a rolling lookback, hard-clamped to
  // ±zClamp. History supplies only the SCALE each factor is measured against —
  // it never re-centers the reading, so the normalized value keeps the raw
  // factor's own sign and direction (see normalizeToScale).
  //
  // SAME-DAY INVARIANT: `history` is the SignalGenerator's per-day scoreHistory,
  // and a fresh generator is created for every trading day (see backtest.ts).
  // The scale is therefore always computed from the SAME day's snapshots —
  // never from prior days' "historical" data. The slice below is a trailing
  // window WITHIN that day; since history starts empty each day it can never
  // reach back across a day boundary. Do not feed a cross-day history here.
  // NET NUMERATOR, GROSS-MAGNITUDE SCALE. Each factor's reading is the NET `…Raw`
  // (the directional signal, where above/below-spot strikes offset) divided by
  // the mean of its own recent GROSS magnitude — the sum of |per-strike
  // contribution|, where nothing cancels. So the scale measures "typical total
  // activity" and never collapses when a day is balanced; the ratio net/gross is
  // then the DIRECTIONAL COHERENCE of that activity: ~1 when one-sided, ~0 on a
  // balanced pinning day (correctly, no direction) rather than a flippy ±1 from
  // self-scaling a near-zero net against a near-zero scale. `meanAbs` inside
  // normalizeToScale keeps the denominator sign-blind either way. See
  // {@link ScoreComponents} gross fields.
  const lookback = history.slice(-config.zScoreLookback);
  const clamp = (z: number) => Math.max(-config.zClamp, Math.min(config.zClamp, z));
  const gexZ = clamp(normalizeToScale(gexRaw, lookback.map((h) => h.gexGross), config.pGamma));
  const dGammaZ = clamp(normalizeToScale(dGammaRaw, lookback.map((h) => h.dGammaGross), config.pDGamma));
  const positionsZ = clamp(normalizeToScale(positionsRaw, lookback.map((h) => h.positionsGross), config.pPositions));
  const dPositionsZ = clamp(normalizeToScale(dPositionsRaw, lookback.map((h) => h.dPositionsGross), config.pDPositions));

  // Composite weighted score
  const composite =
    config.wGex * gexZ +
    config.wDGamma * dGammaZ +
    config.wPositions * positionsZ +
    config.wDPositions * dPositionsZ;

  return {
    gexRaw,
    gexZ,
    dGammaRaw,
    dGammaZ,
    positionsRaw,
    positionsZ,
    dPositionsRaw,
    dPositionsZ,
    composite,
    gexGross,
    dGammaGross,
    positionsGross,
    dPositionsGross,
  };
}

/**
 * One strike's rate of change against its DECAYED BASELINE, updating the
 * baseline in place. This is what lifts each rate of change from a single noisy
 * two-snapshot difference to a move measured against ~2–3 half-lives of history,
 * while the current level still enters at full weight (it is one side of the
 * difference — a large last-minute move is never damped).
 *
 *   seed  = baseline[strike] ?? prevLevel ?? currLevel   // where history stands now
 *   out   = signedDelta(currLevel, seed)                 // flip-aware move off it
 *   baseline[strike] = ρ·seed + (1 − ρ)·currLevel        // fold current in for next time
 *
 * ρ (per-step retention, 0–1) comes from the real Δt and the half-life, so the
 * memory is wall-clock, not snapshot-count (cadence-invariant). Because `out` is
 * a bounded difference of two levels rather than an accumulating sum, it cannot
 * ramp over the session.
 *
 * SEEDING keeps the stateless path (no `baseline` map — unit/direct callers)
 * identical to the old single-step behaviour: seed falls back to `prevLevel`, so
 * `out` = signedDelta(curr, prev), and with no previous snapshot the seed is the
 * current level so the first reading is 0. A newly appearing strike likewise
 * seeds off `prevLevel` (or itself) rather than spiking.
 */
function decayedDelta(
  baseline: Map<number, number> | undefined,
  strike: number,
  currLevel: number,
  prevLevel: number | undefined,
  rho: number,
): number {
  const seed = baseline?.get(strike) ?? prevLevel ?? currLevel;
  const out = signedDelta(currLevel, seed);
  if (baseline) baseline.set(strike, rho * seed + (1 - rho) * currLevel);
  return out;
}

/**
 * Signed rate-of-change of a per-strike quantity (gamma or net MM positions)
 * against a reference level (the previous snapshot, or a decayed baseline).
 * Shared by factors 3 and 4 so both rates of change speak exactly the same
 * language.
 *
 *   size = |curr − prev|                 // how far the value actually travelled
 *   dir  = sign(|curr| − |prev|)         // did the wall build (+) or bleed (−)
 *   out  = dir · size
 *
 * WHY NOT |curr| − |prev|: differencing the magnitudes alone sees only the two
 * endpoint magnitudes, so every sign FLIP is invisible — +100 → −50 scored
 * identically to +100 → +50 (both −50), even though the first destroyed a wall
 * and rebuilt an opposite one while the second merely decayed. Taking |curr −
 * prev| as the size restores that: the flip travels 150, the decay 50.
 *
 * WHY NOT |curr − prev| ALONE: an unsigned size is always ≥ 0, which erases the
 * factor's whole point — a wall building and a wall bleeding off would both read
 * positive (+100 → +50 and +100 → +150 would both be 50). The magnitude change
 * supplies the direction, so pressure growing is + and pressure fading is −.
 *
 * SIGN-INDEPENDENT by construction: negating BOTH inputs leaves `size` and `dir`
 * unchanged, so dGamma(+100→+50) === dGamma(−100→−50) and dGamma(+100→−50) ===
 * dGamma(−100→+50) — the invariant the level factor depends on.
 *
 * WHY `dir` IS +1 WHEN THE MAGNITUDE IS UNCHANGED, not 0: `Math.sign` would
 * return 0 there and zero out the whole term, which silently swallowed the most
 * violent flip of all — +100 → −100 travels 200 through zero yet scored 0,
 * because its endpoint magnitudes happen to match. Only a strict SHRINK is
 * negative momentum; everything else is positive. This cannot resurrect the
 * genuinely-unchanged case (curr === prev), whose `size` is already 0 — the two
 * are separable because |curr| === |prev| with curr !== prev means, necessarily,
 * an exact sign flip.
 */
function signedDelta(curr: number, prev: number): number {
  const dir = Math.abs(curr) - Math.abs(prev) < 0 ? -1 : 1;
  return dir * Math.abs(curr - prev);
}

/**
 * Normalize a raw factor against the magnitude SCALE supplied by `history`,
 * shaped by `exponent` and log-compressed. This is deliberately NOT a
 * statistical z-score — despite the `…Z` field names it produces, standard
 * deviation plays no part.
 *
 *   scale = meanAbs(history)                          // the reference typical size
 *   ratio = value / scale                             // "how many times typical"
 *   out   = sign(ratio) · log2(1 + |ratio|^exponent)  // shaped + compressed
 *
 * MAGNITUDE-ONLY SCALE. `scale` is a mean of ABSOLUTE values, so the sign never
 * enters the denominator and opposite-sign entries in `history` cannot cancel it
 * out. The reading's direction comes solely from `sign(value)` on the output; it
 * is applied AFTER scaling and is orthogonal to the scale.
 *
 * NET VALUE, GROSS-MAGNITUDE HISTORY. `value` is a factor's NET raw (above/below-
 * spot strikes offset — the directional signal), but callers pass its GROSS
 * history for `history`: the per-snapshot sum of |per-strike contribution|, where
 * nothing cancels (see the gross fields on {@link ScoreComponents}). So `scale`
 * is "typical TOTAL activity" and never collapses on a balanced day, and `ratio =
 * net / gross` reads the DIRECTIONAL COHERENCE of that activity — ~1 when the
 * movement is one-sided, ~0 on a balanced "pinning" day where above and below
 * offset. Scaling the net by its own net history instead would divide a near-zero
 * balanced-day net by a near-zero scale and emit a meaningless flippy ±1; the
 * gross scale reports "no clear direction" there instead. history[0]'s delta is a
 * structural zero (no baseline yet); the <3-sample cold-start guard below plus a
 * short lookback keep it from distorting the open.
 *
 * This is the SOLE non-linear transform in the score pipeline (R5). Per-strike
 * accumulation is linear (R6); the factor's shaping exponent — `pGamma`,
 * `pDGamma`, `pPositions`, `pDPositions` — is applied HERE, once, to the whole
 * aggregated raw factor's ratio, not per strike. `exponent` > 1 emphasizes
 * large readings, < 1 saturates them (e.g. a huge position print adds
 * progressively less signal). The anchor `ratio = 1` maps to `log2(2) = 1.0`
 * for ANY exponent, so a reading at the day's typical magnitude always reads
 * 1.0 and the entry thresholds keep a familiar range.
 *
 * WHY NOT (value − mean) / std: mean-centering measures *deviation from the
 * day's average*, which discards the raw factor's own sign. On a day where
 * gamma sits persistently negative, a reading that is merely LESS negative than
 * average scores POSITIVE — the composite turns bullish while gamma pressure is
 * still bearish. Dividing by scale instead keeps the raw sign (negative gamma →
 * negative score) and asks only "how large is this relative to the day's normal
 * size", which is what the factor weights are meant to express.
 *
 * WHY LOG-COMPRESS: a plain ratio needs a big `zClamp` to let a 10× spike read
 * as 10, and such a spike then swamps the other three factors. Compressing
 * keeps a 10× clearly above a 4× while both stay near the ±3.5 clamp, so genuine
 * outliers remain distinguishable without dominating.
 *
 * With fewer than 3 data points there is no reliable scale yet, so a clamped
 * sign estimate is returned (unchanged from the previous z-score behaviour).
 */
function normalizeToScale(value: number, history: number[], exponent: number): number {
  if (history.length < 3) {
    // Not enough data for a meaningful scale — return clamped sign
    return value > 0 ? 1 : value < 0 ? -1 : 0;
  }

  const n = history.length;
  const scale = history.reduce((a, b) => a + Math.abs(b), 0) / n;

  // Degenerate history (every reading ~0): no scale to measure against. Falling
  // back to a sign estimate here would turn numerical noise into a ±1 signal,
  // so report "nothing to see" instead.
  if (scale < 1e-10) return 0;

  const ratio = value / scale;
  return Math.sign(ratio) * Math.log2(1 + Math.pow(Math.abs(ratio), exponent));
}
