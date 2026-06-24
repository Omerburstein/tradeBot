# tradeBot — Claude Code Context

## What This Project Does

Production Railway-deployed scraper for [Unusual Whales Periscope](https://unusualwhales.com/dashboard/4) — a dashboard showing SPX options Greeks (Gamma, Charm, Vanna) by strike price. The scraper polls every minute during RTH, captures the three Greek panels, parses them, and bulk-inserts snapshots into Neon Postgres. A webhook fires on each new insert to trigger an auto-playbook Vercel app.

**Domain**: 0DTE SPX options Greeks — capturing Market Maker positioning (Gamma, Charm, Vanna) in 10-min slots, Mon–Fri 09:20–16:00 ET.

---

## Directory Structure

```
scraper/
├── index.ts              # Entry point: main loop, lifecycle, schedule-aware dedup
├── core/                 # Shared infrastructure
│   ├── config.ts         # Env var validation + MS_PER_TICK constant
│   ├── types.ts          # Panel type + SnapshotRow interface
│   ├── dates.ts          # Timezone utilities (ET↔UTC, RTH/active-window gates)
│   ├── parser.ts         # Pure HTML → SnapshotRow[] (node-html-parser, no DOM)
│   ├── webhook.ts        # Auto-playbook webhook poster (non-blocking, 3-attempt retry)
│   └── logger.ts         # Shared Pino logger for the scrape/ engine
├── scrape/               # Playwright scrape engine (split from the old ~2000-line scrape.ts)
│   ├── index.ts          # Barrel: public API (scrapeAllPanels, scrapeBackfill, …)
│   ├── browser.ts        # Stealth init + withBrowser lifecycle
│   ├── api-types.ts      # API response interfaces + ApiCaptures + ScrapeResult
│   ├── api-transforms.ts # Pure API payload → SnapshotRow[]/MarketTideRow[] transforms
│   ├── api-helpers.ts    # Shared helpers: pickBestMme/Mmc, storeMarketTide, storeCone
│   ├── captures.ts       # attachApiCaptures response router
│   ├── trading-calendar.ts # Holidays + trading-day arithmetic
│   ├── timeframe.ts      # Timeframe HH:MM math + widget walkers
│   ├── navigation.ts     # Expiry/DTE filters + date-picker walkers
│   ├── chart.ts          # Chart-ready wait, zoom-out, spot/strike readers
│   ├── panels.ts         # scrapeAllPanels (live single-slot tick)
│   └── orchestrate.ts    # Per-day scraper + backfill/range/walk-back/discover
├── tools/                # Dev/probe utilities
│   ├── probe.ts          # One-shot scrapeAllPanels runner
│   ├── discover.ts       # Dump all JSON XHRs for endpoint discovery
│   ├── read-all.ts       # Walk-back history reader
│   └── periscope-probe.mjs # Phase-0 dev tool: headed login + selector discovery
└── tests/
    ├── schedule.test.ts  # Dependency-free unit tests (pre-push gate)
    └── integration.test.ts # Live auth + DB integration test

db/                       # Neon Postgres persistence layer (repo-root sibling of
│                         # scraper/ and algorithms/ — shared by both: the scraper
│                         # writes, the algo reads)
├── index.ts              # Barrel: public API (getDb, insertSnapshots, filterInsertable, …)
├── client.ts             # Singleton Neon client + isRthRow + MAX_ROWS_PER_INSERT
├── snapshots.ts          # filterInsertable (RTH + gamma threshold + cross-panel gate) + insertSnapshots
├── spot-prices.ts        # insertSpotPrice / insertSpotPrices
├── market-tide.ts        # insertMarketTide
├── positions.ts          # insertPositions
└── cone.ts               # coneSnapshotExists + insertConeSnapshot
```

---

## Tech Stack

- **Node.js 24+ / TypeScript 5.7** (strict, ESM, no build step — `tsx` executor)
- **Playwright + playwright-extra + puppeteer-extra-plugin-stealth** — headless Chromium with 17+ anti-detection modules
- **Neon Postgres** (`@neondatabase/serverless`) — serverless connection, batch inserts
- **Pino** — structured JSON logging
- **Sentry** — error tracking (initialized before all other imports in `index.ts`)

---

## Critical Invariants

### Timestamps & Timezone
- **All wall-clock representation is Eastern Time (ET / America/New_York)** — matching exactly what the UW Periscope dashboard displays. The `timeframe` label, the slot-END gates, dedup, and the headless browser's `timezoneId` all speak ET. (Converted from CT on 2026-06-20 so DB labels match the dashboard; ET is always +1h from the SPX pit's CT, so the same real-world instants are preserved.)
- `capturedAt` always represents slot **END** time (e.g., the 09:20–09:30 slot → `capturedAt = 09:30 ET`). It is an absolute UTC instant and is unaffected by the CT→ET choice — only the wall-clock representation moved.
- **Never** use wall-clock time as `capturedAt`; use `computeCapturedAt(date, slotEndHhmm)` in `core/dates.ts` (slotEndHhmm is ET).
- All timestamps stored as UTC ISO-8601 TIMESTAMPTZ in Postgres.
- **Do NOT assume container TZ** — `computeCapturedAt` computes the ET→UTC offset explicitly via `Intl.DateTimeFormat`. This was a regression (corrupted 5/4–5/7 data). Do not revert to `new Date(...).toISOString()` + env TZ.

### Anti-Bot Timing
- `waitForTimeout` calls with comments like `// anti-bot`, `// stealth`, or `// empirically tuned` are **intentional pacing delays** — do NOT replace them with locator-based waits
- Day-chevron navigation: safe for <5 days; >10 consecutive clicks triggers UW anti-bot → use calendar widget
- Settle waits (800ms Radix animation, 1.5s data refetch, 5s edge cases) were tuned empirically — do not reduce without testing

### Greeks & Panels
- Greeks are captured in order: **Gamma → Charm → Vanna**
- Gamma is the **anchor**: Charm and Vanna must match Gamma's timeframe or the scraper realigns
- If UW publishes a new slot mid-capture (timeframe drift), the scraper detects it and walks back to the gamma timeframe

### Scraping Path Consistency

All scraping paths — the live tick (`panels.ts`) and every backfill path (`orchestrate.ts`: single-date, range, walk-back) — **must behave identically** for any shared concern. This is enforced structurally:

- **API capture**: both paths call `attachApiCaptures(page)` from `captures.ts` — never inline a response listener again.
- **Response selection** (best MME / MMC): both call `pickBestMme` / `pickBestMmc` from `api-helpers.ts`.
- **Market Tide + Cone storage**: both call `storeMarketTide` / `storeCone` from `api-helpers.ts`.

**When you change any of those four concerns, change it in `api-helpers.ts` or `captures.ts` — not in `panels.ts` or `orchestrate.ts`.** The individual files only hold path-specific logic (navigation, expiry switching, slot walking, RTH guards).

---

### DB Schema Sync
- `SnapshotRow` in `scraper/core/types.ts` must stay in sync with `insertSnapshots` in `db/snapshots.ts`
- Unique constraint: `(captured_at, expiry, panel, strike)` → inserts are idempotent (`ON CONFLICT DO NOTHING`)

### Schedule-Aware Dedup
- `lastCapturedWindowEnd` tracks the last captured slot's end time (e.g., `"09:30"`, ET)
- If `expectedWindowEnd(now) === lastCapturedWindowEnd`, skip Playwright entirely (no new data yet)
- This resets to `null` on overnight/weekend transitions

---

## Environment Variables

### Required
| Var | Purpose |
|-----|---------|
| `DATABASE_URL` | Neon connection string (must include `?sslmode=require`) |
| `UW_AUTH_STATE_PATH` | Path to Playwright storageState JSON (default: `/data/uw-auth-state.json`) |

### Optional
| Var | Purpose |
|-----|---------|
| `UW_PERISCOPE_URL` | Periscope page URL (default: `https://unusualwhales.com/dashboard/4`) |
| `LOG_LEVEL` | Pino log level (default: `info`) |
| `SENTRY_DSN` | If unset, errors go to stdout only |

### Railway Deployment
| Var | Purpose |
|-----|---------|
| `UW_AUTH_STATE_B64` | Base64-encoded storageState JSON; decoded to `UW_AUTH_STATE_PATH` at boot |
| `VERCEL_BASE_URL` | Auto-playbook webhook base URL |
| `PERISCOPE_WEBHOOK_SECRET` | `x-webhook-secret` header value |

### Development
| Var | Purpose |
|-----|---------|
| `FORCE_TICK=true` | One-shot tick bypassing market-hours gate (test auth/selectors) |
| `BACKFILL_DATE=YYYY-MM-DD` | Backfill a single date |
| `BACKFILL_DATE_START` / `BACKFILL_DATE_END` | Multi-day backfill range |
| `HEADLESS=false` | Visible browser (pair with `FORCE_TICK=true`) |
| `SAVE_SCREENSHOT=true` | Save `page.png` + `page.html` to `docs/tmp/` after capture |

---

## Running Locally

```bash
npm install

# Verify auth + selectors (one-shot tick, bypasses market hours)
FORCE_TICK=true npm start

# Backfill a single date
BACKFILL_DATE=2025-11-14 npm start

# Headed browser for debugging selectors
FORCE_TICK=true HEADLESS=false npm start
```

## Verify Changes

```bash
npx tsc --noEmit
```

Always run this after editing TypeScript files. The project has no automated test suite — `tsc --noEmit` is the primary correctness gate.

---

## Known Gotchas

1. **Headless Single-date dropdown**: UW returns an "All" placeholder in headless mode instead of the date list. Workaround: fall back to `walkDateToTarget` + `DTE=[0,0]`. The headed probe (`periscope-probe.mjs`) gets the full list — likely UW's headless-detection guard.

2. **`US_MARKET_HOLIDAYS` is hardcoded** in `scrape/trading-calendar.ts` (2025–2026). Update annually in December. Used to skip backfill days (perf optimization, not a correctness gate).

3. **Radix popovers**: Multiple poppers can be mounted simultaneously. Locators filter by content to avoid clicking wrong ones. Close animation from one click can block the next; scraper settles + uses `force: true` + retries.

4. **Webhook is non-blocking**: Webhook failures log to Sentry but never block the next tick. If `VERCEL_BASE_URL` is unset, webhook is silently skipped.

5. **3 consecutive empty scrapes**: Triggers a Sentry warning — likely means UW session logout or a rendering outage, not genuinely empty data.

---

## Auth State Management

- **Local dev**: Run `node scraper/tools/periscope-probe.mjs --login` for a headed browser login → saves `~/.periscope-probe-auth.json`
- **Railway**: Set `UW_AUTH_STATE_B64` (base64 of the storageState JSON). `index.ts` decodes it to `UW_AUTH_STATE_PATH` at boot. **Never commit or log the raw storageState JSON.**

---

## Deployment (Railway)

- Runs as `npm start` → continuous 1-min polling loop during active window (Mon–Fri 09:21–16:14 ET)
- Fires one tick immediately on boot to avoid missing data after container restart
- SIGTERM handler flushes Sentry then exits cleanly (Railway restart-safe)
- Observability: Sentry for errors + pino JSON logs to stdout (Railway log pipeline)

---

## Git Workflow

**Commit and push automatically** after completing a change — do NOT wait
to be asked each time. The standard end-of-task flow is:

1. `npx tsc --noEmit` (the correctness gate — must pass first)
2. `git add -A && git commit` with a clear message (end with the
   `Co-Authored-By: Claude ...` trailer)
3. `git push origin HEAD:Adapt-scraper-to-own-usage`

Notes:
- The working branch is `Adapt-scraper-to-own-usage`. The local checkout
  is confusingly named `remotes/origin/Adapt-scraper-to-own-usage`, so
  **push with the explicit refspec** `HEAD:Adapt-scraper-to-own-usage`
  (a bare `git push` may fail / target the wrong ref).
- A `pre-push` hook runs `tsc --noEmit` + `npm run test:unit`. **Never
  bypass it** (`--no-verify`) — if it fails, fix the underlying issue.
- Do not commit transient artifacts: `docs/temp/` (scrape/debug dumps)
  and `.claude/worktrees/` are gitignored — keep it that way.