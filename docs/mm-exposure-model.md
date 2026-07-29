# Market-Maker Exposure — the mechanism, and what our model does with it

Source: Unusual Whales' own description of the Periscope *SPX Market Maker
Exposure* charts (the data this repo scrapes). This doc turns that description
into precise statements, then audits
[`algorithms/score-engine.ts`](../algorithms/score-engine.ts) against them.

It is the **domain reference**; [`docs/composite-score.md`](composite-score.md)
describes what the code does today, and [`algorithms/ROLES.md`](../algorithms/ROLES.md)
states the rules the code must obey. Where this doc disagrees with those, the
disagreement is the point — see §3.

---

## 1. The mechanism, stated exactly

**The naive delta-hedging model.** MMs take the other side of customer flow,
accumulate an option inventory they did not choose, and neutralize its
directional risk by trading **ES futures**. Their hedging is therefore a
mechanical, price-triggered order flow — not a view. This is the entire basis of
the signal: we are not predicting what anyone *thinks*, we are predicting a
**forced order flow** that fires when price reaches certain strikes.

**Gamma = how fast that forced flow changes with price.** Larger |gamma| at a
strike ⇒ more hedging per point of price move near that strike ⇒ stronger effect
on price.

**The sign of gamma decides the *direction of the mechanism*, and it is the whole
ballgame:**

| MM net gamma at a strike | MMs are | They hedge | Effect on price near that strike |
|---|---|---|---|
| **Positive** (customers net *sold* options) | long options | **against** the move — sell rallies, buy dips | **Damping / pinning.** Price is *attracted* to the strike; realized vol suppressed |
| **Negative** (customers net *bought* options, puts **or** calls) | short options | **with** the move — buy rallies, sell dips | **Amplifying.** Price is *repelled*, moves accelerate through; vol expands |

Two consequences that the prose states explicitly and that are easy to get wrong:

- **Gamma sign says nothing about customer bullishness.** Customers buying puts
  and customers buying calls both leave the MM short gamma. Put-vs-call is
  irrelevant *to gamma*. Do not read negative gamma as bearish.
- **"Support/resistance" is conditional on the sign.** A large-gamma strike is a
  support/resistance *zone* only under **positive** gamma. Under **negative**
  gamma the same concentration is a **trapdoor**: price entering it is pushed
  further, not held back.

**Therefore a high-gamma strike has no fixed directional meaning.** Its meaning
is `sign(gamma) × (where price is relative to it) × (which way price is already
moving)`. A negative-gamma wall is not "fuel for a move toward it"; it is an
accelerant for whatever move is already underway.

### 1.1 Derived quantities the mechanism implies

These are all computable from data already in the DB (`periscope_snapshots`
gamma panel + `spot_prices`), and none of them exist in the code today.

```
netGex(t)      = Σ_strikes gamma(k, t)                       // signed, not |·|
flipStrike(t)  = the k where Σ_{j ≤ k} gamma(j, t) crosses 0 // "zero-gamma level"
distToFlip(t)  = (spot − flipStrike) / coneHalfWidth         // in expected-move units
callWall(t)    = argmax_{k > spot} gamma(k, t)   subject to gamma > 0
putWall(t)     = argmax_{k < spot} gamma(k, t)   subject to gamma > 0
```

- **`netGex` sign = the day's regime.** Net positive ⇒ mean-reverting, pinned,
  low realized vol, fade the edges. Net negative ⇒ trending, vol-expansionary,
  breakouts follow through, stops get run.
- **`flipStrike`** is the regime boundary *in price space*. Spot crossing it is a
  regime change, and the crossing itself is usually the most violent part of the
  day. `distToFlip` is a continuous version — normalized by the cone
  (`cone_snapshots` already gives the day's expected move) so it is comparable
  across quiet and wild days.
- **Walls** are actionable levels only in the positive-gamma regime; in the
  negative regime the same computation produces the *opposite* trade.

---

## 2. What the score engine does with all of this today

The composite is a fixed linear blend of four factors
(`0.45·gexZ + 0.25·dGammaZ + 0.18·positionsZ + 0.12·dPositionsZ`), where every
per-strike level enters as `Math.abs(...)` and direction comes **only** from the
strike's side of spot (`score-engine.ts:200`, `:217`, `:236`).

**The gamma sign is discarded.** The single place it survives is
`positiveGammaBias = 1.1` (`score-engine.ts:216`) — a 10 % magnitude nudge. So:

> A −5 000 gamma strike 80 pts above spot and a +5 000 gamma strike 80 pts above
> spot contribute the same bullish push, within 10 %.

Under §1 those two strikes mean opposite things: the positive one pulls price up
toward it and holds it there; the negative one, if reached, accelerates price
through it — up *or* down, depending on which way price arrived.

This is codified as [R1](../algorithms/ROLES.md) and [R2](../algorithms/ROLES.md)
("a big gamma wall *above* spot is upside fuel regardless of whether its raw
gamma is signed + or −"). That statement is the direct contradiction of the
mechanism described in §1. It may still have backtested well — see §3.0 for why
that is possible and how to settle it — but it is not what the data means.

**There is no regime variable at all.** `grep -rn "flip|netGamma|regime|totalGamma"
algorithms/` returns nothing structural. The model is linear in four factors with
no interaction term, so it is **not expressible** in the current form that the
same gamma structure implies opposite trades in opposite regimes. No amount of
tuning `wGex` fixes a missing interaction — this is the most likely reason
parameter tuning has felt like it plateaus.

### 2.1 Gap table

| # | Gap | Where | Cost |
|---|---|---|---|
| A | Gamma sign collapsed to `abs()` + 1.1 bias | `score-engine.ts:216-218` | Pinning and accelerating strikes score identically |
| B | No `netGex` / `flipStrike` / regime | absent | Model cannot express the regime interaction at all |
| C | Distance weight rises with distance (edge = 3× ATM) | `score-engine.ts:205` | Score dominated by strikes price may never touch; ATM strikes — where hedging actually fires now — count least |
| D | `positions = call_qty + put_qty`, then `abs()` | `types.ts:32`, `score-engine.ts:236` | DB stores the split; two sign-collapses discard it entirely |
| E | Charm captured, unused | excluded by design | 0DTE charm is large and *time-conditioned*; a linear 5th factor would test as noise even if the effect is real |
| F | Vanna captured, unusable | no IV series stored | Vanna is a *sensitivity*; without ΔIV it has no driver |
| G | Fixed `stopLossPoints: 10`, fixed `strikeWindow: 120` | `types.ts:599`, `:~` | Both are absolute point values in a market whose daily range varies 3×; the cone already gives the scale |

---

## 3. Recommendations, ranked by expected value per unit of work

### 3.0 First: settle the sign question empirically (half a day, no code changes to the model)

Before rewriting anything, measure — the whole argument turns on facts we can
read off our own stored history:

1. **Distribution of `sign(gamma)` near spot.** Per day, per slot: what fraction
   of in-window gamma is positive? If SPX 0DTE is persistently one-signed near
   spot, then `abs()` is nearly lossless in practice and gap A is theoretical.
   If the sign mix varies day to day, `abs()` is destroying real information and
   A is the top priority.
2. **`netGex` sign vs. realized outcome.** Group days by `sign(netGex)` at 10:00
   and compare: realized range, |close − open|, and how the *existing* tuned
   model performed on each group. If the model's edge lives entirely in one
   regime group, that alone justifies B and is worth more than any re-tune.
3. **Flip-crossing events.** Find slots where spot crosses `flipStrike` and
   measure the 15/30-min realized move after. This is the highest-conviction
   single event the mechanism predicts; if it shows up, the model should trade it
   explicitly.

Do these as a read-only analysis script against the DB (same shape as
`coverage-report.ts`). They are cheap and they decide the ordering of everything
below.

### 3.1 Add the regime, as an interaction — not a fifth weighted factor (gap B)

Compute `netGex`, `flipStrike`, `distToFlip` per snapshot. Then use the regime
where it belongs — **multiplying**, not adding:

- **Threshold modulation:** require a higher `entryThreshold` in the pinning
  regime (moves die) and a lower one in the accelerating regime (moves run).
- **Cone logic switch:** the cone breakout gate is a *trend* premise. In a strong
  positive-`netGex` regime the correct trade at the cone edge is the **fade**,
  not the breakout. Making this switchable (and letting the walk-forward tuner
  choose per regime) is the single biggest structural change available.
- **Sizing / stops:** see §3.4.

Keep it as one signed, cone-normalized scalar so the tuner has a continuous knob,
not a boolean cliff.

### 3.2 Split GEX into a pin term and an accelerant term (gap A)

Replace the single `gexRaw` with two factors that have distinct, mechanically
correct directions:

```
// positive gamma: attractor — pulls price toward the strike (both sides)
pinRaw   += (gamma > 0 ? gamma : 0) * sign(strike − spot) * dWeight

// negative gamma: amplifier — no inherent direction; points along the
// prevailing move, scaled by proximity (only strikes price can reach today)
accelRaw += (gamma < 0 ? |gamma| : 0) * sign(recent price momentum) * proximity(k)
```

`pinRaw` keeps the current sign convention (it is exactly the case the current
convention is right for). `accelRaw` is the piece that has no analogue today.
Note this **contradicts R1/R2 as written** — if the head-to-head walk-forward
favors the split, R1/R2 must be rewritten via `/role`, not quietly violated.

Test it head-to-head against the current single-factor engine on the same
walk-forward split. If the split does not win out-of-sample, keep `abs()` and
record in ROLES.md *why* the empirically-worse-but-theoretically-right version
lost — that is real information about the data.

### 3.3 Make the geometry scale-free and let the tuner pick its shape (gaps C, G)

- **`strikeWindow` in cone units, not points.** ±120 pts is ~1.5 % — a huge net on
  a quiet day, a narrow one on a 2 % day. Express it as a multiple of the day's
  cone half-width.
- **Let `distanceWeightSpan` go negative.** Today the ramp can only rise with
  distance. The hedging mechanism says flow fires *where price is now*, which
  argues for ATM-peaked weighting; the current code's rationale (far walls are
  what price must break) argues the opposite. Both are plausible — the cheap fix
  is to allow both shapes in the parameter space and let walk-forward decide,
  rather than hard-coding one belief.

### 3.4 Regime-condition the risk manager (gap G)

A fixed 10-pt stop means something different in each regime — which is precisely
what the mechanism predicts:

- **Positive-gamma / pinning:** vol is suppressed. Tighter stops survive; targets
  should be the **wall** (`callWall`/`putWall`), not a fixed point count. Expect
  many small wins.
- **Negative-gamma / accelerating:** vol expands and stops get run on noise.
  Widen the stop, cut the size to keep risk constant, and let the target run —
  this is where the fat tail is.

Concretely: scale `stopLossPoints` and `takeProfitPoints` by the cone half-width
and by the regime, then size contracts so that *risk in dollars* stays flat.
This is often worth more than any signal improvement, because it changes the
payoff shape without needing the entry to get smarter.

### 3.5 Charm — only as a time-of-day interaction (gap E)

Charm is delta decay per unit time. On 0DTE it is small in the morning and grows
sharply into the afternoon as the whole surface decays; it is the mechanical
driver of the classic late-day drift, as dealers unwind hedges against expiring
OTM options. It is therefore **structurally a conditional effect** — a plain
linear 5th term averages the strong afternoon signal together with the empty
morning and tests as noise, which is the most likely reason it was excluded.

If revisited, enter it as `charm × f(time-to-close)` with `f` rising into the
close, and only after §3.1 is in (charm's direction is also regime-dependent).

### 3.6 Vanna needs an IV series — and that data cannot be backfilled later (gap F)

Vanna is ∂delta/∂IV. Stored as a level with no ΔIV series alongside it, it can
never become a flow estimate — which is why it correctly tests as noise. To make
it usable we need an intraday implied-vol series (VIX is the practical proxy).

**This is time-sensitive:** per the existing price pipeline, Yahoo serves 1-min
history only ~30 days back (see [TODO #6](../TODO.md)). Every day we do not
capture `^VIX` at 1-min is a day that becomes permanently unavailable at that
resolution. Starting the capture is cheap (`^VIX` through the same
`backfill-prices.ts` / `live-prices.ts` path as `^GSPC` and `ES=F`) and is worth
doing **before** deciding whether vanna is useful, not after.

### 3.7 Keep the call/put split (gap D)

`positions` collapses `call_qty + put_qty` and then takes `abs()`. Gamma sign is
genuinely put/call-agnostic (§1), so this costs nothing *for gamma* — but the
positions factor is a separate read on dealer exposure, and there the split
carries delta and charm information that the sum destroys. The DB already has
both columns; carry them through `StrikeData` and test a signed variant.

---

## 4. Practical trading read (the human version)

- **Check the regime before the setup.** `netGex` sign first, then the chart. The
  same pattern is a fade in one regime and a breakout in the other.
- **Positive gamma / above the flip:** sell the edges, buy the dips, expect the
  close to gravitate to the big positive-gamma strike. Small targets, high hit
  rate, and *do not* chase breakouts — they fail by construction, because MM
  hedging is leaning against them.
- **Negative gamma / below the flip:** the opposite. Breakouts follow through,
  dips accelerate, and mean-reversion trades are how accounts die. Wider stops,
  smaller size, hold winners.
- **The flip level is the line that matters.** Approaching it from the positive
  side, the pin weakens; through it, vol expands. It is worth marking daily.
- **The flow hits ES.** MM hedging is executed in E-mini futures — the same
  instrument we trade and price P&L in. The signal and the execution venue are
  the same place, which is unusually direct.

---

## 5. Sequencing

1. §3.0 empirical checks (read-only; decides everything downstream)
2. §3.6 start capturing `^VIX` (do it now — the data is perishable)
3. §3.1 regime as interaction + §3.4 regime-conditioned risk
4. §3.2 pin/accel split, head-to-head walk-forward vs. current engine
5. §3.3 scale-free geometry, both weight shapes in the parameter space
6. §3.5 / §3.7 charm interaction and the call/put split

Do **not** re-tune between steps 3 and 4 and compare against old numbers: any
change here invalidates stored models, exactly as the normalization change did
(see the note at the end of [composite-score.md](composite-score.md)).
