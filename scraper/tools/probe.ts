/**
 * Manual probe — opens the browser, navigates to the UW page, applies
 * filters (or pauses for manual setup when SETUP_PAUSE_MS is set), saves
 * a screenshot + HTML to docs/temp, and logs what rows were captured.
 * No database writes. No webhook. Safe to run at any time.
 *
 * Run via:  npm run probe
 */

import { scrapeAllPanels } from '../scrape/index.js';
import pino from 'pino';
import { LOG_LEVEL } from '../core/config.js';

const logger = pino({ level: LOG_LEVEL });

logger.info('probe: starting');

try {
  const result = await scrapeAllPanels();
  const rows = result.rows;
  logger.info(
    {
      totalRows: rows.length,
      spot: result.spot,
      panels: [...new Set(rows.map((r) => r.panel))],
      strikes: rows.length > 0 ? `${rows[0]!.strike} … ${rows[rows.length - 1]!.strike}` : 'none',
      timeframe: rows[0]?.timeframe ?? 'none',
      expiry: rows[0]?.expiry ?? 'none',
    },
    'probe: complete',
  );
} catch (err) {
  logger.error({ err }, 'probe: failed');
  process.exit(1);
}
