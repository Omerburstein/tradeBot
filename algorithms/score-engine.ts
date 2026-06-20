/**
 * Score engine: computes the composite directional score from a snapshot.
 *
 * Factors (user requirements):
 *   1. Gamma exposure (GEX) — directional gamma pressure per strike
 *   2. Net MM positions — directional positioning pressure per strike, but
 *      only where gamma is strong at the SAME strike, and compressed
 *      non-linearly so an extremely large position print can't dominate
 *   3. dGamma/dt — rate of change of gamma across successive snapshots
 *   4. dPositions/dt — rate of change of net MM positions (same gating)
 *   5. Distance weighting — further strikes contribute MORE score
 *   6. Cone — handled separately in cone.ts (trigger gate, not a score factor)
 *
 * Gamma carries the most weight. Charm and vanna are intentionally excluded
 * from the composite score; the signal is built from gamma and net
 * market-maker positions and their respective rates of change.
 */

import type { AlgoConfig, ScoreComponents, Snapshot, StrikeData } from './types.js';

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

    // Factor 4: Distance weighting — further strikes get MORE weight
    // Linear ramp: ATM gets 1.0x, edge of window gets 3.0x
    const dWeight = 1.0 + 2.0 * (absDistance / config.strikeWindow);

    // Factor 1: Gamma exposure (GEX)
    // Positive gamma above spot → MM sells into rallies (resistance, pulls price up as magnet)
    // Positive gamma below spot → MM buys dips (support, pulls price down as magnet)
    // Net effect: gamma * sign gives directional bias
    gexRaw += s.gamma * sign * dWeight;

    // Factor 2: Net MM positions exposure — gated and weighted by gamma.
    // A strike's positions only count when its gamma is strong relative to
    // the window max; positions are compressed non-linearly so an extremely
    // large print doesn't dominate (size beyond a point adds little signal).
    const gammaStrength = maxAbsGamma > 0 ? Math.abs(s.gamma) / maxAbsGamma : 0;
    const positionsCounts = gammaStrength >= config.positionsGammaGate;

    if (positionsCounts) {
      positionsRaw += compress(s.positions) * gammaStrength * sign * dWeight;
    }

    // Factors 3 & 4: rate-of-change of gamma and positions across snapshots
    if (previous) {
      const prev = prevByStrike.get(s.strike);
      if (prev) {
        const deltaGamma = s.gamma - prev.gamma;
        dGammaRaw += deltaGamma * sign * dWeight;

        if (positionsCounts) {
          const deltaPositions = s.positions - prev.positions;
          dPositionsRaw += compress(deltaPositions) * gammaStrength * sign * dWeight;
        }
      }
    }
  }

  // Z-score normalization using rolling lookback
  const lookback = history.slice(-config.zScoreLookback);
  const gexZ = zScore(gexRaw, lookback.map((h) => h.gexRaw));
  const dGammaZ = zScore(dGammaRaw, lookback.map((h) => h.dGammaRaw));
  const positionsZ = zScore(positionsRaw, lookback.map((h) => h.positionsRaw));
  const dPositionsZ = zScore(dPositionsRaw, lookback.map((h) => h.dPositionsRaw));

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
 * Non-linear compression for net MM positions (and their deltas).
 *
 * Position size can be extremely large at a single strike without carrying
 * proportionally more signal, so we apply a sign-preserving log transform
 * that saturates large magnitudes while staying ~linear for small ones.
 */
function compress(value: number): number {
  return Math.sign(value) * Math.log1p(Math.abs(value));
}

/**
 * Compute z-score of a value against a history array.
 *
 * With fewer than 3 data points, returns a clamped sign estimate
 * (the z-score would be unreliable with so little history).
 */
function zScore(value: number, history: number[]): number {
  if (history.length < 3) {
    // Not enough data for meaningful statistics — return clamped sign
    return value > 0 ? 1 : value < 0 ? -1 : 0;
  }

  const n = history.length;
  const mean = history.reduce((a, b) => a + b, 0) / n;
  const variance = history.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);

  // Avoid division by zero when all values are identical
  if (std < 1e-10) return 0;

  return (value - mean) / std;
}
