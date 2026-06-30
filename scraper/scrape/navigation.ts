/**
 * Page-navigation interactions — driving UW's Expiry dropdown, the DTE
 * filter, and the date picker (both the day-chevron path and the calendar
 * widget). Every waitForTimeout here is empirically-tuned anti-bot pacing
 * and Radix animation settling; do not swap for locator-based waits.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type Page } from 'playwright';
import { logger } from '../core/logger.js';
import { parseDateLabel } from '../core/parser.js';
import { daysBetweenYmd } from './trading-calendar.js';

const MONTH_NAME_TO_NUM: Record<string, number> = {
  January: 1,
  February: 2,
  March: 3,
  April: 4,
  May: 5,
  June: 6,
  July: 7,
  August: 8,
  September: 9,
  October: 10,
  November: 11,
  December: 12,
};

export function escapeRegex(s: string): string {
  return s.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Open the Expiry filter, switch to Single mode, and click the row
 * matching `targetYmd` (YYYY-MM-DD). Returns true on success.
 *
 * UW Periscope renders the Expiry filter as a DropdownFilter component.
 * In the chart view (dashboard/4), dates are shown as "YYYY-MM-DD (Nd)"
 * format, e.g. "2026-06-17 (1d)".
 */
export async function setExpirySingle(
  page: Page,
  targetYmd: string,
  opts: { skipModeSwitch?: boolean } = {},
): Promise<boolean> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetYmd)) {
    throw new Error(`setExpirySingle: invalid target "${targetYmd}"`);
  }
  // UW dialog shows dates as "YYYY-MM-DD (Nd)" e.g. "2026-06-17 (1d)"
  const datePattern = new RegExp(`^${escapeRegex(targetYmd)}\\s*\\(`);

  // Find the Expiry dropdown trigger — stable sentry component attribute.
  const trigger = page
    .locator('[data-sentry-component="DropdownFilter"]')
    .filter({ has: page.locator('span', { hasText: /^Expiry$/ }) })
    .first();
  if ((await trigger.count()) === 0) {
    logger.warn('setExpirySingle: Expiry trigger not found');
    return false;
  }

  const dialogId = await trigger.getAttribute('aria-controls');

  // Approach 1: real mouse move + click (triggers hover/focus states that
  // Radix components sometimes require before the dialog fires).
  const box = await trigger.boundingBox();
  if (box) {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.waitForTimeout(300);
    await page.mouse.click(cx, cy);
  } else {
    // Fallback: synthetic click with force
    await trigger.click({ timeout: 5_000, force: true });
  }
  await page.waitForTimeout(1_500);

  // Approach 2: if the dialog still hasn't opened, try a JS-level click
  // (bypasses Playwright event dispatch entirely — hits the DOM handler directly).
  const isExpanded = await trigger.getAttribute('aria-expanded');
  if (isExpanded !== 'true') {
    logger.info('setExpirySingle: mouse click did not open dialog — trying JS click');
    await page.evaluate(() => {
      const filters = document.querySelectorAll('[data-sentry-component="DropdownFilter"]');
      for (const el of filters) {
        if (el.textContent?.includes('Expiry')) {
          (el as HTMLElement).click();
          break;
        }
      }
    });
    await page.waitForTimeout(1_500);
  }

  // Wait for the dialog to appear.
  const dialog =
    dialogId != null
      ? page.locator(`[id="${dialogId}"]`).first()
      : page.locator('[role="dialog"]').first();
  try {
    await dialog.waitFor({ state: 'visible', timeout: 5_000 });
  } catch {
    // Save debug HTML so we can inspect the state when the dialog fails to open.
    const debugHtml = await page.content().catch(() => '');
    const debugPath = resolve('docs/temp', `expiry-debug-${Date.now()}.html`);
    await mkdir(resolve('docs/temp'), { recursive: true });
    await writeFile(debugPath, debugHtml, 'utf8').catch(() => undefined);
    logger.warn(
      { dialogId, debugPath, ariaExpanded: isExpanded },
      'setExpirySingle: dialog did not appear — debug HTML saved',
    );
    await page.keyboard.press('Escape');
    return false;
  }

  // Switch to Single mode — in Multi mode clicking a date only toggles a
  // checkbox and the dialog stays open. The "Single" control is a toggle:
  // clicking it when already in Single mode flips it back to Multi. So the
  // caller passes skipModeSwitch=true on subsequent calls within the same
  // session (the dialog retains Single mode from the first call) — we then
  // only re-pick the date and never touch the toggle.
  if (!opts.skipModeSwitch) {
    const singleBtn = dialog.getByText('Single', { exact: true }).first();
    if ((await singleBtn.count()) > 0) {
      await singleBtn.click({ timeout: 3_000 });
      await page.waitForTimeout(500);
    }
  }

  // Wait for a date row in YYYY-MM-DD (Nd) format to be visible.
  await dialog
    .locator('span, div, td, li', { hasText: /^\d{4}-\d{2}-\d{2}\s*\(/ })
    .first()
    .waitFor({ state: 'visible', timeout: 5_000 })
    .catch(() => undefined);

  // Click the row whose text starts with "YYYY-MM-DD (" e.g. "2026-06-17 (1d)"
  const target = dialog
    .locator('span, div, td, li', { hasText: datePattern })
    .first();

  if ((await target.count()) === 0) {
    const dialogHtml = await dialog.innerHTML().catch(() => '');
    // Diagnostics: where is the chart actually positioned, and what dates does
    // the dropdown actually list? Distinguishes a stranded chart frame (label
    // != target ⇒ walkDateToTarget didn't land) from a virtualized/short list
    // (target genuinely absent from the rendered rows).
    const chartLabel = await page
      .locator('[data-testid="date-picker-button"] span[role="button"]')
      .first()
      .textContent()
      .catch(() => '');
    const listedDates = await dialog
      .locator('span, div, td, li')
      .filter({ hasText: /^\d{4}-\d{2}-\d{2}\s*\(/ })
      .allTextContents()
      .catch(() => [] as string[]);
    const uniqDates = [...new Set(listedDates.map((t) => t.trim()))];
    logger.warn(
      {
        targetYmd,
        dialogHtmlLen: dialogHtml.length,
        chartLabel: (chartLabel ?? '').trim(),
        listedCount: uniqDates.length,
        listedFirst: uniqDates.slice(0, 4),
        listedLast: uniqDates.slice(-4),
      },
      'setExpirySingle: target date not found in dialog',
    );
    await page.keyboard.press('Escape');
    return false;
  }

  await target.click({ timeout: 3_000, force: true });

  // In Single mode Radix closes the dialog automatically; give it a moment.
  await page.waitForTimeout(500);

  // If dialog is still visible, try pressing Enter (activates focused item)
  // then fall back to clicking outside the modal.
  if (await dialog.isVisible().catch(() => false)) {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
  }
  if (await dialog.isVisible().catch(() => false)) {
    // Click in the page margin well outside the dialog to dismiss it.
    await page.mouse.click(10, 10);
    await page.waitForTimeout(500);
  }

  // Verify the trigger pill updated away from "All"
  const newValue = await trigger.locator('span.text-base').first().textContent().catch(() => '');
  logger.info({ targetYmd, newValue }, 'setExpirySingle: date selected');
  return true;
}

export async function setDTEZero(page: Page): Promise<void> {
  const trigger = page.locator('[data-testid="dte-filter"]').first();
  if ((await trigger.count()) === 0) {
    logger.warn('setDTEZero: dte-filter trigger not found — skipping');
    return;
  }
  await trigger.click({ timeout: 5_000 });
  // Popover opens via Radix portal — wait for the inputs to be paintable.
  await page.waitForTimeout(800);

  const minInput = page.getByPlaceholder(/min dte/i).first();
  const maxInput = page.getByPlaceholder(/max dte/i).first();

  if ((await minInput.count()) === 0 || (await maxInput.count()) === 0) {
    logger.warn('setDTEZero: Min/Max DTE inputs not found — skipping');
    await page.keyboard.press('Escape');
    return;
  }

  // Use pressSequentially-then-Tab so React sees a real keystroke per
  // character + the blur event UW likely uses to commit. fill() can
  // occasionally bypass the controlled-input handler if React batches
  // updates.
  await minInput.click();
  await minInput.fill('');
  await minInput.pressSequentially('0');
  await page.keyboard.press('Tab');
  await maxInput.click();
  await maxInput.fill('');
  await maxInput.pressSequentially('0');
  await page.keyboard.press('Tab');

  // Verify the inputs hold "0" before closing.
  const minVal = await minInput.inputValue();
  const maxVal = await maxInput.inputValue();
  logger.info({ minVal, maxVal }, 'setDTEZero: input values after fill');

  // Close the popover. UW's filter applies on input change, so Escape
  // shouldn't undo it.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1_500);

  // Diagnostic: log what the trigger pills show now, so a flaky filter
  // commit shows up obviously in the next run's output.
  const pills: Record<string, string> = {};
  const dropdowns = page.locator('div[data-sentry-component="DropdownFilter"]');
  const dropdownCount = await dropdowns.count();
  for (let i = 0; i < dropdownCount; i += 1) {
    const dd = dropdowns.nth(i);
    const spans = dd.locator('span');
    const spanCount = await spans.count();
    let key = '';
    for (let j = 0; j < spanCount; j += 1) {
      const span = spans.nth(j);
      const cls = (await span.getAttribute('class')) ?? '';
      const txt = ((await span.textContent()) ?? '').trim();
      if (cls.includes('text-xs')) {
        key = txt;
      } else if (cls.includes('text-base') && key !== '') {
        pills[key] = txt;
        break;
      }
    }
  }
  const dateBtn = page
    .locator('[data-testid="date-picker-button"] span[role="button"]')
    .first();
  if ((await dateBtn.count()) > 0) {
    pills['__date'] = ((await dateBtn.textContent()) ?? '').trim();
  }
  logger.info({ pills }, 'setDTEZero: trigger pill state after apply');
}

/**
 * Walk the date picker chevrons until the displayed label matches the
 * target YYYY-MM-DD. UW's date picker label looks like "Thu, May 7"
 * — we parse the current label via parseDateLabel + the target's year,
 * then click prev or next based on direction. Caps at 30 attempts to
 * prevent infinite loops on unparseable labels.
 */
export async function walkDateToTarget(page: Page, targetYmd: string): Promise<void> {
  const yearStr = targetYmd.slice(0, 4);
  const year = Number.parseInt(yearStr, 10);
  if (!Number.isFinite(year)) {
    throw new Error(`walkDateToTarget: invalid target "${targetYmd}"`);
  }

  const labelLoc = page
    .locator('[data-testid="date-picker-button"] span[role="button"]')
    .first();
  const prevBtn = page.getByLabel('Previous day').first();
  const nextBtn = page.getByLabel('Next day').first();

  // Decide between the day-chevron path (cheap for ±1-3 days) and the
  // calendar widget (cheap for big jumps). Sequential day-chevron
  // clicks past ~10 in a row appear to trip UW's anti-bot — historical
  // backfills returned 0 rows for every slot until the calendar path
  // was added. Threshold is conservative: anything more than 5
  // calendar-days hops over to the calendar.
  const currentLabel = ((await labelLoc.textContent()) ?? '').trim();
  const currentYmd = parseDateLabel(currentLabel, year);
  if (currentYmd === targetYmd) {
    logger.debug(
      { targetYmd, attempts: 0 },
      'walkDateToTarget: already on target',
    );
    return;
  }
  if (currentYmd != null) {
    const daysApart = Math.abs(daysBetweenYmd(currentYmd, targetYmd));
    if (daysApart > 5) {
      await walkDateViaCalendar(page, targetYmd);
      return;
    }
  }

  // Cap at 200 — covers a full half-year walk if the storageState's
  // saved date is far from the target (which happens on the first day
  // of a multi-month backfill range). Within a range loop, day-to-day
  // walks are 1-3 clicks so the cap is never hit in steady state.
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const label = ((await labelLoc.textContent()) ?? '').trim();
    const ymd = parseDateLabel(label, year);
    if (ymd === targetYmd) {
      logger.debug(
        { targetYmd, attempts: attempt },
        'walkDateToTarget: matched (day-chevron path)',
      );
      return;
    }
    if (ymd === null) {
      throw new Error(
        `walkDateToTarget: cannot parse current label "${label}"`,
      );
    }
    if (ymd > targetYmd) {
      await prevBtn.click({ timeout: 3_000 });
    } else {
      await nextBtn.click({ timeout: 3_000 });
    }
    await page.waitForTimeout(500);
  }
  throw new Error(
    `walkDateToTarget: did not reach ${targetYmd} after 200 chevron clicks`,
  );
}

/**
 * Calendar-based date walker. Used for big jumps (multi-month backfills)
 * where the day-chevron path would (a) take 80+ clicks and (b) get
 * throttled by UW's anti-bot.
 *
 * Flow:
 *   1. Click `[data-testid="date-picker-button"]` to open the calendar.
 *   2. Read the month-header label ("May 2026"). Compute month delta vs.
 *      the target.
 *   3. Click `aria-label="Previous month"` (or Next) the required number
 *      of times.
 *   4. Click the day cell — `<button>` containing `<span
 *      class="font-medium">{day}</span>`. Skip disabled cells (UW marks
 *      non-trading days with `disabled` + `cursor-not-allowed`).
 *   5. The calendar should auto-close on day-click; if not, press Esc.
 */
export async function walkDateViaCalendar(
  page: Page,
  targetYmd: string,
): Promise<void> {
  const targetYear = Number.parseInt(targetYmd.slice(0, 4), 10);
  const targetMonth = Number.parseInt(targetYmd.slice(5, 7), 10); // 1-12
  const targetDay = Number.parseInt(targetYmd.slice(8, 10), 10);

  // Step 1: open the calendar
  const datePill = page.locator('[data-testid="date-picker-button"]').first();
  await datePill.click({ timeout: 5_000 });
  await page.waitForTimeout(800);

  // Step 2-3: walk months until the header matches target. The header
  // is unique inside the popup — match it by regex on text.
  const monthHeader = page.locator('text=/^[A-Z][a-z]+ 20[0-9]{2}$/').first();
  const prevMonth = page.getByLabel('Previous month').first();
  const nextMonth = page.getByLabel('Next month').first();
  for (let attempt = 0; attempt < 36; attempt += 1) {
    const headerText = ((await monthHeader.textContent()) ?? '').trim();
    const m = /^([A-Z][a-z]+) (20[0-9]{2})$/.exec(headerText);
    if (m == null) {
      throw new Error(
        `walkDateViaCalendar: unparseable month header "${headerText}"`,
      );
    }
    const curMonth = MONTH_NAME_TO_NUM[m[1]!] ?? 0;
    const curYear = Number.parseInt(m[2]!, 10);
    if (curYear === targetYear && curMonth === targetMonth) {
      break;
    }
    const curMonths = curYear * 12 + curMonth;
    const targetMonths = targetYear * 12 + targetMonth;
    if (curMonths > targetMonths) {
      await prevMonth.click({ timeout: 3_000 });
    } else {
      await nextMonth.click({ timeout: 3_000 });
    }
    await page.waitForTimeout(300);
  }

  // Step 4: click the day cell. Filter to enabled cells only — disabled
  // cells (non-trading days, dates outside UW's retention window) are
  // marked with the `disabled` attribute.
  const dayCell = page
    .locator(
      `button:not([disabled]):has(span.font-medium:text-is("${targetDay}"))`,
    )
    .first();
  await dayCell.click({ timeout: 5_000 });
  await page.waitForTimeout(800);

  // Step 5: confirm the date pill now reflects the target (the popup
  // should auto-close on day-click; if it didn't, the assertion still
  // works because the pill text reflects the new selection).
  const labelLoc = page
    .locator('[data-testid="date-picker-button"] span[role="button"]')
    .first();
  const finalLabel = ((await labelLoc.textContent()) ?? '').trim();
  const finalYmd = parseDateLabel(finalLabel, targetYear);
  if (finalYmd !== targetYmd) {
    // Try to dismiss the popup before throwing so subsequent clicks
    // aren't shadowed.
    await page.keyboard.press('Escape').catch(() => {});
    throw new Error(
      `walkDateViaCalendar: pill shows "${finalLabel}" (parsed=${finalYmd ?? 'null'}) after click — wanted ${targetYmd}`,
    );
  }
  logger.debug({ targetYmd }, 'walkDateViaCalendar: matched');
}
