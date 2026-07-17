/**
 * Scale-carryover report: is the PREVIOUS day's factor magnitude a usable seed
 * for the CURRENT day's opening scale?
 *
 * `normalizeToScale` (score-engine.ts) divides each raw factor by
 * `meanAbs(recent raws)`. That scale needs 3 samples, and `scoreHistory` only
 * advances on FRESH Greek snapshots (signal-generator.ts) — which arrive every
 * 10 minutes. So the first ~30 minutes of every session run on a fabricated
 * ±1 sign estimate instead of a measured scale.
 *
 * Seeding the scale from the previous day would remove that warm-up — IF the
 * previous day's magnitude actually predicts the next day's opening magnitude.
 * This report measures whether it does, per factor:
 *
 *   ratioFirst = meanAbs(prev day's FIRST 3 fresh ticks) / meanAbs(curr day's FIRST 3 fresh ticks)
 *   ratioLast  = meanAbs(prev day's LAST  3 fresh ticks) / meanAbs(curr day's FIRST 3 fresh ticks)
 *
 * Ratio 1.0 = a perfect seed. Ratios are compared on a log2 axis because they
 * are multiplicative: log2 = 0 is perfect, ±1 is "off by 2x" either way, and the
 * distribution is symmetric around 0 in a way the raw ratio is not.
 *
 * Writes an interactive histogram to `docs/scale-carryover.html`.
 *
 * Usage:
 *   npm run scale-carryover
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getAvailableDates, loadDay } from './data-loader.js';
import { computeScore } from './score-engine.js';
import { DEFAULT_CONFIG } from './types.js';
import type { Snapshot } from './types.js';

/** The four raw factors `normalizeToScale` is applied to. */
const FACTORS = ['gexRaw', 'dGammaRaw', 'positionsRaw', 'dPositionsRaw'] as const;
type Factor = (typeof FACTORS)[number];

const FACTOR_LABELS: Record<Factor, string> = {
  gexRaw: 'GEX (gamma level)',
  dGammaRaw: 'dGamma (gamma momentum)',
  positionsRaw: 'Positions (level)',
  dPositionsRaw: 'dPositions (momentum)',
};

/** How many ticks at each end of a day define its "opening" / "closing" magnitude. */
const EDGE_TICKS = 3;

/** log2-ratio histogram bins: each bin is one doubling. */
const BIN_MIN = -6;
const BIN_MAX = 7;

interface Ratio {
  date: string;
  factor: Factor;
  /** prev day's first-3 magnitude / curr day's first-3 magnitude. */
  ratioFirst: number;
  /** prev day's last-3 magnitude / curr day's first-3 magnitude. */
  ratioLast: number;
}

const meanAbs = (a: number[]): number => a.reduce((x, y) => x + Math.abs(y), 0) / a.length;

/**
 * Raw factor series for one day over FRESH Greek ticks only — the samples that
 * actually advance `scoreHistory`. Stale price ticks reuse the last score and
 * never reach the scale, so including them would overstate how fast it warms up.
 *
 * Returns null for a day too short to have non-overlapping first/last windows.
 */
async function dayRaws(date: string): Promise<Record<Factor, number[]> | null> {
  const snaps = await loadDay(date, DEFAULT_CONFIG.strikeWindow);
  const fresh = snaps.filter((s) => !s.greeksStale);
  if (fresh.length < EDGE_TICKS * 2) return null;

  const out: Record<Factor, number[]> = {
    gexRaw: [], dGammaRaw: [], positionsRaw: [], dPositionsRaw: [],
  };
  let prevGreek: Snapshot | null = null;
  for (const s of fresh) {
    // Empty history: gexRaw/positionsRaw don't depend on it, and the momentum
    // factors only need `prevGreek`. Nothing here reads a z-score.
    const sc = computeScore(s, prevGreek, [], DEFAULT_CONFIG);
    for (const f of FACTORS) out[f].push(sc[f]);
    prevGreek = s;
  }
  return out;
}

async function collectRatios(): Promise<{ ratios: Ratio[]; dates: string[]; skipped: number }> {
  const dates = await getAvailableDates();
  const ratios: Ratio[] = [];
  let prev: { raws: Record<Factor, number[]> } | null = null;
  let skipped = 0;

  for (const date of dates) {
    const raws = await dayRaws(date);
    if (!raws) {
      skipped++;
      prev = null; // don't bridge a gap — the "previous day" must be adjacent
      continue;
    }
    if (prev) {
      for (const f of FACTORS) {
        const currFirst = meanAbs(raws[f].slice(0, EDGE_TICKS));
        // dGamma's first tick is 0 by construction (no previous snapshot), so a
        // near-zero denominator here is a property of the factor, not a bug —
        // but the ratio would be meaningless, so drop it.
        if (currFirst < 1e-9) continue;
        const p = prev.raws[f];
        ratios.push({
          date,
          factor: f,
          ratioFirst: meanAbs(p.slice(0, EDGE_TICKS)) / currFirst,
          ratioLast: meanAbs(p.slice(-EDGE_TICKS)) / currFirst,
        });
      }
    }
    prev = { raws };
  }
  return { ratios, dates, skipped };
}

interface Stats {
  n: number;
  p10: number;
  median: number;
  p90: number;
  /** Geometric mean — the right centre for a ratio (its log is the mean log). */
  geomean: number;
  /** Fraction landing within a 2x band either way: the "usable seed" bar. */
  within2x: number;
}

function stats(v: number[]): Stats {
  const s = [...v].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  const logs = v.map((x) => Math.log2(x));
  return {
    n: v.length,
    p10: q(0.1),
    median: q(0.5),
    p90: q(0.9),
    geomean: 2 ** (logs.reduce((a, b) => a + b, 0) / logs.length),
    within2x: v.filter((x) => x >= 0.5 && x <= 2).length / v.length,
  };
}

/** Bin log2(ratio) into one-doubling buckets. */
function histogram(v: number[]): number[] {
  const bins = new Array(BIN_MAX - BIN_MIN).fill(0);
  for (const x of v) {
    const b = Math.floor(Math.log2(x)) - BIN_MIN;
    if (b >= 0 && b < bins.length) bins[b]++;
  }
  return bins;
}

const SERIES = [
  { key: 'ratioFirst' as const, label: "Previous day's first 3 ticks" },
  { key: 'ratioLast' as const, label: "Previous day's last 3 ticks" },
];

function main(): Promise<void> {
  return collectRatios().then(({ ratios, dates, skipped }) => {
    const facets = FACTORS.map((f) => {
      const rows = ratios.filter((r) => r.factor === f);
      return {
        factor: f,
        label: FACTOR_LABELS[f],
        series: SERIES.map((s) => {
          const v = rows.map((r) => r[s.key]).filter((x) => Number.isFinite(x) && x > 0);
          return { key: s.key, label: s.label, bins: histogram(v), stats: stats(v) };
        }),
      };
    });

    const meta = {
      days: dates.length,
      firstDate: dates[0],
      lastDate: dates[dates.length - 1],
      pairs: ratios.length,
      skipped,
      binMin: BIN_MIN,
      binMax: BIN_MAX,
      edgeTicks: EDGE_TICKS,
    };

    // Console summary — the report is useful without opening the HTML.
    console.log(`${meta.days} trading days: ${meta.firstDate} .. ${meta.lastDate}`);
    console.log(`${meta.pairs} factor-day ratio pairs; skipped ${skipped} short day(s)\n`);
    console.log('factor          | series      |   n |   p10 | median |   p90 | geomean | within 2x');
    for (const fc of facets) {
      for (const s of fc.series) {
        const st = s.stats;
        console.log(
          `${fc.factor.padEnd(15)} | ${(s.key === 'ratioFirst' ? 'prev first3' : 'prev last3 ')} | ` +
            `${String(st.n).padStart(3)} | ${st.p10.toFixed(2).padStart(5)} | ` +
            `${st.median.toFixed(2).padStart(6)} | ${st.p90.toFixed(2).padStart(5)} | ` +
            `${st.geomean.toFixed(2).padStart(7)} | ${(st.within2x * 100).toFixed(0).padStart(6)}%`,
        );
      }
    }

    const here = dirname(fileURLToPath(import.meta.url));
    const outPath = resolve(here, '..', 'docs', 'scale-carryover.html');
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, renderHtml(facets, meta), 'utf8');
    console.log(`\nwrote ${outPath}`);
  });
}

// ── HTML report ──────────────────────────────────────────────────────
// Palette: dataviz reference instance (categorical slots 1 & 2). Validated
// all-pairs (small multiples) in both modes — light ΔE 26.5, dark ΔE 27.3,
// target >= 8. Do not hand-pick replacements; re-run scripts/validate_palette.js.

function renderHtml(facets: unknown, meta: unknown): string {
  const payload = JSON.stringify({ facets, meta });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scale carryover — previous day vs current day opening magnitude</title>
<style>
  .viz-root {
    color-scheme: light;
    --surface-1: #fcfcfb;
    --page: #f9f9f7;
    --text-primary: #0b0b0b;
    --text-secondary: #52514e;
    --text-muted: #898781;
    --grid: #e1e0d9;
    --axis: #c3c2b7;
    --border: rgba(11,11,11,0.10);
    --series-1: #2a78d6;
    --series-2: #008300;
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) .viz-root {
      color-scheme: dark;
      --surface-1: #1a1a19;
      --page: #0d0d0d;
      --text-primary: #ffffff;
      --text-secondary: #c3c2b7;
      --text-muted: #898781;
      --grid: #2c2c2a;
      --axis: #383835;
      --border: rgba(255,255,255,0.10);
      --series-1: #3987e5;
      --series-2: #008300;
    }
  }
  :root[data-theme="dark"] .viz-root {
    color-scheme: dark;
    --surface-1: #1a1a19;
    --page: #0d0d0d;
    --text-primary: #ffffff;
    --text-secondary: #c3c2b7;
    --text-muted: #898781;
    --grid: #2c2c2a;
    --axis: #383835;
    --border: rgba(255,255,255,0.10);
    --series-1: #3987e5;
    --series-2: #008300;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--page); }
  .viz-root {
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    background: var(--page);
    color: var(--text-primary);
    padding: 32px 28px 56px;
    min-height: 100vh;
  }
  .wrap { max-width: 1180px; margin: 0 auto; }
  h1 { font-size: 21px; font-weight: 600; margin: 0 0 6px; letter-spacing: -0.01em; }
  .sub { font-size: 13.5px; color: var(--text-secondary); margin: 0 0 4px; line-height: 1.55; max-width: 90ch; }
  .meta { font-size: 12px; color: var(--text-muted); margin: 10px 0 0; }
  .legend { display: flex; gap: 22px; align-items: center; margin: 22px 0 18px; flex-wrap: wrap; }
  .lg { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-secondary); }
  .sw { width: 11px; height: 11px; border-radius: 3px; flex: none; }
  .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; }
  @media (max-width: 960px) { .grid { grid-template-columns: 1fr; } }
  .card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px 16px 10px;
  }
  .card h2 { font-size: 14px; font-weight: 600; margin: 0 0 2px; }
  .card .note { font-size: 12px; color: var(--text-muted); margin: 0 0 8px; }
  .card .note b { color: var(--text-secondary); font-weight: 600; }
  svg { display: block; width: 100%; height: auto; overflow: visible; }
  .tick { font-size: 10.5px; fill: var(--text-muted); font-variant-numeric: tabular-nums; }
  .bar { transition: opacity .12s; }
  .bar:hover { opacity: .75; }
  .hit { fill: transparent; cursor: pointer; }
  #tt {
    position: fixed; pointer-events: none; opacity: 0;
    background: var(--surface-1); color: var(--text-primary);
    border: 1px solid var(--border); border-radius: 8px;
    padding: 8px 10px; font-size: 12px; line-height: 1.5;
    box-shadow: 0 4px 16px rgba(0,0,0,.16); z-index: 9; transition: opacity .1s;
    font-variant-numeric: tabular-nums; max-width: 260px;
  }
  #tt .t { font-weight: 600; margin-bottom: 3px; }
  #tt .r { color: var(--text-secondary); display: flex; gap: 8px; align-items: center; }
  details { margin-top: 26px; }
  summary { font-size: 13px; color: var(--text-secondary); cursor: pointer; padding: 6px 0; }
  table { border-collapse: collapse; font-size: 12.5px; margin-top: 10px; width: 100%; }
  th, td { text-align: right; padding: 6px 10px; border-bottom: 1px solid var(--grid); font-variant-numeric: tabular-nums; }
  th:first-child, td:first-child, th:nth-child(2), td:nth-child(2) { text-align: left; font-variant-numeric: normal; }
  th { color: var(--text-secondary); font-weight: 600; }
  caption { text-align: left; font-size: 12px; color: var(--text-muted); padding: 8px 0; }
</style>
</head>
<body data-palette="#2a78d6,#008300">
<div class="viz-root">
<div class="wrap">
  <h1>Does the previous day's magnitude predict the next day's opening scale?</h1>
  <p class="sub">
    Each factor is normalized by <code>meanAbs</code> of its recent history, which needs 3 fresh Greek ticks —
    30 minutes of wall clock. Seeding that scale from the previous day would remove the warm-up, but only if the
    previous day's magnitude actually predicts the next open. Each bar counts trading days whose ratio
    (previous-day magnitude &divide; current-day opening magnitude) fell in that bin.
    <b>1&times; is a perfect seed.</b> Bins are one doubling wide.
  </p>
  <p class="meta" id="meta"></p>

  <div class="legend" id="legend"></div>
  <div class="grid" id="grid"></div>

  <details>
    <summary>Table view — summary statistics and full bin counts</summary>
    <div id="tables"></div>
  </details>
</div>
</div>
<div id="tt"></div>

<script>
const DATA = ${payload};
const COLORS = ['var(--series-1)', 'var(--series-2)'];
const W = 540, H = 282, M = { top: 28, right: 12, bottom: 42, left: 38 };
const PW = W - M.left - M.right, PH = H - M.top - M.bottom;

const meta = DATA.meta;
document.getElementById('meta').textContent =
  meta.days + ' trading days (' + meta.firstDate + ' \\u2192 ' + meta.lastDate + ') \\u00b7 ' +
  meta.pairs + ' factor-day pairs \\u00b7 comparing the first/last ' + meta.edgeTicks +
  ' fresh Greek ticks of each day';

document.getElementById('legend').innerHTML = DATA.facets[0].series.map((s, i) =>
  '<span class="lg"><span class="sw" style="background:' + COLORS[i] + '"></span>' + s.label + '</span>'
).join('') + '<span class="lg" style="color:var(--text-muted)">Bars right of 1\\u00d7 = previous day ran larger</span>';

const fmtRatio = (k) => k < 0 ? '1/' + Math.pow(2, -k) + '\\u00d7' : Math.pow(2, k) + '\\u00d7';
const nBins = meta.binMax - meta.binMin;

function facetSvg(fc) {
  const maxCount = Math.max(1, ...fc.series.flatMap(s => s.bins));
  // Round up to a multiple of 4 gridline steps so every tick is a whole day
  // (max/10 gave ticks like 12.5 days, which is not a thing).
  const yTop = Math.max(4, Math.ceil(maxCount / 8) * 8);
  const x = (b) => M.left + (b / nBins) * PW;
  const y = (c) => M.top + PH - (c / yTop) * PH;
  const bw = PW / nBins;
  const gap = 2;                       // surface gap between adjacent fills
  const barW = (bw - gap * 2) / 2;
  let s = '';

  // Horizontal gridlines — solid hairlines, one shade off the surface.
  for (let g = 0; g <= 4; g++) {
    const c = (yTop / 4) * g;
    s += '<line x1="' + M.left + '" x2="' + (M.left + PW) + '" y1="' + y(c) + '" y2="' + y(c) +
         '" stroke="var(--grid)" stroke-width="1"/>' +
         '<text class="tick" x="' + (M.left - 7) + '" y="' + (y(c) + 3.5) + '" text-anchor="end">' + c + '</text>';
  }
  // Bars, grouped per bin.
  fc.series.forEach((ser, si) => {
    ser.bins.forEach((c, b) => {
      const bx = x(b) + gap / 2 + si * (barW + gap);
      if (c > 0) {
        const h = Math.max(2, M.top + PH - y(c));
        s += '<rect class="bar" x="' + bx.toFixed(2) + '" y="' + y(c).toFixed(2) + '" width="' + barW.toFixed(2) +
             '" height="' + h.toFixed(2) + '" rx="3" fill="' + COLORS[si] + '"/>';
      }
      // Hit target spans the full bar column height (>= 24px) regardless of value.
      s += '<rect class="hit" x="' + (bx - gap / 2).toFixed(2) + '" y="' + M.top + '" width="' + (barW + gap).toFixed(2) +
           '" height="' + PH + '" data-s="' + si + '" data-b="' + b + '" data-f="' + fc.factor + '"/>';
    });
  });
  // Reference line at 1x (log2 = 0) — a real threshold, not a gridline. Its
  // label sits ABOVE the plot so it can never collide with a tall bar.
  const zx = x(-meta.binMin);
  s += '<line x1="' + zx + '" x2="' + zx + '" y1="' + (M.top - 8) + '" y2="' + (M.top + PH) +
       '" stroke="var(--text-secondary)" stroke-width="1.5"/>';
  s += '<text class="tick" x="' + (zx + 5) + '" y="' + (M.top - 12) + '" fill="var(--text-secondary)">1\\u00d7 perfect seed</text>';
  // Baseline + x ticks (every 2nd boundary keeps labels from colliding).
  s += '<line x1="' + M.left + '" x2="' + (M.left + PW) + '" y1="' + (M.top + PH) + '" y2="' + (M.top + PH) +
       '" stroke="var(--axis)" stroke-width="1"/>';
  for (let k = meta.binMin; k <= meta.binMax; k += 2) {
    const px = x(k - meta.binMin);
    s += '<text class="tick" x="' + px + '" y="' + (M.top + PH + 15) + '" text-anchor="middle">' + fmtRatio(k) + '</text>';
  }
  s += '<text class="tick" x="' + (M.left + PW / 2) + '" y="' + (M.top + PH + 34) +
       '" text-anchor="middle">previous-day magnitude \\u00f7 current-day opening magnitude</text>';
  // y-axis title, clear of the topmost tick label.
  s += '<text class="tick" x="' + (M.left - 30) + '" y="' + (M.top - 12) + '" text-anchor="start">days</text>';
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img">' + s + '</svg>';
}

document.getElementById('grid').innerHTML = DATA.facets.map(fc => {
  // Direct-label the number that decides the question, per facet.
  const note = fc.series.map((s, i) =>
    '<b style="color:' + COLORS[i] + '">' + s.stats.geomean.toFixed(2) + '\\u00d7</b> typical, ' +
    Math.round(s.stats.within2x * 100) + '% within 2\\u00d7'
  ).join(' &nbsp;\\u00b7&nbsp; ');
  return '<div class="card"><h2>' + fc.label + '</h2><p class="note">' + note + '</p>' + facetSvg(fc) + '</div>';
}).join('');

// Tooltip — enhances; every value is also in the table view below.
const tt = document.getElementById('tt');
document.getElementById('grid').addEventListener('mousemove', (e) => {
  const h = e.target.closest('.hit');
  if (!h) { tt.style.opacity = 0; return; }
  const fc = DATA.facets.find(f => f.factor === h.dataset.f);
  const si = +h.dataset.s, b = +h.dataset.b;
  const ser = fc.series[si];
  const lo = meta.binMin + b, count = ser.bins[b];
  tt.innerHTML = '<div class="t">' + fmtRatio(lo) + ' \\u2013 ' + fmtRatio(lo + 1) + '</div>' +
    '<div class="r"><span class="sw" style="background:' + COLORS[si] + '"></span>' + ser.label + '</div>' +
    '<div class="r">' + count + ' day' + (count === 1 ? '' : 's') +
    ' (' + (100 * count / ser.stats.n).toFixed(0) + '% of ' + ser.stats.n + ')</div>';
  tt.style.opacity = 1;
  tt.style.left = Math.min(e.clientX + 14, innerWidth - 270) + 'px';
  tt.style.top = (e.clientY + 16) + 'px';
});
document.getElementById('grid').addEventListener('mouseleave', () => { tt.style.opacity = 0; });

// Table view — the WCAG-clean twin. Every plotted value appears here.
let html = '<table><caption>Summary — ratio of previous-day magnitude to current-day opening magnitude. ' +
  'Geomean is the typical ratio; 1.00 means unbiased.</caption><thead><tr><th>Factor</th><th>Seed source</th>' +
  '<th>n</th><th>p10</th><th>median</th><th>p90</th><th>geomean</th><th>within 2\\u00d7</th></tr></thead><tbody>';
for (const fc of DATA.facets) for (const s of fc.series) {
  html += '<tr><td>' + fc.label + '</td><td>' + s.label + '</td><td>' + s.stats.n + '</td><td>' +
    s.stats.p10.toFixed(2) + '</td><td>' + s.stats.median.toFixed(2) + '</td><td>' + s.stats.p90.toFixed(2) +
    '</td><td>' + s.stats.geomean.toFixed(2) + '</td><td>' + Math.round(s.stats.within2x * 100) + '%</td></tr>';
}
html += '</tbody></table>';

html += '<table><caption>Bin counts (days per bin).</caption><thead><tr><th>Factor</th><th>Seed source</th>';
for (let k = meta.binMin; k < meta.binMax; k++) html += '<th>' + fmtRatio(k) + '</th>';
html += '</tr></thead><tbody>';
for (const fc of DATA.facets) for (const s of fc.series) {
  html += '<tr><td>' + fc.label + '</td><td>' + s.label + '</td>';
  for (const c of s.bins) html += '<td>' + (c || '\\u2013') + '</td>';
  html += '</tr>';
}
html += '</tbody></table>';
document.getElementById('tables').innerHTML = html;
</script>
</body>
</html>
`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
