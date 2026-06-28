/**
 * Walk-forward backtester: replays historical snapshots through the
 * signal generator, tracks PnL, and computes performance metrics.
 *
 * Usage:
 *   BACKTEST_START=2025-05-10 BACKTEST_END=2025-06-15 npm run backtest
 *
 * Or import and call programmatically:
 *   const result = await runBacktest({ startDate, endDate, config });
 */

import pino from 'pino';
import { loadDateRange, getAvailableDates } from './data-loader.js';
import { SignalGenerator } from './signal-generator.js';
import type {
  AlgoConfig,
  BacktestResult,
  EquitySettings,
  Snapshot,
  TradeRecord,
} from './types.js';
import { DEFAULT_CONFIG, DEFAULT_EQUITY } from './types.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

export interface BacktestOptions {
  startDate: string;
  endDate: string;
  config?: AlgoConfig;
  /** Capital-account settings (seed + kill-switch). Defaults to {@link DEFAULT_EQUITY}. */
  equity?: EquitySettings;
}

/**
 * Run a backtest over a date range.
 *
 * Processes snapshots day-by-day, creating a fresh SignalGenerator
 * per day (cone + trade state reset daily).
 */
export async function runBacktest(opts: BacktestOptions): Promise<BacktestResult> {
  const config = opts.config ?? DEFAULT_CONFIG;
  const equity = opts.equity ?? DEFAULT_EQUITY;

  log.info({ startDate: opts.startDate, endDate: opts.endDate }, 'loading snapshots');
  const allSnapshots = await loadDateRange(opts.startDate, opts.endDate, config.strikeWindow);

  if (allSnapshots.length === 0) {
    log.warn('no snapshots found in date range');
    return emptyResult(equity);
  }

  log.info({ snapshots: allSnapshots.length }, 'snapshots loaded');

  const result = simulate(allSnapshots, config, log, equity);

  log.info(
    {
      totalTrades: result.trades.length,
      totalPnl: result.totalPnl.toFixed(2),
      winRate: (result.winRate * 100).toFixed(1) + '%',
      profitFactor: result.profitFactor.toFixed(2),
      maxDrawdown: result.maxDrawdown.toFixed(2),
      sharpe: result.sharpe.toFixed(2),
      finalEquity: result.finalEquity.toFixed(2),
      failed: result.failed,
      days: result.totalDays,
    },
    'backtest complete',
  );

  return result;
}

/**
 * Run the signal generator over already-loaded snapshots and compute metrics.
 *
 * Pure in-memory replay (no DB) so a tuner can evaluate many configs against
 * one set of snapshots. Snapshots are grouped by trading day; a fresh
 * SignalGenerator is created per day (cone + trade state reset daily).
 *
 * @param allSnapshots  Snapshots across one or more days (any order).
 * @param config        Algorithm configuration to evaluate.
 * @param logger        Optional pino logger for per-day detail; omit for silence.
 */
export function simulate(
  allSnapshots: Snapshot[],
  config: AlgoConfig,
  logger?: pino.Logger,
  equity: EquitySettings = DEFAULT_EQUITY,
): BacktestResult {
  // Group snapshots by trading day (expiry)
  const byDay = new Map<string, Snapshot[]>();
  for (const snap of allSnapshots) {
    let list = byDay.get(snap.expiry);
    if (!list) {
      list = [];
      byDay.set(snap.expiry, list);
    }
    list.push(snap);
  }

  const allTrades: TradeRecord[] = [];
  const dailyPnls: number[] = [];
  const tradingDays = [...byDay.keys()].sort();

  // Running capital account (TODO #9): seed at initialCapital and fail the run
  // the instant realized equity touches the floor. The kill-switch is checked
  // after every completed trade — intra-day, in chronological order — so trades
  // taken after the account is dead are never counted.
  let accountEquity = equity.initialCapital;
  let minEquity = accountEquity;
  let failed = false;
  let daysProcessed = 0;

  for (const day of tradingDays) {
    // Sort within the day so causal order is guaranteed regardless of input order.
    const daySnapshots = [...byDay.get(day)!].sort(
      (a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime(),
    );
    // Passing the logger makes the generator emit an ENTRY/EXIT line per action.
    const generator = new SignalGenerator(config, logger);

    for (const snapshot of daySnapshots) {
      generator.processSnapshot(snapshot);
    }

    const dayTrades = generator.getTrades();
    daysProcessed++;

    let dayPnl = 0;
    let dayCount = 0;
    for (const t of dayTrades) {
      accountEquity += t.pnl;
      dayPnl += t.pnl;
      dayCount++;
      allTrades.push(t);
      if (accountEquity < minEquity) minEquity = accountEquity;
      if (accountEquity <= equity.equityFloor) {
        failed = true;
        break;
      }
    }
    dailyPnls.push(dayPnl);

    logger?.info(
      { day, trades: dayCount, pnl: dayPnl.toFixed(2), equity: accountEquity.toFixed(2) },
      failed ? `run FAILED — equity ${accountEquity.toFixed(2)} ≤ floor ${equity.equityFloor}` : 'day complete',
    );

    if (failed) break;
  }

  return computeMetrics(allTrades, dailyPnls, daysProcessed, equity, accountEquity, minEquity, failed);
}

/**
 * Compute performance metrics from trade and daily PnL records.
 */
function computeMetrics(
  trades: TradeRecord[],
  dailyPnls: number[],
  totalDays: number,
  equity: EquitySettings,
  finalEquity: number,
  minEquity: number,
  failed: boolean,
): BacktestResult {
  const equityFields = {
    initialCapital: equity.initialCapital,
    finalEquity,
    minEquity,
    failed,
  };

  if (trades.length === 0) {
    return { ...emptyResult(equity), totalDays, ...equityFields };
  }

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);

  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const winRate = wins.length / trades.length;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;

  const grossWins = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLosses = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0;

  // Max drawdown from cumulative PnL curve
  let peak = 0;
  let maxDrawdown = 0;
  let cumulative = 0;
  for (const pnl of dailyPnls) {
    cumulative += pnl;
    if (cumulative > peak) peak = cumulative;
    const dd = peak - cumulative;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Annualized Sharpe ratio from daily PnLs
  const sharpe = computeSharpe(dailyPnls);

  return {
    trades,
    totalPnl,
    winRate,
    avgWin,
    avgLoss,
    profitFactor,
    maxDrawdown,
    sharpe,
    totalDays,
    ...equityFields,
  };
}

/**
 * Annualized Sharpe ratio from daily PnL series.
 * Assumes risk-free rate of 0 for simplicity.
 */
function computeSharpe(dailyPnls: number[]): number {
  if (dailyPnls.length < 2) return 0;

  const n = dailyPnls.length;
  const mean = dailyPnls.reduce((a, b) => a + b, 0) / n;
  const variance = dailyPnls.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const std = Math.sqrt(variance);

  if (std < 1e-10) return 0;

  // Annualize: multiply by sqrt(252 trading days)
  return (mean / std) * Math.sqrt(252);
}

function emptyResult(equity: EquitySettings = DEFAULT_EQUITY): BacktestResult {
  return {
    trades: [],
    totalPnl: 0,
    winRate: 0,
    avgWin: 0,
    avgLoss: 0,
    profitFactor: 0,
    maxDrawdown: 0,
    sharpe: 0,
    totalDays: 0,
    initialCapital: equity.initialCapital,
    finalEquity: equity.initialCapital,
    minEquity: equity.initialCapital,
    failed: false,
  };
}

// ── Reporting (shared by the backtest CLI and the tuner) ──

/** Format a signed dollar amount, e.g. `+$1500.00` / `-$500.00`. */
function fmtUsd(n: number): string {
  return n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`;
}

/**
 * Render a UTC instant as Eastern Time wall-clock ("YYYY-MM-DD HH:MM ET"),
 * matching the trading time the UW dashboard shows. Display-only — the stored
 * entry/exit times stay absolute UTC (the look-ahead guard + time-gates rely
 * on that). Offset is resolved per-instant via Intl, so DST is handled.
 */
function fmtEt(utcIso: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(utcIso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} ET`;
}

/**
 * Print every trade taken: entry/exit time + price, direction, size, the
 * stop/target levels implied at entry, realized PnL, and the exit reason.
 * (TODO #11 — full trade detail.)
 */
export function printTradeLog(trades: TradeRecord[], title = 'TRADE LOG'): void {
  if (trades.length === 0) {
    console.log(`\n=== ${title} ===\n  (no trades)`);
    return;
  }
  console.log(`\n=== ${title} ===`);
  for (const t of trades) {
    const dir = t.direction.padEnd(5);
    console.log(
      `  ${fmtEt(t.entryTime)} → ${fmtEt(t.exitTime)}  ${dir}  ${t.contracts}x  ` +
        `entry=${t.entryPrice.toFixed(2)} exit=${t.exitPrice.toFixed(2)} ` +
        `stop=${t.stopPrice.toFixed(2)} tgt=${t.targetPrice.toFixed(2)}  ` +
        `${fmtUsd(t.pnl).padStart(11)}  ${t.reason}`,
    );
  }
}

/**
 * Print end-of-run summary stats: total PnL, trade count, win rate, average
 * winner/loser, profit factor, and the capital-account result. (TODO #11.)
 */
export function printSummary(result: BacktestResult, title = 'SUMMARY'): void {
  console.log(`\n=== ${title} ===`);
  console.log(`Total trades:   ${result.trades.length}`);
  console.log(`Total PnL:      ${fmtUsd(result.totalPnl)}`);
  console.log(`Win rate:       ${(result.winRate * 100).toFixed(1)}%`);
  console.log(`Avg win:        ${fmtUsd(result.avgWin)}`);
  console.log(`Avg loss:       ${fmtUsd(result.avgLoss)}`);
  console.log(`Profit factor:  ${result.profitFactor.toFixed(2)}`);
  console.log(`Max drawdown:   $${result.maxDrawdown.toFixed(2)}`);
  console.log(`Sharpe ratio:   ${result.sharpe.toFixed(2)}`);
  console.log(`Initial capital: $${result.initialCapital.toFixed(2)}`);
  console.log(`Final equity:    $${result.finalEquity.toFixed(2)}`);
  console.log(`Min equity:      $${result.minEquity.toFixed(2)}`);
  console.log(`Status:          ${result.failed ? 'FAILED — equity hit the floor' : 'OK'}`);
}

// ── CLI Entry Point ──

const isMain = process.argv[1]?.endsWith('backtest.ts') ||
               process.argv[1]?.endsWith('backtest.js');

if (isMain) {
  const startDate = process.env.BACKTEST_START;
  const endDate = process.env.BACKTEST_END;

  if (!startDate || !endDate) {
    console.error('Usage: BACKTEST_START=YYYY-MM-DD BACKTEST_END=YYYY-MM-DD npm run backtest');
    console.error('\nAvailable dates:');
    getAvailableDates()
      .then((dates) => {
        if (dates.length === 0) {
          console.error('  (no data in database)');
        } else {
          console.error(`  ${dates[0]} to ${dates[dates.length - 1]} (${dates.length} days)`);
        }
      })
      .catch((e) => console.error('  (could not query DB)', e.message));
  } else {
    const equity: EquitySettings = {
      initialCapital: process.env.INITIAL_CAPITAL
        ? Number(process.env.INITIAL_CAPITAL)
        : DEFAULT_EQUITY.initialCapital,
      equityFloor: process.env.EQUITY_FLOOR
        ? Number(process.env.EQUITY_FLOOR)
        : DEFAULT_EQUITY.equityFloor,
    };

    runBacktest({ startDate, endDate, equity })
      .then((result) => {
        console.log(`\nPeriod: ${startDate} → ${endDate} (${result.totalDays} trading days), ` +
          `floor $${equity.equityFloor.toFixed(0)}`);
        printTradeLog(result.trades);
        printSummary(result, 'BACKTEST RESULTS');
      })
      .catch((e) => {
        console.error('Backtest failed:', e);
        process.exit(1);
      });
  }
}
