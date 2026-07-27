import { loadDateRange } from './data-loader.js';
import { simulate } from './backtest.js';
import { DEFAULT_CONFIG } from './types.js';
const snaps = await loadDateRange('2026-05-18','2026-07-24', DEFAULT_CONFIG.strikeWindow);
for (const g of [15, 8, 5, 2]) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.risk.minGexTakeProfitPoints = g;
  const r = simulate(snaps, cfg);
  console.log(`minGexTakeProfitPoints=${String(g).padStart(2)}  trades=${String(r.trades.length).padStart(3)}  pnl=$${r.totalPnl.toFixed(0)}  failed=${r.failed}`);
}
