# The Composite Directional Score

This document explains the **composite z-score** the algorithm uses to decide
which way SPX is likely to move. It is the single number
`SignalGenerator` reads to size conviction; entries and exits are gated on it
(together with the cone — see [`algorithms/cone.ts`](../algorithms/cone.ts)).

Everything here is implemented in
[`algorithms/score-engine.ts`](../algorithms/score-engine.ts) (`computeScore`).
Config knobs live in `AlgoConfig` / `DEFAULT_CONFIG` in
[`algorithms/types.ts`](../algorithms/types.ts).

---

## 1. What the composite is

For each snapshot (one 10-minute Greek slot, or a 5-minute price tick that
reuses the slot's Greeks) the engine produces a `ScoreComponents` object. Its
headline field is:

```
composite = wGex·gexZ  +  wDGamma·dGammaZ  +  wPositions·positionsZ  +  wDPositions·dPositionsZ
```

- It is a **weighted sum of four z-scores**, so the composite itself is roughly
  in "standard-deviation" units — a reading of `+1.5` means the aggregate signal
  is ~1.5σ above its recent same-day average in the **bullish** direction.
- **Sign = direction.** `composite > 0` → net upward (long) pressure;
  `composite < 0` → net downward (short) pressure. The magnitude is conviction.
- Only **gamma** and **net market-maker positions** (and their rates of change)
  feed it. **Charm and vanna are captured but intentionally excluded** — they
  were not found to add directional signal over gamma + positions.

The four weighted terms are exactly what `factorContributions()` returns and
what the trade log prints as `gex= dGam= pos= dPos=`; they sum to the composite.

---

## 2. The per-strike building blocks (shared by all four factors)

Every factor is a sum over the strikes within `strikeWindow` (±120 pts) of spot.
Three per-strike quantities shape every term:

### Direction (`sign`)
```
sign = +1  if strike > spot        (above spot → upside/long pressure)
       -1  if strike < spot        (below spot → downside/short pressure)
        0  at the money
```
Levels are always taken as an **absolute magnitude** and then given direction by
`sign`. There is **no netting** between an above-spot strike and a below-spot
strike of opposite Greek sign — each side pushes the score its own way. This is
deliberate: a big gamma wall *above* spot is upside fuel regardless of whether
its raw gamma is signed + or −.

### Distance weight (`dWeight`) — farther strikes count *more*
```
dWeight = 1 + distanceWeightSpan · (|strike − spot| / strikeWindow) ^ pDistance
```
With the defaults (`distanceWeightSpan = 2.0`, `pDistance = 1.5`): at-the-money
strikes weigh `1.0×`, the edge of the ±120 window weighs up to `3.0×`, curved so
the ramp is gentle near spot and steep at the edges. Rationale: ATM gamma pins
price (little directional information), while a heavy wall out at the edge is
what price has to *break through* — that is where the directional edge lives.

### Gamma gate (`gammaStrength`) — positions only count near real gamma
```
gammaStrength = |gamma| / max(|gamma|) over the window        (0–1)
positionsCounts = gammaStrength ≥ positionsGammaGate          (default 0.30)
```
A strike's **positions** signal is only used when that strike also carries
meaningful gamma (≥ 30 % of the window's peak), and is then scaled by
`gammaStrength`. Positions far from any gamma are noise — dealers are not forced
to hedge there — so they are dropped entirely.

### Non-linear shaping (exponents, applied at normalize)
Every raw factor is aggregated **linearly** in the per-strike data (R6) — the
per-strike term is just `|value|` times the geometric weights (`sign`, `dWeight`,
and `gammaBias` on gamma). No per-strike power is applied.

Each factor's non-linear shaping instead lives at the **normalize step** (§4),
applied **once, to the whole aggregated factor's ratio, inside the log** (R5):
`out = sign(r)·log2(1 + |r|^p)`, with a per-factor exponent
(`pGamma` / `pDGamma` / `pPositions` / `pDPositions`):
- `p > 1` **emphasizes** large readings (e.g. gamma level, gamma momentum).
- `p < 1` **saturates** them (e.g. position level/change — beyond a point, more
  adds little extra signal).
- the anchor `r = 1 → 1.0` holds for any `p`, so a reading at the day's typical
  magnitude always reads 1.0.

---

## 3. The four contributors

Each raw factor below is a sum over in-window strikes. The four raws are then
individually z-scored (Section 4) into `gexZ`, `dGammaZ`, `positionsZ`,
`dPositionsZ`, which are what the composite weights.

### 3.1 GEX — gamma exposure  →  `gexZ` (weight `wGex`, default **0.45**)
```
gexRaw += |gamma| · gammaBias · sign · dWeight       (linear; shaped at normalize by pGamma)
gammaBias = positiveGammaBias (1.1) if gamma ≥ 0, else 1.0
```
- **Represents:** where the standing dealer gamma wall sits relative to spot —
  the dominant structural force on 0DTE SPX. Above-spot gamma → upside pressure,
  below-spot → downside.
- **Why chosen / weighted highest:** gamma positioning is the strongest and most
  persistent driver of intraday SPX drift; it gets the largest weight (0.45).
- **How computed:** absolute gamma (linear), nudged up for positive gamma via
  `positiveGammaBias`, directioned by `sign`, and distance-weighted. The whole
  factor is then shaped at normalize by `pGamma = 1.2` (big walls count more than
  linearly — §4).

### 3.2 dGamma/dt — gamma momentum  →  `dGammaZ` (weight `wDGamma`, default **0.25**)
```
dGammaRaw += signedDelta(|gamma|, baseline) · sign · dWeight   (linear; shaped at normalize by pDGamma)
baseline  = ρ·baseline + (1 − ρ)·gamma,   ρ = 0.5^(Δt_min / momentumHalfLifeMin)   // per strike, wall-clock
```
- **Represents:** how the gamma landscape is *shifting* — gamma building above
  spot (or draining below) is fresh directional momentum.
- **Why chosen:** the *level* (GEX) says where the walls are; the *change* says
  which way they are moving, catching turns earlier than the level alone.
- **How computed:** per strike, the current gamma **magnitude** (`|gamma|`) is
  compared not to the single previous snapshot but to a **time-decayed baseline**
  of that strike's recent levels (half-life `momentumHalfLifeMin` minutes). The
  current level enters at **full weight** — a large last-minute move registers at
  once — while the baseline carries ~2–3 half-lives of history, so a steady build
  accumulates and a one-slot blip reverts as the baseline catches up. It matches
  the absolute-magnitude GEX level (a wall building is +, a wall bleeding off —
  incl. a *negative* gamma strike shrinking toward zero — is −), keeps its own
  sign, is directioned by `sign` and distance-weighted (all linear), then shaped
  at normalize by `pDGamma`. The memory is **wall-clock** (ρ from the real Δt), so
  it means the same thing at 1-min and 10-min cadence, and it **cannot ramp** (a
  bounded difference of two levels). A price tick contributes no update (Greeks
  unchanged); it is 0 on the day's first snapshot. See
  [MomentumState / decayedDelta in score-engine.ts](../algorithms/score-engine.ts).

### 3.3 Net MM positions  →  `positionsZ` (weight `wPositions`, default **0.18**)
```
positionsRaw += |positions| · sign · dWeight   (gated; shaped at normalize by pPositions)
```
- **Represents:** net market-maker contracts stacked at each strike — a second,
  independent read on where dealers are exposed.
- **Why chosen:** it confirms or tempers the gamma read; when big positions sit
  on the same gamma walls, conviction rises. Weighted below gamma (0.18) because
  it is noisier and only meaningful near gamma.
- **How computed:** **raw** absolute position size (linear), counted only where
  the strike's gamma clears the `positionsGammaGate` (a boolean gate — gamma is a
  threshold here, not a multiplier), directioned and distance-weighted. The whole
  factor is then shaped at normalize by `pPositions = 0.5` (saturating — a monster
  print is tamed at the aggregate scale rather than strike-by-strike, §4).

### 3.4 dPositions/dt — positions momentum  →  `dPositionsZ` (weight `wDPositions`, default **0.12**)
```
dPositionsRaw += signedDelta(|positions|, baseline) · sign · dWeight  (gated; shaped at normalize by pDPositions)
baseline     = ρ·baseline + (1 − ρ)·positions        // same ρ / half-life as dGamma, per strike
```
- **Represents:** dealers actively adding or pulling positions at a strike — the
  freshest, fastest-moving read on positioning.
- **Why chosen:** earliest warning that positioning is changing; smallest weight
  (0.12) because it is the noisiest of the four.
- **How computed:** identical machinery to dGamma (§3.2) — current position
  **magnitude** vs. a per-strike **time-decayed baseline** (same
  `momentumHalfLifeMin`), current level at full weight — under the **same boolean
  gamma gate** as the level, directioned and distance-weighted, then shaped at
  normalize by `pDPositions`. The positions baseline is kept warm for every
  in-window strike so a strike crossing the gate mid-day has a settled baseline;
  only a gated strike's delta enters the score.

---

## 4. From raw factors to normalized factors

Raw factor sums are not comparable across days or across the session (their
scale drifts with total open interest, spot level, etc.). So each raw is
measured against a **typical magnitude drawn from recent history**, then
log-compressed:

```
scale = meanAbs(recent raws of THIS factor)     // its own typical size, magnitude only
ratio = raw / scale                             // "how many times typical"
z     = sign(ratio) · log2(1 + |ratio|^p)       // shaped by the factor's exponent p,
                                                //   compressed, then clamped
```

**Every factor sets its own, magnitude-only scale.** Each of the four is divided
by the mean **absolute** magnitude of its OWN recent raw history — so the sign
never enters the denominator (opposite-sign readings cannot cancel the scale),
and the reading is *"how large is this versus this factor's own typical size
today"*:

| Factor | Scale it is divided by | Reads as |
|--------|------------------------|----------|
| `gexRaw` | `meanAbs(recent gexRaw)` | times its own typical size |
| `dGammaRaw` | `meanAbs(recent dGammaRaw)` | times its own typical size |
| `positionsRaw` | `meanAbs(recent positionsRaw)` | times its own typical size |
| `dPositionsRaw` | `meanAbs(recent dPositionsRaw)` | times its own typical size |

Because every factor anchors at `ratio = 1 → 1.0`, a rate of change reads on the
**same footing** as its level (all ≈1.0 typical), so the four `w…` weights are
directly comparable and no per-factor gain is needed.

`p` is the factor's own exponent (`pGamma` / `pDGamma` / `pPositions` /
`pDPositions`) — the **only** place the factors are shaped non-linearly (the raw
sums in §3 are linear). `p = 1` is the pure-log baseline tabulated below; `p > 1`
steepens large ratios, `p < 1` flattens them. The anchor `ratio = 1 → 1.0` holds
for every `p`.

> **This is NOT a statistical z-score.** Standard deviation plays no part. The
> `gexZ` / `dGammaZ` / `positionsZ` / `dPositionsZ` names are retained for
> continuity, but they mean *"how many times the factor's own typical magnitude,
> and in which direction"* — not *"how many sigma from the day's mean"*.

**Why not `(raw − mean) / std`?** Mean-centering measures deviation from the
day's average, which **discards the raw factor's own sign**. On 2026-05-19 gamma
sat persistently negative (gexRaw ≈ −1.1e5 all morning); at 13:00 a merely
*less* negative reading of −4.9e4 scored **+2.14** — the composite turned bullish
and cleared `entryThreshold` while gamma pressure was still bearish. Under
scale normalization that same snapshot reads **−0.52**: still negative (gamma is
bearish). Sign now tracks the market.

**The trade-off of self-scaling a rate of change.** A delta series is roughly
zero-mean, so its own mean magnitude is essentially its movement amplitude. That
means the reading is *relative to the day's own activity*: on a quiet day a small
move still reads ~1.0 because it is typical **for that day** — self-scaling does
not know the move was small in absolute (level) terms. An earlier version
therefore scaled each delta by its LEVEL instead, which kept quiet-day moves
small; the cost was that a typical delta then read a fraction of 1.0 (≈0.3–0.5)
and needed a separate gain to matter, leaving the composite lopsided. This
version self-scales so all four factors share one anchor and the weights stay
comparable. The reason it is safe now: the rate of change is the **decayed-
baseline momentum** (§3.2), not a raw one-step difference, so it is smooth
(≈35 sign flips/session, not ≈118) and its own magnitude is a stable scale rather
than pure noise. `history[0]`'s delta is a structural zero (no baseline yet); the
`<3`-sample cold-start guard plus a short lookback keep that from distorting the
open.

**Why log-compress?** A plain ratio needs a large `zClamp` to let a 10× spike
read as 10, and such a spike then swamps the other three factors. Compression
keeps a 10× clearly above a 4× while both stay near the ±3.5 clamp. A reading at
exactly the day's typical magnitude maps to exactly **1.0**, so the entry
thresholds stay in a familiar range. (The exponent `p` shapes this further —
`p > 1` reaches the clamp sooner, `p < 1` later.)

Baseline mapping at `p = 1` (pure log):

| ratio (× typical) | 0.44 | 1.0 | 2.0 | 4.0 | 10.0 | 50.0 |
|---|---|---|---|---|---|---|
| normalized (p=1) | 0.53 | 1.00 | 1.58 | 2.32 | 3.46 | 3.50 (clamped) |

- **Rolling, same-day window.** The history is the `SignalGenerator`'s per-day
  `scoreHistory`, filtered to the entries whose own instant falls within the last
  `zScoreLookbackMin` (**180**) minutes — a wall-clock window, not a fixed count
  of snapshots, so it means the same physical memory at any feed cadence. A fresh
  generator is created for every trading day, so the scale is **always** from
  the same day — never across a day boundary. (Do not feed a cross-day history.)
- **Cold start.** With fewer than 3 samples there is no reliable scale, so the
  engine returns a clamped **sign estimate** (`+1` / `-1` / `0`) instead.
- **Degenerate history.** If every recent raw is ~0 there is no scale to measure
  against, so the factor returns **0** rather than turning noise into a ±1 signal.
- **Anomaly clamp.** Every factor is hard-clamped to `±zClamp` (**±3.5**). With
  log compression this only binds past ~10.3× typical at `p = 1` (sooner for
  `p > 1`, e.g. ~6.9× at `pGamma = 1.2`; later for `p < 1`), so it is a backstop
  rather than a routine limiter.

---

## 5. Combining into the composite

```
composite = 0.45·gexZ + 0.25·dGammaZ + 0.18·positionsZ + 0.12·dPositionsZ
```

The weights (sum ≈ 1.0) encode the priority order established above:
**gamma level ≫ gamma momentum > positions level > positions momentum.** Because
each term is clamped to `[−3.5, +3.5]`, the composite lives roughly in
`[−3.5, +3.5]` too — in units of "times the day's typical magnitude" (log-compressed),
with sign = direction.

### How it is consumed (see `algorithms/signal-generator.ts`)
The composite is a **conviction gate**, not a standalone trigger:
- **Entry** requires a cone breakout in the same direction **and** the composite
  clearing `entryThreshold` (**1.5**), or a strong inside-cone reading clearing
  `strongEntryThreshold` (**2.0**). The sign of `dGammaZ` is no longer a separate
  gate (TODO #10) — it contributes to the composite via `wDGamma·dGammaZ` only.
- **Exit** fires on signal fade (composite falls below `exitFadeThreshold`,
  **0.5**), a reversal past `reversalThreshold` (**1.0**) the other way, cone
  re-entry, or the stop / take-profit.

---

## 6. Default parameters (from `DEFAULT_CONFIG`)

| Knob | Default | Role |
|------|---------|------|
| `wGex` | 0.45 | weight — gamma level |
| `wDGamma` | 0.25 | weight — gamma momentum |
| `wPositions` | 0.18 | weight — positions level |
| `wDPositions` | 0.12 | weight — positions momentum |
| `pGamma` | 1.2 | normalize exponent — emphasize large gamma |
| `positiveGammaBias` | 1.1 | per-strike multiplier — slight boost to positive gamma |
| `pDGamma` | 1.1 | normalize exponent — emphasize large gamma change |
| `pPositions` | 0.5 | normalize exponent — saturate large positions |
| `pDPositions` | 0.5 | normalize exponent — saturate position change |
| `pDistance` | 1.5 | curvature of the distance ramp |
| `distanceWeightSpan` | 2.0 | edge weighs up to 3× ATM |
| `positionsGammaGate` | 0.30 | min gamma strength for positions to count |
| `zClamp` | 3.5 | per-factor / composite clamp (backstop; binds past ~10.3× typical) |
| `strikeWindow` | 120 | ± SPX pts around spot considered |
| `zScoreLookbackMin` | 180 | trailing same-day WALL-CLOCK MINUTES defining each factor's scale |

All are tuned via backtest (`npm run tune`); treat the defaults as a starting
point, not gospel.

> **Re-tune after the normalization change.** Every threshold (`entryThreshold`,
> `strongEntryThreshold`, `exitFadeThreshold`, `reversalThreshold`) was fitted
> when the factors meant "sigma from the day's mean". They now mean "times the
> day's typical magnitude", so the tuned values do not transfer — run
> `npm run tune` before trusting any stored model. The `zStdFloorFrac` knob was
> removed: it floored a standard deviation that no longer exists.
