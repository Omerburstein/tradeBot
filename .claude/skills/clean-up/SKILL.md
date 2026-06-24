---
name: clean-up
description: Refactor a file, folder, or the entire project by removing dead imports, extracting magic numbers to constants/env, enforcing DRY and single-source-of-truth, applying OOP where appropriate, and splitting large functions/files into focused units. Safe to run repeatedly — each pass is incremental.
argument-hint: [file-or-folder]
allowed-tools: [Read, Edit, Write, Glob, Grep, Bash, TodoWrite]
---

# Clean-Up Skill

Systematically improve code quality in the target without changing observable behaviour.

## Input

- **Target (optional file or folder path):** `$1`
  - If omitted, target is the entire project.
  - If a folder, all `.ts` / `.mjs` files inside are in scope.

## Seven Rules

Apply **all** of the following to every in-scope file. Work through them in order — later rules build on earlier ones.

### Rule 1 — Remove unnecessary imports
- Delete any `import` statement (or individual named import) where the symbol is never referenced in the file after the import line.
- After removing, verify nothing breaks: `npx tsc --noEmit` must still pass.
- Do **not** remove imports that are used only for their side-effects (e.g. `import './sentry'`) — leave those with a `// side-effect` comment if one isn't already present.

### Rule 2 — Eliminate magic numbers (and magic strings)
- Any numeric or string literal that encodes domain knowledge (timeouts, thresholds, limits, port numbers, URL fragments, slot durations, retry counts, etc.) is a magic value.
- Extract each one to a named constant. The name must encode the *why*, not just the value (`MAX_RETRY_ATTEMPTS = 3`, not `THREE = 3`).
- Exception: `0`, `1`, `-1`, `true`, `false`, `""`, `[]`, `{}` used in obvious idioms (array index 0, increment by 1, empty default) are not magic.

### Rule 3 — Place constants in the right home
Decide the right scope for each extracted constant:

| Kind | Where it lives |
|---|---|
| Deployment / infrastructure config (URLs, credentials, feature flags, timeouts that ops might tune) | `core/config.ts` as an env-backed export, with a sensible default |
| Domain knowledge fixed by the business (slot duration, Greek order, RTH window, holiday list) | `core/config.ts` or the module that owns that domain, exported as a `const` |
| Pure algorithmic constants used only inside one function | top of that function or file |

Never leave a magic value inlined where it would need to be changed in more than one place.

### Rule 4 — Apply OOP where it adds clarity
OOP is appropriate when:
- A group of functions all share the same mutable state (convert to a class with private fields).
- A concept is reused across modules and carries both data *and* behaviour (extract an interface or class).
- Constructor injection makes dependencies explicit and testable.

OOP is **not** appropriate for:
- Pure stateless transforms (keep them as plain functions).
- Simple config/constants modules.
- One-off utilities with no shared state.

Do not introduce classes just to have classes. Prefer the simplest structure that satisfies Rule 7.

### Rule 5 — Split large units into focused pieces
Thresholds that should trigger a split:
- **Function**: > ~40 lines of logic (excluding blank lines and comments) → extract inner steps into helpers.
- **File**: > ~250 lines *and* the file clearly contains multiple distinct concerns → split by concern into sibling files.
- **Folder**: if a folder has grown to hold both infrastructure *and* domain logic, reorganise into sub-folders.

When splitting a file:
1. Create the new sibling file(s) in the same directory.
2. Update the barrel (`index.ts`) if one exists.
3. Update all import sites inside the same target scope.
4. Do **not** rename exported symbols — only move them.

### Rule 6 — Eliminate code duplication
- Any block of logic that appears in ≥ 2 places (identical or near-identical) must be extracted into a shared helper and all call sites updated to use it.
- "Near-identical" means: same structure, different variable names or minor parameter differences — parameterise the difference, don't copy-paste.
- Prefer extracting to the lowest common ancestor module (if both callers are in `scrape/`, extract there; if callers span `scrape/` and `core/`, extract to `core/`).

### Rule 7 — Single source of truth
Every concept, value, or behaviour must live in **one canonical place**:
- If changing a business rule requires editing more than one file → consolidate.
- If the same derived value is computed independently in multiple places → compute once, pass as argument or export as constant.
- Cross-check: after your changes, ask "if I needed to change X, how many files would I touch?" The answer should be 1 for any non-trivial concept.

---

## Execution Steps

1. **Identify scope.**
   - If `$1` is a file: operate only on that file.
   - If `$1` is a folder: `Glob` for `**/*.ts` and `**/*.mjs` within it.
   - If no argument: `Glob` the full project (`scraper/**/*.ts`, `scraper/**/*.mjs`).

2. **Read and index the scope.** For each file, note:
   - All imports (used vs unused).
   - All inline literals that might be magic values.
   - File length and whether it mixes concerns.
   - Any repeated logic patterns (grep for similar blocks across files).

3. **Plan the changes.** Use `TodoWrite` to list every concrete action before touching any file. Group by rule. Flag any change that moves/renames a file as high-risk and call it out explicitly.

4. **Apply changes incrementally**, rule by rule:
   - Complete Rule 1 across all in-scope files before starting Rule 2, etc.
   - After each rule, run `npx tsc --noEmit`. If it fails, fix the type error before proceeding.

5. **Final type-check.** After all rules are applied, run `npx tsc --noEmit` one last time and confirm it passes.

6. **Summarise.** Report:
   - Files modified / created / deleted.
   - A bullet per rule: what was found and what was done (or "nothing to do").
   - The final `tsc` result.

---

## Guardrails

- **Never change observable behaviour.** If a refactor would change what the code does at runtime, stop and flag it to the user instead of applying it silently.
- **Preserve intentional anti-bot waits.** Any `waitForTimeout` with a comment (`// anti-bot`, `// stealth`, `// empirically tuned`) must not be touched — these are not magic numbers, they are empirically calibrated delays (see CLAUDE.md).
- **Honor Critical Invariants** (slot-END `capturedAt`, Gamma→Charm→Vanna order, ET timezone, DB schema sync). Do not refactor in a way that would obscure or break these.
- **Do not add comments** explaining what code does — only add them when the WHY is non-obvious (hidden constraint, subtle invariant, workaround). Remove pre-existing "what" comments you encounter.
- **Do not commit.** The skill only edits files. The user decides when to commit.

---

## Example usage

```
/clean-up
/clean-up scraper/core/
/clean-up scraper/scrape/panels.ts
/clean-up scraper/scrape/orchestrate.ts
```
