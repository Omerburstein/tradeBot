# Timezone & GEX-slot alignment audit (TODO #5)

**Scope:** verify every timestamp across the algo pipeline (GEX snapshots, ES
prices, SPX prices, positions, cone) is UTC-normalised for storage and
ET-normalised for wall-clock logic, that no comparison mixes zones, and that at
decision time the algo reads the **correct** GEX slot (no stale slot, no
look-ahead).

**Conclusion:** the storage + join layer was already correct. Two wall-clock
helpers in the algo were still on **CT** (Central) — self-consistent, so not a
behavioural bug, but a hazard and a violation of the "everything ET" invariant
the rest of the codebase adopted on 2026-06-20. Both were converted to ET
(behaviour-preserving — identical real-world instants). Details below.

---

## 1. Timestamp inventory (storage)

Every persisted instant is a UTC `TIMESTAMPTZ`, produced from the ET slot-end
wall-clock via a single helper, `computeCapturedAt(date, slotEndHhmm)` in
[`scraper/core/dates.ts`](../scraper/core/dates.ts) (explicit ET→UTC offset via
`Intl.DateTimeFormat`, DST-aware, container-TZ-independent).

| Table | Key instant | Column type | Grain | Meaning of `captured_at` |
|-------|-------------|-------------|-------|--------------------------|
| `periscope_snapshots` (gamma/charm/vanna/**positions** panels) | `captured_at` | `TIMESTAMPTZ` | 10-min slot | **slot END** (e.g. `[13:10,13:20)` → `13:20` ET) |
| `positions` (call/put qty) | `captured_at` | `TIMESTAMPTZ` | 10-min slot | slot END |
| `spot_prices` (SPX cash) | `captured_at` | `TIMESTAMPTZ` | 1-min bar | bar instant (ET) |
| `es_prices` (ES future) | `captured_at` | `TIMESTAMPTZ` | 1-min bar | bar instant (ET) |
| `cone_snapshots` | `captured_at` | `TIMESTAMPTZ` | daily | 09:30 ET apex row |

All five share the same production path and the same `TIMESTAMPTZ` type, so
there is no zone divergence at write time. The GEX slot and its `positions`
counterpart come from the **same** `captured_at`, so they are always the same
slot.

## 2. Loader joins — no zone mixing

[`algorithms/data-loader.ts`](../algorithms/data-loader.ts) renders every
`captured_at` identically on both sides of every join:

```sql
to_char(captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
```

- **GEX/charm/vanna/positions ⋈ spot ⋈ ES** — joined on the **exact** UTC-ISO
  `captured_at` string (`spotMap.get(key)` / `esMap.get(key)`), so a `13:20`
  GEX slot is only ever paired with the `13:20` spot and `13:20` ES bars —
  never a neighbouring minute, never a different zone.
- **Day selection & cone** — matched by ET calendar date
  (`(captured_at AT TIME ZONE 'America/New_York')::date = expiry`), which also
  enforces **0DTE-only** (capture session = expiry) so forward-expiry captures
  can't mis-join against the wrong day's prices.
- **Densified 5-min ticks** — `priceKey(epochMs)` builds the same
  `…THH:MM:SSZ` key from a UTC epoch, so intra-slot price ticks join the price
  tables on the identical key format.

No arithmetic mixes a UTC instant with an ET/CT wall-clock number anywhere in
the loader.

## 3. Correct GEX slot at decision time (no look-ahead)

`capturedAt` is the slot **END**. The generator processes snapshots in ascending
`capturedAt` order (backtest sorts within the day; the densifier preserves
order) and a look-ahead guard in
[`signal-generator.ts`](../algorithms/signal-generator.ts) `processSnapshot`
throws if a snapshot arrives out of order.

At the `13:20` snapshot the algo therefore:
- uses the Greeks of the just-closed **`[13:10,13:20)`** slot, and
- prices the decision at the **`13:20`** spot/ES instant (exact-join),

i.e. it always uses the **most-recently-closed** slot, evaluated at that slot's
end instant. That is exactly the TODO's requirement ("read the snapshot whose
slot covers `[T, T+10min)`") under the **slot-end labelling** this codebase uses:
the TODO labels the decision by the slot **start** (`T = 13:10`); the code labels
it by the slot **end** (`13:20`). Same slot data, same execution instant, no
look-ahead — the in-progress `[13:20,13:30)` slot (`captured_at = 13:30`) is not
visible until `13:30`.

Densified price ticks are consistent: a `13:25` tick reuses the last **closed**
Greek slot (`13:20`) with the current `13:25` price — never the still-open slot,
so still no look-ahead.

## 4. Findings & fixes

Two algo helpers still converted UTC→**CT** and compared against CT constants.
Both were internally consistent (CT vs CT) so produced correct instants, but
contradicted the ET-normalised rest of the pipeline and were easy to misread
(`forcedExitByCT: '14:50'` actually means 15:50 ET). Converted to ET, preserving
the exact instants:

| Location | Before (CT) | After (ET) | Same instant? |
|----------|-------------|-----------|---------------|
| `risk-manager.ts` `checkTimeGates` / `getEtMinutesSinceMidnight` | `America/Chicago` | `America/New_York` | ✅ |
| `types.ts` `noNewTradesAfter*` | `noNewTradesAfterCT: '14:40'` | `noNewTradesAfterET: '15:40'` | ✅ (14:40 CT = 15:40 ET) |
| `types.ts` `forcedExitBy*` | `forcedExitByCT: '14:50'` | `forcedExitByET: '15:50'` | ✅ (14:50 CT = 15:50 ET) |
| `cone.ts` `minutesUntilClose` | `America/Chicago`, close `15:00 CT` | `America/New_York`, close `16:00 ET` | ✅ |
| `signal-generator.ts` doc | "14:50 CT" | "15:50 ET" | — |

**Not a finding:** `scripts/es-to-spx.ts` references `America/Chicago` only as a
selectable `--tz` CLI option for parsing raw ES CSV input; the default is
`America/New_York`. It is a tool parameter, not a hardcoded pipeline assumption.

## 4b. Slot timing — Greeks are applied at the frame END

UW exposes a frame's Greeks only **after** the frame closes, and stamps it with
the frame **END** time. A saved 2026-06-23 capture shows this: at 11:58 ET the
page still displayed `11:40 - 11:50` (with API `timestamp` = 11:50, the end), and
the forming `11:50 - 12:00` frame was not yet visible. So a slot's Greeks do not
exist until its end.

The algo therefore keys each slot to its END (`captured_at`) and applies it from
there — the causal, no-look-ahead timing: the `[13:10,13:20)` Greeks act from
13:20, the moment they're published. A price tick between Greek slots reuses the
most-recently-published slot with the current spot (see `densifyDecisions`).

> An earlier iteration added an opt-in `LOOKAHEAD_GREEKS_FROM_SLOT_START` toggle
> (later briefly defaulted on) to apply Greeks from the frame START, on the theory
> that UW published at the start. The 2026-06-23 capture disproved that, so the
> toggle and its slot-shifting were removed — end-keying is the only behaviour.

## 5. Verification

- `npx tsc --noEmit` — clean.
- `npm run test-cases` (2026-06-10 midday) — runs clean; cone bands and states
  are byte-for-byte unchanged vs before the CT→ET conversion, confirming the fix
  is behaviour-preserving.

After this change the algo pipeline speaks exactly two zones: **UTC** for stored
instants, **ET** for every wall-clock decision — no CT anywhere.
