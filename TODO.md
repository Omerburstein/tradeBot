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

- [x] **4. Make take-profit GEX-relative instead of a fixed 30 pts; skip trades when GEX-derived TP < 20.**
  Replace the hardcoded 30-point take-profit with a target derived from the
  current GEX level. If the GEX-implied take-profit comes out below 20 points,
  skip the trade entirely rather than entering at an unfavourable target.

- [ ] **6. Add separate entry/exit z-score thresholds and include both as tunable parameters.**
  The algo's exit condition should require a z-score strictly below the entry
  z-score threshold (not the same value). Add a distinct `exitZ` parameter
  alongside the existing entry z-score, so the trade exits when signal z drops
  below `exitZ` (which should be less than the entry threshold). Expose both
  `entryZ` and `exitZ` as factors in the tuner so they are optimised together
  during training.

- [x] **7. Record and print the composite z-score at exit as well as at entry.**
  Currently the composite score is only logged as a structured field on the
  ENTRY event. Capture it on the EXIT event too (both in the log and on
  `TradeRecord`) so the trade log shows the composite at entry AND at the
  moment the exit fired, making it easier to see how much the signal decayed
  between the two.

- [ ] **10. Restrict entries to cone breakouts confirmed by gamma direction; exit on cone re-entry, TP, or SL.**
  Only enter a trade when SPX has broken outside the expected-move cone AND the
  net gamma exposure is pointing in the same direction as the breakout (positive
  gamma for upside break, negative gamma for downside break). Exit the trade on
  whichever comes first: (a) SPX re-enters the cone, (b) the take-profit target
  is hit, or (c) the stop-loss is hit.

- [ ] **9. Write documentation explaining the contributors to the composite z-score.**
  Add a written explanation (inline comments in `score-engine.ts` and/or a
  `docs/` file) describing what each of the four z-score contributors represents,
  why it was chosen, how it is computed, and how the weights combine them into
  the composite signal. Should be clear enough that someone unfamiliar with the
  codebase can understand what the composite is measuring and why each factor
  matters.

- [ ] **8. Audit timezone consistency and ensure the algo reads the correct GEX slot.**
  Verify that all timestamps across the algo pipeline (GEX snapshots, ES prices,
  SPX prices, positions) are in the same timezone (ET/UTC-normalised) and that
  comparisons never mix zones. Additionally, confirm that when the algo is at
  decision time T it reads the GEX snapshot whose slot covers [T, T+10min) — for
  example, at 13:10 ET it should use the snapshot captured at the END of the
  13:10–13:20 slot (captured_at = 13:20 ET), not the prior slot or a look-ahead.

- [ ] **5. Gate algo decisions on full data availability (GEX, positions, ES, SPX); log and summarize gaps.**
  The algo must only make entry/exit decisions when all four data sources are
  present for the current slot: GEX (Greeks / gamma-exposure snapshots),
  positions data, ES price, and SPX price. If any one of them is missing,
  emit a structured error rather than proceeding on incomplete information.
  Additionally, write a summary file (e.g. `docs/data-coverage.md` or a DB
  query output) that captures the specs — which tables/columns are required per
  slot, what counts as "present", and which slots currently lack full coverage —
  so the completeness requirements are documented in one place.

## Training / Backtesting

- [x] **11. Add a test-cases file with explained tune decisions and per-case graphs.**
  Create a test cases file the tuner can run against, where for each case the
  tune output explains WHY a trade was taken or skipped (which factors/
  thresholds drove the decision) and plots a graph per example showing the
  relevant params (e.g. composite z-score, GEX, cone, entry/exit levels) over
  time. Add a first test case for 2026-06-10, 11:00–15:00.
  *Done:* `algorithms/test-cases.ts` (`npm run test-cases`) replays each case
  through the SignalGenerator, prints a per-slot explained timeline (factors +
  thresholds + GEX-TP gate behind every entry/exit/missed trigger), and writes a
  dependency-free dual-axis SVG (composite z + gexZ vs spot + cone + entry/exit
  markers) to `docs/test-cases/<id>.svg`. First case `2026-06-10-midday`. See
  `docs/test-cases/README.md`.

- [ ] **2. Feed SPX price data from DB as the signal input for backtest and tune.**
  In both the backtesting and tuning paths, replace any hardcoded or synthetic
  SPX price data with real SPX prices loaded from the DB. The SPX series is the
  data the algo uses to decide whether it wants to trade (entry/exit signal
  input). The loader should query SPX rows aligned to each snapshot's
  `captured_at` slot so the algo can evaluate conditions at the moment of
  decision without look-ahead.

## Data

- [x] **3. Check which dates are missing GEX and positions data (2025-12-29 → today).**
  Audit the DB for coverage gaps between 2025-12-29 and today: find which trading
  days have no GEX (Greeks / gamma-exposure snapshots) and/or no positions data.
  Produce the list of missing dates for each series so the gaps can be
  identified and backfilled.
