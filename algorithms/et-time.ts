/**
 * Eastern-Time wall-clock helpers, shared across the algorithm.
 *
 * ET (America/New_York) is the pipeline's single wall-clock zone — the
 * `captured_at` instant is stored UTC and converted to ET here, matching what
 * the UW dashboard shows and the ET-labelled config values (see CLAUDE.md).
 * Conversion is DST-aware via `Intl.DateTimeFormat`, never a container-TZ
 * offset (the regression `scraper/core/dates.ts` documents).
 */

/** The pipeline's single wall-clock zone. */
export const ET_TIME_ZONE = 'America/New_York';

/** Extract named numeric parts of a UTC instant rendered in ET. */
function etParts(utcIso: string, options: Intl.DateTimeFormatOptions): (part: string) => string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ET_TIME_ZONE,
    hourCycle: 'h23',
    ...options,
  }).formatToParts(new Date(utcIso));
  return (type: string) => parts.find((p) => p.type === type)?.value ?? '';
}

/**
 * Minutes since ET midnight for a UTC instant (e.g. 09:30 ET → 570). The single
 * source of truth for turning a stored `captured_at` into an ET clock position.
 */
export function etMinutesSinceMidnight(utcIso: string): number {
  const get = etParts(utcIso, { hour: '2-digit', minute: '2-digit' });
  return Number.parseInt(get('hour') || '0', 10) * 60 + Number.parseInt(get('minute') || '0', 10);
}

/**
 * Render a UTC instant as Eastern-Time wall-clock ("YYYY-MM-DD HH:MM ET"),
 * matching the trading time the UW dashboard shows. Display-only — stored times
 * stay absolute UTC (the look-ahead guard + time-gates rely on that).
 */
export function formatEtDateTime(utcIso: string): string {
  const get = etParts(utcIso, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} ET`;
}
