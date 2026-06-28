# TODO

Backlog of work items. Group: **Algorithm** (`algorithms/`).

> Workflow: pick one task → start a focused chat for it → `npx tsc --noEmit` → commit → push.

## Algorithm

- [x] **1. Cone pass triggers a trade only when aligned with momentum.**
  Every cone-line pass should be a trade trigger *as long as it passes in the
  same direction as the momentum/Greeks*. If the cone is passed upwards but the
  Greeks point downwards (mismatch), do **not** trigger.

- [x] **2. Build the cone line from the three DB points; a pass = crossing one of its lines.**
  Ensure the cone line is generated from the three points stored in the DB
  (one starting point + two ending points). The "passing of the cone" means the
  price crossing one of those lines.

- [x] **3. Weight positive gamma slightly higher than negative gamma.**
  Make positive gamma marginally more relevant/influential than negative gamma
  in the scoring. *Done: `positiveGammaBias` config (default 1.1, tunable) in
  `score-engine.ts` Factor 1.*

- [x] **4. Use absolute gamma and position levels.**
  Treat gamma and position levels as absolute magnitudes — i.e. negative gamma
  is added to (combined with) positive gamma rather than netting against it.
  *Done: gamma & positions levels use `|value|` (non-netting); direction comes
  from strike position vs spot. Rate-of-change factors stay signed (momentum).*

- [ ] **5. Enforce a minimum take-profit of 10 points per trade.**
  Only take trades whose take-profit target is at least 10 points.
