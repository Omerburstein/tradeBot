# tradeBot — Claude Code Context

## What This Project Does

Production Railway-deployed scraper for [Unusual Whales Periscope](https://unusualwhales.com/dashboard/4) — a dashboard showing SPX options Greeks (Gamma, Charm, Vanna) by strike price. The scraper polls every minute during RTH, captures the three Greek panels, parses them, and bulk-inserts snapshots into Neon Postgres. A webhook fires on each new insert to trigger an auto-playbook Vercel app.

**Domain**: 0DTE SPX options Greeks — capturing Market Maker positioning (Gamma, Charm, Vanna) in 10-min slots, Mon–Fri 08:20–15:00 CT.

---

## Directory Structure

```
scraper/
├── index.ts          # Entry point: main loop, lifecycle, schedule-aware dedup
├── scrape.ts         # Playwright automation, anti-detection, HTML parsing orchestration (~1400 lines)
├── parser.ts         # Pure HTML → SnapshotRow[] (node-html-parser, no DOM)
├── db.ts             # Neon Postgres batch inserts (500 rows/call)
├── dates.ts          # Timezone utilities (CT↔UTC, RTH/active-window gates)
├── config.ts         # Env var validation + MS_PER_TICK constant
├── types.ts          # Panel type + SnapshotRow interface
├── webhook.ts        # Auto-playbook webhook poster (non-blocking, 3-attempt retry)
└── periscope-probe.mjs  # Phase-0 dev tool: headed login + selector discovery
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

### Timestamps
- `capturedAt` always represents slot **END** time (e.g., the 08:20–08:30 slot → `capturedAt = 08:30 CT`)
- **Never** use wall-clock time as `capturedAt`; use `computeCapturedAt(date, slotEndHhmm)` in `dates.ts`
- All timestamps stored as UTC ISO-8601 TIMESTAMPTZ in Postgres
- **Do NOT assume container TZ=America/Chicago** — `computeCapturedAt` computes CT→UTC offset explicitly via `Intl.DateTimeFormat`. This was a regression (corrupted 5/4–5/7 data). Do not revert to `new Date(...).toISOString()` + env TZ.

### Anti-Bot Timing
- `waitForTimeout` calls with comments like `// anti-bot`, `// stealth`, or `// empirically tuned` are **intentional pacing delays** — do NOT replace them with locator-based waits
- Day-chevron navigation: safe for <5 days; >10 consecutive clicks triggers UW anti-bot → use calendar widget
- Settle waits (800ms Radix animation, 1.5s data refetch, 5s edge cases) were tuned empirically — do not reduce without testing

### Greeks & Panels
- Greeks are captured in order: **Gamma → Charm → Vanna**
- Gamma is the **anchor**: Charm and Vanna must match Gamma's timeframe or the scraper realigns
- If UW publishes a new slot mid-capture (timeframe drift), the scraper detects it and walks back to the gamma timeframe

### DB Schema Sync
- `SnapshotRow` in `types.ts` must stay in sync with `insertSnapshots` in `db.ts`
- Unique constraint: `(captured_at, expiry, panel, strike)` → inserts are idempotent (`ON CONFLICT DO NOTHING`)

### Schedule-Aware Dedup
- `lastCapturedWindowEnd` tracks the last captured slot's end time (e.g., `"08:30"`)
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

2. **`US_MARKET_HOLIDAYS` is hardcoded** in `scrape.ts` (2025–2026). Update annually in December. Used to skip backfill days (perf optimization, not a correctness gate).

3. **Radix popovers**: Multiple poppers can be mounted simultaneously. Locators filter by content to avoid clicking wrong ones. Close animation from one click can block the next; scraper settles + uses `force: true` + retries.

4. **Webhook is non-blocking**: Webhook failures log to Sentry but never block the next tick. If `VERCEL_BASE_URL` is unset, webhook is silently skipped.

5. **3 consecutive empty scrapes**: Triggers a Sentry warning — likely means UW session logout or a rendering outage, not genuinely empty data.

---

## Auth State Management

- **Local dev**: Run `node scraper/periscope-probe.mjs --login` for a headed browser login → saves `~/.periscope-probe-auth.json`
- **Railway**: Set `UW_AUTH_STATE_B64` (base64 of the storageState JSON). `index.ts` decodes it to `UW_AUTH_STATE_PATH` at boot. **Never commit or log the raw storageState JSON.**

---

## Deployment (Railway)

- Runs as `npm start` → continuous 1-min polling loop during active window (Mon–Fri 08:21–15:14 CT)
- Fires one tick immediately on boot to avoid missing data after container restart
- SIGTERM handler flushes Sentry then exits cleanly (Railway restart-safe)
- Observability: Sentry for errors + pino JSON logs to stdout (Railway log pipeline)