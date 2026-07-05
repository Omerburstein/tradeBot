/**
 * Persistent record of test-case model runs (TODO: model bookkeeping).
 *
 * Every `npm run test-cases` invocation records the config it replayed under
 * plus that run's test-trade net P&L. Two slots are kept in
 * `algorithms/test-case-models.json`:
 *
 *   - `lastModel` — always overwritten with the most recent run.
 *   - `bestModel` — the config with the highest test-trade net P&L seen so far,
 *     compared only against runs that replayed the *same* set of cases (so the
 *     metric is apples-to-apples).
 *
 * This lets a tuning session keep the previously-tested config and the best
 * config found without re-deriving them.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AlgoConfig } from './types.js';

export interface ModelRecord {
  /** ISO-8601 UTC timestamp of when the run was recorded. */
  savedAt: string;
  /** Test-case ids that produced `netPnl` (sorted). */
  cases: string[];
  /** Sum of in-window trade P&L (USD) across `cases`. */
  netPnl: number;
  /** Number of in-window trades that contributed to `netPnl`. */
  tradeCount: number;
  /** The full resolved config that was replayed. */
  config: AlgoConfig;
}

export interface ModelStore {
  lastModel: ModelRecord | null;
  bestModel: ModelRecord | null;
}

function storePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, 'test-case-models.json');
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
 * Record a completed test-case run. Always overwrites `lastModel`. Updates
 * `bestModel` when this run beats the stored best by `netPnl` and replayed the
 * same set of cases — or when there is no best yet.
 */
export function recordModelRun(record: ModelRecord): {
  store: ModelStore;
  becameBest: boolean;
  path: string;
} {
  const normalized: ModelRecord = { ...record, cases: [...record.cases].sort() };
  const store = loadModelStore();
  store.lastModel = normalized;

  const best = store.bestModel;
  const comparable = !best || sameCases(best.cases, normalized.cases);
  const becameBest = comparable && (!best || normalized.netPnl > best.netPnl);
  if (becameBest) store.bestModel = normalized;

  const path = saveModelStore(store);
  return { store, becameBest, path };
}

function sameCases(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}
