# Algo Knobs — the params you'll play with

**Single source of truth:** [`DEFAULT_CONFIG`](../algorithms/types.ts) in
`algorithms/types.ts`. Change a value there and it flows to every run —
backtest, test-cases, and the tuner (which clones `DEFAULT_CONFIG` for any knob
it doesn't actively sweep).

```
algorithms/types.ts  →  DEFAULT_CONFIG   ← edit these values
                     →  DEFAULT_EQUITY   ← capital account (or override via env)
```

No rebuild step — `tsx` runs the TypeScript directly, so an edit takes effect on
the next `npm run backtest` / `npm run test-cases` / `npm run tune`.

> After editing, always run `npx tsc --noEmit` to catch typos/type errors.

---

## ⭐ The three switches you just set

| Knob | Where | Current | What it does |
|------|-------|---------|--------------|
| `gexAutoExit` | `DEFAULT_CONFIG` | `true` | **ON** = also exit on GEX signal fade / reversal (not just cone / stop / take-profit). Set `false` to hold until a structural exit. |
| `noNewTradesAfterET` | `DEFAULT_CONFIG.risk` | `'14:00'` | **Last entry time.** No new trade is opened at/after this ET wall-clock time. Open positions still manage/exit normally. |
| `trailingStopEnabled` | `DEFAULT_CONFIG.risk` | `false` | **OFF** = only the hard `stopLossPoints` stop applies. Set `true` to re-enable the trailing stop (`trailingStopActivation` / `trailingStopDistance`). |

---

## Full knob reference

### Signal weights (`DEFAULT_CONFIG`) — re-normalized to sum to 1
| Knob | Current | Meaning |
|------|---------|---------|
| `wGex` | `0.45` | Weight on gamma-exposure score |
| `wDGamma` | `0.25` | Weight on gamma rate-of-change |
| `wPositions` | `0.18` | Weight on net MM positions exposure |
| `wDPositions` | `0.12` | Weight on net MM positions rate-of-change |

### Non-linearity / shaping (`DEFAULT_CONFIG`)
| Knob | Current | Meaning |
|------|---------|---------|
| `pGamma` | `1.2` | Exponent on per-strike gamma (>1 emphasizes big readings) |
| `positiveGammaBias` | `1.1` | Extra weight on positive gamma vs negative |
| `pDGamma` | `1.1` | Exponent on gamma change |
| `pPositions` | `0.5` | Exponent on positions (<1 saturates) |
| `pDPositions` | `0.5` | Exponent on positions change |
| `pDistance` | `1.5` | Exponent on strike distance in the distance-weight ramp |
| `distanceWeightSpan` | `2.0` | Span of the distance-weight ramp |
| `positionsGammaGate` | `0.30` | Min gamma strength (0–1) for a strike's positions to count |
| `zClamp` | `3.5` | Hard cap on each factor z-score (and the composite) |

### Entry / exit thresholds (`DEFAULT_CONFIG`)
| Knob | Current | Meaning |
|------|---------|---------|
| `entryThreshold` | `1.5` | Composite z needed for an **outside-cone** (gamma-aligned breakout) entry |
| `strongEntryThreshold` | `2.0` | Composite z needed for an **inside-cone** entry (higher bar) |
| `conePassBonus` | `0.25` | Threshold discount on the **first** tick of a gamma-aligned cone pass — lowers the outside-cone bar to `entryThreshold − conePassBonus` for that tick. `0` disables it. |
| `exitFadeThreshold` | `0.5` | Directional z below which a position exits (fade) — only if `gexAutoExit` |
| `reversalThreshold` | `1.0` | Opposing-direction z that forces an exit — only if `gexAutoExit` |
| `gexAutoExit` | `true` | Master switch for the two GEX-driven exits above |

**Cone-threshold entry rule (TODO #9, default mode):** the cone state picks the
bar the composite z must clear.
- **Outside the cone** → `entryThreshold`, but only when gamma agrees with the
  side: **above the cone + gamma up (`gexZ > 0`) → long**, **below the cone +
  gamma down (`gexZ < 0`) → short**. A breakout against the gamma direction never
  triggers.
- **Inside the cone** → the higher `strongEntryThreshold`, taken in the
  composite's direction.
- The first tick of a gamma-aligned pass discounts the outside bar by
  `conePassBonus`. The cone does **not** drive exits in default mode.

### Window / stats (`DEFAULT_CONFIG`)
| Knob | Current | Meaning |
|------|---------|---------|
| `strikeWindow` | `120` | Only consider strikes within ±this many pts of spot |
| `zScoreLookback` | `20` | Number of past snapshots for the z-score baseline |

### Cone-breakout mode (`DEFAULT_CONFIG.coneBreakout`)
A distinct entry/exit regime, **off by default**. When `enabled`, it *replaces*
the default entry and exit rules (see below) — it does not stack on them. Set
`enabled: true` for cone-only trading (TODO #3 — enter only on a gamma-confirmed
cone breakout).
| Knob | Current | Meaning |
|------|---------|---------|
| `enabled` | `false` | Master switch. On → cone-only breakout rules. Off → default rules. |
| `exitOnConeReEntry` | `true` | Exit when SPX crosses back inside the cone through the relevant line |
| `exitOnTp` | `true` | Exit when the GEX take-profit target is hit |
| `exitOnSl` | `true` | Exit when the hard stop-loss is hit |

**When `enabled: true`:**
- **Entry** — only on a break through the *direction-relevant* cone line, confirmed by gamma direction:
  - **Long:** SPX breaks **above the upper** cone line **and** gamma points up (`gexZ > 0`)
  - **Short:** SPX breaks **below the lower** cone line **and** gamma points down (`gexZ < 0`)
  - Breaking the wrong line never triggers; there are **no inside-cone entries**.
- **Exit** — whichever of the three toggles above fires first, **plus** the always-on forced end-of-day exit (`forcedExitByET`). The GEX signal-fade / reversal exits (`gexAutoExit`) do **not** apply in this mode.
- Pre-entry gates still apply: `noNewTradesAfterET`, daily limits, and the `minGexTakeProfitPoints` floor.

> "Gamma points up/down" = the sign of `gexZ`, the directional gamma-exposure
> z-score (positive = net upward gamma pressure). Tell me if you'd rather gate
> on raw GEX or on `dGammaZ` instead — it's a one-line change.

### Risk / money management (`DEFAULT_CONFIG.risk`)
| Knob | Current | Meaning |
|------|---------|---------|
| `maxPositionSize` | `2` | Max contracts per trade |
| `accountEquity` | `50_000` | Equity used **only** for position sizing (not the capital account) |
| `maxRiskPerTrade` | `0.01` | Fraction of equity risked per trade |
| `stopLossPoints` | `10` | Hard stop distance (SPX pts) from entry |
| `riskRewardRatio` | `3` | Fallback take-profit = `stopLossPoints × this` when no gamma in window |
| `minGexTakeProfitPoints` | `15` | Skip entries whose GEX take-profit (gamma-center distance) is below this |
| `trailingStopEnabled` | `false` | Master switch for the trailing stop |
| `trailingStopActivation` | `5` | Profit (pts) to arm the trailing stop *(ignored while disabled)* |
| `trailingStopDistance` | `7` | Distance (pts) the trailing stop trails behind the high-water mark *(ignored while disabled)* |
| `maxDailyLoss` | `0.02` | Max daily loss as a fraction of equity |
| `maxTradesPerDay` | `6` | Max round-trip trades per day |
| `slippagePerSide` | `0.50` | Assumed slippage per side (SPX pts) |
| `pointValue` | `50` | USD P&L per 1.0 point, per contract (/ES e-mini) |
| `noNewTradesAfterET` | `'14:00'` | Last entry time (ET) — no new trades at/after this |
| `forcedExitByET` | `'15:50'` | All positions flat by this ET time |

### Capital account — [`DEFAULT_EQUITY`](../algorithms/types.ts)
The real cash balance for a run (separate from `risk.accountEquity`, which only
sizes positions). Overridable per-run via env vars without editing code.
| Knob | Current | Env override |
|------|---------|--------------|
| `initialCapital` | `100_000` | `INITIAL_CAPITAL` |
| `equityFloor` | `98_000` | `EQUITY_FLOOR` — run fails the instant equity touches it |

---

## How exits work (so `gexAutoExit` makes sense)

A position is closed by the **first** of these to fire, checked every slot:

1. **Forced time exit** — past `forcedExitByET` *(always on)*
2. **Hard stop-loss** — `stopLossPoints` against you *(always on)*
3. **Trailing stop** — only if `trailingStopEnabled`
4. **Take-profit** — GEX target (gamma-center distance frozen at entry) *(always on)*
5. **Signal fade** — directional z < `exitFadeThreshold` — **only if `gexAutoExit`**
6. **Reversal** — directional z < −`reversalThreshold` — **only if `gexAutoExit`**

So `gexAutoExit: false` removes #5 and #6, leaving the structural/risk exits.
(Since TODO #9, the cone no longer forces an exit in default mode — it only
selects the entry threshold. Cone re-entry exits are cone-breakout mode only.)

**In cone-breakout mode** (`coneBreakout.enabled: true`) this list is replaced by:
the forced time exit (#1, always) plus only the enabled `coneBreakout` toggles —
`exitOnSl` (stop-loss), `exitOnTp` (take-profit), `exitOnConeReEntry` (cone
re-entry). Signal fade / reversal do not apply.

---

## Tuner note

The tuner (`npm run tune`) sweeps the numeric knobs in `DEFAULT_SEARCH_SPACE`
([`algorithms/tuner.ts`](../algorithms/tuner.ts)). Any knob **not** in that
search space is taken straight from `DEFAULT_CONFIG` — so the three switches
above stay at the values you set here during tuning.

**Search strategy: CMA-ES.** The optimizer is a Covariance Matrix Adaptation
Evolution Strategy — a derivative-free method suited to this black-box,
non-differentiable objective (the backtest makes discrete trade decisions, so
there is no usable gradient). Each generation samples a population from a
multivariate Gaussian, keeps the best half, moves the mean toward their weighted
average, and adapts both the step size and the full covariance so the search
cloud stretches along the directions that actually improve P&L. To avoid getting
trapped in one basin on a multi-modal landscape it runs several independent
restarts (`TUNE_RESTARTS`, default 3; the first seeded at `DEFAULT_CONFIG`, the
rest random) and keeps the global best. Set `TUNE_SEED` for fully reproducible
runs. The total evaluation budget is `TUNE_ITERS + TUNE_REFINE` (split across
restarts); `TUNE_POP` overrides the population size λ and `TUNE_SIGMA` the
initial step size.

`gexAutoExit` is currently commented out of the search space (pinned to the
`DEFAULT_CONFIG` value). To let the tuner explore both exit styles again,
uncomment its line in `DEFAULT_SEARCH_SPACE`.
