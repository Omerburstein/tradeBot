/**
 * Risk manager: position sizing, stop-loss logic, trailing stops,
 * daily limits, and time-based exit gates.
 */

import type { AlgoConfig, Direction, TradeState } from './types.js';

/**
 * Compute position size in contracts based on risk parameters and
 * current signal strength.
 *
 * Uses volatility-aware sizing: stronger signals and lower VIX
 * allow larger positions, within hard limits.
 */
export function computePositionSize(
  config: AlgoConfig,
  compositeZ: number,
): number {
  const { risk } = config;

  // Base contracts: risk budget / (stop distance * point value)
  const maxLossUsd = risk.accountEquity * risk.maxRiskPerTrade;
  const riskPerContract = risk.stopLossPoints * risk.pointValue;
  const baseContracts = Math.floor(maxLossUsd / riskPerContract);

  // Signal strength scalar: full size only for very strong signals
  const absZ = Math.abs(compositeZ);
  const signalScalar = absZ >= config.strongEntryThreshold ? 1.0 : 0.5;

  const contracts = Math.max(1, Math.floor(baseContracts * signalScalar));
  return Math.min(contracts, risk.maxPositionSize);
}

/**
 * Check whether a stop-loss has been hit.
 *
 * Supports:
 *   - Hard stop: fixed distance from entry
 *   - Trailing stop: activates after profit threshold, trails behind HWM
 */
export function checkStopLoss(
  state: TradeState,
  currentSpot: number,
  config: AlgoConfig,
): { stopped: boolean; reason: string } {
  if (state.position === 'flat' || state.entryPrice === null) {
    return { stopped: false, reason: '' };
  }

  const { risk } = config;
  const direction = state.position === 'long' ? 1 : -1;
  const pnlPoints = (currentSpot - state.entryPrice) * direction;

  // Hard stop-loss
  if (pnlPoints <= -risk.stopLossPoints) {
    return { stopped: true, reason: `hard stop hit (${pnlPoints.toFixed(1)} pts)` };
  }

  // Trailing stop: only active after reaching activation threshold
  if (state.highWaterMark >= risk.trailingStopActivation) {
    const trailLevel = state.highWaterMark - risk.trailingStopDistance;
    if (pnlPoints <= trailLevel) {
      return {
        stopped: true,
        reason: `trailing stop hit (HWM=${state.highWaterMark.toFixed(1)}, trail=${trailLevel.toFixed(1)}, current=${pnlPoints.toFixed(1)} pts)`,
      };
    }
  }

  return { stopped: false, reason: '' };
}

/**
 * The fixed take-profit distance in SPX points: stopLossPoints × riskRewardRatio.
 * Single source of truth for both the exit check and the min-TP entry gate.
 */
export function takeProfitTargetPoints(config: AlgoConfig): number {
  return config.risk.stopLossPoints * config.risk.riskRewardRatio;
}

/**
 * Whether a trade's take-profit target clears the configured minimum (default
 * 10 pts). Entries below the floor are skipped — the edge is too thin to cover
 * round-trip cost/slippage. See {@link RiskParams.minTakeProfitPoints}.
 */
export function meetsMinTakeProfit(config: AlgoConfig): boolean {
  return takeProfitTargetPoints(config) >= config.risk.minTakeProfitPoints;
}

/**
 * Check whether the fixed profit target has been reached.
 *
 * The target sits at stopLossPoints × riskRewardRatio from entry, enforcing
 * the configured risk:reward (e.g. 1:3). Slippage is not applied here — it's
 * accounted for at the actual exit fill in recordExit.
 */
export function checkTakeProfit(
  state: TradeState,
  currentSpot: number,
  config: AlgoConfig,
): { hit: boolean; reason: string } {
  if (state.position === 'flat' || state.entryPrice === null) {
    return { hit: false, reason: '' };
  }

  const { risk } = config;
  const direction = state.position === 'long' ? 1 : -1;
  const pnlPoints = (currentSpot - state.entryPrice) * direction;
  const targetPoints = takeProfitTargetPoints(config);

  if (pnlPoints >= targetPoints) {
    return {
      hit: true,
      reason: `+${pnlPoints.toFixed(1)} pts ≥ ${targetPoints.toFixed(1)} target (1:${risk.riskRewardRatio} R:R)`,
    };
  }

  return { hit: false, reason: '' };
}

/**
 * Check daily risk limits: max daily loss and max trade count.
 */
export function checkDailyLimits(
  state: TradeState,
  config: AlgoConfig,
): { blocked: boolean; reason: string } {
  const { risk } = config;
  const maxDailyLossUsd = risk.accountEquity * risk.maxDailyLoss;

  if (state.dailyPnl <= -maxDailyLossUsd) {
    return {
      blocked: true,
      reason: `daily loss limit hit ($${Math.abs(state.dailyPnl).toFixed(0)} / $${maxDailyLossUsd.toFixed(0)})`,
    };
  }

  if (state.dailyTradeCount >= risk.maxTradesPerDay) {
    return {
      blocked: true,
      reason: `max daily trades reached (${state.dailyTradeCount}/${risk.maxTradesPerDay})`,
    };
  }

  return { blocked: false, reason: '' };
}

/**
 * Check time-based exit gates using CT wall-clock time.
 *
 * Returns whether we should block new entries or force-exit positions.
 */
export function checkTimeGates(
  capturedAtUtc: string,
  config: AlgoConfig,
): { blockNewEntries: boolean; forceExit: boolean } {
  const ctMinutes = getCtMinutesSinceMidnight(capturedAtUtc);
  const noEntryMinutes = parseHhmm(config.risk.noNewTradesAfterCT);
  const forceExitMinutes = parseHhmm(config.risk.forcedExitByCT);

  return {
    blockNewEntries: ctMinutes >= noEntryMinutes,
    forceExit: ctMinutes >= forceExitMinutes,
  };
}

/**
 * Update the trade state's high water mark and unrealized PnL.
 */
export function updateTradeMetrics(
  state: TradeState,
  currentSpot: number,
  config: AlgoConfig,
): TradeState {
  if (state.position === 'flat' || state.entryPrice === null) return state;

  const direction = state.position === 'long' ? 1 : -1;
  const pnlPoints = (currentSpot - state.entryPrice) * direction;
  const unrealizedPnl = pnlPoints * config.risk.pointValue * state.contracts;

  return {
    ...state,
    unrealizedPnl,
    highWaterMark: Math.max(state.highWaterMark, pnlPoints),
  };
}

/** Create a fresh flat trade state for start-of-day. */
export function createFlatState(): TradeState {
  return {
    position: 'flat',
    entryPrice: null,
    entryTime: null,
    contracts: 0,
    unrealizedPnl: 0,
    dailyPnl: 0,
    dailyTradeCount: 0,
    highWaterMark: 0,
  };
}

/**
 * Record an entry: updates trade state to reflect a new position.
 */
export function recordEntry(
  state: TradeState,
  direction: Direction,
  entryPrice: number,
  entryTime: string,
  contracts: number,
  slippagePerSide: number,
): TradeState {
  // Apply slippage: long entry at higher price, short at lower
  const slippedPrice =
    direction === 'long'
      ? entryPrice + slippagePerSide
      : entryPrice - slippagePerSide;

  return {
    ...state,
    position: direction,
    entryPrice: slippedPrice,
    entryTime,
    contracts,
    unrealizedPnl: 0,
    highWaterMark: 0,
  };
}

/**
 * Record an exit: closes position and updates daily PnL/trade count.
 */
export function recordExit(
  state: TradeState,
  exitPrice: number,
  slippagePerSide: number,
  pointValue: number,
): { newState: TradeState; realizedPnl: number } {
  if (state.position === 'flat' || state.entryPrice === null) {
    return { newState: state, realizedPnl: 0 };
  }

  const direction = state.position === 'long' ? 1 : -1;

  // Apply slippage: long exit at lower price, short exit at higher
  const slippedExit =
    state.position === 'long'
      ? exitPrice - slippagePerSide
      : exitPrice + slippagePerSide;

  const pnlPoints = (slippedExit - state.entryPrice) * direction;
  const realizedPnl = pnlPoints * pointValue * state.contracts;

  const newState: TradeState = {
    position: 'flat',
    entryPrice: null,
    entryTime: null,
    contracts: 0,
    unrealizedPnl: 0,
    dailyPnl: state.dailyPnl + realizedPnl,
    dailyTradeCount: state.dailyTradeCount + 1,
    highWaterMark: 0,
  };

  return { newState, realizedPnl };
}

// ── Helpers ──

function getCtMinutesSinceMidnight(utcIso: string): number {
  const d = new Date(utcIso);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string) =>
    Number.parseInt(parts.find((p) => p.type === t)?.value ?? '0', 10);
  return get('hour') * 60 + get('minute');
}

function parseHhmm(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((s) => Number.parseInt(s, 10));
  return h! * 60 + m!;
}
