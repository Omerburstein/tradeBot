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

### Non-linear shaping (`^p` / `signedPow`)
Gamma level, gamma momentum, and positions momentum are passed through a power:
- `p > 1` **emphasizes** large readings (gamma level, gamma momentum).
- `p < 1` **saturates** them (position *change* — beyond a point, more adds
  little extra signal).
- `signedPow(x, p) = sign(x)·|x|^p` preserves the sign for the *change* factors,
  because there the sign is the momentum and must be kept.

The positions **level** is the exception: it is aggregated **raw** (linear,
no per-strike power), exactly like the gamma level. Its only compression is the
log at the normalize step (§4), which tames a monster print at the aggregate
scale rather than saturating it strike-by-strike.

---

## 3. The four contributors

Each raw factor below is a sum over in-window strikes. The four raws are then
individually z-scored (Section 4) into `gexZ`, `dGammaZ`, `positionsZ`,
`dPositionsZ`, which are what the composite weights.

### 3.1 GEX — gamma exposure  →  `gexZ` (weight `wGex`, default **0.45**)
```
gexRaw += |gamma|^pGamma · gammaBias · sign · dWeight
gammaBias = positiveGammaBias (1.1) if gamma ≥ 0, else 1.0
```
- **Represents:** where the standing dealer gamma wall sits relative to spot —
  the dominant structural force on 0DTE SPX. Above-spot gamma → upside pressure,
  below-spot → downside.
- **Why chosen / weighted highest:** gamma positioning is the strongest and most
  persistent driver of intraday SPX drift; it gets the largest weight (0.45).
- **How computed:** absolute gamma, shaped by `pGamma = 1.2` (big walls count
  more than linearly), nudged up for positive gamma via `positiveGammaBias`,
  directioned by `sign`, and distance-weighted.

### 3.2 dGamma/dt — gamma momentum  →  `dGammaZ` (weight `wDGamma`, default **0.25**)
```
dGammaRaw += signedPow(|gamma| − |prevGamma|, pDGamma) · sign · dWeight
```
- **Represents:** how the gamma landscape is *shifting* between snapshots —
  gamma building above spot (or draining below) is fresh directional momentum.
- **Why chosen:** the *level* (GEX) says where the walls are; the *change* says
  which way they are moving, catching turns earlier than the level alone.
- **How computed:** the per-strike change in gamma **magnitude** (`|gamma|`) vs.
  the previous **Greek** snapshot — matching the absolute-magnitude GEX level, so
  a wall building is positive momentum and a wall bleeding off (including a
  *negative* gamma strike shrinking toward zero) is negative. A 5-minute price
  tick contributes a zero delta by design (Greeks unchanged). The |gamma| delta
  is sign-preserved through `pDGamma = 1.1`, directioned by `sign` and
  distance-weighted. Requires a previous snapshot; it is 0 on the day's first.

### 3.3 Net MM positions  →  `positionsZ` (weight `wPositions`, default **0.18**)
```
positionsRaw += |positions| · gammaStrength · sign · dWeight   (gated)
```
- **Represents:** net market-maker contracts stacked at each strike — a second,
  independent read on where dealers are exposed.
- **Why chosen:** it confirms or tempers the gamma read; when big positions sit
  on the same gamma walls, conviction rises. Weighted below gamma (0.18) because
  it is noisier and only meaningful near gamma.
- **How computed:** **raw** absolute position size (linear, no per-strike power —
  mirroring the gamma level), gated + scaled by `gammaStrength`, directioned and
  distance-weighted. Compression is left to the log at the normalize step
  (§4), so a monster print is tamed at the aggregate scale rather than
  saturated strike-by-strike.

### 3.4 dPositions/dt — positions momentum  →  `dPositionsZ` (weight `wDPositions`, default **0.12**)
```
dPositionsRaw += signedPow(positions − prevPositions, pDPositions) · gammaStrength · sign · dWeight  (gated)
```
- **Represents:** dealers actively adding or pulling positions at a strike
  between snapshots — the freshest, fastest-moving read on positioning.
- **Why chosen:** earliest warning that positioning is changing; smallest weight
  (0.12) because it is the noisiest of the four.
- **How computed:** per-strike position delta vs. the previous Greek snapshot,
  saturated by `pDPositions = 0.5`, under the **same gamma gate** as the level,
  directioned and distance-weighted.

---

## 4. From raw factors to normalized factors

Raw factor sums are not comparable across days or across the session (their
scale drifts with total open interest, spot level, etc.). So each raw is
measured against the **typical magnitude of its own recent history**, then
log-compressed:

```
scale = meanAbs(recent raws)                 // the factor's typical size
ratio = raw / scale                          // "how many times typical"
z     = sign(ratio) · log2(1 + |ratio|)      // compressed, then clamped
```

> **This is NOT a statistical z-score.** Standard deviation plays no part. The
> `gexZ` / `dGammaZ` / `positionsZ` / `dPositionsZ` names are retained for
> continuity, but they mean *"how many times the day's typical magnitude, and in
> which direction"* — not *"how many sigma from the day's mean"*.

**Why not `(raw − mean) / std`?** Mean-centering measures deviation from the
day's average, which **discards the raw factor's own sign**. On 2026-05-19 gamma
sat persistently negative (gexRaw ≈ −1.1e5 all morning); at 13:00 a merely
*less* negative reading of −4.9e4 scored **+2.14** — the composite turned bullish
and cleared `entryThreshold` while gamma pressure was still bearish. Under
scale normalization that same snapshot reads **−0.52**: still negative (gamma is
bearish), at 0.44× the day's typical magnitude. Sign now tracks the market, and a
10× spike reads as a 10× spike regardless of whether the day ran quiet or busy.

**Why log-compress?** A plain ratio needs a large `zClamp` to let a 10× spike
read as 10, and such a spike then swamps the other three factors. Compression
keeps a 10× (→3.46) clearly above a 4× (→2.32) while both sit inside the ±3.5
clamp. A reading at exactly the day's typical magnitude maps to exactly **1.0**,
so the entry thresholds stay in a familiar range.

| ratio (× typical) | 0.44 | 1.0 | 2.0 | 4.0 | 10.0 | 50.0 |
|---|---|---|---|---|---|---|
| normalized | 0.53 | 1.00 | 1.58 | 2.32 | 3.46 | 3.50 (clamped) |

- **Rolling, same-day window.** The history is the `SignalGenerator`'s per-day
  `scoreHistory`, sliced to the last `zScoreLookback` (**20**) snapshots. A fresh
  generator is created for every trading day, so the scale is **always** from
  the same day — never across a day boundary. (Do not feed a cross-day history.)
- **Cold start.** With fewer than 3 samples there is no reliable scale, so the
  engine returns a clamped **sign estimate** (`+1` / `-1` / `0`) instead.
- **Degenerate history.** If every recent raw is ~0 there is no scale to measure
  against, so the factor returns **0** rather than turning noise into a ±1 signal.
- **Anomaly clamp.** Every factor is hard-clamped to `±zClamp` (**±3.5**). With
  log compression this only binds past ~10.3× typical, so it is a backstop
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
| `pGamma` | 1.2 | emphasize large gamma |
| `positiveGammaBias` | 1.1 | slight boost to positive gamma |
| `pDGamma` | 1.1 | emphasize large gamma change |
| `pDPositions` | 0.5 | saturate position change |
| `pDistance` | 1.5 | curvature of the distance ramp |
| `distanceWeightSpan` | 2.0 | edge weighs up to 3× ATM |
| `positionsGammaGate` | 0.30 | min gamma strength for positions to count |
| `zClamp` | 3.5 | per-factor / composite clamp (backstop; binds past ~10.3× typical) |
| `strikeWindow` | 120 | ± SPX pts around spot considered |
| `zScoreLookback` | 20 | trailing same-day snapshots defining each factor's scale |

All are tuned via backtest (`npm run tune`); treat the defaults as a starting
point, not gospel.

> **Re-tune after the normalization change.** Every threshold (`entryThreshold`,
> `strongEntryThreshold`, `exitFadeThreshold`, `reversalThreshold`) was fitted
> when the factors meant "sigma from the day's mean". They now mean "times the
> day's typical magnitude", so the tuned values do not transfer — run
> `npm run tune` before trusting any stored model. The `zStdFloorFrac` knob was
> removed: it floored a standard deviation that no longer exists.
