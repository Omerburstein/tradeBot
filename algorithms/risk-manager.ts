/**
 * Risk manager: position sizing, stop-loss logic, trailing stops,
 * daily limits, and time-based exit gates.
 */

import type { AlgoConfig, Direction, Snapshot, StrikeData, TradeState } from './types.js';

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
 * Gamma center of mass: the |gamma|-weighted average strike,
 * Σ(|gamma|·strike) / Σ(|gamma|).
 *
 * Strikes are weighted by ABSOLUTE gamma (consistent with the score engine,
 * which treats gamma as a magnitude) so opposite-sign gamma can't cancel the
 * denominator toward zero and fling the average far from spot. Only strikes
 * inside the ±strikeWindow band around spot are counted. Returns null when
 * there is no gamma in the window.
 */
export function gammaCenterStrike(
  strikes: StrikeData[],
  spot: number,
  strikeWindow: number,
): number | null {
  let weightedSum = 0;
  let weightSum = 0;
  for (const s of strikes) {
    if (Math.abs(s.strike - spot) > strikeWindow) continue;
    const w = Math.abs(s.gamma);
    weightedSum += w * s.strike;
    weightSum += w;
  }
  if (weightSum <= 0) return null;
  return weightedSum / weightSum;
}

/**
 * GEX take-profit target in SPX points: the distance from the snapshot's spot
 * to its gamma center of mass (Σ(|gamma|·strike)/Σ(|gamma|)). Price is expected
 * to gravitate toward the gamma center, so that distance is the profit target.
 * Falls back to the fixed stopLossPoints × riskRewardRatio target when the
 * snapshot carries no gamma in the window.
 *
 * Evaluated on the ENTRY snapshot and frozen into TradeState.gexTpPoints; the
 * exit check reads the stored value so the target doesn't drift as gamma/spot
 * move intraday. Single source of truth for both the entry gate and the stored
 * exit target.
 */
export function gexTakeProfitPoints(config: AlgoConfig, snapshot: Snapshot): number {
  const center = gammaCenterStrike(snapshot.strikes, snapshot.spot, config.strikeWindow);
  if (center != null) {
    return Math.abs(center - snapshot.spot);
  }
  return config.risk.stopLossPoints * config.risk.riskRewardRatio;
}

/**
 * Whether the GEX-implied take-profit clears the configured minimum.
 * When the gamma-center distance falls below `minGexTakeProfitPoints` the trade
 * is skipped — the expected move is too small to justify entry costs.
 */
export function meetsGexMinTakeProfit(config: AlgoConfig, snapshot: Snapshot): boolean {
  return gexTakeProfitPoints(config, snapshot) >= config.risk.minGexTakeProfitPoints;
}

/**
 * Check whether the GEX-relative profit target has been reached.
 *
 * The target distance was frozen at entry (TradeState.gexTpPoints = distance
 * from the entry spot to that snapshot's gamma center of mass). Slippage is not
 * applied here — it is accounted for at the actual exit fill in recordExit.
 */
export function checkTakeProfit(
  state: TradeState,
  currentSpot: number,
): { hit: boolean; reason: string } {
  if (state.position === 'flat' || state.entryPrice === null || state.gexTpPoints === null) {
    return { hit: false, reason: '' };
  }

  const direction = state.position === 'long' ? 1 : -1;
  const pnlPoints = (currentSpot - state.entryPrice) * direction;
  const targetPoints = state.gexTpPoints;

  if (pnlPoints >= targetPoints) {
    return {
      hit: true,
      reason: `+${pnlPoints.toFixed(1)} pts ≥ ${targetPoints.toFixed(1)} GEX target`,
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
    entryFill: null,
    entryTime: null,
    entryComposite: null,
    contracts: 0,
    unrealizedPnl: 0,
    dailyPnl: 0,
    dailyTradeCount: 0,
    highWaterMark: 0,
    gexTpPoints: null,
  };
}

/**
 * Record an entry: updates trade state to reflect a new position.
 *
 * Two fill prices are tracked: `spotPrice` (SPX) drives stop/target/HWM
 * decisions, while `esPrice` (the traded future) is the basis for realized P&L
 * (TODO #3). Slippage is applied to each in its own units.
 */
export function recordEntry(
  state: TradeState,
  direction: Direction,
  spotPrice: number,
  esPrice: number,
  entryTime: string,
  contracts: number,
  slippagePerSide: number,
  entryComposite: number,
  gexTpPoints: number,
): TradeState {
  // Apply slippage: long entry at higher price, short at lower
  const slip = direction === 'long' ? slippagePerSide : -slippagePerSide;

  return {
    ...state,
    position: direction,
    entryPrice: spotPrice + slip,
    entryFill: esPrice + slip,
    entryTime,
    entryComposite,
    contracts,
    unrealizedPnl: 0,
    highWaterMark: 0,
    gexTpPoints,
  };
}

/**
 * Record an exit: closes position and updates daily PnL/trade count.
 *
 * Realized P&L is measured off the ES series (TODO #3): the slipped ES exit
 * fill minus the slipped ES entry fill (`state.entryFill`). `esExitPrice` is the
 * raw ES price at the exit slot; the returned `exitFill` is that price after
 * slippage, so callers can record the exact level the P&L was derived from.
 */
export function recordExit(
  state: TradeState,
  esExitPrice: number,
  slippagePerSide: number,
  pointValue: number,
): { newState: TradeState; realizedPnl: number; exitFill: number } {
  if (state.position === 'flat' || state.entryFill === null) {
    return { newState: state, realizedPnl: 0, exitFill: esExitPrice };
  }

  const direction = state.position === 'long' ? 1 : -1;

  // Apply slippage: long exit at lower price, short exit at higher
  const exitFill =
    state.position === 'long'
      ? esExitPrice - slippagePerSide
      : esExitPrice + slippagePerSide;

  const pnlPoints = (exitFill - state.entryFill) * direction;
  const realizedPnl = pnlPoints * pointValue * state.contracts;

  const newState: TradeState = {
    position: 'flat',
    entryPrice: null,
    entryFill: null,
    entryTime: null,
    entryComposite: null,
    contracts: 0,
    unrealizedPnl: 0,
    dailyPnl: state.dailyPnl + realizedPnl,
    dailyTradeCount: state.dailyTradeCount + 1,
    highWaterMark: 0,
    gexTpPoints: null,
  };

  return { newState, realizedPnl, exitFill };
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
