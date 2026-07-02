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

- [ ] **2. Add separate entry/exit z-score thresholds and include both as tunable parameters.**
  The algo's exit condition should require a z-score strictly below the entry
  z-score threshold (not the same value). Add a distinct `exitZ` parameter
  alongside the existing entry z-score, so the trade exits when signal z drops
  below `exitZ` (which should be less than the entry threshold). Expose both
  `entryZ` and `exitZ` as factors in the tuner so they are optimised together
  during training.

- [ ] **3. Restrict entries to cone breakouts confirmed by gamma direction; exit on cone re-entry, TP, or SL.**
  Only enter a trade when SPX has broken outside the expected-move cone AND the
  net gamma exposure is pointing in the same direction as the breakout (positive
  gamma for upside break, negative gamma for downside break). Exit the trade on
  whichever comes first: (a) SPX re-enters the cone, (b) the take-profit target
  is hit, or (c) the stop-loss is hit.

## Training / Backtesting

- [ ] **4. Feed SPX price data from DB as the signal input for backtest and tune.**
  In both the backtesting and tuning paths, replace any hardcoded or synthetic
  SPX price data with real SPX prices loaded from the DB. The SPX series is the
  data the algo uses to decide whether it wants to trade (entry/exit signal
  input). The loader should query SPX rows aligned to each snapshot's
  `captured_at` slot so the algo can evaluate conditions at the moment of
  decision without look-ahead.

## Data

## Scraper

- [ ] **5. Change the scraper to capture data every minute (page layout changed — review it first).**
  Change the scraper so it takes the data every one minute instead of the
  current 10-minute cadence. IMPORTANT: the Unusual Whales Periscope page has
  changed — before making any changes, go over the current page thoroughly
  (selectors, panel layout, timeframe widget, API responses) to make sure you
  know exactly how it looks now, so the capture/parse logic is updated against
  the real current structure rather than the old assumptions.
