import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { hlAccountValue } from '../exchange/hyperliquid-private.js';
import { getLang, pageShell } from './landing.js';

type Lang = 'ru' | 'en';
type Row = Record<string, unknown>;
type Runtime = {
  started_ns?: number; updated_ns?: number; counts?: Record<string, number>;
  pending_executions?: number; basis_required_minutes?: number;
  basis_progress_minutes?: Record<string, number>; basis_ready_symbols?: number;
  primary_trials?: number; primary_rejections?: number; primary_trades?: number;
  shutdown_reason?: string | null;
};
type MicroState = { baselineEquity?: number; consecutiveLosses?: number; active?: Row | null; stoppedReason?: string | null };
type Snapshot = {
  runtime: Runtime | null; state: MicroState | null; candidates: Row[]; approvals: Row[];
  rejections: Row[]; shadows: Row[]; audit: Row[]; equity: number | null;
};

const t = (lang: Lang, ru: string, en: string): string => lang === 'en' ? en : ru;
const esc = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]!));
const dataRoot = (): string => process.env.CROSSVENUE_RUNTIME_DIR ?? '/home/trader/apps/crossvenue-micro-v1/data';

async function readJson<T>(name: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(path.join(dataRoot(), name), 'utf8')) as T; }
  catch { return null; }
}

async function tailJsonl(name: string, limit = 200, bytes = 512_000): Promise<Row[]> {
  try {
    const filePath = path.join(dataRoot(), name);
    const stat = await fs.stat(filePath);
    const start = Math.max(0, stat.size - bytes);
    const handle = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(stat.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    await handle.close();
    let text = buffer.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return text.split('\n').filter(Boolean).slice(-limit).flatMap((line) => {
      try { return [JSON.parse(line) as Row]; } catch { return []; }
    });
  } catch { return []; }
}

async function snapshot(): Promise<Snapshot> {
  const [runtime, state, candidates, approvals, rejections, shadows, audit, account] = await Promise.all([
    readJson<Runtime>('shadow-runtime.json'), readJson<MicroState>('micro-live-state.json'),
    tailJsonl('candidates.jsonl', 100), tailJsonl('live_entry_approvals.jsonl', 100),
    tailJsonl('execution_rejections.jsonl', 200), tailJsonl('trades.jsonl', 200),
    tailJsonl('micro-live-audit.jsonl', 200), hlAccountValue(),
  ]);
  return { runtime, state, candidates, approvals, rejections, shadows, audit, equity: account.ok && !account.degraded ? account.data : null };
}

function fmtUtc(ns: unknown): string {
  const value = Number(ns);
  return Number.isFinite(value) && value > 0 ? new Date(value / 1e6).toISOString().slice(0, 19).replace('T', ' ') : '—';
}
function number(value: unknown, digits = 2): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}
function bpsPct(value: unknown, digits = 3): string {
  const n = Number(value);
  return Number.isFinite(n) ? `${(n / 100).toFixed(digits)}%` : '—';
}
function statusView(s: Snapshot): { live: boolean; progress: number; ready: number; required: number } {
  const updated = Number(s.runtime?.updated_ns ?? 0) / 1e6;
  const live = updated > 0 && Date.now() - updated < 30_000 && !s.runtime?.shutdown_reason;
  const required = Number(s.runtime?.basis_required_minutes ?? 60);
  const values = Object.values(s.runtime?.basis_progress_minutes ?? {});
  const progress = values.length ? Math.min(...values) : 0;
  return { live, progress, ready: Number(s.runtime?.basis_ready_symbols ?? 0), required };
}

export async function crossvenueHero(lang: Lang): Promise<string> {
  const s = await snapshot();
  const view = statusView(s);
  const closed = s.audit.filter((row) => row.event === 'closed');
  const pnl = closed.reduce((sum, row) => sum + Number(row.pnl ?? 0), 0);
  return `<a class="cv-hero" href="/lab/crossvenue">
    <div><span class="cv-badge">⚡ CROSS-VENUE · HYPERLIQUID · MICRO LIVE</span>
      <div class="cv-title">External Lead / HL Lag</div>
      <div class="cv-sub">${t(lang, 'Bybit + OKX · Binance наблюдение · публичный журнал →', 'Bybit + OKX · Binance observation · public ledger →')}</div>
    </div>
    <div class="cv-stats">
      <span><b class="${view.live ? 'ok' : 'bad'}">${view.live ? t(lang, 'РАБОТАЕТ', 'LIVE') : 'OFFLINE'}</b><small>${t(lang, 'движок', 'engine')}</small></span>
      <span><b>${view.ready}/20</b><small>${t(lang, 'прогрето', 'warmed')}</small></span>
      <span><b>${s.candidates.length}</b><small>${t(lang, 'сигналов*', 'signals*')}</small></span>
      <span><b class="${pnl > 0 ? 'ok' : pnl < 0 ? 'bad' : ''}">${pnl >= 0 ? '+' : ''}$${pnl.toFixed(3)}</b><small>${t(lang, 'real PnL', 'real PnL')}</small></span>
    </div>
  </a>`;
}

function candidateRows(rows: Row[], lang: Lang): string {
  if (!rows.length) return `<div class="cv-empty">${t(lang, 'Сигналов пока нет.', 'No signals yet.')}</div>`;
  return rows.slice(-20).reverse().map((row) => `<tr>
    <td>${fmtUtc(row.received_ns)}</td><td><b>${esc(row.symbol)}</b></td><td>${row.side === 'buy' ? 'LONG' : 'SHORT'}</td>
    <td>${bpsPct(row.external_return_bps)}</td><td>${bpsPct(row.raw_edge_bps)}</td>
    <td>${row.rejection ? esc(row.rejection) : '✓ signal'}</td></tr>`).join('');
}

function auditRows(rows: Row[], lang: Lang): string {
  const relevant = rows.filter((row) => ['opened', 'closed', 'entry_rejected', 'entry_unconfirmed', 'entry_unprotected_flatten', 'stopped'].includes(String(row.event)));
  if (!relevant.length) return `<div class="cv-empty">${t(lang, 'Реальных сделок пока нет.', 'No real trades yet.')}</div>`;
  return relevant.slice(-20).reverse().map((row) => `<tr><td>${esc(row.ts)}</td><td>${esc(row.event)}</td>
    <td><b>${esc(row.symbol ?? '—')}</b></td><td>${esc(row.side ?? '—')}</td>
    <td>${row.pnl == null ? '—' : `$${number(row.pnl, 4)}`}</td><td>${esc(row.reason ?? row.message ?? '—')}</td></tr>`).join('');
}

async function render(lang: Lang): Promise<string> {
  const s = await snapshot();
  const v = statusView(s);
  const counts = s.runtime?.counts ?? {};
  const primaryShadows = s.shadows.filter((row) => Number(row.latency_ms) === 200);
  const closed = s.audit.filter((row) => row.event === 'closed');
  const realPnl = closed.reduce((sum, row) => sum + Number(row.pnl ?? 0), 0);
  const rejectionRate = (s.runtime?.primary_trials ?? 0) > 0
    ? Number(s.runtime?.primary_rejections ?? 0) / Number(s.runtime?.primary_trials ?? 1) * 100 : null;
  const progressPct = Math.max(0, Math.min(100, v.progress / v.required * 100));
  const latestCandidate = s.candidates.at(-1);
  return pageShell(t(lang, 'Cross‑Venue Live — лаборатория', 'Cross‑Venue Live — Lab'), `
    <style>${CROSSVENUE_CSS}</style>
    <div class="cv-wrap">
      <a class="cv-back" href="/lab">${t(lang, '← Лаборатория', '← Lab')}</a>
      <div class="cv-head"><div><span class="cv-badge">CROSSVENUE-FORWARD-SHADOW-V1</span>
        <h1>External Lead / Hyperliquid Lag</h1>
        <p>${t(lang, 'Публичный монитор реального микроэксперимента. Показываем сигналы, отказы и убытки — не только удачные сделки.', 'Public monitor for the real-money micro experiment. Signals, rejections and losses are shown—not only winners.')}</p></div>
        <div class="cv-engine ${v.live ? 'live' : 'down'}"><i></i>${v.live ? t(lang, 'Движок работает', 'Engine live') : t(lang, 'Нет свежего heartbeat', 'No fresh heartbeat')}</div>
      </div>
      <div class="cv-grid">
        <div class="cv-card"><small>${t(lang, 'Текущий баланс', 'Current balance')}</small><b>${s.equity == null ? '—' : `$${s.equity.toFixed(6)}`}</b><em>${t(lang, 'Hyperliquid Unified Account', 'Hyperliquid Unified Account')}</em></div>
        <div class="cv-card"><small>${t(lang, 'Реальный PnL', 'Real PnL')}</small><b class="${realPnl > 0 ? 'pos' : realPnl < 0 ? 'neg' : ''}">${realPnl >= 0 ? '+' : ''}$${realPnl.toFixed(4)}</b><em>${closed.length} ${t(lang, 'закрытых сделок', 'closed trades')}</em></div>
        <div class="cv-card"><small>${t(lang, 'Кандидаты', 'Candidates')}</small><b>${s.candidates.length}</b><em>${s.approvals.length} ${t(lang, 'прошли исполнение', 'execution-approved')}</em></div>
        <div class="cv-card"><small>${t(lang, 'Отказы исполнения', 'Execution rejects')}</small><b>${s.rejections.length}</b><em>${rejectionRate == null ? '—' : `${rejectionRate.toFixed(1)}%`} primary</em></div>
        <div class="cv-card"><small>${t(lang, 'Shadow 200 ms', 'Shadow 200 ms')}</small><b>${primaryShadows.length}</b><em>${primaryShadows.length ? `${bpsPct(primaryShadows.reduce((a, r) => a + Number(r.net_bps ?? 0), 0) / primaryShadows.length)} avg` : '—'}</em></div>
        <div class="cv-card"><small>${t(lang, 'Защита', 'Risk guard')}</small><b>${s.state?.stoppedReason ? 'STOP' : '−$10'}</b><em>1× · $11 · max 1 · ${Number(s.state?.consecutiveLosses ?? 0)}/3 loss streak</em></div>
      </div>
      <section class="cv-panel"><div class="cv-panel-head"><h2>${t(lang, 'Прогрев и потоки', 'Warm-up and feeds')}</h2><span>${v.ready}/20 ready · ${v.progress}/${v.required} min</span></div>
        <div class="cv-progress"><i style="width:${progressPct.toFixed(1)}%"></i></div>
        <div class="cv-feeds">${['hyperliquid', 'bybit', 'okx', 'binance'].map((venue) => `<span><i></i>${venue}<b>${Number(counts[venue] ?? 0).toLocaleString('en-US')}</b></span>`).join('')}</div>
        <p class="cv-meta">${t(lang, 'Последнее обновление UTC', 'Last update UTC')}: ${fmtUtc(s.runtime?.updated_ns)} · pending ${Number(s.runtime?.pending_executions ?? 0)}${s.runtime?.shutdown_reason ? ` · STOP: ${esc(s.runtime.shutdown_reason)}` : ''}</p>
      </section>
      <section class="cv-panel"><h2>${t(lang, 'Правила эксперимента', 'Experiment rules')}</h2>
        <div class="cv-rules"><span>5s external move ≥ 0.10%</span><span>HL participation ≤ 75%</span><span>basis-adjusted edge ≥ 0.25%</span><span>60 completed minutes</span><span>depth check: $500</span><span>latency: 200 ms</span><span>hold: 15 sec</span><span>fees: 0.045%/side</span><span>book age ≤ 1 sec</span><span>slippage ≤ 0.20%</span></div>
        <p>${t(lang, 'Реальный ордер — $11 при 1×. Binance собирается как наблюдательный источник; торговый сигнал пока остаётся замороженным Bybit+OKX.', 'The real order is $11 at 1×. Binance is observational; the frozen trading signal remains Bybit+OKX.')}</p>
      </section>
      <section class="cv-panel"><div class="cv-panel-head"><h2>${t(lang, 'Последние сигналы', 'Latest signals')}</h2><span>${latestCandidate ? `${esc(latestCandidate.symbol)} · ${bpsPct(latestCandidate.raw_edge_bps)}` : '—'}</span></div>
        <div class="cv-table">${s.candidates.length ? `<table><thead><tr><th>UTC</th><th>Coin</th><th>Side</th><th>External</th><th>Edge</th><th>Status</th></tr></thead><tbody>${candidateRows(s.candidates, lang)}</tbody></table>` : candidateRows([], lang)}</div>
      </section>
      <section class="cv-panel"><h2>${t(lang, 'Реальный журнал', 'Real-money ledger')}</h2><div class="cv-table">${closed.length || s.audit.some((row) => row.event === 'opened') ? `<table><thead><tr><th>UTC</th><th>Event</th><th>Coin</th><th>Side</th><th>PnL</th><th>Reason</th></tr></thead><tbody>${auditRows(s.audit, lang)}</tbody></table>` : auditRows([], lang)}</div></section>
      <section class="cv-panel cv-hist"><h2>${t(lang, 'Историческое OOS — контекст, не обещание', 'Historical OOS — context, not a promise')}</h2>
        <b>166 ${t(lang, 'сделок · июнь–июль 2026', 'trades · June–July 2026')} · +0.213% avg net</b>
        <p>${t(lang, 'Историческая проверка была положительной после комиссий, но провалила критерии доступности исполнения и концентрации. Микрореал проверяет именно переносимость результата на живой рынок.', 'Historical testing was positive after fees but failed execution availability and concentration gates. The micro-live phase tests whether that result transfers to the live market.')}</p>
      </section>
      <p class="cv-note">${t(lang, 'Это исследовательский эксперимент с реальными деньгами, а не инвестиционная рекомендация. Положительный исторический результат не гарантирует будущую прибыль.', 'This is a real-money research experiment, not investment advice. Positive historical results do not guarantee future profit.')}</p>
    </div>`, { autoRefreshSec: 15, lang });
}

export async function crossvenueLabRoute(app: FastifyInstance): Promise<void> {
  app.get('/lab/crossvenue', async (req, reply) => {
    reply.type('text/html; charset=utf-8');
    reply.header('Cache-Control', 'public, max-age=5');
    return render(getLang(req));
  });
}

export const CROSSVENUE_CSS = `
.cv-hero{display:flex;justify-content:space-between;align-items:center;gap:18px;flex-wrap:wrap;margin:0 0 14px;padding:17px 20px;border:1px solid rgba(80,180,255,.32);border-radius:14px;background:linear-gradient(135deg,rgba(34,126,255,.13),var(--bg-card));color:var(--text);text-decoration:none}.cv-badge{display:inline-block;padding:4px 10px;border-radius:999px;background:rgba(34,126,255,.13);color:#62b3ff;font-size:11px;font-weight:750;letter-spacing:.04em}.cv-title{font-size:19px;font-weight:700;margin-top:8px}.cv-sub{font-size:13px;color:var(--text-dim);margin-top:3px}.cv-stats{display:flex;gap:22px}.cv-stats span{display:grid;text-align:right}.cv-stats b{font-size:18px}.cv-stats small{font-size:10px;color:var(--text-faint);text-transform:uppercase}.cv-stats .ok,.cv-card .pos{color:#38d996}.cv-stats .bad,.cv-card .neg{color:#ff6577}
.cv-wrap{max-width:1120px;margin:0 auto}.cv-back{display:inline-block;margin:4px 0 22px;color:var(--text-dim)}.cv-head{display:flex;justify-content:space-between;align-items:flex-start;gap:20px}.cv-head h1{font-size:34px;margin:12px 0 7px}.cv-head p{max-width:720px;color:var(--text-dim)}.cv-engine{display:flex;align-items:center;gap:8px;padding:9px 12px;border-radius:10px;background:var(--bg-card);white-space:nowrap}.cv-engine i,.cv-feeds i{width:8px;height:8px;border-radius:50%;background:#ff6577}.cv-engine.live i,.cv-feeds i{background:#38d996;box-shadow:0 0 10px rgba(56,217,150,.5)}.cv-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:24px 0}.cv-card,.cv-panel{background:var(--bg-card);border:1px solid var(--border);border-radius:14px}.cv-card{padding:16px;display:grid;gap:5px}.cv-card small,.cv-card em{color:var(--text-faint);font-size:11px;font-style:normal}.cv-card b{font-size:25px;font-variant-numeric:tabular-nums}.cv-panel{padding:18px;margin:12px 0}.cv-panel h2{font-size:17px;margin:0 0 14px}.cv-panel-head{display:flex;justify-content:space-between;gap:12px}.cv-panel-head span,.cv-meta{font-size:12px;color:var(--text-faint)}.cv-progress{height:7px;border-radius:9px;background:var(--bg);overflow:hidden}.cv-progress i{display:block;height:100%;background:linear-gradient(90deg,#287eff,#38d996)}.cv-feeds{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:14px}.cv-feeds span{display:flex;align-items:center;gap:7px;padding:9px;background:var(--bg);border-radius:9px;text-transform:capitalize;font-size:12px}.cv-feeds b{margin-left:auto;font-variant-numeric:tabular-nums}.cv-rules{display:flex;flex-wrap:wrap;gap:7px}.cv-rules span{padding:6px 9px;border-radius:8px;background:var(--bg);font-size:12px}.cv-panel p{color:var(--text-dim);font-size:13px}.cv-table{overflow:auto}.cv-table table{width:100%;border-collapse:collapse;font-size:12px}.cv-table th,.cv-table td{text-align:left;padding:9px;border-bottom:1px solid var(--border);white-space:nowrap}.cv-table th{color:var(--text-faint);font-size:10px;text-transform:uppercase}.cv-empty{padding:20px;text-align:center;color:var(--text-faint)}.cv-hist b{font-size:18px}.cv-note{font-size:12px;color:var(--text-faint);margin:18px 2px 40px}@media(max-width:760px){.cv-grid{grid-template-columns:repeat(2,1fr)}.cv-feeds{grid-template-columns:repeat(2,1fr)}.cv-head{display:block}.cv-engine{display:inline-flex;margin-top:8px}.cv-stats{width:100%;justify-content:space-between}.cv-stats span{text-align:left}}@media(max-width:460px){.cv-grid{grid-template-columns:1fr}.cv-head h1{font-size:27px}.cv-stats{gap:10px;flex-wrap:wrap}.cv-stats span{min-width:70px}}
`;
