/**
 * API-response interception. `attachApiCaptures` installs a single
 * `response` listener that routes every dashboard/4 JSON response into the
 * right ApiCaptures bucket (Greeks exposures, contracts, straddle/cone,
 * net-flow/tide). The backfill / walk-back paths share it so each attaches
 * interception identically instead of duplicating the handler.
 */
import { type Page } from 'playwright';
import type {
  ApiCaptures,
  ApiExposureResponse,
  ApiContractsResponse,
  ApiStraddleResponse,
  ApiNetFlowResponse,
  ApiCandleEntry,
  ApiSpxTickResponse,
} from './api-types.js';

/**
 * Attach a single `response` listener that routes every JSON response
 * into the right ApiCaptures bucket. Returns the live arrays; the caller
 * clears them between days.
 */
export function attachApiCaptures(page: Page): ApiCaptures {
  const caps: ApiCaptures = { mme: [], mmc: [], straddle: [], tide: [], candles: [], ticks: [] };
  page.on('response', (response) => {
    const url = response.url();
    const ct = response.headers()['content-type'] ?? '';
    if (!ct.includes('json')) return;
    response
      .json()
      .then((body) => {
        if (url.includes('market_maker_exposures')) {
          caps.mme.push({ url, body: body as ApiExposureResponse });
        } else if (url.includes('market_maker_contracts')) {
          caps.mmc.push({ url, body: body as ApiContractsResponse });
        } else if (url.includes('/straddle')) {
          caps.straddle.push({ url, body: body as ApiStraddleResponse });
        } else if (url.includes('net-flow-ticks')) {
          caps.tide.push({ url, body: body as ApiNetFlowResponse });
        } else if (url.includes('index_candles')) {
          caps.candles.push({ url, body: body as ApiCandleEntry[] });
        } else if (url.includes('one_minute_ticks')) {
          caps.ticks.push({ url, body: body as ApiSpxTickResponse });
        }
      })
      .catch(() => undefined);
  });
  return caps;
}
