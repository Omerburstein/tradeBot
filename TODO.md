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

- [x] **9. Change `LOOKAHEAD_GREEKS_FROM_SLOT_START` default to `true`.**
  Flip the default value of `LOOKAHEAD_GREEKS_FROM_SLOT_START` from `false`
  to `true` so the setting is on out of the box without requiring an explicit
  env override.
  *Done:* `data-loader.ts` now reads the flag as `(env ?? 'true') !== 'false'`,
  so applying each Greek slot from its START is on by default and `=false` is the
  explicit opt-out (verified: on with no env set, off under `=false`). Comments in
  `data-loader.ts` and the timing section of `docs/timezone-audit.md` updated to
  reflect that this is the **causal** timing: UW publishes each frame's Greeks at
  the frame START, and the slot END is only UW's label/timestamp — so applying
  from the START is live-realistic, NOT a look-ahead. Removed the incorrect
  `not live-realistic` warning that a prior draft added (it misread UW's end-label
  as end-publication). The env var keeps its historical `LOOKAHEAD_…` name.

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

- [x] **4. Write documentation explaining the contributors to the composite z-score.**
  Add a written explanation (inline comments in `score-engine.ts` and/or a
  `docs/` file) describing what each of the four z-score contributors represents,
  why it was chosen, how it is computed, and how the weights combine them into
  the composite signal. Should be clear enough that someone unfamiliar with the
  codebase can understand what the composite is measuring and why each factor
  matters.
  *Done:* `docs/composite-score.md` — a from-scratch walkthrough of the composite
  (sign/direction convention, the shared per-strike building blocks — distance
  weight, gamma gate, non-linear shaping — each of the four contributors' meaning/
  rationale/formula, the same-day rolling z-score normalization + clamp, how the
  weights combine, how it's consumed by the entry/exit gates, and a default-params
  table). `score-engine.ts` header now points to it.

- [x] **5. Audit timezone consistency and ensure the algo reads the correct GEX slot.**
  Verify that all timestamps across the algo pipeline (GEX snapshots, ES prices,
  SPX prices, positions) are in the same timezone (ET/UTC-normalised) and that
  comparisons never mix zones. Additionally, confirm that when the algo is at
  decision time T it reads the GEX snapshot whose slot covers [T, T+10min) — for
  example, at 13:10 ET it should use the snapshot captured at the END of the
  13:10–13:20 slot (captured_at = 13:20 ET), not the prior slot or a look-ahead.
  *Done:* full audit in `docs/timezone-audit.md`. Storage (UTC TIMESTAMPTZ) +
  loader joins (exact UTC-ISO captured_at; cone/day by ET date) were already
  correct; slot alignment confirmed (algo uses the most-recently-closed slot at
  its end instant, look-ahead-guarded). Fixed the two CT holdovers — the
  `checkTimeGates` gate and the cone's `minutesUntilClose` — to ET
  (behaviour-preserving, same instants); config fields renamed
  `noNewTradesAfterCT`/`forcedExitByCT` → `…ET` (15:40 / 15:50). Pipeline now
  speaks only UTC (storage) + ET (wall-clock).

- [x] **6. Gate algo decisions on full data availability (GEX, positions, ES, SPX); log and summarize gaps.**
  The algo must only make entry/exit decisions when all four data sources are
  present for the current slot: GEX (Greeks / gamma-exposure snapshots),
  positions data, ES price, and SPX price. If any one of them is missing,
  emit a structured error rather than proceeding on incomplete information.
  Additionally, write a summary file (e.g. `docs/data-coverage.md` or a DB
  query output) that captures the specs — which tables/columns are required per
  slot, what counts as "present", and which slots currently lack full coverage —
  so the completeness requirements are documented in one place.
  *Done:* `algorithms/data-coverage.ts` is the single source of truth for the
  four required sources + the "present" rule per source; `assessCoverage` is
  enforced as step 0 of `SignalGenerator.processSnapshot` — an incomplete slot
  emits a structured `DATA_GAP` error (level 50) and holds, never scoring,
  trading, or advancing the z-score baseline (gaps collected via `getDataGaps`).
  The loader now stamps per-source `present` flags on every slot/tick and — a
  prerequisite for a meaningful positions gate — loads net MM positions from the
  real `positions` table (call_qty+put_qty); they were silently always 0 before
  because the loader queried a non-existent `positions` panel on
  `periscope_snapshots`. `algorithms/coverage-report.ts` (`npm run coverage`)
  queries the DB and (re)generates `docs/data-coverage.md` with the spec table +
  current per-day gaps. Current state: 740/779 June gamma slots fully covered;
  only 2026-06-29 lacks ES (ingest lag).
  *Note:* wiring real positions into the score changes composite/backtest
  numbers (positions carry ~30% of the default weight) — retune as needed.

## Training / Backtesting

- [ ] **7. Feed SPX price data from DB as the signal input for backtest and tune.**
  In both the backtesting and tuning paths, replace any hardcoded or synthetic
  SPX price data with real SPX prices loaded from the DB. The SPX series is the
  data the algo uses to decide whether it wants to trade (entry/exit signal
  input). The loader should query SPX rows aligned to each snapshot's
  `captured_at` slot so the algo can evaluate conditions at the moment of
  decision without look-ahead.

## Data

## Scraper

- [ ] **8. Change the scraper to capture data every minute (page layout changed — review it first).**
  Change the scraper so it takes the data every one minute instead of the
  current 10-minute cadence. IMPORTANT: the Unusual Whales Periscope page has
  changed — before making any changes, go over the current page thoroughly
  (selectors, panel layout, timeframe widget, API responses) to make sure you
  know exactly how it looks now, so the capture/parse logic is updated against
  the real current structure rather than the old assumptions.
