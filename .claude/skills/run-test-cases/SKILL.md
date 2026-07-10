---
name: run-test-cases
description: Replay the curated TEST_CASES in algorithms/test-cases.ts under a chosen config (best model, latest model, a config file, or DEFAULT_CONFIG), optionally for a single case, then report per-case trades and net PnL.
argument-hint: [best|latest|default|<path-to-config.json>] [case-id]   e.g. /run-test-cases best 2026-06-05-1400
allowed-tools: [Bash, Read]
---

# Run Test Cases Skill

Replay the explained test cases (`TEST_CASES` in `algorithms/test-cases.ts`)
through the `SignalGenerator` and report the trades + net PnL. Each case also
writes an SVG to `docs/test-cases/<id>.svg`, and every run tees its full
explained output to `docs/test-cases/logs/` (a timestamped
`test-cases-<UTC>.log` plus `latest.log`; both gitignored).

## Input

- **Full arguments:** $ARGUMENTS

Two optional positional args, in any order:

1. **Config selector** (default `default`):
   - `best`   → the `bestModel` config in `algorithms/tuned-models.json`
   - `latest` → the `lastModel` config in `algorithms/tuned-models.json`
   - `default` → `DEFAULT_CONFIG` from `algorithms/types.ts`
   - a path ending in `.json` → a config file (full config or partial diff,
     shallow-merged over `DEFAULT_CONFIG`)
2. **Case id** (optional) — e.g. `2026-06-05-1400`. When present, only that one
   case runs. The known ids are the `id:` fields in the `TEST_CASES` array.

---

## Steps

### 1. Parse the arguments

From `$ARGUMENTS`, identify the config selector and the optional case id.

- A token that is exactly `best`, `latest`, or `default`, or ends in `.json`,
  is the **config selector**. If none is present, use `default`.
- A token that looks like a case id (`YYYY-MM-DD...`) is the **case id**.
- If two config selectors are given, stop and ask which one.

### 2. Map to the run command

Pick the command by selector (prepend `TEST_CASE_ID=<id>` when a case id was given):

| Selector        | Command                          |
|-----------------|----------------------------------|
| `best`          | `npm run test-cases:best`        |
| `latest`        | `npm run test-cases:latest`      |
| `default`       | `npm run test-cases`             |
| `<path>.json`   | `ALGO_CONFIG_PATH=<path> npm run test-cases` |

Example (best model, single case):
```
TEST_CASE_ID=2026-06-05-1400 npm run test-cases:best
```

### 3. Run it

Run the command with the Bash tool (allow up to ~5 min for a full-suite run —
each case replays a full trading day; a single case is fast).

### 4. Report

Surface the real output, not a paraphrase:
- The `Config source:` line (confirms which config actually ran).
- The final `TEST-TRADE RESULT` line (case count, trade count, net PnL).
- If the user asked about specific behavior, quote the relevant per-slot
  `why:` / `factors:` lines from the timeline (e.g. the GEX-TP gate, cone
  state, composite-z thresholds). The full run is also saved to
  `docs/test-cases/logs/latest.log` if you need to re-read it.
- Mention the SVG path(s) under `docs/test-cases/` and the `Log written:` path.

## Notes

- The `best`/`latest` slots come from `npm run tune` (recorded via
  `algorithms/model-store.ts`). If a slot is empty the run errors with a clear
  message — tell the user to run `npm run tune` first or pick another selector.
- Config precedence in `test-cases.ts`: `--best`/`USE_BEST_MODEL` >
  `--latest`/`USE_LATEST_MODEL` > `ALGO_CONFIG_PATH` > `DEFAULT_CONFIG`.
