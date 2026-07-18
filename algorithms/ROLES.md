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

## R2 — Gamma and positions LEVELS use absolute value only

**Rule:** The per-strike **gamma** and **net-position** *levels* enter the score
as absolute magnitudes. Opposite-sign strikes never net against each other;
directional sign comes from the strike's side of spot (`sign`), not from the
Greek's own sign.

**Anchors:**
- `score-engine.ts` → `computeScore`: gamma level uses `Math.abs(s.gamma)`
  (`gexRaw += Math.abs(s.gamma) * gammaBias * sign * dWeight`).
- `score-engine.ts` → `computeScore`: positions level uses `Math.abs(s.positions)`.

**Verify:** Both the `gexRaw` and `positionsRaw` accumulators wrap their raw
Greek in `Math.abs(...)`, and the directional term is the spot-relative `sign`,
not `Math.sign(s.gamma)` / `Math.sign(s.positions)`.

## R3 — Derivatives track the absolute value

**Rule:** Rate-of-change factors measure whether the *magnitude* rose or fell —
they care only that the value increased or decreased, not whether it is positive
or negative. Each derivative is therefore the delta of the **absolute** value, so
a wall building versus bleeding is distinguished by magnitude change alone.

**Anchors:**
- `score-engine.ts` → `computeScore`: gamma derivative is
  `const deltaGamma = Math.abs(s.gamma) - Math.abs(prev.gamma);`
- `score-engine.ts` → `computeScore`: the positions derivative
  (`dPositionsRaw`) must likewise be the delta of the absolute position level,
  i.e. `Math.abs(s.positions) - Math.abs(prev.positions)`.

**Verify:** Every rate-of-change delta subtracts an `Math.abs(...)` current from
an `Math.abs(...)` previous. A raw signed delta (`s.x - prev.x` without `abs`)
is a MISMATCH.

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
- `score-engine.ts` → `computeScore`: `positionsRaw += Math.abs(s.positions) * sign * dWeight;`
  gated by `positionsCounts = gammaStrength >= config.positionsGammaGate` — gamma
  is a boolean gate here, never a factor in the value.
- `score-engine.ts` → `computeScore`: `dPositionsRaw += deltaPositions * sign * dWeight;`
  — |positions| delta only, under the same boolean gate.

**Verify:** No factor accumulator multiplies another factor's quantity into its
term. `gexRaw` contains no `deltaGamma`/`positions` factor; `dGammaRaw` contains
no `s.gamma`/`gammaStrength` factor; `positionsRaw`/`dPositionsRaw` use the gamma
gate only as a boolean (`if (positionsCounts)`), never as a multiplier. The only
shared multipliers are `sign` and `dWeight`.

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
- `score-engine.ts` → `computeScore`: `positionsRaw += Math.abs(s.positions) * sign * dWeight;`
  — abs + linear factors only, no power.
- `score-engine.ts` → `computeScore`: `gexRaw += Math.abs(s.gamma) * gammaBias * sign * dWeight;`
  — linear in `|gamma|`; `gammaBias * sign * dWeight` are multiplicative factors, no power.
- `score-engine.ts` → `computeScore`: `dGammaRaw += deltaGamma * sign * dWeight;`
  — linear in the signed `|gamma|` delta, no power.
- `score-engine.ts` → `computeScore`: `dPositionsRaw += deltaPositions * sign * dWeight;`
  — linear in the signed `|positions|` delta, no power.

**Verify:** Each raw accumulator term is linear in its data value — the data
appears only inside `Math.abs(...)` and is multiplied by factors (`sign`,
`dWeight`, `gammaBias`). No `Math.pow`/`signedPow` (exponent ≠ 1) is applied to
the data magnitude at the raw-accumulation step; any such power transform is a
MISMATCH.

<!-- ROLES:END -->
