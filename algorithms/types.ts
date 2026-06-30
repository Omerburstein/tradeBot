/**
 * Core types for the SPX 0DTE Greeks directional scoring algorithm.
 *
 * These types define the data model, scoring components, signals,
 * trade state, and configuration for the algorithm pipeline.
 */

import type { Panel } from '../scraper/core/types.js';

// ── Data Model ──

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
   * True for an intermediate *price tick* the data-loader inserts between the
   * 10-minute Greek slots so the algo can re-decide entry/exit every 5 minutes
   * on the CURRENT stock price. Greeks (`strikes`) are unchanged from the slot
   * that precedes the tick — only `spot`/`es` are refreshed — so the signal
   * generator reuses the latest Greek score instead of recomputing it (and does
   * NOT advance the z-score history). Absent/`false` = a real Greek snapshot.
   */
  greeksStale?: boolean;
}

// ── Scoring ──

export interface ScoreComponents {
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
  contracts: number;
  unrealizedPnl: number;
  dailyPnl: number;
  dailyTradeCount: number;
  /** Highest favorable excursion since entry (for trailing stop). */
  highWaterMark: number;
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
   * Reward-to-risk ratio used as the fallback take-profit when no cone data is
   * available. The fallback target = stopLossPoints × riskRewardRatio.
   * When a cone is available, gexTpFraction replaces this as the TP basis.
   */
  riskRewardRatio: number;
  /**
   * Fraction of the cone half-width (ATM straddle = coneUpper − spxOpen) to
   * use as the GEX-relative take-profit target. Default 1.0 = aim for the full
   * ATM straddle distance. Falls back to stopLossPoints × riskRewardRatio when
   * no cone data is captured for the day.
   */
  gexTpFraction: number;
  /**
   * Minimum GEX-derived take-profit (SPX points) required to enter a trade.
   * When the cone-implied TP (ATM straddle × gexTpFraction) is below this
   * floor the trade is skipped entirely — the expected move is too small to
   * justify round-trip cost and slippage.
   */
  minGexTakeProfitPoints: number;
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
  /** CT time after which no new entries allowed (HH:MM). */
  noNewTradesAfterCT: string;
  /** CT time by which all positions must be flat (HH:MM). */
  forcedExitByCT: string;
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

  // ── Non-linearity (powers) ──
  // Each factor input is passed through a sign-preserving power
  // (signedPow(x, p) = sign(x)·|x|^p) before aggregation. p > 1 emphasizes
  // large readings, p < 1 saturates them. Nothing is left exactly linear.

  /** Exponent on per-strike gamma. */
  pGamma: number;
  /**
   * Multiplier applied to positive per-strike gamma (negative gamma uses 1.0).
   * Slightly > 1 makes positive gamma marginally more influential than negative
   * gamma in the GEX score. Gamma-only — positions are not biased.
   */
  positiveGammaBias: number;
  /** Exponent on per-strike gamma change (dGamma/dt). */
  pDGamma: number;
  /** Exponent on per-strike net positions (saturating, < 1). */
  pPositions: number;
  /** Exponent on per-strike positions change (dPositions/dt). */
  pDPositions: number;
  /** Exponent on normalized strike distance in the distance-weight ramp. */
  pDistance: number;

  /** Span of the distance-weight ramp: weight = 1 + span·(dist/window)^pDistance. */
  distanceWeightSpan: number;

  /**
   * Minimum gamma strength (a strike's |gamma| as a fraction of the window's
   * max |gamma|, 0–1) required for that strike's positions to count at all.
   * Positions where gamma is weak carry no signal regardless of size.
   */
  positionsGammaGate: number;

  /**
   * Hard cap on the absolute value of every factor z-score (and therefore the
   * composite). A one-off anomaly can't produce z=10 and dominate — it's
   * clamped to ±zClamp.
   */
  zClamp: number;

  /** Z-score threshold for standard entries (cone-breach). */
  entryThreshold: number;
  /** Z-score threshold for inside-cone entries (stronger signal needed). */
  strongEntryThreshold: number;
  /** Z-score level below which an open position is exited (signal fade). */
  exitFadeThreshold: number;
  /** Z-score in opposing direction that triggers an exit. */
  reversalThreshold: number;

  /** Only consider strikes within this many points of spot. */
  strikeWindow: number;
  /** Number of past ScoreComponents snapshots for z-score lookback. */
  zScoreLookback: number;

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

  positionsGammaGate: 0.30,
  zClamp: 3.5,

  entryThreshold: 1.5,
  strongEntryThreshold: 2.0,
  exitFadeThreshold: 0.5,
  reversalThreshold: 1.0,

  strikeWindow: 120,
  zScoreLookback: 20,

  risk: {
    maxPositionSize: 2,
    accountEquity: 50_000,
    maxRiskPerTrade: 0.01,
    stopLossPoints: 10,
    riskRewardRatio: 3, // fallback only (no cone): take-profit at 30 pts
    gexTpFraction: 1.0, // target full ATM straddle distance
    minGexTakeProfitPoints: 20, // skip trades whose GEX TP < 20 pts
    trailingStopActivation: 5,
    trailingStopDistance: 7,
    maxDailyLoss: 0.02,
    maxTradesPerDay: 6,
    slippagePerSide: 0.50,
    pointValue: 50, // $50 P&L per 1.0 ES point, per contract (/ES e-mini)
    noNewTradesAfterCT: '14:40',
    forcedExitByCT: '14:50',
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
