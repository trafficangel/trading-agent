import type { FastifyInstance } from 'fastify';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  STRATEGY_CONFIGS,
  getStrategyConfig,
  formatStrategyTradeId,
  type StrategyConfig,
  type BacktestSnapshot,
  TRACK_C_NOTIONAL_USD,
} from './track-c-config.js';
import { recomputeBacktestStats, enrichTrades, type RecomputedStats } from './backtest-recompute.js';
import { isAuthed } from '../auth/routes.js';
import {
  getStrategyLiveStats,
  getStrategyRecentTrades,
  getStrategyActiveTrades,
  type StrategyLiveStats,
  type LiveTradeRow,
  type ActiveTradeRow,
} from './live-stats.js';

// (SUPPORT_URL placeholder removed — never referenced in the rendered
//  pages. Re-add if/when a contact link appears in the page shell.)

// --- Backtest trades loader ---
// Scraped trades log lives in src/strategies/data/<id>.json (written by
// scripts/import-strategy.ts). Loaded lazily on first request per strategy
// and cached forever — the file is immutable per deploy.

type BacktestTrade = {
  num: number;
  side: 'long' | 'short';
  entryAt: number | null;
  entryPrice: number;
  exitAt: number | null;
  exitPrice: number;
  netPnlUsdt: number;
  cumulativePnlUsdt: number;
};

type BacktestTradesBundle = {
  trades: BacktestTrade[];
  /** Full strategy trade count (from Performance tab), may exceed trades.length when capped. */
  totalTradesInStrategy: number;
  capped: boolean;
};

const backtestTradesCache = new Map<string, BacktestTradesBundle | null>();

export function loadBacktestTrades(strategyId: string): BacktestTradesBundle | null {
  if (backtestTradesCache.has(strategyId)) {
    return backtestTradesCache.get(strategyId) ?? null;
  }
  // Resolve from process.cwd() — same root the server starts from.
  // dist/ build keeps the src/strategies/data/ siblings, so this works
  // both in dev (tsx from src/) and prod (node from dist/).
  const candidates = [
    resolve('src', 'strategies', 'data', `${strategyId}.json`),
    resolve('dist', 'strategies', 'data', `${strategyId}.json`),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const json = JSON.parse(readFileSync(p, 'utf-8'));
        const trades = (json?.tradesLog ?? []) as BacktestTrade[];
        const total = (json?.totalTradesInStrategy as number) ?? trades.length;
        const capped = (json?.tradesLogCapped as boolean) ?? false;
        const bundle: BacktestTradesBundle = {
          trades,
          totalTradesInStrategy: total,
          capped,
        };
        backtestTradesCache.set(strategyId, bundle);
        return bundle;
      } catch {
        // fall through
      }
    }
  }
  backtestTradesCache.set(strategyId, null);
  return null;
}

/**
 * Public landing-page routes for Track C strategies.
 *
 *   GET /strategies          → index listing all enabled strategies
 *   GET /strategies/:code    → strategy detail page (backtest + live)
 *
 * Server-side HTML rendering (no React/build step). Style inlined for
 * single-file deploy. Auto-fresh on each request — live stats come
 * straight from SQLite via getStrategyLiveStats.
 *
 * Cache-Control: 60 seconds — protects against scrape storms while
 * keeping the data near-realtime for genuine readers.
 */

const PAGE_CACHE_SECONDS = 60;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c] ?? c);
}

function fmtUsd(n: number, withSign = false): string {
  const sign = withSign && n >= 0 ? '+' : '';
  return `${sign}$${n.toFixed(2)}`;
}

function fmtPct(n: number, withSign = false): string {
  const sign = withSign && n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function classForValue(n: number): 'pos' | 'neg' | 'neu' {
  if (n > 0) return 'pos';
  if (n < 0) return 'neg';
  return 'neu';
}

/**
 * Russian plural selector. Pass three forms:
 *   pluralRu(1, 'сделка', 'сделки', 'сделок')  → 'сделка'
 *   pluralRu(2, 'сделка', 'сделки', 'сделок')  → 'сделки'
 *   pluralRu(5, 'сделка', 'сделки', 'сделок')  → 'сделок'
 *   pluralRu(101, ...)                          → 'сделка' (101 = 1)
 * Mirrors the standard Slavic plural-rules algorithm.
 */
function pluralRu(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n);
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/**
 * Format annualised return ("X% годовых") with an explicit projection
 * marker when the backtest period is shorter than a year.
 *
 * The CAGR calculation itself is linear: (totalPct × 365) / periodDays.
 * Fine for periods ≥ 365 — that's an actual year-over-year rate.
 * For < 365 day periods it's a PROJECTION — extrapolating a partial
 * year onto a full year. Mark it clearly so visitors don't assume
 * "this strategy made 200% last year" when in reality it ran 6 months.
 *
 *   periodDays >= 365  →  "≈49% годовых"
 *   periodDays < 365   →  "~167% годовых (прогноз по N дн)"
 *
 * Always rounds to whole percent — extra precision is false precision
 * for projections.
 */
function fmtCagr(cagrPct: number, periodDays: number): string {
  const rounded = Math.round(cagrPct);
  const sign = rounded >= 0 ? '+' : '';
  if (periodDays >= 365) {
    return `≈${sign}${rounded}% годовых`;
  }
  return `~${sign}${rounded}% годовых (прогноз по ${periodDays} дн)`;
}

// Per-trade $1000 recompute moved to ./backtest-recompute.ts (single
// source of truth used by landing, scraper, and announcement script).

// --- Inline SVG charts ---
// Hand-rolled, no external lib. Three visualisations:
//   1. Donut — win-rate (W vs L ratio)
//   2. Diverging bar — long vs short P&L contribution
//   3. Win/loss spectrum — avg/largest win and loss on a single axis

function donutChart(winPct: number, losses: number, wins: number): string {
  // SVG donut with two arcs.
  // Standard trick: stroke-dasharray on a circle, stroke-dashoffset to rotate.
  const r = 60;
  const cx = 80;
  const cy = 80;
  const circumference = 2 * Math.PI * r;
  const winArc = (winPct / 100) * circumference;
  return `
  <svg viewBox="0 0 160 160" width="160" height="160" role="img" aria-label="Win/Loss donut">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--danger)" stroke-width="22"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--accent)" stroke-width="22"
      stroke-dasharray="${winArc} ${circumference - winArc}"
      stroke-dashoffset="${circumference / 4}"
      transform="rotate(-90 ${cx} ${cy})"
      style="transition: stroke-dasharray 600ms ease;"/>
    <text x="${cx}" y="${cy - 2}" text-anchor="middle" fill="var(--text)"
      font-size="22" font-weight="600">${winPct.toFixed(1)}%</text>
    <text x="${cx}" y="${cy + 18}" text-anchor="middle" fill="var(--text-dim)"
      font-size="10" letter-spacing="0.08em">WIN RATE</text>
  </svg>
  <div class="legend">
    <span class="legend-row"><i class="dot pos"></i> Wins <b>${wins}</b></span>
    <span class="legend-row"><i class="dot neg"></i> Losses <b>${losses}</b></span>
  </div>
  `;
}

function divergingBar(
  label1: string, value1: number,
  label2: string, value2: number,
  unit: string = '%',
): string {
  const max = Math.max(Math.abs(value1), Math.abs(value2), 0.01);
  const w1 = Math.abs(value1) / max * 100;
  const w2 = Math.abs(value2) / max * 100;
  const sign1 = value1 >= 0 ? '+' : '';
  const sign2 = value2 >= 0 ? '+' : '';
  const cls1 = value1 >= 0 ? 'pos' : 'neg';
  const cls2 = value2 >= 0 ? 'pos' : 'neg';
  return `
  <div class="diverging-bar">
    <div class="bar-row">
      <span class="bar-label">${label1}</span>
      <span class="bar-track"><span class="bar-fill ${cls1}" style="width:${w1}%"></span></span>
      <span class="bar-value ${cls1}">${sign1}${value1.toFixed(2)}${unit}</span>
    </div>
    <div class="bar-row">
      <span class="bar-label">${label2}</span>
      <span class="bar-track"><span class="bar-fill ${cls2}" style="width:${w2}%"></span></span>
      <span class="bar-value ${cls2}">${sign2}${value2.toFixed(2)}${unit}</span>
    </div>
  </div>
  `;
}

/**
 * Equity curve SVG. X = trade number, Y = cumulative P&L USDT.
 * Visualises the same equity curve LuxAlgo shows at the top of their
 * Strategy Tester. Drawdowns show as dips; consistent strategies look
 * like a steady up-and-to-the-right line.
 */
function equityCurveSvg(trades: import('./backtest-recompute.js').EnrichedTrade[]): string {
  if (trades.length === 0) return '';
  const w = 720;
  const h = 200;
  const padX = 24;
  const padTop = 12;
  const padBot = 28;
  const innerW = w - 2 * padX;
  const innerH = h - padTop - padBot;
  const cumValues = trades.map((t) => t.cumulativePnlUsd);
  const yMin = Math.min(0, ...cumValues);
  const yMax = Math.max(0, ...cumValues);
  const yRange = yMax - yMin || 1;
  const xStep = innerW / Math.max(trades.length - 1, 1);
  const yZero = padTop + ((yMax - 0) / yRange) * innerH;
  // Build path
  const pts = trades.map((t, i) => {
    const x = padX + i * xStep;
    const y = padTop + ((yMax - t.cumulativePnlUsd) / yRange) * innerH;
    return { x, y };
  });
  const linePath = pts.map((p, i) => (i === 0 ? `M${p.x.toFixed(1)},${p.y.toFixed(1)}` : `L${p.x.toFixed(1)},${p.y.toFixed(1)}`)).join(' ');
  // Filled area (from zero line down to curve)
  const areaPath = `${linePath} L${pts[pts.length - 1]!.x.toFixed(1)},${yZero.toFixed(1)} L${pts[0]!.x.toFixed(1)},${yZero.toFixed(1)} Z`;
  // Y-axis tick labels (min, zero, max)
  const yTicks = [
    { v: yMax, y: padTop },
    ...(yMin < 0 ? [{ v: 0, y: yZero }] : []),
    { v: yMin, y: padTop + innerH },
  ];
  // Drawdown markers (red dots on local maxima followed by dips)
  const finalUsdRaw = cumValues[cumValues.length - 1]!;
  const finalUsdSigned = finalUsdRaw >= 0 ? '+' : '−';
  const finalUsd = Math.abs(finalUsdRaw).toFixed(0);

  return `
  <svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img"
       aria-label="Накопленная прибыль за ${trades.length} ${pluralRu(trades.length, 'сделку', 'сделки', 'сделок')} бэктеста">
    <defs>
      <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.32"/>
        <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${yMin < 0 ? `<line x1="${padX}" y1="${yZero.toFixed(1)}" x2="${(padX + innerW).toFixed(1)}" y2="${yZero.toFixed(1)}" stroke="var(--border)" stroke-dasharray="3,4"/>` : ''}
    <path d="${areaPath}" fill="url(#eqGrad)"/>
    <path d="${linePath}" fill="none" stroke="var(--accent)" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
    ${yTicks.map((t) => `<text x="${padX - 4}" y="${(t.y + 3).toFixed(1)}" font-size="10" fill="var(--text-faint)" text-anchor="end">${t.v >= 0 ? '+' : ''}${Math.round(t.v)}</text>`).join('')}
    <text x="${padX}" y="${h - 8}" font-size="10" fill="var(--text-faint)">Сделка №1</text>
    <text x="${padX + innerW}" y="${h - 8}" font-size="10" fill="var(--text-faint)" text-anchor="end">Сделка №${trades.length} · итог ${finalUsdSigned}${finalUsd} USDT</text>
  </svg>
  `;
}

/**
 * Render a trades table. Columns: # / Date / Side / Entry / Exit /
 * P&L USDT / Cum P&L. First `visibleCount` rows are shown; rest are
 * wrapped in <details> (native expand/collapse, no JS).
 */
function backtestTradesTable(
  trades: import('./backtest-recompute.js').EnrichedTrade[],
  visibleCount = 20,
): string {
  if (trades.length === 0) return '';
  // Show most recent first (reverse chronological).
  const rev = [...trades].reverse();
  const fmtDateLocal = (ts: number | null): string => {
    if (!ts) return '—';
    const d = new Date(ts);
    return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`;
  };
  const renderRow = (t: import('./backtest-recompute.js').EnrichedTrade): string => {
    const cls = t.netPnlUsd >= 0 ? 'pos' : 'neg';
    const sideCls = t.side === 'long' ? 'side-long' : 'side-short';
    return `
      <tr>
        <td>${t.num}</td>
        <td class="dt">${fmtDateLocal(t.entryAt)}</td>
        <td class="dt">${fmtDateLocal(t.exitAt)}</td>
        <td><span class="${sideCls}">${t.side.toUpperCase()}</span></td>
        <td class="right mono">${t.entryPrice.toFixed(4)}</td>
        <td class="right mono">${t.exitPrice.toFixed(4)}</td>
        <td class="right mono ${cls}">${t.netPnlUsd >= 0 ? '+' : ''}${t.netPnlUsd.toFixed(2)}</td>
      </tr>`;
  };
  const head = `
    <thead>
      <tr>
        <th>#</th>
        <th>Вход (UTC)</th>
        <th>Выход (UTC)</th>
        <th>Side</th>
        <th class="right">Entry</th>
        <th class="right">Exit</th>
        <th class="right">P&amp;L USDT</th>
      </tr>
    </thead>`;
  const first = rev.slice(0, visibleCount).map(renderRow).join('');
  const rest = rev.slice(visibleCount).map(renderRow).join('');
  const restBlock = rest
    ? `
      <details class="trades-more">
        <summary>Показать ещё ${rev.length - visibleCount} ${pluralRu(rev.length - visibleCount, 'сделку', 'сделки', 'сделок')}</summary>
        <div class="card table-wrap" style="margin-top: 12px;">
          <table>${head}<tbody>${rest}</tbody></table>
        </div>
      </details>`
    : '';
  return `
    <div class="card table-wrap">
      <table>${head}<tbody>${first}</tbody></table>
    </div>
    ${restBlock}
  `;
}

/**
 * Live trades table. Identical column structure to backtest version so
 * the visual is consistent; close-reason badge added (strategy_exit /
 * sl_hit / time_guard).
 */
function liveTradesTable(trades: LiveTradeRow[], cfg: StrategyConfig): string {
  if (trades.length === 0) return '';
  const fmtDate = (ts: number): string => {
    const d = new Date(ts);
    return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`;
  };
  const reasonLabel = (t: LiveTradeRow): { label: string; cls: string } => {
    if (t.closeReason === 'sl_hit') return { label: 'SL', cls: 'reason-sl' };
    if (t.forceCloseReason === 'strategy_exit') return { label: 'strat', cls: 'reason-strat' };
    if (t.forceCloseReason === 'time_guard') return { label: 'time', cls: 'reason-time' };
    return { label: t.closeReason ?? '—', cls: 'reason-strat' };
  };
  const rows = trades
    .map((t) => {
      const cls = t.pnlUsd >= 0 ? 'pos' : 'neg';
      const sideCls = t.side === 'long' ? 'side-long' : 'side-short';
      const r = reasonLabel(t);
      // Per-strategy counter (BNB#001, XRP#001...) — falls back to
      // global decision.id only when the row was inserted before
      // migration 012 (shouldn't happen in current data, but defensive).
      const num = t.strategyTradeNum ?? t.id;
      const tradeIdStr = formatStrategyTradeId(cfg, num);
      return `
      <tr>
        <td>${tradeIdStr}</td>
        <td class="dt">${fmtDate(t.entryAt)}</td>
        <td class="dt">${fmtDate(t.exitAt)}</td>
        <td><span class="${sideCls}">${t.side.toUpperCase()}</span></td>
        <td class="right mono">${t.entryPrice.toFixed(4)}</td>
        <td class="right mono">${t.exitPrice.toFixed(4)}</td>
        <td class="right mono ${cls}">${t.pnlUsd >= 0 ? '+' : ''}${t.pnlUsd.toFixed(2)}</td>
        <td><span class="reason-pill ${r.cls}">${r.label}</span></td>
      </tr>`;
    })
    .join('');
  return `
    <div class="card table-wrap">
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Вход (UTC)</th>
            <th>Выход (UTC)</th>
            <th>Side</th>
            <th class="right">Entry</th>
            <th class="right">Exit</th>
            <th class="right">P&amp;L USDT</th>
            <th>Exit reason</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function winLossSpectrum(avgWin: number, avgLoss: number, largestWin: number, largestLoss: number): string {
  // Single axis where the wider end shows the largest win / loss and the
  // narrower end shows the average. Visually communicates the asymmetry.
  const max = Math.max(Math.abs(avgWin), Math.abs(avgLoss), Math.abs(largestWin), Math.abs(largestLoss), 0.01);
  const pctAvgW = (avgWin / max) * 100;
  const pctAvgL = (Math.abs(avgLoss) / max) * 100;
  const pctMaxW = (largestWin / max) * 100;
  const pctMaxL = (Math.abs(largestLoss) / max) * 100;
  return `
  <div class="spectrum">
    <div class="spec-line">
      <span class="spec-col">
        <span class="spec-label">Largest loss</span>
        <span class="spec-value neg">$${largestLoss.toFixed(2)}</span>
        <span class="spec-bar neg" style="width:${pctMaxL}%"></span>
      </span>
      <span class="spec-col">
        <span class="spec-label">Avg loss</span>
        <span class="spec-value neg">$${avgLoss.toFixed(2)}</span>
        <span class="spec-bar neg" style="width:${pctAvgL}%"></span>
      </span>
    </div>
    <div class="spec-axis"></div>
    <div class="spec-line">
      <span class="spec-col">
        <span class="spec-label">Avg win</span>
        <span class="spec-value pos">+$${avgWin.toFixed(2)}</span>
        <span class="spec-bar pos" style="width:${pctAvgW}%"></span>
      </span>
      <span class="spec-col">
        <span class="spec-label">Largest win</span>
        <span class="spec-value pos">+$${largestWin.toFixed(2)}</span>
        <span class="spec-bar pos" style="width:${pctMaxW}%"></span>
      </span>
    </div>
  </div>
  `;
}

// --- Shared CSS (dark "trading dashboard" theme matching LuxAlgo aesthetic) ---
const STYLE = `
  :root {
    --bg: #0b0e13;
    --bg-card: #14181f;
    --bg-card-hover: #181d26;
    --border: #1f262f;
    --text: #e6e9ef;
    --text-dim: #8b95a7;
    --text-faint: #5e6776;
    --accent: #4ad991;
    --accent-soft: rgba(74, 217, 145, 0.12);
    --danger: #ef5b6b;
    --danger-soft: rgba(239, 91, 107, 0.12);
    --warning: #f5b14d;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, sans-serif;
    font-size: 14px;
    line-height: 1.5;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .container {
    max-width: 980px; margin: 0 auto;
    padding: clamp(20px, 4vw, 32px) clamp(14px, 4vw, 20px) clamp(48px, 8vw, 80px);
  }
  @media (max-width: 720px) {
    .stats-grid { grid-template-columns: repeat(2, 1fr) !important; }
    .portfolio-dashboard { grid-template-columns: repeat(2, 1fr) !important; }
    .charts-grid { grid-template-columns: 1fr !important; }
    table { font-size: 13px; }
    th, td { padding: 8px 10px; }
    .title { font-size: 24px; }
    .section-title { font-size: 13px; }
    .info-grid { grid-template-columns: 1fr 1fr !important; }
  }
  @media (max-width: 480px) {
    .stats-grid { grid-template-columns: 1fr !important; }
    .portfolio-dashboard { grid-template-columns: 1fr 1fr !important; }
    .dash-value { font-size: 20px !important; }
    table { font-size: 12px; }
    th, td { padding: 6px 8px; }
    .title { font-size: 22px; }
    .alert-id-value { font-size: 10px; padding: 4px 6px; }
  }
  .header { display: flex; flex-direction: column; gap: 6px; margin-bottom: 24px; }
  .strat-code {
    display: inline-block; font-family: 'SF Mono', 'Menlo', monospace;
    font-size: 12px; letter-spacing: 0.08em; color: var(--text-dim);
    background: var(--bg-card); border: 1px solid var(--border);
    padding: 4px 10px; border-radius: 4px; width: fit-content;
  }
  .title { font-size: 28px; font-weight: 600; margin: 0; letter-spacing: -0.01em; }
  .subtitle { color: var(--text-dim); font-size: 15px; margin: 0; }
  .section { margin-top: 36px; }
  .section-title {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em;
    color: var(--text-faint); margin-bottom: 14px; font-weight: 600;
  }
  .stats-grid {
    display: grid; gap: 12px;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  }
  .stat-card {
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: 10px; padding: 16px 18px;
  }
  .stat-label {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--text-faint); margin-bottom: 8px;
  }
  .stat-value { font-size: 22px; font-weight: 600; line-height: 1.1; }
  .stat-value.pos { color: var(--accent); }
  .stat-value.neg { color: var(--danger); }
  .stat-sub { font-size: 12px; color: var(--text-dim); margin-top: 4px; }
  .stat-sub.pos { color: var(--accent); }
  .stat-sub.neg { color: var(--danger); }
  table {
    width: 100%; border-collapse: collapse; font-size: 14px;
  }
  th, td {
    padding: 10px 14px; text-align: left;
    border-bottom: 1px solid var(--border);
  }
  th { color: var(--text-faint); font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; }
  td.right, th.right { text-align: right; }
  tbody tr:last-child td { border-bottom: none; }
  td .pos { color: var(--accent); }
  td .neg { color: var(--danger); }
  .card {
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: 10px; overflow: hidden;
  }
  .card-body { padding: 18px 20px; }
  .info-grid {
    display: grid; gap: 14px;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  }
  .info-item .lbl {
    font-size: 11px; text-transform: uppercase; color: var(--text-faint);
    letter-spacing: 0.08em; margin-bottom: 4px;
  }
  .info-item .val { font-size: 15px; color: var(--text); }
  .info-item code {
    font-family: 'SF Mono', 'Menlo', monospace; font-size: 13px;
    background: var(--bg); padding: 2px 6px; border-radius: 4px;
  }
  .desc { color: var(--text-dim); line-height: 1.65; }
  .pill {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 3px 10px 3px 8px; border-radius: 14px;
    font-size: 11px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .pill.live { background: var(--accent-soft); color: var(--accent); }
  .pill.shadow { background: rgba(245, 177, 77, 0.12); color: var(--warning); }
  .pill.idle { background: rgba(150, 158, 175, 0.10); color: var(--text-dim); }
  /* Slightly smaller pulse dot inside a pill */
  .pill .pulse-dot { width: 7px; height: 7px; }
  .empty-state { text-align: center; color: var(--text-dim); padding: 40px 20px; }
  .footer {
    margin-top: 60px; padding-top: 24px; border-top: 1px solid var(--border);
    color: var(--text-faint); font-size: 12px; text-align: center;
  }
  .strategy-list .card-body { padding: 0; }
  .strategy-list .row {
    display: flex; justify-content: space-between; align-items: center;
    padding: 16px 20px; border-bottom: 1px solid var(--border);
    transition: background 120ms;
  }
  .strategy-list .row:last-child { border-bottom: none; }
  .strategy-list .row:hover { background: var(--bg-card-hover); }
  .strategy-list .row .meta { display: flex; flex-direction: column; gap: 2px; }
  .strategy-list .row .name { font-weight: 500; }
  .strategy-list .row .sub { font-size: 12px; color: var(--text-dim); }
  .strategy-list .row .pnl { font-size: 16px; font-weight: 600; }

  /* Charts */
  .charts-grid {
    display: grid; gap: 16px;
    grid-template-columns: minmax(260px, 1fr) minmax(320px, 2fr);
    align-items: stretch;
  }
  @media (max-width: 720px) {
    .charts-grid { grid-template-columns: 1fr; }
  }
  .chart-card {
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: 10px; padding: 18px 20px;
    display: flex; flex-direction: column; gap: 14px;
  }
  .chart-title {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--text-faint); font-weight: 600;
  }
  .chart-card .donut-wrap {
    display: flex; gap: 18px; align-items: center;
  }
  .legend { display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
  .legend-row { display: flex; align-items: center; gap: 8px; color: var(--text-dim); }
  .legend-row b { color: var(--text); font-weight: 600; margin-left: 4px; }
  .dot {
    display: inline-block; width: 10px; height: 10px; border-radius: 50%;
  }
  .dot.pos { background: var(--accent); }
  .dot.neg { background: var(--danger); }

  /* Diverging bar */
  .diverging-bar { display: flex; flex-direction: column; gap: 10px; }
  .bar-row {
    display: grid; grid-template-columns: 60px 1fr 90px; align-items: center; gap: 12px;
  }
  .bar-label {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--text-faint); font-weight: 600;
  }
  .bar-track {
    height: 10px; background: var(--bg); border-radius: 6px; overflow: hidden;
    border: 1px solid var(--border);
  }
  .bar-fill {
    display: block; height: 100%; border-radius: 6px;
    transition: width 600ms ease;
  }
  .bar-fill.pos { background: linear-gradient(90deg, var(--accent-soft), var(--accent)); }
  .bar-fill.neg { background: linear-gradient(90deg, var(--danger-soft), var(--danger)); }
  .bar-value { font-family: 'SF Mono', 'Menlo', monospace; font-size: 13px; text-align: right; font-weight: 600; }
  .bar-value.pos { color: var(--accent); }
  .bar-value.neg { color: var(--danger); }

  /* Win/Loss spectrum */
  .spectrum { display: flex; flex-direction: column; gap: 8px; }
  .spec-line { display: flex; gap: 14px; }
  .spec-col { flex: 1; display: flex; flex-direction: column; gap: 4px; }
  .spec-label {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--text-faint);
  }
  .spec-value { font-family: 'SF Mono', 'Menlo', monospace; font-size: 14px; font-weight: 600; }
  .spec-value.pos { color: var(--accent); }
  .spec-value.neg { color: var(--danger); }
  .spec-bar { display: block; height: 6px; border-radius: 3px; transition: width 600ms ease; }
  .spec-bar.pos { background: linear-gradient(90deg, var(--accent), var(--accent-soft)); }
  .spec-bar.neg { background: linear-gradient(90deg, var(--danger), var(--danger-soft)); }
  .spec-axis { height: 1px; background: var(--border); margin: 4px 0; }

  /* Trades tables */
  .table-wrap {
    /* Horizontal scroll on narrow viewports — keeps wide tables
     * (entry/exit/dates/price columns) usable on phones without
     * crushing column widths. */
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
  .table-wrap table {
    /* Don't shrink below the natural width — force scroll instead. */
    min-width: 720px;
  }
  td.dt, th.dt { font-family: 'SF Mono', 'Menlo', monospace; font-size: 12px; color: var(--text-dim); }
  td.mono, th.mono { font-family: 'SF Mono', 'Menlo', monospace; font-size: 13px; }
  td.pos { color: var(--accent); }
  td.neg { color: var(--danger); }
  td.right, th.right { text-align: right; }
  .side-long, .side-short {
    display: inline-block; padding: 2px 8px; border-radius: 4px;
    font-size: 11px; font-weight: 600; letter-spacing: 0.04em;
  }
  .side-long { background: var(--accent-soft); color: var(--accent); }
  .side-short { background: var(--danger-soft); color: var(--danger); }
  .reason-pill {
    display: inline-block; padding: 2px 7px; border-radius: 4px;
    font-size: 10px; font-weight: 500; letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .reason-strat { background: rgba(74, 217, 145, 0.10); color: var(--accent); }
  .reason-sl    { background: rgba(239, 91, 107, 0.14); color: var(--danger); }
  .reason-time  { background: rgba(245, 177, 77, 0.12); color: var(--warning); }
  .reason-active{ background: rgba(74, 217, 145, 0.18); color: var(--accent); }

  /* ---------- Live status: pulsing dot ---------- */
  .live-status {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    text-transform: none; letter-spacing: 0;
  }
  .pulse-dot {
    display: inline-block; width: 10px; height: 10px; border-radius: 50%;
    position: relative; flex-shrink: 0;
  }
  .pulse-dot.active {
    background: var(--accent);
    box-shadow: 0 0 0 0 rgba(74, 217, 145, 0.7);
    animation: pulse-green 1.6s ease-out infinite;
  }
  .pulse-dot.waiting {
    background: var(--danger);
    box-shadow: 0 0 0 0 rgba(239, 91, 107, 0.5);
    animation: pulse-red 2.4s ease-out infinite;
  }
  /* "Idle" — strategy is enabled and watching for signal, but no
   *  position is currently open. Slow neutral pulse so the user
   *  sees the system is alive but not currently engaged. */
  .pulse-dot.idle {
    background: var(--text-faint);
    box-shadow: 0 0 0 0 rgba(150, 158, 175, 0.4);
    animation: pulse-neutral 3.2s ease-out infinite;
  }
  @keyframes pulse-neutral {
    0%   { box-shadow: 0 0 0 0 rgba(150, 158, 175, 0.4); }
    70%  { box-shadow: 0 0 0 8px rgba(150, 158, 175, 0); }
    100% { box-shadow: 0 0 0 0 rgba(150, 158, 175, 0); }
  }
  @keyframes pulse-green {
    0%   { box-shadow: 0 0 0 0 rgba(74, 217, 145, 0.7); }
    70%  { box-shadow: 0 0 0 14px rgba(74, 217, 145, 0); }
    100% { box-shadow: 0 0 0 0 rgba(74, 217, 145, 0); }
  }
  @keyframes pulse-red {
    0%   { box-shadow: 0 0 0 0 rgba(239, 91, 107, 0.5); }
    70%  { box-shadow: 0 0 0 10px rgba(239, 91, 107, 0); }
    100% { box-shadow: 0 0 0 0 rgba(239, 91, 107, 0); }
  }
  .status-label {
    font-size: 14px; font-weight: 600; color: var(--text);
    letter-spacing: -0.01em;
  }
  .refresh-note {
    font-size: 11px; color: var(--text-faint); font-weight: 400;
    margin-left: auto;
  }
  /* "обновление каждую минуту" badge — sits inline at the end of the
   *  subtitle so visitors immediately know the page isn't stale. */
  .refresh-pill {
    display: inline-flex; align-items: center; gap: 6px;
    margin-left: 10px; padding: 2px 10px 2px 8px;
    background: rgba(74, 217, 145, 0.10); color: var(--accent);
    border-radius: 12px; font-size: 11px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.05em;
    vertical-align: middle;
  }
  .refresh-pill .pulse-dot { width: 7px; height: 7px; }
  @media (max-width: 720px) {
    .refresh-pill { display: inline-flex; margin-left: 0; margin-top: 4px; }
  }
  .section-subtitle {
    font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--text-faint); margin: 12px 0 8px; font-weight: 600;
  }

  /* ---------- Disclaimer note inside backtest section ---------- */
  .disclaimer-note {
    margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border);
    font-size: 12px; color: var(--text-dim); line-height: 1.6;
  }
  .disclaimer-note b { color: var(--text); font-weight: 600; }

  /* Legacy .top-right-nav buttons removed — replaced by .site-header.
   * Keeping .nav-link as a generic ghost-button utility in case any
   * remaining markup still uses it.
   */
  a.nav-link {
    background: var(--bg-card); border: 1px solid var(--border);
    color: var(--text-dim); padding: 6px 12px; border-radius: 6px;
    font-size: 13px; text-decoration: none; transition: all 120ms;
  }
  a.nav-link:hover {
    color: var(--text); border-color: var(--accent-soft);
    background: var(--bg-card-hover); text-decoration: none;
  }
  .trades-more {
    margin-top: 12px;
  }
  .trades-more summary {
    cursor: pointer; color: var(--text-dim); font-size: 13px; padding: 10px 0;
    list-style: none; user-select: none;
  }
  .trades-more summary::-webkit-details-marker { display: none; }
  .trades-more summary::before {
    content: '▸ '; display: inline-block; transition: transform 200ms;
  }
  .trades-more[open] summary::before { content: '▾ '; }
  .trades-more summary:hover { color: var(--text); }

  /* Накопленная прибыль (equity curve) container */
  .equity-card { background: var(--bg-card); border: 1px solid var(--border);
    border-radius: 10px; padding: 14px 16px; }

  /* Alert ID card — shown right under the header */
  .alert-id-card {
    display: flex; align-items: center; flex-wrap: wrap; gap: 12px;
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: 8px; padding: 10px 14px; margin-top: 8px;
  }
  .alert-id-label {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em;
    color: var(--text-faint); font-weight: 600; flex-shrink: 0;
  }
  .alert-id-value {
    font-family: 'SF Mono', 'Menlo', monospace; font-size: 12px;
    color: var(--text); background: var(--bg); padding: 4px 8px;
    border-radius: 4px; word-break: break-all; flex: 1; min-width: 200px;
  }
  .alert-id-link {
    font-size: 12px; color: var(--accent); text-decoration: none;
    padding: 4px 10px; border: 1px solid var(--accent-soft);
    border-radius: 4px; transition: background 120ms; flex-shrink: 0;
  }
  .alert-id-link:hover {
    background: var(--accent-soft); text-decoration: none;
  }

  /* ---------- Portfolio dashboard on /strategies ---------- */
  .portfolio-dashboard {
    display: grid; gap: 12px;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    margin-bottom: 28px;
  }
  .dash-card {
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: 10px; padding: 16px 18px;
  }
  .dash-label {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--text-faint); margin-bottom: 6px; font-weight: 600;
  }
  .dash-value { font-size: 26px; font-weight: 600; line-height: 1; }
  .dash-value.pos { color: var(--accent); }
  .dash-value.neg { color: var(--danger); }
  .dash-sub { font-size: 12px; color: var(--text-dim); margin-top: 6px; }

  /* ---------- Timeframe groups ---------- */
  .tf-group { margin-bottom: 28px; }
  .tf-group-header {
    display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px;
    padding: 0 4px;
  }
  .tf-group-label {
    font-family: 'SF Mono', 'Menlo', monospace; font-size: 14px;
    font-weight: 600; color: var(--accent); letter-spacing: 0.04em;
    background: var(--accent-soft); padding: 3px 10px; border-radius: 4px;
  }
  .tf-group-count {
    font-size: 12px; color: var(--text-faint);
  }

  /* ---------- Strategy row cards ---------- */
  .strat-row-list {
    display: flex; flex-direction: column; gap: 10px;
  }
  .strat-row {
    display: block; text-decoration: none; color: inherit;
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: 10px; padding: 14px 18px;
    transition: background 120ms, border-color 120ms;
  }
  .strat-row:hover {
    background: var(--bg-card-hover); border-color: var(--text-faint);
    text-decoration: none;
  }
  .strat-row-head {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 6px; gap: 12px; flex-wrap: wrap;
  }
  .strat-row-id { display: flex; align-items: baseline; gap: 8px; }
  .strat-code-mini {
    font-family: 'SF Mono', 'Menlo', monospace; font-size: 11px;
    color: var(--text-faint); letter-spacing: 0.08em; font-weight: 600;
  }
  .strat-row-symbol {
    font-size: 17px; font-weight: 600; color: var(--text);
    letter-spacing: -0.01em;
  }
  .strat-row-tf {
    font-family: 'SF Mono', 'Menlo', monospace; font-size: 12px;
    color: var(--text-dim); padding: 2px 6px;
    background: var(--bg); border-radius: 3px;
  }
  .strat-row-desc {
    font-size: 13px; color: var(--text-dim); margin-bottom: 8px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .row-stat-line {
    display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap;
    font-size: 13px; margin-top: 4px;
  }
  .row-stat-line.dim { color: var(--text-faint); font-style: italic; }
  .stat-tag {
    font-family: 'SF Mono', 'Menlo', monospace; font-size: 10px;
    font-weight: 700; letter-spacing: 0.06em;
    color: var(--text-faint); padding: 2px 6px;
    background: var(--bg); border-radius: 3px; min-width: 36px;
    text-align: center; margin-right: 4px;
  }
  .row-stat-line .pos { color: var(--accent); }
  .row-stat-line .neg { color: var(--danger); }
  .row-stat-line .dim { color: var(--text-faint); }
  /* CAGR line — subtler than the main backtest summary, since it's
   *  derived/projected. Smaller font, dimmer color, but the value
   *  itself keeps the green/red accent. */
  .row-stat-cagr {
    font-size: 12px; color: var(--text-dim); margin-top: 2px;
  }
  .row-stat-cagr .stat-tag { background: transparent; padding: 1px 5px; }

  /* Status pills */
  .pill.running { background: var(--accent-soft); color: var(--accent); }
  .pill.paused { background: rgba(245, 177, 77, 0.12); color: var(--warning); }

  /* ---------- Site header (sticky, on every page) ---------- */
  .site-header {
    position: sticky; top: 0; z-index: 50;
    background: rgba(11, 14, 19, 0.85); backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--border);
  }
  .site-header-inner {
    max-width: 1140px; margin: 0 auto;
    display: flex; align-items: center; gap: 24px;
    padding: 12px clamp(16px, 4vw, 24px);
    height: 56px; box-sizing: border-box;
  }
  .brand {
    display: inline-flex; align-items: center; gap: 10px;
    text-decoration: none; color: var(--text); font-weight: 600;
    letter-spacing: -0.01em; flex-shrink: 0;
  }
  .brand:hover { text-decoration: none; }
  .brand-mark { width: 28px; height: 28px; flex-shrink: 0; }
  .brand-name { font-size: 15px; }
  .site-nav {
    display: flex; gap: 4px; flex: 1;
    margin-left: 12px;
  }
  .site-nav a {
    color: var(--text-dim); text-decoration: none;
    padding: 8px 14px; border-radius: 6px; font-size: 14px;
    font-weight: 500; transition: all 120ms;
  }
  .site-nav a:hover {
    color: var(--text); background: var(--bg-card); text-decoration: none;
  }
  .site-nav-end {
    display: flex; align-items: center; gap: 10px; flex-shrink: 0;
  }
  .lang-toggle {
    display: inline-flex; gap: 2px;
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: 6px; padding: 2px;
  }
  .lang-toggle a {
    color: var(--text-faint); text-decoration: none;
    padding: 4px 10px; border-radius: 4px; font-size: 11px;
    font-weight: 600; letter-spacing: 0.04em; transition: all 120ms;
  }
  .lang-toggle a:hover { color: var(--text); text-decoration: none; }
  .lang-toggle a.active {
    background: var(--accent-soft); color: var(--accent);
  }
  /* Mobile burger button — hidden on desktop, replaces the .site-nav
     on narrow viewports. Toggles the .site-nav-mobile drawer below. */
  .site-burger {
    display: none;
    width: 38px; height: 38px;
    flex-direction: column; align-items: center; justify-content: center;
    gap: 4px;
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: 8px; cursor: pointer; padding: 0;
  }
  .site-burger span {
    display: block; width: 18px; height: 2px;
    background: var(--text); border-radius: 2px;
    transition: transform 180ms, opacity 180ms;
  }
  .site-burger[aria-expanded="true"] span:nth-child(1) {
    transform: translateY(6px) rotate(45deg);
  }
  .site-burger[aria-expanded="true"] span:nth-child(2) { opacity: 0; }
  .site-burger[aria-expanded="true"] span:nth-child(3) {
    transform: translateY(-6px) rotate(-45deg);
  }
  /* Mobile drawer — full-width panel that drops below the header. */
  .site-nav-mobile {
    display: none;
    background: rgba(11, 14, 19, 0.97); backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--border);
    overflow: hidden; max-height: 0;
    transition: max-height 250ms ease;
  }
  .site-nav-mobile[aria-hidden="false"] {
    display: block; max-height: 400px;
  }
  .site-nav-mobile-inner {
    max-width: 1140px; margin: 0 auto;
    padding: 8px clamp(16px, 4vw, 24px) 16px;
    display: flex; flex-direction: column; gap: 4px;
  }
  .site-nav-mobile-inner a {
    color: var(--text-dim); text-decoration: none;
    padding: 12px 14px; border-radius: 8px; font-size: 15px;
    font-weight: 500; transition: all 120ms;
    border: 1px solid transparent;
  }
  .site-nav-mobile-inner a:hover, .site-nav-mobile-inner a:active {
    color: var(--text); background: var(--bg-card);
    border-color: var(--border); text-decoration: none;
  }
  body.nav-open { overflow: hidden; }

  /* Mobile: hide center nav, show burger */
  @media (max-width: 720px) {
    .site-header-inner { gap: 12px; }
    .site-nav { display: none; }
    .site-burger { display: inline-flex; }
    .brand-name { font-size: 14px; }
    .brand-mark { width: 24px; height: 24px; }
  }
  /* Very narrow phones: tighten further */
  @media (max-width: 380px) {
    .site-header-inner { padding: 10px 12px; height: 52px; }
    .brand-name { display: none; }
  }

  /* ---------- Home page sections ---------- */
  .hero {
    position: relative;
    padding: clamp(40px, 8vw, 64px) clamp(16px, 4vw, 32px) clamp(32px, 6vw, 48px);
    text-align: left;
    overflow: hidden; border-radius: 16px;
    margin-bottom: 16px;
  }
  .hero-content { position: relative; z-index: 2; }
  .hero-bg {
    position: absolute; inset: 0; z-index: 0;
    pointer-events: none; overflow: hidden;
  }
  /* Two ambient gradient blobs drifting slowly */
  .blob {
    position: absolute; border-radius: 50%; filter: blur(60px);
    opacity: 0.35;
  }
  .blob-1 {
    width: 360px; height: 360px;
    background: radial-gradient(circle, var(--accent), transparent 70%);
    top: -120px; right: 10%;
    animation: drift-1 18s ease-in-out infinite alternate;
  }
  .blob-2 {
    width: 280px; height: 280px;
    background: radial-gradient(circle, #5b8cff, transparent 70%);
    bottom: -80px; left: 5%;
    animation: drift-2 22s ease-in-out infinite alternate;
    opacity: 0.25;
  }
  /* Third blob — violet, drifts in a different rhythm; gives the
   *  aurora a richer 3-colour palette instead of just green + blue. */
  .blob-3 {
    width: 320px; height: 320px;
    background: radial-gradient(circle, #a06cff, transparent 70%);
    top: 30%; left: 45%;
    animation: drift-3 26s ease-in-out infinite alternate;
    opacity: 0.18;
  }
  @keyframes drift-1 {
    0%   { transform: translate(0, 0) scale(1); }
    100% { transform: translate(-40px, 30px) scale(1.1); }
  }
  @keyframes drift-2 {
    0%   { transform: translate(0, 0) scale(1); }
    100% { transform: translate(60px, -20px) scale(0.95); }
  }
  @keyframes drift-3 {
    0%   { transform: translate(-50%, -50%) scale(1); }
    100% { transform: translate(calc(-50% + 80px), calc(-50% + 40px)) scale(1.08); }
  }
  /* Cursor-following spotlight inside the hero. JS sets --sx/--sy in
   *  pixels relative to .hero on mousemove; the radial gradient is
   *  anchored at that point. Soft white tint, very low opacity — the
   *  effect should feel like the page is alive, not gimmicky. Disabled
   *  by hero[data-spotlight-armed] toggling (so SSR HTML doesn't have
   *  a stuck spotlight at 0,0 before JS runs). */
  .hero-spotlight {
    position: absolute; inset: 0; pointer-events: none;
    opacity: 0; transition: opacity 0.3s ease;
    background: radial-gradient(
      400px circle at var(--sx, 50%) var(--sy, 50%),
      rgba(255, 255, 255, 0.06),
      transparent 65%
    );
    mix-blend-mode: screen;
  }
  .hero[data-spotlight-armed] .hero-spotlight { opacity: 1; }
  /* Animated equity-curve background trace */
  .hero-equity {
    position: absolute; inset: 0; width: 100%; height: 100%;
    opacity: 0.55;
  }
  .hero-equity-line {
    stroke-dasharray: 3000;
    stroke-dashoffset: 3000;
    animation: draw-curve 3.2s cubic-bezier(0.4, 0, 0.2, 1) 0.3s forwards;
  }
  @keyframes draw-curve {
    to { stroke-dashoffset: 0; }
  }
  /* Reduce motion preference */
  @media (prefers-reduced-motion: reduce) {
    .blob, .hero-equity-line { animation: none; }
    .hero-equity-line { stroke-dashoffset: 0; }
    .reveal { opacity: 1 !important; transform: none !important; }
    .hero-spotlight { display: none; }
  }

  /* Scroll-reveal — each .home-section fades up as it enters viewport.
   * Initial state hides; JS toggles .is-visible via IntersectionObserver.
   * will-change hints the compositor (removed after animation by GC). */
  .reveal {
    opacity: 0; transform: translateY(24px);
    transition: opacity 0.7s cubic-bezier(0.4, 0, 0.2, 1),
                transform 0.7s cubic-bezier(0.4, 0, 0.2, 1);
    will-change: opacity, transform;
  }
  .reveal.is-visible {
    opacity: 1; transform: none;
  }
  /* Stagger when multiple cards reveal at once — gives a wave effect
   *  rather than every card popping in at the same instant. */
  .reveal.is-visible.stagger-1 { transition-delay: 0.08s; }
  .reveal.is-visible.stagger-2 { transition-delay: 0.16s; }
  .reveal.is-visible.stagger-3 { transition-delay: 0.24s; }

  /* Scroll-progress bar fixed to the very top of the viewport. A thin
   *  green-to-cyan gradient that grows left-to-right as the user scrolls.
   *  Visual cue that the page has depth + the user is making progress. */
  .scroll-progress {
    position: fixed; top: 0; left: 0;
    width: 0%; height: 2px; z-index: 200;
    background: linear-gradient(90deg, var(--accent), #5b8cff);
    transition: width 0.08s ease-out;
    pointer-events: none;
  }

  /* Primary CTA button — adds a smooth transform transition so the
   *  magnetic-hover JS animates instead of teleporting. Existing
   *  background/box-shadow rules remain in place elsewhere. */
  .btn-primary {
    transition: transform 0.18s cubic-bezier(0.4, 0, 0.2, 1),
                box-shadow 0.18s ease,
                background 0.18s ease;
  }
  .btn-primary:hover {
    box-shadow: 0 8px 24px -8px rgba(74, 217, 145, 0.45);
  }
  .hero-eyebrow {
    display: inline-block; font-family: 'SF Mono', 'Menlo', monospace;
    font-size: 11px; letter-spacing: 0.12em; color: var(--text-dim);
    background: var(--bg-card); border: 1px solid var(--border);
    padding: 4px 12px; border-radius: 4px; margin-bottom: 18px;
  }
  .hero-title {
    font-size: clamp(28px, 6vw, 48px);
    font-weight: 700; margin: 0 0 14px;
    letter-spacing: -0.02em; line-height: 1.05;
  }
  .hero-title .accent { color: var(--accent); }
  .hero-subtitle {
    font-size: clamp(15px, 2.2vw, 17px);
    color: var(--text-dim); margin: 0 0 28px;
    line-height: 1.55; max-width: 640px;
  }
  .hero-cta { display: flex; gap: 10px; flex-wrap: wrap; }
  @media (max-width: 480px) {
    .hero-cta { flex-direction: column; align-items: stretch; }
    .hero-cta .btn { justify-content: center; }
  }

  /* Funnel CTA — SEE → FOLLOW → AUTOMATE.
     3 stat-card-shaped boxes; the last one (autotrading) is the climactic
     CTA with accent border + primary green button. */
  .funnel-cards {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 14px; margin-top: 22px;
  }
  .funnel-card {
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: 14px; padding: 22px 22px 24px;
    display: flex; flex-direction: column; gap: 10px;
  }
  .funnel-card-title {
    font-size: 16px; font-weight: 600; color: var(--text);
  }
  .funnel-card-body {
    font-size: 13.5px; line-height: 1.55; color: var(--text-dim);
    flex: 1;
  }
  .funnel-card .btn { align-self: flex-start; }
  .funnel-card-accent {
    border-color: rgba(74, 217, 145, 0.45);
    background: linear-gradient(180deg, rgba(74,217,145,0.04) 0%, var(--bg-card) 70%);
  }
  @media (max-width: 480px) {
    .funnel-card .btn { align-self: stretch; justify-content: center; }
  }
  .btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 10px 18px; border-radius: 6px; font-size: 14px;
    font-weight: 500; text-decoration: none; cursor: pointer;
    border: 1px solid var(--border); background: var(--bg-card);
    color: var(--text); transition: all 120ms;
  }
  .btn:hover { background: var(--bg-card-hover); text-decoration: none; }
  .btn.btn-primary {
    background: var(--accent); color: var(--bg); border-color: var(--accent);
  }
  .btn.btn-primary:hover { opacity: 0.9; }
  .btn.btn-ghost { background: transparent; }
  .btn.btn-link-out {
    background: transparent; border: none; color: var(--text-dim);
    padding: 10px 12px; font-size: 13px; font-weight: 500;
  }
  .btn.btn-link-out:hover { color: var(--text); background: var(--bg-card); }

  /* Live portfolio strip */
  .live-strip {
    display: flex; gap: 24px; flex-wrap: wrap; align-items: center;
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: 10px; padding: 16px 22px; margin: 0 0 36px;
  }
  .live-strip-item { display: flex; flex-direction: column; gap: 2px; }
  .live-strip-label {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--text-faint); font-weight: 600;
  }
  .live-strip-value { font-size: 18px; font-weight: 600; }
  .live-strip-value.pos { color: var(--accent); }
  .live-strip-value.neg { color: var(--danger); }
  .live-strip-sep {
    color: var(--text-faint); font-size: 18px; user-select: none;
  }

  /* Telegram mockup cards — emulates how a Telegram channel post
   * looks on mobile. Used on the home page to show subscribers
   * what entry/close signals look like before they subscribe. */
  .tg-mockup-grid {
    display: flex; flex-direction: column; gap: 12px;
    align-items: center;
  }
  .tg-mockup {
    width: 100%; max-width: 420px;
    background: #17212b;
    border-radius: 12px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
    overflow: hidden;
    border: 1px solid #232e3c;
  }
  .tg-mockup-header {
    display: flex; gap: 10px; align-items: center;
    padding: 10px 14px;
    background: #232e3c;
    border-bottom: 1px solid #2c3a4d;
  }
  .tg-avatar {
    width: 36px; height: 36px;
    background: linear-gradient(135deg, #4ad991, #2ea968);
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 18px; flex-shrink: 0;
  }
  .tg-channel-info { flex: 1; min-width: 0; }
  .tg-channel-name {
    color: #ffffff; font-size: 14px; font-weight: 600;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .tg-channel-sub {
    color: #7d8e9e; font-size: 11px; margin-top: 1px;
  }
  .tg-mockup-body {
    padding: 14px 16px;
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
    font-size: 14px; line-height: 1.45;
    color: #ffffff;
  }
  .tg-line { min-height: 4px; }
  .tg-line code {
    background: rgba(255, 255, 255, 0.08); padding: 1px 5px;
    border-radius: 3px; font-size: 13px;
    font-family: 'SF Mono', 'Menlo', monospace;
  }
  .tg-line .tg-pos { color: #64bf60; }
  .tg-italic { color: #7d8e9e; font-style: italic; margin-top: 4px; }
  .tg-mockup-separator {
    color: var(--text-faint); font-size: 12px;
    padding: 4px 0;
    font-family: 'SF Mono', 'Menlo', monospace;
  }
  @media (max-width: 480px) {
    .tg-mockup-body { font-size: 13px; }
  }

  /* What you get — green-tinted benefit grid */
  .what-you-get {
    background: linear-gradient(135deg, rgba(74, 217, 145, 0.04), transparent 70%);
    border: 1px solid rgba(74, 217, 145, 0.18);
    border-radius: 14px;
    padding: 28px clamp(20px, 4vw, 32px) 32px;
  }
  .benefit-grid {
    display: grid; gap: 10px;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  }
  .benefit-item {
    padding: 12px 16px; font-size: 14px; color: var(--text);
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: 8px; line-height: 1.5;
  }

  /* How it works grid */
  .how-grid {
    display: grid; gap: 14px;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  }
  .how-card {
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: 10px; padding: 22px 20px;
  }
  .how-step {
    font-family: 'SF Mono', 'Menlo', monospace; font-size: 11px;
    color: var(--accent); letter-spacing: 0.1em; margin-bottom: 8px;
  }
  .how-title { font-size: 16px; font-weight: 600; margin: 0 0 8px; }
  .how-body { font-size: 13px; color: var(--text-dim); line-height: 1.55; margin: 0; }

  /* Roadmap */
  .roadmap-list { list-style: none; padding: 0; margin: 0; }
  .roadmap-item {
    display: flex; gap: 12px; padding: 12px 0;
    border-bottom: 1px solid var(--border);
  }
  .roadmap-item:last-child { border-bottom: none; }
  .roadmap-status {
    flex-shrink: 0; width: 24px; text-align: center;
  }
  .roadmap-status.done { color: var(--accent); }
  .roadmap-status.todo { color: var(--text-faint); }
  .roadmap-meta { display: flex; flex-direction: column; gap: 2px; }
  .roadmap-when {
    font-family: 'SF Mono', 'Menlo', monospace; font-size: 11px;
    color: var(--text-faint); letter-spacing: 0.06em;
  }
  .roadmap-title { font-size: 14px; color: var(--text); font-weight: 500; }

  /* FAQ */
  .faq-list { display: flex; flex-direction: column; gap: 8px; }
  .faq-item {
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: 8px; padding: 14px 18px;
  }
  .faq-item summary {
    cursor: pointer; font-size: 15px; font-weight: 500; color: var(--text);
    list-style: none; user-select: none;
  }
  .faq-item summary::-webkit-details-marker { display: none; }
  .faq-item summary::before { content: '+ '; color: var(--accent); }
  .faq-item[open] summary::before { content: '– '; }
  .faq-answer {
    margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border);
    font-size: 14px; color: var(--text-dim); line-height: 1.55;
  }
  /* renderRichText() output — bulleted cost breakdowns etc. */
  .rich-list {
    margin: 8px 0; padding-left: 20px;
    display: flex; flex-direction: column; gap: 4px;
  }
  .rich-list li { line-height: 1.5; }

  /* Strategy preview on home — compact */
  .strategy-preview-list { display: flex; flex-direction: column; gap: 8px; }
  .strategy-preview-link {
    display: flex; justify-content: space-between; align-items: center;
    padding: 12px 16px; background: var(--bg-card);
    border: 1px solid var(--border); border-radius: 8px;
    text-decoration: none; color: inherit; transition: background 120ms;
  }
  .strategy-preview-link:hover {
    background: var(--bg-card-hover); text-decoration: none;
  }
  .strategy-preview-left { flex: 1; min-width: 0; }
  .strategy-preview-name { font-weight: 500; }
  .strategy-preview-meta { font-size: 12px; color: var(--text-dim); margin-top: 2px; }
  .strategy-preview-right { text-align: right; flex-shrink: 0; }
  .strategy-preview-spark {
    display: flex; align-items: center; flex-shrink: 0;
    padding: 0 12px; opacity: 0.85;
  }
  @media (max-width: 480px) {
    .strategy-preview-spark { display: none; }
  }
  .sparkline {
    /* stroke="currentColor" picks up this color */
    color: var(--accent);
  }
  .sparkline.neg { color: var(--danger); }

  /* Section spacing on home */
  .home-section { margin: 56px 0 0; }

  /* ---------- Live "Working right now" section ----------
   * Renders one card per currently-open Track C position. Server SSR
   * provides initial state from getActivePositionsCached() (8s TTL),
   * client polls /api/active-positions every 10s and patches DOM
   * in-place. data-* hooks tell the JS which nodes to update.
   *
   * Visual hierarchy: brighter than surrounding sections (this is the
   * "alive money" moment), but still calm — green glow on pulse dot,
   * accent border on card, mono-font prices for that trading-terminal
   * vibe. */
  .live-pos-section { margin: 32px 0 0; }
  .live-pos-section[data-empty="true"] { display: none; }
  .live-pos-header {
    display: flex; align-items: center; gap: 10px;
    margin-bottom: 16px;
  }
  .live-pos-pulse {
    display: inline-block; width: 10px; height: 10px;
    border-radius: 50%; background: var(--accent);
    box-shadow: 0 0 0 0 rgba(74, 217, 145, 0.7);
    animation: pulse-green 1.6s ease-out infinite;
  }
  .live-pos-title {
    font-size: 22px; font-weight: 600; margin: 0;
    letter-spacing: -0.01em;
  }
  .live-pos-count {
    margin-left: 4px; padding: 2px 10px; border-radius: 12px;
    background: rgba(74, 217, 145, 0.10); color: var(--accent);
    font-size: 11px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .live-pos-grid {
    display: grid; gap: 12px;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  }
  .live-pos-card {
    background: var(--bg-card);
    border: 1px solid rgba(74, 217, 145, 0.18);
    border-radius: 12px; padding: 16px;
    position: relative; overflow: hidden;
  }
  .live-pos-card::before {
    content: ''; position: absolute; inset: 0;
    background: radial-gradient(
      400px circle at 100% 0%,
      rgba(74, 217, 145, 0.06),
      transparent 60%
    );
    pointer-events: none;
  }
  .live-pos-head {
    display: flex; justify-content: space-between; align-items: baseline;
    gap: 8px; margin-bottom: 12px;
  }
  .live-pos-id { font-size: 14px; }
  .live-pos-id b { font-family: 'SF Mono', 'Menlo', monospace; }
  .live-pos-side { font-size: 12px; color: var(--text-dim); }
  .live-pos-side .side-long { color: var(--accent); font-weight: 600; }
  .live-pos-side .side-short { color: var(--danger); font-weight: 600; }
  .live-pos-prices {
    display: flex; flex-direction: column; gap: 4px;
    margin-bottom: 12px;
  }
  .live-pos-price-row {
    display: flex; align-items: center; gap: 8px;
    font-size: 13px;
  }
  .live-pos-label {
    color: var(--text-dim); width: 64px; flex-shrink: 0;
  }
  .live-pos-val.mono {
    font-family: 'SF Mono', 'Menlo', monospace;
    color: var(--text);
  }
  .live-pos-arrow {
    font-weight: 700; font-size: 14px;
    /* Smooth fade when value flips */
    transition: color 0.3s ease;
  }
  .live-pos-arrow.pos { color: var(--accent); }
  .live-pos-arrow.neg { color: var(--danger); }
  .live-pos-meta {
    color: var(--text-faint); font-size: 11px;
  }
  /* Big PnL line — the eye-catcher of the card. */
  .live-pos-pnl {
    display: flex; align-items: baseline; gap: 12px;
    padding: 12px 14px; border-radius: 8px;
    margin-bottom: 10px;
    transition: background 0.4s ease;
  }
  .live-pos-pnl.pos {
    background: rgba(74, 217, 145, 0.10);
    color: var(--accent);
  }
  .live-pos-pnl.neg {
    background: rgba(239, 91, 107, 0.10);
    color: var(--danger);
  }
  .live-pos-pnl-usd {
    font-size: 22px; font-weight: 700;
    letter-spacing: -0.01em;
    font-variant-numeric: tabular-nums;
  }
  .live-pos-pnl-pct, .live-pos-pnl-r {
    font-size: 13px; font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  /* Brief flash on value change — JS toggles .is-flashing for 600ms */
  .live-pos-pnl.is-flashing { animation: pnl-flash 0.6s ease-out; }
  @keyframes pnl-flash {
    0%   { transform: scale(1); }
    50%  { transform: scale(1.02); }
    100% { transform: scale(1); }
  }
  .live-pos-foot {
    display: flex; justify-content: space-between; align-items: center;
    font-size: 12px; color: var(--text-dim);
  }
  .live-pos-link {
    color: var(--accent); text-decoration: none; font-weight: 500;
  }
  .live-pos-link:hover { text-decoration: underline; }

  /* ---------- Compact table layout (4+ positions) ----------
   * Activated when activePositions.length >= 4. Each position becomes
   * a single 32-44px row instead of a ~280px card — 5 positions fit
   * in ~250px instead of 1400px on mobile. Same data-* hooks so the
   * polling JS patches both layouts uniformly. */
  .live-pos-table {
    background: var(--bg-card);
    border: 1px solid rgba(74, 217, 145, 0.18);
    border-radius: 12px;
    overflow: hidden;
  }
  .live-pos-row {
    display: grid;
    grid-template-columns: 110px 70px 1fr 130px 80px 70px;
    gap: 12px;
    align-items: center;
    padding: 10px 16px;
    border-top: 1px solid var(--border);
    font-size: 13px;
    color: var(--text);
    text-decoration: none;
    transition: background 0.15s ease;
  }
  .live-pos-row:first-child { border-top: none; }
  a.live-pos-row:hover { background: var(--bg-card-hover); }
  .live-pos-row-head {
    color: var(--text-faint);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 8px 16px;
    background: rgba(255, 255, 255, 0.02);
  }
  .live-pos-row-id b { font-family: 'SF Mono', 'Menlo', monospace; }
  .live-pos-row-side.side-long  { color: var(--accent); font-weight: 600; }
  .live-pos-row-side.side-short { color: var(--danger); font-weight: 600; }
  .live-pos-row-price.mono {
    font-family: 'SF Mono', 'Menlo', monospace;
    display: inline-flex; align-items: center; gap: 6px;
  }
  .live-pos-row-pnl {
    display: inline-flex; flex-direction: column; gap: 1px;
    padding: 4px 8px; border-radius: 6px;
    font-variant-numeric: tabular-nums; font-weight: 600;
    transition: background 0.4s ease;
  }
  .live-pos-row-pnl.pos { background: rgba(74, 217, 145, 0.10); color: var(--accent); }
  .live-pos-row-pnl.neg { background: rgba(239, 91, 107, 0.10); color: var(--danger); }
  .live-pos-row-pct {
    font-size: 11px; font-weight: 500; opacity: 0.9;
  }
  .live-pos-row-pnl.is-flashing { animation: pnl-flash 0.6s ease-out; }
  .live-pos-row-age, .live-pos-row-pnl-r {
    color: var(--text-dim); font-variant-numeric: tabular-nums;
  }
  /* Mobile: collapse some columns by stacking into 2 lines per row.
   * At <640px, hide R-multiple and age columns; PnL goes inline with
   * price. This keeps the rows ~50px each on mobile too. */
  @media (max-width: 640px) {
    .live-pos-row {
      grid-template-columns: 1fr 70px 1fr;
      grid-template-rows: auto auto;
      row-gap: 4px;
    }
    .live-pos-row-id { grid-column: 1 / -1; }
    .live-pos-row-pnl-r, .live-pos-row-age { display: none; }
    .live-pos-row-head { display: none; }
  }

  @media (prefers-reduced-motion: reduce) {
    .live-pos-pulse { animation: none; }
    .live-pos-pnl.is-flashing,
    .live-pos-row-pnl.is-flashing { animation: none; }
  }

  .home-section-title {
    font-size: 22px; font-weight: 600; margin: 0 0 18px;
    letter-spacing: -0.01em;
  }
  .home-section-sub {
    font-size: 14px; color: var(--text-dim); margin: -10px 0 22px;
    max-width: 600px; line-height: 1.55;
  }
`;

/** Reusable page shell. Exported so the home-page route can reuse the
 *  exact same CSS / theme. The optional `lang` param swaps the
 *  `<html lang>` attribute and the footer copy; defaults to RU.
 *  `topRight` is rendered as a tiny element absolutely-positioned in
 *  the header (e.g. language toggle on the home page). */
export type PageShellOpts = {
  lang?: 'ru' | 'en';
  /** Show RU/EN language toggle in the header. Only the home page is
   *  bilingual today — set true there. */
  showLangToggle?: boolean;
  /** Hard meta-refresh interval (seconds) for stats pages so the live
   *  table updates without manual reload. */
  autoRefreshSec?: number | null;
  /** Robots meta. Defaults to index,follow. Gated stats pages set noindex. */
  robots?: string;
  /** @deprecated The floating 💬 icon was removed entirely in May 2026.
   *  This flag is kept for back-compat with cabinet callers and is a no-op. */
  hideMobileHelpIcon?: boolean;
};

export function pageShell(
  title: string,
  body: string,
  opts: PageShellOpts = {},
): string {
  const lang: 'ru' | 'en' = opts.lang ?? 'ru';
  const showLangToggle = opts.showLangToggle ?? false;
  const autoRefreshSec = opts.autoRefreshSec ?? null;
  const robots = opts.robots ?? 'index, follow';
  // Footer: keep ONLY the legal disclaimer here. The refresh indicator
  // moved into the header subtitle as a more prominent pill — the
  // technical-cache wording ("Кэш: 60 сек") was confusing to visitors.
  const footerText =
    lang === 'en'
      ? '⚠ Past performance does not guarantee future returns. Backtest results are a model — live trading carries additional execution risk.'
      : '⚠ Прошлые результаты не гарантируют будущих. Бэктест — это модель; в живой торговле возможна дополнительная погрешность исполнения.';
  // Detail pages set autoRefreshSec so the live-trades table reflects new
  // closed positions without the visitor manually reloading. Server-side
  // render is cheap; cache-control still caps the actual fetch rate.
  const metaRefresh = autoRefreshSec !== null
    ? `<meta http-equiv="refresh" content="${autoRefreshSec}" />`
    : '';
  // Inline SVG favicon — green equity-curve going up on a dark rounded
  // square. Echoes the hero-curve animation visual. Data-URI form so
  // there's no extra HTTP request + works on every page from a single
  // declaration. Apple touch icon points to the same SVG (iOS 16.4+
  // supports it natively).
  const faviconSvg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>` +
    `<rect width='64' height='64' rx='14' fill='%230b0e13'/>` +
    `<path d='M8 48 L18 42 L26 44 L36 30 L46 32 L56 14' fill='none' ` +
    `stroke='%234ad991' stroke-width='4' stroke-linecap='round' stroke-linejoin='round'/>` +
    `<circle cx='56' cy='14' r='4' fill='%234ad991'/>` +
    `</svg>`;
  const faviconLink =
    `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${faviconSvg}"/>` +
    `<link rel="apple-touch-icon" href="data:image/svg+xml,${faviconSvg}"/>`;

  // Yandex.Metrika counter 109255043 — clickmap + webvisor + accurate
  // bounce + outbound-link tracking. Loaded async via injected script
  // tag (the standard m,e,t,r,i,k,a pattern). Noscript fallback below
  // for non-JS visitors. Single counter across home, /strategies,
  // detail pages and /admin.
  const metrikaScript = `
<script type="text/javascript">
   (function(m,e,t,r,i,k,a){m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};
   m[i].l=1*new Date();
   for (var j = 0; j < document.scripts.length; j++) {if (document.scripts[j].src === r) { return; }}
   k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)})
   (window, document,'script','https://mc.yandex.ru/metrika/tag.js?id=109255043', 'ym');

   ym(109255043, 'init', {webvisor:true, clickmap:true, referrer: document.referrer, url: location.href, accurateTrackBounce:true, trackLinks:true});
</script>
<noscript><div><img src="https://mc.yandex.ru/watch/109255043" style="position:absolute; left:-9999px;" alt="" /></div></noscript>`;

  // ---------- Site header (sticky, on every page) ----------
  // Layout:
  //   Brand-mark (logo + name)  | center nav links | right group (lang)
  // Mobile (<720px): center nav collapses behind a hamburger button that
  //   opens a full-width drawer with the same links.
  //
  // The floating 💬 help icon was removed entirely (operator dislike) —
  // «Поддержка» / «Support» is reachable via the nav link instead.
  const langToggleHtml = showLangToggle
    ? `<a href="/" class="${lang === 'ru' ? 'active' : ''}" aria-label="Русский">RU</a>` +
      `<a href="/en" class="${lang === 'en' ? 'active' : ''}" aria-label="English">EN</a>`
    : '';
  const labels = lang === 'en'
    ? { strategies: 'Strategies', autotrading: 'Auto-trading', channel: 'Channel', support: 'Support', menu: 'Menu', close: 'Close' }
    : { strategies: 'Стратегии', autotrading: 'Автотрейдинг', channel: 'Канал', support: 'Поддержка', menu: 'Меню', close: 'Закрыть' };

  const navLinksHtml = `
      <a href="/strategies">${labels.strategies}</a>
      <a href="/autotrading">${labels.autotrading}</a>
      <a href="https://t.me/luxalgosignal" target="_blank" rel="noopener">${labels.channel}</a>
      <a href="https://t.me/dboykod" target="_blank" rel="noopener">${labels.support}</a>
  `;

  const siteHeader = `
<header class="site-header">
  <div class="site-header-inner">
    <a class="brand" href="/" aria-label="Robot Claude">
      <svg class="brand-mark" viewBox="0 0 64 64" aria-hidden="true">
        <rect width="64" height="64" rx="14" fill="#0b0e13"/>
        <path d="M8 48 L18 42 L26 44 L36 30 L46 32 L56 14" fill="none"
              stroke="#4ad991" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="56" cy="14" r="5" fill="#4ad991"/>
      </svg>
      <span class="brand-name">Robot&nbsp;Claude</span>
    </a>
    <nav class="site-nav" aria-label="Primary">${navLinksHtml}</nav>
    <div class="site-nav-end">
      ${langToggleHtml ? `<div class="lang-toggle">${langToggleHtml}</div>` : ''}
      <button class="site-burger" type="button" aria-label="${labels.menu}" aria-expanded="false" aria-controls="site-nav-mobile">
        <span></span><span></span><span></span>
      </button>
    </div>
  </div>
  <div class="site-nav-mobile" id="site-nav-mobile" aria-hidden="true">
    <nav class="site-nav-mobile-inner" aria-label="Primary mobile">${navLinksHtml}</nav>
  </div>
</header>
<script>
  (function() {
    var btn = document.querySelector('.site-burger');
    var drawer = document.getElementById('site-nav-mobile');
    if (!btn || !drawer) return;
    function close() {
      btn.setAttribute('aria-expanded', 'false');
      drawer.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('nav-open');
    }
    btn.addEventListener('click', function() {
      var open = btn.getAttribute('aria-expanded') === 'true';
      if (open) { close(); return; }
      btn.setAttribute('aria-expanded', 'true');
      drawer.setAttribute('aria-hidden', 'false');
      document.body.classList.add('nav-open');
    });
    drawer.addEventListener('click', function(e) {
      if (e.target.tagName === 'A') close();
    });
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') close();
    });
  })();
</script>
`;

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="${robots}" />
${metaRefresh}
<title>${escapeHtml(title)}</title>
${faviconLink}
<style>${STYLE}</style>
${metrikaScript}
</head>
<body>
${siteHeader}
<div class="container">
${body}
<div class="footer">
  ${footerText}
</div>
</div>
${countUpScript()}
</body>
</html>`;
}

/** Inline script that animates any element with [data-count] from 0 to
 *  its target value when it enters the viewport. Attributes:
 *    data-count       — target number (required)
 *    data-decimals    — fraction digits (default 0)
 *    data-prefix      — prefix string (e.g. "$")
 *    data-suffix      — suffix string (e.g. "%")
 *    data-signed      — if "true", always show "+" or "−" for the sign
 *  Bails out on prefers-reduced-motion or no IntersectionObserver. */
function countUpScript(): string {
  return `<script>
(function() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!('IntersectionObserver' in window)) return;
  function ease(t) { return 1 - Math.pow(1 - t, 3); }
  function fmt(el, v) {
    var dec = parseInt(el.getAttribute('data-decimals') || '0', 10);
    var prefix = el.getAttribute('data-prefix') || '';
    var suffix = el.getAttribute('data-suffix') || '';
    var signed = el.getAttribute('data-signed') === 'true';
    var sign = '';
    var abs = v;
    if (signed) {
      sign = v >= 0 ? '+' : '−';
      abs = Math.abs(v);
    }
    return sign + prefix + abs.toFixed(dec) + suffix;
  }
  function run(el) {
    var target = parseFloat(el.getAttribute('data-count') || '0');
    if (isNaN(target)) return;
    var dur = 1100;
    var start = performance.now();
    function step(now) {
      var t = Math.min(1, (now - start) / dur);
      var v = target * ease(t);
      el.textContent = fmt(el, v);
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
  var io = new IntersectionObserver(function(entries) {
    entries.forEach(function(en) {
      if (en.isIntersecting) {
        run(en.target);
        io.unobserve(en.target);
      }
    });
  }, { threshold: 0.4 });
  document.querySelectorAll('[data-count]').forEach(function(el) {
    io.observe(el);
  });
})();
</script>`;
}

/** Sort key for timeframes — keeps "5m, 15m, 1H, 4H, 1D" semantic order
 *  rather than alphabetical. Maps string TF to minutes for comparison. */
function tfMinutes(tf: string): number {
  const t = tf.trim().toLowerCase();
  // Bare numbers = minutes (TradingView convention: "15" = 15 min, "240" = 4h)
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  if (/^\d+m$/.test(t)) return parseInt(t, 10);
  if (/^\d+h$/.test(t)) return parseInt(t, 10) * 60;
  if (t === 'd' || t === '1d' || t === 'day') return 1440;
  if (t === 'w' || t === '1w' || t === 'week') return 10080;
  return parseInt(t, 10) || 0;
}

function tfLabel(tf: string): string {
  const m = tfMinutes(tf);
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${m / 60}H`;
  if (m < 10080) return `${m / 1440}D`;
  return `${m / 10080}W`;
}

function renderStrategyIndex(strategies: StrategyConfig[]): string {
  // ---------- Portfolio aggregate ----------
  let totalClosed = 0;
  let totalOpen = 0;
  let totalWins = 0;
  let totalLosses = 0;
  let totalPnlUsd = 0;
  let runningCount = 0;
  const openStrategyLabels: string[] = []; // e.g. ["BNB LONG", "XRP SHORT"]

  const enriched = strategies.map((s) => {
    const live = getStrategyLiveStats(s.id);
    totalClosed += live.closed;
    totalOpen += live.open;
    totalWins += live.wins;
    totalLosses += live.losses;
    totalPnlUsd += live.netPnlUsd;
    if (s.enabled) runningCount++;
    // Collect labels for currently-open positions so the dashboard
    // can list WHICH strategies are open ("STRAT-001 BNBUSDT") rather
    // than just the count.
    if (live.open > 0) {
      const active = getStrategyActiveTrades(s.id);
      for (const t of active) {
        const sideStr = t.side === 'long' ? 'LONG' : 'SHORT';
        openStrategyLabels.push(`${s.symbol ?? s.id} ${sideStr}`);
      }
    }
    return { s, live };
  });
  const portfolioCls = classForValue(totalPnlUsd);
  const portfolioPnlPct = totalClosed > 0
    ? (totalPnlUsd / TRACK_C_NOTIONAL_USD)  // pct of single-trade notional
    : 0;
  void portfolioPnlPct;

  // ---------- Group by timeframe ----------
  const groups = new Map<number, Array<typeof enriched[number]>>();
  for (const e of enriched) {
    const m = tfMinutes(e.s.timeframe);
    if (!groups.has(m)) groups.set(m, []);
    groups.get(m)!.push(e);
  }
  const sortedTfs = [...groups.keys()].sort((a, b) => a - b);

  // ---------- Single strategy row renderer ----------
  const renderRow = (e: typeof enriched[number]): string => {
    const { s, live } = e;
    // Prefer recomputed-from-trades-log stats (same source as detail page)
    // over the static config snapshot. Falls back to snapshot if no log.
    let b: BacktestSnapshot | import('./backtest-recompute.js').RecomputedStats | undefined = s.backtest;
    const bundle = loadBacktestTrades(s.id);
    if (s.backtest && bundle && bundle.trades.length > 0) {
      b = recomputeBacktestStats(bundle.trades, {
        periodLabel: s.backtest.periodLabel,
        periodDays: s.backtest.periodDays,
      });
    }
    const livePnlCls = classForValue(live.netPnlUsd);
    const bgClass = classForValue(b?.netPnlUsd ?? 0);
    // Each strategy row gets exactly ONE status pill so the user can
    // tell at a glance what's happening with it right now:
    //   ⏸ Пауза            — disabled in config
    //   🟢 В работе         — at least one position currently open
    //   ⏳ Ждём сигнал      — enabled but no open position (default state
    //                          between signals); previously the row was
    //                          empty here which made XRPUSDT look broken
    const statusPill = !s.enabled
      ? '<span class="pill paused">⏸ Пауза</span>'
      : live.open > 0
      ? `<span class="pill live"><span class="pulse-dot active" aria-hidden="true"></span> В работе</span>`
      : `<span class="pill idle"><span class="pulse-dot idle" aria-hidden="true"></span> Ждём сигнал</span>`;

    // Backtest row — human-readable Russian, no abbreviations.
    // CAGR adds the "годовая доходность" annualised projection on a
    // separate line below so the eye reads total → annual → context
    // in a natural cascade.
    const btRow = b
      ? `<div class="row-stat-line">
          <span class="stat-tag">БЭКТЕСТ</span>
          <span class="${bgClass}"><b>${fmtPct(b.netPnlPct, true)}</b> доходность</span>
          <span class="dim">·</span>
          <span class="dim">${(b.winRate * 100).toFixed(0)}% побед</span>
          <span class="dim">·</span>
          <span class="dim">${b.totalTrades} ${pluralRu(b.totalTrades, 'сделка', 'сделки', 'сделок')} за ${b.periodDays} ${pluralRu(b.periodDays, 'день', 'дня', 'дней')}</span>
        </div>
        <div class="row-stat-line row-stat-cagr">
          <span class="stat-tag">ГОДОВЫХ</span>
          <span class="${classForValue(b.cagrPct)}"><b>${fmtCagr(b.cagrPct, b.periodDays)}</b></span>
        </div>`
      : '';

    // LIVE row — only when there's something to show
    const liveRow =
      live.closed > 0
        ? `<div class="row-stat-line">
            <span class="stat-tag">LIVE</span>
            <span class="${livePnlCls}"><b>${fmtUsd(live.netPnlUsd, true)}</b></span>
            <span class="dim">·</span>
            <span class="${livePnlCls}">${fmtPct(live.netPnlPct, true)}</span>
            <span class="dim">·</span>
            <span class="dim">${live.wins} прибыльных / ${live.losses} убыточных</span>
          </div>`
        : '';

    return `
      <a href="/strategies/${escapeHtml(s.code)}" class="strat-row">
        <div class="strat-row-head">
          <div class="strat-row-id">
            <span class="strat-code-mini">STRAT-${escapeHtml(s.code)}</span>
            <span class="strat-row-symbol">${escapeHtml(s.symbol ?? 'ANY')}</span>
            <span class="strat-row-tf">${escapeHtml(tfLabel(s.timeframe))}</span>
          </div>
          ${statusPill}
        </div>
        <div class="strat-row-desc">${escapeHtml(s.name ?? s.description.split('|')[0]?.trim() ?? s.id)}</div>
        ${btRow}
        ${liveRow}
      </a>`;
  };

  // ---------- Group sections ----------
  const groupsHtml = sortedTfs
    .map((tf) => {
      const rows = groups.get(tf)!;
      // Sort within group: by Live P&L desc, then by launch date desc
      rows.sort((a, b) => {
        if (b.live.netPnlUsd !== a.live.netPnlUsd) {
          return b.live.netPnlUsd - a.live.netPnlUsd;
        }
        return b.s.launchedAt - a.s.launchedAt;
      });
      return `
        <div class="tf-group">
          <div class="tf-group-header">
            <span class="tf-group-label">${tfLabel(String(tf))}</span>
            <span class="tf-group-count">${rows.length} ${pluralRu(rows.length, 'стратегия', 'стратегии', 'стратегий')}</span>
          </div>
          <div class="strat-row-list">
            ${rows.map(renderRow).join('\n')}
          </div>
        </div>`;
    })
    .join('\n');

  const empty =
    strategies.length === 0
      ? '<div class="empty-state">Активных стратегий пока нет.</div>'
      : '';

  // ---------- Dashboard cards ----------
  // Reworked to be informative BOTH before first closed trade and after.
  // Pre-first-close (the current state): cells say "появится после
  // первого закрытия" rather than a meaningless 0 or em-dash. Once
  // closed trades accumulate, the same cells fill with real numbers.
  //
  // The "Win Rate" card was removed — each strategy's win rate is
  // already in its row, and a single portfolio-level WR is misleading
  // when one strategy carries the other (Simpson's paradox).
  const hasLiveData = totalClosed > 0;
  const openSub = totalOpen === 0
    ? 'нет активных позиций'
    : openStrategyLabels.length <= 2
      ? openStrategyLabels.join(' · ')
      : `${openStrategyLabels.length} позиций`;
  const closedSub = hasLiveData
    ? `<span class="${classForValue(totalWins - totalLosses)}">${totalWins} ✓ / ${totalLosses} ✗</span>`
    : 'появятся после первого закрытия';
  const pnlValue = hasLiveData ? fmtUsd(totalPnlUsd, true) : '—';
  const pnlSub = hasLiveData
    ? `${TRACK_C_NOTIONAL_USD} USDT на сделку`
    : 'появится после первого закрытия';
  const stratPlural = runningCount === 1 ? 'активна' : runningCount < 5 ? 'активны' : 'активны';

  const portfolioDashboard = strategies.length > 0
    ? `
    <div class="portfolio-dashboard">
      <div class="dash-card">
        <div class="dash-label">Стратегии</div>
        <div class="dash-value" data-count="${strategies.length}" data-decimals="0">${strategies.length}</div>
        <div class="dash-sub">${runningCount === strategies.length ? `все ${stratPlural}` : `${runningCount} ${stratPlural}`}</div>
      </div>
      <div class="dash-card">
        <div class="dash-label">Сейчас открыто</div>
        <div class="dash-value ${totalOpen > 0 ? 'pos' : ''}" data-count="${totalOpen}" data-decimals="0">${totalOpen}</div>
        <div class="dash-sub">${openSub}</div>
      </div>
      <div class="dash-card">
        <div class="dash-label">Закрытых сделок</div>
        <div class="dash-value" data-count="${totalClosed}" data-decimals="0">${totalClosed}</div>
        <div class="dash-sub">${closedSub}</div>
      </div>
      <div class="dash-card">
        <div class="dash-label">Live прибыль</div>
        <div class="dash-value ${hasLiveData ? portfolioCls : ''}"${hasLiveData ? ` data-count="${totalPnlUsd}" data-decimals="2" data-prefix="$" data-signed="true"` : ''}>${pnlValue}</div>
        <div class="dash-sub">${pnlSub}</div>
      </div>
    </div>
    `
    : '';

  return pageShell(
    'Strategies',
    `
    <div class="header">
      <span class="strat-code">ROBOT CLAUDE</span>
      <h1 class="title">Активные стратегии</h1>
      <p class="subtitle">
        Автоматическая торговля по стратегиям LuxAlgo AI Strategy Builder в режиме shadow ·
        по ${TRACK_C_NOTIONAL_USD} USDT на сделку
        <span class="refresh-pill" aria-label="Страница обновляется каждую минуту">
          <span class="pulse-dot active" aria-hidden="true"></span>
          обновление каждую минуту
        </span>
      </p>
    </div>

    ${portfolioDashboard}

    ${groupsHtml}
    ${empty}
    `,
    { autoRefreshSec: 60 },
  );
}

function renderBacktestSection(snap: BacktestSnapshot, strategyId: string, cfg?: StrategyConfig): string {
  const bundle = loadBacktestTrades(strategyId);
  // SINGLE SOURCE OF TRUTH: recompute ALL stats from the raw trades log
  // on $1000 notional minus commission. The static `backtest` snapshot in
  // track-c-config.ts is now only used as a FALLBACK when the trades log
  // is missing — and for period metadata (label, days).
  let b: BacktestSnapshot | RecomputedStats;
  let trades: ReturnType<typeof enrichTrades> = [];
  if (bundle && bundle.trades.length > 0) {
    b = recomputeBacktestStats(bundle.trades, {
      periodLabel: snap.periodLabel,
      periodDays: snap.periodDays,
    });
    trades = enrichTrades(bundle.trades);
  } else {
    b = snap;
  }
  const pnlClass = classForValue(b.netPnlPct);
  const longClass = classForValue(b.longPnlPct);
  const shortClass = classForValue(b.shortPnlPct);
  const totalInStrategy = bundle?.totalTradesInStrategy ?? trades.length;
  const wasCapped = bundle?.capped ?? false;
  const equityLabel = wasCapped
    ? `последние ${trades.length} из ${totalInStrategy} ${pluralRu(totalInStrategy, 'сделки', 'сделок', 'сделок')}`
    : `${trades.length} ${pluralRu(trades.length, 'сделка', 'сделки', 'сделок')}`;

  return `
  <div class="section">
    <div class="section-title">Бэктест · ${escapeHtml(b.periodLabel)} (${b.periodDays} дней)</div>

    ${trades.length > 0 ? `
    <div class="equity-card" style="margin-bottom: 16px;">
      <div class="chart-title" style="margin-bottom: 8px;">Накопленная прибыль · ${equityLabel}</div>
      ${equityCurveSvg(trades)}
    </div>
    ` : ''}

    <div class="charts-grid" style="margin-bottom: 16px;">
      <div class="chart-card">
        <div class="chart-title">Win / Loss ratio</div>
        <div class="donut-wrap">
          ${donutChart(b.winRate * 100, b.losses, b.wins)}
        </div>
      </div>
      <div class="chart-card">
        <div class="chart-title">Long vs Short P&L contribution</div>
        ${divergingBar('LONG', b.longPnlPct, 'SHORT', b.shortPnlPct)}
        <div class="chart-title" style="margin-top: 8px;">Avg vs largest (USDT)</div>
        ${winLossSpectrum(b.avgWinUsd, b.avgLossUsd, b.largestWinUsd, b.largestLossUsd)}
      </div>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Net P&L</div>
        <div class="stat-value ${pnlClass}" data-count="${b.netPnlPct}" data-decimals="2" data-suffix="%" data-signed="true">${fmtPct(b.netPnlPct, true)}</div>
        <div class="stat-sub ${pnlClass}">${fmtUsd(b.netPnlUsd, true)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Win Rate</div>
        <div class="stat-value" data-count="${(b.winRate * 100).toFixed(2)}" data-decimals="2" data-suffix="%">${(b.winRate * 100).toFixed(2)}%</div>
        <div class="stat-sub">${b.wins}W / ${b.losses}L · ${b.totalTrades} trades</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Profit Factor</div>
        <div class="stat-value" data-count="${b.profitFactor.toFixed(2)}" data-decimals="2">${b.profitFactor.toFixed(2)}</div>
        <div class="stat-sub">gross profit / gross loss</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Max Drawdown</div>
        <div class="stat-value neg" data-count="${b.maxDrawdownPct.toFixed(2)}" data-decimals="2" data-suffix="%">${b.maxDrawdownPct.toFixed(2)}%</div>
        <div class="stat-sub neg">${fmtUsd(-b.maxDrawdownUsd)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Годовая доходность</div>
        <div class="stat-value ${classForValue(b.cagrPct)}">${b.periodDays >= 365 ? '≈' : '~'}${b.cagrPct >= 0 ? '+' : ''}${Math.round(b.cagrPct)}%</div>
        <div class="stat-sub">${b.periodDays >= 365 ? `годовых · за ${(b.periodDays / 365).toFixed(1)} года` : `годовых · прогноз по ${b.periodDays} ${pluralRu(b.periodDays, 'дню', 'дням', 'дням')}`}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Commission Paid</div>
        <div class="stat-value" data-count="${b.commissionPaidUsd.toFixed(2)}" data-decimals="2" data-prefix="$">${fmtUsd(b.commissionPaidUsd)}</div>
        <div class="stat-sub">${(b.commissionPctPerSide * 100 * 2).toFixed(3)}% round-trip</div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Breakdown</div>
      <div class="card">
        <table>
          <thead>
            <tr><th>Метрика</th><th class="right">All</th><th class="right">Long</th><th class="right">Short</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>Trades</td>
              <td class="right">${b.totalTrades}</td>
              <td class="right">${b.longTrades}</td>
              <td class="right">${b.shortTrades}</td>
            </tr>
            <tr>
              <td>Net P&L %</td>
              <td class="right"><span class="${pnlClass}">${fmtPct(b.netPnlPct, true)}</span></td>
              <td class="right"><span class="${longClass}">${fmtPct(b.longPnlPct, true)}</span></td>
              <td class="right"><span class="${shortClass}">${fmtPct(b.shortPnlPct, true)}</span></td>
            </tr>
            <tr>
              <td>Avg Win</td>
              <td class="right pos">${fmtUsd(b.avgWinUsd, true)} (${fmtPct(b.avgWinPct, true)})</td>
              <td class="right">—</td>
              <td class="right">—</td>
            </tr>
            <tr>
              <td>Avg Loss</td>
              <td class="right neg">${fmtUsd(b.avgLossUsd, true)} (${fmtPct(b.avgLossPct, true)})</td>
              <td class="right">—</td>
              <td class="right">—</td>
            </tr>
            <tr>
              <td>Largest Win</td>
              <td class="right pos">${fmtUsd(b.largestWinUsd, true)}</td>
              <td class="right">—</td>
              <td class="right">—</td>
            </tr>
            <tr>
              <td>Largest Loss</td>
              <td class="right neg">${fmtUsd(b.largestLossUsd, true)}</td>
              <td class="right">—</td>
              <td class="right">—</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Условия теста</div>
      <div class="card"><div class="card-body">
        <div class="info-grid">
          <div class="info-item">
            <div class="lbl">Initial capital</div>
            <div class="val">${fmtUsd(b.initialCapital)}</div>
          </div>
          <div class="info-item">
            <div class="lbl">Notional / trade</div>
            <div class="val">${fmtUsd(b.notionalUsd)}</div>
          </div>
          <div class="info-item">
            <div class="lbl">Commission</div>
            <div class="val">${(b.commissionPctPerSide * 100).toFixed(3)}% × 2 sides</div>
          </div>
          <div class="info-item">
            <div class="lbl">Period</div>
            <div class="val">${escapeHtml(b.periodLabel)}</div>
          </div>
        </div>
        <div class="disclaimer-note">
          ℹ️ Все числа пересчитаны из сырых сделок LuxAlgo на наш sizing
          <b>$${TRACK_C_NOTIONAL_USD} на сделку</b> с вычетом комиссии Bybit
          (${(b.commissionPctPerSide * 100).toFixed(3)}% × 2 сторон). Сумма
          P&amp;L таблицы сделок ниже совпадает с Net P&amp;L сверху.
          <br/><br/>
          Safety SL ${(cfg?.slPct ? (cfg.slPct * 100).toFixed(2) : '2.50')}%
          в бэктесте <b>не моделируется</b> — для точной симуляции нужны
          OHLC данные внутри каждой сделки. В живой торговле SL работает
          как tail-risk cap, обрезая ~5-10% худших сделок, поэтому
          реальный Max Drawdown будет <b>не больше</b> бэктестового.
        </div>
      </div></div>
    </div>

    ${trades.length > 0 ? `
    <div class="section">
      <div class="section-title">
        Trades Log · ${wasCapped ? `последние ${trades.length} из ${totalInStrategy}` : `${trades.length}`} сделок
      </div>
      ${wasCapped ? `<div style="font-size: 12px; color: var(--text-faint); margin-bottom: 8px;">
        Показаны самые свежие сделки. Полная статистика (WR / PF / DD) выше — считается по всем ${totalInStrategy} сделкам.
      </div>` : ''}
      ${backtestTradesTable(trades, 20)}
    </div>
    ` : ''}
  </div>
  `;
}

function fmtDate(ts: number | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`;
}

function fmtDuration(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  const d = Math.floor(totalMin / (60 * 24));
  const h = Math.floor((totalMin % (60 * 24)) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}д ${h}ч`;
  if (h > 0) return `${h}ч ${m}м`;
  return `${m}м`;
}

function activeTradesTable(trades: ActiveTradeRow[], cfg: StrategyConfig): string {
  if (trades.length === 0) return '';
  const rows = trades
    .map((t) => {
      const sideCls = t.side === 'long' ? 'side-long' : 'side-short';
      const num = t.strategyTradeNum ?? t.id;
      const tradeIdStr = formatStrategyTradeId(cfg, num);
      const ageMs = Date.now() - t.entryAt;
      return `
      <tr>
        <td>${tradeIdStr}</td>
        <td class="dt">${fmtDate(t.entryAt)}</td>
        <td class="dt">${fmtDuration(ageMs)}</td>
        <td><span class="${sideCls}">${t.side.toUpperCase()}</span></td>
        <td class="right mono">${t.entryPrice.toFixed(4)}</td>
        <td class="right mono">${t.sl !== null ? t.sl.toFixed(4) : '—'}</td>
        <td><span class="reason-pill reason-active">🟢 В работе</span></td>
      </tr>`;
    })
    .join('');
  return `
    <div class="card table-wrap">
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Открыта (UTC)</th>
            <th>В работе</th>
            <th>Side</th>
            <th class="right">Entry</th>
            <th class="right">Safety SL</th>
            <th>Статус</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderLiveSection(_live: StrategyLiveStats, _launchedAt: number, cfg: StrategyConfig): string {
  // Two stacked sub-tables (when relevant):
  //  - ACTIVE: currently-open positions, with pulsing-green status badge
  //  - CLOSED: most recent closed positions
  // Section header reflects state with a coloured pulsing dot — green
  // dot + "позиция в работе" when active>0, red dot + "ждём сигнал"
  // when nothing's open.
  const active = getStrategyActiveTrades(cfg.id);
  const closed = getStrategyRecentTrades(cfg.id, 50);

  // Status badge for the section title
  const isWorking = active.length > 0;
  const statusBadge = isWorking
    ? `<span class="pulse-dot active" aria-hidden="true"></span>
       <span class="status-label">Позиция в работе</span>`
    : `<span class="pulse-dot waiting" aria-hidden="true"></span>
       <span class="status-label">Ждём сигнал стратегии</span>`;

  // Active block
  const activeBlock = active.length > 0
    ? `<div class="section">
         <div class="section-subtitle">Сейчас открыто: ${active.length}</div>
         ${activeTradesTable(active, cfg)}
       </div>`
    : '';

  // Closed block
  const closedBlock = closed.length > 0
    ? `<div class="section">
         <div class="section-subtitle">Закрытые сделки · последние ${closed.length}</div>
         ${liveTradesTable(closed, cfg)}
       </div>`
    : (active.length === 0
        ? `<div class="card"><div class="card-body">
             <div class="empty-state" style="padding: 24px 0;">
               ⏳ Ждём первого сигнала стратегии.<br/>
               <span style="font-size: 12px; color: var(--text-faint);">Страница обновляется автоматически каждые 60 сек.</span>
             </div>
           </div></div>`
        : '');

  return `
  <div class="section">
    <div class="section-title live-status">
      ${statusBadge}
      <span class="refresh-note">⟳ обновляется каждые 60 сек</span>
    </div>
    ${activeBlock}
    ${closedBlock}
  </div>
  `;
}

function renderRiskSection(cfg: StrategyConfig): string {
  return `
  <div class="section">
    <div class="section-title">Управление риском</div>
    <div class="card"><div class="card-body">
      <div class="info-grid">
        <div class="info-item">
          <div class="lbl">Position size</div>
          <div class="val">${fmtUsd(TRACK_C_NOTIONAL_USD)} на сделку</div>
        </div>
        <div class="info-item">
          <div class="lbl">Safety stop-loss</div>
          <div class="val">${(cfg.slPct * 100).toFixed(2)}% от entry</div>
        </div>
        <div class="info-item">
          <div class="lbl">Entry</div>
          <div class="val">market по сигналу</div>
        </div>
        <div class="info-item">
          <div class="lbl">Exit</div>
          <div class="val">LuxAlgo Builtin Exits</div>
        </div>
        <div class="info-item">
          <div class="lbl">Slippage</div>
          <div class="val">не моделируется (shadow)</div>
        </div>
      </div>
    </div></div>
  </div>
  `;
}

function renderLogicSection(cfg: StrategyConfig): string {
  const long = cfg.longDescription
    ? `<div class="desc" style="margin-bottom: 16px;">${escapeHtml(cfg.longDescription)}</div>`
    : '';
  return `
  <div class="section">
    <div class="section-title">Логика стратегии</div>
    <div class="card"><div class="card-body">
      ${long}
      <div class="info-item">
        <div class="lbl">Конфигурация</div>
        <div class="val"><code>${escapeHtml(cfg.description)}</code></div>
      </div>
    </div></div>
  </div>
  `;
}

function renderAlertIdBlock(cfg: StrategyConfig): string {
  if (!cfg.alertName && !cfg.sourceUrl) return '';
  const idText = cfg.alertName ?? cfg.id;
  // Source link rendered as a separate badge so on mobile the long
  // alert ID can wrap independently.
  const link = cfg.sourceUrl
    ? `<a class="alert-id-link" href="${escapeHtml(cfg.sourceUrl)}" target="_blank" rel="noopener nofollow">
         LuxAlgo source <span aria-hidden="true">↗</span>
       </a>`
    : '';
  return `
    <div class="alert-id-card">
      <span class="alert-id-label">Alert&nbsp;ID</span>
      <code class="alert-id-value">${escapeHtml(idText)}</code>
      ${link}
    </div>
  `;
}

function renderStrategyDetail(cfg: StrategyConfig): string {
  const live = getStrategyLiveStats(cfg.id);
  return pageShell(
    `[STRAT-${cfg.code}] ${cfg.symbol ?? ''} ${cfg.timeframe}m`,
    `
    <div class="header">
      <span class="strat-code">[STRAT-${escapeHtml(cfg.code)}] · ${escapeHtml(cfg.symbol ?? 'ANY')} · ${escapeHtml(cfg.timeframe)}m</span>
      <h1 class="title">${escapeHtml(cfg.description.split('|')[0]?.trim() ?? cfg.id)}</h1>
      <p class="subtitle">Track C · LuxAlgo AI Strategy Builder webhook · <a href="/strategies">все стратегии</a></p>
    </div>

    ${renderAlertIdBlock(cfg)}

    ${renderLiveSection(live, cfg.launchedAt, cfg)}

    ${cfg.backtest ? renderBacktestSection(cfg.backtest, cfg.id, cfg) : ''}

    ${renderRiskSection(cfg)}

    ${renderLogicSection(cfg)}
    `,
    { autoRefreshSec: 60 },
  );
}

export async function landingRoute(app: FastifyInstance): Promise<void> {
  // Index of all enabled strategies. Gated — anonymous visitors see a
  // blurred preview with a registration form overlay; authed visitors
  // see the real dashboard.
  app.get('/strategies', async (req, reply) => {
    const enabled = Object.values(STRATEGY_CONFIGS).filter((s) => s.enabled);
    reply.type('text/html; charset=utf-8');
    if (!isAuthed(req)) {
      // No-cache on the gated stub so re-visits after auth get fresh HTML.
      reply.header('Cache-Control', 'private, no-store');
      return renderGatedPreview('index', renderStrategyIndex(enabled));
    }
    reply.header('Cache-Control', `public, max-age=${PAGE_CACHE_SECONDS}`);
    return renderStrategyIndex(enabled);
  });

  // Detail by code (e.g. /strategies/001) — same gating.
  app.get<{ Params: { code: string } }>('/strategies/:code', async (req, reply) => {
    const cfg =
      Object.values(STRATEGY_CONFIGS).find((s) => s.code === req.params.code) ??
      getStrategyConfig(req.params.code);
    if (!cfg) {
      reply.code(404).type('text/html; charset=utf-8');
      return pageShell(
        'Not found',
        `<div class="header"><h1 class="title">404</h1></div><div class="empty-state">Стратегия не найдена. <a href="/strategies">Все стратегии</a></div>`,
        {},
      );
    }
    reply.type('text/html; charset=utf-8');
    if (!isAuthed(req)) {
      reply.header('Cache-Control', 'private, no-store');
      return renderGatedPreview('detail', renderStrategyDetail(cfg));
    }
    reply.header('Cache-Control', `public, max-age=${PAGE_CACHE_SECONDS}`);
    return renderStrategyDetail(cfg);
  });
}

/**
 * Wrap a server-rendered stats page in a blur layer + access form.
 * The underlying page is fully rendered into HTML and made visually
 * unreadable via CSS filter. Form overlay calls /auth/start →
 * /auth/verify; on success page reloads and the gate falls away.
 *
 * Why render the full page anyway: gives the page real height & visible
 * shapes (so subscribers see "yes there's data here"), and lets the
 * server be the single rendering source — no parallel "preview"
 * template that drifts.
 */
function renderGatedPreview(
  _kind: 'index' | 'detail',
  innerHtml: string,
): string {
  // Extract the inner <body> content of the rendered page so we don't
  // nest <html>. Quick'n'dirty: find first <div class="container">
  // and grab to its matching closer. Easier: rebuild via the same pageShell.
  // Trick — wrap pageShell-rendered HTML in a div with .gated-blur class
  // + overlay form. We embed the full HTML doc into a sandboxed iframe
  // would be ideal, but inline approach is simpler.
  //
  // Implementation: just strip the <html>/<head>/<body> wrapper and
  // re-wrap.
  const bodyMatch = innerHtml.match(/<body[^>]*>([\s\S]*)<\/body>/);
  const bodyInner = bodyMatch ? bodyMatch[1]! : innerHtml;
  // Pull the <style> from the original so the preview keeps the same look.
  const styleMatch = innerHtml.match(/<style>([\s\S]*?)<\/style>/);
  const inlineStyle = styleMatch ? styleMatch[1]! : '';

  const formHtml = `
    <div class="gate-overlay">
      <div class="gate-card">
        <div class="gate-head">
          <span class="gate-icon" aria-hidden="true">🔒</span>
          <h2 class="gate-title">Доступ к детальной статистике</h2>
        </div>
        <p class="gate-sub">
          Введите номер — отправим 6-значный код через официальный сервис
          подтверждения Telegram.
        </p>

        <!-- Stage 1: name + phone -->
        <div id="gate-phone-stage">
          <form id="gate-phone-form" class="gate-form" novalidate>
            <input type="text" name="name" required placeholder="Как к вам обращаться?"
                   maxlength="40" autocomplete="given-name" />
            <input type="tel" name="phone" required placeholder="+79991234567"
                   inputmode="tel" autocomplete="tel" />
            <button type="submit">Получить код в Telegram</button>
          </form>
          <div class="gate-trust">
            <div class="gate-trust-row">
              <span class="gate-trust-icon">📱</span>
              <span>Код придёт от <a href="https://t.me/VerificationCodes" target="_blank" rel="noopener"><b>@VerificationCodes</b></a> <span class="gate-verified" title="Официальный сервис Telegram">✓</span></span>
            </div>
            <div class="gate-trust-row">
              <span class="gate-trust-icon">🛡</span>
              <span>Это официальный сервис Telegram. Мы не получаем доступ к вашему аккаунту.</span>
            </div>
            <div class="gate-trust-row">
              <span class="gate-trust-icon">🔐</span>
              <span>Номер хранится только для подтверждения, третьим лицам не передаётся.</span>
            </div>
          </div>
        </div>

        <!-- Stage 2: code (hidden until phone submitted) -->
        <div id="gate-code-stage" style="display:none">
          <div class="gate-tg-instructions">
            <div class="gate-tg-step">
              <span class="gate-tg-num">1</span>
              <span>Откройте <b>Telegram</b> на телефоне или компьютере</span>
            </div>
            <div class="gate-tg-step">
              <span class="gate-tg-num">2</span>
              <span>Найдите чат <a href="https://t.me/VerificationCodes" target="_blank" rel="noopener" class="gate-tg-link">@VerificationCodes <span class="gate-verified">✓</span> →</a></span>
            </div>
            <div class="gate-tg-step">
              <span class="gate-tg-num">3</span>
              <span>Скопируйте 6-значный код из последнего сообщения и введите ниже</span>
            </div>
          </div>
          <form id="gate-code-form" class="gate-form" novalidate>
            <input type="text" name="code" required placeholder="123456"
                   inputmode="numeric" pattern="\\d{4,9}" maxlength="9"
                   autocomplete="one-time-code" />
            <button type="submit">Подтвердить</button>
          </form>
          <p class="gate-resend">
            Не пришёл код? Подождите 30 секунд — иногда Telegram доставляет
            с задержкой. <a href="#" id="gate-back">← Изменить номер</a>
          </p>
        </div>

        <div id="gate-msg" class="gate-msg"></div>
        <p class="gate-note">
          Cookie сохраняется на 90 дней — больше вводить номер не понадобится.
        </p>
      </div>
    </div>
  `;

  const script = `
    <script>
      (function() {
        var msg = document.getElementById('gate-msg');
        var phoneStage = document.getElementById('gate-phone-stage');
        var codeStage = document.getElementById('gate-code-stage');
        var phoneForm = document.getElementById('gate-phone-form');
        var codeForm = document.getElementById('gate-code-form');
        var backLink = document.getElementById('gate-back');
        function setMsg(text, isError) {
          msg.textContent = text || '';
          msg.className = 'gate-msg' + (isError ? ' err' : '');
        }
        function showCodeStage(masked) {
          phoneStage.style.display = 'none';
          codeStage.style.display = 'block';
          setMsg('✓ Код отправлен на ' + masked + ' через Telegram');
          codeForm.code.focus();
        }
        function showPhoneStage() {
          codeStage.style.display = 'none';
          phoneStage.style.display = 'block';
          setMsg('');
          phoneForm.phone.focus();
        }
        if (backLink) {
          backLink.addEventListener('click', function(e) {
            e.preventDefault();
            showPhoneStage();
            phoneForm.querySelector('button').disabled = false;
          });
        }
        phoneForm.addEventListener('submit', async function(e) {
          e.preventDefault();
          var name = phoneForm.name.value.trim();
          var phone = phoneForm.phone.value.trim();
          if (!name) {
            setMsg('Введите имя, чтобы продолжить', true);
            phoneForm.name.focus();
            return;
          }
          setMsg('Отправляем код…');
          phoneForm.querySelector('button').disabled = true;
          try {
            var res = await fetch('/auth/start', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ phone: phone, name: name }),
            });
            var data = await res.json();
            if (!data.ok) {
              setMsg(data.message || 'Не удалось отправить код. Проверьте номер.', true);
              phoneForm.querySelector('button').disabled = false;
              return;
            }
            showCodeStage(data.masked_phone || phone);
          } catch (err) {
            setMsg('Ошибка сети, попробуйте позже', true);
            phoneForm.querySelector('button').disabled = false;
          }
        });
        codeForm.addEventListener('submit', async function(e) {
          e.preventDefault();
          var code = codeForm.code.value.trim();
          setMsg('Проверяем код…');
          codeForm.querySelector('button').disabled = true;
          try {
            var res = await fetch('/auth/verify', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ code: code }),
            });
            var data = await res.json();
            if (data.ok) {
              // Fire Metrika goal ONLY for first-time registrations.
              // The server flags repeat-login (cookie wipe, new device,
              // 90-day expiry on the same phone) with is_new_registration:false
              // so the goal stays per-unique-phone.
              if (data.is_new_registration && typeof ym === 'function') {
                try { ym(109255043, 'reachGoal', 'registration'); } catch (e) {}
              }
              setMsg('✅ Доступ открыт! Перезагружаем…');
              setTimeout(function() { window.location.reload(); }, 800);
              return;
            }
            setMsg('Неверный код, попробуйте ещё раз', true);
            codeForm.querySelector('button').disabled = false;
            codeForm.code.value = '';
            codeForm.code.focus();
          } catch (err) {
            setMsg('Ошибка сети, попробуйте позже', true);
            codeForm.querySelector('button').disabled = false;
          }
        });
      })();
    </script>
  `;

  // Same Metrika snippet as pageShell — track gate views so the
  // funnel "saw blur → registered" is measurable in the dashboard.
  const metrikaScript = `
<script type="text/javascript">
   (function(m,e,t,r,i,k,a){m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};
   m[i].l=1*new Date();
   for (var j = 0; j < document.scripts.length; j++) {if (document.scripts[j].src === r) { return; }}
   k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)})
   (window, document,'script','https://mc.yandex.ru/metrika/tag.js?id=109255043', 'ym');

   ym(109255043, 'init', {webvisor:true, clickmap:true, referrer: document.referrer, url: location.href, accurateTrackBounce:true, trackLinks:true});
</script>
<noscript><div><img src="https://mc.yandex.ru/watch/109255043" style="position:absolute; left:-9999px;" alt="" /></div></noscript>`;
  const faviconSvg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>` +
    `<rect width='64' height='64' rx='14' fill='%230b0e13'/>` +
    `<path d='M8 48 L18 42 L26 44 L36 30 L46 32 L56 14' fill='none' ` +
    `stroke='%234ad991' stroke-width='4' stroke-linecap='round' stroke-linejoin='round'/>` +
    `<circle cx='56' cy='14' r='4' fill='%234ad991'/>` +
    `</svg>`;
  const faviconLink =
    `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${faviconSvg}"/>` +
    `<link rel="apple-touch-icon" href="data:image/svg+xml,${faviconSvg}"/>`;

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Robot Claude — доступ к статистике</title>
${faviconLink}
${metrikaScript}
<style>${inlineStyle}
  /* Gate overlay */
  .gated-blur {
    filter: blur(8px); pointer-events: none; user-select: none;
    transform: scale(1.02); transform-origin: top center;
  }
  .gate-overlay {
    position: fixed; inset: 0; z-index: 100;
    display: flex; align-items: center; justify-content: center;
    background: rgba(11, 14, 19, 0.6); backdrop-filter: blur(6px);
    padding: 24px;
  }
  .gate-card {
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: 14px; padding: 24px 22px; max-width: 400px;
    width: 100%;
    box-shadow: 0 20px 60px rgba(0,0,0,0.5);
  }
  /* Header — lock icon + title on the same row for compactness.
   *  Was previously 32px lock + 22px title stacked; consumes ~80px
   *  of vertical space. Inline saves ~40px. */
  .gate-head {
    display: flex; align-items: center; gap: 10px;
    margin-bottom: 8px;
  }
  .gate-icon { font-size: 18px; line-height: 1; }
  .gate-title {
    font-size: 18px; font-weight: 700; margin: 0;
    letter-spacing: -0.01em;
  }
  .gate-sub {
    color: var(--text-dim); font-size: 13px; line-height: 1.45;
    margin: 0 0 16px;
  }
  .gate-form { display: flex; flex-direction: column; gap: 8px; }
  .gate-form input {
    background: var(--bg); border: 1px solid var(--border);
    color: var(--text); padding: 11px 13px; border-radius: 8px;
    font-size: 14px; outline: none; font-family: inherit;
    transition: border-color 120ms;
  }
  .gate-form input:focus { border-color: var(--accent); }
  .gate-form button {
    background: var(--accent); color: var(--bg); border: none;
    padding: 11px; border-radius: 8px; font-size: 14px;
    font-weight: 600; cursor: pointer; transition: opacity 120ms;
  }
  .gate-form button:hover { opacity: 0.92; }
  .gate-form button:disabled { opacity: 0.5; cursor: wait; }
  .gate-msg {
    margin: 10px 0 0; font-size: 12px; color: var(--text-dim);
    min-height: 14px;
  }
  .gate-msg.err { color: var(--danger); }
  .gate-note {
    font-size: 11px; color: var(--text-faint); line-height: 1.45;
    margin: 12px 0 0; text-align: center;
  }
  /* Trust row block on phone stage — three icon+text rows. Compact
   *  vertical rhythm: 6px between rows, icons aligned to first text
   *  line baseline via padding-top trick on the icon column. */
  .gate-trust {
    margin-top: 14px; padding-top: 12px;
    border-top: 1px solid var(--border);
    display: flex; flex-direction: column; gap: 6px;
  }
  .gate-trust-row {
    display: grid;
    grid-template-columns: 20px 1fr;
    gap: 10px; align-items: start;
    font-size: 12px; color: var(--text-dim); line-height: 1.45;
  }
  .gate-trust-icon {
    text-align: center; font-size: 13px;
    line-height: 1.45; /* matches the text so icon sits on first line */
  }
  .gate-trust-row a {
    color: var(--accent); text-decoration: none;
  }
  .gate-trust-row a:hover { text-decoration: underline; }
  /* Telegram-blue verified checkmark — visually says "official". */
  .gate-verified {
    display: inline-flex; align-items: center; justify-content: center;
    width: 13px; height: 13px; border-radius: 50%;
    background: #2aabee; color: #fff;
    font-size: 8px; font-weight: 700; line-height: 1;
    vertical-align: 0; margin: 0 1px;
  }
  /* Code stage — 3 numbered steps explaining WHERE the code arrives. */
  .gate-tg-instructions {
    background: rgba(42, 171, 238, 0.06);
    border: 1px solid rgba(42, 171, 238, 0.20);
    border-radius: 8px;
    padding: 12px 14px;
    margin-bottom: 12px;
    display: flex; flex-direction: column; gap: 8px;
  }
  .gate-tg-step {
    display: grid;
    grid-template-columns: 22px 1fr;
    gap: 10px; align-items: start;
    font-size: 12.5px; color: var(--text); line-height: 1.4;
  }
  .gate-tg-num {
    width: 20px; height: 20px; border-radius: 50%;
    background: #2aabee; color: #fff;
    font-size: 11px; font-weight: 700;
    display: inline-flex; align-items: center; justify-content: center;
  }
  .gate-tg-link {
    display: inline-flex; align-items: center; gap: 4px;
    color: #2aabee; text-decoration: none; font-weight: 600;
  }
  .gate-tg-link:hover { text-decoration: underline; }
  .gate-resend {
    font-size: 11px; color: var(--text-faint); line-height: 1.45;
    margin: 10px 0 0; text-align: center;
  }
  .gate-resend a {
    color: var(--accent); text-decoration: none;
  }
  .gate-resend a:hover { text-decoration: underline; }
</style>
</head>
<body>
<div class="gated-blur" aria-hidden="true">${bodyInner}</div>
${formHtml}
${script}
</body>
</html>`;
}
