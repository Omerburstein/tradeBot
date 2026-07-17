---
name: role
description: Register or verify algorithm design roles. `/role <description>` appends a new role to algorithms/ROLES.md; `/role --check` verifies every role in the file still matches the code.
argument-hint: <role description>  |  --check
allowed-tools: [Read, Edit, Grep, Glob]
---

# Role Skill

Maintain the algorithm's design **roles** (rules) in
[`algorithms/ROLES.md`](../../../algorithms/ROLES.md). A role is a
plain-language invariant plus code **anchors** — the exact spots that are
supposed to implement it. The file is delimited by
`<!-- ROLES:START -->` / `<!-- ROLES:END -->`; only edit between those markers.

## Input

- **Full arguments:** $ARGUMENTS

Decide the mode from `$ARGUMENTS`:

- Contains the token `--check` → **CHECK mode** (verify, read-only).
- Otherwise → **ADD mode**: the arguments are the description of a new role. If
  `$ARGUMENTS` is empty, stop and ask what the role is.

---

## ADD mode — append a new role

1. **Read `algorithms/ROLES.md`.** Find the highest existing `## R<N>` id
   between the `ROLES:START` / `ROLES:END` markers; the new id is `R<N+1>`
   (`R1` if there are none yet).

2. **Understand the role.** Turn `$ARGUMENTS` into one crisp `**Rule:**`
   sentence. If it restates something already covered by an existing role, stop
   and tell the user which one — do not add a duplicate.

3. **Find the code anchors.** Search the algorithm source (start with
   `algorithms/score-engine.ts` and `algorithms/types.ts`, widen with Grep if
   needed) for the lines that implement — or should implement — the rule. Record
   them as `file → function: <exact snippet or symbol>`. If nothing implements it
   yet, say so explicitly in the anchor (`(not yet implemented)`), so `--check`
   will surface it.

4. **Append the block** just before the `<!-- ROLES:END -->` marker, matching the
   existing style exactly:

   ```markdown
   ## R<N+1> — <short title>

   **Rule:** <one sentence>

   **Anchors:**
   - `<file>` → `<fn>`: `<snippet or symbol>`

   **Verify:** <a concrete, checkable assertion about the code>
   ```

   Use `Edit` with `old_string` = the `<!-- ROLES:END -->` line and
   `new_string` = the new block followed by that same marker line.

5. **Confirm** with one line: `Added role R<N+1> — <title>  →  algorithms/ROLES.md`.

---

## CHECK mode — verify roles match the code

1. **Read `algorithms/ROLES.md`** and collect every `## R<N>` block with its
   `**Rule:**`, `**Anchors:**`, and `**Verify:**` lines.

2. **For each role**, open the anchored file(s) and locate the referenced
   symbols/snippets (`Read` the relevant lines; `Grep` when a line has moved).
   Evaluate the `**Verify:**` assertion against what the code actually does:
   - **MATCH** — the code implements the rule as the anchors/verify describe.
   - **MISMATCH** — the code contradicts the rule, the anchored snippet is gone,
     or the verify assertion is false. Explain exactly what differs
     (file:line and the actual code).

   Do not treat a role as satisfied just because a symbol *name* exists — check
   the behavior the Verify line asserts (e.g. the bias is on the correct branch,
   the delta really subtracts two `Math.abs(...)` terms).

3. **Report** a compact table, most-severe first, then the details for any
   MISMATCH:

   ```
   ROLE CHECK — algorithms/ROLES.md
   R1  MATCH     positive-gamma bias
   R2  MATCH     abs-value levels
   R3  MISMATCH  derivatives on abs value
       └ score-engine.ts:159 — dPositions uses `s.positions - prev.positions`
         (raw signed), not `Math.abs(s.positions) - Math.abs(prev.positions)`.
   ```

   End with a one-line verdict: `N/N roles match` or list the failing ids. This
   mode never edits any file.

---

## Notes

- Only ever touch the region between `ROLES:START` and `ROLES:END`.
- Keep R-ids stable and unique — they are how the user refers to a role.
- CHECK mode is read-only (`Read`/`Grep`/`Glob` only). If a mismatch is found,
  report it; do not silently "fix" the code or the role — that is the user's call.
- Anchors are guidance, not exact line numbers: prefer symbols and snippets so
  the check survives line drift.
