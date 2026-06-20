---
name: chart-view-api-interception
description: Scraper migrated from table-view HTML scraping (dashboard/6) to chart-view API interception (dashboard/4). All Greeks come from one API call.
type: project
---

Scraper has been migrated from the table-view (dashboard/6) to chart-view (dashboard/4) architecture.

**Why:** Dashboard/4 is a chart view that renders Greeks as visual bars, not HTML tables. The old approach of scraping `tr.table_row__wxw5u` elements and cycling through Greek dropdowns doesn't work. The chart view fetches `phx.unusualwhales.com/api/bsoc/SPX/market_maker_exposures?expiry=YYYY-MM-DD&timestamp=<ms>` which returns ALL Greeks (gamma, charm, vanna) per strike in a single JSON response.

**How to apply:**
- The scraper intercepts Playwright `response` events for URLs containing `market_maker_exposures`
- `apiResponseToRows()` converts the API JSON directly into `SnapshotRow[]` for all three Greeks
- No Greek-dropdown cycling needed — single API call has everything
- SPX spot price: read from page DOM (`<span class="pr-2">SPX</span>7,500.63`) or API `index_values.close`
- Timeframe: derived from API `timestamp` field (UTC) converted to CT HH:MM
- Date format in Expiry dialog changed from `MM/DD/YYYY (Nd)` to `YYYY-MM-DD (Nd)`
- `parsePage` from parser.ts is no longer used in the capture path (but parser.ts still provides `parseDateLabel` for date-picker navigation)
