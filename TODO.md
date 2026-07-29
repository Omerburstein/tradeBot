# TODO

Backlog of work items. Group: **Algorithm** (`algorithms/`).

> Workflow: pick one task → start a focused chat for it → `npx tsc --noEmit` → commit → push.

## Algorithm

> Items 11–16 come from the MM-exposure mechanism audit in
> [`docs/mm-exposure-model.md`](docs/mm-exposure-model.md) — read §3 there before
> picking one up; the ordering in §5 matters (11 decides the priority of 13/14).

- [ ] **11. Settle the gamma-sign question empirically (read-only analysis, no model change).**
  Three measurements off stored history: (a) the distribution of `sign(gamma)`
  for in-window strikes — is SPX 0DTE persistently one-signed near spot, or does
  the mix vary day to day? (b) group days by `sign(netGex)` at 10:00 and compare
  realized range, |close − open|, and the existing tuned model's PnL per group;
  (c) find slots where spot crosses the zero-gamma `flipStrike` and measure the
  15/30-min realized move after. Shape it like `coverage-report.ts`. Outcome
  decides whether #13 (pin/accel split) is a top priority or theoretical.

- [ ] **12. Capture a 1-min `^VIX` series — PERISHABLE, do this early.**
  Vanna is ∂delta/∂IV and is unusable without an intraday IV series, which is
  why it correctly tests as noise today. Add `^VIX` through the same Yahoo path
  as `^GSPC`/`ES=F` (`scripts/backfill-prices.ts` + `live-prices.ts`). Yahoo
  serves 1-min only ~30 days back (TODO #6), so every uncaptured day is
  permanently lost at that resolution — start the capture *before* deciding
  whether vanna is useful.

- [ ] **13. Add the gamma regime (`netGex` / `flipStrike` / `distToFlip`) as an INTERACTION.**
  The composite is a fixed linear blend of four factors with no interaction term,
  so it cannot express that the same gamma structure implies opposite trades in
  opposite regimes — no re-tune of `wGex` fixes a missing interaction. Compute
  signed `netGex`, the zero-gamma `flipStrike`, and `distToFlip` normalized by
  the cone half-width; use them to modulate `entryThreshold`, to switch the cone
  gate between breakout (short-gamma) and fade (long-gamma), and to feed #15.
  Keep it one continuous signed scalar so the tuner gets a knob, not a cliff.

- [ ] **14. Split GEX into a pin term (positive gamma) and an accelerant term (negative gamma).**
  Positive gamma = attractor, direction = side of spot (what the current
  convention is right for). Negative gamma = amplifier with no inherent
  direction — it should point along the prevailing move, scaled by proximity.
  Today both score identically within 10 % (`positiveGammaBias`), which is the
  direct contradiction of the mechanism. **Contradicts R1/R2** — if the
  head-to-head walk-forward favors the split, rewrite those roles via `/role`
  rather than silently violating them; if it loses, record why in ROLES.md.

- [ ] **15. Regime-condition the risk manager; make stops/window scale-free.**
  `stopLossPoints: 10` and `strikeWindow: 120` are absolute point values in a
  market whose daily range varies ~3×. Scale both by the day's cone half-width,
  then condition on the regime: pinning ⇒ tighter stop, target the
  `callWall`/`putWall` rather than a fixed point count; accelerating ⇒ wider
  stop, smaller size (flat dollar risk), let winners run. Also allow
  `distanceWeightSpan` to go negative so the tuner can choose an ATM-peaked
  distance kernel instead of the hard-coded far-strikes-count-more shape.

- [ ] **16. Revisit charm as a time-of-day interaction; carry the call/put split.**
  Charm is small in the morning and grows sharply into the close, so a plain
  linear 5th factor averages the real afternoon signal with an empty morning and
  tests as noise — the likely reason it was excluded. Enter it as
  `charm × f(time-to-close)`, and only after #13 (its direction is also
  regime-dependent). Separately: `positions` collapses `call_qty + put_qty` then
  takes `abs()`, discarding a split the DB already stores; carry both through
  `StrikeData` and test a signed variant.

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

- [ ] **8. Warm-up: feed GEX/positions from pre-market data, hold derivatives at 0 until warm-up completes.**
  Change the warm-up so that GEX and positions use pre-market data, and the
  derivatives value stays 0 until the warm-up is finished.

- [ ] **9. Remove the first 3 ticks in the pre-market.**
  Drop the first 3 ticks of the pre-market window so the algorithm never sees
  them.

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

- [ ] **10. Coin-flip baseline: is the tuned model better than random entries?**
  Build a random-entry baseline to establish the noise floor the algo must beat.
  Over the same trading days, enter at random times with the same average hold
  duration and the same stop/TP rules, 1 contract, and run it ~200 times to get a
  distribution of PnL rather than a single number. Then compare the tuned model's
  out-of-sample PnL against that distribution. If the model lands in the middle of
  it, the Greeks are contributing nothing and the parameters were never the
  problem — which tells "needs better tuning" apart from "no signal in the data".
  *(User also benchmarks against their own manual trading, but wants these numbers
  for reference.)*

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
