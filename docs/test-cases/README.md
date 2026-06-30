# Algorithm test cases (TODO #11)

Curated date + intraday-window scenarios the algo is replayed against, with an
**explained** decision timeline and a **per-case graph**. Defined and run by
[`algorithms/test-cases.ts`](../../algorithms/test-cases.ts).

## Run

```bash
npm run test-cases                              # every case, DEFAULT_CONFIG
TEST_CASE_ID=2026-06-10-midday npm run test-cases   # one case
```

(Needs `DATABASE_URL` in `.env` — the same DB the backtest/tuner read.)

## What you get

1. **Explained timeline** (stdout): for every slot in the window, the spot,
   composite z-score, `gexZ`/`dGammaZ`, cone state and the action taken. Every
   entry, exit, or *missed* trigger (a cone pass that was rejected, or an entry
   skipped by the GEX-TP gate) is expanded with the factors and thresholds that
   drove it — composite vs entry/strong thresholds, the dGamma confirmation, the
   cone band, and the GEX take-profit gamma-center distance vs `minGexTakeProfitPoints`.

2. **Graph** `docs/test-cases/<id>.svg` (dependency-free SVG): composite z-score
   and `gexZ` on the left axis; spot price, cone bands, and entry▲/▼ + exit✕
   markers on the right axis; entry/strong/zero threshold guide lines. Open it in
   a browser or VS Code.

The full trading day is fed to the signal generator so the z-score lookback and
cone crossing-state are built correctly; only the in-window slots are reported
and plotted.

> The generated `*.svg` files are run artifacts — regenerate with `npm run test-cases`.

## Cases

| id | day | window (ET) | illustrates |
|----|-----|-------------|-------------|
| `2026-06-10-midday` | 2026-06-10 | 11:00–15:00 | midday composite-z / GEX / cone interplay |

Add a case by appending to `TEST_CASES` in `algorithms/test-cases.ts`.
