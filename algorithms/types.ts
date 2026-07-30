/**
 * Core types for the SPX 0DTE Greeks directional scoring algorithm.
 *
 * These types define the data model, scoring components, signals,
 * trade state, and configuration for the algorithm pipeline.
 */

import type { Panel } from '../scraper/core/types.js';

// ── Data Model ──

/**
 * The four data sources every entry/exit decision requires (TODO #6). A slot
 * is only actionable when all four are present; otherwise the algo emits a
 * structured error and skips the decision rather than trading on partial data.
 *   - `spx`       — SPX spot price (signal/decision price), from `spot_prices`.
 *   - `es`        — ES front-month future (P&L basis), from `es_prices`.
 *   - `gex`       — gamma-exposure Greeks, from `periscope_snapshots` (gamma panel).
 *   - `positions` — net MM contracts per strike, from the `positions` table.
 */
export type DataSource = 'spx' | 'es' | 'gex' | 'positions';

/** Per-source presence flags for one slot/tick — see {@link DataSource}. */
export type SourcePresence = Record<DataSource, boolean>;

/** Greek values at a single strike for one snapshot. */
export interface StrikeData {
  strike: number;
  gamma: number;
  charm: number;
  vanna: number;
  /** Net market-maker contracts at this strike (call qty + put qty). */
  positions: number;
}

/**
 * A unified snapshot: all three Greek panels joined for one captured_at,
 * plus the SPX spot price at capture time.
 */
export interface Snapshot {
  /** UTC ISO-8601 timestamp (slot END time). */
  capturedAt: string;
  /** Expiry date YYYY-MM-DD. */
  expiry: string;
  /** UW slot label, e.g. "08:20 - 08:30". */
  timeframe: string;
  /** SPX spot price at capture time — the signal/decision price. */
  spot: number;
  /**
   * ES (front-month e-mini future) price at capture time — the instrument
   * actually traded, so realized P&L is measured off this series (TODO #3).
   * `null`/absent when no ES bar was ingested for the slot; P&L then falls back
   * to {@link spot}. Joined from `es_prices` on the same `captured_at` as spot.
   */
  es?: number | null;
  /** All strikes in the 120pt window with their Greek values. */
  strikes: StrikeData[];
  /**
   * The day's stored expected-move cone (from `cone_snapshots`), stamped onto
   * every snapshot of the day so the in-memory backtest/tuner data flow carries
   * it. `null` when no cone was captured for the day. See {@link ConeEndpoints}.
   */
  cone?: ConeEndpoints | null;
  /**
   * True for an intermediate *price tick* the data-loader inserts between Greek
   * slots so the algo can re-decide entry/exit every minute on the CURRENT stock
   * price, even when the Greek feed is coarser (10-min historical backfill).
   * Greeks (`strikes`) are unchanged from the slot that precedes the tick — only
   * `spot`/`es` are refreshed — so the signal generator reuses the latest Greek
   * score instead of recomputing it (and does NOT advance the z-score history).
   * When the Greek feed is already per-minute no ticks are inserted. Absent/
   * `false` = a real Greek snapshot.
   */
  greeksStale?: boolean;
  /**
   * Which of the four required {@link DataSource}s were actually present when the
   * data loader assembled this slot/tick (TODO #6). Stamped by the loader from
   * what it joined: `gex`/`positions` reflect the Greek slot (and carry forward
   * onto intermediate price ticks), while `spx`/`es` reflect the tick instant.
   * The completeness gate in the signal generator reads this to decide whether
   * the slot is actionable. Absent = derive presence from the fields directly
   * (see `assessCoverage` in data-coverage.ts).
   */
  present?: SourcePresence;
}

// ── Scoring ──

export interface ScoreComponents {
  /**
   * Epoch-ms of the snapshot this score was computed from. Stamped by
   * `computeScore` itself so a caller can never forget it, and read back when the
   * score sits in the per-day history: the normalization lookback is a WALL-CLOCK
   * window ({@link AlgoConfig.zScoreLookbackMin}), so each past entry has to carry
   * the instant it belongs to. See the lookback filter in score-engine.ts.
   */
  at: number;
  gexRaw: number;
  gexZ: number;
  dGammaRaw: number;
  dGammaZ: number;
  /** Net MM positions exposure (directional, distance-weighted). */
  positionsRaw: number;
  positionsZ: number;
  /** Rate of change of net MM positions across successive snapshots. */
  dPositionsRaw: number;
  dPositionsZ: number;
  composite: number;

  /**
   * GROSS magnitudes — the sum of each strike's ABSOLUTE contribution, with no
   * above/below-spot cancellation (unlike the net `…Raw` fields, where a strike
   * above spot offsets one below). These feed the normalization SCALE only: the
   * numerator of each `…Z` is the NET `…Raw` (the directional signal), but its
   * denominator is `meanAbs(history of the matching gross)`. So a balanced
   * "pinning" day — lots of gamma movement, net ≈ 0 — reads ~0 (no direction)
   * instead of a flippy self-normalized ±1, while a one-sided day still reads ~1.
   * See `normalizeToScale` / the normalize block in score-engine.ts.
   */
  gexGross: number;
  dGammaGross: number;
  positionsGross: number;
  dPositionsGross: number;
}

/**
 * Carried-forward state backing the rate-of-change baseline (see
 * {@link AlgoConfig.momentumHalfLifeMin}). Per-strike time-decayed averages of
 * the gamma and positions levels, plus the instant of the last Greek snapshot
 * folded in (so the decay ρ can be derived from the real Δt).
 *
 * DAY-SCOPED: one instance per SignalGenerator, i.e. per trading day. The maps
 * start empty each day, so the baseline never reaches across a day boundary —
 * the same invariant the per-day scoreHistory relies on. Never share across days.
 * `computeScore` reads and mutates it in place on each fresh-Greek snapshot.
 */
export interface MomentumState {
  /** strike → time-decayed average of that strike's gamma level. */
  gamma: Map<number, number>;
  /** strike → time-decayed average of that strike's net-positions level. */
  positions: Map<number, number>;
  /** Epoch-ms of the last Greek snapshot folded in, or null before the first. */
  lastAt: number | null;
}

/**
 * Each factor's weighted contribution to the composite (weight × z-score), so
 * the composite can be broken down into the four parts that produced it:
 * `composite = gex + dGamma + positions + dPositions`. Built by
 * `factorContributions` in score-engine.ts.
 */
export interface FactorContributions {
  /** wGex × gexZ. */
  gex: number;
  /** wDGamma × dGammaZ. */
  dGamma: number;
  /** wPositions × positionsZ. */
  positions: number;
  /** wDPositions × dPositionsZ. */
  dPositions: number;
}

// ── Cone ──

/**
 * The three stored points that define a trading day's expected-move cone
 * (one row in `cone_snapshots`). Two straight lines fan out from the apex
 * `(09:30 ET, spxOpen)` to the end-of-day endpoints `(16:00 ET, coneUpper)`
 * and `(16:00 ET, coneLower)`. The cone WIDENS through the session.
 */
export interface ConeEndpoints {
  /** SPX settled open — the cone apex price (at 09:30 ET). */
  spxOpen: number;
  /** Upper endpoint at the close (spxOpen + ATM straddle). */
  coneUpper: number;
  /** Lower endpoint at the close (spxOpen − ATM straddle). */
  coneLower: number;
}

export type ConeState = 'inside' | 'above' | 'below';
export type ConeCrossing = 'up' | 'down' | 'returned' | null;

export interface ConeInfo {
  upper: number;
  lower: number;
  state: ConeState;
  previousState: ConeState | null;
  crossed: ConeCrossing;
  /**
   * True only on an ET clock-aligned 5-min candle CLOSE — the instants the cone
   * actually re-evaluates its state/crossing. `false` on the held intra-candle
   * ticks in between (and on pre-market / no-cone / seed slots). Cone-driven
   * entries fire only when this is true, so entering (like the re-entry exit) is
   * decided on the previous 5-min close. See ConeTracker.
   */
  atCandleClose: boolean;
}

// ── Signals ──

export type Direction = 'long' | 'short';
export type SignalAction = 'enter_long' | 'enter_short' | 'exit' | 'hold';
export type Confidence = 'low' | 'medium' | 'high';

export interface Signal {
  action: SignalAction;
  direction?: Direction;
  score: ScoreComponents;
  cone: ConeInfo;
  confidence: Confidence;
  reason: string;
  timestamp: string;
}

// ── Trade State ──

export interface TradeState {
  position: 'flat' | 'long' | 'short';
  /** SPX fill price at entry (slipped) — drives stop/target/HWM decisions. */
  entryPrice: number | null;
  /**
   * ES fill price at entry (slipped) — the basis for realized P&L (TODO #3).
   * `entryPrice` (SPX) still decides WHEN to exit; this only measures money.
   */
  entryFill: number | null;
  entryTime: string | null;
  /** Full score at entry — carried to the exit so the trade record can report
   *  each factor's contribution at entry. `null` while flat. */
  entryScore: ScoreComponents | null;
  contracts: number;
  unrealizedPnl: number;
  dailyPnl: number;
  dailyTradeCount: number;
  /** Highest favorable excursion since entry (for trailing stop). */
  highWaterMark: number;
  /**
   * GEX take-profit distance (SPX points) frozen at entry: the distance from
   * the entry-snapshot spot to that snapshot's gamma center of mass. The gamma
   * center is recomputed every slot, so the target is fixed here at entry and
   * the exit check reads this stored value instead of recomputing. `null` while
   * flat. See gexTakeProfitPoints / checkTakeProfit in risk-manager.ts.
   */
  gexTpPoints: number | null;
}

// ── Risk ──

export interface RiskParams {
  /** Max contracts per trade. */
  maxPositionSize: number;
  /** Total account equity in USD. */
  accountEquity: number;
  /** Fraction of equity risked per trade (e.g. 0.01 = 1%). */
  maxRiskPerTrade: number;
  /** Hard stop-loss in SPX points from entry. */
  stopLossPoints: number;
  /**
   * Reward-to-risk ratio used as the fallback take-profit when the entry
   * snapshot carries no gamma in the window. The fallback target =
   * stopLossPoints × riskRewardRatio. The primary TP basis is the gamma
   * center of mass (see gexTakeProfitPoints in risk-manager.ts).
   */
  riskRewardRatio: number;
  /**
   * Minimum GEX-derived take-profit (SPX points) required to enter a trade.
   * The GEX TP is the distance from spot to the gamma center of mass
   * (Σ(|gamma|·strike)/Σ(|gamma|)). When that distance is below this floor the
   * trade is skipped entirely — the expected move is too small to justify
   * round-trip cost and slippage.
   */
  minGexTakeProfitPoints: number;

  // ── Time-decaying exit distances ──
  // Both the take-profit and the stop-loss start at their entry distance and
  // walk LINEARLY toward the entry price as the trade ages:
  //
  //   distance(t) = max(floor, initial · (1 − perHour · hoursHeld))
  //
  // The point is the trade that goes the right way but never quite reaches its
  // target: without decay it round-trips back through entry and exits flat (or
  // on a stop) having given back a move it actually caught. A target that gives
  // up ground over time converts that into a smaller realized win — "if it
  // doesn't reach the TP it can still take some". Decay is measured from the
  // ENTRY instant in wall-clock hours, so it means the same thing on the 1-min
  // live feed and on a 10-min backfill.
  //
  // `perHour = 0` disables decay on that side (the pre-decay fixed-distance
  // behaviour). The floor is clamped to at most the initial distance, so a floor
  // set above it can never WIDEN an exit — decay only ever tightens.

  /**
   * Fraction of the ORIGINAL take-profit distance surrendered per hour held
   * (0.25 = the target moves 25% closer to entry every hour). `0` = off.
   */
  takeProfitDecayPerHour: number;
  /**
   * Floor (SPX pts) under which the decaying take-profit never falls, so a
   * long-held trade can't exit inside round-trip cost + slippage.
   */
  takeProfitFloorPoints: number;
  /**
   * Fraction of the ORIGINAL stop distance surrendered per hour held — the stop
   * tightens toward entry as the trade ages, cutting a position that stopped
   * working. `0` = off (the fixed `stopLossPoints` stop, unchanged).
   *
   * Defaults OFF while take-profit decay defaults ON: a decaying TP can only
   * ever bank profit EARLIER, whereas a tightening stop realizes losses earlier
   * and can shake out a trade that was quietly working. Turn it on deliberately.
   */
  stopLossDecayPerHour: number;
  /** Floor (SPX pts) under which the tightening stop never falls. */
  stopLossFloorPoints: number;

  /**
   * Master switch for the trailing stop. When `false` the trailing stop is
   * disabled entirely and only the hard `stopLossPoints` stop applies;
   * `trailingStopActivation` / `trailingStopDistance` are then ignored.
   *
   * Distinct from `stopLossDecayPerHour`: the trailing stop tracks the trade's
   * high-water mark (profit-driven), the decay tightens on the clock
   * (time-driven). They compose — whichever is hit first exits.
   */
  trailingStopEnabled: boolean;
  /** Profit threshold (SPX pts) to activate trailing stop. */
  trailingStopActivation: number;
  /** Distance (SPX pts) the trailing stop trails behind HWM. */
  trailingStopDistance: number;
  /** Max daily loss as fraction of equity (e.g. 0.02 = 2%). */
  maxDailyLoss: number;
  /** Max round-trip trades per day. */
  maxTradesPerDay: number;
  /** Slippage assumed per side in SPX points. */
  slippagePerSide: number;
  /** SPX point value in USD (e.g. $50 for /ES, $100 for SPX options). */
  pointValue: number;
  /**
   * ET time before which no new entries are allowed (HH:MM). Pre-market Greek
   * frames are loaded so the z-score history and cone/positioning warm up before
   * the bell, but entries stay gated to regular trading hours — set to the 09:30
   * open, thin pre-open SPX liquidity makes pre-bell fills untrustworthy. Exits
   * are never blocked (a position can only exist once entries are allowed).
   */
  noNewTradesBeforeET: string;
  /** ET time after which no new entries allowed (HH:MM). */
  noNewTradesAfterET: string;
  /** ET time by which all positions must be flat (HH:MM). */
  forcedExitByET: string;
}

/**
 * Cone-breakout mode (TODO #8): a distinct entry/exit regime, OFF by default.
 *
 * When `enabled`, the algo replaces its default entry/exit rules with:
 *   - Entry: enter ONLY on a break through the *direction-relevant* cone line,
 *     confirmed by gamma direction. Long = SPX breaks ABOVE the upper line and
 *     gamma points up (gexZ > 0); short = SPX breaks BELOW the lower line and
 *     gamma points down (gexZ < 0). Breaking the wrong line never triggers, and
 *     there are NO inside-cone entries.
 *   - Exit: only the three toggles below fire (plus the always-on forced
 *     end-of-day time exit). The default GEX signal-fade / reversal exits do
 *     NOT apply in this mode.
 * Each exit condition is individually switchable so it's easy to experiment.
 * See docs/algo-knobs.md.
 */
export interface ConeBreakoutConfig {
  /** Master switch. Off → the algo uses its default entry/exit rules. */
  enabled: boolean;
  /** Exit when SPX crosses back inside the cone through the relevant line. */
  exitOnConeReEntry: boolean;
  /** Exit when the GEX take-profit target is hit. */
  exitOnTp: boolean;
  /** Exit when the hard stop-loss is hit. */
  exitOnSl: boolean;
}

// ── Configuration ──

export interface AlgoConfig {
  /** Weight for gamma exposure score. */
  wGex: number;
  /** Weight for gamma rate-of-change. */
  wDGamma: number;
  /** Weight for net MM positions exposure. */
  wPositions: number;
  /** Weight for net MM positions rate-of-change. */
  wDPositions: number;

  // ── Non-linearity (exponents) ──
  // All four factors are aggregated RAW (linear) per strike (R6); each factor's
  // shaping exponent is applied ONCE, to the whole aggregated factor, inside the
  // log at the normalize step (normalizeToScale — R5): out = sign(r)·log2(1 +
  // |r|^p), where r is the factor's scale-ratio. p > 1 emphasizes large readings,
  // p < 1 saturates them; the anchor r = 1 → 1.0 holds for any p.

  /** Normalize-step exponent on the gamma-level factor (gexZ). */
  pGamma: number;
  /**
   * Multiplier applied to positive per-strike gamma (negative gamma uses 1.0).
   * Slightly > 1 makes positive gamma marginally more influential than negative
   * gamma in the GEX score. This is a per-strike MULTIPLICATIVE factor on the raw
   * gamma (R6-permitted), not an exponent. Gamma-only — positions are not biased.
   */
  positiveGammaBias: number;
  /** Normalize-step exponent on the gamma-change factor (dGammaZ). */
  pDGamma: number;
  /** Normalize-step exponent on the positions-level factor (positionsZ). */
  pPositions: number;
  /** Normalize-step exponent on the positions-change factor (dPositionsZ). */
  pDPositions: number;
  /** Exponent on normalized strike distance in the distance-weight ramp. */
  pDistance: number;

  /** Span of the distance-weight ramp: weight = 1 + span·(dist/window)^pDistance. */
  distanceWeightSpan: number;

  /**
   * Memory half-life, IN MINUTES, of the rate-of-change baseline shared by
   * dGamma and dPositions.
   *
   * Each rate of change is `current level − baseline`, where the baseline is a
   * time-decayed average of that strike's recent levels:
   *
   *   ρ        = 0.5^(Δt_minutes / momentumHalfLifeMin)   // per-step retention
   *   baseline = ρ·baseline + (1 − ρ)·currentLevel        // updated each snapshot
   *   dGamma   = signedDelta(currentLevel, baseline)      // per strike, then aggregated
   *
   * The CURRENT snapshot always enters the delta at FULL weight (it is one side
   * of the difference), so a large last-minute move registers immediately; the
   * baseline carries the preceding ~2–3 half-lives of history with geometric
   * decay, so a wall building steadily accumulates while a one-slot blip reverts
   * as the baseline catches up. Because it is a bounded difference of two levels,
   * it never ramps over the session (unlike an accumulating sum).
   *
   * CADENCE-INVARIANT: the half-life is wall-clock minutes and ρ is derived from
   * the actual Δt between snapshots, so the same value means the same physical
   * memory on the 1-min live feed and on a 10-min backfill. At the default 10,
   * a level ~20 min old still carries ~25% weight and ~30 min old ~12%.
   */
  momentumHalfLifeMin: number;

  /**
   * Minimum gamma strength (a strike's |gamma| as a fraction of the window's
   * max |gamma|, 0–1) required for that strike's positions to count at all.
   * Positions where gamma is weak carry no signal regardless of size.
   */
  positionsGammaGate: number;

  /**
   * Hard cap on the absolute value of every normalized factor (and therefore the
   * composite). Backstop only: `normalizeToScale` log-compresses, so a ratio has
   * to exceed ~10.3× the day's typical magnitude before this binds.
   */
  zClamp: number;

  /**
   * Z-score threshold for entries taken OUTSIDE the cone (TODO #9). Applies when
   * price is above the cone with gamma pointing up (long) or below the cone with
   * gamma pointing down (short) — the gamma-aligned breakout case.
   */
  entryThreshold: number;
  /**
   * Z-score threshold for entries taken INSIDE the cone (TODO #9) — a higher bar
   * than `entryThreshold`, since there is no breakout to corroborate the signal.
   */
  strongEntryThreshold: number;
  /**
   * Small threshold discount (SPX z-score units) granted on the *first* tick a
   * gamma-aligned cone pass occurs (TODO #9). On the tick price crosses the
   * relevant line in the gamma direction, the outside-cone entry bar is lowered
   * to `entryThreshold − conePassBonus`, giving a fresh breakout a slight edge.
   * `0` disables the bonus.
   */
  conePassBonus: number;
  /**
   * Wall-clock half-life (MINUTES) of the entry-signal smoother. Entry threshold
   * tests gate on an EWMA of the composite instead of its instantaneous value:
   * `s ← ρ·s + (1−ρ)·composite`, `ρ = 0.5^(Δt / entrySignalHalfLifeMin)`, advanced
   * once per fresh Greek bar. The current bar always carries the largest single
   * weight and older bars decay geometrically, so a one-bar gamma spike is damped
   * (it can't clear the bar on its own) while a signal that persists a few minutes
   * passes — the "enters too quickly" fix. Unlike a fixed bar count it is
   * cadence-invariant: the half-life is real minutes, so it means the same memory
   * on the 1-min live feed and on a 10-min backfill. Direction/gamma-alignment
   * (`gexZ`, cone state) and all EXIT checks stay instantaneous, and the raw
   * composite is still what is frozen into the trade record. A short value keeps
   * the current minute dominant (H≈3 → current bar ~21% weight, a bar ~10 min old
   * ~1%); `0` disables smoothing and enters on the first qualifying bar (the
   * pre-existing behaviour). See `updateEntrySignal` in signal-generator.ts.
   */
  entrySignalHalfLifeMin: number;
  /**
   * Absolute FLOOR of the signal-fade exit bar (z-score units). An open position
   * is closed when its directional composite fades below the effective fade bar,
   * which is `max(exitFadeThreshold, exitFadeFraction × entry conviction)` — so
   * this is the smallest fade level that ever closes a trade. See
   * {@link exitFadeFraction} and `fadeExitBar` in risk-manager.ts.
   */
  exitFadeThreshold: number;
  /**
   * How much a high-conviction entry LOWERS its own signal-fade exit bar, so a
   * strong trade runs longer. The effective bar is
   * `exitFadeThreshold × max(0.1, 1 − exitFadeFraction × (entryConviction − 1))`,
   * where entryConviction is the directional composite at entry and 1.0 is the
   * day's typical magnitude. A trade entered near typical (≈1) keeps the plain
   * floor; one entered at z≈3 shrinks its bar toward zero, so it only fade-exits
   * once the signal has almost fully unwound (the stop-loss and reversal still
   * bound the downside). A LOWER bar = the score must fade FURTHER = a longer
   * hold. `0` → the pure fixed floor (exitFadeThreshold), the pre-existing
   * behaviour. See `fadeExitBar` in risk-manager.ts.
   */
  exitFadeFraction: number;
  /** Z-score in opposing direction that triggers an exit. */
  reversalThreshold: number;

  /**
   * Whether GEX-driven auto-exits are active. When `true` (default) an open
   * position is closed as soon as the composite z-factor fades below
   * `exitFadeThreshold` or reverses past `reversalThreshold` — the momentum that
   * justified the trade is gone. When `false` those two score-driven exits are
   * disabled and a position is held until it hits a structural exit instead:
   * cone-return, stop-loss, take-profit, or the forced end-of-day time gate.
   * The forced time exit and stop-loss/take-profit always apply regardless.
   */
  gexAutoExit: boolean;

  /** Only consider strikes within this many points of spot. */
  strikeWindow: number;
  /**
   * Length, IN MINUTES, of the trailing window used to derive each factor's
   * magnitude scale — the "typical size" every factor is divided by at the
   * normalize step (see `normalizeToScale` in score-engine.ts). It answers
   * "big compared to what?".
   *
   * WALL-CLOCK, like {@link momentumHalfLifeMin} and
   * {@link entrySignalHalfLifeMin}: the window is selected by timestamp, not by
   * a count of entries, so the same value means the same physical memory at any
   * feed cadence. (It was previously a COUNT of snapshots, which silently meant
   * 10× less history on a 1-min feed than on a 10-min one.)
   *
   * Shorter = a local, fast-adapting yardstick: in a quiet stretch the scale
   * shrinks, so ordinary moves read as large and more signals clear the entry
   * bar. Longer = a slower, steadier yardstick: fewer and more selective
   * signals, but slower to react when the day's regime changes.
   *
   * DAY-SCOPED, like the history it slices — a fresh SignalGenerator per trading
   * day means the window can never reach back across a day boundary, so early in
   * the session it simply holds fewer entries than the full window.
   */
  zScoreLookbackMin: number;

  /** Cone-breakout entry/exit mode (TODO #8). Off by default. */
  coneBreakout: ConeBreakoutConfig;

  risk: RiskParams;
}

/** Sensible defaults — tune via backtest. */
export const DEFAULT_CONFIG: AlgoConfig = {
  wGex: 0.45,
  wDGamma: 0.25,
  wPositions: 0.18,
  wDPositions: 0.12,

  pGamma: 1.2,
  positiveGammaBias: 1.1,
  pDGamma: 1.1,
  pPositions: 0.5,
  pDPositions: 0.5,
  pDistance: 1.5,
  distanceWeightSpan: 2.0,
  momentumHalfLifeMin: 10,

  positionsGammaGate: 0.30,
  zClamp: 3.5,

  entryThreshold: 1.5,
  strongEntryThreshold: 2.0,
  conePassBonus: 0.25,
  entrySignalHalfLifeMin: 3, // smooth the entry signal over ~a few min so a 1-bar spike can't enter
  exitFadeThreshold: 0.5, // fade-exit floor
  exitFadeFraction: 0.35, // …but scale the fade bar to 35% of entry conviction so strong trades run
  reversalThreshold: 1.0,
  gexAutoExit: true,

  strikeWindow: 120,
  zScoreLookbackMin: 180, // 3h wall-clock scale window (was 20 snapshots ≈ 200 min at the 10-min cadence)

  coneBreakout: {
    enabled: false, // OFF → default score-driven entry/exit rules apply
    exitOnConeReEntry: true, // exit when price crosses back inside the cone
    exitOnTp: true, // exit when the GEX take-profit is hit
    exitOnSl: true, // exit when the hard stop-loss is hit
  },

  risk: {
    maxPositionSize: 2,
    accountEquity: 50_000,
    maxRiskPerTrade: 0.01,
    stopLossPoints: 10,
    riskRewardRatio: 3, // fallback only (no cone): take-profit at 30 pts
    minGexTakeProfitPoints: 15, // skip trades whose GEX TP (gamma-center distance) < 15 pts
    takeProfitDecayPerHour: 0.25, // target gives up 25%/h: a 30pt TP is 22.5 after 1h, 15 after 2h
    takeProfitFloorPoints: 6, // …but never below 6 pts (round-trip cost + slippage)
    stopLossDecayPerHour: 0, // stop tightening OFF by default (see RiskParams)
    stopLossFloorPoints: 4,
    trailingStopEnabled: false, // trailing stop OFF — only the hard stopLossPoints stop applies
    trailingStopActivation: 5,
    trailingStopDistance: 7,
    maxDailyLoss: 0.02,
    maxTradesPerDay: 6,
    slippagePerSide: 0.50,
    pointValue: 50, // $50 P&L per 1.0 ES point, per contract (/ES e-mini)
    noNewTradesBeforeET: '09:30', // first entry time — pre-market slots warm up only, no trades before the 09:30 bell
    noNewTradesAfterET: '14:00', // last entry time — no new trades at/after 14:00 ET
    forcedExitByET: '15:50', // was 14:50 CT — 10 min before the 16:00 ET close
  },
};

// ── Capital account (backtest / training) ──

/**
 * Capital-account settings for a backtest or training run. This models the
 * *real cash balance* and is deliberately separate from `RiskParams.accountEquity`
 * (which only governs per-trade position sizing). A run is seeded with
 * `initialCapital` and is declared a failure the instant realized equity touches
 * `equityFloor` — see TODO #9.
 */
export interface EquitySettings {
  /** Initial capital seeded at the start of the run (USD). */
  initialCapital: number;
  /** Hard equity floor: if equity ≤ this at any point, the run fails (USD). */
  equityFloor: number;
}

/**
 * Default training account: start at $100,000, fail if equity hits $98,000
 * (a hard $2,000 max-drawdown stop). See TODO #9.
 */
export const DEFAULT_EQUITY: EquitySettings = {
  initialCapital: 100_000,
  equityFloor: 98_000,
};

// ── Backtest Results ──

export interface TradeRecord {
  direction: Direction;
  entryTime: string;
  /** SPX entry price (slipped) — the signal-side decision price. */
  entryPrice: number;
  exitTime: string;
  /** SPX exit price — the signal-side decision price. */
  exitPrice: number;
  /** ES entry fill (slipped) — the price realized P&L was computed from. */
  entryFill: number;
  /** ES exit fill (slipped) — the price realized P&L was computed from. */
  exitFill: number;
  contracts: number;
  /** Hard stop-loss level (SPX), computed from entry price at entry. */
  stopPrice: number;
  /** Take-profit target level (SPX), computed from entry price at entry. */
  targetPrice: number;
  /** Realized P&L (USD), computed from the ES fills (TODO #3). */
  pnl: number;
  /** Composite z-factor at entry (== sum of contributionsAtEntry). */
  zAtEntry: number;
  /** Composite z-factor at the exit (== sum of contributionsAtExit). */
  zAtExit: number;
  /** Each factor's weighted contribution to the composite at entry. */
  contributionsAtEntry: FactorContributions;
  /** Each factor's weighted contribution to the composite at the exit. */
  contributionsAtExit: FactorContributions;
  reason: string;
}

export interface BacktestResult {
  trades: TradeRecord[];
  totalPnl: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  maxDrawdown: number;
  sharpe: number;
  totalDays: number;

  // ── Capital account (TODO #9) ──
  /** Capital seeded at the start of the run (USD). */
  initialCapital: number;
  /** Equity at the end of the run = initialCapital + realized PnL of counted trades. */
  finalEquity: number;
  /** Lowest equity touched during the run (USD). */
  minEquity: number;
  /**
   * True if equity hit `equityFloor` at any point — the run is a failure and the
   * params must be changed. Trades after the breach are not counted.
   */
  failed: boolean;
}
