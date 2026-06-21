/**
 * Timeframe helpers — HH:MM string math plus the Playwright interactions
 * that drive UW's Timeframe widget (walk to a target slot, step forward /
 * backward by one 10-min slot, read the current label). The intra-slot
 * waitForTimeout pacing here is intentional anti-bot tuning — do not
 * replace with locator waits.
 */
import { type Page } from 'playwright';
import { logger } from '../core/logger.js';

export const TIMEFRAME_PATTERN = /(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/;

/** "8:20" → "08:20"; "08:20" → "08:20". Stable HH:MM string compare. */
export function normalizeHhmm(hhmm: string): string {
  const parts = hhmm.split(':');
  const h = parts[0] ?? '0';
  const m = parts[1] ?? '0';
  return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
}

/** Extract the slot-start time from a Periscope timeframe label. */
export function parseTimeframeStart(label: string): string | null {
  const m = label.match(TIMEFRAME_PATTERN);
  if (m?.[1] == null) return null;
  return normalizeHhmm(m[1]);
}

/** Advance an HH:MM string by 10 minutes. "08:20" → "08:30", "08:50" → "09:00". */
export function nextTimeframe(slotStartHhmm: string): string {
  const [hStr, mStr] = slotStartHhmm.split(':');
  const totalMin =
    Number.parseInt(hStr ?? '0', 10) * 60 +
    Number.parseInt(mStr ?? '0', 10) +
    10;
  const newH = Math.floor(totalMin / 60);
  const newM = totalMin % 60;
  return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`;
}

/** Locate the Timeframe widget container (shared by every walker below). */
function timeframeContainer(page: Page) {
  return page
    .locator('div.rounded-full')
    .filter({ has: page.locator('span', { hasText: /^Timeframe:$/ }) })
    .first();
}

/**
 * Walk the timeframe-widget chevrons until the displayed slot starts at
 * `targetStartHhmm` (ET — the widget renders in the browser's ET tz).
 * Caps at 80 attempts (covers the full 9:20–16:00 day plus a buffer).
 */
export async function walkTimeframeToTarget(
  page: Page,
  targetStartHhmm: string,
): Promise<void> {
  const target = normalizeHhmm(targetStartHhmm);
  const container = timeframeContainer(page);
  const labelSpan = container.locator('span').last();
  const prevBtn = container.locator('button').first();
  const nextBtn = container.locator('button').last();

  // The first label after a date change is often "Latest" — UW's
  // default setting that resolves to the most-recent slot during RTH
  // but is non-parseable on historical dates. We treat any
  // null-parse result as "click prev to escape into specific-time
  // territory" rather than throwing. Cap raised to 90 so the escape
  // attempts plus a full session walk-back fit within budget.
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const label = ((await labelSpan.textContent()) ?? '').trim();
    const currentStart = parseTimeframeStart(label);
    if (currentStart === target) {
      logger.debug(
        { target, attempts: attempt },
        'walkTimeframeToTarget: matched',
      );
      return;
    }
    if (currentStart === null) {
      // Likely "Latest" or another non-HHMM label. Click prev to step
      // into specific-time territory; the next iteration will parse.
      logger.debug(
        { label, target },
        'walkTimeframeToTarget: non-HHMM label, clicking prev to escape',
      );
      await prevBtn.click({ timeout: 3_000 });
    } else if (currentStart > target) {
      await prevBtn.click({ timeout: 3_000 });
    } else {
      await nextBtn.click({ timeout: 3_000 });
    }
    await page.waitForTimeout(500);
  }
  throw new Error(
    `walkTimeframeToTarget: did not reach ${target} after 90 chevron clicks`,
  );
}

/**
 * Advance the timeframe by one slot (10 min forward) by clicking the
 * next-chevron button. Caller is responsible for the post-click
 * settle wait — we don't impose one here so the caller can absorb
 * jitter (e.g. data fetch) however suits.
 */
export async function advanceTimeframeOneSlot(page: Page): Promise<void> {
  await timeframeContainer(page).locator('button').last().click({ timeout: 3_000 });
}

/**
 * Step the timeframe one slot backwards (10 min earlier). Used to
 * escape the "Latest" sentinel when it renders empty — pre-market /
 * post-close, the most recent specific slot has data even when
 * "Latest" appears empty in DTE=[0,0] mode.
 */
export async function rewindTimeframeOneSlot(page: Page): Promise<void> {
  await timeframeContainer(page).locator('button').first().click({ timeout: 3_000 });
}

/**
 * Read the current Timeframe label from the page.
 * Returns the label text like "15:50 - 16:00" or "Latest".
 */
export async function readTimeframeLabel(page: Page): Promise<string> {
  try {
    const labelSpan = timeframeContainer(page).locator('span').last();
    return ((await labelSpan.textContent()) ?? '').trim();
  } catch {
    return '';
  }
}
