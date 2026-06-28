# TODO

Backlog of work items. Group: **Algorithm** (`algorithms/`).

> Workflow: pick one task → start a focused chat for it → `npx tsc --noEmit` → commit → push.

## Algorithm

- [x] **5. Enforce a minimum take-profit of 10 points per trade.**
  Only take trades whose take-profit target is at least 10 points.
  *Done: `minTakeProfitPoints` config (default 10) in `types.ts`;
  `takeProfitTargetPoints` / `meetsMinTakeProfit` helpers in `risk-manager.ts`;
  `signal-generator.ts` blocks entries when the target
  (stopLossPoints × riskRewardRatio) falls below the floor.*

- [ ] **6. Make next-day (1DTE) strikes less relevant than current-day (0DTE) strikes (factor ≥ 0.5).**
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

- [ ] **7. Train the algorithm on historical data pulled from the DB.**
  Add a way for the algorithm to train/backtest against historical snapshots
  read from the DB (replay the stored slots chronologically and run the strategy
  over them).

- [ ] **8. Optimize parameters to maximize profit across the data.**
  Have the training run search/tune the strategy params so it maximizes total
  profit over the historical dataset.

- [ ] **9. Start with $100,000 capital and a hard stop-loss at $98,000.**
  Seed each training run with $100,000 of initial capital and a $2,000 max
  drawdown stop: if equity drops to $98,000 (i.e. $2,000 lost), the run is a
  failure and the params must be changed.
