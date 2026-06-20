/**
 * Parameter tuner: searches the AlgoConfig space for the configuration that
 * maximizes a chosen objective over a backtest period.
 *
 * Every numeric knob is tunable — factor weights, the non-linearity powers,
 * the distance-weight shape, the gamma gate, the z-score clamp, entry/exit
 * thresholds, lookback, and (optionally) risk params. Add or remove entries
 * in DEFAULT_SEARCH_SPACE (keyed by dotted path) to control what's swept.
 *
 * Strategy: random search to explore broadly, then a local refinement pass
 * that narrows around the best candidate. Snapshots are loaded from the DB
 * once and replayed in-memory per config (see simulate() in backtest.ts).
 *
 * To avoid overfitting, the range is split into an in-sample (train) slice
 * used for optimization and an out-of-sample (test) slice the winner is
 * reported on — if test performance collapses, the config is overfit.
 *
 * Usage:
 *   TUNE_START=2025-05-10 TUNE_END=2025-06-15 npm run tune
 *
 * Optional env:
 *   TUNE_ITERS=400          random-search samples (default 300)
 *   TUNE_REFINE=120         local-refinement samples (default 100)
 *   TUNE_OBJECTIVE=sharpe   sharpe | totalPnl | profitFactor (default sharpe)
 *   TUNE_TRAIN_FRAC=0.7     fraction of days used for training (default 0.7)
 *   TUNE_MIN_TRADES=15      configs with fewer train trades are rejected
 *   TUNE_SEED=42            reproducible runs (default: time-seeded)
 */

import pino from 'pino';
import { loadDateRange } from './data-loader.js';
import { simulate } from './backtest.js';
import type { AlgoConfig, BacktestResult, Snapshot } from './types.js';
import { DEFAULT_CONFIG } from './types.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

// ── Search space ──

export interface ParamRange {
  min: number;
  max: number;
  /** Round samples to whole numbers (e.g. lookback). */
  integer?: boolean;
}

/**
 * Tunable parameters keyed by dotted path into AlgoConfig. Risk params are
 * reachable too (e.g. 'risk.stopLossPoints') — uncomment to include them.
 */
export const DEFAULT_SEARCH_SPACE: Record<string, ParamRange> = {
  // Factor weights (re-normalized to sum 1 after sampling).
  wGex: { min: 0.20, max: 0.70 },
  wDGamma: { min: 0.05, max: 0.40 },
  wPositions: { min: 0.02, max: 0.35 },
  wDPositions: { min: 0.02, max: 0.30 },

  // Non-linearity powers (never exactly 1).
  pGamma: { min: 0.8, max: 1.8 },
  pDGamma: { min: 0.8, max: 1.8 },
  pPositions: { min: 0.3, max: 0.9 },
  pDPositions: { min: 0.3, max: 0.9 },
  pDistance: { min: 0.8, max: 2.5 },
  distanceWeightSpan: { min: 0.5, max: 4.0 },

  // Gates / clamps.
  positionsGammaGate: { min: 0.10, max: 0.60 },
  zClamp: { min: 2.0, max: 5.0 },

  // Signal thresholds.
  entryThreshold: { min: 0.8, max: 2.5 },
  strongEntryThreshold: { min: 1.5, max: 3.5 },
  exitFadeThreshold: { min: 0.0, max: 1.2 },
  reversalThreshold: { min: 0.5, max: 2.0 },

  // Stats.
  zScoreLookback: { min: 8, max: 40, integer: true },
  dailyExpectedMovePct: { min: 0.005, max: 0.015 },

  // ── Risk (uncomment to co-tune money management) ──
  // 'risk.stopLossPoints': { min: 5, max: 20 },
  // 'risk.trailingStopActivation': { min: 3, max: 10 },
  // 'risk.trailingStopDistance': { min: 3, max: 12 },
};

/** Weight paths that get re-normalized to sum to 1 after sampling. */
const WEIGHT_KEYS = ['wGex', 'wDGamma', 'wPositions', 'wDPositions'] as const;

// ── Objective ──

export type ObjectiveName = 'sharpe' | 'totalPnl' | 'profitFactor';

function objectiveValue(r: BacktestResult, name: ObjectiveName): number {
  switch (name) {
    case 'totalPnl':
      return r.totalPnl;
    case 'profitFactor':
      return Number.isFinite(r.profitFactor) ? r.profitFactor : r.totalPnl > 0 ? 1e6 : 0;
    case 'sharpe':
    default:
      return r.sharpe;
  }
}

// ── Tuning ──

export interface TuneOptions {
  startDate: string;
  endDate: string;
  iterations?: number;
  refineIterations?: number;
  objective?: ObjectiveName;
  trainFraction?: number;
  minTrades?: number;
  seed?: number;
  space?: Record<string, ParamRange>;
}

export interface TuneCandidate {
  config: AlgoConfig;
  score: number;
  train: BacktestResult;
}

export interface TuneResult {
  best: AlgoConfig;
  trainResult: BacktestResult;
  testResult: BacktestResult;
  leaderboard: TuneCandidate[];
  evaluated: number;
}

export async function runTuning(opts: TuneOptions): Promise<TuneResult | null> {
  const objective = opts.objective ?? 'sharpe';
  const iterations = opts.iterations ?? 300;
  const refineIterations = opts.refineIterations ?? 100;
  const trainFraction = opts.trainFraction ?? 0.7;
  const minTrades = opts.minTrades ?? 15;
  const space = opts.space ?? DEFAULT_SEARCH_SPACE;
  const rng = makeRng(opts.seed ?? Date.now());

  log.info({ startDate: opts.startDate, endDate: opts.endDate }, 'loading snapshots for tuning');
  const allSnapshots = await loadDateRange(opts.startDate, opts.endDate, DEFAULT_CONFIG.strikeWindow);
  if (allSnapshots.length === 0) {
    log.warn('no snapshots found in date range');
    return null;
  }

  const { train, test } = splitByDay(allSnapshots, trainFraction);
  log.info(
    { totalSnapshots: allSnapshots.length, trainSnapshots: train.length, testSnapshots: test.length },
    'train/test split (by day)',
  );

  const evaluate = (config: AlgoConfig): TuneCandidate => {
    const result = simulate(train, config);
    // Reject configs that barely trade — their metrics aren't meaningful.
    const score = result.trades.length < minTrades ? -Infinity : objectiveValue(result, objective);
    return { config, score, train: result };
  };

  const candidates: TuneCandidate[] = [];

  // Stage 1: random search.
  for (let i = 0; i < iterations; i++) {
    candidates.push(evaluate(sampleConfig(space, rng)));
  }

  // Stage 2: local refinement around the current best (shrunk neighborhood).
  let best = bestOf(candidates);
  for (let i = 0; i < refineIterations; i++) {
    const neighbor = perturbConfig(best.config, space, rng, 0.15);
    const cand = evaluate(neighbor);
    candidates.push(cand);
    if (cand.score > best.score) best = cand;
  }

  const leaderboard = candidates
    .filter((c) => Number.isFinite(c.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  // Out-of-sample evaluation of the winner.
  const testResult = simulate(test, best.config);

  return {
    best: best.config,
    trainResult: best.train,
    testResult,
    leaderboard,
    evaluated: candidates.length,
  };
}

// ── Config sampling ──

function sampleConfig(space: Record<string, ParamRange>, rng: () => number): AlgoConfig {
  const config = cloneConfig(DEFAULT_CONFIG);
  for (const [path, range] of Object.entries(space)) {
    setPath(config, path, sampleRange(range, rng));
  }
  normalizeWeights(config);
  return config;
}

/** Sample near an existing config: each param jitters within ±frac of its range. */
function perturbConfig(
  base: AlgoConfig,
  space: Record<string, ParamRange>,
  rng: () => number,
  frac: number,
): AlgoConfig {
  const config = cloneConfig(base);
  for (const [path, range] of Object.entries(space)) {
    const span = (range.max - range.min) * frac;
    const current = getPath(base, path);
    let next = current + (rng() * 2 - 1) * span;
    next = Math.max(range.min, Math.min(range.max, next));
    if (range.integer) next = Math.round(next);
    setPath(config, path, next);
  }
  normalizeWeights(config);
  return config;
}

function sampleRange(range: ParamRange, rng: () => number): number {
  const v = range.min + rng() * (range.max - range.min);
  return range.integer ? Math.round(v) : v;
}

/** Scale the four factor weights so they sum to 1 (keeps thresholds comparable). */
function normalizeWeights(config: AlgoConfig): void {
  const sum = WEIGHT_KEYS.reduce((s, k) => s + Math.max(0, config[k]), 0);
  if (sum <= 0) return;
  for (const k of WEIGHT_KEYS) {
    config[k] = Math.max(0, config[k]) / sum;
  }
}

function bestOf(candidates: TuneCandidate[]): TuneCandidate {
  return candidates.reduce((a, b) => (b.score > a.score ? b : a));
}

// ── Dotted-path helpers (operate on a deep-cloned config) ──

function cloneConfig(config: AlgoConfig): AlgoConfig {
  return { ...config, risk: { ...config.risk } };
}

function getPath(obj: AlgoConfig, path: string): number {
  const parts = path.split('.');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let node: any = obj;
  for (const p of parts) node = node[p];
  return node as number;
}

function setPath(obj: AlgoConfig, path: string, value: number): void {
  const parts = path.split('.');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let node: any = obj;
  for (let i = 0; i < parts.length - 1; i++) node = node[parts[i]];
  node[parts[parts.length - 1]] = value;
}

// ── Train/test split ──

function splitByDay(snapshots: Snapshot[], trainFraction: number): { train: Snapshot[]; test: Snapshot[] } {
  const days = [...new Set(snapshots.map((s) => s.expiry))].sort();
  const cut = Math.max(1, Math.floor(days.length * trainFraction));
  const trainDays = new Set(days.slice(0, cut));
  const train: Snapshot[] = [];
  const test: Snapshot[] = [];
  for (const s of snapshots) {
    (trainDays.has(s.expiry) ? train : test).push(s);
  }
  return { train, test };
}

// ── Seeded RNG (mulberry32) for reproducible runs ──

function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── CLI ──

const isMain =
  process.argv[1]?.endsWith('tuner.ts') || process.argv[1]?.endsWith('tuner.js');

if (isMain) {
  const startDate = process.env.TUNE_START;
  const endDate = process.env.TUNE_END;

  if (!startDate || !endDate) {
    console.error('Usage: TUNE_START=YYYY-MM-DD TUNE_END=YYYY-MM-DD npm run tune');
    process.exit(1);
  }

  const num = (v: string | undefined, d: number) => (v ? Number(v) : d);

  runTuning({
    startDate,
    endDate,
    iterations: num(process.env.TUNE_ITERS, 300),
    refineIterations: num(process.env.TUNE_REFINE, 100),
    objective: (process.env.TUNE_OBJECTIVE as ObjectiveName) ?? 'sharpe',
    trainFraction: num(process.env.TUNE_TRAIN_FRAC, 0.7),
    minTrades: num(process.env.TUNE_MIN_TRADES, 15),
    seed: process.env.TUNE_SEED ? Number(process.env.TUNE_SEED) : undefined,
  })
    .then((res) => {
      if (!res) {
        console.error('No data — nothing to tune.');
        process.exit(1);
      }

      console.log('\n=== TUNING COMPLETE ===');
      console.log(`Configs evaluated: ${res.evaluated}`);
      console.log(`Objective:         ${process.env.TUNE_OBJECTIVE ?? 'sharpe'}`);

      const fmt = (r: BacktestResult) =>
        `trades=${r.trades.length} pnl=$${r.totalPnl.toFixed(0)} win=${(r.winRate * 100).toFixed(0)}% ` +
        `pf=${r.profitFactor.toFixed(2)} sharpe=${r.sharpe.toFixed(2)} maxDD=$${r.maxDrawdown.toFixed(0)}`;

      console.log(`\nIn-sample  (train): ${fmt(res.trainResult)}`);
      console.log(`Out-sample (test):  ${fmt(res.testResult)}`);

      console.log('\n=== BEST CONFIG ===');
      console.log(JSON.stringify(res.best, null, 2));

      console.log('\n=== LEADERBOARD (train objective) ===');
      res.leaderboard.forEach((c, i) => {
        console.log(`  #${(i + 1).toString().padStart(2)}  score=${c.score.toFixed(3)}  ${fmt(c.train)}`);
      });
    })
    .catch((e) => {
      console.error('Tuning failed:', e);
      process.exit(1);
    });
}
