/**
 * Score engine: computes the composite directional score from a snapshot.
 *
 * Five factors (user requirements):
 *   1. Gamma exposure (GEX) — directional gamma pressure per strike
 *   2. Put/call positions — only with large gamma (deferred; uses gamma sign as proxy)
 *   3. dGamma/dt — rate of change of gamma across successive snapshots
 *   4. Distance weighting — further strikes contribute MORE score
 *   5. Cone — handled separately in cone.ts (trigger gate, not a score factor)
 *
 * Charm and vanna are included as additional Greek signals that amplify
 * the gamma-based core signal.
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
  let charmRaw = 0;
  let vannaRaw = 0;

  // Build a lookup for previous snapshot's strikes for dGamma computation
  const prevByStrike = new Map<number, StrikeData>();
  if (previous) {
    for (const s of previous.strikes) {
      prevByStrike.set(s.strike, s);
    }
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

    // Charm bias: charm decay amplifies gamma effects into close
    charmRaw += s.charm * sign * dWeight;

    // Vanna bias: vanna amplifies during vol regime changes
    vannaRaw += s.vanna * sign * dWeight;

    // Factor 3: dGamma/dt — rate of change of gamma positioning
    if (previous) {
      const prev = prevByStrike.get(s.strike);
      if (prev) {
        const deltaGamma = s.gamma - prev.gamma;
        dGammaRaw += deltaGamma * sign * dWeight;
      }
    }
  }

  // Z-score normalization using rolling lookback
  const lookback = history.slice(-config.zScoreLookback);
  const gexZ = zScore(gexRaw, lookback.map((h) => h.gexRaw));
  const dGammaZ = zScore(dGammaRaw, lookback.map((h) => h.dGammaRaw));
  const charmZ = zScore(charmRaw, lookback.map((h) => h.charmRaw));
  const vannaZ = zScore(vannaRaw, lookback.map((h) => h.vannaRaw));

  // Composite weighted score
  const composite =
    config.wGex * gexZ +
    config.wDGamma * dGammaZ +
    config.wCharm * charmZ +
    config.wVanna * vannaZ;

  return {
    gexRaw,
    gexZ,
    dGammaRaw,
    dGammaZ,
    charmRaw,
    charmZ,
    vannaRaw,
    vannaZ,
    composite,
  };
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
