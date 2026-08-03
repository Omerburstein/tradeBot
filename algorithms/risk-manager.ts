/**
 * Risk manager: position sizing, stop-loss logic, trailing stops,
 * daily limits, and time-based exit gates.
 */

import { etMinutesSinceMidnight } from './et-time.js';
import type {
  AlgoConfig,
  Direction,
  ScoreComponents,
  Snapshot,
  StrikeData,
  TradeState,
} from './types.js';

/** Full base size once a signal clears `strongEntryThreshold`. */
const FULL_SIZE_SCALAR = 1.0;
/** Reduced base size for a signal below `strongEntryThreshold`. */
const WEAK_SIGNAL_SIZE_SCALAR = 0.5;
/** Milliseconds per hour — decay rates are expressed per hour held. */
const MS_PER_HOUR = 3_600_000;

/**
 * Wall-clock hours the position has been open at `nowUtc`.
 *
 * A missing entry time, an unparseable instant, or an out-of-order pair (exit
 * before entry) all collapse to 0, so a clock problem can only ever mean "no
 * decay yet" — never a spuriously shrunken target that fabricates an exit.
 */
function hoursHeld(state: TradeState, nowUtc: string): number {
  if (state.entryTime === null) return 0;
  const held = (Date.parse(nowUtc) - Date.parse(state.entryTime)) / MS_PER_HOUR;
  return Number.isFinite(held) && held > 0 ? held : 0;
}

/**
 * Linear time-decay of an exit distance toward the entry price:
 *
 *   distance(t) = max(floor, initial · (1 − perHour · hours))
 *
 * `perHour ≤ 0` (or non-finite) returns `initial` unchanged — the fixed-distance
 * behaviour that predates decay. The floor is clamped to at most `initial` so a
 * floor set above the starting distance can never WIDEN the exit: decay only
 * ever tightens. The result is also held at ≥ 0 (a decay rate past 1/hour would
 * otherwise drive the distance negative and exit on any price at all).
 */
function decayDistance(
  initial: number,
  perHour: number,
  floorPoints: number,
  hours: number,
): number {
  if (!Number.isFinite(perHour) || perHour <= 0) return initial;
  const floor = Number.isFinite(floorPoints) ? Math.max(0, floorPoints) : 0;
  const decayed = initial * (1 - perHour * hours);
  return Math.max(Math.min(initial, floor), decayed);
}

/**
 * The take-profit distance (SPX pts) in force right now: the entry-frozen GEX
 * target after time-decay. `null` while flat / with no stored target.
 */
export function effectiveTakeProfitPoints(
  config: AlgoConfig,
  state: TradeState,
  nowUtc: string,
): number | null {
  if (state.gexTpPoints === null) return null;
  return decayDistance(
    state.gexTpPoints,
    config.risk.takeProfitDecayPerHour,
    config.risk.takeProfitFloorPoints,
    hoursHeld(state, nowUtc),
  );
}

/**
 * The hard stop distance (SPX pts) in force right now: `stopLossPoints` after
 * time-decay. Independent of the HWM-driven trailing stop, which is applied
 * separately in {@link checkStopLoss}.
 */
export function effectiveStopLossPoints(
  config: AlgoConfig,
  state: TradeState,
  nowUtc: string,
): number {
  return decayDistance(
    config.risk.stopLossPoints,
    config.risk.stopLossDecayPerHour,
    config.risk.stopLossFloorPoints,
    hoursHeld(state, nowUtc),
  );
}

/** `" (decayed from 30.0 after 42m)"`, or `''` when decay isn't in force. */
function decayNote(initial: number, effective: number, hours: number): string {
  if (effective >= initial - 1e-9) return '';
  return ` (decayed from ${initial.toFixed(1)} after ${Math.round(hours * 60)}m)`;
}

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
  const signalScalar = absZ >= config.strongEntryThreshold ? FULL_SIZE_SCALAR : WEAK_SIGNAL_SIZE_SCALAR;

  const contracts = Math.max(1, Math.floor(baseContracts * signalScalar));
  return Math.min(contracts, risk.maxPositionSize);
}

/**
 * Check whether a stop-loss has been hit.
 *
 * Supports:
 *   - Hard stop: `stopLossPoints` from entry, tightened by `stopLossDecayPerHour`
 *     as the trade ages (no decay configured → the original fixed distance)
 *   - Trailing stop: activates after profit threshold, trails behind HWM
 *
 * `nowUtc` is the current snapshot's `capturedAt` — the instant the decay is
 * measured against.
 */
export function checkStopLoss(
  state: TradeState,
  currentSpot: number,
  config: AlgoConfig,
  nowUtc: string,
): { stopped: boolean; reason: string } {
  if (state.position === 'flat' || state.entryPrice === null) {
    return { stopped: false, reason: '' };
  }

  const { risk } = config;
  const direction = state.position === 'long' ? 1 : -1;
  const pnlPoints = (currentSpot - state.entryPrice) * direction;

  // Hard stop-loss, at whatever distance the clock has tightened it to.
  const stopPoints = effectiveStopLossPoints(config, state, nowUtc);
  if (pnlPoints <= -stopPoints) {
    const note = decayNote(risk.stopLossPoints, stopPoints, hoursHeld(state, nowUtc));
    return {
      stopped: true,
      reason: `hard stop hit (${pnlPoints.toFixed(1)} pts ≤ −${stopPoints.toFixed(1)}${note})`,
    };
  }

  // Trailing stop: only when enabled, and only after reaching activation threshold
  if (risk.trailingStopEnabled && state.highWaterMark >= risk.trailingStopActivation) {
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
 * Exponent on |gamma| when weighting strikes for the gamma center of mass.
 * Squaring sharpens the weights toward the dominant strike cluster, so the
 * center sits on the gamma pile price is actually drawn to rather than the
 * balance point of a two-sided distribution — on 2026-05-19 10:00 that moves it
 * from 17.1 to 34.2 pts from spot.
 *
 * ONE exponent, used by BOTH consumers of the center — the frozen take-profit
 * ({@link gexTakeProfitPoints}) and the `minGexTakeProfitPoints` entry gate
 * ({@link meetsGexMinTakeProfit}). The gate is the sensitive one: a sharper
 * center sits systematically further from spot (mean 11.96 → 16.06 pts on
 * 2026-05-19), so the 15-pt filter passes many more slots. Backtest
 * 2026-05-18 → 2026-07-24 on the tuned bestModel: 6 → 11 trades, +$1125 →
 * +$1075, profit factor 3.73 → 1.76, max drawdown $375 → $712.50. Re-tune
 * (`npm run tune`) after changing this — the gate threshold is fitted to it.
 */
const GAMMA_CENTER_POWER = 2;

/**
 * Gamma center of mass: the |gamma|^p-weighted average strike,
 * Σ(|gamma|^p·strike) / Σ(|gamma|^p).
 *
 * Strikes are weighted by ABSOLUTE gamma (consistent with the score engine,
 * which treats gamma as a magnitude) so opposite-sign gamma can't cancel the
 * denominator toward zero and fling the average far from spot. Only strikes
 * inside the ±strikeWindow band around spot are counted. Returns null when
 * there is no gamma in the window.
 *
 * `gammaPower` raises each weight before averaging: 1 is the plain mass center,
 * >1 concentrates the average on the heaviest strikes. Weights are normalized by
 * the window's largest |gamma| first — the ratio is scale-invariant, so this
 * doesn't move the result, it just keeps |gamma|^p in a safe numeric range for
 * any exponent (raw gamma exposure runs to ~1e9 per strike).
 */
export function gammaCenterStrike(
  strikes: StrikeData[],
  spot: number,
  strikeWindow: number,
  gammaPower = 1,
): number | null {
  const inWindow = strikes.filter((s) => Math.abs(s.strike - spot) <= strikeWindow);
  let maxGamma = 0;
  for (const s of inWindow) maxGamma = Math.max(maxGamma, Math.abs(s.gamma));
  if (maxGamma <= 0) return null;

  let weightedSum = 0;
  let weightSum = 0;
  for (const s of inWindow) {
    const scaled = Math.abs(s.gamma) / maxGamma;
    const w = gammaPower === 1 ? scaled : Math.pow(scaled, gammaPower);
    weightedSum += w * s.strike;
    weightSum += w;
  }
  if (weightSum <= 0) return null;
  return weightedSum / weightSum;
}

/**
 * GEX take-profit target in SPX points: the distance from the snapshot's spot to
 * its gamma center of mass under {@link GAMMA_CENTER_POWER}. Price is expected
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
  const center = gammaCenterStrike(
    snapshot.strikes,
    snapshot.spot,
    config.strikeWindow,
    GAMMA_CENTER_POWER,
  );
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
 * Check whether the profit target has been reached.
 *
 * The target distance was frozen at entry (TradeState.gexTpPoints = distance
 * from the entry spot to that snapshot's gamma center of mass) and is then
 * walked toward entry by `takeProfitDecayPerHour`. So a trade that runs most of
 * the way to its GEX target and stalls is taken at the reduced distance instead
 * of round-tripping — with decay off this is exactly the old fixed target.
 *
 * Slippage is not applied here — it is accounted for at the actual exit fill in
 * recordExit. `nowUtc` is the current snapshot's `capturedAt`.
 */
export function checkTakeProfit(
  state: TradeState,
  currentSpot: number,
  config: AlgoConfig,
  nowUtc: string,
): { hit: boolean; reason: string } {
  if (state.position === 'flat' || state.entryPrice === null || state.gexTpPoints === null) {
    return { hit: false, reason: '' };
  }

  const direction = state.position === 'long' ? 1 : -1;
  const pnlPoints = (currentSpot - state.entryPrice) * direction;
  const targetPoints = effectiveTakeProfitPoints(config, state, nowUtc)!;

  if (pnlPoints >= targetPoints) {
    const note = decayNote(state.gexTpPoints, targetPoints, hoursHeld(state, nowUtc));
    return {
      hit: true,
      reason: `+${pnlPoints.toFixed(1)} pts ≥ ${targetPoints.toFixed(1)} GEX target${note}`,
    };
  }

  return { hit: false, reason: '' };
}

/** Fade fraction used when a config predates `exitFadeFraction` (0 → pure floor,
 *  i.e. the original fixed-threshold fade behaviour). */
const DEFAULT_EXIT_FADE_FRACTION = 0;
/** Floor on the conviction scale (× exitFadeThreshold): even the strongest entry
 *  still fade-exits eventually rather than only ever on a reversal/stop. */
const MIN_FADE_SCALE = 0.1;

/**
 * Effective signal-fade exit bar (z-score units) for an open position. The
 * position is closed when its directional composite fades below this bar, so a
 * LOWER bar makes the trade hold LONGER (the score must fade further to trigger).
 *
 * Because the composite is normalized to the day's typical magnitude, a sustained
 * regime decays from its entry reading toward ~1.0; a fixed floor (0.5) then trips
 * on shallow pullbacks and flushes a still-valid position early. Scaling the bar
 * DOWN with entry conviction is what lets a strong trade run: conviction above the
 * typical magnitude (1.0) shrinks the bar toward reversal territory, so a trade
 * entered at directional z≈3 must fade almost to zero before the fade rule fires,
 * while a merely-typical entry keeps the plain floor. The hard stop-loss and the
 * reversal exit still bound the downside regardless.
 *
 * Entry conviction is the directional composite frozen at entry (positive in the
 * normal case — we entered because the signal was strong in the trade's direction);
 * a missing entry score, `exitFadeFraction ≤ 0`, or a flat state falls back to the
 * plain floor so behaviour is unchanged for configs that don't opt in.
 */
export function fadeExitBar(config: AlgoConfig, state: TradeState): number {
  const floor = config.exitFadeThreshold;
  const fraction = Number.isFinite(config.exitFadeFraction)
    ? config.exitFadeFraction
    : DEFAULT_EXIT_FADE_FRACTION;
  if (state.entryScore === null || fraction <= 0 || state.position === 'flat') {
    return floor;
  }
  const direction = state.position === 'long' ? 1 : -1;
  const entryConviction = state.entryScore.composite * direction;
  // Conviction ABOVE the day's typical magnitude (1.0) earns fade tolerance; the
  // bar shrinks by `fraction` per unit of excess, floored at MIN_FADE_SCALE·floor.
  const excess = Math.max(0, entryConviction - 1);
  const scale = Math.max(MIN_FADE_SCALE, 1 - fraction * excess);
  // Cap the bar at the entry conviction: a "fade" means the signal weakened FROM
  // where it got us in, so we must never demand the score climb HIGHER than its
  // entry level to stay in. Without this, a config whose fade floor exceeds the
  // (effective) entry bar — e.g. entryThreshold 0.8 vs exitFadeThreshold 1.03 —
  // flushes a low-conviction entry on the very next tick (instant whipsaw). The
  // cap only binds when floor·scale > entryConviction; healthy configs are
  // unaffected. Entry conviction can be ≤0 in a degenerate case (we entered on a
  // structural rule with a weak/negative composite); clamp at 0 so the cap never
  // produces a negative bar (reversal/stop still bound the downside).
  return Math.min(floor * scale, Math.max(0, entryConviction));
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
 * Check time-based exit gates using ET wall-clock time.
 *
 * ET (America/New_York) is the single wall-clock zone across the whole pipeline
 * — the captured_at instant is UTC and is converted to ET here, matching the
 * ET-labelled `noNewTradesAfterET` / `forcedExitByET` config values. No CT.
 *
 * Returns whether we should block new entries or force-exit positions.
 */
export function checkTimeGates(
  capturedAtUtc: string,
  config: AlgoConfig,
): { blockNewEntries: boolean; forceExit: boolean } {
  const etMinutes = etMinutesSinceMidnight(capturedAtUtc);
  const openMinutes = parseHhmm(config.risk.noNewTradesBeforeET);
  const noEntryMinutes = parseHhmm(config.risk.noNewTradesAfterET);
  const forceExitMinutes = parseHhmm(config.risk.forcedExitByET);

  return {
    // Block new entries pre-market (before the open) and after the late cutoff.
    // Pre-market Greek frames never reach here at all — the data loader drops
    // them, since SPX has no pre-open print to score against (see
    // RiskParams.noNewTradesBeforeET).
    blockNewEntries: etMinutes < openMinutes || etMinutes >= noEntryMinutes,
    forceExit: etMinutes >= forceExitMinutes,
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
    entryScore: null,
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
  entryScore: ScoreComponents,
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
    entryScore,
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

  // Flatten via the single flat-state source, carrying the day's running
  // PnL/trade tally forward (createFlatState zeroes those for start-of-day).
  const newState: TradeState = {
    ...createFlatState(),
    dailyPnl: state.dailyPnl + realizedPnl,
    dailyTradeCount: state.dailyTradeCount + 1,
  };

  return { newState, realizedPnl, exitFill };
}

// ── Helpers ──

function parseHhmm(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((s) => Number.parseInt(s, 10));
  return h! * 60 + m!;
}
