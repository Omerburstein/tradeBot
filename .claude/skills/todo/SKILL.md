---
name: todo
description: Add a new work item to TODO.md from a short description. Appends a properly numbered, formatted checkbox entry to the correct section of the project backlog. Pass --clean to instead remove all completed items and renumber the remainder.
argument-hint: [--clean] <description of the task to add>
allowed-tools: [Read, Write]
---

# Todo Skill

Add a new task to the project backlog in `TODO.md`, or clean it up with `--clean`.

## Input

- **Full arguments:** $ARGUMENTS

---

## Mode A — `--clean` flag (no description needed)

Triggered when `$ARGUMENTS` starts with `--clean` (or is exactly `--clean`).

1. **Read `TODO.md`** in full.
2. **Remove every completed item** — any entry whose checkbox is `[x]` (including
   all its indented body lines and the blank line that follows it).
3. **Renumber** the surviving `[ ]` items sequentially starting from 1, updating
   the bold `**N. title**` prefix on each item's first line. Numbering is
   continuous across all sections (do not restart per section).
4. **Rewrite the file** with `Write`, preserving all section headings, the intro
   block, and blank lines between items.
5. **Confirm**: how many items were removed, how many remain, and the new
   numbering range.

---

## Mode B — add a new item (default, no flag)

1. **Read `TODO.md`** to learn the current format and the highest item number
   in use.
   - Items are `- [ ] **N. <title>**` checkbox entries with an indented body.
   - Sections seen so far: `## Algorithm` and `## Training / Backtesting`.

2. **Pick the section.** Choose the section the description best fits. If it
   clearly matches an existing one, append there. If it fits none, add it under
   `## Algorithm` (the default) unless the description names a different area —
   in that case create a new `## <Section>` heading.

3. **Number it.** Use the next integer after the current highest item number
   across the whole file (numbering is continuous across sections).

4. **Append the entry** with `Write` (rewrite the whole file with the new item
   added at the end of the chosen section):
   ```
   - [ ] **N. <Concise title derived from the description>.**
     <The full description, wrapped to ~80 cols, lightly cleaned up.>
   ```
   - Keep the user's intent verbatim; only tidy grammar/wrapping.
   - Leave a blank line between items.

5. **Confirm** the item number, section, and title. New items are always `[ ]`.

---

## Notes

- Never mark a new item as done (`[x]`).
- `--clean` does not add a new item, even if extra text follows the flag — ignore it.
- Match the existing markdown style exactly (bold `**N. title.**`, two-space indented body).

## Example usage

```
/todo make sure the algo only ever sees one frame at a time, never the future
/todo add a CLI flag to dump the score breakdown per slot
/todo --clean
```
