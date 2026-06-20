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
  Snapshot,
  TradeRecord,
} from './types.js';
import { DEFAULT_CONFIG } from './types.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

export interface BacktestOptions {
  startDate: string;
  endDate: string;
  config?: AlgoConfig;
}

/**
 * Run a backtest over a date range.
 *
 * Processes snapshots day-by-day, creating a fresh SignalGenerator
 * per day (cone + trade state reset daily).
 */
export async function runBacktest(opts: BacktestOptions): Promise<BacktestResult> {
  const config = opts.config ?? DEFAULT_CONFIG;

  log.info({ startDate: opts.startDate, endDate: opts.endDate }, 'loading snapshots');
  const allSnapshots = await loadDateRange(opts.startDate, opts.endDate, config.strikeWindow);

  if (allSnapshots.length === 0) {
    log.warn('no snapshots found in date range');
    return emptyResult();
  }

  log.info({ snapshots: allSnapshots.length }, 'snapshots loaded');

  // Group snapshots by trading day (expiry)
  const byDay = new Map<string, Snapshot[]>();
  for (const snap of allSnapshots) {
    const day = snap.expiry;
    let list = byDay.get(day);
    if (!list) {
      list = [];
      byDay.set(day, list);
    }
    list.push(snap);
  }

  const allTrades: TradeRecord[] = [];
  const dailyPnls: number[] = [];
  const tradingDays = [...byDay.keys()].sort();

  for (const day of tradingDays) {
    const daySnapshots = byDay.get(day)!;
    const generator = new SignalGenerator(config);

    log.debug({ day, snapshots: daySnapshots.length }, 'processing day');

    for (const snapshot of daySnapshots) {
      const signal = generator.processSnapshot(snapshot);

      if (signal.action !== 'hold') {
        log.debug(
          {
            time: signal.timestamp,
            action: signal.action,
            composite: signal.score.composite.toFixed(2),
            cone: signal.cone.state,
            reason: signal.reason,
          },
          'signal',
        );
      }
    }

    // Force-close any open position at end of day
    const finalState = generator.getState();
    const dayTrades = generator.getTrades();
    allTrades.push(...dayTrades);

    const dayPnl = dayTrades.reduce((sum, t) => sum + t.pnl, 0);
    dailyPnls.push(dayPnl);

    log.info(
      {
        day,
        trades: dayTrades.length,
        pnl: dayPnl.toFixed(2),
        position: finalState.position,
      },
      'day complete',
    );
  }

  const result = computeMetrics(allTrades, dailyPnls, tradingDays.length);

  log.info(
    {
      totalTrades: result.trades.length,
      totalPnl: result.totalPnl.toFixed(2),
      winRate: (result.winRate * 100).toFixed(1) + '%',
      profitFactor: result.profitFactor.toFixed(2),
      maxDrawdown: result.maxDrawdown.toFixed(2),
      sharpe: result.sharpe.toFixed(2),
      days: result.totalDays,
    },
    'backtest complete',
  );

  return result;
}

/**
 * Compute performance metrics from trade and daily PnL records.
 */
function computeMetrics(
  trades: TradeRecord[],
  dailyPnls: number[],
  totalDays: number,
): BacktestResult {
  if (trades.length === 0) {
    return { ...emptyResult(), totalDays };
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

function emptyResult(): BacktestResult {
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
  };
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
    runBacktest({ startDate, endDate })
      .then((result) => {
        console.log('\n=== BACKTEST RESULTS ===');
        console.log(`Period:         ${startDate} → ${endDate} (${result.totalDays} trading days)`);
        console.log(`Total trades:   ${result.trades.length}`);
        console.log(`Total PnL:      $${result.totalPnl.toFixed(2)}`);
        console.log(`Win rate:       ${(result.winRate * 100).toFixed(1)}%`);
        console.log(`Avg win:        $${result.avgWin.toFixed(2)}`);
        console.log(`Avg loss:       $${result.avgLoss.toFixed(2)}`);
        console.log(`Profit factor:  ${result.profitFactor.toFixed(2)}`);
        console.log(`Max drawdown:   $${result.maxDrawdown.toFixed(2)}`);
        console.log(`Sharpe ratio:   ${result.sharpe.toFixed(2)}`);

        if (result.trades.length > 0) {
          console.log('\n=== TRADE LOG ===');
          for (const t of result.trades) {
            const dir = t.direction.padEnd(5);
            const pnlStr = t.pnl >= 0 ? `+$${t.pnl.toFixed(2)}` : `-$${Math.abs(t.pnl).toFixed(2)}`;
            console.log(
              `  ${t.entryTime.slice(0, 16)} → ${t.exitTime.slice(0, 16)}  ${dir}  ${t.contracts}x  ${pnlStr.padStart(10)}  ${t.reason}`,
            );
          }
        }
      })
      .catch((e) => {
        console.error('Backtest failed:', e);
        process.exit(1);
      });
  }
}
