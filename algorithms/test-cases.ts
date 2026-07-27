/**
 * Explained test cases (TODO #11).
 *
 * A curated list of date + intraday-window cases the algo is replayed against.
 * For every case this file:
 *   1. Replays the FULL trading day through the same SignalGenerator the
 *      backtest/tuner use (so z-score history + cone crossings are correct).
 *   2. Prints an EXPLAINED timeline for the WHOLE day — every slot from the
 *      market open onward is listed with ALL of its factor z-scores (composite,
 *      gexZ, dGammaZ, positionsZ, dPositionsZ) computed exactly as the tuner
 *      computes them, so e.g. the 09:30 factors are visible even when the case
 *      window starts at 09:40. The case's [start, end] ET window is bracketed
 *      inline; for every entry / exit / missed-trigger the factors and
 *      thresholds that drove the decision are expanded (cone state, GEX-TP gate).
 *   3. Writes a per-case SVG graph to `docs/test-cases/<id>.svg` plotting the
 *      composite z-score and gexZ (left axis) against spot + cone bands and the
 *      entry/exit levels (right axis) over the window.
 *   4. Tees the full explained run to `docs/test-cases/logs/` — a timestamped
 *      `test-cases-<UTC>.log` per run plus `latest.log` (both gitignored).
 *
 * The TEST_CASES list and runTestCase() are exported so the backtest/tuner can
 * import and replay the same scenarios under a candidate config.
 *
 * Usage:
 *   npm run test-cases                 # run every case with DEFAULT_CONFIG
 *   npm run test-cases:best            # run under bestModel from tuned-models.json
 *   npm run test-cases:latest          # run under lastModel  from tuned-models.json
 *   ALGO_CONFIG_PATH=my.json npm run test-cases          # run under a config file
 *   TEST_CASE_ID=2026-06-10-midday npm run test-cases    # one case (combines with any of the above)
 *
 * Config selection (highest priority first): --best/USE_BEST_MODEL,
 * --latest/USE_LATEST_MODEL, ALGO_CONFIG_PATH, then DEFAULT_CONFIG.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadDay } from './data-loader.js';
import { SignalGenerator } from './signal-generator.js';
import { gexTakeProfitPoints } from './risk-manager.js';
import { loadModelStore, type ModelRecord } from './model-store.js';
import type { AlgoConfig, Signal, Snapshot, TradeRecord } from './types.js';
import { DEFAULT_CONFIG } from './types.js';

// ── Case definitions ──

export interface TestCase {
  /** Stable id — also the output SVG filename. */
  id: string;
  /** Trading day YYYY-MM-DD (0DTE expiry). */
  date: string;
  /** Window start, ET wall-clock "HH:MM" (inclusive). */
  startEt: string;
  /** Window end, ET wall-clock "HH:MM" (inclusive). */
  endEt: string;
  /** What this case is meant to illustrate. */
  description: string;
}

export const TEST_CASES: TestCase[] = [
  {
    id: '2026-06-10-midday',
    date: '2026-06-10',
    startEt: '11:00',
    endEt: '15:00',
    description:
      'Midday window — inspect how the composite z-score, gamma exposure and ' +
      'the expected-move cone drive (or suppress) entries/exits between 11:00 ' +
      'and 15:00 ET.',
  },
  {
    id: '2026-06-17-1400',
    date: '2026-06-17',
    startEt: '14:00',
    endEt: '16:00',
    description:
      '14:00–16:00 ET — inspect composite z-score, gamma exposure and ' +
      'expected-move cone between 14:00 and 16:00 ET on 2026-06-17.',
  },
  {
    id: '2026-06-11-1100',
    date: '2026-06-11',
    startEt: '11:00',
    endEt: '15:00',
    description:
      '11:00–15:00 ET — inspect composite z-score, gamma exposure and ' +
      'expected-move cone between 11:00 and 15:00 ET on 2026-06-11.',
  },
  {
    id: '2026-05-19-0930',
    date: '2026-05-19',
    startEt: '09:30',
    endEt: '15:30',
    description:
      '09:30–15:30 ET — inspect composite z-score, gamma exposure and ' +
      'expected-move cone between 09:30 and 15:30 ET on 2026-05-19.',
  },
  {
    id: '2026-05-21-0930',
    date: '2026-05-21',
    startEt: '09:30',
    endEt: '15:10',
    description:
      '09:30–15:10 ET — inspect composite z-score, gamma exposure and ' +
      'expected-move cone between 09:30 and 15:10 ET on 2026-05-21.',
  },
  {
    id: '2026-05-26-0930',
    date: '2026-05-26',
    startEt: '09:30',
    endEt: '12:30',
    description:
      '09:30–12:30 ET — inspect composite z-score, gamma exposure and ' +
      'expected-move cone between 09:30 and 12:30 ET on 2026-05-26.',
  },
  {
    id: '2026-05-28-0930',
    date: '2026-05-28',
    startEt: '09:30',
    endEt: '15:00',
    description:
      '09:30–15:00 ET — inspect composite z-score, gamma exposure and ' +
      'expected-move cone between 09:30 and 15:00 ET on 2026-05-28.',
  },
  {
    id: '2026-05-29-0930',
    date: '2026-05-29',
    startEt: '09:30',
    endEt: '14:30',
    description:
      '09:30–14:30 ET — inspect composite z-score, gamma exposure and ' +
      'expected-move cone between 09:30 and 14:30 ET on 2026-05-29.',
  },
  {
    id: '2026-06-01-0930',
    date: '2026-06-01',
    startEt: '09:30',
    endEt: '16:00',
    description:
      '09:30–16:00 ET — inspect composite z-score, gamma exposure and ' +
      'expected-move cone between 09:30 and 16:00 ET on 2026-06-01.',
  },
  {
    id: '2026-06-02-1030',
    date: '2026-06-02',
    startEt: '10:30',
    endEt: '13:30',
    description:
      '10:30–13:30 ET — inspect composite z-score, gamma exposure and ' +
      'expected-move cone between 10:30 and 13:30 ET on 2026-06-02.',
  },
  {
    id: '2026-06-03-0930',
    date: '2026-06-03',
    startEt: '09:30',
    endEt: '15:30',
    description:
      '09:30–15:30 ET — inspect composite z-score, gamma exposure and ' +
      'expected-move cone between 09:30 and 15:30 ET on 2026-06-03.',
  },
  {
    id: '2026-06-04-0930',
    date: '2026-06-04',
    startEt: '09:30',
    endEt: '15:30',
    description:
      '09:30–15:30 ET — inspect composite z-score, gamma exposure and ' +
      'expected-move cone between 09:30 and 15:30 ET on 2026-06-04.',
  },
  {
    id: '2026-06-05-1400',
    date: '2026-06-05',
    startEt: '14:00',
    endEt: '15:30',
    description:
      '14:00–15:30 ET — inspect composite z-score, gamma exposure and ' +
      'expected-move cone between 14:00 and 15:30 ET on 2026-06-05.',
  },
];

// ── Per-slot diagnostics captured during replay ──

interface SlotDiag {
  capturedAt: string;
  etLabel: string;
  etMinutes: number;
  isTick: boolean;
  inWindow: boolean;
  spot: number;
  composite: number;
  gexZ: number;
  dGammaZ: number;
  positionsZ: number;
  dPositionsZ: number;
  coneUpper: number;
  coneLower: number;
  coneState: Signal['cone']['state'];
  coneCrossed: Signal['cone']['crossed'];
  action: Signal['action'];
  confidence: Signal['confidence'];
  reason: string;
  /** GEX take-profit distance (gamma-center dist) this slot would target. */
  gexTpPoints: number;
}

export interface TestCaseResult {
  testCase: TestCase;
  /** Every slot of the trading day, from the open (drives the explained log). */
  allSlots: SlotDiag[];
  /** In-window slots only (drives the SVG — the part the case is about). */
  slots: SlotDiag[];
  /** Trades that entered or exited inside the window. */
  trades: TradeRecord[];
  /** All trades of the day (used to annotate entries/exits in the full log). */
  allTrades: TradeRecord[];
  /** Absolute path of the SVG written, or null when there was no data. */
  svgPath: string | null;
}

// ── ET time helpers (display + window gating; storage stays UTC) ──

function etParts(utcIso: string): { hh: number; mm: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(utcIso));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  return { hh: get('hour'), mm: get('minute') };
}

function etMinutes(utcIso: string): number {
  const { hh, mm } = etParts(utcIso);
  return hh * 60 + mm;
}

function etLabel(utcIso: string): string {
  const { hh, mm } = etParts(utcIso);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function parseHhmm(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

// ── Runner ──

/**
 * Replay one case and write its graph. The FULL day is fed to the generator so
 * the z-score lookback and cone crossing-state are built correctly; only the
 * in-window slots are reported and plotted.
 */
export async function runTestCase(
  testCase: TestCase,
  config: AlgoConfig = DEFAULT_CONFIG,
): Promise<TestCaseResult> {
  const daySnapshots = await loadDay(testCase.date, config.strikeWindow);

  const startMin = parseHhmm(testCase.startEt);
  const endMin = parseHhmm(testCase.endEt);
  const inWindow = (snap: Snapshot) => {
    const m = etMinutes(snap.capturedAt);
    return m >= startMin && m <= endMin;
  };

  const generator = new SignalGenerator(config);
  const diags: SlotDiag[] = [];

  for (const snap of daySnapshots) {
    const signal = generator.processSnapshot(snap);
    diags.push({
      capturedAt: snap.capturedAt,
      etLabel: etLabel(snap.capturedAt),
      etMinutes: etMinutes(snap.capturedAt),
      isTick: snap.greeksStale === true,
      inWindow: inWindow(snap),
      spot: snap.spot,
      composite: signal.score.composite,
      gexZ: signal.score.gexZ,
      dGammaZ: signal.score.dGammaZ,
      positionsZ: signal.score.positionsZ,
      dPositionsZ: signal.score.dPositionsZ,
      coneUpper: signal.cone.upper,
      coneLower: signal.cone.lower,
      coneState: signal.cone.state,
      coneCrossed: signal.cone.crossed,
      action: signal.action,
      confidence: signal.confidence,
      reason: signal.reason,
      gexTpPoints: gexTakeProfitPoints(config, snap),
    });
  }

  const windowSlots = diags.filter((d) => d.inWindow);

  // Trades touching the window (entered or exited inside it).
  const allTrades = generator.getTrades();
  const trades = allTrades.filter((t) => {
    const enter = etMinutes(t.entryTime);
    const exit = etMinutes(t.exitTime);
    return (enter >= startMin && enter <= endMin) || (exit >= startMin && exit <= endMin);
  });

  let svgPath: string | null = null;
  if (windowSlots.length > 0) {
    svgPath = writeSvg(testCase, windowSlots, trades, config);
  }

  return { testCase, allSlots: diags, slots: windowSlots, trades, allTrades, svgPath };
}

// ── Explanation (console) ──

/**
 * Concise per-case summary: the case header, the trades that touched the window
 * (one line each) and their net P&L. The full per-slot factor timeline is no
 * longer printed to the console -- the SVG graph and the tee'd log file carry
 * the detail, so the console stays skimmable across many cases.
 */
function printExplanation(result: TestCaseResult): void {
  const { testCase, allSlots, trades, svgPath } = result;

  console.log(`\n${'='.repeat(72)}`);
  console.log(`TEST CASE  ${testCase.id}`);
  console.log(`${testCase.date}  ${testCase.startEt}-${testCase.endEt} ET`);
  console.log(testCase.description);
  console.log('='.repeat(72));

  if (allSlots.length === 0) {
    console.log('\n  (no snapshots found for this day - is the day loaded in the DB?)');
    return;
  }

  for (const t of trades) {
    console.log(
      `  ${etLabel(t.entryTime)}-${etLabel(t.exitTime)}  ${t.direction.toUpperCase()} ${t.contracts} ` +
        `@ spx ${t.entryPrice.toFixed(2)} -> ${t.exitPrice.toFixed(2)}  pnl=${fmtUsd(t.pnl)}  (${t.reason})`,
    );
  }

  console.log(
    `Trades in window: ${trades.length}` +
      (trades.length > 0
        ? `  net pnl=${fmtUsd(trades.reduce((a, t) => a + t.pnl, 0))}`
        : ''),
  );
  if (svgPath) console.log(`Graph: ${svgPath}`);
}

function fmtSigned(n: number): string {
  return (n >= 0 ? '+' : '') + n.toFixed(2);
}

function fmtUsd(n: number): string {
  return (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2);
}

// ── SVG graph (dependency-free dual-axis line chart) ──

const SVG_W = 1040;
const SVG_H = 520;
const M = { top: 48, right: 70, bottom: 56, left: 60 };
const PLOT_W = SVG_W - M.left - M.right;
const PLOT_H = SVG_H - M.top - M.bottom;

const COLORS = {
  composite: '#2563eb', // blue
  gexZ: '#f59e0b', // amber
  spot: '#16a34a', // green
  cone: '#9ca3af', // gray
  guide: '#d1d5db', // light gray
  zero: '#6b7280',
  long: '#16a34a',
  short: '#dc2626',
  exit: '#7c3aed',
  text: '#111827',
};

function writeSvg(
  testCase: TestCase,
  slots: SlotDiag[],
  trades: TradeRecord[],
  config: AlgoConfig,
): string {
  const n = slots.length;
  const x = (i: number) => M.left + (n <= 1 ? PLOT_W / 2 : (i / (n - 1)) * PLOT_W);

  // Left axis: z-scores, symmetric around 0.
  const zMax = Math.max(
    config.strongEntryThreshold,
    config.zClamp,
    ...slots.map((s) => Math.abs(s.composite)),
    ...slots.map((s) => Math.abs(s.gexZ)),
  );
  const zTop = niceCeil(zMax);
  const yL = (z: number) => M.top + PLOT_H / 2 - (z / zTop) * (PLOT_H / 2);

  // Right axis: price (spot + cone bands).
  const prices = [
    ...slots.map((s) => s.spot),
    ...slots.map((s) => s.coneUpper),
    ...slots.map((s) => s.coneLower),
  ];
  let pMin = Math.min(...prices);
  let pMax = Math.max(...prices);
  const pad = Math.max(1, (pMax - pMin) * 0.08);
  pMin -= pad;
  pMax += pad;
  const yR = (p: number) => M.top + PLOT_H - ((p - pMin) / (pMax - pMin)) * PLOT_H;

  const idxByTime = new Map(slots.map((s, i) => [s.capturedAt, i]));

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_W}" height="${SVG_H}" ` +
      `viewBox="0 0 ${SVG_W} ${SVG_H}" font-family="ui-monospace,Menlo,Consolas,monospace">`,
  );
  parts.push(`<rect width="${SVG_W}" height="${SVG_H}" fill="#ffffff"/>`);

  // Title
  parts.push(
    text(
      M.left,
      26,
      `${testCase.id}  —  ${testCase.date} ${testCase.startEt}–${testCase.endEt} ET`,
      14,
      COLORS.text,
      'start',
      'bold',
    ),
  );

  // Plot frame
  parts.push(
    `<rect x="${M.left}" y="${M.top}" width="${PLOT_W}" height="${PLOT_H}" fill="none" stroke="#e5e7eb"/>`,
  );

  // Left-axis gridlines + labels (z): zero, ±entry, ±strong, ±top
  const zLines = [
    { z: 0, c: COLORS.zero, dash: '' },
    { z: config.entryThreshold, c: COLORS.guide, dash: '4 3' },
    { z: -config.entryThreshold, c: COLORS.guide, dash: '4 3' },
    { z: config.strongEntryThreshold, c: COLORS.guide, dash: '1 4' },
    { z: -config.strongEntryThreshold, c: COLORS.guide, dash: '1 4' },
  ];
  for (const g of zLines) {
    if (Math.abs(g.z) > zTop) continue;
    const y = yL(g.z);
    parts.push(
      `<line x1="${M.left}" y1="${y.toFixed(1)}" x2="${M.left + PLOT_W}" y2="${y.toFixed(1)}" ` +
        `stroke="${g.c}"${g.dash ? ` stroke-dasharray="${g.dash}"` : ''}/>`,
    );
    parts.push(text(M.left - 6, y + 3, fmtSigned(g.z), 10, COLORS.zero, 'end'));
  }
  parts.push(text(14, M.top + PLOT_H / 2, 'z-score', 11, COLORS.text, 'middle', '', -90));

  // Right-axis labels (price)
  for (let k = 0; k <= 4; k++) {
    const p = pMin + (k / 4) * (pMax - pMin);
    const y = yR(p);
    parts.push(text(M.left + PLOT_W + 6, y + 3, p.toFixed(0), 10, COLORS.spot, 'start'));
  }
  parts.push(
    text(SVG_W - 12, M.top + PLOT_H / 2, 'price', 11, COLORS.text, 'middle', '', 90),
  );

  // X labels (every ~Nth slot)
  const step = Math.max(1, Math.round(n / 10));
  for (let i = 0; i < n; i += step) {
    parts.push(
      `<line x1="${x(i).toFixed(1)}" y1="${M.top + PLOT_H}" x2="${x(i).toFixed(1)}" y2="${M.top + PLOT_H + 4}" stroke="${COLORS.zero}"/>`,
    );
    parts.push(text(x(i), M.top + PLOT_H + 18, slots[i]!.etLabel, 9, COLORS.zero, 'middle'));
  }

  // Cone bands (right axis, dashed)
  parts.push(polyline(slots.map((s, i) => [x(i), yR(s.coneUpper)]), COLORS.cone, 1, '5 4'));
  parts.push(polyline(slots.map((s, i) => [x(i), yR(s.coneLower)]), COLORS.cone, 1, '5 4'));

  // Spot (right axis)
  parts.push(polyline(slots.map((s, i) => [x(i), yR(s.spot)]), COLORS.spot, 2));

  // Composite z + gexZ (left axis)
  parts.push(polyline(slots.map((s, i) => [x(i), yL(s.composite)]), COLORS.composite, 2));
  parts.push(polyline(slots.map((s, i) => [x(i), yL(s.gexZ)]), COLORS.gexZ, 1.5));

  // Entry / exit markers on the price line
  for (const t of trades) {
    const ei = idxByTime.get(t.entryTime);
    if (ei !== undefined) {
      const color = t.direction === 'long' ? COLORS.long : COLORS.short;
      parts.push(marker(x(ei), yR(t.entryPrice), t.direction === 'long' ? 'up' : 'down', color));
    }
    const xi = idxByTime.get(t.exitTime);
    if (xi !== undefined) {
      parts.push(marker(x(xi), yR(t.exitPrice), 'x', COLORS.exit));
    }
  }

  // Legend
  const legend: Array<[string, string]> = [
    ['composite z', COLORS.composite],
    ['gexZ', COLORS.gexZ],
    ['spot', COLORS.spot],
    ['cone', COLORS.cone],
    ['entry▲/▼', COLORS.long],
    ['exit✕', COLORS.exit],
  ];
  let lx = M.left;
  for (const [label, color] of legend) {
    parts.push(`<rect x="${lx}" y="${SVG_H - 14}" width="10" height="10" fill="${color}"/>`);
    parts.push(text(lx + 14, SVG_H - 5, label, 10, COLORS.text, 'start'));
    lx += 14 + label.length * 6.6 + 14;
  }

  parts.push('</svg>');

  const outPath = resolveOutPath(testCase.id);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, parts.join('\n'), 'utf8');
  return outPath;
}

function resolveOutPath(id: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'docs', 'test-cases', `${id}.svg`);
}

/** Directory the per-run explained logs are written to (gitignored). */
function logsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'docs', 'test-cases', 'logs');
}

function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const frac = v / pow;
  const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return nice * pow;
}

function polyline(pts: Array<[number, number]>, color: string, width: number, dash = ''): string {
  const d = pts.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
  return `<polyline points="${d}" fill="none" stroke="${color}" stroke-width="${width}"${
    dash ? ` stroke-dasharray="${dash}"` : ''
  }/>`;
}

function marker(cx: number, cy: number, kind: 'up' | 'down' | 'x', color: string): string {
  const r = 5;
  if (kind === 'up') {
    return `<polygon points="${cx.toFixed(1)},${(cy - r).toFixed(1)} ${(cx - r).toFixed(1)},${(cy + r).toFixed(1)} ${(cx + r).toFixed(1)},${(cy + r).toFixed(1)}" fill="${color}"/>`;
  }
  if (kind === 'down') {
    return `<polygon points="${cx.toFixed(1)},${(cy + r).toFixed(1)} ${(cx - r).toFixed(1)},${(cy - r).toFixed(1)} ${(cx + r).toFixed(1)},${(cy - r).toFixed(1)}" fill="${color}"/>`;
  }
  return (
    `<line x1="${(cx - r).toFixed(1)}" y1="${(cy - r).toFixed(1)}" x2="${(cx + r).toFixed(1)}" y2="${(cy + r).toFixed(1)}" stroke="${color}" stroke-width="2"/>` +
    `<line x1="${(cx - r).toFixed(1)}" y1="${(cy + r).toFixed(1)}" x2="${(cx + r).toFixed(1)}" y2="${(cy - r).toFixed(1)}" stroke="${color}" stroke-width="2"/>`
  );
}

function text(
  x: number,
  y: number,
  s: string,
  size: number,
  color: string,
  anchor: 'start' | 'middle' | 'end' = 'start',
  weight = '',
  rotate = 0,
): string {
  const transform = rotate ? ` transform="rotate(${rotate} ${x} ${y})"` : '';
  return (
    `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${size}" fill="${color}" ` +
    `text-anchor="${anchor}"${weight ? ` font-weight="${weight}"` : ''}${transform}>${escapeXml(s)}</text>`
  );
}

function escapeXml(s: string): string {
  return s.replace(/[<>&]/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'));
}

// ── Config resolution ──

/**
 * Shallow-merge a (possibly partial) config over `DEFAULT_CONFIG`, merging the
 * nested `risk` object too, so both full configs and partial diffs work.
 */
function mergeOverDefault(raw: Partial<AlgoConfig>): AlgoConfig {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    risk: { ...DEFAULT_CONFIG.risk, ...(raw.risk ?? {}) },
  };
}

/** Truthy env flag: "1", "true", "yes" (case-insensitive). */
function envFlag(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** Short description of a stored model record for the "Config source:" line. */
function describeModel(rec: ModelRecord): string {
  return `${rec.source} · metric=${rec.metric} · savedAt=${rec.savedAt}`;
}

/**
 * Resolve the config to replay under, in priority order:
 *   1. `--best`  / `USE_BEST_MODEL`   → `bestModel.config` from tuned-models.json
 *   2. `--latest`/ `USE_LATEST_MODEL` → `lastModel.config` from tuned-models.json
 *   3. `ALGO_CONFIG_PATH`             → JSON file (full config or partial diff)
 *   4. otherwise                      → `DEFAULT_CONFIG`
 *
 * Stored-model and file configs are merged over `DEFAULT_CONFIG` so configs
 * saved before a field was added still resolve every key.
 */
function loadRunConfig(): { config: AlgoConfig; source: string } {
  const argv = process.argv.slice(2);
  const wantBest = argv.includes('--best') || envFlag('USE_BEST_MODEL');
  const wantLatest = argv.includes('--latest') || envFlag('USE_LATEST_MODEL');

  if (wantBest || wantLatest) {
    const store = loadModelStore();
    const rec = wantBest ? store.bestModel : store.lastModel;
    const slot = wantBest ? 'bestModel' : 'lastModel';
    if (!rec) {
      throw new Error(
        `No ${slot} recorded in tuned-models.json — run \`npm run tune\` first, ` +
          `or drop the ${wantBest ? '--best/USE_BEST_MODEL' : '--latest/USE_LATEST_MODEL'} flag.`,
      );
    }
    return { config: mergeOverDefault(rec.config), source: `${slot} (${describeModel(rec)})` };
  }

  const path = process.env.ALGO_CONFIG_PATH;
  if (!path) return { config: DEFAULT_CONFIG, source: 'DEFAULT_CONFIG' };

  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<AlgoConfig>;
  return { config: mergeOverDefault(raw), source: path };
}

// ── CLI ──

const isMain =
  process.argv[1]?.endsWith('test-cases.ts') || process.argv[1]?.endsWith('test-cases.js');

if (isMain) {
  const only = process.env.TEST_CASE_ID;
  const cases = only ? TEST_CASES.filter((c) => c.id === only) : TEST_CASES;

  if (cases.length === 0) {
    console.error(
      `No test case matched TEST_CASE_ID=${only}. Known: ${TEST_CASES.map((c) => c.id).join(', ')}`,
    );
    process.exit(1);
  }

  // Tee every console line into a buffer so the full explained run is persisted
  // to docs/test-cases/logs/ alongside the per-case SVGs. Terminal output is
  // unchanged — the original console methods still write to stdout/stderr.
  const logLines: string[] = [];
  const tee =
    (write: (...a: unknown[]) => void) =>
    (...args: unknown[]) => {
      logLines.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
      write(...args);
    };
  const origLog = console.log.bind(console);
  console.log = tee(origLog);
  console.error = tee(console.error.bind(console));

  const flushLog = (): string => {
    const dir = logsDir();
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-'); // filesystem-safe
    const body = logLines.join('\n') + '\n';
    const file = resolve(dir, `test-cases-${stamp}.log`);
    writeFileSync(file, body, 'utf8');
    writeFileSync(resolve(dir, 'latest.log'), body, 'utf8'); // convenience: always the most recent run
    return file;
  };

  (async () => {
    const { config, source } = loadRunConfig();
    console.log(`Config source: ${source}`);

    let netPnl = 0;
    let tradeCount = 0;
    for (const testCase of cases) {
      const result = await runTestCase(testCase, config);
      printExplanation(result);
      for (const t of result.trades) {
        netPnl += t.pnl;
        tradeCount += 1;
      }
    }

    console.log(`\n${'='.repeat(72)}`);
    console.log(
      `TEST-TRADE RESULT  ${cases.length} case(s), ${tradeCount} trades  ` +
        `net pnl=${fmtUsd(netPnl)}`,
    );

    const logFile = flushLog();
    origLog(`Log written: ${logFile}`);
  })().catch((e) => {
    console.error('Test-case run failed:', e);
    try {
      const logFile = flushLog();
      origLog(`Partial log written: ${logFile}`);
    } catch {
      /* best-effort log flush on failure */
    }
    process.exit(1);
  });
}
