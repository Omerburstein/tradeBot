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
Each raw input is passed through a power so nothing is purely linear:
- `p > 1` **emphasizes** large readings (gamma level, gamma momentum).
- `p < 1` **saturates** them (position size — beyond a point, more size adds
  little extra signal).
- `signedPow(x, p) = sign(x)·|x|^p` preserves the sign for the *change* factors,
  because there the sign is the momentum and must be kept.

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
positionsRaw += |positions|^pPositions · gammaStrength · sign · dWeight   (gated)
```
- **Represents:** net market-maker contracts stacked at each strike — a second,
  independent read on where dealers are exposed.
- **Why chosen:** it confirms or tempers the gamma read; when big positions sit
  on the same gamma walls, conviction rises. Weighted below gamma (0.18) because
  it is noisier and only meaningful near gamma.
- **How computed:** absolute position size **saturated** by `pPositions = 1/3`
  (cube-root: a monster print is not 10× the signal of a large one), gated + scaled by
  `gammaStrength`, directioned and distance-weighted.

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

## 4. From raw factors to z-scores (normalization)

Raw factor sums are not comparable across days or across the session (their
scale drifts with total open interest, spot level, etc.). So each raw is
converted to a **z-score against its own recent history**:

```
z = (raw − mean(recent raws)) / std(recent raws)
```

- **Rolling, same-day window.** The history is the `SignalGenerator`'s per-day
  `scoreHistory`, sliced to the last `zScoreLookback` (**20**) snapshots. A fresh
  generator is created for every trading day, so the mean/std are **always** from
  the same day — never across a day boundary. (Do not feed a cross-day history.)
- **Cold start.** With fewer than 3 samples the z-score is unreliable, so the
  engine returns a clamped **sign estimate** (`+1` / `-1` / `0`) instead.
- **Anomaly clamp.** Every z-score is hard-clamped to `±zClamp` (**±3.5**) so a
  single freak snapshot cannot blow one factor out to z=10 and dominate the
  composite.

---

## 5. Combining into the composite

```
composite = 0.45·gexZ + 0.25·dGammaZ + 0.18·positionsZ + 0.12·dPositionsZ
```

The weights (sum ≈ 1.0) encode the priority order established above:
**gamma level ≫ gamma momentum > positions level > positions momentum.** Because
each term is a clamped z-score in `[−3.5, +3.5]`, the composite lives roughly in
`[−3.5, +3.5]` too, in σ-like units, with sign = direction.

### How it is consumed (see `algorithms/signal-generator.ts`)
The composite is a **conviction gate**, not a standalone trigger:
- **Entry** requires a cone breakout in the same direction **and** the composite
  clearing `entryThreshold` (**1.5**), or a strong inside-cone reading clearing
  `strongEntryThreshold` (**2.0**), with `dGammaZ` agreeing in sign.
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
| `pPositions` | 1/3 | saturate position size (cube-root) |
| `pDPositions` | 0.5 | saturate position change |
| `pDistance` | 1.5 | curvature of the distance ramp |
| `distanceWeightSpan` | 2.0 | edge weighs up to 3× ATM |
| `positionsGammaGate` | 0.30 | min gamma strength for positions to count |
| `zClamp` | 3.5 | per-factor / composite z-score clamp |
| `strikeWindow` | 120 | ± SPX pts around spot considered |
| `zScoreLookback` | 20 | trailing same-day snapshots for z-score |

All are tuned via backtest (`npm run tune`); treat the defaults as a starting
point, not gospel.
