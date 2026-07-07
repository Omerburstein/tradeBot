---
name: add-test-case
description: Append a new entry to the TEST_CASES array in algorithms/test-cases.ts. Provide a date and time window; the skill generates a stable id, auto-description, and inserts the case.
argument-hint: <YYYY-MM-DD> <HH:MM>-<HH:MM>   e.g. /add-test-case 2026-06-15 09:30-11:00
allowed-tools: [Read, Edit]
---

# Add Test Case Skill

Append a new `TestCase` entry to the `TEST_CASES` array in
`algorithms/test-cases.ts`.

## Input

- **Full arguments:** $ARGUMENTS

---

## Steps

### 1. Parse the arguments

Extract **date**, **startEt**, and **endEt** from `$ARGUMENTS`.

Accepted formats (all equivalent):
- `2026-06-15 09:30-11:00`
- `2026-06-15 09:30 to 11:00`
- `2026-06-15 from 09:30 to 11:00`
- `2026-06-15 09:30 -> 2026-06-15 11:00` (repeated date + arrow also accepted)
- `2026-6-15 9:30-11:00` (single-digit month/hour also accepted)

Normalise the date to `YYYY-MM-DD` (zero-pad month and day).
Normalise times to `HH:MM` (zero-pad hour).

If the arguments cannot be parsed into a date + two times, stop and explain
what was wrong — do **not** edit any file.

### 2. Read `algorithms/test-cases.ts`

Read the file. Confirm it contains the `TEST_CASES` array.

### 3. Generate a stable `id`

Format: `{date}-{startHH}{startMM}` — e.g., `2026-06-15-0930`.

If an entry with that `id` already exists in `TEST_CASES`, stop and tell the
user — do **not** add a duplicate.

### 4. Build the new `TestCase` object

Use this TypeScript literal (fill in the placeholders):

```typescript
  {
    id: '{id}',
    date: '{date}',
    startEt: '{startEt}',
    endEt: '{endEt}',
    description:
      '{startEt}–{endEt} ET — inspect composite z-score, gamma exposure and ' +
      'expected-move cone between {startEt} and {endEt} ET on {date}.',
  },
```

### 5. Insert it into the file with `Edit`

Find the closing `];` of the `TEST_CASES` array (the last line that is exactly
`];` inside that block). Replace it so the new entry appears just before it:

```
  {existing last entry ...},        ← leave untouched
  {
    id: '...',
    ...new entry...
  },
];
```

Use Edit with `old_string` = the last `  },\n];` of the array, and `new_string`
= that same trailing `  },\n` + the new entry block + `\n];`.

If the array currently has only one entry, the `old_string` to match is:

```
  },
];
```

(two spaces before `},`, then `];` on its own line — match exactly as it
appears in the file.)

### 6. Confirm

Print a one-line summary:
```
Added test case '{id}': {date} {startEt}–{endEt} ET  →  algorithms/test-cases.ts
```

---

## Notes

- Never modify anything outside the `TEST_CASES` array.
- Never add the case if parsing fails or the id already exists.
- Match the indentation style exactly: two-space indent for array entries,
  four spaces for object fields (same as the existing entry).
- The `description` is a single auto-generated sentence; the user can edit it
  manually afterwards if needed.

## Example invocations

```
/add-test-case 2026-06-15 09:30-11:00
/add-test-case 2026-07-01 from 13:00 to 16:00
/add-test-case 2026-06-20 14:00-15:30
```
