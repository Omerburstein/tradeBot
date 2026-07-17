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
  (inside `Math.pow(Math.abs(s.gamma), config.pGamma)`).
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

<!-- ROLES:END -->
