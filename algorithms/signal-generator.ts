/**
 * Signal generator: combines score engine + cone tracker + risk manager
 * into actionable entry/exit signals.
 *
 * Entry logic (user requirements):
 *   The cone is treated as support/resistance, NOT a magnet. A breakout
 *   through a band is a continuation signal — trade in the breakout direction.
 *   Every cone-line pass is a trade trigger, but ONLY when it agrees with the
 *   Greek/momentum direction (conviction floor = entryThreshold). A pass up
 *   with bearish Greeks (or a pass down with bullish Greeks) is a mismatch and
 *   is rejected.
 *   - LONG:  cone pass UP   + composite > +entryThreshold AND dGamma rising
 *            (or, with no pass, a strong inside signal: composite > strongEntryThreshold)
 *   - SHORT: cone pass DOWN + composite < -entryThreshold AND dGamma falling
 *            (or, with no pass, a strong inside signal: composite < -strongEntryThreshold)
 *
 * Exit logic:
 *   - Signal fade: composite drops below ±0.5
 *   - Cone returned: price falls back inside the cone after a breakout (failed breakout)
 *   - Reversal: composite flips past ±1.0 in opposing direction
 *   - Stop-loss: hard or trailing stop hit
 *   - Time gate: forced exit before 0DTE decay chaos (15:50 ET)
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
  gexTakeProfitPoints,
  meetsGexMinTakeProfit,
  recordEntry,
  recordExit,
  updateTradeMetrics,
} from './risk-manager.js';
import { computeScore, factorContributions } from './score-engine.js';
import type {
  AlgoConfig,
  ConeInfo,
  Confidence,
  FactorContributions,
  ScoreComponents,
  Signal,
  Snapshot,
  TradeRecord,
  TradeState,
} from './types.js';

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
  /** Last snapshot of any kind — for the chronological look-ahead guard. */
  private previousSnapshot: Snapshot | null = null;
  /** Last snapshot carrying fresh Greeks — the dGamma/dPositions baseline. */
  private previousGreekSnapshot: Snapshot | null = null;
  /** Most recent Greek score, reused on intermediate price ticks. */
  private lastScore: ScoreComponents | null = null;
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
   * Called once per decision — every 5 minutes — in chronological order. Real
   * Greek snapshots arrive every 10 minutes; the data-loader inserts an
   * intermediate price tick (`greeksStale`) at each 5-minute mark so entry/exit
   * is re-decided on the current stock price twice as often. On a price tick the
   * Greeks are unchanged, so the latest Greek score is reused (and the z-score
   * history is not advanced) while the cone/stop/target/entry checks below all
   * run against the tick's current spot.
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
    if (!snapshot.greeksStale || this.lastScore === null) {
      score = computeScore(snapshot, this.previousGreekSnapshot, this.scoreHistory, config);
      this.scoreHistory.push(score);
      this.previousGreekSnapshot = snapshot;
      this.lastScore = score;
    } else {
      score = this.lastScore;
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

    // Stop-loss check
    const stopCheck = checkStopLoss(this.state, snapshot.spot, config);
    if (stopCheck.stopped) {
      return this.makeSignal('exit', score, cone, snapshot, 'high', `stop-loss: ${stopCheck.reason}`);
    }

    // Take-profit check: GEX-relative target (gamma-center distance frozen at entry)
    const tpCheck = checkTakeProfit(this.state, snapshot.spot);
    if (tpCheck.hit) {
      return this.makeSignal('exit', score, cone, snapshot, 'high', `take-profit: ${tpCheck.reason}`);
    }

    // Cone returned: price fell back inside the band — breakout failed
    if (cone.crossed === 'returned') {
      return this.makeSignal('exit', score, cone, snapshot, 'medium', 'cone returned: failed breakout, price back inside band');
    }

    // GEX-driven auto-exits (signal fade + reversal). Gated by config.gexAutoExit:
    // when disabled, the position is held through score fades/flips and only a
    // structural exit above (cone-return / stop-loss / take-profit) or the forced
    // time gate closes it.
    if (config.gexAutoExit) {
      // Signal fade: directional score dropped below exit threshold
      if (directionalScore < config.exitFadeThreshold) {
        return this.makeSignal('exit', score, cone, snapshot, 'medium', `signal fade: z-factor=${score.composite.toFixed(2)}`);
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
    const z = score.composite.toFixed(2);

    // Cone-breakout mode (TODO #8) uses its own, stricter entry rule.
    if (config.coneBreakout.enabled) {
      return this.checkBreakoutEntries(score, cone, snapshot);
    }

    // ── CONE-PASS ENTRIES ──
    // Every cone-line pass is a trigger, but only when the composite conviction
    // clears entryThreshold in the same direction as the pass. (The sign of
    // dGammaZ is no longer a gate — TODO #10 — it still feeds the composite.)
    if (cone.crossed === 'up') {
      if (score.composite > config.entryThreshold) {
        const confidence = this.assessConfidence(score, true);
        return this.makeSignal('enter_long', score, cone, snapshot, confidence,
          `long entry: cone pass up + bullish Greeks (z-factor=${z})`);
      }
      return this.makeSignal('hold', score, cone, snapshot, 'low',
        `cone pass up ignored: z-factor below entry threshold (z-factor=${z})`);
    }

    if (cone.crossed === 'down') {
      if (score.composite < -config.entryThreshold) {
        const confidence = this.assessConfidence(score, true);
        return this.makeSignal('enter_short', score, cone, snapshot, confidence,
          `short entry: cone pass down + bearish Greeks (z-factor=${z})`);
      }
      return this.makeSignal('hold', score, cone, snapshot, 'low',
        `cone pass down ignored: z-factor above entry threshold (z-factor=${z})`);
    }

    // ── STRONG INSIDE-CONE ENTRIES (no pass) ──
    if (cone.state === 'inside') {
      if (score.composite > config.strongEntryThreshold) {
        const confidence = this.assessConfidence(score, false);
        return this.makeSignal('enter_long', score, cone, snapshot, confidence,
          `long entry: strong inside-cone signal (z-factor=${z})`);
      }
      if (score.composite < -config.strongEntryThreshold) {
        const confidence = this.assessConfidence(score, false);
        return this.makeSignal('enter_short', score, cone, snapshot, confidence,
          `short entry: strong inside-cone signal (z-factor=${z})`);
      }
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
      const stopCheck = checkStopLoss(this.state, snapshot.spot, config);
      if (stopCheck.stopped) {
        return this.makeSignal('exit', score, cone, snapshot, 'high', `stop-loss: ${stopCheck.reason}`);
      }
    }

    // (b) Take-profit (GEX-relative target frozen at entry)
    if (cb.exitOnTp) {
      const tpCheck = checkTakeProfit(this.state, snapshot.spot);
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
    if (coneTrigger && absZ > 2.5 && Math.abs(score.dGammaZ) > 1.0) {
      return 'high';
    }

    // Medium confidence: either cone breach or strong signal, but not both extreme
    if (coneTrigger || absZ > 2.0) {
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
  gexRaw: 0, gexZ: 0,
  dGammaRaw: 0, dGammaZ: 0,
  positionsRaw: 0, positionsZ: 0,
  dPositionsRaw: 0, dPositionsZ: 0,
  composite: 0,
};

const NEUTRAL_CONE: ConeInfo = {
  upper: NaN,
  lower: NaN,
  state: 'inside',
  previousState: null,
  crossed: null,
};

/** Round to 2 decimals for tidy log fields. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
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
