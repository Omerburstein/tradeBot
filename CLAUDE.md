# tradeBot — Claude Code Context

## What This Project Does

Production Railway-deployed scraper for [Unusual Whales Periscope](https://unusualwhales.com/dashboard/4) — a dashboard showing SPX options Greeks (Gamma, Charm, Vanna) by strike price. The scraper polls every minute during RTH, fetches the latest published per-minute snapshot directly from UW's periscope API (Greeks + positions, for the session expiry and the next trading day), and bulk-inserts it into Neon Postgres. A webhook fires once per 10-min window to trigger an auto-playbook Vercel app.

**Domain**: 0DTE SPX options Greeks — capturing Market Maker positioning (Gamma, Charm, Vanna) in 1-min snapshots (2026-07 UW redesign; was 10-min slots), Mon–Fri 09:30–16:00 ET.

---

## Directory Structure

```
scraper/
├── index.ts              # Entry point: main loop, lifecycle, schedule-aware dedup
├── core/                 # Shared infrastructure
│   ├── config.ts         # Env var validation + MS_PER_TICK constant
│   ├── types.ts          # Panel type + SnapshotRow interface
│   ├── dates.ts          # Timezone utilities (ET↔UTC, RTH/active-window gates)
│   ├── parser.ts         # LEGACY: HTML → SnapshotRow[] for the pre-2026-07 table view
│   ├── webhook.ts        # Auto-playbook webhook poster (non-blocking, 3-attempt retry)
│   └── logger.ts         # Shared Pino logger for the scrape/ engine
├── scrape/               # Playwright scrape engine (split from the old ~2000-line scrape.ts)
│   ├── index.ts          # Barrel: public API (scrapeAllPanels, scrapeBackfill, …)
│   ├── browser.ts        # Stealth init + withBrowser lifecycle
│   ├── api-types.ts      # API response interfaces + ApiCaptures + ScrapeResult
│   ├── api-transforms.ts # Pure API payload → SnapshotRow[]/MarketTideRow[] transforms
│   ├── api-helpers.ts    # Shared helpers: fetchPeriscopeTimestamps/Slot (direct API), storeMarketTide, storeCone
│   ├── captures.ts       # attachApiCaptures response router
│   ├── trading-calendar.ts # Holidays + trading-day arithmetic
│   ├── timeframe.ts      # HH:MM math (+ LEGACY walkers for the removed Timeframe widget)
│   ├── navigation.ts     # LEGACY: Expiry/DTE dialog + date-picker walkers (unused since 2026-07)
│   ├── chart.ts          # Chart-ready wait, zoom-out, spot/strike readers
│   ├── panels.ts         # scrapeAllPanels (live per-minute tick)
│   ├── orchestrate.ts    # Per-day scraper + backfill/range/walk-back entry points
│   └── discovery.ts      # discoverEndpoints dev helper (dump all JSON XHRs)
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
- `capturedAt` always represents slot **END** time. Since 2026-07 a "slot" is one minute: the 10:06–10:07 snapshot → `capturedAt = 10:07 ET` (pre-redesign 10-min rows, e.g. 09:20–09:30 → 09:30, remain valid). It is an absolute UTC instant and is unaffected by the CT→ET choice — only the wall-clock representation moved.
- **Never** use wall-clock time as `capturedAt`. The periscope API supplies the snapshot instant directly (`periscope/timestamps` UTC ISO entries — use them as-is); when deriving an instant from an ET wall-clock label, use `computeCapturedAt(date, slotEndHhmm)` in `core/dates.ts` (slotEndHhmm is ET).
- All timestamps stored as UTC ISO-8601 TIMESTAMPTZ in Postgres.
- **Do NOT assume container TZ** — `computeCapturedAt` computes the ET→UTC offset explicitly via `Intl.DateTimeFormat`. This was a regression (corrupted 5/4–5/7 data). Do not revert to `new Date(...).toISOString()` + env TZ.

### Anti-Bot Timing
- `waitForTimeout` calls with comments like `// anti-bot`, `// stealth`, or `// empirically tuned` are **intentional pacing delays** — do NOT replace them with locator-based waits
- The direct periscope API fetches are paced (~200-300ms between request pairs) to stay indistinguishable from the dashboard's own traffic — keep the pacing when adding fetch loops
- (Legacy, for the widget walkers kept as reference: day-chevron navigation was safe for <5 days; >10 consecutive clicks tripped UW anti-bot → calendar widget. Radix settle waits were 800ms/1.5s/5s.)

### Greeks & Panels
- The periscope/exposures response carries **Gamma, Charm, Vanna (and delta) for every strike in ONE payload per minute** — no per-panel capture order or timeframe-drift realignment exists anymore (both were artifacts of the pre-2026-07 three-panel scrape)
- Gamma is still the **anchor for persistence**: a strike's Charm/Vanna rows are kept only when that strike's |gamma| clears the threshold (see `db/snapshots.ts` `filterInsertable` and `exposuresToRows`)
- `delta` arrives from the new endpoint but is NOT persisted (DB `panel` CHECK allows gamma/charm/vanna)

### Greek-Frame Sanity (stale-underlying defect)
- **UW occasionally serves Greeks computed against a STALE underlying** — for the first ~2h of 2026-05-26 (long-weekend gap-up), gamma was priced off the prior close (~7480) while spot was ~7515. Live/evolving frames, correct minute+expiry, **positions matched byte-for-byte** — only the Greeks were wrong. Silent, plausible, self-consistent. The morning-block cases cluster on post-long-weekend gap-ups (2026-01-20 post-MLK, 02-17 post-Presidents', 05-26 post-Memorial); isolated single slots occur on ordinary days too.
- **Repaired 2026-07-17**: full-history audit found 56 corrupt slots across 15 days (2026-01 → 2026-06). Days still inside UW's periscope history floor were re-backfilled (UW recomputes the frames after the fact → a re-fetch returns correct data); days UW no longer serves, or specific slots UW still serves stale (06-09/10/11), were **deleted as gaps** — a gap is strictly better than a corrupt frame the algo would train on. Any re-tune must post-date this cleanup.
- **Invariant used to detect it** (`scraper/core/frame-quality.ts`): per-CONTRACT gamma (`|gamma| / |net position|`) peaks at the money for any expiry/IV/skew — a Black-Scholes kernel property. Gamma *exposure* alone can't check this (open interest piles up anywhere); dividing by net position cancels positioning and recovers the kernel, whose peak must sit within ~25 pts of an INDEPENDENT spot (spot_prices / cone apex — never the frame). Do NOT use "max-|gamma| strike near spot": it both misses the defect and false-positives on healthy data.
- Scan stored history any time with `npm run audit:frames` (read-only, exits 1 on any corrupt slot). Regression fixtures + threshold calibration live in `scraper/tests/frame-quality.test.ts` (pre-push gate).

### Scraping Path Consistency

All scraping paths — the live tick (`panels.ts`) and every backfill path (`orchestrate.ts`: single-date, range, walk-back) — **must behave identically** for any shared concern. This is enforced structurally:

- **API capture**: both paths call `attachApiCaptures(page)` from `captures.ts` — never inline a response listener again.
- **Snapshot fetching**: both call `fetchPeriscopeTimestamps` / `fetchPeriscopeSlot` from `api-helpers.ts` (direct authenticated GETs against `periscope/timestamps|exposures|positions`).
- **Market Tide + Cone storage**: both call `storeMarketTide` / `storeCone` from `api-helpers.ts`.

**When you change any of those concerns, change it in `api-helpers.ts` or `captures.ts` — not in `panels.ts` or `orchestrate.ts`.** The individual files only hold path-specific logic (latest-minute selection, slot iteration, RTH guards).

---

### DB Schema Sync
- `SnapshotRow` in `scraper/core/types.ts` must stay in sync with `insertSnapshots` in `db/snapshots.ts`
- Unique constraint: `(captured_at, expiry, panel, strike)` → inserts are idempotent (`ON CONFLICT DO NOTHING`)

### Schedule-Aware Dedup & Webhook Cadence
- `lastFullWindowEnd` tracks the last captured snapshot's end minute (e.g., `"10:07"`, ET)
- If `expectedWindowEnd(now, 1) === lastFullWindowEnd`, skip Playwright entirely (current minute already captured)
- This resets to `null` on overnight/weekend transitions
- The auto-playbook webhook fires once per **10-min window** (first captured snapshot landing in a new window), NOT once per minute — the Vercel app runs Claude per invocation, so per-minute firing would 10× that cost

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
| `APP_ENV` | `staging` routes all DB writes to `STAGING_DATABASE_URL` instead of `DATABASE_URL`. Any other value (default) = production. |
| `STAGING_DATABASE_URL` | Neon staging-branch connection string. **Required** when `APP_ENV=staging`; the scraper fails loudly rather than falling back to prod. |

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
| `BACKFILL_START` / `BACKFILL_END` | ET HH:MM bounds on backfilled `captured_at` instants (defaults 09:31 / 16:00) |
| `BACKFILL_STEP_MIN` | Backfill minute step (default 10 = historical cadence/volume; 1 = full minute resolution) |
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

1. **UW replaced the periscope endpoints in 2026-07**: `market_maker_exposures` / `market_maker_contracts` are GONE. The current API is `periscope/timestamps?date=` (lists every published minute), and `periscope/exposures` / `periscope/positions` keyed by `ticker=SPX&expiries=<YYYY-MM-DD>&timestamp=<epoch-ms>&prev_minutes=10,20` (note: `expiries`, plural). Response shapes also changed: `data` is an array, Greeks are numbers, exposures carry `delta`, positions use `option_type`/`market_maker`, and there is no top-level `date`/`index_values` (spot comes from the page header or the last 1-min tick). The old "Timeframe:" widget no longer exists on the page.

2. **`US_MARKET_HOLIDAYS` is hardcoded** in `scrape/trading-calendar.ts` (2025–2026). Update annually in December. Used to skip backfill days (perf optimization, not a correctness gate).

3. **Date-keyed tick endpoints ignore their `date` param** (net-flow-ticks, one_minute_ticks) — they always return the LATEST session. Historical intraday spot comes only from `index_candles/SPX/5m` (~30 trading days back).

4. **Webhook is non-blocking**: Webhook failures log to Sentry but never block the next tick. If `VERCEL_BASE_URL` is unset, webhook is silently skipped.

5. **3 consecutive empty scrapes**: Triggers a Sentry warning — likely means UW session logout or a rendering outage, not genuinely empty data.

6. **(Legacy widget lore, relevant only to `navigation.ts`/`timeframe.ts` reference code)**: headless mode used to get an "All"-placeholder expiry dropdown; Radix popovers could stack and block clicks; day-chevron walking past ~10 clicks tripped anti-bot.

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
3. `git push origin HEAD:main`

Notes:
- The working branch is `main` — commit and push straight to it.
- A `pre-push` hook runs `tsc --noEmit` + `npm run test:unit`. **Never
  bypass it** (`--no-verify`) — if it fails, fix the underlying issue.
- Do not commit transient artifacts: `docs/temp/` (scrape/debug dumps)
  and `.claude/worktrees/` are gitignored — keep it that way.