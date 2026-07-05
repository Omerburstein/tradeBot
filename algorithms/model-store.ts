/**
 * Persistent record of tuned models.
 *
 * Every `npm run tune` invocation records the winning config plus the metric it
 * was ranked on (the tuner's objective, evaluated out-of-sample). Two slots are
 * kept in `algorithms/tuned-models.json`:
 *
 *   - `lastModel` — always overwritten with the most recent tune run.
 *   - `bestModel` — the run with the highest `metric` seen so far.
 *
 * This lets a tuning session keep the previously-tuned config and the best
 * config found without re-deriving them.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AlgoConfig } from './types.js';

export interface ModelRecord {
  /** ISO-8601 UTC timestamp of when the run was recorded. */
  savedAt: string;
  /** How the metric was produced, e.g. "tune totalPnl (out-sample)". */
  source: string;
  /** Scalar used to rank `bestModel` (higher is better). */
  metric: number;
  /** Free-form context (date range, objective, trade counts, …). */
  meta?: Record<string, unknown>;
  /** The full winning config. */
  config: AlgoConfig;
}

export interface ModelStore {
  lastModel: ModelRecord | null;
  bestModel: ModelRecord | null;
}

function storePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, 'tuned-models.json');
}

export function loadModelStore(): ModelStore {
  const p = storePath();
  if (!existsSync(p)) return { lastModel: null, bestModel: null };
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as Partial<ModelStore>;
    return { lastModel: parsed.lastModel ?? null, bestModel: parsed.bestModel ?? null };
  } catch {
    // Corrupt/hand-edited store — start fresh rather than crash the run.
    return { lastModel: null, bestModel: null };
  }
}

export function saveModelStore(store: ModelStore): string {
  const p = storePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(store, null, 2) + '\n', 'utf8');
  return p;
}

/**
 * Record a completed tune run. Always overwrites `lastModel`. Updates
 * `bestModel` when this run's `metric` beats the stored best (or there is no
 * best yet). A non-finite metric never becomes best.
 */
export function recordModelRun(record: ModelRecord): {
  store: ModelStore;
  becameBest: boolean;
  path: string;
} {
  const store = loadModelStore();
  store.lastModel = record;

  const best = store.bestModel;
  const bestMetric =
    best && Number.isFinite(best.metric as number) ? best.metric : Number.NEGATIVE_INFINITY;
  const becameBest = Number.isFinite(record.metric) && record.metric > bestMetric;
  if (becameBest) store.bestModel = record;

  const path = saveModelStore(store);
  return { store, becameBest, path };
}
