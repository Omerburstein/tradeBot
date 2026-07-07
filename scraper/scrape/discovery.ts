/**
 * Discovery helper — open dashboard/4 and dump EVERY JSON XHR/fetch
 * response (URL + full body) to docs/temp/, so we can identify the exact
 * endpoints and JSON shapes for panels we don't parse yet BEFORE writing
 * parsers against them. No DB writes. Split out of orchestrate.ts — it's
 * a dev tool, not part of the scrape/persist pipeline.
 *
 * The panels load on dashboard/4, so simply opening the page fires their
 * API calls. Run headed during RTH so intraday panels actually have data,
 * and use SETUP_PAUSE_MS to hold the window open for manual clicking if a
 * panel is lazy-loaded:
 *
 *   HEADLESS=false SETUP_PAUSE_MS=30000 npm run discover
 *
 * Output: docs/temp/endpoints-<ts>/ with one <NNN>_<sanitized-url>.json
 * per unique endpoint plus an _index.json manifest. docs/temp/ is
 * gitignored, so nothing sensitive is committed.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { UW_PERISCOPE_URL } from '../core/config.js';
import { logger } from '../core/logger.js';
import { withBrowser } from './browser.js';
import { clickZoomOut, waitForChartReady } from './chart.js';

/** Default settle time for lazy panels when SETUP_PAUSE_MS is unset. */
const DEFAULT_SETTLE_MS = 8_000;

export async function discoverEndpoints(): Promise<{
  outDir: string;
  endpoints: Array<{ url: string; status: number; bytes: number; file: string }>;
}> {
  return await withBrowser(async (_browser, page) => {
    const captured: Array<{ url: string; status: number; body: string }> = [];

    page.on('response', (response) => {
      const ct = response.headers()['content-type'] ?? '';
      if (!ct.includes('json')) return;
      const url = response.url();
      const status = response.status();
      response
        .text()
        .then((body) => {
          captured.push({ url, status, body });
        })
        .catch(() => undefined);
    });

    logger.info({ url: UW_PERISCOPE_URL }, 'discover: navigating to dashboard/4');
    await page.goto(UW_PERISCOPE_URL, { waitUntil: 'networkidle' });
    await waitForChartReady(page);
    await clickZoomOut(page);

    // Hold the page so lazy panels finish loading. In headed mode this is
    // also the window for manual interaction.
    const pauseRaw = Number.parseInt((process.env.SETUP_PAUSE_MS ?? '').trim(), 10);
    const pauseMs = Number.isFinite(pauseRaw) && pauseRaw > 0 ? pauseRaw : DEFAULT_SETTLE_MS;
    logger.info({ pauseMs }, 'discover: settling — interact now if headed');
    await page.waitForTimeout(pauseMs);
    await page.waitForLoadState('networkidle').catch(() => undefined);

    // Keep the largest body per unique URL (later/full payloads win over
    // empty pre-flight responses for the same endpoint).
    const byUrl = new Map<string, { url: string; status: number; body: string }>();
    for (const c of captured) {
      const prev = byUrl.get(c.url);
      if (prev == null || c.body.length > prev.body.length) byUrl.set(c.url, c);
    }

    const outDir = resolve('docs/temp', `endpoints-${Date.now()}`);
    await mkdir(outDir, { recursive: true });

    const endpoints: Array<{ url: string; status: number; bytes: number; file: string }> = [];
    const sorted = [...byUrl.values()].sort((a, b) => a.url.localeCompare(b.url));
    let idx = 0;
    for (const { url, status, body } of sorted) {
      const safe = url
        .replace(/^https?:\/\//, '')
        .replace(/[^\w.-]+/g, '_')
        .slice(0, 120);
      const file = resolve(outDir, `${String(idx).padStart(3, '0')}_${safe}.json`);
      await writeFile(file, body, 'utf8').catch(() => undefined);
      endpoints.push({ url, status, bytes: body.length, file });
      idx += 1;
    }

    await writeFile(
      resolve(outDir, '_index.json'),
      JSON.stringify(endpoints, null, 2),
      'utf8',
    ).catch(() => undefined);

    logger.info(
      { outDir, endpointCount: endpoints.length },
      'discover: captured JSON endpoints — inspect docs/temp',
    );
    for (const e of endpoints) {
      logger.info({ bytes: e.bytes, status: e.status }, e.url);
    }

    return { outDir, endpoints };
  });
}
