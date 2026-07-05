/**
 * API-response interception. `attachApiCaptures` installs a single
 * `response` listener that routes every dashboard/4 JSON response into the
 * right ApiCaptures bucket (periscope exposures/positions/timestamps,
 * straddle/cone, net-flow/tide, candles, ticks). The backfill / walk-back
 * paths share it so each attaches interception identically instead of
 * duplicating the handler.
 */
import { type Page } from 'playwright';
import { logger } from '../core/logger.js';
import type {
  ApiCaptures,
  ApiPeriscopeExposuresResponse,
  ApiPeriscopePositionsResponse,
  ApiPeriscopeTimestampsResponse,
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
/** Auth-relevant request headers to replay on direct periscope fetches. */
const PERISCOPE_HEADER_ALLOWLIST = /^(authorization|origin|referer|x-.+)$/i;

export function attachApiCaptures(page: Page): ApiCaptures {
  const caps: ApiCaptures = {
    periscopeHeaders: null,
    exposures: [],
    positions: [],
    timestamps: [],
    straddle: [],
    tide: [],
    candles: [],
    ticks: [],
  };
  page.on('response', (response) => {
    const url = response.url();
    const ct = response.headers()['content-type'] ?? '';
    if (!ct.includes('json')) return;
    // Stash the auth headers the page itself sent on its first periscope
    // XHR — the direct fetch helpers replay them (the phx API 403s bare
    // cookie-auth requests to periscope/*).
    if (caps.periscopeHeaders === null && url.includes('/periscope/')) {
      response
        .request()
        .allHeaders()
        .then((all) => {
          const kept: Record<string, string> = {};
          for (const [k, v] of Object.entries(all)) {
            if (PERISCOPE_HEADER_ALLOWLIST.test(k)) kept[k] = v;
          }
          if (Object.keys(kept).length > 0) caps.periscopeHeaders ??= kept;
        })
        .catch(() => undefined);
    }
    response
      .json()
      .then((body) => {
        if (url.includes('periscope/exposures')) {
          caps.exposures.push({ url, body: body as ApiPeriscopeExposuresResponse });
        } else if (url.includes('periscope/positions')) {
          caps.positions.push({ url, body: body as ApiPeriscopePositionsResponse });
        } else if (url.includes('periscope/timestamps')) {
          const ts = body as ApiPeriscopeTimestampsResponse;
          caps.timestamps.push({ url, body: ts });
          logger.info(
            { url, minutes: ts.data?.length ?? 0 },
            'captured periscope/timestamps',
          );
        } else if (url.includes('/straddle')) {
          caps.straddle.push({ url, body: body as ApiStraddleResponse });
        } else if (url.includes('net-flow-ticks')) {
          const tide = body as ApiNetFlowResponse;
          caps.tide.push({ url, body: tide });
          logger.info(
            { url, points: tide.data?.length ?? 0, returnedDate: tide.data?.[0]?.date ?? null },
            'captured net-flow-ticks (Market Tide)',
          );
        } else if (url.includes('index_candles')) {
          // The index_candles endpoints return { data: [...] }, NOT a bare
          // array. Storing the raw object made caps.candles.flatMap(r => r.body)
          // iterate the wrong shape, so the daily-close spot lookup (and cone
          // candle fallback) found nothing. Unwrap `.data` here.
          const arr = Array.isArray(body)
            ? (body as ApiCandleEntry[])
            : ((body as { data?: ApiCandleEntry[] }).data ?? []);
          caps.candles.push({ url, body: arr });
          logger.info(
            { url, candles: arr.length, first: arr[0]?.date ?? null, last: arr[arr.length - 1]?.date ?? null },
            'captured index_candles',
          );
        } else if (url.includes('one_minute_ticks')) {
          caps.ticks.push({ url, body: body as ApiSpxTickResponse });
        }
      })
      .catch(() => undefined);
  });
  return caps;
}
