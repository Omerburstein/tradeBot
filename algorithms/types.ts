/**
 * Core types for the SPX 0DTE Greeks directional scoring algorithm.
 *
 * These types define the data model, scoring components, signals,
 * trade state, and configuration for the algorithm pipeline.
 */

import type { Panel } from '../scraper/types.js';

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
  /** SPX spot price at capture time. */
  spot: number;
  /** All strikes in the 120pt window with their Greek values. */
  strikes: StrikeData[];
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
  entryPrice: number | null;
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

  /** Daily expected move as fraction of spot (e.g. 0.009 = 0.9%). */
  dailyExpectedMovePct: number;

  risk: RiskParams;
}

/** Sensible defaults — tune via backtest. */
export const DEFAULT_CONFIG: AlgoConfig = {
  wGex: 0.45,
  wDGamma: 0.25,
  wPositions: 0.18,
  wDPositions: 0.12,

  pGamma: 1.2,
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

  dailyExpectedMovePct: 0.009,

  risk: {
    maxPositionSize: 2,
    accountEquity: 50_000,
    maxRiskPerTrade: 0.01,
    stopLossPoints: 10,
    trailingStopActivation: 5,
    trailingStopDistance: 7,
    maxDailyLoss: 0.02,
    maxTradesPerDay: 6,
    slippagePerSide: 0.50,
    pointValue: 50, // /ES mini
    noNewTradesAfterCT: '14:40',
    forcedExitByCT: '14:50',
  },
};

// ── Backtest Results ──

export interface TradeRecord {
  direction: Direction;
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  contracts: number;
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
}
