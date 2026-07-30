/**
 * Parameter tuner: searches the AlgoConfig space for the configuration that
 * maximizes a chosen objective over a backtest period.
 *
 * Every numeric knob is tunable — factor weights, the non-linearity powers,
 * the distance-weight shape, the gamma gate, the z-score clamp, entry/exit
 * thresholds, lookback, and (optionally) risk params. Add or remove entries
 * in DEFAULT_SEARCH_SPACE (keyed by dotted path) to control what's swept.
 *
 * Strategy: CMA-ES (Covariance Matrix Adaptation Evolution Strategy) — a
 * derivative-free optimizer well suited to this black-box, non-convex,
 * non-differentiable objective (the backtest makes discrete trade decisions,
 * so there is no usable gradient). Each generation samples a population from a
 * multivariate Gaussian N(mean, σ²·C), scores each candidate by replaying it
 * against the in-sample slice, then moves the mean toward a *weighted average
 * of the best half* and adapts both the step size σ and the full covariance C
 * so the search cloud stretches along the directions that actually improve the
 * objective. Because selection is rank-based, infeasible configs (blown
 * account / too few trades) simply sort last and are never selected — the
 * -Infinity penalty needs no special handling.
 *
 * Multi-start: a genuinely multi-modal landscape can trap any single CMA-ES
 * run in one basin, so we run several independent restarts (the first seeded at
 * DEFAULT_CONFIG, the rest at random points) and keep the global best. This is
 * what makes runs converge consistently instead of landing on whichever local
 * maximum the initial randomness happened to favor.
 *
 * Snapshots are loaded from the DB once and replayed in-memory per config
 * (see simulate() in backtest.ts).
 *
 * Validation — walk-forward (default): rather than one train/test split, the
 * range is cut into K expanding-window folds. Each fold re-tunes on all history
 * up to its test block (in-sample objective = profit factor) and is scored on
 * the held-out block it never saw. Every fold's out-of-sample trades are pooled
 * into one equity curve whose TOTAL DOLLARS is the honest estimate of "money
 * this process would have made walking forward" — the keep/discard metric. The
 * config that ships is then re-tuned on ALL data (the walk-forward dollars vouch
 * for the process, not for one frozen config). Set TUNE_WF=false to fall back to
 * the legacy single train/test split.
 *
 * Dimensionality — a handful of low-impact / secondary knobs are frozen during
 * tuning (see FROZEN_PARAMS) at the current bestModel's values, cutting the
 * swept params ~22 → ~14 to fight overfitting on the small trade sample.
 *
 * Capital account (TODO #9): every config is replayed against a seeded account
 * (default $100k, fail at $98k). A config whose run hits the floor is a failure
 * and is rejected outright (score = -Infinity) — its params must change.
 *
 * Usage:
 *   TUNE_START=2025-05-10 TUNE_END=2025-06-15 npm run tune
 *
 * Optional env:
 *   TUNE_ITERS=400          total evaluation budget across all restarts (default 300 + TUNE_REFINE)
 *   TUNE_REFINE=120         added to the eval budget (kept for backward compat; default 100)
 *   TUNE_RESTARTS=3         independent CMA-ES restarts, best kept (default 3)
 *   TUNE_POP=12             CMA-ES population size λ per generation (default 4 + ⌊3·ln n⌋)
 *   TUNE_SIGMA=0.3          initial CMA-ES step size in normalized space (default 0.3)
 *   TUNE_OBJECTIVE=profitFactor  sharpe | totalPnl | profitFactor (default profitFactor)
 *   TUNE_WF=true            walk-forward validation on/off (default true; false = single split)
 *   TUNE_WF_FOLDS=4         number of expanding-window folds (default 4)
 *   TUNE_WF_INIT_FRAC=0.4   fraction of days reserved as the first fold's initial train (default 0.4)
 *   TUNE_TRAIN_FRAC=0.7     single-split only: fraction of days used for training (default 0.7)
 *   TUNE_MIN_TRADES=10      configs with fewer train trades are rejected
 *   TUNE_SEED=42            reproducible runs (default: time-seeded)
 *   INITIAL_CAPITAL=100000  seed capital for each run (default 100000)
 *   EQUITY_FLOOR=98000      hard equity floor; runs that hit it fail (default 98000)
 */

import pino from 'pino';
import { loadDateRange, getAvailableDates } from './data-loader.js';
import { simulate, resultFromTrades, printTradeLog, printSummary } from './backtest.js';
import { recordModelRun } from './model-store.js';
import type { AlgoConfig, BacktestResult, EquitySettings, Snapshot, TradeRecord } from './types.js';
import { DEFAULT_CONFIG, DEFAULT_EQUITY } from './types.js';

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
  // Factor weights (re-normalized to sum 1 after sampling — only RATIOS matter).
  // Every factor self-normalizes to ~1.0 typical (each divided by its OWN recent
  // magnitude), so a rate of change reads on the same footing as its level and
  // the weights are directly comparable. All four therefore get a wide, roughly
  // symmetric ceiling; the floors stay near zero so the tuner can still ignore a
  // genuinely useless factor.
  wGex: { min: 0.20, max: 0.70 },
  wDGamma: { min: 0.05, max: 0.70 },
  wPositions: { min: 0.02, max: 0.35 },
  wDPositions: { min: 0.02, max: 0.55 },

  // Normalize-step shaping exponents (applied to the whole factor's ratio). The
  // ratio anchors at ~1.0 for every factor; the exponent shapes the response
  // around it — >1 emphasizes moves above typical, <1 saturates them. The
  // rate-of-change exponents keep a wide range so the tuner can pick either.
  pGamma: { min: 0.8, max: 1.8 },
  positiveGammaBias: { min: 1.0, max: 1.3 }, // per-strike multiplier, not an exponent
  pDGamma: { min: 0.3, max: 1.8 },
  pPositions: { min: 0.3, max: 0.9 },
  pDPositions: { min: 0.3, max: 0.9 },

  pDistance: { min: 0.8, max: 2.5 },
  distanceWeightSpan: { min: 0.5, max: 4.0 },

  // Half-life (MINUTES) of the dGamma/dPositions baseline. Wall-clock, so the
  // same value means the same memory at any cadence. ~3 min ≈ react to the last
  // few minutes only; ~30 min ≈ a slow, deep baseline. The current level always
  // enters the delta at full weight regardless.
  momentumHalfLifeMin: { min: 3, max: 30 },

  // Gates / clamps.
  positionsGammaGate: { min: 0.10, max: 0.60 },
  zClamp: { min: 2.0, max: 5.0 },

  // Signal thresholds.
  entryThreshold: { min: 0.8, max: 2.5 },
  strongEntryThreshold: { min: 1.5, max: 3.5 },
  conePassBonus: { min: 0.0, max: 0.75 },
  // Wall-clock half-life (min) of the entry-signal EWMA (0 = off/instantaneous;
  // higher = more smoothing, later entries). Filters one-bar spikes, cadence-invariant.
  entrySignalHalfLifeMin: { min: 0, max: 12 },
  exitFadeThreshold: { min: 0.0, max: 1.2 }, // absolute floor of the fade-exit bar
  // How much a high-conviction entry LOWERS its fade bar (bar shrinks by this per
  // unit of entry z above typical). Higher → strong trades hold longer. 0 = pure
  // fixed floor. NOTE: under a pure-PnL objective the tuner may push this toward 0
  // and entrySignalHalfLifeMin toward 0 if shorter trades score better in-sample —
  // the DEFAULT_CONFIG values bias toward longer holds when NOT tuning.
  exitFadeFraction: { min: 0.0, max: 0.9 },
  reversalThreshold: { min: 0.5, max: 2.0 },

  // Exit style toggle: sampled as 0/1 and coerced to the boolean config field.
  // 1 = GEX auto-exit on (fade + reversal close the trade); 0 = hold until a
  // structural exit (cone-return / stop-loss / take-profit / forced time gate).
  // Pinned OFF for now via DEFAULT_CONFIG.gexAutoExit=false — uncomment to let
  // the tuner sweep both exit styles again.
  // gexAutoExit: { min: 0, max: 1, integer: true },

  // Stats.
  // zScoreLookbackMin is deliberately NOT searched: it is pinned at
  // DEFAULT_CONFIG's 180 wall-clock minutes by request. It used to be swept as a
  // snapshot COUNT and settled at its MIN bound (8) in the last two tunes — i.e.
  // an 80-minute scale window at the 10-min cadence — which makes the normalizer
  // track the signal so closely that most readings collapse toward ~1.0. Fixing
  // it also returns one dimension to the (badly over-parameterized) search.

  // ── Risk (uncomment to co-tune money management) ──
  // 'risk.stopLossPoints': { min: 5, max: 20 },
  // 'risk.trailingStopActivation': { min: 3, max: 10 },
  // 'risk.trailingStopDistance': { min: 3, max: 12 },
  // Time-decay of the exit distances (fraction of the ORIGINAL distance given up
  // per hour held; 0 = fixed distance). Deliberately NOT searched yet — the
  // DEFAULT_CONFIG values are meant to be A/B'd by hand against the existing
  // tuned models first, since decay trades win RATE against average win SIZE and
  // a pure-PnL objective may push it to an extreme in-sample.
  // 'risk.takeProfitDecayPerHour': { min: 0, max: 0.8 },
  // 'risk.takeProfitFloorPoints': { min: 3, max: 15 },
  // 'risk.stopLossDecayPerHour': { min: 0, max: 0.8 },
};

/** Weight paths that get re-normalized to sum to 1 after sampling. */
const WEIGHT_KEYS = ['wGex', 'wDGamma', 'wPositions', 'wDPositions'] as const;

/**
 * Low-impact / secondary knobs FROZEN during tuning to cut the search
 * dimensionality (~22 → ~14) and fight overfitting on the small trade sample.
 * They are pinned at the values of the current `bestModel` — the 2026-07-15 tune
 * that generalized to +$650 out-of-sample — NOT at DEFAULT_CONFIG, whose values
 * are unvetted. Only params that exist in that bestModel are frozen; newer knobs
 * it predates (pPositions, entrySignalHalfLifeMin, …) stay tunable rather than
 * be pinned at an arbitrary default. Re-derive these if bestModel changes
 * materially, or remove a key here to sweep it again.
 */
export const FROZEN_PARAMS: Partial<Record<keyof AlgoConfig, number>> = {
  positiveGammaBias: 1.1607767980745605,
  pDGamma: 1.0021324829187954,
  pDPositions: 0.7118878461245194,
  distanceWeightSpan: 2.0070431945600453,
  zClamp: 4.136436829932964,
  strongEntryThreshold: 2.529692499488264,
  conePassBonus: 0.1338095230282378,
  reversalThreshold: 1.1900472858336397,
};

/** Base config a tuning run decodes from: DEFAULT_CONFIG with FROZEN_PARAMS pinned. */
export const TUNING_BASE_CONFIG: AlgoConfig = (() => {
  const base = cloneConfig(DEFAULT_CONFIG);
  for (const [key, value] of Object.entries(FROZEN_PARAMS)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (base as any)[key] = value;
  }
  return base;
})();

/** The space actually swept: the full search space minus every frozen key. */
export const TUNING_SEARCH_SPACE: Record<string, ParamRange> = Object.fromEntries(
  Object.entries(DEFAULT_SEARCH_SPACE).filter(([key]) => !(key in FROZEN_PARAMS)),
);

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

/**
 * True when a config's fade floor sits at or above the LOWEST achievable entry
 * bar — `entryThreshold − conePassBonus`, the fresh-pass outside-cone case. Such
 * a config opens a position already below its own signal-fade bar, so the fade
 * rule flushes it on the next tick (instant whipsaw). The runtime cap in
 * `fadeExitBar` (risk-manager.ts) neutralizes the symptom, but the tuner should
 * never bank a whipsaw-driven score, so these are rejected outright.
 */
function isInvertedFadeConfig(config: AlgoConfig): boolean {
  const lowestEntryBar = config.entryThreshold - config.conePassBonus;
  return config.exitFadeThreshold >= lowestEntryBar;
}

/**
 * Zero-filled result stand-in for a config rejected BEFORE simulation (an
 * inverted fade bar): recorded in `candidates` for an accurate `evaluated`
 * count, but `failed`/-Infinity so it is filtered out and never selected.
 */
const EMPTY_RESULT: BacktestResult = {
  trades: [],
  totalPnl: 0,
  winRate: 0,
  avgWin: 0,
  avgLoss: 0,
  profitFactor: 0,
  maxDrawdown: 0,
  sharpe: 0,
  totalDays: 0,
  initialCapital: 0,
  finalEquity: 0,
  minEquity: 0,
  failed: true,
};

// ── Tuning ──

export interface TuneOptions {
  startDate: string;
  endDate: string;
  /** Random-search-era name kept for the CLI: base evaluation budget. */
  iterations?: number;
  /** Added to {@link iterations} for the total evaluation budget (back-compat). */
  refineIterations?: number;
  /** Independent CMA-ES restarts; the global best across all is returned. */
  restarts?: number;
  /** CMA-ES population size λ per generation. Default: 4 + ⌊3·ln n⌋. */
  popSize?: number;
  /** Initial CMA-ES step size in normalized [0,1] space. Default 0.3. */
  sigma0?: number;
  objective?: ObjectiveName;
  trainFraction?: number;
  minTrades?: number;
  seed?: number;
  space?: Record<string, ParamRange>;
  /** Capital-account settings applied to every config's replay. Defaults to {@link DEFAULT_EQUITY}. */
  equity?: EquitySettings;
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
  /** The search space that was swept — used to report the winning tuned params. */
  space: Record<string, ParamRange>;
}

/** Everything a single CMA-ES search over one in-sample slice needs. */
interface SearchConfig {
  objective: ObjectiveName;
  minTrades: number;
  totalBudget: number;
  restarts: number;
  popSize?: number;
  sigma0: number;
  equity: EquitySettings;
  /** Config the search decodes from — FROZEN_PARAMS pinned (see TUNING_BASE_CONFIG). */
  baseConfig: AlgoConfig;
  rng: () => number;
  /** Emit the per-restart CMA-ES config line (off for the many walk-forward folds). */
  verbose?: boolean;
}

interface SearchResult {
  best: AlgoConfig;
  trainResult: BacktestResult;
  leaderboard: TuneCandidate[];
  evaluated: number;
}

/**
 * Run CMA-ES over one in-sample slice and return the best config found. Shared
 * by the single-split tuner and every walk-forward fold so both paths optimize
 * identically. Returns null when no config clears the usability gates (blown
 * account / too few trades / inverted fade) — the caller decides what that means.
 */
function searchBestConfig(train: Snapshot[], space: Record<string, ParamRange>, cfg: SearchConfig): SearchResult | null {
  // The ordered list of tuned params defines the CMA-ES coordinate vector.
  const params = Object.entries(space) as Array<[string, ParamRange]>;
  const n = params.length;
  const lambda = cfg.popSize ?? defaultLambda(n);

  // Size the restart count to the budget: each restart needs at least one full
  // generation (λ evals), and ideally several. Never exceed budget/λ restarts.
  const requestedRestarts = Math.max(1, cfg.restarts);
  const restarts = Math.max(1, Math.min(requestedRestarts, Math.floor(cfg.totalBudget / lambda)));
  const perRestartBudget = Math.floor(cfg.totalBudget / restarts);

  if (cfg.verbose) {
    log.info(
      { params: n, populationLambda: lambda, restarts, perRestartBudget, totalBudget: cfg.totalBudget, sigma0: cfg.sigma0 },
      'CMA-ES configuration',
    );
  }

  const candidates: TuneCandidate[] = [];

  // One evaluation: decode a normalized vector → config → in-sample backtest.
  // Rejects (blown account / too few trades / inverted fade bar) score -Infinity;
  // CMA-ES ranks by score, so they sort last and are never selected.
  const evaluate = (x: number[]): number => {
    const config = decodeConfig(params, x, cfg.baseConfig);
    // Reject configs whose fade floor sits ABOVE the lowest possible entry bar
    // (entryThreshold − conePassBonus, the fresh-pass outside-cone case). Such a
    // config enters a position already below its own fade bar and flushes it on
    // the next tick — see fadeExitBar in risk-manager.ts. Rejecting steers the
    // optimizer away from that region instead of banking whipsaw-driven scores.
    if (isInvertedFadeConfig(config)) {
      candidates.push({ config, score: -Infinity, train: EMPTY_RESULT });
      return -Infinity;
    }
    const result = simulate(train, config, undefined, cfg.equity);
    const usable = !result.failed && result.trades.length >= cfg.minTrades;
    const score = usable ? objectiveValue(result, cfg.objective) : -Infinity;
    candidates.push({ config, score, train: result });
    return score;
  };

  const gauss = makeGaussian(cfg.rng);

  // Multi-start: restart 0 begins at the (frozen) base config; the rest at random points.
  for (let r = 0; r < restarts; r++) {
    const x0 = r === 0 ? encodeConfig(params, cfg.baseConfig) : Array.from({ length: n }, () => cfg.rng());
    cmaes({ n, x0, sigma0: cfg.sigma0, lambda, maxEvals: perRestartBudget, gauss, evaluate });
  }

  const finite = candidates.filter((c) => Number.isFinite(c.score));
  if (finite.length === 0) return null;

  const leaderboard = [...finite].sort((a, b) => b.score - a.score).slice(0, 10);
  return { best: leaderboard[0]!.config, trainResult: leaderboard[0]!.train, leaderboard, evaluated: candidates.length };
}

export async function runTuning(opts: TuneOptions): Promise<TuneResult | null> {
  const objective = opts.objective ?? 'profitFactor';
  // Total evaluation budget: fold the old two-stage env vars into one budget so
  // TUNE_ITERS / TUNE_REFINE keep controlling total compute.
  const totalBudget = (opts.iterations ?? 300) + (opts.refineIterations ?? 100);
  const trainFraction = opts.trainFraction ?? 0.7;
  const minTrades = opts.minTrades ?? 10;
  const space = opts.space ?? TUNING_SEARCH_SPACE;
  const equity = opts.equity ?? DEFAULT_EQUITY;
  const sigma0 = opts.sigma0 ?? 0.3;
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

  const search = searchBestConfig(train, space, {
    objective, minTrades, totalBudget, restarts: opts.restarts ?? 3,
    popSize: opts.popSize, sigma0, equity, baseConfig: TUNING_BASE_CONFIG, rng, verbose: true,
  });
  if (!search) {
    log.warn('no usable configs found (all rejected) — widen the search space or relax minTrades');
    return null;
  }

  // Out-of-sample evaluation of the winner.
  const testResult = simulate(test, search.best, undefined, equity);

  return {
    best: search.best,
    trainResult: search.trainResult,
    testResult,
    leaderboard: search.leaderboard,
    evaluated: search.evaluated,
    space,
  };
}

// ── Walk-forward validation ──

/** One expanding-window fold: re-tuned on all history before its test block, scored on it. */
export interface FoldResult {
  index: number;
  trainDays: number;
  testDays: number;
  /** First/last day (expiry) of the held-out test block. */
  testStart: string;
  testEnd: string;
  /** Best config found on this fold's train slice (null if none was usable). */
  best: AlgoConfig | null;
  /** Out-of-sample result on the held-out block. */
  oos: BacktestResult;
}

export interface WalkForwardResult {
  /** Config to ship: re-tuned on ALL data (the walk-forward dollars vouch for the process). */
  deploy: AlgoConfig;
  /** In-sample result of the deploy config over all data. */
  deployResult: BacktestResult;
  /** Pooled out-of-sample: every fold's held-out trades concatenated into one equity curve. */
  oos: BacktestResult;
  folds: FoldResult[];
  space: Record<string, ParamRange>;
  evaluated: number;
}

/** Options for {@link runWalkForward} — TuneOptions plus fold geometry. */
export interface WalkForwardOptions extends TuneOptions {
  /** Number of expanding-window folds (default 4). */
  folds?: number;
  /** Fraction of days reserved as the first fold's initial train block (default 0.4). */
  initialTrainFraction?: number;
}

/** Collect every snapshot whose day (expiry) is in `dayList`, preserving input order. */
function snapshotsForDays(byDay: Map<string, Snapshot[]>, dayList: string[]): Snapshot[] {
  const out: Snapshot[] = [];
  for (const day of dayList) {
    const list = byDay.get(day);
    if (list) out.push(...list);
  }
  return out;
}

/**
 * Walk-forward validation: cut the range into K expanding-window folds, re-tune
 * each on all history up to its held-out test block, and pool every fold's
 * out-of-sample trades into one honest equity curve. The pooled TOTAL DOLLARS is
 * the keep/discard metric; the shipped config is re-tuned on ALL data.
 */
export async function runWalkForward(opts: WalkForwardOptions): Promise<WalkForwardResult | null> {
  const objective = opts.objective ?? 'profitFactor';
  const totalBudget = (opts.iterations ?? 300) + (opts.refineIterations ?? 100);
  const minTrades = opts.minTrades ?? 10;
  // Held-out fold slices trade far less than the full range, so a lower floor
  // keeps folds from being rejected wholesale (which would empty the leaderboard).
  const foldMinTrades = Math.max(2, Math.round(minTrades / 3));
  const folds = Math.max(2, opts.folds ?? 4);
  const initialTrainFraction = opts.initialTrainFraction ?? 0.4;
  const space = opts.space ?? TUNING_SEARCH_SPACE;
  const equity = opts.equity ?? DEFAULT_EQUITY;
  const sigma0 = opts.sigma0 ?? 0.3;
  const restarts = opts.restarts ?? 3;
  const rng = makeRng(opts.seed ?? Date.now());

  log.info({ startDate: opts.startDate, endDate: opts.endDate }, 'loading snapshots for walk-forward tuning');
  const allSnapshots = await loadDateRange(opts.startDate, opts.endDate, DEFAULT_CONFIG.strikeWindow);
  if (allSnapshots.length === 0) {
    log.warn('no snapshots found in date range');
    return null;
  }

  const days = [...new Set(allSnapshots.map((s) => s.expiry))].sort();
  if (days.length < folds + 1) {
    log.warn({ days: days.length, folds }, 'not enough trading days for the requested fold count');
    return null;
  }

  // Expanding-window folds: reserve the first initialTrainFraction of days as the
  // seed train block, split the remainder into K contiguous out-of-sample blocks.
  const byDay = groupSnapshotsByDay(allSnapshots);
  const startIdx = Math.max(1, Math.floor(days.length * initialTrainFraction));
  const testDays = days.slice(startIdx);
  const chunk = Math.max(1, Math.ceil(testDays.length / folds));

  const foldResults: FoldResult[] = [];
  const oosTrades: TradeRecord[] = [];
  let evaluated = 0;

  for (let f = 0; f < folds; f++) {
    const testSlice = testDays.slice(f * chunk, (f + 1) * chunk);
    if (testSlice.length === 0) break;
    const testStart = testSlice[0]!;
    // Expanding train: every day strictly before this test block.
    const trainDayList = days.slice(0, days.indexOf(testStart));
    const trainSnaps = snapshotsForDays(byDay, trainDayList);
    const testSnaps = snapshotsForDays(byDay, testSlice);

    const search = searchBestConfig(trainSnaps, space, {
      objective, minTrades: foldMinTrades, totalBudget, restarts,
      popSize: opts.popSize, sigma0, equity, baseConfig: TUNING_BASE_CONFIG, rng,
    });
    evaluated += search?.evaluated ?? 0;
    const oos = search ? simulate(testSnaps, search.best, undefined, equity) : EMPTY_RESULT;
    for (const t of oos.trades) oosTrades.push(t);

    log.info(
      { fold: f + 1, trainDays: trainDayList.length, testDays: testSlice.length, testStart, oosTrades: oos.trades.length, oosPnl: oos.totalPnl.toFixed(0) },
      search ? 'fold complete' : 'fold produced no usable config',
    );

    foldResults.push({
      index: f + 1,
      trainDays: trainDayList.length,
      testDays: testSlice.length,
      testStart,
      testEnd: testSlice[testSlice.length - 1]!,
      best: search?.best ?? null,
      oos,
    });
  }

  // Pooled out-of-sample equity curve — the honest "money the process made".
  const oos = resultFromTrades(oosTrades, equity);

  // Ship a config re-tuned on ALL data (same process, more data).
  const deploySearch = searchBestConfig(allSnapshots, space, {
    objective, minTrades, totalBudget, restarts,
    popSize: opts.popSize, sigma0, equity, baseConfig: TUNING_BASE_CONFIG, rng, verbose: true,
  });
  if (!deploySearch) {
    log.warn('deploy retrain (all data) found no usable config');
    return null;
  }
  evaluated += deploySearch.evaluated;

  return {
    deploy: deploySearch.best,
    deployResult: deploySearch.trainResult,
    oos,
    folds: foldResults,
    space,
    evaluated,
  };
}

// ── Config encode / decode (normalized [0,1] vector ↔ AlgoConfig) ──

/**
 * Decode a normalized CMA-ES vector into a concrete config. Each coordinate is
 * clamped to [0,1] (box-constraint repair) then mapped onto its param range;
 * integers are rounded and the factor weights re-normalized to sum to 1.
 */
function decodeConfig(
  params: Array<[string, ParamRange]>,
  x: number[],
  base: AlgoConfig = DEFAULT_CONFIG,
): AlgoConfig {
  const config = cloneConfig(base);
  params.forEach(([path, range], i) => {
    const unit = Math.max(0, Math.min(1, x[i] ?? 0.5));
    let value = range.min + unit * (range.max - range.min);
    if (range.integer) value = Math.round(value);
    setPath(config, path, value);
  });
  normalizeWeights(config);
  return config;
}

/** Encode a config into the normalized [0,1] vector — the inverse of {@link decodeConfig}. */
function encodeConfig(params: Array<[string, ParamRange]>, config: AlgoConfig): number[] {
  return params.map(([path, range]) => {
    const value = getPath(config, path);
    const span = range.max - range.min;
    const unit = span === 0 ? 0.5 : (value - range.min) / span;
    return Math.max(0, Math.min(1, unit));
  });
}

/** Scale the four factor weights so they sum to 1 (keeps thresholds comparable). */
function normalizeWeights(config: AlgoConfig): void {
  const sum = WEIGHT_KEYS.reduce((s, k) => s + Math.max(0, config[k]), 0);
  if (sum <= 0) return;
  for (const k of WEIGHT_KEYS) {
    config[k] = Math.max(0, config[k]) / sum;
  }
}

// ── Dotted-path helpers (operate on a deep-cloned config) ──

function cloneConfig(config: AlgoConfig): AlgoConfig {
  return { ...config, risk: { ...config.risk }, coneBreakout: { ...config.coneBreakout } };
}

function getPath(obj: AlgoConfig, path: string): number {
  const parts = path.split('.');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let node: any = obj;
  for (const p of parts) node = node[p];
  // Boolean toggles (e.g. gexAutoExit) round-trip through the numeric search
  // space as 0/1 so sampling/perturbation stay uniform.
  if (typeof node === 'boolean') return node ? 1 : 0;
  return node as number;
}

function setPath(obj: AlgoConfig, path: string, value: number): void {
  const parts = path.split('.');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let node: any = obj;
  for (let i = 0; i < parts.length - 1; i++) node = node[parts[i]];
  const key = parts[parts.length - 1];
  // Coerce back to boolean for toggle fields (the field's current type decides).
  node[key] = typeof node[key] === 'boolean' ? value >= 0.5 : value;
}

// ── Train/test split ──

/** Bucket snapshots by trading day (expiry), preserving input order within a day. */
function groupSnapshotsByDay(snapshots: Snapshot[]): Map<string, Snapshot[]> {
  const byDay = new Map<string, Snapshot[]>();
  for (const s of snapshots) {
    let list = byDay.get(s.expiry);
    if (!list) {
      list = [];
      byDay.set(s.expiry, list);
    }
    list.push(s);
  }
  return byDay;
}

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

/** Standard-normal sampler (Marsaglia polar) drawing from a uniform rng. */
function makeGaussian(rng: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = rng() * 2 - 1;
      v = rng() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * mul;
    return u * mul;
  };
}

// ── CMA-ES core ──

/** Default population size λ = 4 + ⌊3·ln n⌋ (Hansen). */
function defaultLambda(n: number): number {
  return 4 + Math.floor(3 * Math.log(n));
}

interface CmaesOptions {
  /** Dimension = number of tuned params. */
  n: number;
  /** Initial mean in normalized [0,1] space. */
  x0: number[];
  /** Initial step size (normalized-space units). */
  sigma0: number;
  /** Population size λ. */
  lambda: number;
  /** Evaluation budget for this restart. */
  maxEvals: number;
  gauss: () => number;
  /** Maximize this: takes a normalized vector, returns a score (may be -Infinity). */
  evaluate: (x: number[]) => number;
}

/**
 * One CMA-ES run (a single restart). Standard (μ/μ_w, λ) CMA-ES following
 * Hansen's reference: weighted intermediate recombination, cumulative step-size
 * adaptation (CSA) via the σ evolution path, and a rank-one + rank-μ covariance
 * update. Selection is rank-based, so -Infinity scores never get selected.
 *
 * Bounds are handled by clipping each sampled coordinate into [0,1] before
 * evaluation (box-constraint repair) and updating the strategy on the clipped
 * vector — simple and stable for a search this size.
 */
function cmaes(opts: CmaesOptions): void {
  const { n, gauss, evaluate } = opts;
  const lambda = opts.lambda;
  const mu = Math.floor(lambda / 2);

  // Recombination weights (log-decreasing), normalized to sum 1.
  const wRaw: number[] = [];
  for (let i = 0; i < mu; i++) wRaw.push(Math.log(mu + 0.5) - Math.log(i + 1));
  const wSum = wRaw.reduce((a, b) => a + b, 0);
  const weights = wRaw.map((w) => w / wSum);
  const mueff = 1 / weights.reduce((a, w) => a + w * w, 0);

  // Strategy-parameter time constants / learning rates (Hansen defaults).
  const cc = (4 + mueff / n) / (n + 4 + (2 * mueff) / n);
  const cs = (mueff + 2) / (n + mueff + 5);
  const c1 = 2 / ((n + 1.3) ** 2 + mueff);
  const cmu = Math.min(1 - c1, (2 * (mueff - 2 + 1 / mueff)) / ((n + 2) ** 2 + mueff));
  const damps = 1 + 2 * Math.max(0, Math.sqrt((mueff - 1) / (n + 1)) - 1) + cs;
  const chiN = Math.sqrt(n) * (1 - 1 / (4 * n) + 1 / (21 * n * n));

  let xmean = opts.x0.slice();
  let sigma = opts.sigma0;
  let pc = new Array(n).fill(0);
  let ps = new Array(n).fill(0);
  let B = identity(n); // columns are eigenvectors of C
  let d = new Array(n).fill(1); // sqrt of eigenvalues of C
  let C = identity(n);
  let evals = 0;
  let gen = 0;
  let evalsSinceEig = 0;

  while (evals + lambda <= opts.maxEvals) {
    // Sample and evaluate a population of λ candidates.
    const pop: Array<{ x: number[]; score: number }> = [];
    for (let k = 0; k < lambda; k++) {
      const z = Array.from({ length: n }, () => gauss());
      const dz = z.map((zi, i) => d[i] * zi);
      const y = matVec(B, dz); // y = B·(d ⊙ z) ~ N(0, C)
      // Clip into [0,1] (box-constraint repair) so decode stays in-range.
      const x = xmean.map((m, i) => Math.max(0, Math.min(1, m + sigma * y[i])));
      const score = evaluate(x);
      evals++;
      pop.push({ x, score });
    }

    // Rank best-first (maximization) and recombine the top μ into a new mean.
    pop.sort((a, b) => b.score - a.score);
    const xold = xmean;
    xmean = new Array(n).fill(0);
    for (let i = 0; i < mu; i++) {
      for (let j = 0; j < n; j++) xmean[j] += weights[i] * pop[i].x[j];
    }

    // Step of the mean, in normalized units.
    const meanStep = xmean.map((m, i) => (m - xold[i]) / sigma);

    // σ evolution path: ps = (1-cs)·ps + √(cs(2-cs)μeff)·C^(-1/2)·meanStep.
    const cInvHalfStep = invSqrtMul(B, d, meanStep); // C^(-1/2)·meanStep
    for (let i = 0; i < n; i++) {
      ps[i] = (1 - cs) * ps[i] + Math.sqrt(cs * (2 - cs) * mueff) * cInvHalfStep[i];
    }
    const psNorm = Math.sqrt(ps.reduce((a, v) => a + v * v, 0));

    // Heaviside stall flag: pause the rank-one path when σ-path is over-long.
    const hsig =
      psNorm / Math.sqrt(1 - (1 - cs) ** (2 * (gen + 1))) / chiN < 1.4 + 2 / (n + 1) ? 1 : 0;

    // C evolution path (rank-one direction).
    for (let i = 0; i < n; i++) {
      pc[i] = (1 - cc) * pc[i] + hsig * Math.sqrt(cc * (2 - cc) * mueff) * meanStep[i];
    }

    // Covariance update: blend old C, rank-one (pc·pcᵀ), and rank-μ (Σ wᵢ yᵢyᵢᵀ).
    const deltaHsig = (1 - hsig) * cc * (2 - cc);
    const nextC = C.map((row) => row.slice());
    for (let a = 0; a < n; a++) {
      for (let b = a; b < n; b++) {
        let rankMu = 0;
        for (let i = 0; i < mu; i++) {
          const ya = (pop[i].x[a] - xold[a]) / sigma;
          const yb = (pop[i].x[b] - xold[b]) / sigma;
          rankMu += weights[i] * ya * yb;
        }
        const value =
          (1 - c1 - cmu) * C[a][b] +
          c1 * (pc[a] * pc[b] + deltaHsig * C[a][b]) +
          cmu * rankMu;
        nextC[a][b] = value;
        nextC[b][a] = value; // keep C symmetric
      }
    }
    C = nextC;

    // Step-size update (CSA).
    sigma *= Math.exp((cs / damps) * (psNorm / chiN - 1));
    if (!Number.isFinite(sigma) || sigma > 1e3) sigma = 1e3;
    if (sigma < 1e-12) sigma = 1e-12;

    gen++;
    evalsSinceEig += lambda;

    // Re-decompose C periodically to refresh the sampling basis (B, d).
    if (evalsSinceEig > lambda / (c1 + cmu) / n / 10) {
      evalsSinceEig = 0;
      const { values, vectors } = jacobiEigen(C);
      B = vectors;
      d = values.map((v) => Math.sqrt(Math.max(v, 1e-20)));
    }
  }
}

// ── Small dense linear algebra (n ≈ 18, so clarity over speed) ──

function identity(n: number): number[][] {
  const m: number[][] = [];
  for (let i = 0; i < n; i++) {
    m.push(new Array(n).fill(0));
    m[i][i] = 1;
  }
  return m;
}

/** Matrix·vector: (M·v)[i] = Σ_j M[i][j]·v[j]. */
function matVec(m: number[][], v: number[]): number[] {
  const n = v.length;
  const out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += m[i][j] * v[j];
    out[i] = s;
  }
  return out;
}

/**
 * Apply C^(-1/2) to a vector, given C's eigenvectors B (columns) and d = √eig:
 * C^(-1/2)·v = B · diag(1/d) · Bᵀ · v.
 */
function invSqrtMul(B: number[][], d: number[], v: number[]): number[] {
  const n = v.length;
  // t = Bᵀ·v
  const t = new Array(n).fill(0);
  for (let j = 0; j < n; j++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += B[i][j] * v[i];
    t[j] = s / d[j];
  }
  // result = B·t
  return matVec(B, t);
}

/**
 * Symmetric eigenvalue decomposition via the cyclic Jacobi algorithm. Returns
 * eigenvalues and an eigenvector matrix whose COLUMNS are the eigenvectors.
 * Ample for the small (n ≈ 18) covariance matrices here.
 */
function jacobiEigen(input: number[][]): { values: number[]; vectors: number[][] } {
  const n = input.length;
  const a = input.map((row) => row.slice());
  const V = identity(n);
  const maxSweeps = 100;

  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    // Sum of squared off-diagonal entries — converged when negligible.
    let off = 0;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    }
    if (off < 1e-28) break;

    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        // Rotation angle that zeros a[p][q].
        const phi = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]);
        const c = Math.cos(phi);
        const s = Math.sin(phi);
        // A ← Jᵀ A J (rotate columns p,q then rows p,q).
        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        // Accumulate eigenvectors: V ← V J.
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p];
          const vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq;
          V[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }

  const values = a.map((row, i) => row[i]);
  return { values, vectors: V };
}

// ── CLI reporting helpers (shared by the single-split and walk-forward paths) ──

/** One-line performance summary of a backtest result. */
function fmtResult(r: BacktestResult): string {
  return (
    `trades=${r.trades.length} pnl=$${r.totalPnl.toFixed(0)} win=${(r.winRate * 100).toFixed(0)}% ` +
    `pf=${r.profitFactor.toFixed(2)} sharpe=${r.sharpe.toFixed(2)} maxDD=$${r.maxDrawdown.toFixed(0)} ` +
    `eq=$${r.finalEquity.toFixed(0)} ${r.failed ? 'FAILED' : 'OK'}`
  );
}

/** Print the winning value of every swept knob (the headline "what params won"). */
function printTunedParams(config: AlgoConfig, space: Record<string, ParamRange>): void {
  console.log('\n=== TUNED PARAMS (swept knobs) ===');
  const paths = Object.keys(space).sort();
  const pad = Math.max(...paths.map((p) => p.length));
  for (const path of paths) {
    const value = getPath(config, path);
    const isWeight = (WEIGHT_KEYS as readonly string[]).includes(path);
    const range = space[path]!;
    const isToggle = range.integer && range.min === 0 && range.max === 1;
    const shown = isToggle ? (value >= 0.5 ? '1 (on)' : '0 (off)') : value.toFixed(4);
    console.log(`  ${path.padEnd(pad)} = ${shown}${isWeight ? ' (normalized)' : ''}`);
  }
}

/**
 * Flag any tuned param whose winning value sits at (or within a hair of) its
 * search-space bound — a sign the optimum may lie OUTSIDE the range, so the
 * bound should be widened and the tune re-run before trusting it. Re-normalized
 * weights and 0/1 toggles are skipped (a bound simply IS the value there).
 */
function printParamsAtLimit(config: AlgoConfig, space: Record<string, ParamRange>): void {
  console.log('\n=== PARAMS AT SEARCH-SPACE LIMIT ===');
  const paths = Object.keys(space).sort();
  const pad = Math.max(...paths.map((p) => p.length));
  const atLimit: string[] = [];
  for (const p of paths) {
    const range = space[p]!;
    const isWeight = (WEIGHT_KEYS as readonly string[]).includes(p);
    const isToggle = range.integer === true && range.min === 0 && range.max === 1;
    if (isWeight || isToggle) continue;
    const value = getPath(config, p);
    const span = range.max - range.min;
    const tol = range.integer ? 0 : span * 0.005; // within 0.5% of the range counts as "at" it
    if (value <= range.min + tol) {
      atLimit.push(`  ${p.padEnd(pad)} = ${value.toFixed(4)}  → at MIN bound (${range.min})`);
    } else if (value >= range.max - tol) {
      atLimit.push(`  ${p.padEnd(pad)} = ${value.toFixed(4)}  → at MAX bound (${range.max})`);
    }
  }
  if (atLimit.length === 0) {
    console.log('  none — every tuned param settled inside its range.');
  } else {
    console.log('  These hit a search-space bound; consider widening the range and re-tuning:');
    for (const line of atLimit) console.log(line);
  }
}

// ── CLI ──

const isMain =
  process.argv[1]?.endsWith('tuner.ts') || process.argv[1]?.endsWith('tuner.js');

if (isMain) {
  const startDate = process.env.TUNE_START;
  const endDate = process.env.TUNE_END;

  if (!startDate || !endDate) {
    console.error('Usage: TUNE_START=YYYY-MM-DD TUNE_END=YYYY-MM-DD npm run tune');
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
  const num = (v: string | undefined, d: number) => (v ? Number(v) : d);
  const objective = (process.env.TUNE_OBJECTIVE as ObjectiveName) ?? 'profitFactor';
  const walkForward = (process.env.TUNE_WF ?? 'true').toLowerCase() !== 'false';

  const common = {
    startDate,
    endDate,
    iterations: num(process.env.TUNE_ITERS, 300),
    refineIterations: num(process.env.TUNE_REFINE, 100),
    restarts: num(process.env.TUNE_RESTARTS, 3),
    popSize: process.env.TUNE_POP ? Number(process.env.TUNE_POP) : undefined,
    sigma0: num(process.env.TUNE_SIGMA, 0.3),
    objective,
    minTrades: num(process.env.TUNE_MIN_TRADES, 10),
    seed: process.env.TUNE_SEED ? Number(process.env.TUNE_SEED) : undefined,
    equity: {
      initialCapital: num(process.env.INITIAL_CAPITAL, DEFAULT_EQUITY.initialCapital),
      equityFloor: num(process.env.EQUITY_FLOOR, DEFAULT_EQUITY.equityFloor),
    },
  };

  const run = walkForward
    ? runWalkForward({
        ...common,
        folds: num(process.env.TUNE_WF_FOLDS, 4),
        initialTrainFraction: num(process.env.TUNE_WF_INIT_FRAC, 0.4),
      }).then((res) => {
        if (!res) {
          console.error('No data — nothing to tune.');
          process.exit(1);
        }

        console.log('\n=== WALK-FORWARD COMPLETE ===');
        console.log(`Configs evaluated: ${res.evaluated}`);
        console.log(`Objective (in-sample, per fold): ${objective}`);

        console.log('\n=== FOLDS (out-of-sample) ===');
        for (const f of res.folds) {
          const tag = f.best ? '' : '  (no usable config)';
          console.log(`  #${f.index}  train=${f.trainDays}d  test=${f.testDays}d [${f.testStart}→${f.testEnd}]  ${fmtResult(f.oos)}${tag}`);
        }

        console.log('\n=== POOLED OUT-OF-SAMPLE (the honest estimate) ===');
        console.log(`  ${fmtResult(res.oos)}`);
        console.log('\n=== DEPLOY CONFIG (re-tuned on ALL data) — IN-SAMPLE ===');
        console.log(`  ${fmtResult(res.deployResult)}`);

        printTunedParams(res.deploy, res.space);
        console.log('\n=== DEPLOY CONFIG (full) ===');
        console.log(JSON.stringify(res.deploy, null, 2));

        printTradeLog(res.oos.trades, 'POOLED OUT-OF-SAMPLE TRADES');
        printSummary(res.oos, 'POOLED OUT-OF-SAMPLE SUMMARY');

        // Persist the DEPLOY config (re-tuned on all data). bestModel is ranked
        // on the pooled WALK-FORWARD total P&L — real dollars the process made on
        // days it never trained on, walking forward. That is the honest
        // keep-or-discard signal; the shipped config is the all-data retrain the
        // walk-forward vouches for.
        const o = res.oos;
        const metric = o.totalPnl;
        const { becameBest, store, path } = recordModelRun({
          savedAt: new Date().toISOString(),
          source: 'walk-forward pooled totalPnl (out-sample)',
          metric,
          meta: {
            startDate,
            endDate,
            objective,
            mode: 'walk-forward',
            folds: res.folds.length,
            evaluated: res.evaluated,
            deployTrainPnl: res.deployResult.totalPnl,
            deployTrainTrades: res.deployResult.trades.length,
            // Pooled out-of-sample summary — the basis for bestModel ranking.
            oosPnl: o.totalPnl,
            oosTrades: o.trades.length,
            oosWinRate: o.winRate,
            oosProfitFactor: o.profitFactor,
            oosSharpe: o.sharpe,
            oosMaxDrawdown: o.maxDrawdown,
            oosFinalEquity: o.finalEquity,
          },
          config: res.deploy,
        });

        console.log('\n=== MODEL SAVED ===');
        console.log(`  metric (walk-forward pooled totalPnl, out-sample): $${metric.toFixed(2)}`);
        console.log(
          becameBest
            ? '  → saved as lastModel AND bestModel (new best)'
            : `  → saved as lastModel  (best so far: ${(store.bestModel?.metric ?? 0).toFixed(3)})`,
        );
        console.log(`  store: ${path}`);

        printParamsAtLimit(res.deploy, res.space);
      })
    : runTuning({ ...common, trainFraction: num(process.env.TUNE_TRAIN_FRAC, 0.7) }).then((res) => {
        if (!res) {
          console.error('No data — nothing to tune.');
          process.exit(1);
        }

        console.log('\n=== TUNING COMPLETE (single split) ===');
        console.log(`Configs evaluated: ${res.evaluated}`);
        console.log(`Objective:         ${objective}`);
        console.log(`\nIn-sample  (train): ${fmtResult(res.trainResult)}`);
        console.log(`Out-sample (test):  ${fmtResult(res.testResult)}`);

        printTunedParams(res.best, res.space);
        console.log('\n=== BEST CONFIG (full) ===');
        console.log(JSON.stringify(res.best, null, 2));

        console.log('\n=== LEADERBOARD (train objective) ===');
        res.leaderboard.forEach((c, i) => {
          console.log(`  #${(i + 1).toString().padStart(2)}  score=${c.score.toFixed(3)}  ${fmtResult(c.train)}`);
        });

        printTradeLog(res.trainResult.trades, 'WINNING CONFIG — TRAIN TRADES');
        printSummary(res.trainResult, 'WINNING CONFIG — TRAIN SUMMARY');
        printTradeLog(res.testResult.trades, 'WINNING CONFIG — TEST TRADES');
        printSummary(res.testResult, 'WINNING CONFIG — TEST SUMMARY');

        const t = res.testResult;
        const metric = t.totalPnl;
        const { becameBest, store, path } = recordModelRun({
          savedAt: new Date().toISOString(),
          source: 'tune test-slice totalPnl (out-sample)',
          metric,
          meta: {
            startDate,
            endDate,
            objective,
            mode: 'single-split',
            evaluated: res.evaluated,
            trainPnl: res.trainResult.totalPnl,
            trainTrades: res.trainResult.trades.length,
            testPnl: t.totalPnl,
            testTrades: t.trades.length,
            testWinRate: t.winRate,
            testProfitFactor: t.profitFactor,
            testSharpe: t.sharpe,
            testMaxDrawdown: t.maxDrawdown,
            testFinalEquity: t.finalEquity,
          },
          config: res.best,
        });

        console.log('\n=== MODEL SAVED ===');
        console.log(`  metric (test-slice totalPnl, out-sample): $${metric.toFixed(2)}`);
        console.log(
          becameBest
            ? '  → saved as lastModel AND bestModel (new best)'
            : `  → saved as lastModel  (best so far: ${(store.bestModel?.metric ?? 0).toFixed(3)})`,
        );
        console.log(`  store: ${path}`);

        printParamsAtLimit(res.best, res.space);
      });

  run.catch((e) => {
    console.error('Tuning failed:', e);
    process.exit(1);
  });
  }
}
