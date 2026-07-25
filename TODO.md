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

- [ ] **7. Fix the derivatives issues.**
  Fix the outstanding issues with the algorithm's derivatives (the
  dGamma/dPositions rate-of-change and momentum terms). *(Underspecified — flag
  the specific derivatives and the observed problem before implementing; ask the
  user for details.)*

## Training / Backtesting

- [ ] **2. Feed SPX price data from DB as the signal input for backtest and tune.**
  In both the backtesting and tuning paths, replace any hardcoded or synthetic
  SPX price data with real SPX prices loaded from the DB. The SPX series is the
  data the algo uses to decide whether it wants to trade (entry/exit signal
  input). The loader should query SPX rows aligned to each snapshot's
  `captured_at` slot so the algo can evaluate conditions at the moment of
  decision without look-ahead.

- [ ] **3. Measure correlation between the 30 min pre-open window and the first 10 min after open.**
  Check the correlation between the 30 minutes before market open (the pre-bell
  active polling window, ~09:00–09:30 ET) and the 10 minutes after the open
  (~09:30–09:40 ET). Determine whether pre-open Greek/positioning signals predict
  the opening move, so we know if the early window carries usable signal for the
  algo.

## Data

- [ ] **4. Migrate persistence from Neon Postgres to CockroachDB Serverless.**
  Move the database layer off Neon Postgres onto CockroachDB Serverless. This
  spans everything under `db/` (client connection, batch inserts, `ON CONFLICT`
  idempotency, the `(captured_at, expiry, panel, strike)` unique constraint) plus
  the `DATABASE_URL` / `STAGING_DATABASE_URL` env wiring and the Railway
  deployment config. Verify CockroachDB's Postgres-wire compatibility with the
  `@neondatabase/serverless` client (may need swapping to a standard `pg`/driver),
  confirm `TIMESTAMPTZ` and the batch-insert paths behave identically, and plan a
  data copy/backfill from the existing Neon branch. Both the scraper (writer) and
  the algorithm (reader) depend on this schema, so validate both paths after
  cutover.

- [x] **6. Replace the massive (I:SPX) spot data source with Yahoo Finance.** ✅
  Ripped out the I:SPX spot pipeline (`scripts/fetch_spx.py` + `scripts/ingest-spx.ts`
  + the `ingest-spx` npm script + code comments pointing at them). Backfill spot now
  comes solely from Yahoo `^GSPC` via `scripts/backfill-prices.ts` (already wired to
  `spot_prices`, same `captured_at` alignment); the live tick keeps writing its
  page-header spot. **Massive fully removed:** `fetch_es.py` and `fetch_spy.py` (the
  last massive SDK users) and the `MASSIVE_API_KEY` env key are also gone — ES now
  comes from Yahoo `ES=F` via `backfill-prices.ts`/`live-prices.ts`. The ES→SPX CSV
  *conversion* tooling (`es-to-spx.ts`, `ingest-prices.ts`, `test-es-spx-conversion.ts`,
  `lib/es-spx.ts`) is kept — it doesn't use massive and is the manual deep-history
  fallback (feed it a CSV from any source). **Trade-off accepted:** Yahoo 1-min only
  reaches ~30 days back for BOTH `ES=F` and `^GSPC`, so 1-min ES/SPX older than that
  can no longer be re-fetched from source (existing DB rows are untouched).

## Scraper

- [ ] **5. Add a Market Tide backfill scraping mechanism.**
  Add a scraping path for Market Tide, found in the left menu under the **Market**
  option → **Market Tide** window. Scrape all available dates of the market tide
  history from there. This should run **only during backfill** (not on the live
  per-minute tick). Scrape **both the OTM and the ALL options** views of the
  market tide. *(User offered to give further guidance if needed — ask before
  implementing if the endpoint/date-range details are unclear.)*
