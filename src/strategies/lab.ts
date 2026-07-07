/**
 * THE LAB — in-house paper-trading R&D surface (public, but clearly
 * separated from the live book).
 *
 * Custom (code-defined) strategies from src/backtest/strategies/ are
 * forward-tested here on a paper account. They are driven by the engine
 * runner (src/jobs/custom-runner.ts), NOT by LuxAlgo webhooks, and live on
 * a fully isolated `track='lab'`:
 *   - never enter the live aggregates / status.ts / admin portfolio,
 *   - never trip the live risk circuit-breaker (a lab SL hit can't pause
 *     the real book),
 *   - never fan out to user accounts,
 *   - never appear in the public /strategies list or any tier.
 *
 * When a lab strategy proves itself (≥15–20 net-positive paper trades), it
 * graduates: we add a real STRATEGY_CONFIGS entry and promote it. Until
 * then it lives only at /lab, labelled «эксперимент».
 *
 * The registry lives in lab-registry.ts (no web deps, shared with the
 * backtest script + runner). This file is the page + route only. It reuses
 * the exact rich stats block from the live detail page (renderLiveStatsBlock)
 * — the stats functions are parameterised by track, so backtest == live ==
 * lab presentation, zero divergence.
 */

import type { FastifyInstance } from 'fastify';
import { pageShell, renderLiveStatsBlock, getLang } from './landing.js';
import {
  getStrategyLiveStats,
  getStrategyEquityExtras,
  getStrategyRecentTrades,
  getStrategyActiveTrades,
} from './live-stats.js';
import { TRACK_C_NOTIONAL_USD } from './track-c-config.js';
import { ALL_LAB_STRATEGIES, LAB_BY_CODE, LAB_BY_ID, LAB_TRACK, LAB_MAKER_TRACK, BT_NET_PCT_PER_TRADE, BT_MAXDD_PCT, type LabStrategy } from './lab-registry.js';
import { labGateVerdict } from '../lib/lab-gate.js';
import { allocatePortfolio, portfolioSummary } from '../lib/portfolio.js';
import { liveTrackHero, LIVE_TRACK_HERO_CSS } from './lab-track.js';

const trackOf = (s: LabStrategy): string => s.track ?? LAB_TRACK;

type Lang = 'ru' | 'en';
const t = (lang: Lang, ru: string, en: string): string => (lang === 'en' ? en : ru);

// ── tiny self-contained formatters (avoid coupling to landing internals) ──
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
function usd(n: number, signed = false): string {
  const sign = signed && n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}
function pct(n: number): string {
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(2)}%`;
}
function cls(n: number): string {
  return n > 0 ? 'pos' : n < 0 ? 'neg' : '';
}
function fmtDt(ms: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

const labBanner = (lang: Lang): string => `
  <div class="lab-banner">
    <span class="lab-pill">🧪 ${t(lang, 'ЭКСПЕРИМЕНТ · R&amp;D', 'EXPERIMENT · R&amp;D')}</span>
    ${t(lang,
      'Это <b>лаборатория</b>: собственные (кодовые) стратегии на <b>бумажной</b> торговле. ' +
      'Они НЕ входят в боевые тарифы, не торгуют на счетах подписчиков и проходят форвард-тест, ' +
      'прежде чем (если) стать боевыми. Прошлые и бумажные результаты не гарантируют будущих.',
      'This is the <b>lab</b>: in-house (code-defined) strategies on a <b>paper</b> account. ' +
      'They are NOT part of any live tier, never trade on subscriber accounts, and go through ' +
      'forward-testing before (if ever) going live. Past and paper results do not guarantee future ones.')}
  </div>`;

const LAB_CSS = `
  .lab-banner{background:var(--accent-soft);border:1px solid var(--accent-soft);border-radius:12px;
    padding:14px 16px;margin:0 0 20px;font-size:13.5px;color:var(--text-dim);line-height:1.5}
  .lab-banner b{color:var(--text)}
  .lab-pill{display:inline-block;background:var(--accent);color:var(--bg);font-weight:700;font-size:11px;
    letter-spacing:.04em;padding:3px 9px;border-radius:999px;margin-right:8px;vertical-align:middle}
  .lab-list{display:grid;gap:12px}
  .lab-row{display:block;background:var(--bg-card);border:1px solid var(--border);border-radius:12px;
    padding:14px 16px;text-decoration:none;color:var(--text);transition:border-color .15s}
  .lab-row:hover{border-color:var(--accent)}
  .lab-row-top{display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap}
  .lab-row-name{font-weight:600}
  .lab-row-code{font-family:ui-monospace,monospace;font-size:11px;color:var(--text-faint);margin-right:8px}
  .lab-row-sym{font-size:12px;color:var(--text-faint)}
  .lab-row-stats{display:flex;gap:18px;align-items:baseline;margin-top:8px;font-size:13px;flex-wrap:wrap}
  .lab-row-stats .k{color:var(--text-faint);font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin-right:5px}
  .lab-status{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--border)}
  .lab-status.work{color:var(--accent);border-color:var(--accent-soft);background:var(--accent-soft)}
  .lab-status.wait{color:var(--text-faint)}
  .lab-empty{color:var(--text-faint);font-size:13px;padding:20px 0;text-align:center}
  .lab-fam{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-faint);margin:18px 0 6px}
  .lab-fam-note{font-size:12px;color:var(--text-faint);margin:-2px 0 9px;line-height:1.45}
  .lab-fam-note b{color:var(--text-dim)}
  .lab-gate{margin-top:8px;font-size:12px;color:var(--text-faint)}
  .lab-gate.gate-ready{color:var(--accent);font-weight:600}
  .lab-gate.gate-underperforming{color:var(--danger)}
  .lab-gate.gate-diverging{color:#e0a23a}
  .lab-gate.gate-confirming{color:var(--text-dim)}
  .gate-banner{border:1px solid var(--border);border-radius:10px;padding:10px 14px;margin:0 0 16px;font-size:13px}
`;

/** Family grouping for the list, by strategy description. */
function familyOf(s: LabStrategy): string {
  const d = s.description;
  if (s.track === LAB_MAKER_TRACK || d.includes('Keltner') || d.includes('Z-score')) return 'Mean-reversion · maker (лимитки, низкий TF)';
  if (d.includes('Bollinger') || d.includes('RSI')) return 'Mean-reversion (откуп от средней, в сторону тренда)';
  if (d.includes('Donchian')) return 'Breakout (пробой канала)';
  if (d.includes('SMA') || (d.includes('EMA') && d.includes('cross')) || d.includes('ROC')) return 'Trend-following (следование тренду)';
  return 'Прочее';
}

/** Compact summary row for the /lab list. */
function labRow(s: LabStrategy): string {
  const live = getStrategyLiveStats(s.id, trackOf(s));
  const makerTag = s.track === LAB_MAKER_TRACK ? ' · <b>maker</b>' : '';
  const gate = labGateVerdict({ closed: live.closed, netPct: live.netPnlPct, winRate: live.winRate, btNetPctPerTrade: BT_NET_PCT_PER_TRADE[s.code] });
  const working = live.open > 0;
  const statusPill = working
    ? '<span class="lab-status work">🟢 в работе</span>'
    : `<span class="lab-status wait">${live.closed > 0 ? 'ждём сигнал' : 'нет сделок'}</span>`;
  const netCell = live.closed > 0
    ? `<span class="${cls(live.netPnlUsd)}">${pct(live.netPnlPct)} · ${usd(live.netPnlUsd, true)}</span>`
    : '<span class="lab-row-sym">—</span>';
  const wrCell = live.winRate !== null ? `${(live.winRate * 100).toFixed(0)}%` : '—';
  return `
    <a class="lab-row" href="/lab/${esc(s.code)}">
      <div class="lab-row-top">
        <div><span class="lab-row-code">[${esc(s.code)}]</span><span class="lab-row-name">${esc(s.name)}</span></div>
        ${statusPill}
      </div>
      <div class="lab-row-sym">${esc(s.symbol)} · ${esc(s.timeframe)}m · SL ${(s.slPct * 100).toFixed(0)}%${makerTag}</div>
      <div class="lab-row-stats">
        <span><span class="k">Net</span>${netCell}</span>
        <span><span class="k">WR</span>${wrCell}</span>
        <span><span class="k">Сделок</span>${live.closed}</span>
        <span><span class="k">Открыто</span>${live.open}</span>
      </div>
      <div class="lab-gate gate-${gate.status}">${gate.emoji} ${gate.label}</div>
    </a>`;
}

function renderLabList(lang: Lang): string {
  // Group rows by family for readability.
  const fams = new Map<string, LabStrategy[]>();
  for (const s of ALL_LAB_STRATEGIES) {
    const f = familyOf(s);
    (fams.get(f) ?? fams.set(f, []).get(f)!).push(s);
  }
  const body = ALL_LAB_STRATEGIES.length === 0
    ? `<div class="lab-empty">${t(lang,
        '<b>Лаборатория обновляется.</b><br>Старый набор медленных стратегий снят с форвард-теста. Сейчас в разработке — быстрые стратегии на событийных сигналах (ликвидации, фандинг, order-flow). Появятся здесь после прохождения kill-батареи и форвард-валидации.',
        '<b>The lab is being retooled.</b><br>The old set of slow strategies has been pulled from forward-testing. In the works now — fast strategies on event-driven signals (liquidations, funding, order-flow). They will appear here once they pass the kill-battery and forward-validation.')}</div>`
    : [...fams.entries()].map(([fam, list]) => {
        const note = fam.startsWith('Mean-reversion') && list.length > 1
          ? `<div class="lab-fam-note">${t(lang,
              `⚠ Это одна логика на ${list.length} монетах = <b>коррелированная ставка</b>, а не ${list.length} независимых. При промоуте лимитируются как единый кластер (общий лимит риска), иначе широкая просадка альтов откроет все разом.`,
              `⚠ This is one logic across ${list.length} coins = <b>a correlated bet</b>, not ${list.length} independent ones. On promotion they are capped as a single cluster (shared risk limit), otherwise a broad alt drawdown would open them all at once.`)}</div>`
          : '';
        return `<div class="lab-fam">${esc(fam)}</div>${note}<div class="lab-list">${list.map(labRow).join('')}</div>`;
      }).join('');
  const portfolioLink = ALL_LAB_STRATEGIES.length === 0
    ? ''
    : `<div style="margin:0 0 16px"><a class="lab-row" style="display:inline-block;padding:10px 14px" href="/lab/portfolio">💼 ${t(lang, 'План сайзинга портфеля (риск-паритет + кластер-кэп) →', 'Portfolio sizing plan (risk-parity + cluster cap) →')}</a></div>`;
  return pageShell(
    t(lang, 'Лаборатория — R&D стратегии (бумага)', 'Lab — R&D strategies (paper)'),
    `
    <div class="header">
      <span class="strat-code">IN-HOUSE ENGINE · PAPER</span>
      <h1 class="title">${t(lang, 'Лаборатория', 'The Lab')}</h1>
      <p class="subtitle">${t(lang, 'Собственные стратегии на форвард-тесте. Движок бэктеста == движок бумаги — никакого расхождения.', 'In-house strategies under forward-testing. The backtest engine == the paper engine — zero divergence.')}</p>
    </div>
    <style>${LAB_CSS}${LIVE_TRACK_HERO_CSS}</style>
    ${liveTrackHero(lang)}
    ${labBanner(lang)}
    ${portfolioLink}
    ${body}
    `,
    { autoRefreshSec: 60, lang },
  );
}

/** Recent paper trades — compact lab table (own renderer; not coupled to
 *  the live page's cfg-based table). */
function labTradesTable(strategyId: string, track: string): string {
  const trades = getStrategyRecentTrades(strategyId, 30, track);
  if (trades.length === 0) return '';
  const rows = trades.map((t) => {
    const c = cls(t.pnlPct);
    const sideCls = t.side === 'long' ? 'side-long' : 'side-short';
    const reason = t.closeReason === 'sl_hit' ? 'SL'
      : t.forceCloseReason === 'time_guard' ? 'time'
      : 'сигнал';
    return `<tr>
      <td>L#${t.strategyTradeNum ?? t.id}</td>
      <td class="dt">${fmtDt(t.entryAt)}</td>
      <td class="dt">${fmtDt(t.exitAt)}</td>
      <td><span class="${sideCls}">${t.side.toUpperCase()}</span></td>
      <td class="right mono">${t.entryPrice}</td>
      <td class="right mono">${t.exitPrice}</td>
      <td class="right mono ${c}">${pct(t.pnlPct)}</td>
      <td>${reason}</td>
    </tr>`;
  }).join('');
  return `
    <div class="section">
      <div class="section-subtitle">Бумажные сделки · последние ${trades.length}</div>
      <div class="card table-wrap"><table>
        <thead><tr><th>ID</th><th>Вход (UTC)</th><th>Выход (UTC)</th><th>Side</th>
          <th class="right">Entry</th><th class="right">Exit</th><th class="right">P&amp;L %</th><th>Выход</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>`;
}

function renderLabDetail(s: LabStrategy): string {
  const track = trackOf(s);
  const isMaker = s.track === LAB_MAKER_TRACK;
  const live = getStrategyLiveStats(s.id, track);
  const ex = getStrategyEquityExtras(s.id, track);
  const active = getStrategyActiveTrades(s.id, track);
  const gate = labGateVerdict({ closed: live.closed, netPct: live.netPnlPct, winRate: live.winRate, btNetPctPerTrade: BT_NET_PCT_PER_TRADE[s.code] });

  const activeBlock = active.length > 0
    ? `<div class="section"><div class="section-subtitle">Сейчас открыто: ${active.length}</div>
        <div class="card table-wrap"><table>
          <thead><tr><th>ID</th><th>Открыта (UTC)</th><th>Side</th><th class="right">Entry</th><th class="right">Размер</th><th>Статус</th></tr></thead>
          <tbody>${active.map((a) => `<tr>
            <td>L#${a.strategyTradeNum ?? a.id}</td>
            <td class="dt">${fmtDt(a.entryAt)}</td>
            <td><span class="${a.side === 'long' ? 'side-long' : 'side-short'}">${a.side.toUpperCase()}</span></td>
            <td class="right mono">${a.entryPrice}</td>
            <td class="right mono">$${TRACK_C_NOTIONAL_USD.toFixed(0)}</td>
            <td><span class="reason-pill reason-active">🟢 В работе</span></td>
          </tr>`).join('')}</tbody>
        </table></div></div>`
    : '';

  const statsBlock = ex.closed > 0
    ? renderLiveStatsBlock(live, ex, isMaker ? '0.04% maker (HL)' : '0.07% taker (HL)')
    : `<div class="card"><div class="card-body"><div class="empty-state" style="padding:24px 0;">
         ⏳ Бумажная торговля запущена, ждём ${isMaker ? 'заполнения лимитки' : 'первого сигнала стратегии'}.<br/>
         <span style="font-size:12px;color:var(--text-faint);">Движок проверяет рынок на каждом закрытии бара (${esc(s.timeframe)}m). Обновляется автоматически.</span>
       </div></div></div>`;

  return pageShell(
    `[${s.code}] ${s.symbol} ${s.timeframe}m — Лаборатория`,
    `
    <div class="header">
      <span class="strat-code">[${esc(s.code)}] · ${esc(s.symbol)} · ${esc(s.timeframe)}m · IN-HOUSE ENGINE</span>
      <h1 class="title">${esc(s.name)}</h1>
      <p class="subtitle">Лаборатория · бумажная торговля · <a href="/lab">все эксперименты</a></p>
    </div>
    <style>${LAB_CSS}</style>
    ${labBanner('ru')}

    <div class="gate-banner gate-${gate.status}">Форвард-гейт: ${gate.emoji} ${gate.label}${BT_NET_PCT_PER_TRADE[s.code] != null ? ` · бэктест ≈ ${BT_NET_PCT_PER_TRADE[s.code]!.toFixed(2)}%/сделку` : ''}</div>

    <div class="alert-id-card">
      <span class="alert-id-label">Логика</span>
      <code class="alert-id-value">${esc(s.description)}</code>
    </div>
    ${s.longDescription ? `<div class="card" style="margin-bottom:16px;"><div class="card-body"><div class="desc">${esc(s.longDescription)}</div></div></div>` : ''}

    <div class="section">
      <div class="section-title">Управление риском (бумага)</div>
      <div class="card"><div class="card-body"><div class="info-grid">
        <div class="info-item"><div class="lbl">Размер позиции</div><div class="val">$${TRACK_C_NOTIONAL_USD.toFixed(0)} номинал</div></div>
        <div class="info-item"><div class="lbl">Safety SL</div><div class="val">${(s.slPct * 100).toFixed(1)}% (предварит.)</div></div>
        <div class="info-item"><div class="lbl">Вход</div><div class="val">${isMaker ? 'лимит у полосы (maker)' : 'market на закрытии бара'}</div></div>
        <div class="info-item"><div class="lbl">Выход</div><div class="val">${isMaker ? 'лимит у средней / safety SL' : 'сигнал движка / safety SL'}</div></div>
      </div></div></div>
    </div>

    ${statsBlock}
    ${activeBlock}
    ${labTradesTable(s.id, track)}
    `,
    { autoRefreshSec: 60 },
  );
}

const PORTFOLIO_CAP = 10_000; // reference deployable capital for the $ column

/** Portfolio sizing plan: risk-parity (1/DD) + cluster cap, over all lab
 *  candidates. Real deployment would include only forward-confirmed
 *  (gate=ready) strategies — flagged below. */
function renderLabPortfolio(): string {
  const clusterOf = (s: LabStrategy): string => familyOf(s);
  const items = ALL_LAB_STRATEGIES.map((s) => ({ id: s.code, cluster: clusterOf(s), riskPct: BT_MAXDD_PCT[s.code] ?? 20 }));
  const alloc = allocatePortfolio(items, { clusterCap: 0.35 });
  const wById = new Map(alloc.map((a) => [a.id, a.weight]));
  const stats: Record<string, { expectancyPct: number; riskPct: number }> = {};
  for (const s of ALL_LAB_STRATEGIES) stats[s.code] = { expectancyPct: BT_NET_PCT_PER_TRADE[s.code] ?? 0, riskPct: BT_MAXDD_PCT[s.code] ?? 20 };
  const sum = portfolioSummary(alloc, stats);

  const fams = new Map<string, LabStrategy[]>();
  for (const s of ALL_LAB_STRATEGIES) { const c = clusterOf(s); (fams.get(c) ?? fams.set(c, []).get(c)!).push(s); }

  const blocks = [...fams.entries()].map(([c, list]) => {
    const cw = list.reduce((a, s) => a + (wById.get(s.code) ?? 0), 0);
    const head = `<tr class="pf-cl"><td colspan="5"><b>${esc(c)}</b> — ${(cw * 100).toFixed(0)}% · ${usd(cw * PORTFOLIO_CAP)} <span style="color:var(--text-faint);font-weight:400">(кэп кластера 35%)</span></td></tr>`;
    const rows = list.map((s) => {
      const w = wById.get(s.code) ?? 0;
      const g = labGateVerdict({ closed: getStrategyLiveStats(s.id, trackOf(s)).closed, netPct: getStrategyLiveStats(s.id, trackOf(s)).netPnlPct, winRate: null, btNetPctPerTrade: BT_NET_PCT_PER_TRADE[s.code] });
      return `<tr>
        <td><a href="/lab/${esc(s.code)}" style="color:var(--text)">${esc(s.code)} ${esc(s.name)}</a> ${g.emoji}</td>
        <td class="right">−${BT_MAXDD_PCT[s.code] ?? '?'}%</td>
        <td class="right">${(BT_NET_PCT_PER_TRADE[s.code] ?? 0).toFixed(2)}%</td>
        <td class="right"><b>${(w * 100).toFixed(1)}%</b></td>
        <td class="right">${usd(w * PORTFOLIO_CAP)}</td>
      </tr>`;
    }).join('');
    return head + rows;
  }).join('');

  return pageShell(
    'Портфель — план сайзинга',
    `
    <div class="header">
      <span class="strat-code">MONEY MANAGEMENT · ПЛАН ПО БЭКТЕСТУ</span>
      <h1 class="title">Портфель / сайзинг</h1>
      <p class="subtitle">Риск-паритет (вес ∝ 1/просадка) + кэп кластера 35% · <a href="/lab">← в лабораторию</a></p>
    </div>
    <style>${LAB_CSS}
      .pf-tbl{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}
      .pf-tbl th{text-align:left;color:var(--text-faint);font-weight:600;padding:7px 8px;border-bottom:1px solid var(--border)}
      .pf-tbl td{padding:7px 8px;border-bottom:1px solid var(--border)}
      .pf-tbl td.right,.pf-tbl th.right{text-align:right;font-variant-numeric:tabular-nums}
      .pf-tbl tr.pf-cl td{background:var(--accent-soft);border-top:1px solid var(--border)}
      .pf-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:16px 0}
      @media(max-width:560px){.pf-cards{grid-template-columns:1fr}}
    </style>
    <div class="lab-banner">
      <span class="lab-pill">💼 ПЛАН</span>
      Как распределить капитал по найденным краям: <b>равный риск</b> (тугая стратегия → больше денег, дикая → меньше)
      и <b>лимит на кластер 35%</b> (коррелированные края = одна ставка, не N). Числа — по бэктесту;
      в реальный запуск идут только <b>подтверждённые форвардом</b> (✅ в гейте). Капитал-пример: ${usd(PORTFOLIO_CAP)}.
    </div>
    <div class="pf-cards">
      <div class="stat-card"><div class="stat-label">Кластеров (диверсификация)</div><div class="stat-value">${sum.clusters}</div></div>
      <div class="stat-card"><div class="stat-label">Средневзв. просадка</div><div class="stat-value neg">−${sum.weightedRiskPct}%</div></div>
      <div class="stat-card"><div class="stat-label">Средневзв. эдж</div><div class="stat-value pos">${sum.weightedExpectancyPct.toFixed(2)}%/сделку</div></div>
    </div>
    <div class="card table-wrap"><table class="pf-tbl">
      <thead><tr><th>Стратегия</th><th class="right">Просадка</th><th class="right">Эдж/сд</th><th class="right">Вес</th><th class="right">$ из ${usd(PORTFOLIO_CAP)}</th></tr></thead>
      <tbody>${blocks}</tbody>
    </table></div>
    `,
    {},
  );
}

export async function labRoute(app: FastifyInstance): Promise<void> {
  app.get('/lab/portfolio', async (_req, reply) => {
    // The sizing plan is only meaningful with lab strategies present. While the
    // paper book is cleared, send visitors back to the lab index.
    if (ALL_LAB_STRATEGIES.length === 0) { reply.redirect('/lab'); return; }
    reply.type('text/html; charset=utf-8');
    reply.header('Cache-Control', 'public, max-age=60');
    return renderLabPortfolio();
  });

  app.get('/lab', async (req, reply) => {
    reply.type('text/html; charset=utf-8');
    reply.header('Cache-Control', 'public, max-age=30');
    return renderLabList(getLang(req));
  });

  app.get<{ Params: { code: string } }>('/lab/:code', async (req, reply) => {
    const s = LAB_BY_CODE.get(req.params.code) ?? LAB_BY_ID.get(req.params.code);
    const lang = getLang(req);
    reply.type('text/html; charset=utf-8');
    if (!s) {
      reply.code(404);
      return pageShell(t(lang, 'Не найдено', 'Not found'), `<div class="header"><h1 class="title">404</h1></div>
        <div class="empty-state">${t(lang, 'Эксперимент не найден. <a href="/lab">Все эксперименты</a>', 'Experiment not found. <a href="/lab">All experiments</a>')}</div>`, { lang });
    }
    reply.header('Cache-Control', 'public, max-age=30');
    return renderLabDetail(s);
  });
}
