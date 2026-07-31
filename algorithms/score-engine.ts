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
 *      positions enter at full magnitude with no gamma-strength weighting).
 *
 *      DIRECTION COMES FROM THE LEG AND THE SIGN OF ITS QUANTITY, not from the
 *      strike's side of spot (see {@link legContribution}). Puts and calls of the
 *      same sign point OPPOSITE ways, so the two legs are read separately and
 *      bullish and bearish cancel — within a strike and across strikes alike.
 *      Side of spot survives only as the ITM/OTM test that picks each leg's
 *      distance weight.
 *   3. dGamma/dt — rate of change of gamma, measured as the current gamma level
 *      against a TIME-DECAYED BASELINE of that strike's recent levels (not just
 *      the immediately previous snapshot). Its SIZE is the distance the value
 *      actually travelled from the baseline (|Δgamma|, so a sign flip counts as
 *      the full trip through zero) and its SIGN is momentum — a wall building vs
 *      bleeding, including a negative-gamma strike shrinking toward zero. See
 *      {@link signedDelta}. Then pointed by the strike's side of spot.
 *   4. dPositions/dt — rate of change of net MM positions (same gamma gate —
 *      threshold only, no gamma-strength weighting). Each LEG moves against its
 *      own decayed baseline, as a PLAIN SIGNED DIFFERENCE (not {@link signedDelta}
 *      — see {@link decayedDiff}), and the two are then combined by the same
 *      {@link legContribution} rule as the level.
 *
 *      The baseline is a per-strike EWMA in WALL-CLOCK time (half-life
 *      `momentumHalfLifeMin`): the current snapshot enters at full weight, so a
 *      large last-minute move registers at once, while the preceding ~2–3
 *      half-lives of history decay in behind it — a steady build accumulates, a
 *      one-slot blip reverts as the baseline catches up. See {@link MomentumState}
 *      and {@link decayedDelta}. It is cadence-invariant (ρ is derived from the
 *      real Δt) and cannot ramp (a bounded difference of two levels).
 *
 *      BOTH RATES OF CHANGE READ 0 UNTIL THERE IS A BASELINE. On a day with
 *      pre-market coverage the baselines are warmed from the 09:00–09:29 ET
 *      frames ({@link primeMomentum}), so the first slot after the bell measures
 *      against real pre-open levels; without pre-market data the first scored
 *      slot establishes the baseline and reports dGamma/dPositions as exactly 0
 *      (never a self-difference). The gamma and positions LEVELS are unaffected
 *      — they are instantaneous readings and need no history.
 *   5. Distance weighting — further strikes contribute MORE score. EXCEPT the
 *      in-the-money position leg, which decays the other way — see
 *      {@link legContribution}.
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
  WarmupFrame,
} from './types.js';

/** Fresh, empty day-scoped {@link MomentumState}. One per SignalGenerator. */
export function createMomentumState(): MomentumState {
  return {
    gamma: new Map(),
    positionsCall: new Map(),
    positionsPut: new Map(),
    lastAt: null,
    initialized: false,
  };
}

/**
 * Fold the day's PRE-MARKET frames into the momentum baselines, so the first
 * scored slot of the session measures dGamma/dPositions against real pre-open
 * levels instead of against itself.
 *
 * This is the ONLY thing pre-market data is used for. A {@link WarmupFrame}
 * carries no price (SPX has no pre-open print), so it is never scored, never
 * enters the z-score history, and can never open a trade — see WarmupFrame.
 *
 * The fold is exactly the fold `computeScore` performs: the same ρ from the same
 * wall-clock Δt, the same `decayedDelta`/`decayedDiff` update — the returned
 * deltas are simply discarded. Replaying the pre-market through here and
 * replaying it through `computeScore` therefore leave identical baselines; there
 * is no second copy of the decay math to drift.
 *
 * Position LEGS are folded only from frames that actually carried a positions
 * row (`hasPositions`): a loader-default 0 is not an observed 0, and folding it
 * would fake a position collapse at the bell. Gamma is folded from every frame.
 *
 * @param state   Day-scoped state, mutated in place.
 * @param frames  Pre-market frames in CHRONOLOGICAL order (the loader sorts them).
 * @param config  Supplies `momentumHalfLifeMin` — the same half-life scoring uses.
 * @returns How many frames were folded; 0 leaves the state untouched (and
 *          `initialized` false, so the deltas stay 0 until the first scored slot).
 */
export function primeMomentum(
  state: MomentumState,
  frames: readonly WarmupFrame[],
  config: AlgoConfig,
): number {
  for (const frame of frames) {
    const frameMs = new Date(frame.capturedAt).getTime();
    const rho = decayRetention(state.lastAt, frameMs, config);

    for (const s of frame.strikes) {
      decayedDelta(state.gamma, s.strike, s.gamma, undefined, rho);
      if (frame.hasPositions) {
        decayedDiff(state.positionsCall, s.strike, s.callQty, undefined, rho);
        decayedDiff(state.positionsPut, s.strike, s.putQty, undefined, rho);
      }
    }

    state.lastAt = frameMs;
  }

  if (frames.length > 0) state.initialized = true;
  return frames.length;
}

/**
 * Per-step baseline retention ρ = 0.5^(Δt / halfLife), derived from the REAL
 * wall-clock gap so the half-life means the same memory at any cadence. Before
 * the first fold (`lastAt === null`) ρ = 0, so the baseline simply seeds to the
 * current level. Δt is clamped — see {@link MIN_DELTA_MINUTES}/{@link MAX_DELTA_MINUTES}.
 */
function decayRetention(lastAt: number | null, currentMs: number, config: AlgoConfig): number {
  if (lastAt === null) return 0;
  const halfLife =
    Number.isFinite(config.momentumHalfLifeMin) && config.momentumHalfLifeMin > 0
      ? config.momentumHalfLifeMin
      : DEFAULT_MOMENTUM_HALF_LIFE_MIN;
  const dtMin = Math.min(
    MAX_DELTA_MINUTES,
    Math.max(MIN_DELTA_MINUTES, (currentMs - lastAt) / 60_000),
  );
  return Math.pow(0.5, dtMin / halfLife);
}

/**
 * Flat damping applied to the IN-THE-MONEY position leg, on top of its distance
 * decay: an ITM leg is worth half an OTM leg at the same distance. Deliberately a
 * fixed constant rather than a tuner knob — it encodes a structural property of
 * the leg (an ITM contract is a weaker expression of a directional view), not a
 * free parameter to fit. See {@link legContribution}.
 */
const ITM_POSITION_WEIGHT = 0.5;

/** Fallback half-life (min) if a config predates `momentumHalfLifeMin`. */
const DEFAULT_MOMENTUM_HALF_LIFE_MIN = 10;
/**
 * Fallback normalization window (min) if a config predates `zScoreLookbackMin` —
 * notably a model persisted in `tuned-models.json` back when the field was the
 * snapshot COUNT `zScoreLookback`, which `loadModelStore` casts without
 * validating. Without this a stale record would yield `undefined` minutes, an
 * empty lookback, and a silent cold-start score on every slot.
 */
const DEFAULT_ZSCORE_LOOKBACK_MIN = 180;
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
  // last Greek frame folded in (a pre-market warm-up frame counts) so the
  // half-life means the same wall-clock memory at any cadence. Before the first
  // fold (or with no momentum state) ρ = 0, so the baseline simply seeds to the
  // current level and the first delta is 0.
  const currentMs = new Date(current.capturedAt).getTime();
  const rho = momentum ? decayRetention(momentum.lastAt, currentMs, config) : 0;

  // Do the rate-of-change factors have a baseline to measure against yet? With a
  // MomentumState that is `initialized` (pre-market warm-up folded in, or an
  // earlier scored slot); on the stateless path it is simply "there is a
  // previous snapshot". Until then dGamma/dPositions are reported as EXACTLY 0
  // rather than a self-difference against a baseline seeded from this very
  // frame — see {@link MomentumState.initialized}. The levels are still folded
  // below, so the next frame reads a true change.
  const momentumReady = momentum ? momentum.initialized : previous !== null;

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
    // The per-leg quantity is taken RAW (linear, no power) — like every factor
    // (R6). Shaping (its `pPositions` exponent) and compression (the log) happen
    // together at the normalize step (normalizeToScale), so a large print is
    // tamed at the aggregate scale rather than saturated strike-by-strike.
    //
    // Unlike gamma, this factor does NOT take `sign`: direction is already baked
    // into the leg/quantity-sign rule inside legContribution.
    const gammaStrength = maxAbsGamma > 0 ? Math.abs(s.gamma) / maxAbsGamma : 0;
    const positionsCounts = gammaStrength >= config.positionsGammaGate;

    if (positionsCounts) {
      const c = legContribution(s.callQty, s.putQty, distance, dWeight);
      positionsRaw += c;
      positionsGross += Math.abs(c); // |strike's net contribution|, no cross-strike cancellation
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

    // Factor 4: each POSITION LEG moves against its own decayed baseline, then the
    // two are combined by the same leg/sign rule as the level — so a change is
    // bullish or bearish for exactly the reason the level would be.
    //
    // The delta is a PLAIN SIGNED DIFFERENCE (decayedDiff), NOT signedDelta: this
    // factor's direction comes from the quantity's own sign, and signedDelta is
    // sign-blind by construction, so it would point backwards on every negative
    // leg (MM shorting more puts — a deepening bearish position — reads as
    // "magnitude building" and would score bullish). A plain difference is correct
    // at every sign and still travels the full trip through zero on a flip,
    // because the quantity it differences is itself signed.
    //
    // Both baselines are kept fresh for EVERY in-window strike (so a strike
    // crossing the gamma gate mid-day already has a warm baseline), but only a
    // gated strike's delta enters the score — mirroring the positions LEVEL gate.
    // They hold RAW UNWEIGHTED quantities; the ITM/OTM weights are applied after
    // the delta, inside legContribution, so a strike flipping ITM↔OTM as spot
    // moves never registers as a phantom position change.
    const dCall = decayedDiff(momentum?.positionsCall, s.strike, s.callQty, prev?.callQty, rho);
    const dPut = decayedDiff(momentum?.positionsPut, s.strike, s.putQty, prev?.putQty, rho);
    if (positionsCounts) {
      const dc = legContribution(dCall, dPut, distance, dWeight);
      dPositionsRaw += dc;
      dPositionsGross += Math.abs(dc); // |strike's net contribution|, no cross-strike cancellation
    }
  }

  // No baseline yet (see `momentumReady`): report the rate-of-change factors as
  // exactly 0 — raw AND gross, so nothing enters the normalization scale either.
  // The baselines above were still updated, so the next frame reads a real
  // change. This is a no-op on a day that warmed up pre-market.
  if (!momentumReady) {
    dGammaRaw = 0;
    dGammaGross = 0;
    dPositionsRaw = 0;
    dPositionsGross = 0;
  }

  // The baseline decay consumed this snapshot; advance the clock so the next
  // snapshot derives ρ from the true Δt, and mark the baselines usable.
  // (Skipped when running stateless.)
  if (momentum) {
    momentum.lastAt = currentMs;
    momentum.initialized = true;
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
  // WALL-CLOCK lookback: keep the history entries whose own instant falls inside
  // the trailing `zScoreLookbackMin` window, rather than a fixed COUNT of
  // entries. A count means 10× less history on a 1-min feed than on a 10-min one
  // (the same trap `momentumHalfLifeMin` / `entrySignalHalfLifeMin` were made
  // cadence-invariant to avoid); selecting by timestamp makes the scale mean the
  // same physical memory at any cadence. `history` holds only PRIOR scores (the
  // current one is pushed by the caller after this returns), and it is day-scoped,
  // so early in the session the window simply holds fewer entries.
  const windowMin =
    Number.isFinite(config.zScoreLookbackMin) && config.zScoreLookbackMin > 0
      ? config.zScoreLookbackMin
      : DEFAULT_ZSCORE_LOOKBACK_MIN;
  const windowStartMs = currentMs - windowMin * 60_000;
  const lookback = history.filter((h) => h.at >= windowStartMs);
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
    // Stamped here, not by the caller, so a score can never enter the history
    // without the instant the wall-clock lookback needs to place it.
    at: currentMs,
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
 * Combine one strike's two market-maker position legs into a single signed
 * directional contribution. The single source of truth for what a position
 * MEANS — used for both the level (factor 2) and the rate of change (factor 4),
 * so a change is bullish or bearish for exactly the reason the level would be.
 *
 * DIRECTION — from the leg and the sign of its quantity, NOT the side of spot:
 *
 *              negative qty   positive qty
 *     puts       bearish        bullish
 *     calls      bullish        bearish
 *
 * which is exactly `+putQty − callQty`: a put carries its own sign, a call is
 * inverted. This holds identically above and below spot. Because the terms are
 * summed SIGNED, bullish and bearish cancel — within a strike (a bullish put
 * against a bearish call) and, once the caller accumulates, across strikes too.
 *
 * DISTANCE — the in-the-money leg decays, the out-of-the-money leg ramps. Puts
 * are ITM above spot, calls are ITM below spot; an ITM contract is a weaker
 * expression of a directional view, and weaker still the deeper it goes:
 *
 *     w_OTM = otmWeight                       // 1 + span·(d/W)^pDistance, rises
 *     w_ITM = ITM_POSITION_WEIGHT / otmWeight // reciprocal mirror, falls
 *
 * The ITM curve is the OTM ramp inverted, so it reuses the already-tuned
 * `distanceWeightSpan`/`pDistance` and adds no free parameter; the flat
 * {@link ITM_POSITION_WEIGHT} then damps it further. At exactly ATM neither leg
 * is in the money, so both take `otmWeight` (which is 1.0 there anyway).
 *
 * @param callQty   Signed call-leg quantity (or its rate of change).
 * @param putQty    Signed put-leg quantity (or its rate of change).
 * @param distance  `strike − spot`, SIGNED — only its sign is read, to decide
 *                  which leg is in the money.
 * @param otmWeight The shared distance ramp `dWeight` at this strike.
 */
function legContribution(
  callQty: number,
  putQty: number,
  distance: number,
  otmWeight: number,
): number {
  const itmWeight = ITM_POSITION_WEIGHT / otmWeight;
  const wPut = distance > 0 ? itmWeight : otmWeight;
  const wCall = distance < 0 ? itmWeight : otmWeight;
  return putQty * wPut - callQty * wCall;
}

/**
 * One position leg's rate of change against its DECAYED BASELINE, updating the
 * baseline in place. Identical to {@link decayedDelta} — same seeding, same EWMA
 * fold-in, same cadence-invariant ρ — except the move itself is a PLAIN SIGNED
 * DIFFERENCE rather than {@link signedDelta}'s flip-aware magnitude measure:
 *
 *   seed = baseline[strike] ?? prevLevel ?? currLevel
 *   out  = currLevel − seed
 *
 * WHY NOT signedDelta HERE: it is sign-blind by construction (negating both
 * inputs leaves its output unchanged), which is right for gamma — whose direction
 * comes from the side of spot — and wrong for positions, whose direction comes
 * from the quantity's OWN sign (see {@link legContribution}). A market maker
 * shorting more puts, −500 → −800, is deepening a BEARISH position; signedDelta
 * reads that as "magnitude building" and returns +300, scoring it bullish. The
 * plain difference returns −300, which is correct — and it loses nothing on
 * flips, since differencing an already-signed quantity travels the full trip
 * through zero on its own (+100 → −50 gives −150, not −50).
 */
function decayedDiff(
  baseline: Map<number, number> | undefined,
  strike: number,
  currLevel: number,
  prevLevel: number | undefined,
  rho: number,
): number {
  const seed = baseline?.get(strike) ?? prevLevel ?? currLevel;
  const out = currLevel - seed;
  if (baseline) baseline.set(strike, rho * seed + (1 - rho) * currLevel);
  return out;
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
 * Signed rate-of-change of a per-strike gamma level against a reference level
 * (the previous snapshot, or a decayed baseline).
 *
 * GAMMA ONLY (factor 3). Factor 4 used to share this, but positions moved to
 * {@link decayedDiff}'s plain signed difference once their direction started
 * coming from the quantity's own sign — which this function is deliberately
 * blind to. See {@link decayedDiff} for why that distinction is load-bearing.
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
