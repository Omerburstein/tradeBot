/**
 * Signal generator: combines score engine + cone tracker + risk manager
 * into actionable entry/exit signals.
 *
 * Entry logic (user requirements):
 *   - LONG: composite > +1.5 AND dGamma rising AND (cone crossed down OR strong inside signal)
 *   - SHORT: composite < -1.5 AND dGamma falling AND (cone crossed up OR strong inside signal)
 *
 * Exit logic:
 *   - Signal fade: composite drops below ±0.5
 *   - Cone returned: price re-enters cone after breach (mean-reversion played out)
 *   - Reversal: composite flips past ±1.0 in opposing direction
 *   - Stop-loss: hard or trailing stop hit
 *   - Time gate: forced exit before 0DTE decay chaos (14:50 CT)
 */

import { ConeTracker } from './cone.js';
import {
  checkDailyLimits,
  checkStopLoss,
  checkTimeGates,
  computePositionSize,
  createFlatState,
  recordEntry,
  recordExit,
  updateTradeMetrics,
} from './risk-manager.js';
import { computeScore } from './score-engine.js';
import type {
  AlgoConfig,
  ConeInfo,
  Confidence,
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
  private cone: ConeTracker;
  private state: TradeState;
  private scoreHistory: ScoreComponents[] = [];
  private previousSnapshot: Snapshot | null = null;
  private trades: TradeRecord[] = [];

  constructor(config: AlgoConfig) {
    this.config = config;
    this.cone = new ConeTracker(config);
    this.state = createFlatState();
  }

  /**
   * Process a new snapshot and return a signal.
   *
   * Call this once per 10-minute snapshot, in chronological order.
   */
  processSnapshot(snapshot: Snapshot): Signal {
    const { config } = this;

    // 1. Compute score
    const score = computeScore(
      snapshot,
      this.previousSnapshot,
      this.scoreHistory,
      config,
    );
    this.scoreHistory.push(score);

    // 2. Update cone
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

    return this.checkEntries(score, cone, snapshot);
  }

  private checkExits(
    score: ScoreComponents,
    cone: ConeInfo,
    snapshot: Snapshot,
  ): Signal {
    const { config } = this;
    const isLong = this.state.position === 'long';
    const directionalScore = isLong ? score.composite : -score.composite;
    const directionalDGamma = isLong ? score.dGammaZ : -score.dGammaZ;

    // Stop-loss check
    const stopCheck = checkStopLoss(this.state, snapshot.spot, config);
    if (stopCheck.stopped) {
      return this.makeSignal('exit', score, cone, snapshot, 'high', `stop-loss: ${stopCheck.reason}`);
    }

    // Cone returned: mean-reversion played out
    if (cone.crossed === 'returned') {
      return this.makeSignal('exit', score, cone, snapshot, 'medium', 'cone returned: mean-reversion target reached');
    }

    // Signal fade: directional score dropped below exit threshold
    if (directionalScore < config.exitFadeThreshold) {
      return this.makeSignal('exit', score, cone, snapshot, 'medium', `signal fade: composite=${score.composite.toFixed(2)}`);
    }

    // Reversal: score flipped in opposing direction
    if (directionalScore < -config.reversalThreshold) {
      return this.makeSignal('exit', score, cone, snapshot, 'high', `reversal: composite=${score.composite.toFixed(2)}`);
    }

    return this.makeSignal('hold', score, cone, snapshot, 'low', 'position held');
  }

  private checkEntries(
    score: ScoreComponents,
    cone: ConeInfo,
    snapshot: Snapshot,
  ): Signal {
    const { config } = this;

    // ── LONG ENTRY ──
    // Cone crossed down + bullish signal (mean-reversion long)
    // OR inside cone with very strong bullish signal
    const longConeTrigger = cone.crossed === 'down';
    const longStrongInside = cone.state === 'inside' && score.composite > config.strongEntryThreshold;

    if (
      score.composite > config.entryThreshold &&
      score.dGammaZ > 0 &&
      (longConeTrigger || longStrongInside)
    ) {
      const confidence = this.assessConfidence(score, longConeTrigger);
      const reason = longConeTrigger
        ? `long entry: cone breach down + bullish gamma (z=${score.composite.toFixed(2)})`
        : `long entry: strong inside-cone signal (z=${score.composite.toFixed(2)})`;
      return this.makeSignal('enter_long', score, cone, snapshot, confidence, reason);
    }

    // ── SHORT ENTRY ──
    const shortConeTrigger = cone.crossed === 'up';
    const shortStrongInside = cone.state === 'inside' && score.composite < -config.strongEntryThreshold;

    if (
      score.composite < -config.entryThreshold &&
      score.dGammaZ < 0 &&
      (shortConeTrigger || shortStrongInside)
    ) {
      const confidence = this.assessConfidence(score, shortConeTrigger);
      const reason = shortConeTrigger
        ? `short entry: cone breach up + bearish gamma (z=${score.composite.toFixed(2)})`
        : `short entry: strong inside-cone signal (z=${score.composite.toFixed(2)})`;
      return this.makeSignal('enter_short', score, cone, snapshot, confidence, reason);
    }

    return this.makeSignal('hold', score, cone, snapshot, 'low', `no entry signal (z=${score.composite.toFixed(2)})`);
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

    if (signal.action === 'enter_long' || signal.action === 'enter_short') {
      const direction = signal.action === 'enter_long' ? 'long' as const : 'short' as const;
      const contracts = computePositionSize(config, signal.score.composite);

      this.state = recordEntry(
        this.state,
        direction,
        snapshot.spot,
        snapshot.capturedAt,
        contracts,
        config.risk.slippagePerSide,
      );
    } else if (signal.action === 'exit' && this.state.position !== 'flat') {
      const { newState, realizedPnl } = recordExit(
        this.state,
        snapshot.spot,
        config.risk.slippagePerSide,
        config.risk.pointValue,
      );

      // Record completed trade
      this.trades.push({
        direction: this.state.position as 'long' | 'short',
        entryTime: this.state.entryTime!,
        entryPrice: this.state.entryPrice!,
        exitTime: snapshot.capturedAt,
        exitPrice: snapshot.spot,
        contracts: this.state.contracts,
        pnl: realizedPnl,
        reason: signal.reason,
      });

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
