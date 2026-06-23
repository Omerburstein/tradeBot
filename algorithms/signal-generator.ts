/**
 * Signal generator: combines score engine + cone tracker + risk manager
 * into actionable entry/exit signals.
 *
 * Entry logic (user requirements):
 *   The cone is treated as support/resistance, NOT a magnet. A breakout
 *   through a band is a continuation signal — trade in the breakout direction.
 *   - LONG:  composite > +1.5 AND dGamma rising  AND (broke UP through resistance OR strong inside signal)
 *   - SHORT: composite < -1.5 AND dGamma falling AND (broke DOWN through support  OR strong inside signal)
 *
 * Exit logic:
 *   - Signal fade: composite drops below ±0.5
 *   - Cone returned: price falls back inside the cone after a breakout (failed breakout)
 *   - Reversal: composite flips past ±1.0 in opposing direction
 *   - Stop-loss: hard or trailing stop hit
 *   - Time gate: forced exit before 0DTE decay chaos (14:50 CT)
 */

import type pino from 'pino';
import { ConeTracker } from './cone.js';
import {
  checkDailyLimits,
  checkStopLoss,
  checkTakeProfit,
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
  private logger?: pino.Logger;

  /**
   * @param config  Algorithm configuration.
   * @param logger  Optional pino logger; when provided, every entry/exit
   *                action is logged at info level. Omit to run silently
   *                (e.g. inside the tuner's inner loop).
   */
  constructor(config: AlgoConfig, logger?: pino.Logger) {
    this.config = config;
    this.cone = new ConeTracker(config);
    this.state = createFlatState();
    this.logger = logger;
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

    // Take-profit check: fixed target enforcing the configured risk:reward
    const tpCheck = checkTakeProfit(this.state, snapshot.spot, config);
    if (tpCheck.hit) {
      return this.makeSignal('exit', score, cone, snapshot, 'high', `take-profit: ${tpCheck.reason}`);
    }

    // Cone returned: price fell back inside the band — breakout failed
    if (cone.crossed === 'returned') {
      return this.makeSignal('exit', score, cone, snapshot, 'medium', 'cone returned: failed breakout, price back inside band');
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
    // Price broke UP through resistance (continuation long)
    // OR inside cone with very strong bullish signal
    const longConeTrigger = cone.crossed === 'up';
    const longStrongInside = cone.state === 'inside' && score.composite > config.strongEntryThreshold;

    if (
      score.composite > config.entryThreshold &&
      score.dGammaZ > 0 &&
      (longConeTrigger || longStrongInside)
    ) {
      const confidence = this.assessConfidence(score, longConeTrigger);
      const reason = longConeTrigger
        ? `long entry: cone breakout up + bullish gamma (z=${score.composite.toFixed(2)})`
        : `long entry: strong inside-cone signal (z=${score.composite.toFixed(2)})`;
      return this.makeSignal('enter_long', score, cone, snapshot, confidence, reason);
    }

    // ── SHORT ENTRY ──
    // Price broke DOWN through support (continuation short)
    const shortConeTrigger = cone.crossed === 'down';
    const shortStrongInside = cone.state === 'inside' && score.composite < -config.strongEntryThreshold;

    if (
      score.composite < -config.entryThreshold &&
      score.dGammaZ < 0 &&
      (shortConeTrigger || shortStrongInside)
    ) {
      const confidence = this.assessConfidence(score, shortConeTrigger);
      const reason = shortConeTrigger
        ? `short entry: cone breakout down + bearish gamma (z=${score.composite.toFixed(2)})`
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

      this.logger?.info(
        {
          event: 'ENTRY',
          order: direction === 'long' ? 'BUY' : 'SELL', // open
          side: direction,
          time: snapshot.capturedAt,
          fillPrice: round2(this.state.entryPrice!),
          contracts,
          confidence: signal.confidence,
          composite: round2(signal.score.composite),
          reason: signal.reason,
        },
        `ENTRY ${direction.toUpperCase()} ${contracts}x @ ${this.state.entryPrice!.toFixed(2)} — ${signal.reason}`,
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

      this.logger?.info(
        {
          event: 'EXIT',
          order: this.state.position === 'long' ? 'SELL' : 'BUY', // close
          side: this.state.position,
          time: snapshot.capturedAt,
          entryPrice: round2(this.state.entryPrice!),
          exitPrice: round2(snapshot.spot),
          contracts: this.state.contracts,
          pnl: round2(realizedPnl),
          reason: signal.reason,
        },
        `EXIT  ${(this.state.position as string).toUpperCase()} ${this.state.contracts}x @ ${snapshot.spot.toFixed(2)} pnl=$${realizedPnl.toFixed(2)} — ${signal.reason}`,
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

/** Round to 2 decimals for tidy log fields. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
