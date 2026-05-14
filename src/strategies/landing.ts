import type { FastifyInstance } from 'fastify';
import {
  STRATEGY_CONFIGS,
  getStrategyConfig,
  type StrategyConfig,
  type BacktestSnapshot,
  TRACK_C_NOTIONAL_USD,
} from './track-c-config.js';
import { getStrategyLiveStats, type StrategyLiveStats } from './live-stats.js';

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
  .container { max-width: 980px; margin: 0 auto; padding: 32px 20px 80px; }
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
    display: inline-block; padding: 3px 8px; border-radius: 4px;
    font-size: 11px; font-weight: 500; text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .pill.live { background: var(--accent-soft); color: var(--accent); }
  .pill.shadow { background: rgba(245, 177, 77, 0.12); color: var(--warning); }
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
`;

function pageShell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="container">
${body}
<div class="footer">
  Данные обновляются автоматически из БД бота. Кэш: 60 сек.<br/>
  ⚠ Backtest ≠ guarantee. Прошлые результаты не гарантируют будущих.
</div>
</div>
</body>
</html>`;
}

function renderStrategyIndex(strategies: StrategyConfig[]): string {
  const rows = strategies
    .map((s) => {
      const live = getStrategyLiveStats(s.id);
      const livePnlClass = classForValue(live.netPnlPct);
      const pnlDisplay = live.closed > 0
        ? `<span class="${livePnlClass}">${fmtPct(live.netPnlPct, true)}</span>`
        : '<span style="color: var(--text-faint)">—</span>';
      return `
        <a href="/strategies/${escapeHtml(s.code)}" class="row" style="text-decoration: none; color: inherit;">
          <div class="meta">
            <div class="name">[STRAT-${escapeHtml(s.code)}] ${escapeHtml(s.symbol ?? 'ANY')} ${escapeHtml(s.timeframe)}m</div>
            <div class="sub">${escapeHtml(s.description.slice(0, 80))}${s.description.length > 80 ? '…' : ''}</div>
          </div>
          <div class="pnl">${pnlDisplay}<span class="sub" style="margin-left: 10px;">${live.closed} closed</span></div>
        </a>`;
    })
    .join('\n');

  const empty = strategies.length === 0
    ? '<div class="empty-state">Активных стратегий пока нет.</div>'
    : '';

  return pageShell(
    'Strategies',
    `
    <div class="header">
      <span class="strat-code">ROBOT CLAUDE</span>
      <h1 class="title">Активные стратегии</h1>
      <p class="subtitle">Live торговля LuxAlgo AI Strategy Builder · shadow mode</p>
    </div>
    <div class="card strategy-list">
      <div class="card-body">
        ${rows}
        ${empty}
      </div>
    </div>
    `,
  );
}

function renderBacktestSection(b: BacktestSnapshot): string {
  const pnlClass = classForValue(b.netPnlPct);
  const longClass = classForValue(b.longPnlPct);
  const shortClass = classForValue(b.shortPnlPct);

  return `
  <div class="section">
    <div class="section-title">Backtest · ${escapeHtml(b.periodLabel)} (${b.periodDays} дней)</div>
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Net P&L</div>
        <div class="stat-value ${pnlClass}">${fmtPct(b.netPnlPct, true)}</div>
        <div class="stat-sub ${pnlClass}">${fmtUsd(b.netPnlUsd, true)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Win Rate</div>
        <div class="stat-value">${(b.winRate * 100).toFixed(2)}%</div>
        <div class="stat-sub">${b.wins}W / ${b.losses}L · ${b.totalTrades} trades</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Profit Factor</div>
        <div class="stat-value">${b.profitFactor.toFixed(2)}</div>
        <div class="stat-sub">gross profit / gross loss</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Max Drawdown</div>
        <div class="stat-value neg">${b.maxDrawdownPct.toFixed(2)}%</div>
        <div class="stat-sub neg">${fmtUsd(-b.maxDrawdownUsd)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">CAGR</div>
        <div class="stat-value ${classForValue(b.cagrPct)}">${b.cagrPct.toFixed(2)}%</div>
        <div class="stat-sub">аннуализированная доходность</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Commission Paid</div>
        <div class="stat-value">${fmtUsd(b.commissionPaidUsd)}</div>
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
      </div></div>
    </div>
  </div>
  `;
}

function renderLiveSection(live: StrategyLiveStats, launchedAt: number): string {
  const launchLabel = new Date(launchedAt).toISOString().slice(0, 10);
  if (live.closed === 0 && live.open === 0) {
    return `
    <div class="section">
      <div class="section-title">Live · с ${launchLabel}</div>
      <div class="card"><div class="card-body">
        <div class="empty-state" style="padding: 24px 0;">
          ⏳ Ждём первого сигнала стратегии.<br/>
          <span style="font-size: 12px; color: var(--text-faint);">Backtest показывает ~1 сделка в 1.8 дня. Подождите.</span>
        </div>
      </div></div>
    </div>
    `;
  }
  const pnlClass = classForValue(live.netPnlPct);
  const wrDisplay = live.winRate !== null
    ? `${(live.winRate * 100).toFixed(0)}% (${live.wins}W / ${live.losses}L)`
    : '—';
  const exits = `${live.exitsStrategy} strat / ${live.exitsSafetySL} sl / ${live.exitsTimeGuard} time`;
  return `
  <div class="section">
    <div class="section-title">Live · с ${launchLabel} <span class="pill shadow">SHADOW MODE</span></div>
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Net P&L</div>
        <div class="stat-value ${pnlClass}">${fmtPct(live.netPnlPct, true)}</div>
        <div class="stat-sub ${pnlClass}">${fmtUsd(live.netPnlUsd, true)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Closed</div>
        <div class="stat-value">${live.closed}</div>
        <div class="stat-sub">${wrDisplay}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Open / Pending</div>
        <div class="stat-value">${live.open}</div>
        <div class="stat-sub">прямо сейчас</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Avg Duration</div>
        <div class="stat-value">${live.avgDurationMin !== null ? `${live.avgDurationMin}m` : '—'}</div>
        <div class="stat-sub">в минутах</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Largest Win</div>
        <div class="stat-value pos">${fmtUsd(live.largestWinUsd, true)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Largest Loss</div>
        <div class="stat-value neg">${fmtUsd(live.largestLossUsd, true)}</div>
      </div>
    </div>
    <div class="section">
      <div class="section-title">Структура выходов</div>
      <div class="card"><div class="card-body">
        <div class="desc">${escapeHtml(exits)}</div>
        <div style="margin-top: 10px; font-size: 12px; color: var(--text-faint);">
          <b>strat</b> — закрытие по сигналу стратегии (как в backtest) ·
          <b>sl</b> — safety SL 2.5% сработал ·
          <b>time</b> — 24ч time-guard
        </div>
      </div></div>
    </div>
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
          <div class="lbl">Time-guard</div>
          <div class="val">24 часа максимум</div>
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

    ${cfg.backtest ? renderBacktestSection(cfg.backtest) : ''}

    ${renderLiveSection(live, cfg.launchedAt)}

    ${renderRiskSection(cfg)}

    ${renderLogicSection(cfg)}
    `,
  );
}

export async function landingRoute(app: FastifyInstance): Promise<void> {
  // Index of all enabled strategies
  app.get('/strategies', async (_req, reply) => {
    const enabled = Object.values(STRATEGY_CONFIGS).filter((s) => s.enabled);
    reply.type('text/html; charset=utf-8');
    reply.header('Cache-Control', `public, max-age=${PAGE_CACHE_SECONDS}`);
    return renderStrategyIndex(enabled);
  });

  // Detail by code (e.g. /strategies/001)
  app.get<{ Params: { code: string } }>('/strategies/:code', async (req, reply) => {
    // Lookup by `code` (operator-friendly numeric tag) — first match wins.
    const cfg =
      Object.values(STRATEGY_CONFIGS).find((s) => s.code === req.params.code) ??
      // Fallback: maybe operator typed the id instead of the code
      getStrategyConfig(req.params.code);
    if (!cfg) {
      reply.code(404).type('text/html; charset=utf-8');
      return pageShell(
        'Not found',
        `<div class="header"><h1 class="title">404</h1></div><div class="empty-state">Стратегия не найдена. <a href="/strategies">Все стратегии</a></div>`,
      );
    }
    reply.type('text/html; charset=utf-8');
    reply.header('Cache-Control', `public, max-age=${PAGE_CACHE_SECONDS}`);
    return renderStrategyDetail(cfg);
  });
}
