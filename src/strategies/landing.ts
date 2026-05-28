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
import { isAuthed, getAuthedUser } from '../auth/routes.js';
import { logger } from '../lib/logger.js';
import { TIER_CONFIGS, computeTierTradeSize } from './tier-config.js';
import {
  getStrategyLiveStats,
  getStrategyRecentTrades,
  getStrategyActiveTrades,
  getAllActiveShadowTrades,
  getAllClosedShadowTrades,
  countAllClosedShadowTrades,
  type StrategyLiveStats,
  type LiveTradeRow,
  type ActiveTradeRow,
  type LiveTradeFeedRow,
  type ActiveTradeFeedRow,
  type FeedSort,
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
  // Same exhaustive mapping as renderAllStrategiesFeed (the all-strategies
  // table on /strategies). Audit gap: the previous version only knew 3
  // reasons, so any reconcile-derived close — manual_close, bybit_sl_hit,
  // bybit_reconcile, reverse_signal — rendered as the raw closeReason
  // string («manual») in the pill.
  const reasonLabel = (t: LiveTradeRow): { label: string; cls: string } => {
    if (t.closeReason === 'sl_hit' || t.forceCloseReason === 'bybit_sl_hit') {
      return { label: 'SL', cls: 'reason-sl' };
    }
    if (t.forceCloseReason === 'strategy_exit') return { label: 'strat', cls: 'reason-strat' };
    if (t.forceCloseReason === 'reverse_signal') return { label: 'flip', cls: 'reason-reverse' };
    if (t.forceCloseReason === 'time_guard') return { label: 'time', cls: 'reason-time' };
    if (t.forceCloseReason === 'manual_close') return { label: 'manual', cls: 'reason-manual' };
    if (t.forceCloseReason === 'bybit_reconcile') return { label: 'sync', cls: 'reason-manual' };
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
    .alert-id-value { font-size: 10px; padding: 4px 6px; min-width: 0; flex-basis: 100%; }
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
    margin-top: 60px; padding: 24px 16px 32px;
    border-top: 1px solid var(--border);
    color: var(--text-faint); font-size: 12px; text-align: center;
    line-height: 1.6; max-width: 880px; margin-left: auto; margin-right: auto;
  }
  .footer b { color: var(--text-dim); }
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
    white-space: nowrap;
  }
  .reason-strat { background: rgba(74, 217, 145, 0.10); color: var(--accent); }
  .reason-sl    { background: rgba(239, 91, 107, 0.14); color: var(--danger); }
  .reason-time  { background: rgba(245, 177, 77, 0.12); color: var(--warning); }
  .reason-active{ background: rgba(74, 217, 145, 0.18); color: var(--accent); }

  /* Phase N — «live started on …» note above the trade tables. */
  .live-since-note {
    font-size: 12.5px; color: var(--text-dim);
    padding: 10px 14px; margin: 0 0 16px;
    background: rgba(74, 217, 145, 0.04);
    border: 1px solid rgba(74, 217, 145, 0.20);
    border-radius: 8px; line-height: 1.55;
  }
  .live-since-note b { color: var(--accent); font-weight: 600; }

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

  /* ---------- All-strategies live feed (Phase O) ---------- */
  .feed-subsection { margin: 14px 0 6px; }
  .feed-subsection-title {
    display: flex; align-items: center; gap: 8px;
    font-size: 12px; color: var(--text-dim);
    text-transform: uppercase; letter-spacing: 0.05em;
  }
  .feed-subsection-title b { color: var(--text); }
  .feed-table .feed-strat-cell {
    display: inline-flex; flex-direction: column; line-height: 1.25;
    text-decoration: none;
  }
  .feed-table .feed-strat-cell:hover .feed-strat-id { color: var(--accent); }
  .feed-strat-id {
    font-weight: 600; color: var(--text); font-size: 12.5px;
    font-family: ui-monospace, Menlo, monospace;
    transition: color 120ms;
  }
  .feed-strat-meta {
    font-size: 10.5px; color: var(--text-faint);
    margin-top: 2px;
  }
  .feed-table tr.feed-row-active {
    background: rgba(74,217,145,0.04);
  }
  .feed-table tr.feed-row-active td {
    border-top: 1px solid rgba(74,217,145,0.18);
  }
  .reason-pill.reason-active {
    background: rgba(74,217,145,0.15); color: var(--accent);
    border: 1px solid rgba(74,217,145,0.45);
  }
  .reason-pill.reason-reverse {
    background: rgba(255,193,107,0.14); color: #ffc16b;
    border: 1px solid rgba(255,193,107,0.45);
  }
  .reason-pill.reason-manual {
    background: rgba(133,144,160,0.18); color: #cfd6dd;
    border: 1px solid rgba(133,144,160,0.40);
  }
  /* PnL cell — secondary % suffix dimmer than the headline $ amount. */
  .feed-pnl-pct {
    font-size: 11px; font-weight: 500;
    margin-left: 4px; opacity: 0.75;
  }
  /* SL distance shown beside the SL price for active trades. */
  .feed-sl-pct {
    font-size: 10.5px; color: var(--text-faint);
    margin-left: 2px;
  }
  /* Live P&L cell for active rows in the trades feed — stacks the
     current price below the $ / % so it doesn't push the table wider. */
  .feed-pnl-live { display: inline-flex; flex-direction: column; align-items: flex-end; gap: 1px; line-height: 1.3; }
  .feed-pnl-live-meta {
    font-size: 10px; color: var(--text-faint); font-weight: 400;
    letter-spacing: 0.01em;
  }
  .feed-pnl-live-meta .mono { color: var(--text-dim); margin-left: 3px; }
  /* Two-line entry+exit cell — saves a whole column in narrow viewports. */
  .feed-time-cell {
    display: flex; flex-direction: column; gap: 2px;
    white-space: nowrap; line-height: 1.35;
  }
  .feed-time-entry {
    font-size: 12px; color: var(--text);
  }
  .feed-time-exit {
    font-size: 11.5px; color: var(--text-dim);
  }
  .feed-time-exit-empty { font-style: italic; opacity: 0.7; }
  /* Sort selector — sits beside the «Закрытые» subsection title. */
  .feed-sort-form {
    display: inline-flex; align-items: center; gap: 8px;
    margin-left: auto;
  }
  .feed-subsection-title { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  .feed-sort-label {
    font-size: 11px; color: var(--text-faint);
    text-transform: uppercase; letter-spacing: 0.05em;
  }
  .feed-sort-select {
    background: var(--bg-card); border: 1px solid var(--border);
    color: var(--text); padding: 5px 10px; border-radius: 6px;
    font-size: 12px; font-family: inherit; cursor: pointer;
    transition: border-color 120ms;
  }
  .feed-sort-select:hover  { border-color: var(--accent); }
  .feed-sort-select:focus  { outline: none; border-color: var(--accent); }
  .feed-sort-apply {
    background: var(--accent); color: var(--bg); border: none;
    padding: 5px 12px; border-radius: 6px; font-size: 12px;
    font-weight: 600; cursor: pointer;
  }
  /* Legend below the table — explains each reason-pill colour. */
  .feed-reason-legend {
    font-size: 12px; color: var(--text-dim);
    margin: 14px 4px 0; padding: 12px 14px;
    background: rgba(255,255,255,0.02);
    border: 1px solid var(--border);
    border-radius: 8px;
    line-height: 2.1;
  }
  .feed-reason-legend b { color: var(--text); margin-right: 6px; }
  .feed-reason-legend .reason-pill { vertical-align: middle; margin: 0 2px; }
  /* Pagination footer for the live-feed table */
  .feed-pagination {
    display: flex; align-items: center; justify-content: center;
    gap: 6px; flex-wrap: wrap;
    margin: 18px 0 0; padding: 12px 0;
  }
  .feed-page-link {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 32px; height: 32px; padding: 0 10px;
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: 6px; color: var(--text-dim);
    font-size: 13px; font-weight: 600; text-decoration: none;
    transition: all 120ms;
  }
  .feed-page-link:hover {
    border-color: var(--accent); color: var(--accent);
  }
  .feed-page-current {
    background: var(--accent-soft); border-color: var(--accent);
    color: var(--accent); cursor: default;
  }
  .feed-page-disabled { opacity: 0.35; cursor: not-allowed; pointer-events: none; }
  .feed-page-info {
    margin: 0 8px; font-size: 12px; color: var(--text-dim);
  }
  .feed-page-info b { color: var(--text); }
  .feed-page-info .dim { color: var(--text-faint); }

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
  .tf-group { margin-bottom: 40px; }

  /* Group-header card — clearly delineates each timeframe as its own
     section with: TF chip, human name, strategy count, optional
     «since DATE», then a row of aggregated stats (LIVE or BACKTEST). */
  .tf-group-card {
    background: linear-gradient(180deg, rgba(74,217,145,0.04) 0%, var(--bg-card) 100%);
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: 10px;
    padding: 14px 18px;
    margin-bottom: 12px;
  }
  .tf-group-card-top {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  }
  .tf-group-tf-chip {
    font-family: 'SF Mono', 'Menlo', monospace; font-size: 13px;
    font-weight: 700; color: var(--accent); letter-spacing: 0.04em;
    background: var(--accent-soft); padding: 4px 10px; border-radius: 5px;
    text-transform: uppercase;
  }
  .tf-group-tf-name {
    font-size: 17px; font-weight: 600; color: var(--text);
    letter-spacing: -0.01em;
  }
  .tf-group-count-pill {
    font-size: 11.5px; color: var(--text-dim);
    background: var(--bg); padding: 3px 9px; border-radius: 999px;
    border: 1px solid var(--border);
  }
  .tf-group-since {
    margin-left: auto; font-size: 11.5px; color: var(--text-faint);
  }
  .tf-group-card-stats {
    display: flex; align-items: center; gap: 6px 10px; flex-wrap: wrap;
    margin-top: 10px; padding-top: 10px;
    border-top: 1px dashed var(--border);
  }
  .tf-stat {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 13px; color: var(--text-dim);
    padding: 2px 0;
  }
  .tf-stat b { color: var(--text); font-weight: 700; }
  .tf-stat b.pos { color: var(--accent); }
  .tf-stat b.neg { color: var(--danger); }
  .tf-stat-label {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--text-faint);
  }
  .tf-stat-live {
    font-family: 'SF Mono', 'Menlo', monospace; font-size: 10.5px;
    font-weight: 700; letter-spacing: 0.08em; color: var(--accent);
    background: var(--accent-soft); padding: 3px 8px 3px 6px;
    border-radius: 4px; border: 1px solid rgba(74,217,145,0.30);
  }
  .tf-stat-live .tf-stat-dot {
    width: 7px; height: 7px; border-radius: 50%; background: var(--accent);
    margin-right: 4px;
    animation: pulse-green 1.6s ease-out infinite;
  }
  .tf-stat-bt {
    font-family: 'SF Mono', 'Menlo', monospace; font-size: 10.5px;
    font-weight: 700; letter-spacing: 0.08em; color: var(--text-dim);
    background: var(--bg); padding: 3px 8px; border-radius: 4px;
    border: 1px solid var(--border);
  }
  .tf-stat-open {
    color: var(--accent); font-weight: 600;
    margin-left: auto;
  }
  .tf-stat-await {
    color: var(--text-faint); font-style: italic; font-size: 12px;
    margin-left: auto;
  }
  @media (max-width: 640px) {
    .tf-group-card { padding: 12px 14px; }
    .tf-group-tf-name { font-size: 15px; }
    .tf-group-since { display: none; }
    .tf-stat { font-size: 12px; }
    .tf-stat-label { font-size: 10px; }
  }
  /* ----- Timeframe explainer (collapsible) -----
     Sits above the timeframe-group list. Closed by default — visitors
     who already know what 5m/15m/1H means skip it; newcomers tap the
     summary to expand a short, plain-language definition of each TF. */
  .tf-explainer {
    margin: 0 0 22px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
  }
  .tf-explainer > summary {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 16px; cursor: pointer;
    list-style: none;
    font-size: 14px; color: var(--text);
    transition: background 120ms;
  }
  .tf-explainer > summary::-webkit-details-marker { display: none; }
  .tf-explainer > summary:hover { background: var(--bg-card-hover); }
  .tf-explainer-icon { font-size: 18px; }
  .tf-explainer-title { flex: 1; font-weight: 500; }
  .tf-explainer-hint {
    font-size: 11.5px; color: var(--text-faint);
    text-transform: uppercase; letter-spacing: 0.06em;
  }
  .tf-explainer[open] .tf-explainer-hint::after { content: ''; }
  .tf-explainer[open] > summary { border-bottom: 1px solid var(--border); }
  .tf-explainer-body {
    padding: 16px 18px 18px;
    font-size: 13.5px; line-height: 1.6; color: var(--text-dim);
  }
  .tf-explainer-body p { margin: 0 0 12px; }
  .tf-explainer-body b { color: var(--text); font-weight: 600; }
  .tf-explainer-grid {
    display: flex; flex-direction: column; gap: 10px;
    margin-bottom: 14px;
  }
  .tf-explainer-row {
    display: flex; gap: 12px; align-items: flex-start;
    padding: 10px 12px;
    background: var(--bg); border-radius: 8px;
    border: 1px solid var(--border);
  }
  .tf-explainer-chip {
    flex-shrink: 0;
    font-family: 'SF Mono', 'Menlo', monospace; font-size: 12px;
    font-weight: 700; color: var(--accent); letter-spacing: 0.04em;
    background: var(--accent-soft); padding: 4px 10px; border-radius: 4px;
    text-transform: uppercase;
    min-width: 44px; text-align: center;
  }
  .tf-explainer-note {
    margin-top: 14px !important;
    padding: 10px 14px;
    background: rgba(74, 217, 145, 0.05);
    border-left: 2px solid var(--accent);
    border-radius: 0 6px 6px 0;
    font-size: 13px;
  }
  /* Screenshot inside the «как стратегии выглядят на графике» explainer.
     Caps height so a tall TradingView capture doesn't dominate the page,
     keeps a soft border + radius so it reads as a framed example, not a
     bleed-into-page raw image. */
  .tf-explainer-screenshot {
    display: block; width: 100%; max-width: 920px;
    margin: 6px auto 8px; height: auto;
    border-radius: 8px; border: 1px solid var(--border);
    background: var(--bg);
  }
  .tf-explainer-shot-caption {
    text-align: center; font-size: 12px; color: var(--text-faint);
    margin: 0 0 10px; line-height: 1.5;
  }
  @media (max-width: 640px) {
    .tf-explainer > summary { padding: 10px 14px; font-size: 13px; gap: 8px; }
    .tf-explainer-hint { font-size: 10.5px; }
    .tf-explainer-body { padding: 14px 14px 14px; font-size: 12.5px; }
    .tf-explainer-row { padding: 8px 10px; gap: 10px; }
    .tf-explainer-chip { font-size: 11px; min-width: 38px; }
  }

  /* Legacy header — kept in case the old DOM is in flight elsewhere. */
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

  /* ---------- Strategy row cards — horizontal focus carousel ----------
     Same pattern as the /autotrading pricing slider. Each timeframe
     group is a track of cards, snap-centred, with a focused (full-
     opacity) middle card and dimmed peeking neighbours. */
  .strat-row-carousel-wrap {
    position: relative; margin: 0 -4px 4px;
  }
  .strat-row-carousel {
    display: flex; gap: 16px;
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    /* Side-padding = (viewport_half − card_half) so first/last cards
       can snap to centre. Card 360px → padding = 50% - 180px on wide
       viewports, clamped at 20px minimum. */
    padding: 14px max(20px, calc(50% - 190px)) 16px;
    scrollbar-color: #2a323d transparent;
    scrollbar-width: thin;
    -webkit-overflow-scrolling: touch;
    touch-action: pan-x pan-y;
    overscroll-behavior-x: contain;
  }
  .strat-row-carousel::-webkit-scrollbar { height: 8px; }
  .strat-row-carousel::-webkit-scrollbar-track { background: transparent; }
  .strat-row-carousel::-webkit-scrollbar-thumb { background: #2a323d; border-radius: 4px; }
  /* Single-strategy timeframe groups skip the carousel chrome and just
     render the card centred at its desktop width. */
  .strat-row-single {
    display: flex; justify-content: center; padding: 8px 4px 4px;
  }
  .strat-row-single .strat-row { max-width: 600px; width: 100%; }

  /* ---------- Collapsible TF group (replaces carousel) ---------- */
  .tf-group-details { margin-bottom: 20px; }
  .tf-group-details > summary.tf-group-summary {
    list-style: none; cursor: pointer; position: relative;
    display: block;
  }
  .tf-group-details > summary::-webkit-details-marker { display: none; }
  .tf-group-summary:focus-visible {
    outline: 2px solid rgba(74, 217, 145, 0.4); outline-offset: 4px;
    border-radius: 12px;
  }
  /* Chevron — sits inside summary, rotates when details opens. */
  .tf-group-chevron {
    position: absolute; top: 50%; right: 18px;
    transform: translateY(-50%); font-size: 18px; line-height: 1;
    color: var(--text-faint); transition: transform 200ms ease;
    pointer-events: none;
  }
  details[open] > summary .tf-group-chevron { transform: translateY(-50%) rotate(180deg); }
  /* The header card inside summary doesn't need its own click handler. */
  .tf-group-summary .tf-group-card {
    transition: background 180ms;
    padding-right: 50px; /* reserve room for chevron */
  }
  .tf-group-summary:hover .tf-group-card {
    background: linear-gradient(180deg, rgba(74,217,145,0.06) 0%, var(--bg-card-hover) 100%);
  }
  /* Vertical list of strategies. Centred, capped width matching the
     single-card layout, with comfortable gap between cards. */
  .tf-group-list {
    display: flex; flex-direction: column; align-items: center;
    gap: 8px; padding: 10px 4px 2px;
  }
  .tf-group-list .strat-row {
    flex: 0 0 auto; width: 100%; max-width: 600px;
    scroll-snap-align: none;
    opacity: 1 !important;
  }
  @media (max-width: 640px) {
    .tf-group-list { gap: 8px; padding: 8px 0 0; }
    .tf-group-list .strat-row { width: 100%; max-width: 100%; padding: 10px 12px 9px; }
    .tf-group-chevron { right: 12px; font-size: 16px; }
  }

  .strat-row {
    display: flex; flex-direction: column; gap: 2px;
    text-decoration: none; color: inherit; position: relative;
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: 10px; padding: 11px 14px 10px;
    flex: 0 0 360px; min-width: 0;
    scroll-snap-align: center;
    box-shadow: 0 4px 12px rgba(0,0,0,0.18);
    transition: border-color 180ms;
  }
  .strat-row:hover {
    background: var(--bg-card-hover); border-color: var(--text-faint);
    text-decoration: none;
  }
  /* Active card in focus carousel — full opacity (others dim per the
     global focus-mode rule), tier-colour-ish accent border. */
  [data-carousel="focus"] .strat-row.rc-card-active {
    border-color: rgba(74, 217, 145, 0.45);
    box-shadow: 0 10px 28px rgba(0,0,0,0.35),
                0 0 0 1px rgba(74, 217, 145, 0.20);
  }
  /* Asymmetric dimming inside the strategy carousels: cards on the LEFT
     of the active card are dimmer than ones on the RIGHT. Rationale:
     reading flow is left-to-right; the right neighbour is «what's
     coming next» (visitor's attention pulls there naturally), the left
     neighbour is «already past». Using ~ sibling combinator: only
     siblings AFTER .rc-card-active match, so we override their opacity
     UP from the default. */
  .strat-row-carousel.rc-carousel-track > .rc-card-active ~ .strat-row {
    opacity: 0.7;
  }
  /* Override the base focus-mode rule for default-dim (cards before
     active) to be even darker. */
  [data-carousel="focus"] .strat-row-carousel.rc-carousel-track > .strat-row {
    opacity: 0.35;
  }
  [data-carousel="focus"] .strat-row-carousel.rc-carousel-track > .rc-card-active {
    opacity: 1;
  }
  @media (max-width: 640px) {
    .strat-row-head { gap: 6px; margin-bottom: 2px; }
    .strat-row-symbol { font-size: 14px; }
    .strat-code-mini { font-size: 10px; }
    /* Multi-line wrap with 2-line clamp for description (was nowrap/ellipsis). */
    .strat-row-desc {
      white-space: normal !important;
      display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      font-size: 11.5px;
      line-height: 1.4;
    }
    .row-stat-line { font-size: 11.5px; gap: 5px; }
    .stat-tag { min-width: 28px; font-size: 9px; padding: 1px 4px; }
    .row-stat-cagr { font-size: 10.5px; }
  }
  .strat-row-head {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 3px; gap: 10px; flex-wrap: wrap;
  }
  .strat-row-id { display: flex; align-items: baseline; gap: 8px; }
  .strat-code-mini {
    font-family: 'SF Mono', 'Menlo', monospace; font-size: 11px;
    color: var(--text-faint); letter-spacing: 0.08em; font-weight: 600;
  }
  .strat-row-symbol {
    font-size: 15px; font-weight: 600; color: var(--text);
    letter-spacing: -0.01em;
  }
  .strat-row-tf {
    font-family: 'SF Mono', 'Menlo', monospace; font-size: 11px;
    color: var(--text-dim); padding: 1px 5px;
    background: var(--bg); border-radius: 3px;
  }
  .strat-row-desc {
    font-size: 12px; color: var(--text-dim); margin-bottom: 4px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .row-stat-line {
    display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap;
    font-size: 12px; margin-top: 2px;
  }
  .row-stat-line.dim { color: var(--text-faint); font-style: italic; }
  .stat-tag {
    font-family: 'SF Mono', 'Menlo', monospace; font-size: 9.5px;
    font-weight: 700; letter-spacing: 0.05em;
    color: var(--text-faint); padding: 1px 5px;
    background: var(--bg); border-radius: 3px; min-width: 32px;
    text-align: center; margin-right: 3px;
  }
  .row-stat-line .pos { color: var(--accent); }
  .row-stat-line .neg { color: var(--danger); }
  .row-stat-line .dim { color: var(--text-faint); }
  /* CAGR line — subtler than the main backtest summary, since it's
   *  derived/projected. Smaller font, dimmer color, but the value
   *  itself keeps the green/red accent. */
  .row-stat-cagr {
    font-size: 11.5px; color: var(--text-dim); margin-top: 1px;
  }
  .row-stat-cagr .stat-tag { background: transparent; padding: 1px 5px; }
  /* SL row — calmer than backtest/live, since it's a risk parameter not
     a performance result. Tag in muted-red to associate with «стоп». */
  .stat-tag-sl {
    color: rgba(239, 91, 107, 0.85);
    background: rgba(239, 91, 107, 0.10);
  }

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
  /* Beta badge — pill next to the brand-name. Always visible, even when
     brand-name is hidden on very narrow screens, so the "active beta"
     status doesn't disappear with the wordmark. Subtle orange because
     green collides with our brand-mark colour. */
  .brand-beta {
    display: inline-flex;
    align-items: center;
    padding: 2px 7px;
    border-radius: 4px;
    background: rgba(255, 188, 70, 0.14);
    color: #ffbc46;
    border: 1px solid rgba(255, 188, 70, 0.40);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    line-height: 1;
    margin-left: 2px;
    text-transform: uppercase;
    flex-shrink: 0;
    cursor: help;
  }
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
  /* Header auth-pill — visible at-a-glance indicator of session state.
     Logged-in form shows a green dot + name (with the «›» nudging the
     user toward /account). Anonymous form is a plain «Войти» link
     styled like the nav links. */
  .header-auth {
    display: inline-flex; align-items: center; gap: 7px;
    padding: 5px 10px 5px 11px; border-radius: 999px;
    text-decoration: none; font-size: 12px; font-weight: 600;
    line-height: 1.2; letter-spacing: 0.01em;
    transition: border-color 120ms, background 120ms, color 120ms;
    max-width: 220px;
  }
  .header-auth-in {
    background: rgba(74,217,145,0.08);
    border: 1px solid rgba(74,217,145,0.35);
    color: #cfd6dd;
  }
  .header-auth-in:hover {
    background: rgba(74,217,145,0.14);
    border-color: rgba(74,217,145,0.55);
    color: #fff;
  }
  .header-auth-dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: #4ad991;
    box-shadow: 0 0 6px rgba(74,217,145,0.65);
    flex-shrink: 0;
  }
  .header-auth-name {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    max-width: 140px;
  }
  .header-auth-arrow {
    color: #4ad991; font-weight: 700; font-size: 13px;
    margin-left: -2px;
  }
  .header-auth-out {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-dim);
  }
  .header-auth-out:hover {
    border-color: var(--accent); color: var(--accent);
  }
  @media (max-width: 540px) {
    .header-auth-name { max-width: 80px; }
    .header-auth { font-size: 11px; padding: 4px 9px; }
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

  /* Mobile: hide center nav, show burger. Without .site-nav (flex:1)
   * pushing things apart, the .site-nav-end group (lang-toggle +
   * burger) would stick to the brand on the left — push it right with
   * margin-left:auto so the burger lands in the corner where users
   * expect it. */
  @media (max-width: 720px) {
    .site-header-inner { gap: 12px; }
    .site-nav { display: none; }
    .site-burger { display: inline-flex; }
    .site-nav-end { margin-left: auto; }
    .brand-name { font-size: 14px; }
    .brand-mark { width: 24px; height: 24px; }
    .brand-beta { font-size: 9px; padding: 2px 5px; }
  }
  /* Very narrow phones: tighten further */
  @media (max-width: 380px) {
    .site-header-inner { padding: 10px 12px; height: 52px; }
    .brand-name { display: none; }
    /* Keep .brand-beta visible — it's the only beta status indicator
       when the wordmark is hidden. */
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

  /* «How the system works» flow diagram — 4 nodes with arrows.
     Desktop: row of 4 boxes + arrows between. Mobile: column with
     vertical arrows between rows. */
  .flow-section .home-section-title { text-align: center; }
  .flow-section .home-section-sub { text-align: center; max-width: 720px; margin-left: auto; margin-right: auto; }
  .flow-diagram {
    display: flex; align-items: stretch; justify-content: center;
    gap: 8px; flex-wrap: nowrap; margin: 26px 0 18px;
  }
  .flow-node {
    flex: 1; min-width: 0;
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: 12px; padding: 18px 18px 16px;
    display: flex; flex-direction: column;
  }
  .flow-node-icon { font-size: 26px; line-height: 1; margin-bottom: 10px; }
  .flow-node-title {
    font-size: 14.5px; font-weight: 600; color: var(--text);
    margin-bottom: 6px;
  }
  .flow-node-body {
    font-size: 12.5px; color: var(--text-dim); line-height: 1.55;
    flex: 1;
  }
  .flow-arrow {
    display: flex; align-items: center; justify-content: center;
    color: var(--accent); font-size: 22px; font-weight: 700;
    flex-shrink: 0; padding: 0 2px;
  }
  .flow-footnote {
    background: rgba(74, 217, 145, 0.06);
    border-left: 3px solid var(--accent);
    border-radius: 0 8px 8px 0;
    padding: 12px 18px;
    font-size: 13.5px; color: var(--text-dim); line-height: 1.6;
    max-width: 820px; margin: 18px auto 0;
  }
  .flow-footnote b { color: var(--accent); }
  .flow-footnote em { color: var(--text); font-style: normal; font-weight: 500; }
  @media (max-width: 880px) {
    .flow-diagram { flex-direction: column; align-items: stretch; gap: 4px; }
    .flow-arrow { transform: rotate(90deg); padding: 4px 0; font-size: 24px; }
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
  /* On narrow phones the «·» separators wrap to their own line and
   * look broken. Hide them — items still read fine with just gap. */
  @media (max-width: 540px) {
    .live-strip { gap: 12px 18px; padding: 12px 16px; }
    .live-strip-sep { display: none; }
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
  .strategy-preview-meta { font-size: 12.5px; color: var(--text-dim); margin-top: 4px; line-height: 1.45; }
  .strategy-preview-meta b { color: var(--text-faint); font-weight: 600; letter-spacing: 0.02em; }
  .strategy-preview-meta-dim { opacity: 0.78; }
  .strategy-preview-right { text-align: right; flex-shrink: 0; }
  /* Big % number on the right — primary visual anchor for "live profit". */
  .strategy-preview-big {
    font-size: 20px; font-weight: 700; line-height: 1.1;
    letter-spacing: -0.01em; font-family: ui-monospace, Menlo, monospace;
  }
  .strategy-preview-big.pos { color: var(--accent); }
  .strategy-preview-big.neg { color: var(--danger); }
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
  /* Active positions cards: minmax bounded by an explicit max so that 1-2
   * positions don't stretch into oversize banners on a 1100px viewport.
   * For 4+ positions the JS swaps in .live-pos-carousel instead. */
  .live-pos-grid {
    display: grid; gap: 12px;
    grid-template-columns: repeat(auto-fill, minmax(min(320px, 100%), 1fr));
    /* On desktop, cap each card at a reasonable width even when there's
     * only 1-2 of them — prevents single-card-stretched-100% look. */
  }
  @media (min-width: 720px) {
    .live-pos-grid {
      grid-template-columns: repeat(auto-fill, minmax(320px, 380px));
      justify-content: center;
    }
  }
  /* Horizontal scroll-snap carousel for 4+ positions. Switched from
     grid to flex so JS-cloned looped cards lay out predictably. Each
     card carries a fixed flex-basis; gap handled at container level. */
  .live-pos-carousel {
    display: flex;
    gap: 16px;
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    /* Centred padding so first/last card can snap to viewport centre. */
    padding: 8px max(12px, calc(50% - 180px)) 14px;
    margin: 0 -4px;
    scrollbar-width: none;
    -ms-overflow-style: none;
    -webkit-overflow-scrolling: touch;
    touch-action: pan-x pan-y;
    overscroll-behavior-x: contain;
  }
  /* Hide the native horizontal scrollbar entirely — arrows + edge-fade
     do the affordance, and the bright-green scrollbar was reading as a
     UI element instead of a hint. */
  .live-pos-carousel::-webkit-scrollbar { height: 0; display: none; }
  .live-pos-carousel > .live-pos-card {
    flex: 0 0 min(360px, 88vw);
    scroll-snap-align: center;
  }
  /* Loop-mode hides the «← смахните, чтобы посмотреть все позиции →»
     hint because there's no end — it cycles forever. */
  [data-carousel="focus"] + .live-pos-scroll-hint,
  .live-pos-carousel-wrap[data-carousel="focus"] ~ .live-pos-scroll-hint {
    display: none;
  }
  /* Active live-pos card glows brighter green in focus mode. */
  [data-carousel="focus"] .live-pos-card.rc-card-active {
    border-color: rgba(74, 217, 145, 0.45);
    box-shadow: 0 10px 30px rgba(74, 217, 145, 0.12), 0 4px 14px rgba(0,0,0,0.35);
  }
  .live-pos-scroll-hint {
    text-align: center; font-size: 11.5px; color: var(--text-muted, #6b7480);
    margin: 4px 0 0; letter-spacing: 0.02em; opacity: 0.85;
  }
  .live-pos-subtitle {
    text-align: center; margin: 6px 0 14px;
    color: var(--text-muted, #8590a0); font-size: 13px; line-height: 1.55;
    max-width: 720px; margin-left: auto; margin-right: auto;
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
  /* Position counter — compact pill that sits inline at the start of
     the id row, BEFORE the trade-id and side pill, so it never overlaps
     ЛОНГ/ШОРТ. Tight padding so it doesn't push the row layout. */
  .live-pos-num {
    display: inline-flex; align-items: baseline; gap: 1px;
    flex-shrink: 0;
    background: rgba(74, 217, 145, 0.10);
    border: 1px solid rgba(74, 217, 145, 0.30);
    color: var(--accent);
    padding: 2px 8px; border-radius: 999px;
    font-family: ui-monospace, Menlo, monospace;
    font-size: 10.5px; font-weight: 700;
    letter-spacing: 0.02em;
    line-height: 1.3;
    margin-right: 6px;
  }
  .live-pos-num [data-pos-num-cur] { color: var(--accent); }
  .live-pos-num .live-pos-num-sep { color: rgba(74, 217, 145, 0.55); margin: 0 1px; }
  .live-pos-num [data-pos-num-total] { color: var(--text-dim); font-weight: 500; }
  /* Carousel loop-clones — used only for visual continuity (last card
     peeking before first, first peeking after last). Hide the number
     pill so they don't pretend to be additional positions. */
  .rc-clone .live-pos-num { display: none; }
  /* Two-row layout: top row = trade ID + side pill (no wrapping issues),
   * bottom row = dim meta (STRAT-XXX · SYMBOL). Was a single squeezed flex
   * row that wrapped the «ШОРТ» label badly when card width tightened. */
  .live-pos-head {
    display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px;
  }
  .live-pos-id-row {
    display: flex; justify-content: space-between; align-items: center; gap: 8px;
  }
  .live-pos-id { font-size: 14px; }
  .live-pos-id b { font-family: 'SF Mono', 'Menlo', monospace; }
  .live-pos-side-pill {
    font-size: 10.5px; font-weight: 600;
    padding: 2px 8px; border-radius: 999px;
    letter-spacing: 0.04em; line-height: 1.4;
    flex-shrink: 0;
  }
  .live-pos-side-pill.side-long {
    background: rgba(74, 217, 145, 0.16); color: var(--accent);
    border: 1px solid rgba(74, 217, 145, 0.40);
  }
  .live-pos-side-pill.side-short {
    background: rgba(239, 91, 107, 0.16); color: var(--danger);
    border: 1px solid rgba(239, 91, 107, 0.40);
  }
  .live-pos-meta-row {
    font-size: 11.5px; color: var(--text-dim); letter-spacing: 0.02em;
  }
  /* Legacy classes kept for back-compat if any cached HTML still uses them. */
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
  .live-pos-pnl-pct {
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
    /* Trade · Side · Entry · Price · Size · PnL · Age */
    grid-template-columns: 110px 70px 120px 1fr 70px 130px 80px;
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
  .live-pos-row-age {
    color: var(--text-dim); font-variant-numeric: tabular-nums;
  }
  .live-pos-row-entry.mono, .live-pos-row-size.mono {
    font-family: 'SF Mono', 'Menlo', monospace;
    color: var(--text-dim);
  }
  /* Mobile (<640px): grid-template-areas so every field is visible.
   * 2-column layout, 4 rows:
   *   Row 1: trade-id . . . . . . . . . side-chip
   *   Row 2: ВХОД value         · ЦЕНА value
   *   Row 3: РАЗМЕР value       · P&L block
   *   Row 4: age (full width, right-aligned, dim)
   * Labels are injected via ::before pseudo-elements so we don't
   * touch the SSR HTML. */
  @media (max-width: 640px) {
    .live-pos-row {
      grid-template-columns: 1fr 1fr;
      grid-template-areas:
        "id    side"
        "entry price"
        "size  pnl"
        "age   age";
      row-gap: 6px;
      column-gap: 12px;
      align-items: center;
      padding: 12px 14px;
    }
    .live-pos-row-id    { grid-area: id; }
    .live-pos-row-side  { grid-area: side; justify-self: end; }
    .live-pos-row-entry { grid-area: entry; display: inline-flex; align-items: baseline; gap: 6px; font-size: 12px; }
    .live-pos-row-entry::before { content: 'Вход'; color: var(--text-faint); font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; }
    .live-pos-row-price { grid-area: price; justify-self: end; font-size: 12px; }
    .live-pos-row-size  { grid-area: size; display: inline-flex; align-items: baseline; gap: 6px; font-size: 12px; }
    .live-pos-row-size::before { content: 'Размер'; color: var(--text-faint); font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; }
    .live-pos-row-pnl   { grid-area: pnl; justify-self: end; }
    .live-pos-row-age   { grid-area: age; display: block; font-size: 11px; color: var(--text-faint); }
    .live-pos-row-head  { display: none; }
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
  /** Phase L SEO — meta description (under 160 chars recommended). */
  description?: string;
  /** Phase L SEO — canonical URL path (e.g. '/autotrading'); becomes
   *  https://robotclaude.biz<path>. Defaults to '/' when omitted. */
  canonicalPath?: string;
  /** Phase L SEO — optional Open Graph image URL (absolute). Defaults to
   *  a generic site card. */
  ogImage?: string;
  /** Phase L SEO — JSON-LD structured data objects to inject. Use the
   *  jsonLd*() helpers from this file. Each entry should be an
   *  already-serialised JSON string (without the <script> wrapper). */
  jsonLd?: string[];
  /** Authenticated user — when set, the header renders a name pill +
   *  «Кабинет» link instead of the «Войти» link. Pass `null` (or
   *  omit) to render the anonymous header. */
  authed?: { displayName: string | null; phone: string | null } | null;
};

/** Public-facing origin used to build absolute URLs for SEO tags
 *  (canonical, OG, sitemap). Hard-coded today; could move to env later. */
export const PUBLIC_ORIGIN = 'https://robotclaude.biz';

/** Format a «since DATE» suffix for live-stats blocks.
 *  Example: formatSinceDate(t, 'ru') → «с 1 мая 2026»
 *           formatSinceDate(t, 'en') → «since May 1, 2026»
 *  Returns empty string when ms is null/undefined (no live trades yet). */
export function formatSinceDate(
  ms: number | null | undefined,
  lang: 'ru' | 'en' = 'ru',
): string {
  if (!ms) return '';
  const d = new Date(ms);
  const opts = { day: 'numeric', month: 'long', year: 'numeric' } as const;
  const formatted = d.toLocaleDateString(lang === 'en' ? 'en-US' : 'ru-RU', opts)
    .replace(/\s*г\.?$/u, ''); // strip the «г.» suffix Russian locale adds
  return lang === 'en' ? `since ${formatted}` : `с ${formatted}`;
}

/** Cookie name for language preference (Phase M). Short to keep cookie
 *  header small; value is the literal 'ru' or 'en' string. */
export const LANG_COOKIE = 'rclang';

/** Read the user's preferred language. Priority:
 *   1. rclang cookie (set explicitly by the toggle)
 *   2. Accept-Language header (browser default; en-prefix → EN)
 *   3. Fallback 'ru' (primary market).
 */
export function getLang(req: import('fastify').FastifyRequest): 'ru' | 'en' {
  const cookieLang = req.cookies?.[LANG_COOKIE];
  if (cookieLang === 'en' || cookieLang === 'ru') return cookieLang;
  const acceptLang = String(req.headers['accept-language'] ?? '').toLowerCase();
  if (acceptLang.startsWith('en')) return 'en';
  return 'ru';
}

/** Google Search Console verification — TOKEN part after «=» from the
 *  DNS TXT record «google-site-verification=<TOKEN>». Primary verification
 *  is done via the Cloudflare-mediated DNS TXT record; this meta tag is
 *  a belt-and-suspenders backup in case the operator also adds an
 *  HTML-tag method property in Google Search Console. */
export const GOOGLE_VERIFICATION_TOKEN = '_s5B7EW78dla89PL9tsBXXiyuxxIdPTZnsr99rb12us';

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
      ? '⚠ <b>Risk disclaimer.</b> Robot Claude is a software automation service, not a financial advisor or fund. ' +
        'Past performance does not guarantee future returns; backtest results are a model and live trading carries additional ' +
        'execution risk. Cryptocurrency derivatives can result in total loss of capital. By using the service you accept all ' +
        'trading risks; Robot Claude is not liable for any losses incurred on your exchange account. ' +
        'Do not deposit more than you are prepared to lose.'
      : '⚠ <b>Дисклеймер о рисках.</b> Robot Claude — сервис автоматизации торговли, не финансовый советник и не фонд. ' +
        'Прошлые результаты не гарантируют будущих; бэктест — это модель, а в живой торговле возможна дополнительная ' +
        'погрешность исполнения. Криптовалютные деривативы сопряжены с риском полной потери капитала. Используя сервис, ' +
        'вы принимаете на себя все риски, связанные с трейдингом — Robot Claude не несёт ответственности за убытки на ' +
        'вашем биржевом счёте. Не торгуйте на средства, потерю которых не готовы пережить.';
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
  // Phase M — always show lang toggle. Click sets cookie + reloads.
  // Self-link (same-lang) is kept active-styled but still functional.
  void showLangToggle; // legacy flag — no-op since Phase M.
  const langToggleHtml =
    `<a href="/set-lang/ru" class="${lang === 'ru' ? 'active' : ''}" aria-label="Русский">RU</a>` +
    `<a href="/set-lang/en" class="${lang === 'en' ? 'active' : ''}" aria-label="English">EN</a>`;
  const labels = lang === 'en'
    ? { home: 'Home', strategies: 'Strategies', autotrading: 'Auto-trading', channel: 'Channel', support: 'Support', menu: 'Menu', close: 'Close',
        cabinet: 'Cabinet', login: 'Log in', greeting: 'Hi' }
    : { home: 'Главная', strategies: 'Стратегии', autotrading: 'Автотрейдинг', channel: 'Канал', support: 'Поддержка', menu: 'Меню', close: 'Закрыть',
        cabinet: 'Кабинет', login: 'Войти', greeting: 'Привет' };

  // Auth pill in the header — either:
  //  - logged in: «Привет, NAME · Кабинет» (clickable, goes to /account)
  //  - anonymous: «Войти» link (goes to the login-mode gate)
  const authedUser = opts.authed ?? null;
  const authPillHtml = authedUser
    ? `<a class="header-auth header-auth-in" href="/account" title="${escapeHtml(authedUser.displayName ?? authedUser.phone ?? '')}">` +
        `<span class="header-auth-dot" aria-hidden="true"></span>` +
        `<span class="header-auth-name">${escapeHtml(authedUser.displayName ?? authedUser.phone ?? labels.cabinet)}</span>` +
        `<span class="header-auth-arrow" aria-hidden="true">›</span>` +
      `</a>`
    : `<a class="header-auth header-auth-out" href="/strategies?login=1">${labels.login}</a>`;

  const navLinksHtml = `
      <a href="/">${labels.home}</a>
      <a href="/autotrading">${labels.autotrading}</a>
      <a href="/strategies">${labels.strategies}</a>
      <a href="https://t.me/luxalgosignal" target="_blank" rel="noopener">${labels.channel}</a>
      <a href="https://t.me/dboykod" target="_blank" rel="noopener">${labels.support}</a>
  `;

  const siteHeader = `
<header class="site-header">
  <div class="site-header-inner">
    <a class="brand" href="/" aria-label="Robot Claude (beta)">
      <svg class="brand-mark" viewBox="0 0 64 64" aria-hidden="true">
        <rect width="64" height="64" rx="14" fill="#0b0e13"/>
        <path d="M8 48 L18 42 L26 44 L36 30 L46 32 L56 14" fill="none"
              stroke="#4ad991" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="56" cy="14" r="5" fill="#4ad991"/>
      </svg>
      <span class="brand-name">Robot&nbsp;Claude</span>
      <span class="brand-beta" title="Сервис в стадии активного бета-тестирования. Возможны изменения функционала, переключения серверов и кратковременные перебои.">BETA</span>
    </a>
    <nav class="site-nav" aria-label="Primary">${navLinksHtml}</nav>
    <div class="site-nav-end">
      ${authPillHtml}
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

  // Phase O — Carousel arrows + edge-fade hint, sitewide. Any element
  // marked [data-carousel="true"] with a child .rc-carousel-track gets
  // clickable « / » buttons and a fade-out gradient at start/end edges.
  // Touch devices hide the buttons (swipe is natural there); the fade
  // stays everywhere so non-techy visitors notice the carousel can move.
  const carouselBlock = `
<style>
  /* Wrapper allows arrows to sit OUTSIDE the scroll track (in the
     section's side padding zone) instead of floating over the first
     and last visible card. */
  [data-carousel="true"] {
    position: relative;
  }
  /* Edge fade — narrower (40px instead of 56px) and starts from a
     softer alpha so there's no hard vertical line over the card edge. */
  [data-carousel="true"]::before,
  [data-carousel="true"]::after {
    content: '';
    position: absolute; top: 0; bottom: 14px;
    width: 40px;
    pointer-events: none;
    z-index: 2;
    transition: opacity 200ms;
  }
  [data-carousel="true"]::before {
    left: 0;
    background: linear-gradient(90deg, rgba(11,14,19,0.85) 0%, rgba(11,14,19,0.55) 50%, rgba(11,14,19,0) 100%);
  }
  [data-carousel="true"]::after {
    right: 0;
    background: linear-gradient(270deg, rgba(11,14,19,0.85) 0%, rgba(11,14,19,0.55) 50%, rgba(11,14,19,0) 100%);
  }
  [data-carousel="true"].rc-at-start::before,
  [data-carousel="focus"].rc-at-start::before { opacity: 0; }
  [data-carousel="true"].rc-at-end::after,
  [data-carousel="focus"].rc-at-end::after    { opacity: 0; }

  /* Focus mode — active card front-and-center, neighbours dimmed and
     scaled down so visitor sees one tier at a time but understands
     there are more behind. Opt-in via data-carousel="focus". */
  [data-carousel="focus"] {
    position: relative;
  }
  [data-carousel="focus"]::before,
  [data-carousel="focus"]::after {
    content: '';
    position: absolute; top: 0; bottom: 14px;
    width: 60px;
    pointer-events: none;
    z-index: 2;
    transition: opacity 200ms;
  }
  [data-carousel="focus"]::before {
    left: 0;
    background: linear-gradient(90deg, rgba(11,14,19,0.92) 0%, rgba(11,14,19,0.55) 55%, rgba(11,14,19,0) 100%);
  }
  [data-carousel="focus"]::after {
    right: 0;
    background: linear-gradient(270deg, rgba(11,14,19,0.92) 0%, rgba(11,14,19,0.55) 55%, rgba(11,14,19,0) 100%);
  }
  [data-carousel="focus"] .rc-carousel-track > * {
    scroll-snap-align: center;
    transition: transform 280ms ease, opacity 280ms ease, filter 280ms ease;
    transform: scale(0.88);
    opacity: 0.45;
    filter: saturate(0.7);
  }
  [data-carousel="focus"] .rc-carousel-track > .rc-card-active {
    transform: scale(1);
    opacity: 1;
    filter: saturate(1);
  }
  /* Mobile: focus-mode dimming + edge fade combined make the peeking
     neighbour cards visually murky AND the dark gradient eats into
     the active card text. On phones the swipe gesture already
     communicates «scroll for more», so we drop both effects: neighbours
     stay full-opacity, edge gradients are hidden.

     Critical: we also remove the scale-down on neighbours. The desktop
     pattern was «neighbours at scale(0.96), active at scale(1)» so
     active appears bigger. But scroll-snap positions the cards by their
     UNTRANSFORMED box, and then the post-snap transform expands the
     active card outward from its centre by 2% on each side — pushing
     the right edge ~7px past the viewport boundary. Cards now stay at
     scale(1) on mobile; dim/active distinction is opacity-only. */
  @media (max-width: 640px) {
    [data-carousel="true"]::before,
    [data-carousel="true"]::after,
    [data-carousel="focus"]::before,
    [data-carousel="focus"]::after { display: none; }
    [data-carousel="focus"] .rc-carousel-track > * {
      transform: none;
      opacity: 0.6;
      filter: none;
    }
    [data-carousel="focus"] .rc-carousel-track > .rc-card-active {
      transform: none;
      opacity: 1;
    }
  }
  .rc-carousel-arrow {
    position: absolute; top: 50%; transform: translateY(-50%);
    width: 42px; height: 42px;
    background: #14181f;
    border: 1px solid #2a323d;
    border-radius: 50%;
    color: #e8edf2;
    font-size: 22px; font-weight: 400;
    cursor: pointer;
    z-index: 4;
    display: flex; align-items: center; justify-content: center;
    line-height: 1;
    transition: background 150ms, border-color 150ms, opacity 200ms, transform 150ms;
    padding: 0;
    box-shadow: 0 4px 14px rgba(0,0,0,0.4);
  }
  .rc-carousel-arrow:hover {
    background: rgba(74, 217, 145, 0.18);
    border-color: rgba(74, 217, 145, 0.55);
    color: #4ad991;
    transform: translateY(-50%) scale(1.05);
  }
  .rc-carousel-arrow:disabled { opacity: 0.18; cursor: default; transform: translateY(-50%); }
  /* Arrows sit fully OUTSIDE the carousel content (–28px). Section has
     enough side padding for them to land in clear space without
     overlapping the first/last card. */
  .rc-carousel-arrow-prev { left: -28px; }
  .rc-carousel-arrow-next { right: -28px; }
  @media (max-width: 900px) {
    .rc-carousel-arrow-prev { left: -16px; }
    .rc-carousel-arrow-next { right: -16px; }
  }
  @media (max-width: 640px) {
    .rc-carousel-arrow { width: 36px; height: 36px; font-size: 19px; }
    .rc-carousel-arrow-prev { left: -4px; }
    .rc-carousel-arrow-next { right: -4px; }
  }
  @media (hover: none) and (pointer: coarse) {
    .rc-carousel-arrow { display: none; }
  }
</style>
<script>
  (function() {
    function ready(fn) {
      if (document.readyState !== 'loading') return fn();
      document.addEventListener('DOMContentLoaded', fn);
    }
    ready(function() {
      // Pick up both data-carousel="true" and the focus variant.
      var carousels = document.querySelectorAll('[data-carousel]');
      carousels.forEach(function(wrap) {
        var track = wrap.querySelector('.rc-carousel-track');
        var prev  = wrap.querySelector('[data-rc-prev]');
        var next  = wrap.querySelector('[data-rc-next]');
        if (!track) return;
        var isFocus = wrap.getAttribute('data-carousel') === 'focus';

        // ---- Looped carousel: clone last → prepend, clone first → append ----
        // Focus mode only — gives the «cards wrap around» feel so the
        // first card never has empty space on its left. Disabled when
        // there are <2 real cards (looping a single card is silly).
        var realCount = track.children.length;
        var loopable = isFocus && realCount >= 2;
        if (loopable) {
          var first = track.firstElementChild;
          var last  = track.lastElementChild;
          var cloneLast = last.cloneNode(true);
          var cloneFirst = first.cloneNode(true);
          cloneLast.classList.add('rc-clone');
          cloneFirst.classList.add('rc-clone');
          cloneLast.setAttribute('aria-hidden', 'true');
          cloneFirst.setAttribute('aria-hidden', 'true');
          track.insertBefore(cloneLast, first);
          track.appendChild(cloneFirst);
        }

        function realChildren() {
          var nodes = track.children;
          if (!loopable) return [].slice.call(nodes);
          var out = [];
          for (var i = 0; i < nodes.length; i++) {
            if (!nodes[i].classList.contains('rc-clone')) out.push(nodes[i]);
          }
          return out;
        }

        var isTeleporting = false;
        function alignToFirstReal() {
          if (!loopable) return;
          var firstReal = track.children[1]; // index 0 is the prepended clone
          if (!firstReal) return;
          var trackRect = track.getBoundingClientRect();
          var firstRect = firstReal.getBoundingClientRect();
          var firstCentre = firstRect.left + firstRect.width / 2 - trackRect.left + track.scrollLeft;
          var target = firstCentre - track.clientWidth / 2;
          isTeleporting = true;
          track.scrollTo({ left: target, behavior: 'auto' });
          // Release the lock on the next animation frame so the resulting
          // scroll event doesn't immediately re-trigger maybeTeleport.
          requestAnimationFrame(function() {
            requestAnimationFrame(function() { isTeleporting = false; });
          });
        }
        alignToFirstReal();

        function updateEdgeState() {
          // In looped mode the carousel never «ends» — keep both gradient
          // sides visible and both arrows active.
          if (loopable) {
            wrap.classList.remove('rc-at-start', 'rc-at-end');
            if (prev) prev.disabled = false;
            if (next) next.disabled = false;
            return;
          }
          var atStart = track.scrollLeft <= 4;
          var atEnd   = track.scrollLeft + track.clientWidth >= track.scrollWidth - 4;
          wrap.classList.toggle('rc-at-start', atStart);
          wrap.classList.toggle('rc-at-end',   atEnd);
          if (prev) prev.disabled = atStart;
          if (next) next.disabled = atEnd;
        }
        function updateActive() {
          if (!isFocus) return;
          // Pick the card whose centre is closest to the viewport centre.
          // Clones can become «active» momentarily — that's fine, the
          // teleport step below replaces them with the real twin.
          var trackRect = track.getBoundingClientRect();
          var viewCentre = trackRect.left + trackRect.width / 2;
          var bestCard = null;
          var bestDist = Infinity;
          for (var i = 0; i < track.children.length; i++) {
            var card = track.children[i];
            var r = card.getBoundingClientRect();
            var cardCentre = r.left + r.width / 2;
            var d = Math.abs(cardCentre - viewCentre);
            if (d < bestDist) { bestDist = d; bestCard = card; }
          }
          for (var j = 0; j < track.children.length; j++) {
            track.children[j].classList.toggle('rc-card-active', track.children[j] === bestCard);
          }
        }
        var teleportTimer = null;
        function maybeTeleport() {
          if (!loopable) return;
          if (isTeleporting) return; // suppress re-entry from our own scroll
          if (teleportTimer) clearTimeout(teleportTimer);
          // Debounce on scroll END — we only teleport after the user
          // actually finished moving, not during inertia. 200ms covers
          // smooth-scroll trails on most platforms.
          teleportTimer = setTimeout(function() {
            var nodes = track.children;
            if (nodes.length < 3) return;
            var trackRect = track.getBoundingClientRect();
            var viewCentre = trackRect.left + trackRect.width / 2;
            var firstClone = nodes[0]; // clone of LAST real card
            var lastClone  = nodes[nodes.length - 1]; // clone of FIRST real card
            var firstRect = firstClone.getBoundingClientRect();
            var lastRect  = lastClone.getBoundingClientRect();
            // Tight threshold: clone must be ESSENTIALLY centred —
            // within 25% of its own width from the viewport centre.
            // Previously the threshold was trackRect.width/2 which
            // matched as soon as the clone was even partially visible,
            // causing endless teleport-bounce.
            var tight = firstRect.width * 0.25;
            var firstCentre = firstRect.left + firstRect.width / 2;
            var lastCentre  = lastRect.left + lastRect.width / 2;
            // Scrolled past start → centre is on the prepended clone
            // → jump forward to the real-last twin.
            if (Math.abs(firstCentre - viewCentre) < tight) {
              var realLast = nodes[nodes.length - 2];
              var realLastRect = realLast.getBoundingClientRect();
              var jump = (realLastRect.left + realLastRect.width / 2) - viewCentre;
              isTeleporting = true;
              track.scrollTo({ left: track.scrollLeft + jump, behavior: 'auto' });
              requestAnimationFrame(function() {
                requestAnimationFrame(function() { isTeleporting = false; });
              });
            }
            // Scrolled past end → centre is on the appended clone
            // → jump back to the real-first twin.
            else if (Math.abs(lastCentre - viewCentre) < tight) {
              var realFirst = nodes[1];
              var realFirstRect = realFirst.getBoundingClientRect();
              var jump2 = (realFirstRect.left + realFirstRect.width / 2) - viewCentre;
              isTeleporting = true;
              track.scrollTo({ left: track.scrollLeft + jump2, behavior: 'auto' });
              requestAnimationFrame(function() {
                requestAnimationFrame(function() { isTeleporting = false; });
              });
            }
          }, 200);
        }
        function scrollByOne(dir) {
          var firstChild = track.firstElementChild;
          var step = firstChild
            ? firstChild.getBoundingClientRect().width + 16
            : track.clientWidth * 0.8;
          track.scrollBy({ left: dir * step, behavior: 'smooth' });
        }
        if (prev) prev.addEventListener('click', function() { scrollByOne(-1); });
        if (next) next.addEventListener('click', function() { scrollByOne(1);  });
        track.addEventListener('scroll', function() {
          updateEdgeState();
          updateActive();
          maybeTeleport();
        }, { passive: true });
        window.addEventListener('resize', function() {
          updateEdgeState();
          updateActive();
          alignToFirstReal();
        });
        updateEdgeState();
        updateActive();
        // Silence unused-var lint in case realChildren is dropped later.
        void realChildren;
      });
    });
  })();
</script>
`;

  // Phase O — «come-alive» effects taken from the home page and made
  // sitewide. Three independent pieces, all bail out on
  // prefers-reduced-motion or when the browser lacks IntersectionObserver:
  //   1. Scroll-progress bar — thin gradient line growing left→right at
  //      the top of every page as the user scrolls.
  //   2. Scroll-reveal — sections fade-up the moment they enter the
  //      viewport. Selector is broadened so .home-section, .at-section,
  //      .section, and anything with [data-reveal] participate.
  //   3. Magnetic CTA — primary buttons subtly translate toward the
  //      cursor on hover (desktop only).
  // CSS for .reveal, .scroll-progress, .btn-primary already lives in
  // pageShell so nothing extra is needed there.
  const effectsBlock = `
<div class="scroll-progress" aria-hidden="true"></div>
<script>
(function() {
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // 1. Scroll-reveal — fade-up sections as they enter the viewport.
  var revealSel = '.home-section, .at-section, .section, [data-reveal]';
  var sections = document.querySelectorAll(revealSel);
  if ('IntersectionObserver' in window && !reduce && sections.length > 0) {
    sections.forEach(function(el) { el.classList.add('reveal'); });
    var io = new IntersectionObserver(function(entries) {
      entries.forEach(function(en) {
        if (en.isIntersecting) {
          en.target.classList.add('is-visible');
          io.unobserve(en.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    sections.forEach(function(el) { io.observe(el); });
    // Anything already in view on first paint (hero, top sections)
    // reveals immediately so there's no first-frame blink.
    sections.forEach(function(el) {
      var r = el.getBoundingClientRect();
      if (r.top < window.innerHeight && r.bottom > 0) {
        el.classList.add('is-visible');
      }
    });
  }

  // 2. Scroll-progress bar.
  var bar = document.querySelector('.scroll-progress');
  if (bar) {
    var ticking = false;
    function update() {
      var d = document.documentElement;
      var max = d.scrollHeight - d.clientHeight;
      var pct = max > 0 ? (d.scrollTop / max) * 100 : 0;
      bar.style.width = pct + '%';
      ticking = false;
    }
    document.addEventListener('scroll', function() {
      if (!ticking) { requestAnimationFrame(update); ticking = true; }
    }, { passive: true });
    update();
  }

  // 3. Magnetic CTA — buttons softly follow the cursor on hover.
  if (!reduce && window.matchMedia('(hover: hover)').matches) {
    document.querySelectorAll('.btn-primary, .at-btn-primary, .at-btn-large').forEach(function(btn) {
      btn.addEventListener('mousemove', function(e) {
        var r = btn.getBoundingClientRect();
        var x = (e.clientX - r.left - r.width / 2) * 0.16;
        var y = (e.clientY - r.top - r.height / 2) * 0.16;
        btn.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)';
      });
      btn.addEventListener('mouseleave', function() {
        btn.style.transform = '';
      });
    });
  }
})();
</script>
`;

  // Phase L SEO — derive defaults for description, canonical, OG image.
  const defaultDescriptionRu = 'Robot Claude — автоматический криптотрейдинг на вашем Bybit-аккаунте по проверенным стратегиям. Прозрачная статистика, ключ без права на вывод, тарифы от $12/мес.';
  const defaultDescriptionEn = 'Robot Claude — automated crypto trading on your Bybit account using verified strategies. Open stats, withdraw-disabled API key, tiers from $12/mo.';
  const description = opts.description
    ?? (lang === 'en' ? defaultDescriptionEn : defaultDescriptionRu);
  const canonicalPath = opts.canonicalPath ?? '/';
  const canonicalUrl = `${PUBLIC_ORIGIN}${canonicalPath}`;
  const ogImage = opts.ogImage ?? `${PUBLIC_ORIGIN}/og-default.png`;
  const ogLocale = lang === 'en' ? 'en_US' : 'ru_RU';
  const ogAlt = lang === 'en' ? 'ru_RU' : 'en_US';
  const siteName = 'Robot Claude';

  // JSON-LD blocks — caller supplies pre-serialised JSON strings. Always
  // append the WebSite + Organization defaults so search engines have a
  // baseline graph even on pages that don't add anything extra.
  const baseLd: string[] = [
    jsonLdOrganization(),
    jsonLdWebSite(),
  ];
  const allLd = [...baseLd, ...(opts.jsonLd ?? [])];
  const jsonLdHtml = allLd
    .map((s) => `<script type="application/ld+json">${s}</script>`)
    .join('\n');

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="${robots}" />
${metaRefresh}
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}" />
<meta name="google-site-verification" content="${GOOGLE_VERIFICATION_TOKEN}" />
<link rel="canonical" href="${canonicalUrl}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="${siteName}" />
<meta property="og:locale" content="${ogLocale}" />
<meta property="og:locale:alternate" content="${ogAlt}" />
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:url" content="${canonicalUrl}" />
<meta property="og:image" content="${ogImage}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeHtml(title)}" />
<meta name="twitter:description" content="${escapeHtml(description)}" />
<meta name="twitter:image" content="${ogImage}" />
${faviconLink}
${jsonLdHtml}
<style>${STYLE}</style>
${metrikaScript}
</head>
<!-- Generative-search hints: this site explains Robot Claude — a SaaS
     copytrading platform that executes strategies on a user's Bybit
     futures account via API key (trade-only, no withdraw). Tiered
     pricing $12/mo–$580/mo by user deposit; Prof tier $99/mo with
     manual strategy controls. 14-day free trial + 30-day bonus for
     Bybit signups via referral. Public stats at /strategies.
-->
<body>
${siteHeader}
${carouselBlock}
${effectsBlock}
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

// ────────────────────────────────────────────────────────────────────────────
// Phase L — JSON-LD helpers for SEO + GEO
// ────────────────────────────────────────────────────────────────────────────

/** Organization schema — name, URL, contact, logo. Emitted on every page. */
export function jsonLdOrganization(): string {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'Robot Claude',
    url: PUBLIC_ORIGIN,
    logo: `${PUBLIC_ORIGIN}/og-default.png`,
    description: 'SaaS-сервис автоматизации криптотрейдинга на Bybit',
    sameAs: ['https://t.me/luxalgosignal', 'https://t.me/dboykod'],
    contactPoint: {
      '@type': 'ContactPoint',
      contactType: 'customer support',
      url: 'https://t.me/dboykod',
      availableLanguage: ['Russian', 'English'],
    },
  });
}

/** WebSite schema with SearchAction. Emitted on every page. */
export function jsonLdWebSite(): string {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'Robot Claude',
    url: PUBLIC_ORIGIN,
    inLanguage: ['ru-RU', 'en-US'],
    publisher: { '@type': 'Organization', name: 'Robot Claude' },
  });
}

/** Service / Product schema — used on landing pages that pitch a tier. */
export function jsonLdService(args: {
  name: string;
  description: string;
  priceUsd?: number;
}): string {
  const offers = args.priceUsd
    ? {
        '@type': 'Offer',
        price: args.priceUsd,
        priceCurrency: 'USD',
        priceSpecification: {
          '@type': 'UnitPriceSpecification',
          price: args.priceUsd,
          priceCurrency: 'USD',
          billingDuration: 'P1M',
        },
      }
    : undefined;
  const obj: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Service',
    name: args.name,
    description: args.description,
    provider: { '@type': 'Organization', name: 'Robot Claude' },
    areaServed: 'Worldwide',
  };
  if (offers) obj.offers = offers;
  return JSON.stringify(obj);
}

/** FAQPage schema — feed it our autotrading FAQ items. */
export function jsonLdFaqPage(items: Array<{ q: string; a: string }>): string {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((it) => ({
      '@type': 'Question',
      name: it.q,
      acceptedAnswer: {
        '@type': 'Answer',
        text: it.a.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      },
    })),
  });
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

/** Human-readable Russian timeframe name for the group-header card.
 *  «5m» → «5 минут», «1H» → «1 час», «4H» → «4 часа», «1D» → «День». */
function tfHumanRu(tf: string): string {
  const m = tfMinutes(tf);
  if (m < 60) return `${m} ${pluralRu(m, 'минута', 'минуты', 'минут')}`;
  if (m < 1440) {
    const h = m / 60;
    return `${h} ${pluralRu(h, 'час', 'часа', 'часов')}`;
  }
  if (m < 10080) {
    const d = m / 1440;
    return `${d} ${pluralRu(d, 'день', 'дня', 'дней')}`;
  }
  const w = m / 10080;
  return `${w} ${pluralRu(w, 'неделя', 'недели', 'недель')}`;
}

/** Combined live-trades feed across ALL strategies — used on /strategies
 *  to give visitors a single timeline of what shadow trading is doing.
 *  Active trades pinned at top, closed trades below with pagination. */
const FEED_PAGE_SIZE = 20;
const FEED_SORT_OPTIONS: ReadonlyArray<{ value: FeedSort; label: string }> = [
  { value: 'close_desc', label: 'Закрытие: сначала новые' },
  { value: 'close_asc',  label: 'Закрытие: сначала старые' },
  { value: 'entry_desc', label: 'Вход: сначала новые' },
  { value: 'entry_asc',  label: 'Вход: сначала старые' },
  { value: 'pnl_desc',   label: 'PnL: лучшие сверху' },
  { value: 'pnl_asc',    label: 'PnL: худшие сверху' },
];
function renderAllStrategiesFeed(
  page: number,
  sort: FeedSort = 'close_desc',
  /** Live-PnL views from /api/active-positions cache. Keyed by tradeId
   *  (e.g. «BNB#001») internally. Optional — feed degrades to «—» when
   *  the price feed is unreachable. */
  activeViews: import('../api/active-positions.js').ActivePositionView[] = [],
): string {
  const active = getAllActiveShadowTrades();
  const totalClosed = countAllClosedShadowTrades();
  const totalPages = Math.max(1, Math.ceil(totalClosed / FEED_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const offset = (safePage - 1) * FEED_PAGE_SIZE;
  const closed = getAllClosedShadowTrades(FEED_PAGE_SIZE, offset, sort);

  if (active.length === 0 && totalClosed === 0) {
    return `
      <div class="section">
        <div class="section-title">📋 Все сделки (shadow)</div>
        <div class="card"><div class="card-body">
          <div class="empty-state" style="padding: 24px 0;">
            ⏳ Пока ни одной сделки в shadow-режиме. Страница обновляется автоматически.
          </div>
        </div></div>
      </div>
    `;
  }

  // Strategy metadata column — links to the detail page, shows symbol +
  // timeframe + T# in a compact stack so the table doesn't get too wide.
  const stratCellHtml = (strategyId: string, tradeNum: number | null, fallbackId: number): string => {
    const cfg = STRATEGY_CONFIGS[strategyId];
    if (!cfg) {
      return `<span class="dim">${escapeHtml(strategyId)}</span>`;
    }
    const num = tradeNum ?? fallbackId;
    const tradeIdStr = formatStrategyTradeId(cfg, num);
    const symbol = cfg.symbol ?? 'ANY';
    return (
      `<a class="feed-strat-cell" href="/strategies/${escapeHtml(cfg.code)}">` +
        `<span class="feed-strat-id">${tradeIdStr}</span>` +
        `<span class="feed-strat-meta">${escapeHtml(symbol)} · ${escapeHtml(cfg.timeframe)}m</span>` +
      `</a>`
    );
  };

  // Reason labels — friendly Russian + tooltip explaining each. Maps the
  // internal close_reason / force_close_reason codes to a UI label.
  const reasonLabel = (t: LiveTradeFeedRow): { label: string; cls: string; title: string } => {
    // SL hit on Bybit (either we caught it directly, or reconciliation
    // saw the position was already closed by Bybit's safety stop).
    if (t.closeReason === 'sl_hit' || t.forceCloseReason === 'bybit_sl_hit') {
      return { label: 'Стоп-лосс', cls: 'reason-sl',
        title: 'Safety stop-loss сработал на Bybit' };
    }
    if (t.forceCloseReason === 'strategy_exit') {
      return { label: 'По стратегии', cls: 'reason-strat',
        title: 'Стратегия LuxAlgo прислала сигнал на выход (Builtin Exit)' };
    }
    if (t.forceCloseReason === 'reverse_signal') {
      return { label: 'Разворот', cls: 'reason-reverse',
        title: 'Стратегия прислала противоположный сигнал — позиция закрыта чтобы открыть новую в обратную сторону' };
    }
    if (t.forceCloseReason === 'time_guard') {
      return { label: 'Тайм-аут 24ч', cls: 'reason-time',
        title: 'Позиция держалась > 24ч без сигнала на выход — закрыта по тайм-гарду' };
    }
    if (t.forceCloseReason === 'manual_close') {
      return { label: 'Вручную', cls: 'reason-manual',
        title: 'Позиция закрыта вручную на Bybit (оператор или экстренная остановка). Не сигнал стратегии.' };
    }
    if (t.forceCloseReason === 'bybit_reconcile') {
      return { label: 'Реконсиль', cls: 'reason-manual',
        title: 'Позиция исчезла с Bybit между нашими проверками, точная причина не известна — записываем как реконсиль' };
    }
    return { label: t.closeReason ?? '—', cls: 'reason-strat', title: '' };
  };

  // Position notional — TRACK_C_NOTIONAL_USD for shadow trades (always $1000).
  const notionalStr = `$${TRACK_C_NOTIONAL_USD}`;

  // Two-line entry+exit cell — saves horizontal space compared to two
  // separate columns. Top = вход, bottom = выход (or "—" for active).
  const timeCellHtml = (entryAt: number, exitAt: number | null): string => {
    const exitLine = exitAt === null
      ? `<span class="feed-time-exit feed-time-exit-empty">— ещё открыта</span>`
      : `<span class="feed-time-exit">→ ${fmtDate(exitAt)}</span>`;
    return (
      `<div class="feed-time-cell">` +
        `<span class="feed-time-entry">${fmtDate(entryAt)}</span>` +
        exitLine +
      `</div>`
    );
  };

  // Build trade-id → live view map so each active row can render
  // its current P&L (updated server-side every 8s via the cache).
  const liveByTradeId = new Map<string, import('../api/active-positions.js').ActivePositionView>();
  for (const v of activeViews) liveByTradeId.set(v.tradeId, v);

  const activeRows = active.map((t: ActiveTradeFeedRow) => {
    const sideCls = t.side === 'long' ? 'side-long' : 'side-short';
    const ageMs = Date.now() - t.entryAt;
    // SL distance in % — gives a sense of how much risk the trade is taking.
    const slDistPct = t.sl !== null
      ? (Math.abs(t.entryPrice - t.sl) / t.entryPrice) * 100
      : null;
    const slCell = t.sl !== null
      ? `${t.sl.toFixed(4)} <span class="feed-sl-pct">(−${slDistPct!.toFixed(2)}%)</span>`
      : '—';
    // Look up live P&L by formatted trade-id (e.g. «BNB#001»). The
    // active-positions cache and the feed both use formatStrategyTradeId,
    // so the keys match deterministically.
    const cfg = STRATEGY_CONFIGS[t.strategyId];
    const tradeIdKey = cfg ? formatStrategyTradeId(cfg, t.strategyTradeNum ?? t.id) : null;
    const live = tradeIdKey ? liveByTradeId.get(tradeIdKey) : undefined;
    // Live cell: show «текущая цена + PnL в USD + %». Falls back to
    // «—» if the ticker fetch failed (cache miss / network glitch).
    // data-trade-id attribute lets a future client-side poller patch
    // these in place without a full re-render.
    let pnlCell: string;
    if (live) {
      const cls = live.pnlUsd >= 0 ? 'pos' : 'neg';
      const sign = live.pnlUsd >= 0 ? '+' : '−';
      const pctSign = live.pnlPct >= 0 ? '+' : '−';
      pnlCell =
        `<span class="feed-pnl-live" data-trade-id="${escapeHtml(tradeIdKey!)}">` +
          `<span class="mono ${cls}" data-pnl-usd>${sign}$${Math.abs(live.pnlUsd).toFixed(2)}</span>` +
          ` <span class="feed-pnl-pct ${cls}" data-pnl-pct>(${pctSign}${Math.abs(live.pnlPct).toFixed(2)}%)</span>` +
          `<span class="feed-pnl-live-meta">сейчас <span class="mono" data-current-price>${live.currentPrice.toFixed(4)}</span></span>` +
        `</span>`;
    } else {
      pnlCell = `<span class="dim" data-trade-id="${tradeIdKey ? escapeHtml(tradeIdKey) : ''}">—</span>`;
    }
    return `
      <tr class="feed-row-active">
        <td>${stratCellHtml(t.strategyId, t.strategyTradeNum, t.id)}</td>
        <td class="dt">${timeCellHtml(t.entryAt, null)}</td>
        <td class="dt">${fmtDuration(ageMs)}</td>
        <td><span class="${sideCls}">${t.side.toUpperCase()}</span></td>
        <td class="right mono">${notionalStr}</td>
        <td class="right mono">${t.entryPrice.toFixed(4)}</td>
        <td class="right mono">${slCell}</td>
        <td class="right">${pnlCell}</td>
        <td><span class="reason-pill reason-active" title="Позиция сейчас открыта, ждём сигнал выхода или SL">🟢 В работе</span></td>
      </tr>
    `;
  }).join('');

  const closedRows = closed.map((t: LiveTradeFeedRow) => {
    const cls = t.pnlUsd >= 0 ? 'pos' : 'neg';
    const sideCls = t.side === 'long' ? 'side-long' : 'side-short';
    const r = reasonLabel(t);
    const dur = fmtDuration(t.exitAt - t.entryAt);
    const pnlSign = t.pnlUsd >= 0 ? '+' : '−';
    const pctSign = t.pnlPct >= 0 ? '+' : '−';
    return `
      <tr>
        <td>${stratCellHtml(t.strategyId, t.strategyTradeNum, t.id)}</td>
        <td class="dt">${timeCellHtml(t.entryAt, t.exitAt)}</td>
        <td class="dt">${dur}</td>
        <td><span class="${sideCls}">${t.side.toUpperCase()}</span></td>
        <td class="right mono">${notionalStr}</td>
        <td class="right mono">${t.entryPrice.toFixed(4)}</td>
        <td class="right mono">${t.exitPrice.toFixed(4)}</td>
        <td class="right mono ${cls}">${pnlSign}$${Math.abs(t.pnlUsd).toFixed(2)} <span class="feed-pnl-pct ${cls}">(${pctSign}${Math.abs(t.pnlPct).toFixed(2)}%)</span></td>
        <td><span class="reason-pill ${r.cls}" title="${escapeHtml(r.title)}">${r.label}</span></td>
      </tr>
    `;
  }).join('');

  // Pagination — show first/prev/next/last + current page indicator.
  // Generates plain ?p=N&sort=… links so sort persists across pages.
  const sortQs = sort && sort !== 'close_desc' ? `&sort=${encodeURIComponent(sort)}` : '';
  const pageLink = (n: number, label: string, disabled: boolean, current = false): string => {
    if (disabled) return `<span class="feed-page-link feed-page-disabled">${label}</span>`;
    if (current) return `<span class="feed-page-link feed-page-current">${label}</span>`;
    return `<a class="feed-page-link" href="?p=${n}${sortQs}#feed">${label}</a>`;
  };
  const paginationHtml = totalClosed > FEED_PAGE_SIZE
    ? `
      <div class="feed-pagination">
        ${pageLink(1, '«', safePage === 1)}
        ${pageLink(Math.max(1, safePage - 1), '‹', safePage === 1)}
        <span class="feed-page-info">
          Страница <b>${safePage}</b> из <b>${totalPages}</b>
          <span class="dim">· ${totalClosed} закрытых сделок всего</span>
        </span>
        ${pageLink(Math.min(totalPages, safePage + 1), '›', safePage === totalPages)}
        ${pageLink(totalPages, '»', safePage === totalPages)}
      </div>
    `
    : '';

  const activeBlock = active.length > 0
    ? `
      <div class="feed-subsection">
        <div class="feed-subsection-title">
          <span class="pulse-dot active" aria-hidden="true"></span>
          Сейчас открыто: <b>${active.length}</b>
        </div>
      </div>
    `
    : '';

  // Inline sort selector — auto-submits on change. Plain GET form so it
  // works without JS; preserves the current page via hidden ?p=. JS hook
  // wires the «onchange → submit» behaviour for snappier UX.
  const sortOptionsHtml = FEED_SORT_OPTIONS.map((o) =>
    `<option value="${o.value}"${o.value === sort ? ' selected' : ''}>${escapeHtml(o.label)}</option>`,
  ).join('');
  const sortFormHtml = `
    <form method="GET" action="/strategies#feed" class="feed-sort-form">
      <label for="feed-sort-select" class="feed-sort-label">Сортировка</label>
      <select id="feed-sort-select" name="sort" class="feed-sort-select"
              onchange="this.form.submit()">
        ${sortOptionsHtml}
      </select>
      <input type="hidden" name="p" value="1"/>
      <noscript><button class="feed-sort-apply" type="submit">Применить</button></noscript>
    </form>
  `;

  const closedBlock = closed.length > 0
    ? `
      <div class="feed-subsection">
        <div class="feed-subsection-title">
          Закрытые · показано ${closed.length} из ${totalClosed}
        </div>
        ${sortFormHtml}
      </div>
    `
    : '';

  return `
    <div class="section" id="feed">
      <div class="section-title">
        📋 Все сделки в shadow
        <span class="refresh-note">⟳ обновляется каждые 60 сек</span>
      </div>

      ${activeBlock}
      ${closedBlock}

      <div class="card table-wrap">
        <table class="feed-table">
          <thead>
            <tr>
              <th>Стратегия</th>
              <th>Время сделки <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--text-faint);font-size:10.5px;">(UTC)</span></th>
              <th>Длительн.</th>
              <th>Сторона</th>
              <th class="right" title="Размер shadow-сделки — фиксированный $1000 на каждую">Объём</th>
              <th class="right">Entry</th>
              <th class="right" title="Цена выхода для закрытых, safety SL (и расстояние в %) для активных">Exit / SL</th>
              <th class="right">P&amp;L</th>
              <th>Причина выхода</th>
            </tr>
          </thead>
          <tbody>${activeRows}${closedRows}</tbody>
        </table>
      </div>

      <div class="feed-reason-legend">
        <b>Расшифровка причин:</b>
        <span class="reason-pill reason-strat">По стратегии</span> — exit-сигнал LuxAlgo. ·
        <span class="reason-pill reason-sl">Стоп-лосс</span> — сработал safety SL. ·
        <span class="reason-pill reason-reverse">Разворот</span> — пришёл противоположный сигнал. ·
        <span class="reason-pill reason-time">Тайм-аут</span> — позиция > 24ч без сигнала. ·
        <span class="reason-pill reason-manual">Вручную</span> — оператор закрыл руками на Bybit (экстренная остановка / тех.причины).
      </div>

      ${paginationHtml}
    </div>
  `;
}

function renderStrategyIndex(
  strategies: StrategyConfig[],
  authed: { displayName: string | null; phone: string | null } | null = null,
  page = 1,
  sort: FeedSort = 'close_desc',
  activeViews: import('../api/active-positions.js').ActivePositionView[] = [],
): string {
  // ---------- Portfolio aggregate ----------
  let totalClosed = 0;
  let totalOpen = 0;
  let totalWins = 0;
  let totalLosses = 0;
  let totalPnlUsd = 0;
  let runningCount = 0;
  let earliestLiveStart: number | null = null; // for portfolio «since X» label
  const openStrategyLabels: string[] = []; // e.g. ["BNB LONG", "XRP SHORT"]

  const enriched = strategies.map((s) => {
    const live = getStrategyLiveStats(s.id);
    totalClosed += live.closed;
    totalOpen += live.open;
    if (live.firstTradeAt && (!earliestLiveStart || live.firstTradeAt < earliestLiveStart)) {
      earliestLiveStart = live.firstTradeAt;
    }
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
  // posInGroup / groupSize are 1-indexed for human-readable "№3 из 5"
  // numbering inside the timeframe carousel.
  const renderRow = (
    e: typeof enriched[number],
    posInGroup: number,
    groupSize: number,
  ): string => {
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

    // LIVE row — only when there's something to show. Includes the
    // «since DATE» context so visitors see how much trading history
    // the % is based on (10 trades over 1 day ≠ 10 over 6 months).
    const sinceLabel = formatSinceDate(live.firstTradeAt, 'ru');
    const liveRow =
      live.closed > 0
        ? `<div class="row-stat-line">
            <span class="stat-tag">LIVE</span>
            <span class="${livePnlCls}"><b>${fmtUsd(live.netPnlUsd, true)}</b></span>
            <span class="dim">·</span>
            <span class="${livePnlCls}">${fmtPct(live.netPnlPct, true)}</span>
            <span class="dim">·</span>
            <span class="dim">${live.wins} прибыльных / ${live.losses} убыточных</span>
            ${sinceLabel ? `<span class="dim">·</span><span class="dim">${sinceLabel}</span>` : ''}
          </div>`
        : '';

    // SL row — shows BOTH numbers that matter:
    //   1) Strategy's slPct (price distance) — what gets sent to Bybit
    //   2) Real worst-case loss as % of deposit for a reference tier
    //      (Standard, min-depo $800) — the number that actually hits
    //      the user's wallet. Tier-margin makes wide-SL strategies safe
    //      because notional shrinks: e.g. UNI 30% SL × $20 notional =
    //      $6 = 0.75% of $800 deposit, even though the SL distance
    //      looks scary.
    const slPctStr = (s.slPct * 100).toFixed(1);
    const refTier = TIER_CONFIGS.standard;
    const refSize = computeTierTradeSize('standard', s.id);
    const slRow = refSize
      ? (() => {
          const worstUsd = s.slPct * refSize.notionalUsd;
          const pctOfMinDepo = (worstUsd / refTier.minBalanceUsdt) * 100;
          const pctCls = pctOfMinDepo <= 2 ? 'pos' : 'dim';
          return `<div class="row-stat-line">
            <span class="stat-tag stat-tag-sl">SL</span>
            <span><b>−${slPctStr}%</b> <span class="dim">от цены</span></span>
            <span class="dim">·</span>
            <span class="${pctCls}">≈ <b>${pctOfMinDepo.toFixed(2)}%</b> депо</span>
            <span class="dim" title="Расчёт на минимальном депо тарифа Standard ($800). Чем ниже тариф — тем меньше notional и тем меньше потеря в долларах при том же SL.">за SL на Standard ($800)</span>
          </div>`;
        })()
      : `<div class="row-stat-line">
          <span class="stat-tag stat-tag-sl">SL</span>
          <span><b>−${slPctStr}%</b> <span class="dim">от цены</span></span>
        </div>`;

    void posInGroup; void groupSize;
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
        ${slRow}
      </a>`;
  };

  // ---------- Group sections — each timeframe becomes a focus carousel ----------
  // Same pattern as the /autotrading pricing carousel: one active card
  // centered, neighbours dimmed via opacity. Arrow buttons on desktop,
  // swipe on mobile. Each card carries its position within the group
  // («№3 / 5») so the user can see how many strategies they're scrolling
  // through.
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
      const groupSize = rows.length;
      const cardsHtml = rows
        .map((row, i) => renderRow(row, i + 1, groupSize))
        .join('\n');

      // ----- Per-timeframe aggregates -----
      // Sum across all strategies in this group so the header card can
      // show «here's how the 5m strategies are doing AS A GROUP» — useful
      // when 1 strategy is dragging the others and the group-level number
      // tells the real story.
      let grpClosed = 0, grpWins = 0, grpLosses = 0, grpOpen = 0;
      let grpPnlUsd = 0;
      let grpEarliestAt: number | null = null;
      // Backtest aggregates — only count strategies that have a backtest.
      let btTradeSum = 0, btWeightedWr = 0, btWrDenom = 0;
      for (const { s, live } of rows) {
        grpClosed += live.closed;
        grpWins += live.wins;
        grpLosses += live.losses;
        grpOpen += live.open;
        grpPnlUsd += live.netPnlUsd;
        if (live.firstTradeAt && (!grpEarliestAt || live.firstTradeAt < grpEarliestAt)) {
          grpEarliestAt = live.firstTradeAt;
        }
        const bt = s.backtest;
        if (bt && bt.totalTrades > 0) {
          btTradeSum += bt.totalTrades;
          // Weight WR by trade count so high-volume strategies dominate
          // the avg (mirrors how a true portfolio-level WR is computed).
          btWeightedWr += bt.winRate * bt.totalTrades;
          btWrDenom += bt.totalTrades;
        }
      }
      const grpLiveWr = (grpWins + grpLosses) > 0
        ? Math.round((grpWins / (grpWins + grpLosses)) * 100)
        : null;
      const grpPnlCls = classForValue(grpPnlUsd);
      const grpBtAvgWr = btWrDenom > 0
        ? Math.round((btWeightedWr / btWrDenom) * 100)
        : null;
      const grpSinceLabel = formatSinceDate(grpEarliestAt, 'ru');

      // ----- Stats chips for the header -----
      // Only show LIVE chips when there's actual live history; only show
      // BACKTEST chips when at least one strategy has a backtest. Empty
      // groups get a softer «нет данных» row.
      const chips: string[] = [];
      if (grpClosed > 0) {
        chips.push(`<span class="tf-stat tf-stat-live"><span class="tf-stat-dot"></span>LIVE</span>`);
        chips.push(`<span class="tf-stat"><span class="tf-stat-label">сделок</span><b>${grpClosed}</b></span>`);
        if (grpLiveWr !== null) {
          const wrCls = grpLiveWr >= 50 ? 'pos' : 'neg';
          chips.push(`<span class="tf-stat"><span class="tf-stat-label">побед</span><b class="${wrCls}">${grpLiveWr}%</b></span>`);
        }
        chips.push(`<span class="tf-stat"><span class="tf-stat-label">PnL</span><b class="${grpPnlCls}">${fmtUsd(grpPnlUsd, true)}</b></span>`);
        if (grpOpen > 0) {
          chips.push(`<span class="tf-stat tf-stat-open">🟢 ${grpOpen} в работе</span>`);
        }
      } else if (btTradeSum > 0) {
        chips.push(`<span class="tf-stat tf-stat-bt">БЭКТЕСТ</span>`);
        chips.push(`<span class="tf-stat"><span class="tf-stat-label">сделок</span><b>${btTradeSum}</b></span>`);
        if (grpBtAvgWr !== null) {
          chips.push(`<span class="tf-stat"><span class="tf-stat-label">побед в среднем</span><b>${grpBtAvgWr}%</b></span>`);
        }
        chips.push(`<span class="tf-stat tf-stat-await">ждём первый сигнал</span>`);
      }

      const headerCard = `
        <div class="tf-group-card">
          <div class="tf-group-card-top">
            <span class="tf-group-tf-chip">${tfLabel(String(tf))}</span>
            <span class="tf-group-tf-name">${tfHumanRu(String(tf))}</span>
            <span class="tf-group-count-pill">${groupSize} ${pluralRu(groupSize, 'стратегия', 'стратегии', 'стратегий')}</span>
            ${grpSinceLabel && grpClosed > 0 ? `<span class="tf-group-since">${grpSinceLabel}</span>` : ''}
          </div>
          ${chips.length > 0 ? `<div class="tf-group-card-stats">${chips.join('')}</div>` : ''}
        </div>`;

      // Collapsible per-TF list — replaces the old horizontal carousel.
      // Operator: «уберем слайдер, лучше сделаем раскрывающийся список».
      // The <details>/<summary> pair gives the toggle for free with no JS;
      // the summary IS the headerCard (clicking anywhere on it expands).
      // open attribute on the first (smallest TF) group so visitors see
      // SOMETHING expanded without having to click.
      const openByDefault = tf === sortedTfs[0];
      return `
        <details class="tf-group tf-group-details" ${openByDefault ? 'open' : ''}>
          <summary class="tf-group-summary">
            ${headerCard}
            <span class="tf-group-chevron" aria-hidden="true">▾</span>
          </summary>
          <div class="tf-group-list" role="region" aria-label="Стратегии ${tfLabel(String(tf))}">
            ${cardsHtml}
          </div>
        </details>`;
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
  const sinceTotal = formatSinceDate(earliestLiveStart, 'ru');
  const pnlSub = hasLiveData
    ? `$${TRACK_C_NOTIONAL_USD} на сделку${sinceTotal ? ` · ${sinceTotal}` : ''}`
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

    ${groupsHtml.length > 0 ? `
    <details class="tf-explainer">
      <summary>
        <span class="tf-explainer-icon">📊</span>
        <span class="tf-explainer-title">Как стратегии выглядят на графике?</span>
        <span class="tf-explainer-hint">пример ↓</span>
      </summary>
      <div class="tf-explainer-body">
        <p>
          На графике TradingView стратегия читает <b>несколько слоёв индикаторов
          LuxAlgo одновременно</b> — тренд, импульс, объём, ключевые ценовые
          уровни. Когда условия совпадают, рисуется стрелка вход/выход и
          одновременно срабатывает webhook, который наш сервис принимает и
          открывает позицию на Bybit.
        </p>
        <img src="/static/luxalgo-chart-example.jpg?v=1"
             alt="Пример графика TradingView с индикаторами LuxAlgo и сигналами Backtester"
             class="tf-explainer-screenshot"
             loading="lazy"/>
        <div class="tf-explainer-shot-caption">
          BTC/USDT 1H · видны зоны премии/дисконта (Premium/Discount),
          сигналы Scripted Long/Short, отметки выхода Scripted Exit,
          осциллятор настроения внизу.
        </div>
        <p class="tf-explainer-note">
          Вам этот график видеть не обязательно — это «под капотом». Сделки
          приходят в кабинет автоматически. Если хотите перепроверить, какой
          сигнал сработал — можно открыть страницу стратегии, там есть
          полный лог.
        </p>
      </div>
    </details>

    <details class="tf-explainer">
      <summary>
        <span class="tf-explainer-icon">🕐</span>
        <span class="tf-explainer-title">Что значат «5&nbsp;минут», «15&nbsp;минут», «1&nbsp;час»?</span>
        <span class="tf-explainer-hint">подробнее ↓</span>
      </summary>
      <div class="tf-explainer-body">
        <p>
          Это <b>таймфрейм</b> — на каких свечах графика стратегия ищет сигнал.
          У каждой стратегии свой ритм:
        </p>
        <div class="tf-explainer-grid">
          <div class="tf-explainer-row">
            <span class="tf-explainer-chip">5m</span>
            <div>
              <b>Скальпинг.</b> Сигнал на свечах по 5 минут. Сделки часто,
              быстро открываются и закрываются (обычно от 10 минут до пары часов).
            </div>
          </div>
          <div class="tf-explainer-row">
            <span class="tf-explainer-chip">15m</span>
            <div>
              <b>Внутри-дневная торговля.</b> Свечи по 15 минут. Сделок меньше,
              чем на 5m, но дольше живут — от часа до суток.
            </div>
          </div>
          <div class="tf-explainer-row">
            <span class="tf-explainer-chip">1H</span>
            <div>
              <b>Свинг-трейдинг.</b> Свечи по часу. Сигналов мало, но сделки
              могут идти днями и приносить больше за раз.
            </div>
          </div>
        </div>
        <p class="tf-explainer-note">
          На какой таймфрейм идти — решает <b>сама стратегия</b>, не вы.
          Мы её предварительно проверяем на истории и подбираем оптимальный ритм.
          Внутри тарифа вам ничего настраивать не нужно.
        </p>
      </div>
    </details>
    ` : ''}

    ${groupsHtml}
    ${empty}

    ${renderAllStrategiesFeed(page, sort, activeViews)}

    <script>
    // Live P&L polling for active rows in the trades feed.
    // Same /api/active-positions endpoint the home page uses (8s cache).
    // We poll every 12s — slightly slower than home (10s) because this
    // page has more body to keep light.
    (function() {
      var POLL_MS = 12000;
      function fmt(v, signed) {
        var sign = signed && v >= 0 ? '+' : (v < 0 ? '−' : '');
        return sign + Math.abs(v).toFixed(2);
      }
      function patch(views) {
        var byId = {};
        for (var i = 0; i < views.length; i++) byId[views[i].tradeId] = views[i];
        document.querySelectorAll('.feed-pnl-live').forEach(function(el) {
          var tid = el.getAttribute('data-trade-id');
          var v = byId[tid];
          if (!v) return;
          var cls = v.pnlUsd >= 0 ? 'pos' : 'neg';
          var usdEl = el.querySelector('[data-pnl-usd]');
          var pctEl = el.querySelector('[data-pnl-pct]');
          var pxEl = el.querySelector('[data-current-price]');
          if (usdEl) {
            usdEl.className = 'mono ' + cls;
            usdEl.textContent = (v.pnlUsd >= 0 ? '+' : '−') + '$' + Math.abs(v.pnlUsd).toFixed(2);
          }
          if (pctEl) {
            pctEl.className = 'feed-pnl-pct ' + cls;
            pctEl.textContent = '(' + (v.pnlPct >= 0 ? '+' : '−') + Math.abs(v.pnlPct).toFixed(2) + '%)';
          }
          if (pxEl) pxEl.textContent = v.currentPrice.toFixed(4);
        });
      }
      function poll() {
        if (document.hidden) return;
        fetch('/api/active-positions', { headers: { 'accept': 'application/json' } })
          .then(function(r) { return r.ok ? r.json() : null; })
          .then(function(j) { if (j && j.positions) patch(j.positions); })
          .catch(function() {});
      }
      if (document.querySelectorAll('.feed-pnl-live').length > 0) {
        setInterval(poll, POLL_MS);
      }
    })();
    </script>
    `,
    { autoRefreshSec: 60, authed },
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

function renderLiveSection(live: StrategyLiveStats, _launchedAt: number, cfg: StrategyConfig): string {
  // Two stacked sub-tables (when relevant):
  //  - ACTIVE: currently-open positions, with pulsing-green status badge
  //  - CLOSED: most recent closed positions
  // Section header reflects state with a coloured pulsing dot — green
  // dot + "позиция в работе" when active>0, red dot + "ждём сигнал"
  // when nothing's open.
  const active = getStrategyActiveTrades(cfg.id);
  const closed = getStrategyRecentTrades(cfg.id, 50);
  // Phase N — explicit «live started on DATE» note so the visitor sees
  // the sample period. Empty string when no live trades yet.
  const liveSince = formatSinceDate(live.firstTradeAt, 'ru');

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
    ${liveSince
      ? `<div class="live-since-note">Live-торговля на shadow-счёте ведётся <b>${liveSince}</b>. Все цифры ниже — реальные сделки, не симуляция.</div>`
      : ''}
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

function renderStrategyDetail(
  cfg: StrategyConfig,
  authed: { displayName: string | null; phone: string | null } | null = null,
): string {
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
    { autoRefreshSec: 60, authed },
  );
}

export async function landingRoute(app: FastifyInstance): Promise<void> {
  // ── Phase M language toggle ────────────────────────────────────────────
  // GET /set-lang/:lang → set the rclang cookie and 303-redirect back.
  // Both the public site header and any in-page «Switch to EN/RU» link
  // point here. Idempotent; safe with GET (just a preference cookie).
  app.get<{ Params: { lang: string } }>('/set-lang/:lang', async (req, reply) => {
    const lang = req.params.lang;
    if (lang !== 'ru' && lang !== 'en') {
      reply.code(400).send('bad lang');
      return;
    }
    reply.setCookie(LANG_COOKIE, lang, {
      path: '/',
      httpOnly: false,
      secure: true,
      sameSite: 'lax',
      maxAge: 365 * 24 * 60 * 60,
    });
    const referer = (req.headers.referer as string | undefined) ?? '/';
    // Sanitize referer — must be a relative URL or same-origin to avoid
    // open-redirect. Accept only paths starting with '/'.
    let safe = '/';
    try {
      const u = new URL(referer, PUBLIC_ORIGIN);
      if (u.origin === PUBLIC_ORIGIN) safe = u.pathname + u.search + u.hash;
    } catch { /* fall through to '/' */ }
    reply.code(303).header('location', safe).send();
  });

  // ── Phase L SEO routes ──────────────────────────────────────────────────
  // (Yandex Webmaster removed — RU IP blocks made it unreachable. Only
  // Google Search Console is supported; verified via DNS TXT + meta tag.)

  // /robots.txt — allow most, point to sitemap, restrict /account.
  app.get('/robots.txt', async (_req, reply) => {
    reply.type('text/plain; charset=utf-8');
    reply.header('Cache-Control', 'public, max-age=86400');
    return [
      'User-agent: *',
      'Allow: /',
      'Disallow: /account',
      'Disallow: /auth',
      'Disallow: /admin',
      'Disallow: /webhook',
      'Disallow: /api/',
      '',
      `Sitemap: ${PUBLIC_ORIGIN}/sitemap.xml`,
      '',
    ].join('\n');
  });

  // /sitemap.xml — list public marketing pages + every enabled strategy.
  app.get('/sitemap.xml', async (_req, reply) => {
    const enabled = Object.values(STRATEGY_CONFIGS).filter((s) => s.enabled);
    const lastmod = new Date().toISOString().slice(0, 10);
    const urls: Array<{ loc: string; priority: string; changefreq: string }> = [
      { loc: '/', priority: '1.0', changefreq: 'daily' },
      { loc: '/en', priority: '0.8', changefreq: 'daily' },
      { loc: '/autotrading', priority: '0.9', changefreq: 'weekly' },
      { loc: '/strategies', priority: '0.7', changefreq: 'daily' },
    ];
    for (const s of enabled) {
      urls.push({ loc: `/strategies/${s.code}`, priority: '0.6', changefreq: 'daily' });
    }
    const body = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      ...urls.map((u) =>
        `  <url><loc>${PUBLIC_ORIGIN}${u.loc}</loc><lastmod>${lastmod}</lastmod>` +
        `<changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`),
      '</urlset>',
    ].join('\n');
    reply.type('application/xml; charset=utf-8');
    reply.header('Cache-Control', 'public, max-age=3600');
    return body;
  });

  // /llms.txt — emerging standard analogue of robots.txt for AI agents.
  // Spec-compliant minimal version: name + summary + sections of useful links.
  app.get('/llms.txt', async (_req, reply) => {
    reply.type('text/plain; charset=utf-8');
    reply.header('Cache-Control', 'public, max-age=86400');
    return [
      '# Robot Claude',
      '',
      '> Robot Claude is a SaaS copytrading service that executes verified',
      '> trading strategies on a user\'s Bybit USDT-perp futures account via',
      '> an API key (trade-only, no withdraw). User funds stay on Bybit;',
      '> the platform never accepts deposits and cannot withdraw funds.',
      '',
      '## Pricing tiers',
      '',
      `- **Starter** ($12/mo, deposit $300–$799, ${TIER_CONFIGS.starter.strategyIds.length} strategies)`,
      `- **Standard** ($35/mo, deposit $800–$2 499, ${TIER_CONFIGS.standard.strategyIds.length} strategies)`,
      `- **Plus** ($90/mo, deposit $2 500–$5 999, ${TIER_CONFIGS.plus.strategyIds.length} strategies)`,
      `- **Pro** ($235/mo, deposit $6 000–$14 999, ${TIER_CONFIGS.pro.strategyIds.length} strategies, larger sizes)`,
      '- **VIP** ($580/mo, deposit $15 000+, custom)',
      `- **Prof** ($99/mo, manual control of position size + leverage, ${TIER_CONFIGS.prof.strategyIds.length} strategies)`,
      '',
      '## Key pages',
      '',
      `- [Home](${PUBLIC_ORIGIN}/) — live trades and stats`,
      `- [Auto-trading pitch](${PUBLIC_ORIGIN}/autotrading) — how it works, tiers, FAQ`,
      `- [Strategies index](${PUBLIC_ORIGIN}/strategies) — full per-strategy stats`,
      '',
      '## Risk note',
      '',
      'Crypto-derivatives trading carries risk of total loss. Users accept',
      'all trading risks. The platform is software automation, not a',
      'financial advisor or fund. Past performance does not guarantee',
      'future returns.',
      '',
      '## Contact',
      '',
      '- Telegram signals channel: https://t.me/luxalgosignal',
      '- Operator support: https://t.me/dboykod',
      '',
    ].join('\n');
  });

  // Index of all enabled strategies. Gated — anonymous visitors see a
  // blurred preview with a registration form overlay; authed visitors
  // see the real dashboard.
  app.get('/strategies', async (req, reply) => {
    const enabled = Object.values(STRATEGY_CONFIGS).filter((s) => s.enabled);
    const q = (req.query ?? {}) as { from?: string; login?: string; p?: string; sort?: string };
    const fromAutotrading = q.from === 'autotrading';
    const loginMode = q.login === '1';
    // Feed pagination — clamped 1..N inside renderAllStrategiesFeed.
    const page = Number.parseInt(q.p ?? '1', 10);
    const safePage = Number.isFinite(page) && page > 0 ? page : 1;
    // Feed sort selector — whitelist against the known FeedSort union.
    const validSorts: FeedSort[] = ['close_desc', 'close_asc', 'entry_desc', 'entry_asc', 'pnl_desc', 'pnl_asc'];
    const safeSort: FeedSort = validSorts.includes(q.sort as FeedSort)
      ? (q.sort as FeedSort)
      : 'close_desc';
    reply.type('text/html; charset=utf-8');
    // Authed users who came from an autotrading CTA or a login CTA
    // shouldn't see the strategies list — bounce them to /account.
    if ((fromAutotrading || loginMode) && isAuthed(req)) {
      reply.redirect('/account');
      return;
    }
    // Fetch live in-flight P&L (8s cached) so the feed's active rows
    // show real-time PnL instead of «—». Best-effort: degrades to no
    // live data if Bybit ticker is unreachable.
    const { getActivePositionsCached } = await import('../api/active-positions.js');
    let activeViews: import('../api/active-positions.js').ActivePositionView[] = [];
    try {
      activeViews = await getActivePositionsCached();
    } catch (err) {
      logger.warn({ err }, 'strategies-index: getActivePositionsCached failed');
    }
    if (!isAuthed(req)) {
      // No-cache on the gated stub so re-visits after auth get fresh HTML.
      reply.header('Cache-Control', 'private, no-store');
      return renderGatedPreview('index', renderStrategyIndex(enabled, null, safePage, safeSort, activeViews), { fromAutotrading, loginMode, lang: getLang(req) });
    }
    // Personalised header for authed users — must NOT be public-cached.
    reply.header('Cache-Control', 'private, no-store');
    const u = getAuthedUser(req);
    const authed = u ? { displayName: u.displayName, phone: u.phone } : null;
    return renderStrategyIndex(enabled, authed, safePage, safeSort, activeViews);
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
      return renderGatedPreview('detail', renderStrategyDetail(cfg), { lang: getLang(req) });
    }
    // Personalised header — same caching concern as the index page.
    reply.header('Cache-Control', 'private, no-store');
    const u = getAuthedUser(req);
    const authed = u ? { displayName: u.displayName, phone: u.phone } : null;
    return renderStrategyDetail(cfg, authed);
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
  opts: { fromAutotrading?: boolean; loginMode?: boolean; lang?: 'ru' | 'en' } = {},
): string {
  const lang = opts.lang ?? 'ru';
  const t = lang === 'en'
    ? {
        loginTitle: 'Sign in to your account',
        registerTitleAuto: '14-day trial + up to 30 days bonus via referral',
        registerTitleDefault: 'Unlock detailed statistics',
        loginSub: 'Enter your phone — we will send a 6-digit code on Telegram. We already have your name.',
        registerSubAuto: 'Enter your name and phone — we will send a 6-digit code on Telegram. After confirming you will land in your dashboard and can connect your Bybit account.',
        registerSubDefault: 'Enter your name and phone — we will send a 6-digit code through the official Telegram verification service.',
        namePlaceholder: 'How should we address you?',
        phoneLabel: 'Phone number linked to your Telegram',
        phoneHint: 'Full international format: <b>+</b> country code + number. Examples: <code>+1</code> USA, <code>+44</code> UK, <code>+49</code> Germany, <code>+7</code> Russia.',
        btnRegister: 'Sign up',
        btnLogin: 'Sign in',
        toggleToLogin: 'Already registered?',
        toggleToLoginLink: 'Sign in',
        toggleToRegister: 'New here?',
        toggleToRegisterLink: 'Sign up',
        trustCodeFrom: 'Code arrives from',
        trustOfficial: 'This is the official Telegram service. We never access your account.',
        trustPrivacy: 'Your phone is stored only for verification, never shared with third parties.',
        tgStep1: 'Open <b>Telegram</b> on your phone or computer',
        tgStep2Prefix: 'Find the chat ',
        tgStep3: 'Copy the 6-digit code from the latest message and enter it below',
        codePlaceholder: '123456',
        btnConfirm: 'Confirm',
        resend: 'No code? Wait 30 seconds — Telegram sometimes delivers with a delay.',
        editPhone: '← Change number',
        cookieNote: 'Cookie is saved for 90 days — you will not need to enter your number again.',
        // JS messages
        jsEnterName: 'Enter your name to continue',
        jsSendingCode: 'Sending code…',
        jsCodeSent: '✓ Code sent to',
        jsCodeSentVia: 'via Telegram',
        jsPhoneNotRegistered: 'This number is not registered. Enter your name and tap «Sign up».',
        jsSendFail: 'Could not send code. Check the number.',
        jsNetErr: 'Network error, try again later',
        jsCheckingCode: 'Verifying code…',
        jsAccessGranted: '✅ Access granted! Reloading…',
        jsWrongCode: 'Wrong code, try again',
      }
    : {
        loginTitle: 'Вход в личный кабинет',
        registerTitleAuto: '14 дней теста + до 30 дней бонусом по реф-ссылке',
        registerTitleDefault: 'Доступ к детальной статистике',
        loginSub: 'Введите номер — пришлём 6-значный код в Telegram. Имя у нас уже есть.',
        registerSubAuto: 'Введите имя и номер — отправим 6-значный код в Telegram. После подтверждения попадёте в личный кабинет и сможете подключить свой Bybit-аккаунт.',
        registerSubDefault: 'Введите имя и номер — отправим 6-значный код через официальный сервис подтверждения Telegram.',
        namePlaceholder: 'Как к вам обращаться?',
        phoneLabel: 'Номер телефона, к которому привязан ваш Telegram',
        phoneHint: 'Полный международный формат: <b>+</b> код страны + номер. Например: <code>+7</code> Россия, <code>+1</code> США, <code>+44</code> Великобритания, <code>+994</code> Азербайджан.',
        btnRegister: 'Зарегистрироваться',
        btnLogin: 'Войти',
        toggleToLogin: 'Уже регистрировались?',
        toggleToLoginLink: 'Войти',
        toggleToRegister: 'Впервые здесь?',
        toggleToRegisterLink: 'Зарегистрироваться',
        trustCodeFrom: 'Код придёт от',
        trustOfficial: 'Это официальный сервис Telegram. Мы не получаем доступ к вашему аккаунту.',
        trustPrivacy: 'Номер хранится только для подтверждения, третьим лицам не передаётся.',
        tgStep1: 'Откройте <b>Telegram</b> на телефоне или компьютере',
        tgStep2Prefix: 'Найдите чат ',
        tgStep3: 'Скопируйте 6-значный код из последнего сообщения и введите ниже',
        codePlaceholder: '123456',
        btnConfirm: 'Подтвердить',
        resend: 'Не пришёл код? Подождите 30 секунд — иногда Telegram доставляет с задержкой.',
        editPhone: '← Изменить номер',
        cookieNote: 'Cookie сохраняется на 90 дней — больше вводить номер не понадобится.',
        // JS messages
        jsEnterName: 'Введите имя, чтобы продолжить',
        jsSendingCode: 'Отправляем код…',
        jsCodeSent: '✓ Код отправлен на',
        jsCodeSentVia: 'через Telegram',
        jsPhoneNotRegistered: 'Этот номер не зарегистрирован. Введите имя и нажмите «Зарегистрироваться».',
        jsSendFail: 'Не удалось отправить код. Проверьте номер.',
        jsNetErr: 'Ошибка сети, попробуйте позже',
        jsCheckingCode: 'Проверяем код…',
        jsAccessGranted: '✅ Доступ открыт! Перезагружаем…',
        jsWrongCode: 'Неверный код, попробуйте ещё раз',
      };
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

  // 3-way framing of the gate:
  //   - loginMode → phone-only «Войти»; if phone unknown, page JS
  //     pivots to register flow with the phone pre-filled.
  //   - fromAutotrading → register flow with autotrading-style copy
  //   - default → register flow with "see-the-stats" copy
  const gateIcon = opts.loginMode ? '👋' : opts.fromAutotrading ? '🚀' : '🔒';
  const gateTitle = opts.loginMode
    ? t.loginTitle
    : opts.fromAutotrading
      ? t.registerTitleAuto
      : t.registerTitleDefault;
  const gateSub = opts.loginMode
    ? t.loginSub
    : opts.fromAutotrading
      ? t.registerSubAuto
      : t.registerSubDefault;
  // Initial mode for the JS controller. The form field rendering is
  // identical (name + phone); on login mode the name field is hidden
  // via CSS but the JS knows whether to send mode='login' or 'register'.
  const initialMode = opts.loginMode ? 'login' : 'register';

  // Pre-render both register + login copy so the JS toggle can swap
  // them in-place without a fresh server roundtrip. Visibility is
  // CSS-driven by [data-mode] on the wrapping #gate-phone-stage.
  const registerIcon = opts.fromAutotrading ? '🚀' : '🔒';
  const registerTitle = opts.fromAutotrading ? t.registerTitleAuto : t.registerTitleDefault;
  const registerSub = opts.fromAutotrading ? t.registerSubAuto : t.registerSubDefault;
  void gateIcon; void gateTitle; void gateSub; // initial values were used to set data-mode

  const formHtml = `
    <div class="gate-overlay">
      <div class="gate-card" data-mode="${initialMode}">
        <div class="gate-head">
          <span class="gate-icon gate-icon-register" aria-hidden="true">${registerIcon}</span>
          <span class="gate-icon gate-icon-login" aria-hidden="true">👋</span>
          <h2 class="gate-title">
            <span class="gate-title-register">${registerTitle}</span>
            <span class="gate-title-login">${t.loginTitle}</span>
          </h2>
        </div>
        <p class="gate-sub">
          <span class="gate-sub-register">${registerSub}</span>
          <span class="gate-sub-login">${t.loginSub}</span>
        </p>

        <!-- Stage 1: (name +) phone — name hidden in login mode -->
        <div id="gate-phone-stage">
          <form id="gate-phone-form" class="gate-form" novalidate>
            <div class="gate-name-field">
              <input type="text" name="name" placeholder="${t.namePlaceholder}"
                     maxlength="40" autocomplete="given-name" />
            </div>
            <label class="gate-phone-label" for="gate-phone-input">
              ${t.phoneLabel}
            </label>
            <input id="gate-phone-input" type="tel" name="phone" required
                   placeholder="+_ _ _ _ _ _ _ _ _ _ _"
                   inputmode="tel" autocomplete="tel" />
            <p class="gate-phone-hint">${t.phoneHint}</p>
            <button type="submit">
              <span class="gate-btn-label-register">${t.btnRegister}</span>
              <span class="gate-btn-label-login">${t.btnLogin}</span>
            </button>
          </form>
          <p class="gate-mode-toggle">
            <span class="gate-toggle-to-login">
              ${t.toggleToLogin} <a href="#" id="gate-switch-to-login">${t.toggleToLoginLink}</a>
            </span>
            <span class="gate-toggle-to-register">
              ${t.toggleToRegister} <a href="#" id="gate-switch-to-register">${t.toggleToRegisterLink}</a>
            </span>
          </p>
          <div class="gate-trust">
            <div class="gate-trust-row">
              <span class="gate-trust-icon">📱</span>
              <span>${t.trustCodeFrom} <a href="https://t.me/VerificationCodes" target="_blank" rel="noopener"><b>@VerificationCodes</b></a> <span class="gate-verified" title="Telegram official service">✓</span></span>
            </div>
            <div class="gate-trust-row">
              <span class="gate-trust-icon">🛡</span>
              <span>${t.trustOfficial}</span>
            </div>
            <div class="gate-trust-row">
              <span class="gate-trust-icon">🔐</span>
              <span>${t.trustPrivacy}</span>
            </div>
          </div>
        </div>

        <!-- Stage 2: code (hidden until phone submitted) -->
        <div id="gate-code-stage" style="display:none">
          <div class="gate-tg-instructions">
            <div class="gate-tg-step">
              <span class="gate-tg-num">1</span>
              <span>${t.tgStep1}</span>
            </div>
            <div class="gate-tg-step">
              <span class="gate-tg-num">2</span>
              <span>${t.tgStep2Prefix}<a href="https://t.me/VerificationCodes" target="_blank" rel="noopener" class="gate-tg-link">@VerificationCodes <span class="gate-verified">✓</span> →</a></span>
            </div>
            <div class="gate-tg-step">
              <span class="gate-tg-num">3</span>
              <span>${t.tgStep3}</span>
            </div>
          </div>
          <form id="gate-code-form" class="gate-form" novalidate>
            <input type="text" name="code" required placeholder="${t.codePlaceholder}"
                   inputmode="numeric" pattern="\\d{4,9}" maxlength="9"
                   autocomplete="one-time-code" />
            <button type="submit">${t.btnConfirm}</button>
          </form>
          <p class="gate-resend">
            ${t.resend} <a href="#" id="gate-back">${t.editPhone}</a>
          </p>
        </div>

        <div id="gate-msg" class="gate-msg"></div>
        <p class="gate-note">${t.cookieNote}</p>
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
          setMsg(${JSON.stringify(t.jsCodeSent)} + ' ' + masked + ' ' + ${JSON.stringify(t.jsCodeSentVia)});
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

        // Mode toggle. data-mode on .gate-card controls visibility of
        // every mode-specific element (icon, title, sub, name field,
        // button label, toggle links) via CSS. Single source of truth.
        var gateCard = document.querySelector('.gate-card');
        function getMode() {
          return gateCard ? (gateCard.getAttribute('data-mode') || 'register') : 'register';
        }
        function setMode(mode) {
          if (gateCard) gateCard.setAttribute('data-mode', mode);
          setMsg('');
          phoneForm.querySelector('button').disabled = false;
        }
        var toLogin = document.getElementById('gate-switch-to-login');
        var toRegister = document.getElementById('gate-switch-to-register');
        if (toLogin) toLogin.addEventListener('click', function(e) { e.preventDefault(); setMode('login'); phoneForm.phone.focus(); });
        if (toRegister) toRegister.addEventListener('click', function(e) { e.preventDefault(); setMode('register'); phoneForm.name.focus(); });

        phoneForm.addEventListener('submit', async function(e) {
          e.preventDefault();
          var mode = getMode();
          var name = phoneForm.name.value.trim();
          var phone = phoneForm.phone.value.trim();
          if (mode === 'register' && !name) {
            setMsg(${JSON.stringify(t.jsEnterName)}, true);
            phoneForm.name.focus();
            return;
          }
          setMsg(${JSON.stringify(t.jsSendingCode)});
          phoneForm.querySelector('button').disabled = true;
          try {
            var body = mode === 'login'
              ? { phone: phone, mode: 'login' }
              : { phone: phone, name: name, mode: 'register' };
            var res = await fetch('/auth/start', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            });
            var data = await res.json();
            if (!data.ok) {
              // Special-case: user typed a phone we don't know in login
              // mode → switch to register, pre-fill the phone, focus name.
              if (data.error === 'phone_not_registered') {
                setMode('register');
                setMsg(${JSON.stringify(t.jsPhoneNotRegistered)}, true);
                phoneForm.name.focus();
                phoneForm.querySelector('button').disabled = false;
                return;
              }
              setMsg(data.message || ${JSON.stringify(t.jsSendFail)}, true);
              phoneForm.querySelector('button').disabled = false;
              return;
            }
            showCodeStage(data.masked_phone || phone);
          } catch (err) {
            setMsg(${JSON.stringify(t.jsNetErr)}, true);
            phoneForm.querySelector('button').disabled = false;
          }
        });
        codeForm.addEventListener('submit', async function(e) {
          e.preventDefault();
          var code = codeForm.code.value.trim();
          setMsg(${JSON.stringify(t.jsCheckingCode)});
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
              setMsg(${JSON.stringify(t.jsAccessGranted)});
              setTimeout(function() { window.location.reload(); }, 800);
              return;
            }
            setMsg(${JSON.stringify(t.jsWrongCode)}, true);
            codeForm.querySelector('button').disabled = false;
            codeForm.code.value = '';
            codeForm.code.focus();
          } catch (err) {
            setMsg(${JSON.stringify(t.jsNetErr)}, true);
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
  /* Gate overlay. transform: scale(1.02) adds depth behind the modal
     but on mobile it ALSO makes the page 2% wider than the viewport,
     creating 17-50px of horizontal scroll. Wrap in a fixed-size clipper
     so the scale stays purely visual and doesn't extend the document. */
  .gated-blur-clip { overflow: hidden; width: 100%; }
  .gated-blur {
    filter: blur(8px); pointer-events: none; user-select: none;
    transform: scale(1.02); transform-origin: top center;
  }
  .gate-overlay {
    position: fixed; inset: 0; z-index: 100;
    display: flex; align-items: center; justify-content: center;
    background: rgba(11, 14, 19, 0.6); backdrop-filter: blur(6px);
    padding: 24px;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }
  /* On short viewports (iOS keyboard up, landscape phone) center
   * alignment hides the submit button under the keyboard. Anchor
   * card to the top so user can scroll the panel itself. */
  @media (max-height: 640px), (max-width: 480px) {
    .gate-overlay { align-items: flex-start; padding-top: 16px; padding-bottom: 32px; }
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
  .gate-phone-label {
    color: var(--text-dim); font-size: 12px; line-height: 1.4;
    margin: 4px 0 -2px; display: block;
  }
  .gate-phone-hint {
    color: var(--text-dim); font-size: 11px; line-height: 1.5;
    margin: -2px 0 2px;
  }
  .gate-phone-hint code {
    background: var(--bg); border: 1px solid var(--border);
    padding: 1px 5px; border-radius: 4px; font-size: 10.5px;
    color: var(--text); font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }
  .gate-phone-hint b { color: var(--text); }

  /* Mode-driven visibility — single data-mode on .gate-card cascades to
     every mode-specific element (icon, title, sub, fields, button label,
     toggle links). data-mode=login → hide everything tagged -register
     and vice versa. */
  .gate-card[data-mode="login"]  .gate-icon-register,
  .gate-card[data-mode="login"]  .gate-title-register,
  .gate-card[data-mode="login"]  .gate-sub-register,
  .gate-card[data-mode="login"]  .gate-name-field,
  .gate-card[data-mode="login"]  .gate-btn-label-register,
  .gate-card[data-mode="login"]  .gate-toggle-to-login {
    display: none;
  }
  .gate-card[data-mode="register"] .gate-icon-login,
  .gate-card[data-mode="register"] .gate-title-login,
  .gate-card[data-mode="register"] .gate-sub-login,
  .gate-card[data-mode="register"] .gate-btn-label-login,
  .gate-card[data-mode="register"] .gate-toggle-to-register {
    display: none;
  }
  .gate-mode-toggle {
    text-align: center; font-size: 12.5px; color: var(--text-faint);
    margin-top: 10px;
  }
  .gate-mode-toggle a { color: var(--accent); text-decoration: none; }
  .gate-mode-toggle a:hover { text-decoration: underline; }
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
<div class="gated-blur-clip" aria-hidden="true"><div class="gated-blur">${bodyInner}</div></div>
${formHtml}
${script}
</body>
</html>`;
}
