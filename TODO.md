# TODO

Backlog of work items. Group: **Algorithm** (`algorithms/`).

> Workflow: pick one task → start a focused chat for it → `npx tsc --noEmit` → commit → push.

## Algorithm

- [ ] **1. Make next-day (1DTE) strikes less relevant than current-day (0DTE) strikes (factor ≥ 0.5).**
  Down-weight next-day strikes relative to current-day strikes by a factor of at
  least 0.5 (next-day counts at most half as much).
  *Context:* the scraper stores **two expiries per session** (`orchestrate.ts`
  Pass 1 = session-day/0DTE, Pass 2 = `nextTradingDay()`/1DTE), but the algorithm
  only loads one expiry — `data-loader.ts` `loadDay()` filters `WHERE expiry = $1`,
  and `score-engine.ts` scores a single `Snapshot`'s strikes (one expiry). So
  next-day strikes are never combined into the score today. Implementing this
  needs: (a) load both the 0DTE and same-session 1DTE strikes per `captured_at`
  slot, tagging which expiry each strike belongs to, and (b) multiply each
  next-day strike's contribution in `computeScore` by a weight (suggest a
  configurable `nextDayWeight`, default 0.5). Open design question: merge strikes
  per slot and down-weight (most faithful) vs. score the two expiries separately
  and blend composites.

## Training / Backtesting

- [x] **2. No look-ahead: the algo sees only the current frame and earlier ones.**
  During backtest/training the strategy must only ever see one slot at a time
  plus the slots that came before it — never any future data. Enforce strictly
  causal replay (feed snapshots one `captured_at` at a time, in order) so no
  decision can peek at slots that haven't happened yet.
  *Done* — `simulate()` now explicitly sorts each day's snapshots by `capturedAt`
  before processing (safe even if input arrives unordered); `SignalGenerator.processSnapshot()`
  throws a `Look-ahead violation` error if a snapshot arrives out of chronological order.
