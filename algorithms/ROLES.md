# Algorithm Roles

Design rules the scoring algorithm **must** obey. Each role states the intent in
plain language, then anchors to the exact code that is supposed to implement it.

- **Add a role:** `/role <description>` — appends a new role block below.
- **Verify the code matches:** `/role --check` — reads every role's anchors and
  reports `MATCH` / `MISMATCH` per role.

The primary surface these roles govern is
[`algorithms/score-engine.ts`](score-engine.ts) → `computeScore`, with config
fields defined in [`algorithms/types.ts`](types.ts).

<!-- ROLES:START — entries below are managed by the `role` skill; keep the R-ids unique -->

## R1 — Positive gamma is worth more than negative gamma

**Rule:** A strike's positive gamma contributes more to the composite score than
the same magnitude of negative gamma. The gamma sign is not thrown away for
*weighting*: a positive-gamma strike gets a bias multiplier greater than `1.0`.

**Anchors:**
- `score-engine.ts` → `computeScore`: `const gammaBias = s.gamma >= 0 ? config.positiveGammaBias : 1.0;`
  and `gammaBias` multiplied into `gexRaw`.
- `types.ts`: config field `positiveGammaBias`, default value `> 1.0`.

**Verify:** `positiveGammaBias` is applied only on the `s.gamma >= 0` branch, and
its default in `DEFAULT_CONFIG` is strictly greater than `1.0`.

## R2 — The gamma LEVEL uses absolute value only

**Rule:** The per-strike **gamma** *level* enters the score as an absolute
magnitude. Opposite-sign strikes never net against each other; directional sign
comes from the strike's side of spot (`sign`), not from the Greek's own sign.

**Scope:** GAMMA ONLY. Positions are explicitly excluded — they are governed by
R7, whose direction comes from the leg and the sign of the quantity instead.
This role once covered both; it was narrowed when the positions factor moved to
the leg/sign table.

**Anchors:**
- `score-engine.ts` → `computeScore`: gamma level uses `Math.abs(s.gamma)`
  (`gexRaw += Math.abs(s.gamma) * gammaBias * sign * dWeight`).

**Verify:** The `gexRaw` accumulator wraps its raw Greek in `Math.abs(...)`, and
the directional term is the spot-relative `sign`, not `Math.sign(s.gamma)`.
`positionsRaw` is NOT expected to match this shape — see R7.

## R3 — The gamma derivative tracks the absolute value

**Rule:** The gamma rate-of-change factor measures whether the *magnitude* rose
or fell — it cares only that the value increased or decreased, not whether it is
positive or negative. The derivative is therefore flip-aware over the
**absolute** value, so a wall building versus bleeding is distinguished by
magnitude change alone.

**Scope:** GAMMA ONLY, for the same reason as R2. The positions derivative is a
PLAIN SIGNED DIFFERENCE (`decayedDiff`) and must not be `abs`-wrapped — under R7
its direction comes from the quantity's own sign, which `signedDelta` is
deliberately blind to. See R7.

**Anchors:**
- `score-engine.ts` → `computeScore`: gamma derivative is
  `const deltaGamma = decayedDelta(momentum?.gamma, s.strike, s.gamma, prev?.gamma, rho);`
- `score-engine.ts` → `signedDelta`: size is `Math.abs(curr - prev)`, direction is
  `Math.abs(curr) - Math.abs(prev)`.

**Verify:** `dGammaRaw` is built from `decayedDelta`/`signedDelta`, whose
direction term differences two `Math.abs(...)` values. `dPositionsRaw` using a
raw signed delta is CORRECT, not a mismatch.

## R4 — Factors are orthogonal: no z-component multiplies another's value

**Rule:** Each scored factor (`gexRaw`, `dGammaRaw`, `positionsRaw`,
`dPositionsRaw`) is built only from its OWN quantity. One factor's value is never
folded into another's — e.g. the gamma derivative is not multiplied by the gamma
level, and positions are not scaled by gamma magnitude. Where gamma influences
another factor it may act only as a boolean THRESHOLD (a gate), never as a
multiplicative weight. The only terms allowed to be common across factors are the
shared geometric weights that are not themselves scored components — the
spot-relative `sign` and the distance weight `dWeight`.

**Anchors:**
- `score-engine.ts` → `computeScore`: `gexRaw += Math.abs(s.gamma) * gammaBias * sign * dWeight;`
  — gamma level only (no `dGamma`/positions terms).
- `score-engine.ts` → `computeScore`: `dGammaRaw += deltaGamma * sign * dWeight;`
  — |gamma| delta only, NOT multiplied by `s.gamma` / any gamma level.
- `score-engine.ts` → `computeScore`: `positionsRaw += legContribution(s.callQty, s.putQty, distance, dWeight);`
  gated by `positionsCounts = gammaStrength >= config.positionsGammaGate` — gamma
  is a boolean gate here, never a factor in the value.
- `score-engine.ts` → `computeScore`: `dPositionsRaw += legContribution(dCall, dPut, distance, dWeight);`
  — position-leg deltas only, under the same boolean gate.

**Verify:** No factor accumulator multiplies another factor's quantity into its
term. `gexRaw` contains no `deltaGamma`/`positions` factor; `dGammaRaw` contains
no `s.gamma`/`gammaStrength` factor; `positionsRaw`/`dPositionsRaw` use the gamma
gate only as a boolean (`if (positionsCounts)`), never as a multiplier. The only
shared multipliers are `sign`, `dWeight`, and the ITM/OTM weights `legContribution`
derives from `dWeight` (a geometric weight, not a scored component).

## R5 — The z component is non-linear, applied once to the whole factor

**Rule:** Each normalized factor (`gexZ`, `dGammaZ`, `positionsZ`,
`dPositionsZ` — the `…Z` outputs) is a **non-linear** function of its raw factor,
and that non-linearity is applied **at the normalization step to the whole
aggregated raw factor** (`gexRaw`, `dGammaRaw`, …) — not per-strike. Doubling the
whole raw factor must NOT double the z output: the scale-ratio is log-compressed
in `normalizeToScale`. This is the ONLY place non-linearity enters (per-strike
accumulation stays linear — see [[R6]]). A plain linear normalize (`z = ratio`)
is a MISMATCH.

**Anchors:**
- `score-engine.ts` → `normalizeToScale`: returns
  `Math.sign(ratio) * Math.log2(1 + Math.pow(Math.abs(ratio), exponent))` —
  log-compresses the whole factor's scale-ratio, shaped by the factor's
  `exponent`, not the bare `ratio`.
- `score-engine.ts` → `computeScore`: `gexZ`/`dGammaZ`/`positionsZ`/`dPositionsZ`
  are each `normalizeToScale(<factor>Raw, …, <exponent>)` — the transform, and
  the factor's shaping exponent (`pGamma`/`pDGamma`/`pPositions`/`pDPositions`),
  are applied to the aggregated factor, once, not per strike.

**Verify:** `normalizeToScale` wraps the ratio in `Math.log2(1 + …)` (never
returns `ratio` directly), and it is the sole non-linear transform in the score
pipeline — it acts on the already-aggregated `…Raw` factor (carrying that
factor's exponent), not on individual per-strike values.

## R6 — Raw factor score is linear in the data (abs + multiplicative factors only)

**Rule:** Each raw factor (`gexRaw`, `dGammaRaw`, `positionsRaw`,
`dPositionsRaw`) must be **linear** in the per-strike data value: the value may
be transformed by `Math.abs` and multiplied by constant/geometric factors
(`sign`, `dWeight`, `gammaBias`), but **never** reshaped by a non-linear
transform — no `Math.pow`/`signedPow` exponent on the magnitude, and nothing
similar. Doubling a strike's data must double its contribution to the raw score.
All non-linearity is deferred to the normalize step (see [[R5]]): the shaping
comes from the log — and each factor's exponent applied to the whole-factor
ratio — at normalize, not from power exponents at the raw step. (R1's
`gammaBias` is a plain multiplicative factor and remains allowed.)

**Anchors:**
- `score-engine.ts` → `legContribution`: `return putQty * wPut - callQty * wCall;`
  — linear in each leg quantity; `wPut`/`wCall` are geometric weights, no power.
- `score-engine.ts` → `computeScore`: `gexRaw += Math.abs(s.gamma) * gammaBias * sign * dWeight;`
  — linear in `|gamma|`; `gammaBias * sign * dWeight` are multiplicative factors, no power.
- `score-engine.ts` → `computeScore`: `dGammaRaw += deltaGamma * sign * dWeight;`
  — linear in the signed `|gamma|` delta, no power.
- `score-engine.ts` → `computeScore`: `dPositionsRaw += legContribution(dCall, dPut, distance, dWeight);`
  — linear in the signed leg deltas, no power.

**Verify:** Each raw accumulator term is linear in its data value — the data
appears only inside `Math.abs(...)` (gamma) or bare (position legs) and is
multiplied by factors (`sign`, `dWeight`, `gammaBias`, the ITM/OTM weights). No
`Math.pow`/`signedPow` (exponent ≠ 1) is applied to the data magnitude at the
raw-accumulation step; any such power transform is a MISMATCH. `pDistance` inside
`dWeight` is a power on the DISTANCE, not on the data, and is allowed.

## R7 — Position direction comes from the leg and the sign of its quantity

**Rule:** A market-maker position's directional meaning is set by which leg it is
in and the sign of its quantity — identically above and below spot:

|         | negative qty | positive qty |
|---------|--------------|--------------|
| puts    | bearish      | bullish      |
| calls   | bullish      | bearish      |

which is exactly `+putQty − callQty`. The two legs are therefore **never summed
before scoring**, and the level is **never** `abs`-wrapped: bullish and bearish
must cancel, both within a strike and across strikes. The strike's side of spot
does NOT set position direction (that is gamma's rule, R2) — it survives only as
the in-the-money test that picks each leg's distance weight.

The in-the-money leg (puts above spot, calls below spot) **decays** with distance
while the out-of-the-money leg keeps the outward ramp `dWeight`: `w_ITM =
ITM_POSITION_WEIGHT / w_OTM`, a reciprocal mirror that reuses the tuned
`distanceWeightSpan`/`pDistance` and adds no free parameter. At exactly ATM
neither leg is in the money and both take `w_OTM`.

**Anchors:**
- `types.ts`: `StrikeData.callQty` / `StrikeData.putQty` — the two signed legs;
  `StrikeData.positions` (their sum) is presence-only and must not be scored.
- `score-engine.ts` → `legContribution`: `return putQty * wPut - callQty * wCall;`
  with `wPut = distance > 0 ? itmWeight : otmWeight` and the call leg mirrored.
- `score-engine.ts` → `ITM_POSITION_WEIGHT = 0.5` — a fixed constant, not a
  tuner knob.
- `score-engine.ts` → `computeScore`: both `positionsRaw` and `dPositionsRaw`
  accumulate via `legContribution`, with no `sign` multiplier.
- `score-engine.ts` → `decayedDiff`: `const out = currLevel - seed;` — a PLAIN
  signed difference, because `signedDelta` is sign-blind and would invert the
  direction of every negative leg.
- `data-loader.ts` → `loadPositions`: returns `{ call, put }` per strike; the two
  legs are never summed on the way in.

**Verify:** `positionsRaw`/`dPositionsRaw` contain no `Math.abs(...)` around the
position data and no `sign` multiplier; the put term is positive and the call term
negative; the position derivative is a bare subtraction, not `signedDelta`. Any
reintroduction of `s.positions` (the summed field) into a score accumulator is a
MISMATCH.

<!-- ROLES:END -->
