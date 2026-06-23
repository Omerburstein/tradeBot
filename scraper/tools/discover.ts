/**
 * Endpoint discovery entry point — opens dashboard/4 and dumps every
 * JSON XHR/fetch response to docs/temp/ so we can identify the exact
 * endpoints + shapes for panels not yet parsed (The Cone, Market Tide)
 * before writing parsers against them. No DB writes, no webhook.
 *
 * Run headed during RTH so intraday panels have data; hold the window
 * open for manual interaction with SETUP_PAUSE_MS:
 *
 *   HEADLESS=false SETUP_PAUSE_MS=30000 npm run discover
 *
 * Then inspect the printed URL list / the dumped JSON in docs/temp.
 */

import pino from 'pino';
import { LOG_LEVEL } from '../core/config.js';
import { discoverEndpoints } from '../scrape/index.js';

const logger = pino({ level: LOG_LEVEL });

logger.info('discover: starting');

try {
  const { outDir, endpoints } = await discoverEndpoints();
  logger.info(
    { outDir, endpointCount: endpoints.length },
    'discover: complete — inspect the dumped JSON files in the output dir',
  );
} catch (err) {
  logger.error({ err }, 'discover: failed');
  process.exit(1);
}
