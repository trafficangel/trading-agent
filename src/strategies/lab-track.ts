/**
 * LIVE TRACK — the public, honest record of the real-money book (wick-fade on
 * Hyperliquid). This is NOT the paper R&D lab (see lab.ts) — every row here is
 * real money on a real exchange, PnL net of commission. The page answers three
 * operator-requested questions, in order:
 *   1. что мы делаем   — what we do (general terms; NO strategy internals)
 *   2. реальные данные — real trades with entry points + result metrics, live from wick_fade_log
 *   3. к чему идём      — the vault roadmap (toward a public Hyperliquid vault)
 *
 * Data is queried DIRECTLY from wick_fade_log (mode='live') at render time — the
 * same table the live runner writes to, so the page can never diverge from reality.
 * Route: /lab/live. A hero card at the top of /lab links here.
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client.js';
import { pageShell } from './landing.js';
import { WF_CONFIG, COIN_X } from '../jobs/wick-fade-runner.js';

// ── real-money log rows ──
type WfRow = {
  id: number; coin: string; side: string; entry_px: number; qty: number; x: number | null;
  opened_at: number; exit_px: number | null; closed_at: number | null; pnl_pct: number | null; close_reason: string | null;
};
const closedStmt = db.prepare<[], WfRow>(`SELECT * FROM wick_fade_log WHERE mode='live' AND closed_at IS NOT NULL ORDER BY closed_at ASC`);
const openStmt = db.prepare<[], WfRow>(`SELECT * FROM wick_fade_log WHERE mode='live' AND closed_at IS NULL ORDER BY opened_at DESC`);

// ── formatters (self-contained; matches lab.ts style) ──
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
function usd(n: number, signed = false): string {
  const sign = signed && n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}
function pct(n: number, dp = 2): string {
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(dp)}%`;
}
const cls = (n: number): string => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');
function fmtDt(ms: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}
const notionalOf = (r: WfRow): number => r.qty * r.entry_px;
const usdOf = (r: WfRow): number => ((r.pnl_pct ?? 0) / 100) * notionalOf(r);
/** Format a computed price (target/stop) at the same decimal precision as the entry, so it lines up. */
function fmtPx(n: number, ref: number): string {
  const dp = Math.min(8, Math.max(2, (String(ref).split('.')[1] ?? '').length));
  return n.toFixed(dp);
}
/** Held duration since open, human-readable. */
function heldStr(openedMs: number, nowMs: number): string {
  const m = Math.max(0, Math.round((nowMs - openedMs) / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)}ч ${m % 60}м` : `${m}м`;
}

// ── aggregate stats over the real closed track ──
type TrackStats = {
  closed: number; wins: number; losses: number; winRate: number | null;
  netPct: number; netUsd: number; best: number; worst: number; avgPct: number;
  profitFactor: number | null; daysLive: number; open: number; cum: number[];
};
function computeStats(rows: WfRow[], open: number): TrackStats {
  const closed = rows.length;
  const pnls = rows.map((r) => r.pnl_pct ?? 0);
  const wins = pnls.filter((p) => p > 0).length;
  const losses = pnls.filter((p) => p < 0).length;
  const netPct = pnls.reduce((s, p) => s + p, 0);
  const netUsd = rows.reduce((s, r) => s + usdOf(r), 0);
  const grossWin = pnls.filter((p) => p > 0).reduce((s, p) => s + p, 0);
  const grossLoss = -pnls.filter((p) => p < 0).reduce((s, p) => s + p, 0);
  let cum = 0; const cumSeries: number[] = [];
  for (const p of pnls) { cum += p; cumSeries.push(cum); }
  const firstOpen = rows.length ? Math.min(...rows.map((r) => r.opened_at)) : Date.now();
  return {
    closed, wins, losses,
    winRate: wins + losses > 0 ? wins / (wins + losses) : null,
    netPct, netUsd,
    best: pnls.length ? Math.max(...pnls) : 0,
    worst: pnls.length ? Math.min(...pnls) : 0,
    avgPct: closed ? netPct / closed : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    daysLive: Math.max(1, Math.round((Date.now() - firstOpen) / 86_400_000)),
    open,
    cum: cumSeries,
  };
}

// ── compact cumulative-% equity curve (self-contained SVG) ──
function equityCurve(cum: number[]): string {
  if (cum.length < 2) return '';
  const W = 680, H = 180, padX = 12, padT = 16, padB = 20;
  const pts = [0, ...cum]; // start at 0
  const n = pts.length;
  const lo = Math.min(0, ...pts), hi = Math.max(0, ...pts);
  const span = hi - lo || 1;
  const innerW = W - padX * 2, innerH = H - padT - padB;
  const x = (i: number): number => padX + (i / (n - 1)) * innerW;
  const y = (v: number): number => padT + (1 - (v - lo) / span) * innerH;
  const yZero = y(0);
  const line = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(n - 1).toFixed(1)},${yZero.toFixed(1)} L${x(0).toFixed(1)},${yZero.toFixed(1)} Z`;
  const last = pts[n - 1]!;
  const stroke = last >= 0 ? 'var(--accent)' : 'var(--danger)';
  const fill = last >= 0 ? 'url(#eqPos)' : 'url(#eqNeg)';
  const dots = pts.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.2" fill="${stroke}"/>`).join('');
  return `
  <div class="eq-wrap">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="eq-svg" role="img" aria-label="Кривая накопленного результата, %">
      <defs>
        <linearGradient id="eqPos" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--accent)" stop-opacity="0.28"/><stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/></linearGradient>
        <linearGradient id="eqNeg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--danger)" stop-opacity="0.24"/><stop offset="100%" stop-color="var(--danger)" stop-opacity="0"/></linearGradient>
      </defs>
      <line x1="${padX}" y1="${yZero.toFixed(1)}" x2="${(W - padX).toFixed(1)}" y2="${yZero.toFixed(1)}" stroke="var(--border)" stroke-dasharray="3,4"/>
      <path d="${area}" fill="${fill}"/>
      <path d="${line}" fill="none" stroke="${stroke}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}
    </svg>
    <div class="eq-cap"><span>старт 0%</span><span class="${cls(last)}">${pct(last)} накопл.</span></div>
  </div>`;
}

// ── the vault roadmap (toward a public Hyperliquid vault) ──
type Stage = { status: 'done' | 'now' | 'next'; title: string; desc: string; meta?: string };
function roadmap(st: TrackStats): Stage[] {
  return [
    { status: 'done', title: 'Механика построена', meta: 'готово',
      desc: 'Движок исполнения на бирже, стопы прямо на бирже (не в коде), пакетные заявки, риск-контроль, автоматические предохранители при аномалиях и просадке.' },
    { status: 'now', title: 'Живая валидация', meta: `${st.closed} / ~100 сделок`,
      desc: 'Реальные деньги на малом капитале. Цель этой фазы — не прибыль, а честная статистика на настоящих комиссиях и проскальзывании. Каждая сделка ниже — из этого этапа.' },
    { status: 'next', title: 'Зелёный трек', meta: 'критерий выхода',
      desc: 'Устойчивый положительный результат на реальных издержках — на достаточной выборке и в разных рыночных режимах, а не на одном удачном окне.' },
    { status: 'next', title: 'Масштаб капитала', meta: '',
      desc: 'Увеличение депозита снимает лимиты биржи и даёт стратегии работать в полную силу — больше монет, более свежие котировки, выше частота.' },
    { status: 'next', title: 'Публичный вульт · Hyperliquid', meta: 'цель',
      desc: 'Вкладчики депонируют средства в ончейн-вульт, стратегия копируется автоматически и прозрачно. Управляющий держит собственную долю в вульте; комиссия берётся только с прибыли вкладчиков.' },
  ];
}

const TRACK_CSS = `
  .lt-intro{background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:18px 20px;margin:0 0 16px;line-height:1.6;color:var(--text-dim);font-size:14.5px}
  .lt-intro b{color:var(--text)}
  .lt-phase{display:flex;gap:12px;align-items:flex-start;background:var(--accent-soft);border:1px solid var(--accent-soft);border-radius:14px;padding:15px 18px;margin:0 0 22px;font-size:13.5px;color:var(--text-dim);line-height:1.55}
  .lt-phase .dot{flex:none;width:9px;height:9px;border-radius:50%;background:var(--accent);margin-top:6px;box-shadow:0 0 0 4px var(--accent-soft)}
  .lt-phase b{color:var(--text)}
  .lt-cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:0 0 24px}
  @media(max-width:820px){.lt-cards{grid-template-columns:repeat(2,1fr)}}
  .lt-stat{background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:14px 15px}
  .lt-stat .l{font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--text-faint)}
  .lt-stat .v{font-size:22px;font-weight:650;line-height:1.15;margin-top:5px;font-variant-numeric:tabular-nums}
  .lt-stat .v.pos{color:var(--accent)}.lt-stat .v.neg{color:var(--danger)}
  .lt-stat .s{font-size:12px;color:var(--text-dim);margin-top:3px}
  .lt-stat .s.pos{color:var(--accent)}.lt-stat .s.neg{color:var(--danger)}
  .eq-wrap{background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:14px 14px 10px}
  .eq-svg{width:100%;height:180px;display:block}
  .eq-cap{display:flex;justify-content:space-between;font-size:12px;color:var(--text-faint);margin-top:6px;font-variant-numeric:tabular-nums}
  .eq-cap .pos{color:var(--accent)}.eq-cap .neg{color:var(--danger)}
  .lt-tbl{width:100%;border-collapse:collapse;font-size:13px}
  .lt-tbl th{text-align:left;color:var(--text-faint);font-weight:600;padding:9px 10px;border-bottom:1px solid var(--border);font-size:11px;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap}
  .lt-tbl td{padding:9px 10px;border-bottom:1px solid var(--border);font-variant-numeric:tabular-nums}
  .lt-tbl td.r,.lt-tbl th.r{text-align:right}
  .lt-tbl .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
  .lt-tbl .dt{color:var(--text-faint);font-size:12px;white-space:nowrap}
  .lt-tbl tr:hover td{background:var(--bg-card-hover)}
  .sd{font-weight:650;font-size:11px;padding:1px 7px;border-radius:5px}
  .sd.long{color:var(--accent);background:var(--accent-soft)}
  .sd.short{color:var(--danger);background:var(--danger-soft)}
  .rp{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--border);color:var(--text-dim);white-space:nowrap}
  .rp.target{color:var(--accent);border-color:var(--accent-soft);background:var(--accent-soft)}
  .rp.cat{color:var(--danger);border-color:var(--danger-soft);background:var(--danger-soft)}
  .rp.open{color:var(--accent);border-color:var(--accent-soft);background:var(--accent-soft)}
  .rm{position:relative;margin:6px 0 0;padding:0}
  .rm-item{position:relative;padding:0 0 22px 30px}
  .rm-item::before{content:'';position:absolute;left:8px;top:20px;bottom:-2px;width:2px;background:var(--border)}
  .rm-item:last-child::before{display:none}
  .rm-dot{position:absolute;left:0;top:2px;width:18px;height:18px;border-radius:50%;border:2px solid var(--border);background:var(--bg-card)}
  .rm-item.done .rm-dot{border-color:var(--accent);background:var(--accent)}
  .rm-item.now .rm-dot{border-color:var(--accent);background:var(--bg);box-shadow:0 0 0 4px var(--accent-soft)}
  .rm-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
  .rm-title{font-weight:650;font-size:15px;color:var(--text)}
  .rm-item.next .rm-title{color:var(--text-dim)}
  .rm-meta{font-size:11px;padding:2px 8px;border-radius:999px;background:var(--bg-card);border:1px solid var(--border);color:var(--text-faint)}
  .rm-item.now .rm-meta{color:var(--accent);border-color:var(--accent-soft);background:var(--accent-soft)}
  .rm-desc{font-size:13.5px;color:var(--text-dim);line-height:1.55;margin-top:5px;max-width:640px}
  .lt-note{font-size:12px;color:var(--text-faint);line-height:1.55;margin:20px 0 0}
  .lt-back{display:inline-block;margin-bottom:6px;font-size:13px}
  .sd-lead{color:var(--text-dim);font-size:14px;line-height:1.6;margin:0 0 14px;max-width:780px}
  .sd-lead b{color:var(--text)}
  .sd-diag{background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:16px 14px 12px}
  .sd-svg{width:100%;height:auto;display:block}
  .sd-steps{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:14px 0 22px}
  @media(max-width:760px){.sd-steps{grid-template-columns:1fr}}
  .sd-step{background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:13px 15px}
  .sd-step .n{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:var(--accent);color:var(--bg);font-weight:700;font-size:12px;margin-bottom:8px}
  .sd-step.cat .n{background:var(--danger)}
  .sd-step h5{margin:0 0 5px;font-size:14px;color:var(--text)}
  .sd-step p{margin:0;font-size:12.5px;color:var(--text-dim);line-height:1.5}
  .sd-blocks{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media(max-width:760px){.sd-blocks{grid-template-columns:1fr}}
  .sd-block{background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:16px 18px}
  .sd-block h4{margin:0 0 11px;font-size:14px;color:var(--text)}
  .sd-block ul{margin:0;padding:0;list-style:none}
  .sd-block li{position:relative;padding:0 0 9px 18px;font-size:13px;color:var(--text-dim);line-height:1.5}
  .sd-block li:last-child{padding-bottom:0}
  .sd-block li::before{content:'';position:absolute;left:2px;top:7px;width:5px;height:5px;border-radius:50%;background:var(--accent)}
  .sd-block.risk li::before{background:var(--danger)}
  .sd-block b{color:var(--text)}
  .lt-days{display:flex;gap:10px;overflow-x:auto;padding:2px 2px 12px;-webkit-overflow-scrolling:touch;scroll-snap-type:x proximity}
  .lt-days::-webkit-scrollbar{height:8px}
  .lt-days::-webkit-scrollbar-track{background:transparent}
  .lt-days::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px}
  .lt-days{scrollbar-width:thin;scrollbar-color:var(--border) transparent}
  .lt-day{flex:0 0 auto;min-width:112px;background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:12px 14px;scroll-snap-align:start}
  .lt-day .d{font-size:11px;color:var(--text-faint);text-transform:uppercase;letter-spacing:.03em;white-space:nowrap}
  .lt-day .v{font-size:19px;font-weight:650;margin-top:7px;font-variant-numeric:tabular-nums;line-height:1.1}
  .lt-day .v.pos{color:var(--accent)}.lt-day .v.neg{color:var(--danger)}
  .lt-day .s{font-size:11px;color:var(--text-dim);margin-top:4px;white-space:nowrap}
  .lt-day.today{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
  .lt-day.today .d{color:var(--accent)}
`;

function tradesTable(rows: WfRow[]): string {
  // newest first for the table
  const ordered = [...rows].sort((a, b) => (b.closed_at ?? 0) - (a.closed_at ?? 0));
  const body = ordered.map((r) => {
    const p = r.pnl_pct ?? 0;
    const reasonCls = r.close_reason === 'target' ? 'target' : r.close_reason === 'catastrophe' ? 'cat' : '';
    const reasonLbl = r.close_reason === 'target' ? '🎯 цель' : r.close_reason === 'time-stop' ? '⏱ тайм-стоп' : r.close_reason === 'catastrophe' ? '🛑 стоп' : (r.close_reason ?? '—');
    return `<tr>
      <td>#${r.id}</td>
      <td><b>${esc(r.coin)}</b></td>
      <td><span class="sd ${r.side === 'long' ? 'long' : 'short'}">${r.side.toUpperCase()}</span></td>
      <td class="r mono">${r.entry_px}</td>
      <td class="r mono">${r.exit_px ?? '—'}</td>
      <td class="r mono">${r.x != null ? (r.x * 100).toFixed(1) + '%' : '—'}</td>
      <td class="r mono ${cls(p)}">${pct(p, 2)}</td>
      <td class="r ${cls(usdOf(r))}">${usd(usdOf(r), true)}</td>
      <td class="r mono" style="color:var(--text-faint)">${usd(notionalOf(r) * 0.05 / 100)}</td>
      <td><span class="rp ${reasonCls}">${reasonLbl}</span></td>
      <td class="dt">${fmtDt(r.opened_at)}</td>
    </tr>`;
  }).join('');
  return `<div class="card table-wrap"><table class="lt-tbl">
    <thead><tr>
      <th>#</th><th>Монета</th><th>Сторона</th>
      <th class="r">Вход</th><th class="r">Выход</th><th class="r">Глубина</th><th class="r">Результат</th><th class="r">P&amp;L $</th>
      <th class="r">Комиссия</th><th>Как закрыли</th><th>Открыта (UTC)</th>
    </tr></thead><tbody>${body}</tbody></table></div>`;
}

/** Currently-OPEN positions (closed_at IS NULL) — live entries the Telegram alert fires on, which the closed
 *  table can't show yet. Entry/target/stop derived exactly like the runner: target = pre-wick mid = entry/(1±x),
 *  stop = entry·(1±stopPct). DB-only (no exchange call) so the public page can't hang on an HL request. */
function openPositionsSection(nowMs: number): string {
  const open = openStmt.all();
  if (open.length === 0) return '';
  const stopPct = WF_CONFIG.stopPct;
  const body = open.map((r) => {
    const x = r.x ?? COIN_X[r.coin] ?? 0.03;
    const short = r.side === 'short';
    const target = short ? r.entry_px / (1 + x) : r.entry_px / (1 - x);
    const stop = short ? r.entry_px * (1 + stopPct) : r.entry_px * (1 - stopPct);
    return `<tr>
      <td>#${r.id}</td>
      <td><b>${esc(r.coin)}</b></td>
      <td><span class="sd ${short ? 'short' : 'long'}">${r.side.toUpperCase()}</span></td>
      <td class="r mono">${r.entry_px}</td>
      <td class="r mono">${(x * 100).toFixed(1)}%</td>
      <td class="r mono pos">${fmtPx(target, r.entry_px)}</td>
      <td class="r mono neg">${fmtPx(stop, r.entry_px)}</td>
      <td class="r">${usd(notionalOf(r))}</td>
      <td class="dt">${heldStr(r.opened_at, nowMs)}</td>
      <td><span class="rp open">🟢 в работе</span></td>
    </tr>`;
  }).join('');
  return `<div class="section">
    <div class="section-title">Открыто сейчас · ${open.length}</div>
    <div class="card table-wrap"><table class="lt-tbl">
      <thead><tr><th>#</th><th>Монета</th><th>Сторона</th><th class="r">Вход</th><th class="r">Глубина</th>
        <th class="r">Цель 🎯</th><th class="r">Стоп 🛑</th><th class="r">Размер</th><th>В работе</th><th>Статус</th></tr></thead>
      <tbody>${body}</tbody></table></div></div>`;
}

/** Detailed strategy explainer — a schematic SVG of the wick-fade mechanic + what it's based on, the data
 *  analysed, and the layered stops. Static (no data) — the credibility/depth surface for the vault pitch. */
function strategyDetail(universe: number): string {
  // Schematic (LONG / buy-the-dip): price rests at the mid, a flash wick pierces our deep bid (①), price
  // reverts to the mid = exit at target (②); if the flush CONTINUES it hits the 4% stop instead (③).
  const diagram = `
  <div class="sd-diag">
    <svg viewBox="0 0 720 260" class="sd-svg" role="img" aria-label="Схема стратегии: лимитка ловит резкий провал, затем возврат к средней">
      <!-- reference levels -->
      <line x1="120" y1="70" x2="612" y2="70" stroke="var(--border)" stroke-dasharray="4,4"/>
      <line x1="120" y1="142" x2="612" y2="142" stroke="var(--accent)" stroke-opacity="0.55" stroke-dasharray="6,4"/>
      <line x1="120" y1="212" x2="612" y2="212" stroke="var(--danger)" stroke-opacity="0.55" stroke-dasharray="6,4"/>
      <text x="12" y="74" fill="var(--text-faint)" font-size="11">средняя</text>
      <text x="12" y="146" fill="var(--accent)" font-size="11">лимит (адаптивный)</text>
      <text x="12" y="216" fill="var(--danger)" font-size="11">стоп −4%</text>
      <!-- catastrophe branch (flush continues → stop) -->
      <path d="M 326,172 L 400,212" fill="none" stroke="var(--danger)" stroke-width="1.6" stroke-dasharray="5,4" stroke-opacity="0.85"/>
      <!-- price path (flash down, revert to mid) -->
      <path d="M 128,70 L 250,70 L 314,165 L 326,172 L 415,102 L 470,70 L 606,70" fill="none" stroke="var(--accent)" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>
      <!-- markers -->
      <circle cx="299" cy="142" r="11" fill="var(--accent)"/><text x="299" y="146" text-anchor="middle" fill="var(--bg)" font-size="12" font-weight="700">1</text>
      <circle cx="470" cy="70" r="11" fill="var(--accent)"/><text x="470" y="74" text-anchor="middle" fill="var(--bg)" font-size="12" font-weight="700">2</text>
      <circle cx="400" cy="212" r="11" fill="var(--danger)"/><text x="400" y="216" text-anchor="middle" fill="var(--bg)" font-size="12" font-weight="700">3</text>
      <text x="606" y="240" text-anchor="end" fill="var(--text-faint)" font-size="11">время →</text>
    </svg>
  </div>
  <div class="sd-steps">
    <div class="sd-step"><span class="n">1</span><h5>Ловим шип лимиткой</h5><p>На каждой монете держим глубокую лимитную заявку. Глубина <b>адаптивная — подстраивается под волатильность</b>: ставится на «N сигм» от средней, а не на фиксированный %. Так ловим <b>настоящие</b> переотклонения, а не обычный шум. Резкий провал прокалывает уровень — заявка исполняется как <b>мейкер</b> (без тейкерской комиссии).</p></div>
    <div class="sd-step"><span class="n">2</span><h5>Ставим на возврат</h5><p>Резкие выбросы цены на розничных альтах статистически краткосрочны. Цель — <b>возврат к средней</b> (к цене до шипа). На откате фиксируем прибыль.</p></div>
    <div class="sd-step cat"><span class="n">3</span><h5>Защита, если не откатило</h5><p>Если это был настоящий тренд, а не шип — закрываемся по <b>4%-стопу</b>. Плюс <b>30-мин тайм-стоп</b>: разворот быстрый или его нет.</p></div>
  </div>
  <div class="sd-blocks">
    <div class="sd-block">
      <h4>🧠 На чём основана</h4>
      <ul>
        <li>Устойчивая рыночная микроструктура: на розничных альткоинах резкие шипы и каскады ликвидаций <b>систематически уводят цену слишком далеко от нормы, и она быстро откатывает назад</b>.</li>
        <li><b>Доказательство, что эффект реальный, а не подгонка</b> — контрольная группа: на эффективных мейджорах (BTC, ETH, SOL, LINK) эффекта НЕТ. Случайный шум реагировал бы на всё одинаково; то, что алгоритм отличает розничные альты от эффективных мейджоров, доказывает реальную структуру рынка.</li>
      </ul>
    </div>
    <div class="sd-block">
      <h4>📊 Что мы проанализировали</h4>
      <ul>
        <li><b>Данные:</b> месяцы 5-минутных свечей по ${universe} монетам, <b>3 независимых окна по 180 дней</b>, ~15&nbsp;000+ смоделированных сделок.</li>
        <li><b>Перестановочный тест (K=200):</b> реальный результат против 200 случайных перестановок направления — отличаем край от везения.</li>
        <li><b>Кросс-оконный walk-forward:</b> результат обязан держаться в разных режимах рынка, а не в одном удачном.</li>
        <li><b>MAE-анализ</b> распределения внутрисделочных просадок по каждой монете — так подобраны стопы, что режут катастрофический хвост, но не срезают нормальный шум разворота.</li>
        <li><b>Адаптивная глубина</b> (∝ волатильности): на честном causal A/B (3 окна, перестановочный тест) устойчиво <b>бьёт фиксированный %</b>, при этом контроли (BTC/ETH/SOL/LINK) остаются мёртвыми — значит это реальная структура, а не подгонка под волатильность.</li>
      </ul>
    </div>
    <div class="sd-block risk">
      <h4>🛡 Стопы и защита (многоуровневая)</h4>
      <ul>
        <li><b>Цель</b> — возврат цены к средней (выход в прибыль).</li>
        <li><b>Тайм-стоп 30 мин</b> — если не вернулось, выходим по рынку.</li>
        <li><b>Катастроф-стоп 4%</b> — биржевой стоп-ордер (живёт на бирже, переживает сбои процесса), если движение оказалось трендом.</li>
        <li><b>Дневной −5% СТОПКРАН</b> — при −5% за день (включая плавающую просадку) закрываются ВСЕ позиции + пауза до следующего дня. Жёсткий пол против коррелированных каскадов.</li>
        <li><b>Авто-предохранители:</b> пауза после каскада, контроль лимитов биржи, fail-closed при потере связи с биржей.</li>
      </ul>
    </div>
    <div class="sd-block">
      <h4>⚙️ Как исполняется</h4>
      <ul>
        <li>Только <b>ликвидные монеты</b>, вход — <b>мейкер-лимитками</b>, 24/7 без ручного управления.</li>
        <li><b>Одна позиция на монету</b>, диверсификация по ${universe} монетам — коррелированный флэш ловится по многим сразу.</li>
        <li>Всё автоматически: вход, выход, стопы, перестановка заявок, риск-контроль.</li>
        <li>Каждая сделка публикуется ниже — с реальной точкой входа и результатом <b>после комиссий</b>.</li>
      </ul>
    </div>
  </div>`;
  return `<div class="section">
    <div class="section-title">Как устроена стратегия</div>
    <p class="sd-lead">Систематический <b>маркет-мейкинг с возвратом к среднему</b> на ${universe} ликвидных монетах. Ниже — как это работает, на чём основано и как защищено. Схема на примере <b>лонга</b> (откуп резкого провала); для шорта всё зеркально (продажа резкого выброса вверх).</p>
    ${diagram}
  </div>`;
}

const RU_MON = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const fmtDay = (dayMs: number): string => { const d = new Date(dayMs); return `${d.getUTCDate()} ${RU_MON[d.getUTCMonth()]}`; };

/** Scrollable per-UTC-day result tape — one chip per day (net %, $, trade count), newest first, today highlit. */
function dailyStrip(rows: WfRow[]): string {
  const byDay = new Map<number, { pct: number; usd: number; n: number }>();
  for (const r of rows) {
    if (r.closed_at == null) continue;
    const day = Math.floor(r.closed_at / 86_400_000) * 86_400_000;
    const e = byDay.get(day) ?? { pct: 0, usd: 0, n: 0 };
    e.pct += r.pnl_pct ?? 0; e.usd += usdOf(r); e.n++; byDay.set(day, e);
  }
  if (byDay.size === 0) return '';
  const today = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  const chips = [...byDay.entries()].sort((a, b) => b[0] - a[0]).map(([day, e]) => `
    <div class="lt-day${day === today ? ' today' : ''}">
      <div class="d">${fmtDay(day)}${day === today ? ' · сегодня' : ''}</div>
      <div class="v ${cls(e.pct)}">${pct(e.pct)}</div>
      <div class="s">${usd(e.usd, true)} · ${e.n} сд.</div>
    </div>`).join('');
  return `<div class="section"><div class="section-title">Результат по дням (net комиссий · листайте →)</div><div class="lt-days">${chips}</div></div>`;
}

export function renderLiveTrack(): string {
  const rows = closedStmt.all();
  const openRows = openStmt.all();
  const st = computeStats(rows, openRows.length);
  const hasData = st.closed > 0;
  const universe = WF_CONFIG.coins.length;                 // book breadth (single source of truth)
  const distinctTraded = new Set(rows.map((r) => r.coin)).size; // how many of the book have fired so far
  const dayStart = Math.floor(Date.now() / 86_400_000) * 86_400_000; // current UTC day start
  const todayRows = rows.filter((r) => (r.closed_at ?? 0) >= dayStart);
  const todayPct = todayRows.reduce((s, r) => s + (r.pnl_pct ?? 0), 0);
  const todayUsd = todayRows.reduce((s, r) => s + usdOf(r), 0);
  // Commissions already netted out of pnl (COST_RT≈0.05%): maker entry ~0.015% + taker exit ~0.035%.
  const feeEntry = rows.reduce((s, r) => s + notionalOf(r) * 0.015 / 100, 0);
  const feeExit = rows.reduce((s, r) => s + notionalOf(r) * 0.035 / 100, 0);

  const statCard = (l: string, v: string, vc = '', s = '', sc = ''): string =>
    `<div class="lt-stat"><div class="l">${l}</div><div class="v ${vc}">${v}</div>${s ? `<div class="s ${sc}">${s}</div>` : ''}</div>`;

  const cards = hasData ? `
    <div class="lt-cards">
      ${statCard('Монет в работе', String(universe), '', st.open > 0 ? `${st.open} сейчас открыто` : `${distinctTraded} уже дали сделки`)}
      ${statCard('Накопл. результат', pct(st.netPct), cls(st.netPct), `${usd(st.netUsd, true)} · net комиссий`, cls(st.netUsd))}
      ${statCard('Результат за день', todayRows.length ? pct(todayPct) : '—', cls(todayPct), todayRows.length ? `${usd(todayUsd, true)} · ${todayRows.length} сделок (UTC)` : 'сегодня сделок нет', cls(todayUsd))}
      ${statCard('Закрытых сделок', String(st.closed), '', `за ${st.daysLive} дн.`)}
      ${statCard('Винрейт', st.winRate != null ? `${(st.winRate * 100).toFixed(0)}%` : '—', '', `${st.wins} прибыльных · ${st.losses} убыточных`)}
      ${statCard('Профит-фактор', st.profitFactor != null ? st.profitFactor.toFixed(2) : '—', st.profitFactor != null && st.profitFactor >= 1 ? 'pos' : st.profitFactor != null ? 'neg' : '', 'прибыль / убыток')}
      ${statCard('Лучшая сделка', pct(st.best), 'pos', esc(rows.find((r) => (r.pnl_pct ?? 0) === st.best)?.coin ?? ''))}
      ${statCard('Худшая сделка', pct(st.worst), 'neg', esc(rows.find((r) => (r.pnl_pct ?? 0) === st.worst)?.coin ?? ''))}
      ${statCard('Средняя / сделку', pct(st.avgPct), cls(st.avgPct), 'net комиссий')}
      ${statCard('Комиссии уплачено', usd(feeEntry + feeExit), '', `вход ${usd(feeEntry)} (maker) · выход ${usd(feeExit)} (taker)`)}
    </div>` : '';

  const stages = roadmap(st).map((s) => `
    <div class="rm-item ${s.status}">
      <div class="rm-dot"></div>
      <div class="rm-head"><span class="rm-title">${esc(s.title)}</span>${s.meta ? `<span class="rm-meta">${esc(s.meta)}</span>` : ''}</div>
      <div class="rm-desc">${esc(s.desc)}</div>
    </div>`).join('');

  const emptyState = `<div class="card"><div class="card-body"><div class="empty-state" style="padding:26px 0;text-align:center;">
      ⏳ Боевой трек на паузе — копим статистику. Данные появятся здесь автоматически, как только пойдут сделки.
    </div></div></div>`;

  return pageShell(
    'Боевой трек — реальные результаты · Robot Claude',
    `
    <div class="header">
      <a class="lt-back" href="/lab">← в лабораторию</a>
      <span class="strat-code">LIVE · HYPERLIQUID · РЕАЛЬНЫЕ ДЕНЬГИ</span>
      <h1 class="title">Боевой трек</h1>
      <p class="subtitle">Что мы делаем, реальная статистика и к чему идём. Всё ниже — живые данные, net комиссий.</p>
    </div>
    <style>${TRACK_CSS}</style>

    <div class="lt-intro">
      <b>Robot Claude</b> — систематическая торговая система на бирже Hyperliquid. Алгоритм одновременно ведёт
      книгу из <b>${universe} ликвидных монет</b> (лонг и шорт), отслеживает краткосрочные ценовые аномалии и
      зарабатывает на возврате цены к норме.
      Работает 24/7 без ручного управления: вход, выход и защита от резких движений — полностью автоматические.
      <b>Никаких обещаний</b> — только реальный трек ниже, каждая сделка с настоящей точкой входа и результатом
      после комиссий.
    </div>

    <div class="lt-phase">
      <span class="dot"></span>
      <div><b>Сейчас: фаза живой валидации.</b> Система торгует реальными деньгами на небольшом капитале.
      Задача этого этапа — не максимальная прибыль, а <b>честная статистика</b> на настоящих издержках. Именно
      этот проверенный трек станет фундаментом публичного вульта (см. дорожную карту внизу).</div>
    </div>

    ${hasData ? cards : ''}
    ${hasData ? `<div class="section"><div class="section-title">Кривая результата (накопленный %, net комиссий)</div>${equityCurve(st.cum)}</div>` : ''}
    ${hasData ? dailyStrip(rows) : ''}
    ${strategyDetail(universe)}
    ${openPositionsSection(Date.now())}
    ${hasData ? `<div class="section"><div class="section-title">Закрытые сделки · все ${st.closed}</div>${tradesTable(rows)}</div>` : emptyState}

    <div class="section">
      <div class="section-title">Дорожная карта — к публичному вульту</div>
      <div class="rm">${stages}</div>
    </div>

    <p class="lt-note">
      Данные обновляются автоматически из журнала сделок системы — страница не может расходиться с реальностью.
      Результаты указаны за вычетом комиссий (≈0.05% на сделку). Прошлые результаты не гарантируют будущих;
      это не инвестиционная рекомендация. Малый размер сумм в долларах — следствие тестового капитала на фазе валидации.
    </p>
    `,
    { autoRefreshSec: 60 },
  );
}

/** Compact live-track summary for the hero card at the top of /lab. */
export function liveTrackHero(): string {
  const rows = closedStmt.all();
  if (rows.length === 0) return '';
  const st = computeStats(rows, openStmt.all().length);
  return `
    <a class="lt-hero" href="/lab/live">
      <div class="lt-hero-l">
        <span class="lt-hero-badge">🟢 LIVE · Hyperliquid · реальные деньги</span>
        <div class="lt-hero-title">Боевой трек — реальные результаты</div>
        <div class="lt-hero-sub">Что мы делаем, честная статистика и дорожная карта к вульту →</div>
      </div>
      <div class="lt-hero-r">
        <div class="lt-hero-stat"><div class="v ${cls(st.netPct)}">${pct(st.netPct)}</div><div class="k">накопл.</div></div>
        <div class="lt-hero-stat"><div class="v">${WF_CONFIG.coins.length}</div><div class="k">монет</div></div>
        <div class="lt-hero-stat"><div class="v">${st.closed}</div><div class="k">сделок</div></div>
        <div class="lt-hero-stat"><div class="v">${st.winRate != null ? `${(st.winRate * 100).toFixed(0)}%` : '—'}</div><div class="k">винрейт</div></div>
      </div>
    </a>`;
}

export const LIVE_TRACK_HERO_CSS = `
  .lt-hero{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;
    background:linear-gradient(135deg,var(--accent-soft),var(--bg-card));border:1px solid var(--accent-soft);
    border-radius:14px;padding:16px 20px;margin:0 0 22px;text-decoration:none;color:var(--text);transition:border-color .15s}
  .lt-hero:hover{border-color:var(--accent)}
  .lt-hero-badge{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.03em;color:var(--accent);
    background:var(--accent-soft);border-radius:999px;padding:3px 10px;margin-bottom:8px}
  .lt-hero-title{font-size:18px;font-weight:650}
  .lt-hero-sub{font-size:13px;color:var(--text-dim);margin-top:3px}
  .lt-hero-r{display:flex;gap:22px}
  .lt-hero-stat{text-align:right}
  .lt-hero-stat .v{font-size:22px;font-weight:650;font-variant-numeric:tabular-nums;line-height:1.1}
  .lt-hero-stat .v.pos{color:var(--accent)}.lt-hero-stat .v.neg{color:var(--danger)}
  .lt-hero-stat .k{font-size:11px;color:var(--text-faint);text-transform:uppercase;letter-spacing:.04em;margin-top:2px}
  @media(max-width:560px){.lt-hero-r{gap:16px}.lt-hero-stat .v{font-size:18px}}
`;

export async function labTrackRoute(app: FastifyInstance): Promise<void> {
  app.get('/lab/live', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    reply.header('Cache-Control', 'public, max-age=30');
    return renderLiveTrack();
  });
}
