/**
 * Public surface of the scrape/ engine. Re-exports the entry points the
 * rest of the codebase consumes so importers depend on `./scrape/index.js`
 * rather than reaching into individual modules. The internal split
 * (browser, navigation, timeframe, chart, captures, api-transforms,
 * trading-calendar, panels, orchestrate) stays encapsulated behind this
 * barrel.
 */
export { scrapeAllPanels, scrapeMarketTideAndPrice } from './panels.js';
export {
  scrapeBackfill,
  scrapeBackfillRange,
  scrapeBackfillDates,
  scrapeWalkBack,
  discoverEndpoints,
} from './orchestrate.js';
export { tradingDaysBetween } from './trading-calendar.js';
export type { ScrapeResult, LightScrapeResult } from './api-types.js';

// computeCapturedAt lives in core/dates.ts; re-exported here so existing
// callers that imported it from the scraper engine keep working unchanged.
export { computeCapturedAt } from '../core/dates.js';
