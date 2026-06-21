/**
 * Chart-readiness and chart-axis interactions — waiting for the MM
 * Exposures panel to mount, zooming the strike axis out until enough
 * strikes are visible, and reading the SPX spot price + strike ticks off
 * the rendered SVG. The waitForTimeout calls are tuned chart re-render
 * settles; leave them as-is.
 */
import { type Page } from 'playwright';
import { logger } from '../core/logger.js';

/**
 * Read the strike-axis tick labels currently rendered on the chart and return
 * the furthest distance (in points) from `spot`, or null if none are readable.
 *
 * The strike axis is drawn as SVG `<text>` ticks (e.g. `7375` … `7600`). Other
 * panels on the page also draw numeric SVG text, so we keep only labels within
 * 1000 points of spot — SPX strikes always sit within a few hundred points of
 * the underlying, while unrelated labels are far outside that band.
 */
export async function furthestVisibleStrikeDistance(
  page: Page,
  spot: number,
): Promise<number | null> {
  const strikes = await page.evaluate(() => {
    const out: number[] = [];
    for (const t of Array.from(document.querySelectorAll('svg text'))) {
      const txt = t.textContent?.trim() ?? '';
      if (/^\d{3,6}$/.test(txt)) out.push(Number(txt));
    }
    return out;
  });
  let max: number | null = null;
  for (const s of strikes) {
    const dist = Math.abs(s - spot);
    if (dist > 1000) continue; // exclude numeric labels from other panels
    if (max === null || dist > max) max = dist;
  }
  return max;
}

/**
 * Zoom the chart out until the furthest visible strike is at least
 * `minStrikeDistance` points from the current SPX price (or the zoom-out
 * button runs out / we hit `maxClicks`). Each click widens the strike axis,
 * so the furthest-strike distance grows monotonically toward the threshold.
 *
 * Called after the page loads and the chart is ready, before any date/filter
 * manipulation begins.
 */
export async function clickZoomOut(
  page: Page,
  minStrikeDistance = 120,
  maxClicks = 12,
): Promise<void> {
  const zoomOutBtn = page.locator('svg.lucide-zoom-out').locator('..');
  if ((await zoomOutBtn.count()) === 0) {
    logger.debug('zoom-out button not found');
    return;
  }

  for (let clicks = 0; clicks < maxClicks; clicks++) {
    const spot = await readSpotPrice(page);
    const dist =
      spot !== null ? await furthestVisibleStrikeDistance(page, spot) : null;
    if (dist !== null && dist >= minStrikeDistance) {
      logger.info(
        { dist, minStrikeDistance, clicks },
        'zoom-out: furthest strike far enough — stopping',
      );
      return;
    }
    await zoomOutBtn.first().click();
    // Wait for the chart to re-render after zoom change.
    await page.waitForTimeout(500);
  }

  const spot = await readSpotPrice(page);
  const dist =
    spot !== null ? await furthestVisibleStrikeDistance(page, spot) : null;
  logger.warn(
    { dist, minStrikeDistance, maxClicks },
    'zoom-out: hit max clicks before reaching target strike distance',
  );
}

/**
 * Wait for the page to have loaded enough that data is rendered.
 * For the chart view, we look for the "SPX Market Maker Exposures" title
 * or the Timeframe widget — either means the chart panel is mounted.
 *
 * Returns true if the chart appears ready, false on timeout.
 */
export async function waitForChartReady(
  page: Page,
  timeoutMs = 20_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Check for the Timeframe widget (reliable indicator the MM Exposures
    // panel is rendered and interactive).
    const tfCount = await page.locator('span', { hasText: /^Timeframe:$/ }).count();
    if (tfCount > 0) return true;

    // Also check for explicit "No data available"
    const noDataCount = await page.getByText(/no data available/i).count();
    if (noDataCount > 0) return false;

    await page.waitForTimeout(1_000);
  }
  logger.warn('waitForChartReady timed out');
  return false;
}

/**
 * Read the SPX spot price from the chart view page header.
 * The chart view shows: `<span class="pr-2">SPX</span>7,500.63`
 * Falls back to the `Underlying: ($XXXX.XX)` pattern used by the table view.
 */
export async function readSpotPrice(page: Page): Promise<number | null> {
  return await page.evaluate(() => {
    // Chart view pattern: SPX followed by price
    const spans = document.querySelectorAll('span');
    for (const span of spans) {
      if (span.textContent?.trim() === 'SPX') {
        // The price is in the next text node or sibling
        const parent = span.parentElement;
        if (parent) {
          const text = parent.textContent ?? '';
          const match = text.match(/SPX\s*([\d,]+\.\d+)/);
          if (match?.[1]) {
            const v = parseFloat(match[1].replace(/,/g, ''));
            if (isFinite(v) && v > 0) return v;
          }
        }
      }
    }
    // Table view fallback: Underlying: ($XXXX.XX)
    for (const span of spans) {
      const match = span.textContent?.match(/Underlying:\s*\(\$([\d.]+)\)/);
      if (match?.[1]) {
        const v = parseFloat(match[1]);
        if (isFinite(v) && v > 0) return v;
      }
    }
    return null;
  });
}
