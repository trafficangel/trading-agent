/**
 * LIVE TRACK — the public, honest record of the real-money book (wick-fade on
 * Hyperliquid). This is NOT the paper R&D lab (see lab.ts) — every row here is
 * real money on a real exchange, PnL net of commission. The page answers three
 * operator-requested questions, in order:
 *   1. что мы делаем   — what we do (general terms; NO strategy internals)
 *   2. реальные данные — real trades with entry points + result metrics, live from wick_fade_log
 *   3. к чему идём      — the roadmap (build → live-validation → green track → capital scale)
 *
 * Data is queried DIRECTLY from wick_fade_log (mode='live') at render time — the
 * same table the live runner writes to, so the page can never diverge from reality.
 * Route: /lab/live. A hero card at the top of /lab links here.
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client.js';
import { pageShell, getLang } from './landing.js';
import { WF_CONFIG, COIN_X, LADDER } from '../jobs/wick-fade-runner.js';
import { hlOpenOrders, type HlOpenOrder } from '../exchange/hyperliquid-private.js';
import { metaAndAssetCtxs } from '../exchange/hyperliquid.js';

type Lang = 'ru' | 'en';
/** tiny picker: t(lang, ru, en) */
const t = (lang: Lang, ru: string, en: string): string => (lang === 'en' ? en : ru);

// ── real-money log rows ──
type WfRow = {
  id: number; coin: string; side: string; entry_px: number; qty: number; x: number | null;
  opened_at: number; exit_px: number | null; closed_at: number | null; pnl_pct: number | null; close_reason: string | null;
};
const closedStmt = db.prepare<[], WfRow>(`SELECT * FROM wick_fade_log WHERE mode='live' AND closed_at IS NOT NULL ORDER BY closed_at ASC`);
const openStmt = db.prepare<[], WfRow>(`SELECT * FROM wick_fade_log WHERE mode='live' AND closed_at IS NULL ORDER BY opened_at DESC`);
const limitVolClosesStmt = db.prepare<[string, number], { t: number; c: number }>(`SELECT t, c FROM hl_candles WHERE coin = ? ORDER BY t DESC LIMIT ?`);

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
function heldStr(openedMs: number, nowMs: number, lang: Lang): string {
  const m = Math.max(0, Math.round((nowMs - openedMs) / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)}${t(lang, 'ч', 'h')} ${m % 60}${t(lang, 'м', 'm')}` : `${m}${t(lang, 'м', 'm')}`;
}

type LimitVol = { volPct4h: number; factor: number };
function limitVolState(coin: string): LimitVol | null {
  const W = WF_CONFIG.volWindow;
  let rows: { c: number }[];
  try { rows = limitVolClosesStmt.all(coin, 550); } catch { return null; }
  const closes = rows.map((r) => r.c).reverse();
  if (closes.length < W + 80) return null;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(closes[i]! > 0 && closes[i - 1]! > 0 ? Math.log(closes[i]! / closes[i - 1]!) : 0);
  const volAt = (end: number): number => {
    let m = 0;
    for (let j = end - W; j < end; j++) m += rets[j]!;
    m /= W;
    let v = 0;
    for (let j = end - W; j < end; j++) { const d = rets[j]! - m; v += d * d; }
    return Math.sqrt(v / (W - 1));
  };
  let e = 0, seeded = false;
  for (let end = W; end <= rets.length; end++) {
    const v = volAt(end);
    if (!(v > 0)) continue;
    if (!seeded) { e = v; seeded = true; }
    else e = e + 0.01 * (v - e);
  }
  const cur = volAt(rets.length);
  if (!(cur > 0)) return null;
  const rawFactor = e > 0 ? cur / e : 1;
  return { volPct4h: cur * Math.sqrt(W) * 100, factor: Math.min(2, Math.max(0.4, rawFactor)) };
}

async function liveMids(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const [meta, ctxs] = await metaAndAssetCtxs();
    meta.universe.forEach((u, i) => {
      const ctx = ctxs[i];
      const mid = Number(ctx?.midPx ?? 0) || Number(ctx?.markPx ?? 0) || Number(ctx?.oraclePx ?? 0);
      if (mid > 0) out.set(u.name, mid);
    });
  } catch {
    // Informative only: the table still renders raw exchange orders without current mids.
  }
  return out;
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
function equityCurve(cum: number[], lang: Lang): string {
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
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="eq-svg" role="img" aria-label="${t(lang, 'Кривая накопленного результата, %', 'Cumulative result curve, %')}">
      <defs>
        <linearGradient id="eqPos" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--accent)" stop-opacity="0.28"/><stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/></linearGradient>
        <linearGradient id="eqNeg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--danger)" stop-opacity="0.24"/><stop offset="100%" stop-color="var(--danger)" stop-opacity="0"/></linearGradient>
      </defs>
      <line x1="${padX}" y1="${yZero.toFixed(1)}" x2="${(W - padX).toFixed(1)}" y2="${yZero.toFixed(1)}" stroke="var(--border)" stroke-dasharray="3,4"/>
      <path d="${area}" fill="${fill}"/>
      <path d="${line}" fill="none" stroke="${stroke}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}
    </svg>
    <div class="eq-cap"><span>${t(lang, 'старт 0%', 'start 0%')}</span><span class="${cls(last)}">${pct(last)} ${t(lang, 'накопл.', 'total')}</span></div>
  </div>`;
}

// ── the roadmap (build → live-validation → green track → capital scale) ──
type Stage = { status: 'done' | 'now' | 'next'; title: string; desc: string; meta?: string };
function roadmap(st: TrackStats, lang: Lang): Stage[] {
  return [
    { status: 'done', title: t(lang, 'Механика построена', 'Mechanics built'), meta: t(lang, 'готово', 'done'),
      desc: t(lang, 'Движок исполнения на бирже, стопы прямо на бирже (не в коде), пакетные заявки, риск-контроль, автоматические предохранители при аномалиях и просадке.', 'Exchange-native execution engine, stops resting on the exchange (not in code), batched orders, risk controls, automatic breakers on anomalies and drawdown.') },
    { status: 'now', title: t(lang, 'Живая валидация', 'Live validation'), meta: t(lang, `${st.closed} / ~100 сделок`, `${st.closed} / ~100 trades`),
      desc: t(lang, 'Реальные деньги на малом капитале. Цель этой фазы — не прибыль, а честная статистика на настоящих комиссиях и проскальзывании. Каждая сделка ниже — из этого этапа.', 'Real money at small size. The goal of this phase is not profit but honest statistics on real fees and slippage. Every trade below is from this stage.') },
    { status: 'next', title: t(lang, 'Зелёный трек', 'Green track'), meta: t(lang, 'критерий выхода', 'exit criterion'),
      desc: t(lang, 'Устойчивый положительный результат на реальных издержках — на достаточной выборке и в разных рыночных режимах, а не на одном удачном окне.', 'A sustained positive result at real costs — on a sufficient sample and across market regimes, not one lucky window.') },
    { status: 'next', title: t(lang, 'Масштаб капитала', 'Capital scale'), meta: t(lang, 'цель', 'goal'),
      desc: t(lang, 'Увеличение депозита снимает лимиты биржи и даёт стратегии работать в полную силу — больше монет, более свежие котировки, выше частота.', 'A larger deposit lifts exchange limits and lets the strategy run at full strength — more coins, fresher quotes, higher frequency.') },
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
  .limit-head{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:10px}
  .limit-head .section-title{margin:0}
  .limit-meta{font-size:12px;color:var(--text-faint);font-variant-numeric:tabular-nums}
  .limit-note{font-size:12px;color:var(--text-faint);line-height:1.5;margin:10px 0 0}
  .limit-corridor{display:inline-flex;align-items:center;font-weight:650}
  .limit-corridor.long{color:var(--accent)}
  .limit-corridor.short{color:var(--danger)}
  .limit-vol{display:flex;flex-direction:column;gap:2px;align-items:flex-end;line-height:1.15}
  .limit-vol b{color:var(--text);font-weight:650}
  .limit-vol span{font-size:11px;color:var(--text-faint)}
  .limit-warn{background:var(--danger-soft);color:var(--danger);border:1px solid var(--danger-soft);border-radius:10px;padding:12px 14px;font-size:13px;line-height:1.5}
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
  .lt-pager{display:flex;align-items:center;justify-content:center;gap:14px;margin-top:14px;font-size:13px;flex-wrap:wrap}
  .lt-pager a{color:var(--accent);text-decoration:none;padding:6px 14px;border:1px solid var(--border);border-radius:8px;transition:border-color .15s}
  .lt-pager a:hover{border-color:var(--accent)}
  .lt-pager .off{color:var(--text-faint);padding:6px 14px;border:1px solid var(--border);border-radius:8px;opacity:.45}
  .lt-pager .pg{color:var(--text-dim);font-variant-numeric:tabular-nums}
`;

const PER_PAGE = 50;
function tradesTable(rows: WfRow[], page: number, lang: Lang): string {
  // newest first, paginated server-side via ?page=N — survives the page auto-refresh, needs no JS
  const ordered = [...rows].sort((a, b) => (b.closed_at ?? 0) - (a.closed_at ?? 0));
  const pages = Math.max(1, Math.ceil(ordered.length / PER_PAGE));
  const p = Math.min(Math.max(1, page), pages);
  const from = (p - 1) * PER_PAGE;
  const body = ordered.slice(from, from + PER_PAGE).map((r) => {
    const p = r.pnl_pct ?? 0;
    const reasonCls = r.close_reason === 'target' ? 'target' : r.close_reason === 'catastrophe' ? 'cat' : '';
    const reasonLbl = r.close_reason === 'target' ? t(lang, '🎯 цель', '🎯 target') : r.close_reason === 'time-stop' ? t(lang, '⏱ тайм-стоп', '⏱ time-stop') : r.close_reason === 'catastrophe' ? t(lang, '🛑 стоп', '🛑 stop') : (r.close_reason ?? '—');
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
      <th>#</th><th>${t(lang, 'Монета', 'Coin')}</th><th>${t(lang, 'Сторона', 'Side')}</th>
      <th class="r">${t(lang, 'Вход', 'Entry')}</th><th class="r">${t(lang, 'Выход', 'Exit')}</th><th class="r">${t(lang, 'Глубина', 'Depth')}</th><th class="r">${t(lang, 'Результат', 'Result')}</th><th class="r">P&amp;L $</th>
      <th class="r">${t(lang, 'Комиссия', 'Fee')}</th><th>${t(lang, 'Как закрыли', 'Exit')}</th><th>${t(lang, 'Открыта (UTC)', 'Opened (UTC)')}</th>
    </tr></thead><tbody>${body}</tbody></table></div>${(() => {
    if (pages <= 1) return '';
    const shown = Math.min(PER_PAGE, ordered.length - from);
    const link = (n: number, label: string): string => (n >= 1 && n <= pages) ? `<a href="/lab/live?page=${n}#trades">${label}</a>` : `<span class="off">${label}</span>`;
    return `<div class="lt-pager">${link(p - 1, t(lang, '← Назад', '← Back'))}<span class="pg">${t(lang, 'Стр.', 'Page')} ${p} ${t(lang, 'из', 'of')} ${pages} · ${from + 1}–${from + shown} ${t(lang, 'из', 'of')} ${ordered.length}</span>${link(p + 1, t(lang, 'Вперёд →', 'Next →'))}</div>`;
  })()}`;
}

/** Currently-OPEN positions (closed_at IS NULL) — live entries the Telegram alert fires on, which the closed
 *  table can't show yet. Entry/target/stop derived exactly like the runner: target = pre-wick mid = entry/(1±x),
 *  stop = entry·(1±stopPct). DB-only (no exchange call) so the public page can't hang on an HL request. */
function openPositionsSection(nowMs: number, lang: Lang): string {
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
      <td class="dt">${heldStr(r.opened_at, nowMs, lang)}</td>
      <td><span class="rp open">🟢 ${t(lang, 'в работе', 'open')}</span></td>
    </tr>`;
  }).join('');
  return `<div class="section">
    <div class="section-title">${t(lang, 'Открыто сейчас', 'Open now')} · ${open.length}</div>
    <div class="card table-wrap"><table class="lt-tbl">
      <thead><tr><th>#</th><th>${t(lang, 'Монета', 'Coin')}</th><th>${t(lang, 'Сторона', 'Side')}</th><th class="r">${t(lang, 'Вход', 'Entry')}</th><th class="r">${t(lang, 'Глубина', 'Depth')}</th>
        <th class="r">${t(lang, 'Цель', 'Target')} 🎯</th><th class="r">${t(lang, 'Стоп', 'Stop')} 🛑</th><th class="r">${t(lang, 'Размер', 'Size')}</th><th>${t(lang, 'В работе', 'Held')}</th><th>${t(lang, 'Статус', 'Status')}</th></tr></thead>
      <tbody>${body}</tbody></table></div></div>`;
}


function limitRungLabel(o: HlOpenOrder, distancePct: number | null, vol: LimitVol | null, lang: Lang): string {
  const base = COIN_X[o.coin];
  if (base == null || distancePct == null) return '—';
  const factor = WF_CONFIG.dynamicDepth ? (vol?.factor ?? 1) : 1;
  const baseDepth = base * factor * 100;
  const deepDepth = LADDER[o.coin] != null ? LADDER[o.coin]! * factor * 100 : null;
  if (deepDepth == null) return t(lang, 'базовая', 'base');
  return distancePct >= (baseDepth + deepDepth) / 2 ? t(lang, 'глубокая', 'deep') : t(lang, 'базовая', 'base');
}

async function openLimitsSection(lang: Lang): Promise<string> {
  const res = await hlOpenOrders();
  if (!res.ok) {
    return `<div class="section"><div class="limit-head"><div class="section-title">${t(lang, 'Выставленные лимитки', 'Resting limit orders')}</div></div><div class="limit-warn">${t(lang, 'Не удалось прочитать лимитки с Hyperliquid:', 'Could not read Hyperliquid limit orders:')} ${esc(res.msg)}</div></div>`;
  }
  const mids = await liveMids();
  const orders = res.data
    .filter((o) => WF_CONFIG.coins.includes(o.coin))
    .sort((a, b) => a.coin.localeCompare(b.coin) || (a.side === b.side ? a.px - b.px : a.side === 'long' ? -1 : 1));
  const now = new Date();
  if (orders.length === 0) {
    return `<div class="section"><div class="limit-head"><div class="section-title">${t(lang, 'Выставленные лимитки', 'Resting limit orders')} · 0</div><div class="limit-meta">${t(lang, 'обновлено', 'updated')} ${now.toISOString().slice(11, 19)} UTC</div></div><div class="card"><div class="card-body"><div class="empty-state" style="padding:20px 0;text-align:center;">${t(lang, 'Сейчас входных лимиток нет: книга снята защитой, бюджетом действий или открытыми позициями.', 'No entry limits right now: the book is pulled by protection, action budget, or open positions.')}</div></div></div></div>`;
  }
  const body = orders.map((o) => {
    const mid = mids.get(o.coin) ?? null;
    const distancePct = mid != null ? (o.side === 'long' ? (mid - o.px) / mid : (o.px - mid) / mid) * 100 : null;
    const vol = limitVolState(o.coin);
    const notional = o.px * o.sz;
    const distText = distancePct == null ? '—' : `${distancePct.toFixed(2)}%`;
    const volText = vol ? `${vol.volPct4h.toFixed(2)}%` : '—';
    const factorText = vol ? `×${vol.factor.toFixed(2)} ${t(lang, 'к норме', 'vs norm')}` : t(lang, 'нет свечей', 'no candles');
    return `<tr>
      <td><b>${esc(o.coin)}</b></td>
      <td><span class="sd ${o.side === 'long' ? 'long' : 'short'}">${o.side.toUpperCase()}</span></td>
      <td class="r mono">${fmtPx(o.px, o.px)}</td>
      <td class="r mono">${mid != null ? fmtPx(mid, o.px) : '—'}</td>
      <td class="r mono"><span class="limit-corridor ${o.side === 'long' ? 'long' : 'short'}">${distText}</span></td>
      <td>${limitRungLabel(o, distancePct, vol, lang)}</td>
      <td class="r mono">${o.sz.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}</td>
      <td class="r mono">${usd(notional)}</td>
      <td class="r"><div class="limit-vol"><b>${volText}</b><span>${factorText}</span></div></td>
      <td class="r mono" style="color:var(--text-faint)">#${o.oid}</td>
    </tr>`;
  }).join('');
  return `<div class="section" id="limits">
    <div class="limit-head"><div class="section-title">${t(lang, 'Выставленные лимитки', 'Resting limit orders')} · ${orders.length}</div><div class="limit-meta">${t(lang, 'обновлено', 'updated')} ${now.toISOString().slice(11, 19)} UTC · ${t(lang, 'автообновление 60 сек', 'auto-refresh 60s')}</div></div>
    <div class="card table-wrap"><table class="lt-tbl"><thead><tr>
      <th>${t(lang, 'Монета', 'Coin')}</th><th>${t(lang, 'Сторона', 'Side')}</th><th class="r">${t(lang, 'Лимит', 'Limit')}</th><th class="r">${t(lang, 'Сейчас', 'Now')}</th><th class="r">${t(lang, 'Коридор от цены', 'Distance')}</th><th>${t(lang, 'Уровень', 'Rung')}</th><th class="r">${t(lang, 'Кол-во', 'Qty')}</th><th class="r">${t(lang, 'Номинал', 'Notional')}</th><th class="r">${t(lang, 'Волатильность 4ч', '4h volatility')}</th><th class="r">OID</th>
    </tr></thead><tbody>${body}</tbody></table></div>
    <p class="limit-note">${t(lang, 'Коридор показывает, на сколько процентов лимитка стоит дальше текущей цены. Волатильность считается по 5-минутным свечам за последние 4 часа; множитель показывает, насколько текущий режим шире или тише обычного.', 'Distance shows how far the limit is from current price. Volatility is computed from 5-minute candles over the last 4 hours; the multiplier shows how much wider or calmer the current regime is versus normal.')}</p>
  </div>`;
}
/** Detailed strategy explainer — a schematic SVG of the wick-fade mechanic + what it's based on, the data
 *  analysed, and the layered stops. Static (no data) — the credibility/depth surface for the live track. */
function strategyDetail(universe: number, lang: Lang): string {
  // Schematic (LONG / buy-the-dip): price rests at the mid, a flash wick pierces our deep bid (①), price
  // reverts to the mid = exit at target (②); if the flush CONTINUES it hits the 4% stop instead (③).
  const diagram = `
  <div class="sd-diag">
    <svg viewBox="0 0 720 260" class="sd-svg" role="img" aria-label="${t(lang, 'Схема стратегии: лимитка ловит резкий провал, затем возврат к средней', 'Strategy schematic: a limit order catches a sharp dip, then price reverts to the mean')}">
      <!-- reference levels -->
      <line x1="120" y1="70" x2="612" y2="70" stroke="var(--border)" stroke-dasharray="4,4"/>
      <line x1="120" y1="142" x2="612" y2="142" stroke="var(--accent)" stroke-opacity="0.55" stroke-dasharray="6,4"/>
      <line x1="120" y1="212" x2="612" y2="212" stroke="var(--danger)" stroke-opacity="0.55" stroke-dasharray="6,4"/>
      <text x="12" y="74" fill="var(--text-faint)" font-size="11">${t(lang, 'средняя', 'mean')}</text>
      <text x="12" y="146" fill="var(--accent)" font-size="11">${t(lang, 'лимит (адаптивный)', 'limit (adaptive)')}</text>
      <text x="12" y="216" fill="var(--danger)" font-size="11">${t(lang, 'стоп −4%', 'stop −4%')}</text>
      <!-- catastrophe branch (flush continues → stop) -->
      <path d="M 326,172 L 400,212" fill="none" stroke="var(--danger)" stroke-width="1.6" stroke-dasharray="5,4" stroke-opacity="0.85"/>
      <!-- price path (flash down, revert to mid) -->
      <path d="M 128,70 L 250,70 L 314,165 L 326,172 L 415,102 L 470,70 L 606,70" fill="none" stroke="var(--accent)" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>
      <!-- markers -->
      <circle cx="299" cy="142" r="11" fill="var(--accent)"/><text x="299" y="146" text-anchor="middle" fill="var(--bg)" font-size="12" font-weight="700">1</text>
      <circle cx="470" cy="70" r="11" fill="var(--accent)"/><text x="470" y="74" text-anchor="middle" fill="var(--bg)" font-size="12" font-weight="700">2</text>
      <circle cx="400" cy="212" r="11" fill="var(--danger)"/><text x="400" y="216" text-anchor="middle" fill="var(--bg)" font-size="12" font-weight="700">3</text>
      <text x="606" y="240" text-anchor="end" fill="var(--text-faint)" font-size="11">${t(lang, 'время →', 'time →')}</text>
    </svg>
  </div>
  <div class="sd-steps">
    <div class="sd-step"><span class="n">1</span><h5>${t(lang, 'Ловим шип лимиткой', 'Catch the spike with a limit')}</h5><p>${t(lang, 'На каждой монете держим глубокую лимитную заявку. Глубина <b>адаптивная — подстраивается под волатильность</b>: ставится на «N сигм» от средней, а не на фиксированный %. Так ловим <b>настоящие</b> переотклонения, а не обычный шум. Резкий провал прокалывает уровень — заявка исполняется как <b>мейкер</b> (без тейкерской комиссии).', 'On each coin we rest a deep limit order. The depth is <b>adaptive — it scales with volatility</b>: placed at “N sigmas” from the mean, not a fixed %. That catches <b>genuine</b> over-extensions, not ordinary noise. A sharp dip pierces the level — the order fills as a <b>maker</b> (no taker fee).')}</p></div>
    <div class="sd-step"><span class="n">2</span><h5>${t(lang, 'Ставим на возврат', 'Bet on the reversion')}</h5><p>${t(lang, 'Резкие выбросы цены на розничных альтах статистически краткосрочны. Цель — <b>возврат к средней</b> (к цене до шипа). На откате фиксируем прибыль.', 'Sharp price spikes on retail alts are statistically short-lived. The target is a <b>return to the mean</b> (the pre-spike price). We book profit on the snap-back.')}</p></div>
    <div class="sd-step cat"><span class="n">3</span><h5>${t(lang, 'Защита, если не откатило', 'Protection if it doesn’t revert')}</h5><p>${t(lang, 'Если это был настоящий тренд, а не шип — закрываемся по <b>4%-стопу</b>. Плюс <b>30-мин тайм-стоп</b>: разворот быстрый или его нет.', 'If it was a real trend, not a spike — we exit at the <b>4% stop</b>. Plus a <b>30-min time-stop</b>: the reversion is fast or it isn’t coming.')}</p></div>
  </div>
  <div class="sd-blocks">
    <div class="sd-block">
      <h4>🧠 ${t(lang, 'На чём основана', 'What it’s based on')}</h4>
      <ul>
        <li>${t(lang, 'Устойчивая рыночная микроструктура: на розничных альткоинах резкие шипы и каскады ликвидаций <b>систематически уводят цену слишком далеко от нормы, и она быстро откатывает назад</b>.', 'A robust market-microstructure fact: on retail altcoins, sharp spikes and liquidation cascades <b>systematically push price too far from fair, and it snaps back quickly</b>.')}</li>
        <li>${t(lang, '<b>Доказательство, что эффект реальный, а не подгонка</b> — контрольная группа: на эффективных мейджорах (BTC, ETH, SOL, LINK) эффекта НЕТ. Случайный шум реагировал бы на всё одинаково; то, что алгоритм отличает розничные альты от эффективных мейджоров, доказывает реальную структуру рынка.', '<b>Proof it’s real, not curve-fitting</b> — a control group: on efficient majors (BTC, ETH, SOL, LINK) the effect is ABSENT. Random noise would react to everything the same; the fact that the algorithm tells retail alts apart from efficient majors proves genuine market structure.')}</li>
      </ul>
    </div>
    <div class="sd-block">
      <h4>📊 ${t(lang, 'Что мы проанализировали', 'What we analysed')}</h4>
      <ul>
        <li>${t(lang, `<b>Данные:</b> месяцы 5-минутных свечей по ${universe} монетам, <b>3 независимых окна по 180 дней</b>, ~15&nbsp;000+ смоделированных сделок.`, `<b>Data:</b> months of 5-minute candles across ${universe} coins, <b>3 independent 180-day windows</b>, ~15,000+ simulated trades.`)}</li>
        <li>${t(lang, '<b>Перестановочный тест (K=200):</b> реальный результат против 200 случайных перестановок направления — отличаем край от везения.', '<b>Permutation test (K=200):</b> the real result vs 200 random direction shuffles — separating edge from luck.')}</li>
        <li>${t(lang, '<b>Кросс-оконный walk-forward:</b> результат обязан держаться в разных режимах рынка, а не в одном удачном.', '<b>Cross-window walk-forward:</b> the result must hold across market regimes, not one lucky window.')}</li>
        <li>${t(lang, '<b>MAE-анализ</b> распределения внутрисделочных просадок по каждой монете — так подобраны стопы, что режут катастрофический хвост, но не срезают нормальный шум разворота.', '<b>MAE analysis</b> of the in-trade drawdown distribution per coin — so the stops cut the catastrophic tail without clipping normal reversion noise.')}</li>
        <li>${t(lang, '<b>Адаптивная глубина</b> (∝ волатильности): на честном causal A/B (3 окна, перестановочный тест) устойчиво <b>бьёт фиксированный %</b>, при этом контроли (BTC/ETH/SOL/LINK) остаются мёртвыми — значит это реальная структура, а не подгонка под волатильность.', '<b>Adaptive depth</b> (∝ volatility): in an honest causal A/B (3 windows, permutation test) it robustly <b>beats a fixed %</b> while the controls (BTC/ETH/SOL/LINK) stay dead — genuine structure, not vol-fitting.')}</li>
      </ul>
    </div>
    <div class="sd-block risk">
      <h4>🛡 ${t(lang, 'Стопы и защита (многоуровневая)', 'Stops & protection (layered)')}</h4>
      <ul>
        <li>${t(lang, '<b>Цель</b> — возврат цены к средней (выход в прибыль).', '<b>Target</b> — price reverts to the mean (exit in profit).')}</li>
        <li>${t(lang, '<b>Тайм-стоп 30 мин</b> — если не вернулось, выходим по рынку.', '<b>30-min time-stop</b> — if it hasn’t reverted, we exit at market.')}</li>
        <li>${t(lang, '<b>Катастроф-стоп 4%</b> — биржевой стоп-ордер (живёт на бирже, переживает сбои процесса), если движение оказалось трендом.', '<b>4% catastrophe stop</b> — an exchange-resident stop order (lives on the exchange, survives process downtime), if the move turned out to be a trend.')}</li>
        <li>${t(lang, '<b>Дневной −5% СТОПКРАН</b> — при −5% за день (включая плавающую просадку) закрываются ВСЕ позиции + пауза до следующего дня. Жёсткий пол против коррелированных каскадов.', '<b>Daily −5% CIRCUIT-BREAKER</b> — at −5% on the day (including open unrealized drawdown) ALL positions close + trading pauses until the next day. A hard floor against correlated cascades.')}</li>
        <li>${t(lang, '<b>Авто-предохранители:</b> пауза после каскада, контроль лимитов биржи, fail-closed при потере связи с биржей.', '<b>Auto-safeguards:</b> post-cascade cooldown, exchange rate-limit control, fail-closed if the exchange connection drops.')}</li>
      </ul>
    </div>
    <div class="sd-block">
      <h4>⚙️ ${t(lang, 'Как исполняется', 'How it executes')}</h4>
      <ul>
        <li>${t(lang, 'Только <b>ликвидные монеты</b>, вход — <b>мейкер-лимитками</b>, 24/7 без ручного управления.', 'Liquid coins only, entries via <b>maker limits</b>, 24/7 with no manual intervention.')}</li>
        <li>${t(lang, `<b>Одна позиция на монету</b>, диверсификация по ${universe} монетам — коррелированный флэш ловится по многим сразу.`, `<b>One position per coin</b>, diversified across ${universe} coins — a correlated flush is caught on many at once.`)}</li>
        <li>${t(lang, 'Всё автоматически: вход, выход, стопы, перестановка заявок, риск-контроль.', 'Everything automatic: entry, exit, stops, quote re-placement, risk control.')}</li>
        <li>${t(lang, 'Каждая сделка публикуется ниже — с реальной точкой входа и результатом <b>после комиссий</b>.', 'Every trade is published below — with a real entry point and the result <b>net of fees</b>.')}</li>
      </ul>
    </div>
  </div>`;
  return `<div class="section">
    <div class="section-title">${t(lang, 'Как устроена стратегия', 'How the strategy works')}</div>
    <p class="sd-lead">${t(lang, `Систематический <b>маркет-мейкинг с возвратом к среднему</b> на ${universe} ликвидных монетах. Ниже — как это работает, на чём основано и как защищено. Схема на примере <b>лонга</b> (откуп резкого провала); для шорта всё зеркально (продажа резкого выброса вверх).`, `Systematic <b>mean-reversion market-making</b> across ${universe} liquid coins. Below — how it works, what it’s based on, and how it’s protected. The schematic shows a <b>long</b> (buying a sharp dip); shorts are mirror-image (selling a sharp spike up).`)}</p>
    ${diagram}
  </div>`;
}

const RU_MON = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const EN_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDay = (dayMs: number, lang: Lang): string => { const d = new Date(dayMs); return lang === 'en' ? `${EN_MON[d.getUTCMonth()]} ${d.getUTCDate()}` : `${d.getUTCDate()} ${RU_MON[d.getUTCMonth()]}`; };

/** Scrollable per-UTC-day result tape — one chip per day (net %, $, trade count), newest first, today highlit. */
function dailyStrip(rows: WfRow[], lang: Lang): string {
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
      <div class="d">${fmtDay(day, lang)}${day === today ? t(lang, ' · сегодня', ' · today') : ''}</div>
      <div class="v ${cls(e.pct)}">${pct(e.pct)}</div>
      <div class="s">${usd(e.usd, true)} · ${e.n} ${t(lang, 'сд.', 'tr.')}</div>
    </div>`).join('');
  return `<div class="section"><div class="section-title">${t(lang, 'Результат по дням (net комиссий · листайте →)', 'Daily result (net of fees · scroll →)')}</div><div class="lt-days">${chips}</div></div>`;
}

export async function renderLiveTrack(page = 1, lang: Lang = 'ru'): Promise<string> {
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
  const limitsSection = await openLimitsSection(lang);

  const statCard = (l: string, v: string, vc = '', s = '', sc = ''): string =>
    `<div class="lt-stat"><div class="l">${l}</div><div class="v ${vc}">${v}</div>${s ? `<div class="s ${sc}">${s}</div>` : ''}</div>`;

  const cards = hasData ? `
    <div class="lt-cards">
      ${statCard(t(lang, 'Монет в работе', 'Coins traded'), String(universe), '', st.open > 0 ? t(lang, `${st.open} сейчас открыто`, `${st.open} open now`) : t(lang, `${distinctTraded} уже дали сделки`, `${distinctTraded} have traded`))}
      ${statCard(t(lang, 'Накопл. результат', 'Cumulative result'), pct(st.netPct), cls(st.netPct), `${usd(st.netUsd, true)} · ${t(lang, 'net комиссий', 'net of fees')}`, cls(st.netUsd))}
      ${statCard(t(lang, 'Результат за день', 'Result today'), todayRows.length ? pct(todayPct) : '—', cls(todayPct), todayRows.length ? t(lang, `${usd(todayUsd, true)} · ${todayRows.length} сделок (UTC)`, `${usd(todayUsd, true)} · ${todayRows.length} trades (UTC)`) : t(lang, 'сегодня сделок нет', 'no trades today'), cls(todayUsd))}
      ${statCard(t(lang, 'Закрытых сделок', 'Closed trades'), String(st.closed), '', t(lang, `за ${st.daysLive} дн.`, `in ${st.daysLive}d`))}
      ${statCard(t(lang, 'Винрейт', 'Win rate'), st.winRate != null ? `${(st.winRate * 100).toFixed(0)}%` : '—', '', t(lang, `${st.wins} прибыльных · ${st.losses} убыточных`, `${st.wins} winners · ${st.losses} losers`))}
      ${statCard(t(lang, 'Профит-фактор', 'Profit factor'), st.profitFactor != null ? st.profitFactor.toFixed(2) : '—', st.profitFactor != null && st.profitFactor >= 1 ? 'pos' : st.profitFactor != null ? 'neg' : '', t(lang, 'прибыль / убыток', 'profit / loss'))}
      ${statCard(t(lang, 'Лучшая сделка', 'Best trade'), pct(st.best), 'pos', esc(rows.find((r) => (r.pnl_pct ?? 0) === st.best)?.coin ?? ''))}
      ${statCard(t(lang, 'Худшая сделка', 'Worst trade'), pct(st.worst), 'neg', esc(rows.find((r) => (r.pnl_pct ?? 0) === st.worst)?.coin ?? ''))}
      ${statCard(t(lang, 'Средняя / сделку', 'Avg / trade'), pct(st.avgPct), cls(st.avgPct), t(lang, 'net комиссий', 'net of fees'))}
      ${statCard(t(lang, 'Комиссии уплачено', 'Fees paid'), usd(feeEntry + feeExit), '', t(lang, `вход ${usd(feeEntry)} (maker) · выход ${usd(feeExit)} (taker)`, `entry ${usd(feeEntry)} (maker) · exit ${usd(feeExit)} (taker)`))}
    </div>` : '';

  const stages = roadmap(st, lang).map((s) => `
    <div class="rm-item ${s.status}">
      <div class="rm-dot"></div>
      <div class="rm-head"><span class="rm-title">${esc(s.title)}</span>${s.meta ? `<span class="rm-meta">${esc(s.meta)}</span>` : ''}</div>
      <div class="rm-desc">${esc(s.desc)}</div>
    </div>`).join('');

  const emptyState = `<div class="card"><div class="card-body"><div class="empty-state" style="padding:26px 0;text-align:center;">
      ⏳ ${t(lang, 'Боевой трек на паузе — копим статистику. Данные появятся здесь автоматически, как только пойдут сделки.', 'Live track paused — accumulating statistics. Data will appear here automatically once trades resume.')}
    </div></div></div>`;

  return pageShell(
    t(lang, 'Боевой трек — реальные результаты · Robot Claude', 'Live Track — real results · Robot Claude'),
    `
    <div class="header">
      <a class="lt-back" href="/lab">${t(lang, '← в лабораторию', '← to the lab')}</a>
      <span class="strat-code">${t(lang, 'LIVE · HYPERLIQUID · РЕАЛЬНЫЕ ДЕНЬГИ', 'LIVE · HYPERLIQUID · REAL MONEY')}</span>
      <h1 class="title">${t(lang, 'Боевой трек', 'Live Track')}</h1>
      <p class="subtitle">${t(lang, 'Что мы делаем, реальная статистика и к чему идём. Всё ниже — живые данные, net комиссий.', 'What we do, real statistics, and where we’re headed. Everything below is live data, net of fees.')}</p>
    </div>
    <style>${TRACK_CSS}</style>

    <div class="lt-intro">
      ${t(lang, `<b>Robot Claude</b> — систематическая торговая система на бирже Hyperliquid. Алгоритм одновременно ведёт
      книгу из <b>${universe} ликвидных монет</b> (лонг и шорт), отслеживает краткосрочные ценовые аномалии и
      зарабатывает на возврате цены к норме.
      Работает 24/7 без ручного управления: вход, выход и защита от резких движений — полностью автоматические.
      <b>Никаких обещаний</b> — только реальный трек ниже, каждая сделка с настоящей точкой входа и результатом
      после комиссий.`, `<b>Robot Claude</b> is a systematic trading system on Hyperliquid. The algorithm runs a book of
      <b>${universe} liquid coins</b> (long and short) simultaneously, watches for short-term price anomalies and
      earns on the reversion back to fair value.
      It runs 24/7 with no manual intervention: entry, exit and protection against sharp moves are fully automatic.
      <b>No promises</b> — only the real track record below, every trade with a genuine entry point and result
      net of fees.`)}
    </div>

    <div class="lt-phase">
      <span class="dot"></span>
      <div>${t(lang, `<b>Сейчас: фаза живой валидации.</b> Система торгует реальными деньгами на небольшом капитале.
      Задача этого этапа — не максимальная прибыль, а <b>честная статистика</b> на настоящих издержках. Именно
      этот проверенный трек — фундамент, на котором мы масштабируемся (см. дорожную карту внизу).`, `<b>Now: the live-validation phase.</b> The system trades real money at small size.
      The goal of this stage is not maximum profit but <b>honest statistics</b> on real costs. This proven
      track record is the foundation we scale from (see the roadmap below).`)}</div>
    </div>

    ${hasData ? cards : ''}
    ${hasData ? `<div class="section"><div class="section-title">${t(lang, 'Кривая результата (накопленный %, net комиссий)', 'Result curve (cumulative %, net of fees)')}</div>${equityCurve(st.cum, lang)}</div>` : ''}
    ${hasData ? dailyStrip(rows, lang) : ''}
    ${strategyDetail(universe, lang)}
    ${limitsSection}
    ${openPositionsSection(Date.now(), lang)}
    ${hasData ? `<div class="section" id="trades"><div class="section-title">${t(lang, `Закрытые сделки · все ${st.closed}`, `Closed trades · all ${st.closed}`)}</div>${tradesTable(rows, page, lang)}</div>` : emptyState}

    <div class="section">
      <div class="section-title">${t(lang, 'Дорожная карта', 'Roadmap')}</div>
      <div class="rm">${stages}</div>
    </div>

    <p class="lt-note">
      ${t(lang, `Данные обновляются автоматически из журнала сделок системы — страница не может расходиться с реальностью.
      Результаты указаны за вычетом комиссий (≈0.05% на сделку). Прошлые результаты не гарантируют будущих;
      это не инвестиционная рекомендация. Малый размер сумм в долларах — следствие тестового капитала на фазе валидации.`, `Data updates automatically from the system’s trade log — the page cannot diverge from reality.
      Results are shown net of fees (≈0.05% per trade). Past results do not guarantee future ones;
      this is not investment advice. The small dollar amounts are a consequence of the test capital in the validation phase.`)}
    </p>
    `,
    { autoRefreshSec: 60, lang },
  );
}

/** Compact live-track summary for the hero card at the top of /lab. */
export function liveTrackHero(lang: Lang = 'ru'): string {
  const rows = closedStmt.all();
  if (rows.length === 0) return '';
  const st = computeStats(rows, openStmt.all().length);
  return `
    <a class="lt-hero" href="/lab/live">
      <div class="lt-hero-l">
        <span class="lt-hero-badge">🟢 LIVE · Hyperliquid · ${t(lang, 'реальные деньги', 'real money')}</span>
        <div class="lt-hero-title">${t(lang, 'Боевой трек — реальные результаты', 'Live track — real results')}</div>
        <div class="lt-hero-sub">${t(lang, 'Что мы делаем, честная статистика и дорожная карта →', 'What we do, honest stats, and the roadmap →')}</div>
      </div>
      <div class="lt-hero-r">
        <div class="lt-hero-stat"><div class="v ${cls(st.netPct)}">${pct(st.netPct)}</div><div class="k">${t(lang, 'накопл.', 'cumul.')}</div></div>
        <div class="lt-hero-stat"><div class="v">${WF_CONFIG.coins.length}</div><div class="k">${t(lang, 'монет', 'coins')}</div></div>
        <div class="lt-hero-stat"><div class="v">${st.closed}</div><div class="k">${t(lang, 'сделок', 'trades')}</div></div>
        <div class="lt-hero-stat"><div class="v">${st.winRate != null ? `${(st.winRate * 100).toFixed(0)}%` : '—'}</div><div class="k">${t(lang, 'винрейт', 'win rate')}</div></div>
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
  app.get<{ Querystring: { page?: string } }>('/lab/live', async (req, reply) => {
    const page = Math.max(1, parseInt(req.query.page ?? '1', 10) || 1);
    reply.type('text/html; charset=utf-8');
    reply.header('Cache-Control', 'public, max-age=30');
    return renderLiveTrack(page, getLang(req));
  });
}
