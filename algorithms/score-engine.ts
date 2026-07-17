/**
 * Score engine: computes the composite directional score from a snapshot.
 *
 * Factors (user requirements):
 *   1. Gamma exposure (GEX) — directional gamma pressure per strike. The gamma
 *      LEVEL is taken as an absolute magnitude: + and - gamma both add
 *      same-direction pressure (no netting between opposite-sign strikes);
 *      direction comes from the strike's position vs spot. Positive gamma is
 *      weighted slightly higher than negative via positiveGammaBias.
 *   2. Net MM positions — directional positioning pressure per strike, but
 *      only where gamma is strong at the SAME strike, and compressed
 *      non-linearly so an extremely large position print can't dominate. The
 *      positions LEVEL is also taken as an absolute magnitude (no netting);
 *      direction comes from position vs spot (no positive bias — gamma only).
 *   3. dGamma/dt — rate of change of gamma *magnitude* (|gamma|) across
 *      successive snapshots, matching the absolute-magnitude GEX level. The
 *      delta of |gamma| is signed (its sign is momentum — a wall building vs
 *      bleeding, including a negative-gamma strike shrinking toward zero), then
 *      pointed by the strike's side of spot.
 *   4. dPositions/dt — rate of change of net MM positions (same gating, signed)
 *   5. Distance weighting — further strikes contribute MORE score
 *   6. Cone — handled separately in cone.ts (trigger gate, not a score factor)
 *
 * Gamma carries the most weight. Charm and vanna are intentionally excluded
 * from the composite score; the signal is built from gamma and net
 * market-maker positions and their respective rates of change.
 *
 * NORMALIZATION IS NOT A Z-SCORE. Every factor is divided by the mean absolute
 * magnitude of its own recent history and log-compressed — history sets the
 * SCALE only, and never re-centers the reading (see normalizeToScale). The
 * `…Z` field names are retained for continuity but no standard deviation is
 * involved. Each normalized value therefore keeps its raw factor's sign, and
 * reads roughly as "how many times the day's typical magnitude is this".
 *
 * For a from-scratch explanation of what each of the four contributors means,
 * why it was chosen, how it is computed, and how the weights combine into the
 * composite, see docs/composite-score.md.
 */

import type {
  AlgoConfig,
  FactorContributions,
  ScoreComponents,
  Snapshot,
  StrikeData,
} from './types.js';

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
 * @param previous  The previous snapshot (10 min ago), or null if first of day
 * @param history   Past ScoreComponents for z-score normalization
 * @param config    Algorithm configuration
 */
export function computeScore(
  current: Snapshot,
  previous: Snapshot | null,
  history: ScoreComponents[],
  config: AlgoConfig,
): ScoreComponents {
  const { spot, strikes } = current;

  let gexRaw = 0;
  let dGammaRaw = 0;
  let positionsRaw = 0;
  let dPositionsRaw = 0;

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
    // than negative via positiveGammaBias. Magnitude shaped non-linearly by pGamma.
    const gammaBias = s.gamma >= 0 ? config.positiveGammaBias : 1.0;
    gexRaw += Math.pow(Math.abs(s.gamma), config.pGamma) * gammaBias * sign * dWeight;

    // Factor 2: Net MM positions exposure — gated and weighted by gamma.
    // A strike's positions only count when its gamma is strong relative to
    // the window max; positions are shaped by pPositions (saturating < 1) so
    // an extremely large print doesn't dominate (size beyond a point adds
    // little signal).
    const gammaStrength = maxAbsGamma > 0 ? Math.abs(s.gamma) / maxAbsGamma : 0;
    const positionsCounts = gammaStrength >= config.positionsGammaGate;

    if (positionsCounts) {
      // Absolute magnitude (no netting): position size adds pressure regardless
      // of its own sign; direction comes from `sign`. No positive bias here —
      // the bias is gamma-only.
      positionsRaw += Math.pow(Math.abs(s.positions), config.pPositions) * gammaStrength * sign * dWeight;
    }

    // Factors 3 & 4: rate-of-change of gamma and positions across snapshots
    if (previous) {
      const prev = prevByStrike.get(s.strike);
      if (prev) {
        // Change in gamma *magnitude* (|gamma|), to match the GEX level factor
        // which treats gamma as an absolute pressure. A wall building (|gamma|
        // growing) is positive momentum; a wall bleeding off (|gamma| shrinking)
        // is negative — including a NEGATIVE gamma position shrinking toward
        // zero, which is a fade of that strike's pressure, so the delta is
        // negative. The delta's own sign is still momentum (preserved through
        // signedPow); `sign` then points it by the strike's side of spot.
        const deltaGamma = Math.abs(s.gamma) - Math.abs(prev.gamma);
        dGammaRaw += signedPow(deltaGamma, config.pDGamma) * sign * dWeight;

        if (positionsCounts) {
          const deltaPositions = s.positions - prev.positions;
          dPositionsRaw += signedPow(deltaPositions, config.pDPositions) * gammaStrength * sign * dWeight;
        }
      }
    }
  }

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
  const lookback = history.slice(-config.zScoreLookback);
  const clamp = (z: number) => Math.max(-config.zClamp, Math.min(config.zClamp, z));
  const gexZ = clamp(normalizeToScale(gexRaw, lookback.map((h) => h.gexRaw)));
  const dGammaZ = clamp(normalizeToScale(dGammaRaw, lookback.map((h) => h.dGammaRaw)));
  const positionsZ = clamp(normalizeToScale(positionsRaw, lookback.map((h) => h.positionsRaw)));
  const dPositionsZ = clamp(normalizeToScale(dPositionsRaw, lookback.map((h) => h.dPositionsRaw)));

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
  };
}

/**
 * Sign-preserving power transform: sign(x)·|x|^exponent.
 *
 * Used to shape every factor input non-linearly. exponent > 1 emphasizes
 * large readings; exponent < 1 saturates them (e.g. a huge position print
 * adds progressively less signal). exponent = 1 would be linear — by design
 * no factor uses exactly 1.
 */
function signedPow(value: number, exponent: number): number {
  return Math.sign(value) * Math.pow(Math.abs(value), exponent);
}

/**
 * Normalize a raw factor against the magnitude SCALE of its recent history,
 * log-compressed. This is deliberately NOT a statistical z-score — despite the
 * `…Z` field names it produces, standard deviation plays no part.
 *
 *   scale = meanAbs(history)                    // the factor's typical size
 *   ratio = value / scale                       // "how many times typical"
 *   out   = sign(ratio) · log2(1 + |ratio|)     // compressed
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
 * keeps a 10× (→3.46) clearly above a 4× (→2.32) while both stay inside the
 * ±3.5 clamp, so genuine outliers remain distinguishable without dominating.
 * A typical reading (ratio 1.0) maps to exactly 1.0, keeping the entry
 * thresholds in a familiar range.
 *
 * With fewer than 3 data points there is no reliable scale yet, so a clamped
 * sign estimate is returned (unchanged from the previous z-score behaviour).
 */
function normalizeToScale(value: number, history: number[]): number {
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
  return Math.sign(ratio) * Math.log2(1 + Math.abs(ratio));
}
