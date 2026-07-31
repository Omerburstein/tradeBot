/**
 * Signal generator: combines score engine + cone tracker + risk manager
 * into actionable entry/exit signals.
 *
 * Entry logic (TODO #9 — cone-threshold rule):
 *   The cone sets *which* entry bar the composite z-score must clear, keyed on
 *   the current cone state (not on pass events):
 *   - OUTSIDE the cone → the normal `entryThreshold`, but only when gamma agrees
 *     with the breakout side:
 *       - LONG:  price ABOVE the cone + gamma up   (gexZ > 0) + composite > +entryThreshold
 *       - SHORT: price BELOW the cone + gamma down (gexZ < 0) + composite < -entryThreshold
 *     A breakout against the gamma direction never qualifies.
 *   - INSIDE the cone → the higher `strongEntryThreshold` (no breakout to
 *     corroborate the signal), taken in the composite's direction.
 *   The *first* tick of a gamma-aligned cone pass earns a small discount on the
 *   outside-cone bar (`conePassBonus`), rewarding a fresh breakout.
 *
 * Exit logic:
 *   - Signal fade: composite drops below ±0.5
 *   - Reversal: composite flips past ±1.0 in opposing direction
 *   - Stop-loss: hard or trailing stop hit
 *   - Cone breach: on a 5-min candle close, the cone state moved AGAINST the
 *     position (short → state moved up, long → moved down). Covers a breakout
 *     that closed back inside its line AND an inside position that broke out the
 *     far line against it (e.g. a short closing above the upper line). Structural
 *     (independent of gexAutoExit), applies to inside- and outside-cone entries.
 *   - Time gate: forced exit before 0DTE decay chaos (15:50 ET)
 *   (The cone samples state on 5-min closes for BOTH entries and this exit — see
 *    ConeTracker. Cone-breakout mode, TODO #8, keeps its own exit set.)
 */

import type pino from 'pino';
import { ConeTracker } from './cone.js';
import { assessCoverage, coverageGap, type DataGap } from './data-coverage.js';
import {
  checkDailyLimits,
  checkStopLoss,
  checkTakeProfit,
  checkTimeGates,
  computePositionSize,
  createFlatState,
  fadeExitBar,
  gexTakeProfitPoints,
  meetsGexMinTakeProfit,
  recordEntry,
  recordExit,
  updateTradeMetrics,
} from './risk-manager.js';
import {
  computeScore,
  createMomentumState,
  factorContributions,
  primeMomentum,
} from './score-engine.js';
import type {
  AlgoConfig,
  ConeInfo,
  ConeState,
  Confidence,
  FactorContributions,
  MomentumState,
  ScoreComponents,
  Signal,
  Snapshot,
  TradeRecord,
  TradeState,
} from './types.js';

// ── Confidence tiers (assessConfidence) ──
// Composite |z| and dGamma |z| bars that upgrade a signal's confidence label.
// Labels are advisory (logged / reported); they do not gate entries.
/** |composite z| above this, with a cone breach and strong dGamma, reads 'high'. */
const HIGH_CONFIDENCE_Z = 2.5;
/** |dGamma z| required alongside {@link HIGH_CONFIDENCE_Z} for a 'high' label. */
const HIGH_CONFIDENCE_DGAMMA_Z = 1.0;
/** |composite z| above this (or any cone breach) reads at least 'medium'. */
const MEDIUM_CONFIDENCE_Z = 2.0;

/**
 * Stateful signal generator for a single trading day.
 * Create a new instance for each day.
 */
export class SignalGenerator {
  private config: AlgoConfig;
  /** Built lazily from the first snapshot's stored cone endpoints. */
  private cone: ConeTracker | null = null;
  private state: TradeState;
  /**
   * Per-day score history backing the z-score normalization. Starts empty for
   * each day because a new SignalGenerator is created per trading day (see
   * simulate() in backtest.ts) — so the z-score mean/std are always derived
   * from the SAME day's snapshots, never from prior days' historical data.
   * Never share a generator across days or this invariant breaks.
   */
  private scoreHistory: ScoreComponents[] = [];
  /**
   * Day-scoped baseline state for the dGamma/dPositions rate-of-change factors
   * (see {@link MomentumState}). Fresh per generator, so the momentum baseline
   * never reaches across a day boundary — same invariant as scoreHistory.
   */
  private momentum: MomentumState = createMomentumState();
  /**
   * Pre-market frames folded into {@link momentum} at the day's first snapshot
   * (see `primeMomentum`). 0 = the day started cold, so dGamma/dPositions read
   * exactly 0 until the first scored slot establishes the baseline. Reported by
   * {@link getWarmup} so a run can say which of the two it was.
   */
  private warmupFrames = 0;
  /** Whether the once-per-day warm-up fold has already run. */
  private warmedUp = false;
  /** Last snapshot of any kind — for the chronological look-ahead guard. */
  private previousSnapshot: Snapshot | null = null;
  /** Last snapshot carrying fresh Greeks — the dGamma/dPositions baseline. */
  private previousGreekSnapshot: Snapshot | null = null;
  /** Most recent Greek score, reused on intermediate price ticks. */
  private lastScore: ScoreComponents | null = null;
  /**
   * True when the current snapshot carried fresh Greeks (score was recomputed),
   * false on a reused-score price tick. Set each `processSnapshot` before the
   * signal is generated; the entry-signal EWMA advances only on fresh Greek bars
   * (a price tick brings no new Greek information).
   */
  private freshGreeks = false;
  /**
   * Day-scoped EWMA of the composite, used ONLY to gate entry threshold tests
   * (see {@link AlgoConfig.entrySignalHalfLifeMin}). Seeded to the first fresh
   * composite and advanced only on fresh Greek bars, in wall-clock time. Equals
   * the raw composite when smoothing is off. `entrySignalLastMs` is the instant
   * of the last advance, for the wall-clock decay. See `updateEntrySignal`.
   */
  private entrySignalComposite = 0;
  private entrySignalLastMs: number | null = null;
  private trades: TradeRecord[] = [];
  private logger?: pino.Logger;
  /**
   * Slots skipped because a required data source was missing (TODO #6). Each is
   * also emitted at error level as it happens; this collects them so a run can
   * summarize its coverage gaps at the end (see getDataGaps()).
   */
  private dataGaps: DataGap[] = [];

  /**
   * @param config  Algorithm configuration.
   * @param logger  Optional pino logger; when provided, every entry/exit
   *                action is logged at info level. Omit to run silently
   *                (e.g. inside the tuner's inner loop).
   */
  constructor(config: AlgoConfig, logger?: pino.Logger) {
    this.config = config;
    this.state = createFlatState();
    this.logger = logger;
  }

  /**
   * Process a new snapshot and return a signal.
   *
   * Called once per decision — every minute — in chronological order. Real Greek
   * snapshots arrive at the feed's own cadence (per-minute live, 10-min
   * historical backfill); when it is coarser the data-loader inserts an
   * intermediate price tick (`greeksStale`) at each minute so entry/exit is
   * re-decided on the current stock price between Greek frames. On a price tick
   * the Greeks are unchanged, so the latest Greek score is reused (and the
   * z-score history is not advanced) while the cone/stop/target/entry checks
   * below all run against the tick's current spot.
   *
   * Throws if a snapshot arrives out of order (look-ahead guard).
   */
  processSnapshot(snapshot: Snapshot): Signal {
    if (this.previousSnapshot !== null) {
      const prevMs = new Date(this.previousSnapshot.capturedAt).getTime();
      const currMs = new Date(snapshot.capturedAt).getTime();
      if (currMs < prevMs) {
        throw new Error(
          `Look-ahead violation: snapshot ${snapshot.capturedAt} arrived after ${this.previousSnapshot.capturedAt}`,
        );
      }
    }

    const { config } = this;

    // 0a. Pre-market warm-up, once per day, before anything is scored: fold the
    // day's pre-open Greek/position frames into the momentum baselines so the
    // first slot after the bell measures dGamma/dPositions against real pre-open
    // levels instead of against itself. Runs even when this first snapshot turns
    // out to be a data gap (the warm-up is day data, not slot data), and is a
    // no-op on a day with no pre-market coverage — the rate-of-change factors
    // then simply read 0 until the first scored slot establishes the baseline.
    if (!this.warmedUp) {
      this.warmedUp = true;
      this.warmupFrames = primeMomentum(this.momentum, snapshot.warmup ?? [], config);
    }

    // 0. Data-completeness gate (TODO #6). A decision requires all four sources
    // (SPX, ES, GEX, positions) for THIS slot. If any is missing, emit a
    // structured error and hold — never score, enter, exit, or advance the
    // z-score baseline on partial data. The slot is recorded so the run can
    // summarize its coverage gaps.
    const coverage = assessCoverage(snapshot);
    if (!coverage.complete) {
      const gap = coverageGap(snapshot, coverage);
      this.dataGaps.push(gap);
      this.logger?.error(
        { event: 'DATA_GAP', ...gap },
        `skipping decision at ${snapshot.capturedAt}: incomplete slot — missing ${gap.missing.join(', ')}`,
      );
      // Keep the ordering guard monotonic, but leave the Greek/score baseline
      // untouched so an incomplete slot never pollutes the z-score history.
      this.previousSnapshot = snapshot;
      return this.makeSignal('hold', EMPTY_SCORE, NEUTRAL_CONE, snapshot, 'low',
        `data gap: missing ${gap.missing.join(', ')}`);
    }

    // 1. Score. Fresh Greeks → recompute (vs the previous Greek snapshot) and
    // advance the z-score history. A price tick reuses the latest Greek score:
    // the Greeks haven't changed, so re-deriving a delta against an identical
    // strike set would only inject zero-deltas that distort the lookback.
    let score: ScoreComponents;
    this.freshGreeks = !snapshot.greeksStale || this.lastScore === null;
    if (this.freshGreeks) {
      score = computeScore(snapshot, this.previousGreekSnapshot, this.scoreHistory, config, this.momentum);
      this.scoreHistory.push(score);
      this.previousGreekSnapshot = snapshot;
      this.lastScore = score;
      // Advance the entry-signal EWMA on fresh Greek bars only — a reused-score
      // price tick carries no new signal, so the gate holds its last value.
      this.entrySignalComposite = this.updateEntrySignal(
        score.composite,
        new Date(snapshot.capturedAt).getTime(),
      );
    } else {
      // freshGreeks is false only when greeksStale AND lastScore !== null, so the
      // reused score is guaranteed present (the field-based condition hides this
      // from the narrower).
      score = this.lastScore!;
    }

    // 2. Update cone (built once from this day's stored cone endpoints)
    this.cone ??= new ConeTracker(snapshot.cone ?? null);
    const cone = this.cone.update(snapshot.spot, snapshot.capturedAt);

    // 3. Update trade metrics (unrealized PnL, HWM)
    this.state = updateTradeMetrics(this.state, snapshot.spot, config);

    // 4. Generate signal
    const signal = this.generateSignal(score, cone, snapshot);

    // 5. Execute signal (update trade state)
    this.executeSignal(signal, snapshot);

    // 6. Remember for next iteration
    this.previousSnapshot = snapshot;

    return signal;
  }

  /** Get all completed trades for this day. */
  getTrades(): TradeRecord[] {
    return this.trades;
  }

  /** Get current trade state. */
  getState(): TradeState {
    return { ...this.state };
  }

  /** Get accumulated score history. */
  getScoreHistory(): ScoreComponents[] {
    return [...this.scoreHistory];
  }

  /** Slots this generator skipped for incomplete data (TODO #6). */
  getDataGaps(): DataGap[] {
    return [...this.dataGaps];
  }

  /**
   * How the day's rate-of-change baselines started: `frames` pre-market frames
   * folded in (0 = cold start, so dGamma/dPositions read 0 until the first
   * scored slot), and whether the baselines are usable at all yet.
   */
  getWarmup(): { frames: number; initialized: boolean } {
    return { frames: this.warmupFrames, initialized: this.momentum.initialized };
  }

  private generateSignal(
    score: ScoreComponents,
    cone: ConeInfo,
    snapshot: Snapshot,
  ): Signal {
    const { config } = this;

    // Time gates
    const timeGates = checkTimeGates(snapshot.capturedAt, config);

    // Force exit if past deadline
    if (timeGates.forceExit && this.state.position !== 'flat') {
      return this.makeSignal('exit', score, cone, snapshot, 'high', 'forced exit: past time deadline');
    }

    // If we have a position, check exits first
    if (this.state.position !== 'flat') {
      return this.checkExits(score, cone, snapshot);
    }

    // If flat, check entries (unless blocked)
    if (timeGates.blockNewEntries) {
      return this.makeSignal('hold', score, cone, snapshot, 'low', 'no new entries: past time cutoff');
    }

    const dailyLimits = checkDailyLimits(this.state, config);
    if (dailyLimits.blocked) {
      return this.makeSignal('hold', score, cone, snapshot, 'low', `daily limit: ${dailyLimits.reason}`);
    }

    // GEX-derived TP gate: skip entries when the gamma-center distance < 15 pts.
    // The TP is the distance from spot to the gamma center of mass
    // (Σ(|gamma|·strike)/Σ(|gamma|)); falls back to stopLossPoints ×
    // riskRewardRatio when the snapshot carries no gamma in the window.
    if (!meetsGexMinTakeProfit(config, snapshot)) {
      const tp = gexTakeProfitPoints(config, snapshot);
      return this.makeSignal('hold', score, cone, snapshot, 'low',
        `GEX TP ${tp.toFixed(1)} pts < ${config.risk.minGexTakeProfitPoints} pt minimum — gamma center too close`);
    }

    return this.checkEntries(score, cone, snapshot);
  }

  /**
   * Advance the entry-signal EWMA to the current fresh Greek bar and return the
   * smoothed composite the entry gate reads ({@link AlgoConfig.entrySignalHalfLifeMin}).
   *
   * `s ← ρ·s + (1−ρ)·composite` with `ρ = 0.5^(Δt / halfLife)` derived from the
   * REAL minutes since the last fresh bar, so the half-life is the same wall-clock
   * memory at any feed cadence. The current composite always enters at full weight
   * (1−ρ) — the largest single weight — and older bars decay geometrically, which
   * damps a one-bar spike while letting a persisting signal through. With smoothing
   * off (`halfLife ≤ 0`) or on the first bar of the day there is no history to
   * blend, so the gate is the raw composite.
   */
  private updateEntrySignal(composite: number, currentMs: number): number {
    const halfLife = this.config.entrySignalHalfLifeMin;
    if (!Number.isFinite(halfLife) || halfLife <= 0 || this.entrySignalLastMs === null) {
      this.entrySignalLastMs = currentMs;
      return composite;
    }
    const dtMin = Math.min(
      MAX_ENTRY_SIGNAL_DT_MIN,
      Math.max(MIN_ENTRY_SIGNAL_DT_MIN, (currentMs - this.entrySignalLastMs) / 60_000),
    );
    const rho = Math.pow(0.5, dtMin / halfLife); // weight retained by history
    this.entrySignalLastMs = currentMs;
    return rho * this.entrySignalComposite + (1 - rho) * composite;
  }

  private checkExits(
    score: ScoreComponents,
    cone: ConeInfo,
    snapshot: Snapshot,
  ): Signal {
    const { config } = this;

    // Cone-breakout mode (TODO #8) uses its own exit set (the three toggles).
    if (config.coneBreakout.enabled) {
      return this.checkBreakoutExits(score, cone, snapshot);
    }

    const isLong = this.state.position === 'long';
    const directionalScore = isLong ? score.composite : -score.composite;

    // Stop-loss check (distance time-decayed per risk.stopLossDecayPerHour)
    const stopCheck = checkStopLoss(this.state, snapshot.spot, config, snapshot.capturedAt);
    if (stopCheck.stopped) {
      return this.makeSignal('exit', score, cone, snapshot, 'high', `stop-loss: ${stopCheck.reason}`);
    }

    // Take-profit check: GEX-relative target (gamma-center distance frozen at
    // entry, then decayed toward entry per risk.takeProfitDecayPerHour).
    const tpCheck = checkTakeProfit(this.state, snapshot.spot, config, snapshot.capturedAt);
    if (tpCheck.hit) {
      return this.makeSignal('exit', score, cone, snapshot, 'high', `take-profit: ${tpCheck.reason}`);
    }

    // Cone breach exit, evaluated on the 5-min candle close (the ConeTracker
    // only transitions on ET-aligned closes, so this fires off the confirmed
    // close, not an intra-candle wick). Rank the band low→high as
    // below(-1) < inside(0) < above(+1); a SHORT exits when the confirmed close
    // moves the state UP (against the short), a LONG when it moves DOWN. This
    // covers BOTH a breakout that closed back inside its line (e.g. a below-cone
    // short closing back above the lower line → below→inside) AND a position
    // opened INSIDE the cone that then broke out the far line against it (e.g. a
    // short closing above the upper line → inside→above). Only fires on a real
    // close transition (state === previousState on the held intra-candle ticks).
    // Structural — fires regardless of gexAutoExit.
    if (cone.previousState !== null && cone.state !== cone.previousState) {
      const movedUp = coneRank(cone.state) > coneRank(cone.previousState);
      const adverse = isLong ? !movedUp : movedUp;
      if (adverse) {
        const line = cone.state === 'above' ? 'upper'
          : cone.state === 'below' ? 'lower'
          : cone.previousState === 'above' ? 'upper' : 'lower';
        return this.makeSignal('exit', score, cone, snapshot, 'medium',
          `cone breach (5-min close): closed ${isLong ? 'below' : 'above'} the ${line} line against the ${isLong ? 'long' : 'short'}`);
      }
    }

    // GEX-driven auto-exits (signal fade + reversal). Gated by config.gexAutoExit:
    // when disabled, the position is held through score fades/flips and only a
    // structural exit above (cone-return / stop-loss / take-profit) or the forced
    // time gate closes it.
    if (config.gexAutoExit) {
      // Signal fade: directional score dropped below the effective fade bar. The
      // bar is LOWERED for a high-conviction entry (see fadeExitBar), so a strong
      // trade must fade almost to zero before this fires — shallow pullbacks no
      // longer flush it and winners run longer. A typical entry exits at the floor.
      const fadeBar = fadeExitBar(config, this.state);
      if (directionalScore < fadeBar) {
        return this.makeSignal('exit', score, cone, snapshot, 'medium',
          `signal fade: z-factor=${score.composite.toFixed(2)} < ${fadeBar.toFixed(2)} fade bar`);
      }

      // Reversal: score flipped in opposing direction
      if (directionalScore < -config.reversalThreshold) {
        return this.makeSignal('exit', score, cone, snapshot, 'high', `reversal: z-factor=${score.composite.toFixed(2)}`);
      }
    }

    return this.makeSignal('hold', score, cone, snapshot, 'low', 'position held');
  }

  private checkEntries(
    score: ScoreComponents,
    cone: ConeInfo,
    snapshot: Snapshot,
  ): Signal {
    const { config } = this;

    // Cone-breakout mode (TODO #8) uses its own, stricter entry rule.
    if (config.coneBreakout.enabled) {
      return this.checkBreakoutEntries(score, cone, snapshot);
    }

    // ── NO 5-MIN GATE ON ENTRY. The 5-minute rule scopes the CONE, not entry
    // timing: it decides when the cone may change state and when a pass counts as
    // fresh — never how often the algo is allowed to trade. Every branch below is
    // therefore evaluated on EVERY minute of the 1-min feed.
    //
    // The two places the 5-min rule genuinely binds both enforce themselves inside
    // `ConeTracker`, so neither needs a check here:
    //   - `cone.state` is only ever recomputed at an ET-aligned 5-min close;
    //     between closes the tracker replays the last CONFIRMED candle. So a state
    //     read on any minute is already a confirmed one.
    //   - `cone.crossed` is forced to null on held ticks, so the `conePassBonus`
    //     fresh-pass discount below is confined to real crossings automatically.
    // The cone-breach EXIT is self-gating for the same reason: it triggers on
    // `cone.state !== cone.previousState`, and the tracker pins those equal on
    // held ticks, so it can only fire on a genuine close transition.
    //
    // HISTORICAL NOTE — a `!cone.atCandleClose → hold` gate lived here (first for
    // all entries, then scoped to the cone branches). Removing it lets a breakout
    // be opened deep into an already-held state rather than at the confirmation
    // that justified it, and on the 44-day 1-min staging range that measured
    // WORSE in-sample: 63 trades / −$862 / PF 0.91 against 44 / +$2,750 / PF 1.55,
    // and tightening entryThreshold did not recover it (0.7 → −$1,675). Removed
    // deliberately anyway, by decision: entry cadence should not be a side effect
    // of the cone's sampling rate. That in-sample comparison is 44–63 trades on a
    // single range — if a walk-forward run reproduces the gap, reinstate the gate
    // on the two cone branches rather than re-deriving this from scratch.

    // Entry threshold tests gate on the TIME-SMOOTHED composite (an EWMA over the
    // last few minutes, entrySignalHalfLifeMin) so a one-bar gamma spike can't open
    // a trade on its own; direction/gamma-alignment (gexZ, cone state) stays
    // instantaneous. `gate` equals the raw composite when smoothing is off. The raw
    // score is still what's frozen into the trade record (signal.score).
    const gate = this.entrySignalComposite;
    const z = gate.toFixed(2);

    // ── CONE-THRESHOLD RULE (TODO #9) ──
    // The cone state selects the entry bar: the normal `entryThreshold` OUTSIDE
    // the cone (gamma-aligned breakout only), the higher `strongEntryThreshold`
    // INSIDE it. A fresh gamma-aligned pass discounts the outside bar by
    // `conePassBonus` on that first tick. Gamma direction = sign of gexZ.
    const gz = score.gexZ.toFixed(2);

    if (cone.state === 'above') {
      // Above the cone → long only, and only when gamma also points up.
      if (score.gexZ > 0) {
        const bonus = cone.crossed === 'up' ? config.conePassBonus : 0;
        const threshold = config.entryThreshold - bonus;
        if (gate > threshold) {
          const confidence = this.assessConfidence(score, true);
          return this.makeSignal('enter_long', score, cone, snapshot, confidence,
            `long entry: above cone + gamma up (z-factor=${z}, thr=${threshold.toFixed(2)}${bonus ? ', fresh-pass bonus' : ''})`);
        }
        return this.makeSignal('hold', score, cone, snapshot, 'low',
          `above cone: z-factor below entry threshold (z-factor=${z}, thr=${threshold.toFixed(2)})`);
      }
      return this.makeSignal('hold', score, cone, snapshot, 'low',
        `above cone ignored: gamma not pointing up (gexZ=${gz})`);
    }

    if (cone.state === 'below') {
      // Below the cone → short only, and only when gamma also points down.
      if (score.gexZ < 0) {
        const bonus = cone.crossed === 'down' ? config.conePassBonus : 0;
        const threshold = config.entryThreshold - bonus;
        if (gate < -threshold) {
          const confidence = this.assessConfidence(score, true);
          return this.makeSignal('enter_short', score, cone, snapshot, confidence,
            `short entry: below cone + gamma down (z-factor=${z}, thr=${threshold.toFixed(2)}${bonus ? ', fresh-pass bonus' : ''})`);
        }
        return this.makeSignal('hold', score, cone, snapshot, 'low',
          `below cone: z-factor above entry threshold (z-factor=${z}, thr=${threshold.toFixed(2)})`);
      }
      return this.makeSignal('hold', score, cone, snapshot, 'low',
        `below cone ignored: gamma not pointing down (gexZ=${gz})`);
    }

    // ── INSIDE THE CONE → higher bar (strongEntryThreshold), either direction ──
    if (gate > config.strongEntryThreshold) {
      const confidence = this.assessConfidence(score, false);
      return this.makeSignal('enter_long', score, cone, snapshot, confidence,
        `long entry: strong inside-cone signal (z-factor=${z})`);
    }
    if (gate < -config.strongEntryThreshold) {
      const confidence = this.assessConfidence(score, false);
      return this.makeSignal('enter_short', score, cone, snapshot, confidence,
        `short entry: strong inside-cone signal (z-factor=${z})`);
    }

    return this.makeSignal('hold', score, cone, snapshot, 'low', `no entry signal (z-factor=${z})`);
  }

  /**
   * Cone-breakout entries (TODO #8, active only when config.coneBreakout.enabled).
   *
   * Enter ONLY on a break through the direction-relevant cone line, confirmed by
   * gamma direction (gexZ sign):
   *   - LONG:  SPX broke ABOVE the upper line (cone.crossed === 'up')   + gexZ > 0
   *   - SHORT: SPX broke BELOW the lower line (cone.crossed === 'down') + gexZ < 0
   * Breaking the wrong line never triggers, and there are no inside-cone entries.
   */
  private checkBreakoutEntries(
    score: ScoreComponents,
    cone: ConeInfo,
    snapshot: Snapshot,
  ): Signal {
    const z = score.composite.toFixed(2);
    const gz = score.gexZ.toFixed(2);

    if (cone.crossed === 'up') {
      if (score.gexZ > 0) {
        const confidence = this.assessConfidence(score, true);
        return this.makeSignal('enter_long', score, cone, snapshot, confidence,
          `breakout long: SPX broke above upper cone + gamma up (gexZ=${gz}, z=${z})`);
      }
      return this.makeSignal('hold', score, cone, snapshot, 'low',
        `breakout up ignored: gamma not pointing up (gexZ=${gz})`);
    }

    if (cone.crossed === 'down') {
      if (score.gexZ < 0) {
        const confidence = this.assessConfidence(score, true);
        return this.makeSignal('enter_short', score, cone, snapshot, confidence,
          `breakout short: SPX broke below lower cone + gamma down (gexZ=${gz}, z=${z})`);
      }
      return this.makeSignal('hold', score, cone, snapshot, 'low',
        `breakout down ignored: gamma not pointing down (gexZ=${gz})`);
    }

    return this.makeSignal('hold', score, cone, snapshot, 'low',
      `no breakout (cone ${cone.state}, z=${z})`);
  }

  /**
   * Cone-breakout exits (TODO #8, active only when config.coneBreakout.enabled).
   *
   * Exit on whichever fires first among the three individually-switchable
   * conditions — cone re-entry, take-profit, stop-loss. The always-on forced
   * end-of-day time exit is handled earlier in generateSignal(); the default
   * GEX signal-fade / reversal exits do NOT apply in this mode.
   */
  private checkBreakoutExits(
    score: ScoreComponents,
    cone: ConeInfo,
    snapshot: Snapshot,
  ): Signal {
    const { config } = this;
    const cb = config.coneBreakout;

    // (c) Stop-loss
    if (cb.exitOnSl) {
      const stopCheck = checkStopLoss(this.state, snapshot.spot, config, snapshot.capturedAt);
      if (stopCheck.stopped) {
        return this.makeSignal('exit', score, cone, snapshot, 'high', `stop-loss: ${stopCheck.reason}`);
      }
    }

    // (b) Take-profit (GEX target frozen at entry, then time-decayed)
    if (cb.exitOnTp) {
      const tpCheck = checkTakeProfit(this.state, snapshot.spot, config, snapshot.capturedAt);
      if (tpCheck.hit) {
        return this.makeSignal('exit', score, cone, snapshot, 'high', `take-profit: ${tpCheck.reason}`);
      }
    }

    // (a) Cone re-entry: price crossed back inside the band through the relevant
    // line (the position was opened on that side, so 'returned' is that line).
    if (cb.exitOnConeReEntry && cone.crossed === 'returned') {
      return this.makeSignal('exit', score, cone, snapshot, 'medium',
        'cone re-entry: price back inside the band');
    }

    return this.makeSignal('hold', score, cone, snapshot, 'low', 'breakout position held');
  }

  private assessConfidence(score: ScoreComponents, coneTrigger: boolean): Confidence {
    const absZ = Math.abs(score.composite);

    // High confidence: cone breach + extreme z-score + strong dGamma
    if (coneTrigger && absZ > HIGH_CONFIDENCE_Z && Math.abs(score.dGammaZ) > HIGH_CONFIDENCE_DGAMMA_Z) {
      return 'high';
    }

    // Medium confidence: either cone breach or strong signal, but not both extreme
    if (coneTrigger || absZ > MEDIUM_CONFIDENCE_Z) {
      return 'medium';
    }

    return 'low';
  }

  private executeSignal(signal: Signal, snapshot: Snapshot): void {
    const { config } = this;

    // ES is the traded instrument and is the basis for fills/P&L (TODO #3);
    // fall back to SPX spot only when no ES bar was ingested for the slot.
    const esPrice = snapshot.es ?? snapshot.spot;

    if (signal.action === 'enter_long' || signal.action === 'enter_short') {
      const direction = signal.action === 'enter_long' ? 'long' as const : 'short' as const;
      const contracts = computePositionSize(config, signal.score.composite);

      // Freeze the GEX take-profit (gamma-center distance) on the entry
      // snapshot so the exit target doesn't drift as gamma/spot move intraday.
      this.state = recordEntry(
        this.state,
        direction,
        snapshot.spot,
        esPrice,
        snapshot.capturedAt,
        contracts,
        config.risk.slippagePerSide,
        signal.score,
        gexTakeProfitPoints(config, snapshot),
      );

      this.logger?.info(
        {
          event: 'ENTRY',
          order: direction === 'long' ? 'BUY' : 'SELL', // open
          side: direction,
          time: snapshot.capturedAt,
          fillPrice: round2(this.state.entryFill!), // ES fill (P&L basis)
          spot: round2(this.state.entryPrice!), // SPX decision price
          contracts,
          confidence: signal.confidence,
          // Each factor's weighted contribution to the composite (sums to it).
          contributions: roundContributions(factorContributions(signal.score, config)),
          reason: signal.reason,
        },
        `ENTRY ${direction.toUpperCase()} ${contracts} ES contract${contracts === 1 ? '' : 's'} @ ES ${this.state.entryFill!.toFixed(2)} — ${signal.reason}`,
      );
    } else if (signal.action === 'exit' && this.state.position !== 'flat') {
      // Capture the pre-exit state for the trade record (recordExit flattens it).
      const direction = this.state.position as 'long' | 'short';
      const entryPrice = this.state.entryPrice!;
      const entryFill = this.state.entryFill!;
      const contracts = this.state.contracts;
      // Each factor's weighted contribution to the composite, at entry and now.
      const contributionsAtEntry = roundContributions(
        factorContributions(this.state.entryScore!, config),
      );
      const contributionsAtExit = roundContributions(factorContributions(signal.score, config));
      // GEX take-profit distance frozen at entry (recordExit clears it).
      const gexTpPoints = this.state.gexTpPoints ?? 0;

      const { newState, realizedPnl, exitFill } = recordExit(
        this.state,
        esPrice,
        config.risk.slippagePerSide,
        config.risk.pointValue,
      );

      // Stop/target levels (SPX) implied by the entry fill — for the trade log.
      const dir = direction === 'long' ? 1 : -1;
      const stopPrice = entryPrice - dir * config.risk.stopLossPoints;
      const targetPrice = entryPrice + dir * gexTpPoints;

      // Record completed trade
      this.trades.push({
        direction,
        entryTime: this.state.entryTime!,
        entryPrice,
        exitTime: snapshot.capturedAt,
        exitPrice: snapshot.spot,
        entryFill,
        exitFill,
        contracts,
        stopPrice,
        targetPrice,
        pnl: realizedPnl,
        // Composite z-factor at entry (frozen entry score) and at this exit.
        zAtEntry: this.state.entryScore!.composite,
        zAtExit: signal.score.composite,
        contributionsAtEntry,
        contributionsAtExit,
        reason: signal.reason,
      });

      this.logger?.info(
        {
          event: 'EXIT',
          order: direction === 'long' ? 'SELL' : 'BUY', // close
          side: direction,
          time: snapshot.capturedAt,
          entryFill: round2(entryFill), // ES (P&L basis)
          exitFill: round2(exitFill), // ES (P&L basis)
          spot: round2(snapshot.spot), // SPX decision price
          contracts,
          pnl: round2(realizedPnl),
          contributionsAtEntry,
          contributionsAtExit,
          reason: signal.reason,
        },
        `EXIT  ${direction.toUpperCase()} ${contracts} ES contract${contracts === 1 ? '' : 's'} @ ES ${exitFill.toFixed(2)} pnl=$${realizedPnl.toFixed(2)} — ${signal.reason}`,
      );

      this.state = newState;
    }
  }

  private makeSignal(
    action: Signal['action'],
    score: ScoreComponents,
    cone: ConeInfo,
    snapshot: Snapshot,
    confidence: Confidence,
    reason: string,
  ): Signal {
    return {
      action,
      direction:
        action === 'enter_long' ? 'long'
        : action === 'enter_short' ? 'short'
        : undefined,
      score,
      cone,
      confidence,
      reason,
      timestamp: snapshot.capturedAt,
    };
  }
}

/**
 * Placeholder score/cone for a `hold` returned on an incomplete slot (TODO #6).
 * The slot is never scored (no data), so these are all-zero / neutral and are
 * NOT pushed into the z-score history — they exist only to shape the returned
 * Signal. Callers that skipped a decision must not read these as a real reading.
 */
const EMPTY_SCORE: ScoreComponents = {
  at: 0, // never enters scoreHistory (data-gap slots are skipped), so the instant is unused
  gexRaw: 0, gexZ: 0,
  dGammaRaw: 0, dGammaZ: 0,
  positionsRaw: 0, positionsZ: 0,
  dPositionsRaw: 0, dPositionsZ: 0,
  composite: 0,
  gexGross: 0, dGammaGross: 0, positionsGross: 0, dPositionsGross: 0,
};

const NEUTRAL_CONE: ConeInfo = {
  upper: NaN,
  lower: NaN,
  state: 'inside',
  previousState: null,
  crossed: null,
  atCandleClose: false,
};

/** Δt clamp (minutes) for the entry-signal EWMA decay: floor a zero/negative gap
 *  so ρ stays finite; cap a large gap so a long hole in the feed makes ρ→0 (the
 *  smoother reseeds to the current level) rather than underflowing. Mirrors the
 *  momentum baseline clamps in score-engine.ts. */
const MIN_ENTRY_SIGNAL_DT_MIN = 0.05;
const MAX_ENTRY_SIGNAL_DT_MIN = 120;

/** Round to 2 decimals for tidy log fields. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Order the cone band low→high so an adverse move can be read as a sign change:
 *  below(-1) < inside(0) < above(+1). Used by the cone-breach exit. */
function coneRank(state: ConeState): number {
  return state === 'above' ? 1 : state === 'below' ? -1 : 0;
}

/** Round each factor contribution to 2 decimals for tidy log/trade-record fields. */
function roundContributions(c: FactorContributions): FactorContributions {
  return {
    gex: round2(c.gex),
    dGamma: round2(c.dGamma),
    positions: round2(c.positions),
    dPositions: round2(c.dPositions),
  };
}
