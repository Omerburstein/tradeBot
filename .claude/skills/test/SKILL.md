---
name: test
description: Test a file, folder, or described behavior in the tradeBot scraper using provided data. Reads the target, runs the relevant checks (tsc, FORCE_TICK tick, or ad-hoc), and reports pass/fail with real output.
argument-hint: <file-or-folder> <test description / relevant data>
allowed-tools: [Read, Glob, Grep, Bash]
---

# Test Skill

Run a focused test against a target in this repo using the description and data the user provided.

## Input

- **Target (file or folder):** `$1`
- **Full request (target + description + data):** $ARGUMENTS

## Instructions

1. **Locate the target.** `$1` is a file or folder path.
   - If it's a folder, use Glob/Grep to enumerate the relevant `.ts`/`.mjs` files.
   - Read the target so you understand what's actually being tested before writing or running anything.

2. **Interpret the rest of the arguments** as the test description plus any data/fixtures the user supplied (expected inputs, expected outputs, edge cases, sample HTML, etc.). Everything after the path in $ARGUMENTS is the spec for what "passing" means.

3. **Pick the right verification method** for this project (it has no automated test suite — `tsc --noEmit` is the primary correctness gate):
   - **Type correctness** (any `.ts` edit): always run `npx tsc --noEmit`.
   - **Pure-function behavior** (e.g. `parser.ts`, `dates.ts`): write a small one-off `tsx` script under `docs/tmp/` (or inline via `npx tsx -e "..."`) that imports the function, feeds it the provided data, and asserts the expected output. Delete it after if it was scratch.
   - **End-to-end scrape/auth/selectors**: run a one-shot tick with `FORCE_TICK=true npm start` (add `HEADLESS=false` to watch, `SAVE_SCREENSHOT=true` to capture `docs/tmp/page.png` + `page.html`). Respect the anti-bot timing invariants in CLAUDE.md — don't add or shorten waits.
   - **Date/timezone logic**: verify against `computeCapturedAt` / RTH gate semantics; never assume container TZ.

4. **Run it** and capture the actual output. On Windows, set env vars the PowerShell way (`$env:FORCE_TICK='true'; npm start`) or use the Bash tool with POSIX syntax.

5. **Report** clearly:
   - ✅/❌ per check, with the real command output (don't paraphrase failures).
   - If it failed, show the diff between expected and actual and your read on the root cause.
   - If the test required code changes to be testable, say what you added and whether it's scratch or worth keeping.

## Notes

- Honor the Critical Invariants in `CLAUDE.md` (timestamps = slot END, Gamma→Charm→Vanna order, intentional anti-bot waits, DB schema sync). A "passing" test that violates an invariant is a failing test.
- Keep scratch artifacts in `docs/tmp/`. Never commit auth state or log raw `storageState` JSON.

## Example usage

```
/test scraper/parser.ts parse an empty Gamma panel and expect SnapshotRow[] to be []
/test scraper/dates.ts computeCapturedAt for 2025-11-14 slot end 08:30 CT should be 14:30Z
/test scraper/ FORCE_TICK one-shot to confirm auth + selectors still work
```
