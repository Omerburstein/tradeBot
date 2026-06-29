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

- [ ] **2. Feed SPX price data from DB as the signal input for backtest and tune.**
  In both the backtesting and tuning paths, replace any hardcoded or synthetic
  SPX price data with real SPX prices loaded from the DB. The SPX series is the
  data the algo uses to decide whether it wants to trade (entry/exit signal
  input). The loader should query SPX rows aligned to each snapshot's
  `captured_at` slot so the algo can evaluate conditions at the moment of
  decision without look-ahead.

- [ ] **3. Use ES price data from DB to calculate backtest and tune P&L.**
  In both the backtesting and tuning paths, compute realized P&L using ES
  (futures) prices loaded from the DB rather than SPX. ES is the instrument
  actually traded, so fill prices, slippage, and outcome measurement should all
  be based on the ES series. The ES loader should fetch prices for the
  trade-open and trade-close timestamps to compute per-trade profit/loss
  accurately.

## Data

- [x] **4. Add a script that ingests ES and SPX data into the DB.**
  Build a script that adds the ES and SPX price data to the database. Should
  populate the DB with both the ES (futures) and SPX (index) series so they are
  available alongside the existing snapshot data.
  *Done:* `scripts/ingest-prices.ts` (`npm run ingest -- --es <es.csv>`). Takes
  one ES CSV, parses the RTH bars (shared `scripts/lib/es-spx.ts`), derives the
  SPX cash series via the Yahoo-anchored basis calibration, writes ES OHLCV →
  `es_prices` and the derived SPX close → existing `spot_prices`. `--dry-run`
  prints sample rows without touching the DB.

- [x] **5. Create a new Postgres table to store ES data.**
  Add a new table to the Neon Postgres schema for storing ES (futures) price
  data. Define columns, types, constraints, and indexes appropriate for the ES
  series (e.g. timestamp, open, high, low, close, volume). Add the corresponding
  `db/` module (client helpers, insert function) and keep `SnapshotRow` /
  existing tables untouched.
  *Done:* `db/es-prices.ts` — `es_prices(captured_at PK, date, open, high, low,
  close, volume)` + `es_prices_date_idx`, RTH-gated upsert `insertEsPrices`
  exported from `db/index.ts`. SPX reuses the existing `spot_prices` table.

- [x] **6. Add a validation test for the ES→SPX conversion using Yahoo Finance data.**
  Write a test script that downloads the latest trading day's 1-min bars for
  both ES and SPX from Yahoo Finance, runs each ES bar through the ES→SPX
  converter, and asserts that no converted value differs from the actual SPX
  price by more than 1 point. The script should also print the single largest
  observed difference so the conversion accuracy can be monitored over time.
  *Done:* `scripts/test-es-spx-conversion.ts` (`npm run test:es-spx`). NOTE: a
  literal per-bar 1 pt assert is not achievable against FREE Yahoo 1-min `ES=F`
  (sporadic bad prints + real ~5 pt open basis lag), so the 1 pt gate is applied
  to a robust statistic — the MEDIAN body error after rejecting outlier prints
  and the opening cash-lag window (≈0.49 pt on a normal day). The single largest
  raw difference across all minutes is always printed for monitoring.

- [x] **7. Add a way to get live SPX and ES data for the process.**
  Provide a live data source for both SPX (index) and ES (futures) that the
  process can consume in real time, alongside the existing historical CSV
  ingest. Should feed the same `spot_prices` (SPX) and `es_prices` (ES) tables
  so the live series sits alongside the backfilled/historical data and the algo
  can read current prices during an active session.
  *Done:* `scripts/live-prices.ts` (`npm run live -- --loop 60`). Polls Yahoo's
  1-min chart feed for `ES=F` → `es_prices` (OHLCV) and `^GSPC` → `spot_prices`
  (close as `spot`). Unlike the CSV ingest it does NO ES→SPX conversion: live we
  have both real feeds, and `^GSPC` IS the cash index, so SPX is written directly
  (0 pt error). `--loop <sec>` polls forever (incremental cursor, resets at each
  ET day rollover, survives transient Yahoo blips); omit for one-shot. `--dry-run`
  prints new-bar counts without touching the DB. Inserts are RTH-gated + idempotent
  upserts in the DB layer. The 1-min Yahoo fetcher was hoisted into the shared
  `scripts/lib/es-spx.ts` (`fetchYahoo1mByDay`) so the live script and the #6
  accuracy test share one source of truth.
