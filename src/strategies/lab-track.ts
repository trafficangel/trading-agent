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
type MomRow = {
  id: number; coin: string; side: string; entry_px: number; qty: number; opened_at: number; signal: string;
  exit_px: number | null; closed_at: number | null; pnl_pct: number | null; close_reason: string | null;
};
const closedStmt = db.prepare<[], WfRow>(`SELECT * FROM wick_fade_log WHERE mode='live' AND closed_at IS NOT NULL ORDER BY closed_at ASC`);
const openStmt = db.prepare<[], WfRow>(`SELECT * FROM wick_fade_log WHERE mode='live' AND closed_at IS NULL ORDER BY opened_at DESC`);
const momClosedStmt = db.prepare<[], MomRow>(`SELECT * FROM hl_momentum_live_log WHERE closed_at IS NOT NULL ORDER BY closed_at ASC`);
const momOpenStmt = db.prepare<[], MomRow>(`SELECT * FROM hl_momentum_live_pos ORDER BY opened_at DESC`);
const limitVolClosesStmt = db.prepare<[string, number], { t: number; c: number }>(`SELECT t, c FROM hl_candles WHERE coin = ? ORDER BY t DESC LIMIT ?`);
const runtimeConfigStmt = db.prepare<[string], { value: string }>(`SELECT value FROM runtime_config WHERE key = ?`);
const momUniverseStmt = db.prepare<[number], { coins: number; fresh: number | null; newest: number | null }>(`
  SELECT COUNT(*) AS coins,
         SUM(CASE WHEN newest_t >= ? THEN 1 ELSE 0 END) AS fresh,
         MAX(newest_t) AS newest
    FROM (
      SELECT coin, COUNT(*) AS n, MAX(t) AS newest_t
        FROM hl_candles
       GROUP BY coin
      HAVING n >= 70
    )
`);
const momSignalStatsStmt = db.prepare<[number], {
  total: number; live_open: number | null; skipped: number | null; paper: number | null;
  avg_score: number | null; avg_ev: number | null; avg_prob: number | null; avg_prob_conf: number | null;
  avg_kelly_conf: number | null; avg_spread: number | null; avg_depth: number | null; avg_notional: number | null;
}>(`
  SELECT COUNT(*) AS total,
         SUM(CASE WHEN decision = 'live-open' THEN 1 ELSE 0 END) AS live_open,
         SUM(CASE WHEN decision = 'skip' THEN 1 ELSE 0 END) AS skipped,
         SUM(CASE WHEN decision = 'paper' THEN 1 ELSE 0 END) AS paper,
         AVG(score) AS avg_score,
         AVG(expected_pnl) AS avg_ev,
         AVG(calibrated_prob) AS avg_prob,
         AVG(prob_confidence) AS avg_prob_conf,
         AVG(kelly_confidence) AS avg_kelly_conf,
         AVG(spread_pct) AS avg_spread,
         AVG(side_depth_usd) AS avg_depth,
         AVG(notional_usd) AS avg_notional
    FROM hl_momentum_signal_journal
   WHERE ts >= ?
`);
const momSessionPnlStmt = db.prepare<[number], { closed: number; pct: number | null; usd: number | null }>(`
  SELECT COUNT(*) AS closed,
         SUM(pnl_pct) AS pct,
         SUM((pnl_pct / 100.0) * qty * entry_px) AS usd
    FROM hl_momentum_live_log
   WHERE closed_at IS NOT NULL AND pnl_pct IS NOT NULL AND closed_at >= ?
`);
const momEngineOpenStmt = db.prepare<[], { open: number; notional: number | null }>(`
  SELECT COUNT(*) AS open, SUM(qty * entry_px) AS notional FROM hl_momentum_live_pos
`);
const MOMENTUM_PUBLIC_START_FALLBACK_MS = Date.UTC(2026, 6, 8, 18, 14, 0);

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
const momNotionalOf = (r: MomRow): number => r.qty * r.entry_px;
const momUsdOf = (r: MomRow): number => ((r.pnl_pct ?? 0) / 100) * momNotionalOf(r);
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

function momentumPublicRows(rows: MomRow[]): MomRow[] {
  const startMs = momentumPublicStartMs();
  return rows.filter((r) => r.opened_at >= startMs);
}

function momentumPublicStartMs(): number {
  const raw = Number(runtimeConfigStmt.get('hl_momentum_public_start_ms')?.value ?? MOMENTUM_PUBLIC_START_FALLBACK_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : MOMENTUM_PUBLIC_START_FALLBACK_MS;
}

function runtimeNum(key: string, fallback: number): number {
  const raw = Number(runtimeConfigStmt.get(key)?.value ?? fallback);
  return Number.isFinite(raw) ? raw : fallback;
}

function todayStartUtcMs(nowMs = Date.now()): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function momentumPublicStartText(lang: Lang): string {
  const d = new Date(momentumPublicStartMs());
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const monthsRu = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const monthsEn = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return lang === 'en'
    ? `${monthsEn[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}, ${hh}:${mm} UTC`
    : `${d.getUTCDate()} ${monthsRu[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

function ageText(ms: number | null, lang: Lang): string {
  if (ms == null) return '—';
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (mins < 60) return `${mins}${t(lang, 'м назад', 'm ago')}`;
  return `${Math.floor(mins / 60)}${t(lang, 'ч ', 'h ')}${mins % 60}${t(lang, 'м назад', 'm ago')}`;
}

type LimitVol = { volPct4h: number; factor: number; ageMs: number | null };
function limitVolState(coin: string): LimitVol | null {
  const W = WF_CONFIG.volWindow;
  let rows: { t: number; c: number }[];
  try { rows = limitVolClosesStmt.all(coin, 550); } catch { return null; }
  const newestT = rows[0]?.t ?? null;
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
  return {
    volPct4h: cur * Math.sqrt(W) * 100,
    factor: Math.min(2, Math.max(0.4, rawFactor)),
    ageMs: newestT == null ? null : Date.now() - newestT,
  };
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
    // Public market snapshot is informative only; the table still renders raw exchange orders without it.
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
  .ops-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:0 0 14px}
  @media(max-width:900px){.ops-grid{grid-template-columns:repeat(2,1fr)}}
  @media(max-width:560px){.ops-grid{grid-template-columns:1fr}}
  .ops-card{background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:14px 15px}
  .ops-card .k{font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--text-faint)}
  .ops-card .v{font-size:21px;font-weight:650;line-height:1.15;margin-top:6px;font-variant-numeric:tabular-nums;color:var(--text)}
  .ops-card .v.pos{color:var(--accent)}.ops-card .v.neg{color:var(--danger)}
  .ops-card .s{font-size:12px;color:var(--text-dim);line-height:1.45;margin-top:5px}
  .ops-table{background:var(--bg-card);border:1px solid var(--border);border-radius:12px;overflow:hidden}
  .ops-row{display:grid;grid-template-columns:190px 1fr;gap:16px;padding:12px 14px;border-bottom:1px solid var(--border)}
  .ops-row:last-child{border-bottom:none}
  .ops-row .k{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-faint);font-weight:650}
  .ops-row .v{font-size:13px;color:var(--text-dim);line-height:1.5}
  .ops-row .v b{color:var(--text)}
  .ops-tags{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
  .ops-tag{display:inline-flex;align-items:center;border:1px solid var(--border);border-radius:999px;padding:3px 8px;font-size:11px;color:var(--text-dim);background:rgba(255,255,255,.02)}
  @media(max-width:640px){.ops-row{grid-template-columns:1fr;gap:5px}}
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
  .limit-corridor{display:inline-flex;align-items:center;gap:6px;font-weight:650}
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
  .mom-link{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:16px 18px;text-decoration:none;color:var(--text);transition:border-color .15s}
  .mom-link:hover{border-color:var(--accent)}
  .mom-link-badge{display:inline-block;font-size:10.5px;font-weight:700;letter-spacing:.05em;color:var(--accent);background:var(--accent-soft);border-radius:999px;padding:3px 9px;margin-bottom:7px}
  .mom-link-title{font-size:18px;font-weight:650}
  .mom-link-sub{font-size:13px;color:var(--text-dim);margin-top:3px}
  .mom-link-stats{display:flex;gap:18px;text-align:right}
  .mom-link-stats b{display:block;font-size:20px;font-weight:650;font-variant-numeric:tabular-nums;line-height:1.1}
  .mom-link-stats b.pos{color:var(--accent)}.mom-link-stats b.neg{color:var(--danger)}
  .mom-link-stats small{display:block;font-size:10.5px;color:var(--text-faint);text-transform:uppercase;letter-spacing:.04em;margin-top:2px}
  @media(max-width:560px){.mom-link-stats{width:100%;justify-content:space-between;text-align:left}}
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

function momentumLiveSection(nowMs: number, lang: Lang): string {
  const closed = momentumPublicRows(momClosedStmt.all());
  const open = momentumPublicRows(momOpenStmt.all());
  const pnls = closed.map((r) => r.pnl_pct ?? 0);
  const net = pnls.reduce((s, p) => s + p, 0);
  const wins = pnls.filter((p) => p > 0).length;
  const losses = pnls.filter((p) => p < 0).length;
  const netUsd = closed.reduce((s, r) => s + momUsdOf(r), 0);
  const wr = wins + losses > 0 ? `${((wins / (wins + losses)) * 100).toFixed(0)}%` : '—';
  const openRows = open.map((r) => `<tr>
    <td><b>${esc(r.coin)}</b></td>
    <td><span class="sd ${r.side === 'long' ? 'long' : 'short'}">${r.side.toUpperCase()}</span></td>
    <td class="r mono">${r.entry_px}</td>
    <td class="r">${usd(momNotionalOf(r))}</td>
    <td class="dt">${heldStr(r.opened_at, nowMs, lang)}</td>
  </tr>`).join('');
  const recent = closed.slice().reverse().slice(0, 12).map((r) => {
    const p = r.pnl_pct ?? 0;
    return `<tr>
      <td>#${r.id}</td>
      <td><b>${esc(r.coin)}</b></td>
      <td><span class="sd ${r.side === 'long' ? 'long' : 'short'}">${r.side.toUpperCase()}</span></td>
      <td class="r mono">${r.entry_px}</td>
      <td class="r mono">${r.exit_px ?? '—'}</td>
      <td class="r mono ${cls(p)}">${pct(p)}</td>
      <td class="r ${cls(momUsdOf(r))}">${usd(momUsdOf(r), true)}</td>
      <td><span class="rp">${esc(r.close_reason ?? '—')}</span></td>
      <td class="dt">${fmtDt(r.opened_at)}</td>
    </tr>`;
  }).join('');

  return `<div class="section" id="momentum-live">
    <div class="section-title">${t(lang, 'Вторая live-механика: Momentum Follow', 'Second live mechanic: Momentum Follow')}</div>
    <p class="sd-lead">${t(lang,
      'Это противоположность основной wick-fade стратегии. Если wick-fade ловит возврат после шипа, то Momentum Follow входит <b>по направлению импульса</b>, когда движение подтверждено объёмом и удержанием цены. Размер выбирается консервативным Kelly внутри micro-коридора, 1x, с биржевым стопом; монета временно блокируется для wick-fade, чтобы стратегии не конфликтовали.',
      'This is the opposite of the main wick-fade strategy. If wick-fade catches snap-back after a spike, Momentum Follow enters <b>with the impulse</b> when the move is confirmed by volume and price holding. Size is selected by conservative Kelly inside a micro range, 1x, with an exchange stop; the coin is temporarily locked away from wick-fade so the strategies cannot fight each other.')}</p>
    <div class="lt-cards">
      <div class="lt-stat"><div class="l">${t(lang, 'Статус', 'Status')}</div><div class="v">${t(lang, 'REAL · малый размер', 'REAL · small size')}</div><div class="s">${t(lang, 'проверяем на деньгах', 'testing with real money')}</div></div>
      <div class="lt-stat"><div class="l">${t(lang, 'Закрытых', 'Closed')}</div><div class="v">${closed.length}</div><div class="s">${open.length} ${t(lang, 'открыто', 'open')}</div></div>
      <div class="lt-stat"><div class="l">${t(lang, 'Результат', 'Result')}</div><div class="v ${cls(net)}">${pct(net)}</div><div class="s ${cls(netUsd)}">${usd(netUsd, true)}</div></div>
      <div class="lt-stat"><div class="l">${t(lang, 'WR', 'WR')}</div><div class="v">${wr}</div><div class="s">${wins}W / ${losses}L</div></div>
    </div>
    ${open.length ? `<div class="section-subtitle">${t(lang, 'Momentum открыто сейчас', 'Momentum open now')}</div><div class="card table-wrap"><table class="lt-tbl"><thead><tr><th>${t(lang, 'Монета', 'Coin')}</th><th>${t(lang, 'Сторона', 'Side')}</th><th class="r">${t(lang, 'Вход', 'Entry')}</th><th class="r">${t(lang, 'Размер', 'Size')}</th><th>${t(lang, 'В работе', 'Held')}</th></tr></thead><tbody>${openRows}</tbody></table></div>` : ''}
    ${closed.length ? `<div class="section-subtitle">${t(lang, 'Momentum закрытые сделки', 'Momentum closed trades')}</div><div class="card table-wrap"><table class="lt-tbl"><thead><tr><th>#</th><th>${t(lang, 'Монета', 'Coin')}</th><th>${t(lang, 'Сторона', 'Side')}</th><th class="r">${t(lang, 'Вход', 'Entry')}</th><th class="r">${t(lang, 'Выход', 'Exit')}</th><th class="r">${t(lang, 'Результат', 'Result')}</th><th class="r">P&amp;L $</th><th>${t(lang, 'Как закрыли', 'Exit')}</th><th>${t(lang, 'Открыта (UTC)', 'Opened (UTC)')}</th></tr></thead><tbody>${recent}</tbody></table></div>` : ''}
  </div>`;
}

function momentumLinkSection(lang: Lang): string {
  const liveClosed = momentumPublicRows(momClosedStmt.all());
  const liveOpen = momentumPublicRows(momOpenStmt.all());
  const net = liveClosed.reduce((s, r) => s + (r.pnl_pct ?? 0), 0);
  return `<div class="section">
    <a class="mom-link" href="/lab/momentum">
      <div>
        <span class="mom-link-badge">${t(lang, 'MOMENTUM V2 · НОВЫЙ ОТСЧЁТ', 'MOMENTUM V2 · NEW TRACK')}</span>
        <div class="mom-link-title">Momentum Follow</div>
        <div class="mom-link-sub">${t(lang, 'Адаптивный 2s-радар по импульсам: описание, live-статистика и сделки →', 'Adaptive 2s impulse radar: description, live stats and trades →')}</div>
      </div>
      <div class="mom-link-stats">
        <span><b class="${cls(net)}">${pct(net)}</b><small>${t(lang, 'live', 'live')}</small></span>
        <span><b>${liveClosed.length}</b><small>${t(lang, 'закрыто', 'closed')}</small></span>
        <span><b>${liveOpen.length}</b><small>${t(lang, 'открыто', 'open')}</small></span>
      </div>
    </a>
  </div>`;
}

type MomStats = {
  closed: number; open: number; wins: number; losses: number; winRate: number | null;
  netPct: number; netUsd: number; avgPct: number; best: number; worst: number; profitFactor: number | null; cum: number[];
};
function computeMomentumStats(rows: MomRow[], open: number): MomStats {
  const pnls = rows.map((r) => r.pnl_pct ?? 0);
  const wins = pnls.filter((p) => p > 0).length;
  const losses = pnls.filter((p) => p < 0).length;
  const netPct = pnls.reduce((s, p) => s + p, 0);
  const netUsd = rows.reduce((s, r) => s + momUsdOf(r), 0);
  const grossWin = pnls.filter((p) => p > 0).reduce((s, p) => s + p, 0);
  const grossLoss = -pnls.filter((p) => p < 0).reduce((s, p) => s + p, 0);
  let cum = 0;
  const cumSeries: number[] = [];
  for (const p of pnls) { cum += p; cumSeries.push(cum); }
  return {
    closed: rows.length,
    open,
    wins,
    losses,
    winRate: wins + losses > 0 ? wins / (wins + losses) : null,
    netPct,
    netUsd,
    avgPct: rows.length ? netPct / rows.length : 0,
    best: pnls.length ? Math.max(...pnls) : 0,
    worst: pnls.length ? Math.min(...pnls) : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    cum: cumSeries,
  };
}

function momentumOpenTable(rows: MomRow[], nowMs: number, lang: Lang): string {
  if (rows.length === 0) return `<div class="card"><div class="card-body"><div class="empty-state" style="padding:18px 0;text-align:center;">${t(lang, 'Сейчас открытых Momentum-позиций нет.', 'No Momentum positions are open right now.')}</div></div></div>`;
  const body = rows.map((r) => `<tr>
    <td><b>${esc(r.coin)}</b></td>
    <td><span class="sd ${r.side === 'long' ? 'long' : 'short'}">${r.side.toUpperCase()}</span></td>
    <td class="r mono">${r.entry_px}</td>
    <td class="r">${usd(momNotionalOf(r))}</td>
    <td class="dt">${heldStr(r.opened_at, nowMs, lang)}</td>
  </tr>`).join('');
  return `<div class="card table-wrap"><table class="lt-tbl"><thead><tr>
    <th>${t(lang, 'Монета', 'Coin')}</th><th>${t(lang, 'Сторона', 'Side')}</th><th class="r">${t(lang, 'Вход', 'Entry')}</th>
    <th class="r">${t(lang, 'Размер', 'Size')}</th><th>${t(lang, 'В работе', 'Held')}</th>
  </tr></thead><tbody>${body}</tbody></table></div>`;
}

function momentumClosedTable(rows: MomRow[], page: number, baseUrl: string, lang: Lang): string {
  if (rows.length === 0) return `<div class="card"><div class="card-body"><div class="empty-state" style="padding:18px 0;text-align:center;">${t(lang, 'Закрытых сделок пока нет.', 'No closed trades yet.')}</div></div></div>`;
  const ordered = [...rows].sort((a, b) => (b.closed_at ?? 0) - (a.closed_at ?? 0));
  const pages = Math.max(1, Math.ceil(ordered.length / PER_PAGE));
  const p = Math.min(Math.max(1, page), pages);
  const from = (p - 1) * PER_PAGE;
  const body = ordered.slice(from, from + PER_PAGE).map((r) => {
    const pnl = r.pnl_pct ?? 0;
    return `<tr>
      <td>#${r.id}</td>
      <td><b>${esc(r.coin)}</b></td>
      <td><span class="sd ${r.side === 'long' ? 'long' : 'short'}">${r.side.toUpperCase()}</span></td>
      <td class="r mono">${r.entry_px}</td>
      <td class="r mono">${r.exit_px ?? '—'}</td>
      <td class="r mono ${cls(pnl)}">${pct(pnl)}</td>
      <td class="r ${cls(momUsdOf(r))}">${usd(momUsdOf(r), true)}</td>
      <td><span class="rp">${esc(r.close_reason ?? '—')}</span></td>
      <td class="dt">${fmtDt(r.opened_at)}</td>
    </tr>`;
  }).join('');
  const shown = Math.min(PER_PAGE, ordered.length - from);
  const pager = pages <= 1 ? '' : `<div class="lt-pager">
    ${p > 1 ? `<a href="${baseUrl}?page=${p - 1}#closed">${t(lang, '← Назад', '← Back')}</a>` : `<span class="off">${t(lang, '← Назад', '← Back')}</span>`}
    <span class="pg">${t(lang, 'Стр.', 'Page')} ${p} ${t(lang, 'из', 'of')} ${pages} · ${from + 1}–${from + shown} ${t(lang, 'из', 'of')} ${ordered.length}</span>
    ${p < pages ? `<a href="${baseUrl}?page=${p + 1}#closed">${t(lang, 'Вперёд →', 'Next →')}</a>` : `<span class="off">${t(lang, 'Вперёд →', 'Next →')}</span>`}
  </div>`;
  return `<div class="card table-wrap"><table class="lt-tbl"><thead><tr>
    <th>#</th><th>${t(lang, 'Монета', 'Coin')}</th><th>${t(lang, 'Сторона', 'Side')}</th><th class="r">${t(lang, 'Вход', 'Entry')}</th>
    <th class="r">${t(lang, 'Выход', 'Exit')}</th><th class="r">${t(lang, 'Результат', 'Result')}</th><th class="r">P&amp;L $</th>
    <th>${t(lang, 'Как закрыли', 'Exit')}</th><th>${t(lang, 'Открыта (UTC)', 'Opened (UTC)')}</th>
  </tr></thead><tbody>${body}</tbody></table></div>${pager}`;
}

function momentumDailyStrip(rows: MomRow[], lang: Lang): string {
  const byDay = new Map<number, { pct: number; usd: number; n: number }>();
  for (const r of rows) {
    if (r.closed_at == null) continue;
    const day = Math.floor(r.closed_at / 86_400_000) * 86_400_000;
    const e = byDay.get(day) ?? { pct: 0, usd: 0, n: 0 };
    e.pct += r.pnl_pct ?? 0; e.usd += momUsdOf(r); e.n++; byDay.set(day, e);
  }
  if (byDay.size === 0) return '';
  const today = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  const chips = [...byDay.entries()].sort((a, b) => b[0] - a[0]).map(([day, e]) => `
    <div class="lt-day${day === today ? ' today' : ''}">
      <div class="d">${fmtDay(day, lang)}${day === today ? t(lang, ' · сегодня', ' · today') : ''}</div>
      <div class="v ${cls(e.pct)}">${pct(e.pct)}</div>
      <div class="s">${usd(e.usd, true)} · ${e.n} ${t(lang, 'сд.', 'tr.')}</div>
    </div>`).join('');
  return `<div class="section"><div class="section-title">${t(lang, 'Momentum по дням', 'Momentum by day')}</div><div class="lt-days">${chips}</div></div>`;
}

function momentumOpsMetrics(liveOpenPublic: number, lang: Lang): string {
  const publicStart = momentumPublicStartMs();
  const universe = momUniverseStmt.get(Date.now() - 25 * 60_000) ?? { coins: 0, fresh: 0, newest: null };
  const sig = momSignalStatsStmt.get(publicStart) ?? {
    total: 0, live_open: 0, skipped: 0, paper: 0,
    avg_score: null, avg_ev: null, avg_prob: null, avg_prob_conf: null,
    avg_kelly_conf: null, avg_spread: null, avg_depth: null, avg_notional: null,
  };
  const sessionStart = runtimeNum('hl_momentum_live_day_reset_ms', todayStartUtcMs());
  const session = momSessionPnlStmt.get(sessionStart) ?? { closed: 0, pct: 0, usd: 0 };
  const engineOpen = momEngineOpenStmt.get() ?? { open: 0, notional: 0 };
  const maxOpen = runtimeNum('hl_momentum_live_max_open', 4);
  const minNotional = runtimeNum('hl_momentum_min_notional_usd', 11);
  const maxNotional = runtimeNum('hl_momentum_max_notional_usd', 24);
  const minProb = runtimeNum('hl_momentum_min_calibrated_prob', 0.49);
  const minScore = runtimeNum('hl_momentum_min_live_score', 68);
  const minEv = runtimeNum('hl_momentum_min_expected_pnl_pct', 0.10);
  const stopUsd = runtimeNum('hl_momentum_live_daily_stop_usd', -20);
  const usedUsd = session.usd ?? 0;
  const stopLeft = Math.max(0, Math.abs(stopUsd) - Math.max(0, -usedUsd));
  const kellyOn = runtimeNum('hl_momentum_kelly_enabled', 1) >= 0.5;
  const metric = (k: string, v: string, s: string, clsName = ''): string =>
    `<div class="ops-card"><div class="k">${k}</div><div class="v ${clsName}">${v}</div><div class="s">${s}</div></div>`;

  return `<div class="section">
    <div class="section-title">${t(lang, 'Боевые метрики системы', 'Live system metrics')}</div>
    <div class="ops-grid">
      ${metric(t(lang, 'Рынок', 'Market'), `${universe.fresh ?? 0} / ${universe.coins}`, t(lang, `свежих монет из архива · свечи обновлены ${ageText(universe.newest, lang)}`, `fresh coins from archive · candles updated ${ageText(universe.newest, lang)}`))}
      ${metric(t(lang, 'Радар', 'Radar'), '2s', t(lang, 'allMids по всему рынку + 5m подтверждающий слой раз в минуту', 'allMids across the market + 5m confirmation layer every minute'))}
      ${metric(t(lang, 'Сигналы', 'Signals'), String(sig.total), t(lang, `${sig.skipped ?? 0} отфильтрованы защитой · ${sig.live_open ?? 0} новых live-входов`, `${sig.skipped ?? 0} filtered by protection · ${sig.live_open ?? 0} new live entries`))}
      ${metric(t(lang, 'Позиции', 'Positions'), `${liveOpenPublic} / ${maxOpen}`, t(lang, `${engineOpen.open} сейчас под управлением движка · публичный трек показывает новые после reset`, `${engineOpen.open} currently managed by engine · public track shows new ones after reset`))}
      ${metric(t(lang, 'Качество входа', 'Entry quality'), `score ≥ ${minScore}`, t(lang, `p ≥ ${minProb.toFixed(2)} · EV ≥ ${minEv.toFixed(2)}% · средний score ${sig.avg_score != null ? sig.avg_score.toFixed(0) : '—'}`, `p ≥ ${minProb.toFixed(2)} · EV ≥ ${minEv.toFixed(2)}% · avg score ${sig.avg_score != null ? sig.avg_score.toFixed(0) : '—'}`))}
      ${metric(t(lang, 'Kelly размер', 'Kelly sizing'), `$${minNotional.toFixed(0)}–${maxNotional.toFixed(0)}`, t(lang, `${kellyOn ? 'включён' : 'выключен'} · средний размер сигнала ${sig.avg_notional != null ? usd(sig.avg_notional) : '—'}`, `${kellyOn ? 'enabled' : 'disabled'} · avg signal size ${sig.avg_notional != null ? usd(sig.avg_notional) : '—'}`))}
      ${metric(t(lang, 'Dollar-stop', 'Dollar stop'), usd(stopUsd, true), t(lang, `сессия ${usd(usedUsd, true)} · до стопа ${usd(stopLeft)}`, `session ${usd(usedUsd, true)} · to stop ${usd(stopLeft)}`), usedUsd < 0 ? 'neg' : '')}
      ${metric(t(lang, 'Ликвидность', 'Liquidity'), '≤0.35%', t(lang, `макс. спред · top3 стакан ≥ $150 · ордер ≤10% глубины`, `max spread · top3 book ≥ $150 · order ≤10% of depth`))}
    </div>
    <div class="ops-table">
      <div class="ops-row">
        <div class="k">${t(lang, 'Что считаем всплеском', 'Impulse definition')}</div>
        <div class="v">${t(lang,
          'Быстрый слой смотрит сдвиги <b>r30/r90</b> за 30/90 секунд и движение от последней 5m-свечи. Подтверждающий слой смотрит <b>r3</b> за 3 свечи, <b>r12</b> за час, объём, закрытие у нужного края диапазона и не слишком позднее расширение.',
          'The fast layer watches <b>r30/r90</b> moves over 30/90 seconds and movement from the last 5m close. The confirmation layer watches <b>r3</b> over 3 candles, <b>r12</b> over one hour, volume, close near the correct range edge, and avoids late extension.'
        )}<div class="ops-tags"><span class="ops-tag">r30 / r90</span><span class="ops-tag">from 5m close</span><span class="ops-tag">r3 / r12</span><span class="ops-tag">volume ratio</span><span class="ops-tag">close edge</span></div></div>
      </div>
      <div class="ops-row">
        <div class="k">${t(lang, 'Фильтры входа', 'Entry filters')}</div>
        <div class="v">${t(lang,
          'Перед live-входом проверяем, что монета свободна, wick-fade её не держит, нет перегруза по одной стороне, нет кластерного импульса, стакан достаточно глубокий, а calibrated probability и EV проходят порог.',
          'Before a live entry we check that the coin is free, wick-fade does not hold it, same-side exposure is not crowded, there is no impulse cluster, the book is deep enough, and calibrated probability plus EV pass the gate.'
        )}<div class="ops-tags"><span class="ops-tag">free coin</span><span class="ops-tag">no wick-fade conflict</span><span class="ops-tag">portfolio crowding</span><span class="ops-tag">regime breadth</span><span class="ops-tag">spread/depth</span></div></div>
      </div>
      <div class="ops-row">
        <div class="k">${t(lang, 'Риск и выход', 'Risk and exit')}</div>
        <div class="v">${t(lang,
          'Стоп строится от волатильности монеты в bounded-коридоре примерно <b>1.5–1.8%</b>. Трейлинг включается только после движения с расчётным R:R не хуже 1:2, откат для fast-менеджера узкий, а если импульс быстро не подтвердился, включается momentum-decay.',
          'The stop is derived from coin volatility inside a bounded <b>1.5–1.8%</b> range. Trailing only activates after a move with designed R:R at least 1:2, fast giveback is tight, and if impulse does not confirm quickly, momentum-decay can exit.'
        )}<div class="ops-tags"><span class="ops-tag">exchange stop</span><span class="ops-tag">dynamic trail</span><span class="ops-tag">R:R ≥ 1:2</span><span class="ops-tag">momentum-decay</span><span class="ops-tag">session dollar-stop</span></div></div>
      </div>
    </div>
  </div>`;
}

function momentumStrategyDetail(lang: Lang): string {
  return `<div class="section">
    <div class="section-title">${t(lang, 'Как устроена Momentum Follow', 'How Momentum Follow works')}</div>
    <p class="sd-lead">${t(lang,
      'Momentum Follow v2 — отдельная трендовая механика на Hyperliquid, противоположная основной wick-fade. Она не ловит откат после шипа, а пытается войти <b>по направлению резкого импульса</b>. Система смотрит весь рынок лёгким 2-секундным allMids-радаром, пересчитывает порог всплеска под волатильность каждой монеты и в real входит только после проверок стакана, спреда, свободной монеты и риск-лимитов.',
      'Momentum Follow v2 is a separate trend mechanic on Hyperliquid, opposite to the main wick-fade. It does not catch snap-backs after spikes; it tries to enter <b>with a sharp impulse</b>. The system watches the full market with a lightweight 2-second allMids radar, recalculates the impulse threshold from each coin’s volatility, and only enters live after book depth, spread, free-coin and risk-limit checks.')}</p>
    <div class="sd-steps">
      <div class="sd-step"><span class="n">1</span><h5>${t(lang, 'Адаптивный all-market сканер', 'Adaptive all-market scanner')}</h5><p>${t(lang, 'Каждые 2 секунды лёгкий allMids-радар смотрит весь рынок на резкие intrabar-сдвиги, а раз в минуту подтверждающий слой проверяет закрытые 5-минутные свечи. Порог всплеска не фиксированный: он пересчитывается по текущей волатильности монеты, свежему объёмному профилю и часовому направлению.', 'Every 2 seconds a light allMids radar watches the full market for sharp intrabar moves, while a confirming layer checks closed 5-minute candles every minute. The impulse threshold is not fixed: it is recalculated from the coin’s current volatility, recent volume profile, and one-hour direction.')}</p></div>
      <div class="sd-step"><span class="n">2</span><h5>${t(lang, 'Вход по тренду', 'Trend entry')}</h5><p>${t(lang, 'Если монета свободна, wick-fade не держит позицию, спред нормальный и в стакане достаточно глубины, стратегия входит малым рыночным ордером по направлению импульса. Быстрый слой может войти внутри 5m свечи; подтверждающий слой раз в минуту проверяет закрытые свечи, объём и закрытие у правильного края диапазона.', 'If the coin is free, wick-fade has no position, spread is acceptable and the book has enough depth, the strategy enters with a small market order in the impulse direction. The fast layer can enter inside a 5-minute candle; the confirming layer checks closed candles, volume and range-edge close every minute.')}</p></div>
      <div class="sd-step cat"><span class="n">3</span><h5>${t(lang, 'Динамический риск, Kelly-размер и быстрый выход', 'Dynamic risk, Kelly sizing and fast exit')}</h5><p>${t(lang, 'На входе считаем волатильность монеты и от неё строим стоп, зону включения трейлинга и допустимый откат. Размер позиции тоже не фиксированный: score/EV сигнала переводится в консервативный fractional Kelly, но остаётся в micro-коридоре. Биржевой стоп ставится сразу; 2-секундный fast-менеджер может закрыть по трейлингу внутри свечи. Модель держит расчётный risk/reward не хуже 1:2.', 'At entry, the strategy estimates coin volatility and derives the stop, trailing activation zone and allowed giveback from it. Position size is not fixed either: signal score/EV is converted into conservative fractional Kelly while staying inside a micro range. An exchange stop is placed immediately; the 2-second fast manager can close on trailing inside the candle. Designed risk/reward stays at least 1:2.')}</p></div>
    </div>
    <div class="sd-blocks">
      <div class="sd-block">
        <h4>${t(lang, 'Зачем она нужна', 'Why it exists')}</h4>
        <ul>
          <li>${t(lang, 'Wick-fade зарабатывает на возврате к средней; Momentum Follow покрывает режимы, где рынок <b>не возвращается</b>, а продолжает движение.', 'Wick-fade earns on mean reversion; Momentum Follow covers regimes where the market <b>does not revert</b> and continues moving.')}</li>
          <li>${t(lang, 'Это диверсификация по логике, а не ещё одна копия той же ставки.', 'This is diversification by logic, not another copy of the same bet.')}</li>
          <li>${t(lang, 'Пока размер специально минимальный: задача — собрать настоящую статистику на деньгах.', 'Size is intentionally minimal for now: the goal is to collect real-money statistics.')}</li>
        </ul>
      </div>
      <div class="sd-block risk">
        <h4>${t(lang, 'Защита от конфликта', 'Conflict protection')}</h4>
        <ul>
          <li>${t(lang, 'Одна монета не может одновременно управляться двумя live-механиками.', 'One coin cannot be managed by two live mechanics at the same time.')}</li>
          <li>${t(lang, 'При входе Momentum монета блокируется для wick-fade, а его лимитки по этой монете снимаются.', 'When Momentum enters, the coin is locked away from wick-fade and its resting limits on that coin are pulled.')}</li>
          <li>${t(lang, 'Биржевой стоп ставится сразу после подтверждения позиции; кодовый poll остаётся резервной защитой.', 'An exchange stop is placed immediately after position confirmation; the code poll remains backup protection.')}</li>
          <li>${t(lang, 'Momentum Doctor регулярно пересчитывает контрфакты по закрытым live-сделкам и может менять только ограниченные параметры риска после достаточной выборки.', 'Momentum Doctor regularly recomputes counterfactuals on closed live trades and can only tune bounded risk parameters after enough sample size.')}</li>
        </ul>
      </div>
    </div>
  </div>`;
}

export function renderMomentumTrack(page = 1, lang: Lang = 'ru'): string {
  const liveClosed = momentumPublicRows(momClosedStmt.all());
  const liveOpen = momentumPublicRows(momOpenStmt.all());
  const live = computeMomentumStats(liveClosed, liveOpen.length);
  const statCard = (l: string, v: string, vc = '', s = '', sc = ''): string =>
    `<div class="lt-stat"><div class="l">${l}</div><div class="v ${vc}">${v}</div>${s ? `<div class="s ${sc}">${s}</div>` : ''}</div>`;

  return pageShell(
    t(lang, 'Momentum Follow — отдельная live-стратегия · Robot Claude', 'Momentum Follow — separate live strategy · Robot Claude'),
    `
    <div class="header">
      <a class="lt-back" href="/lab">${t(lang, '← в лабораторию', '← to the lab')}</a>
      <a class="lt-back" href="/lab/live" style="margin-left:12px">${t(lang, '← основной live-трек', '← main live track')}</a>
      <span class="strat-code">${t(lang, 'LIVE MICRO · HYPERLIQUID · MOMENTUM V2', 'LIVE MICRO · HYPERLIQUID · MOMENTUM V2')}</span>
      <h1 class="title">Momentum Follow</h1>
      <p class="subtitle">${t(lang, 'Адаптивная трендовая стратегия: 2-секундный радар всплесков, score/EV/Kelly-размер, новый публичный отсчёт.', 'Adaptive trend strategy: 2-second impulse radar, score/EV/Kelly sizing, new public track.')}</p>
    </div>
    <style>${TRACK_CSS}</style>

    <div class="lt-phase">
      <span class="dot"></span>
      <div>${t(lang, '<b>Статус: real micro · новый публичный отсчёт.</b> Статистика ниже считается с адаптивной версии стратегии, запущенной ', '<b>Status: real micro · new public track.</b> The stats below are counted from the adaptive version launched at ')}${momentumPublicStartText(lang)}${t(lang, '. Размер выбирается по консервативному Kelly в micro-коридоре, плечо 1x, стоп на бирже.', '. Size is selected by conservative Kelly inside a micro range, leverage 1x, stop on exchange.')}</div>
    </div>

    <div class="lt-cards">
      ${statCard(t(lang, 'Live результат', 'Live result'), pct(live.netPct), cls(live.netPct), `${usd(live.netUsd, true)} · ${t(lang, 'реальные деньги', 'real money')}`, cls(live.netUsd))}
      ${statCard(t(lang, 'Live сделки', 'Live trades'), String(live.closed), '', `${live.open} ${t(lang, 'открыто', 'open')}`)}
      ${statCard(t(lang, 'Live WR', 'Live WR'), live.winRate != null ? `${(live.winRate * 100).toFixed(0)}%` : '—', '', `${live.wins}W / ${live.losses}L`)}
      ${statCard(t(lang, 'Live PF', 'Live PF'), live.profitFactor != null ? live.profitFactor.toFixed(2) : '—', live.profitFactor != null && live.profitFactor >= 1 ? 'pos' : live.profitFactor != null ? 'neg' : '', t(lang, 'прибыль / убыток', 'profit / loss'))}
      ${statCard(t(lang, 'Средняя live', 'Live average'), pct(live.avgPct), cls(live.avgPct), t(lang, 'на сделку', 'per trade'))}
      ${statCard(t(lang, 'Лучший live', 'Best live'), pct(live.best), cls(live.best), t(lang, 'закрытая сделка', 'closed trade'))}
      ${statCard(t(lang, 'Худший live', 'Worst live'), pct(live.worst), cls(live.worst), t(lang, 'закрытая сделка', 'closed trade'))}
    </div>

    ${live.cum.length >= 2 ? `<div class="section"><div class="section-title">${t(lang, 'Live-кривая результата', 'Live result curve')}</div>${equityCurve(live.cum, lang)}</div>` : ''}
    ${momentumDailyStrip(liveClosed, lang)}
    ${momentumOpsMetrics(liveOpen.length, lang)}
    ${momentumStrategyDetail(lang)}

    <div class="section">
      <div class="section-title">${t(lang, 'Live открыто сейчас', 'Live open now')} · ${liveOpen.length}</div>
      ${momentumOpenTable(liveOpen, Date.now(), lang)}
    </div>

    <div class="section" id="closed">
      <div class="section-title">${t(lang, 'Live закрытые сделки', 'Live closed trades')} · ${liveClosed.length}</div>
      ${momentumClosedTable(liveClosed, page, '/lab/momentum', lang)}
    </div>

    <p class="lt-note">${t(lang, 'На странице показана только live-статистика Momentum v2: реальные деньги и реальные исполнения. Публичная статистика считается с нового старта; старая история сохранена для внутреннего анализа. Прошлые результаты не гарантируют будущих.', 'This page shows only Momentum v2 live stats: real money and real execution. Public stats are counted from the new start; older history is kept for internal analysis. Past results do not guarantee future results.')}</p>
    `,
    { autoRefreshSec: 60, lang },
  );
}

function limitRungLabel(o: HlOpenOrder, distancePct: number | null, vol: LimitVol | null, lang: Lang): string {
  const base = COIN_X[o.coin];
  if (base == null || distancePct == null) return '—';
  const factor = WF_CONFIG.dynamicDepth ? (vol?.factor ?? 1) : 1;
  const baseDepth = base * factor * 100;
  const deepDepth = LADDER[o.coin] != null ? LADDER[o.coin]! * factor * 100 : null;
  if (deepDepth == null) return t(lang, 'базовая', 'base');
  const mid = (baseDepth + deepDepth) / 2;
  return distancePct >= mid ? t(lang, 'глубокая', 'deep') : t(lang, 'базовая', 'base');
}

async function openLimitsSection(lang: Lang): Promise<string> {
  const res = await hlOpenOrders();
  if (!res.ok) {
    return `<div class="section">
      <div class="limit-head"><div class="section-title">${t(lang, 'Выставленные лимитки', 'Resting limit orders')}</div></div>
      <div class="limit-warn">${t(lang, 'Не удалось прочитать лимитки с Hyperliquid:', 'Could not read Hyperliquid limit orders:')} ${esc(res.msg)}</div>
    </div>`;
  }
  const mids = await liveMids();
  const orders = res.data
    .filter((o) => WF_CONFIG.coins.includes(o.coin))
    .sort((a, b) => a.coin.localeCompare(b.coin) || (a.side === b.side ? a.px - b.px : a.side === 'long' ? -1 : 1));
  const now = new Date();
  if (orders.length === 0) {
    return `<div class="section">
      <div class="limit-head">
        <div class="section-title">${t(lang, 'Выставленные лимитки', 'Resting limit orders')} · 0</div>
        <div class="limit-meta">${t(lang, 'обновлено', 'updated')} ${now.toISOString().slice(11, 19)} UTC</div>
      </div>
      <div class="card"><div class="card-body"><div class="empty-state" style="padding:20px 0;text-align:center;">${t(lang, 'Сейчас входных лимиток нет: книга снята защитой, бюджетом действий или открытыми позициями.', 'No entry limits right now: the book is pulled by protection, action budget, or open positions.')}</div></div></div>
    </div>`;
  }
  const body = orders.map((o) => {
    const mid = mids.get(o.coin) ?? null;
    const distancePct = mid != null ? (o.side === 'long' ? (mid - o.px) / mid : (o.px - mid) / mid) * 100 : null;
    const vol = limitVolState(o.coin);
    const notional = o.px * o.sz;
    const corridorCls = o.side === 'long' ? 'long' : 'short';
    const distText = distancePct == null ? '—' : `${distancePct.toFixed(2)}%`;
    const volText = vol ? `${vol.volPct4h.toFixed(2)}%` : '—';
    const factorText = vol ? `×${vol.factor.toFixed(2)} ${t(lang, 'к норме', 'vs norm')}` : t(lang, 'нет свечей', 'no candles');
    return `<tr>
      <td><b>${esc(o.coin)}</b></td>
      <td><span class="sd ${o.side === 'long' ? 'long' : 'short'}">${o.side.toUpperCase()}</span></td>
      <td class="r mono">${fmtPx(o.px, o.px)}</td>
      <td class="r mono">${mid != null ? fmtPx(mid, o.px) : '—'}</td>
      <td class="r mono"><span class="limit-corridor ${corridorCls}">${distText}</span></td>
      <td>${limitRungLabel(o, distancePct, vol, lang)}</td>
      <td class="r mono">${o.sz.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}</td>
      <td class="r mono">${usd(notional)}</td>
      <td class="r"><div class="limit-vol"><b>${volText}</b><span>${factorText}</span></div></td>
      <td class="r mono" style="color:var(--text-faint)">#${o.oid}</td>
    </tr>`;
  }).join('');
  return `<div class="section" id="limits">
    <div class="limit-head">
      <div class="section-title">${t(lang, 'Выставленные лимитки', 'Resting limit orders')} · ${orders.length}</div>
      <div class="limit-meta">${t(lang, 'обновлено', 'updated')} ${now.toISOString().slice(11, 19)} UTC · ${t(lang, 'автообновление 60 сек', 'auto-refresh 60s')}</div>
    </div>
    <div class="card table-wrap"><table class="lt-tbl">
      <thead><tr>
        <th>${t(lang, 'Монета', 'Coin')}</th><th>${t(lang, 'Сторона', 'Side')}</th>
        <th class="r">${t(lang, 'Лимит', 'Limit')}</th><th class="r">${t(lang, 'Сейчас', 'Now')}</th>
        <th class="r">${t(lang, 'Коридор от цены', 'Distance')}</th><th>${t(lang, 'Уровень', 'Rung')}</th>
        <th class="r">${t(lang, 'Кол-во', 'Qty')}</th><th class="r">${t(lang, 'Номинал', 'Notional')}</th>
        <th class="r">${t(lang, 'Волатильность 4ч', '4h volatility')}</th><th class="r">OID</th>
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
        <li>${t(lang, '<b>Дневной −5% СТОПКРАН</b> — при −5% за день по эквити или по закрытому UTC-PnL снимаем лимитки, закрываем открытые позиции и не открываем новые до следующего дня.', '<b>Daily −5% CIRCUIT-BREAKER</b> — at −5% by equity or closed UTC-day PnL, resting limits are pulled, open positions are closed and no new entries are placed until the next day.')}</li>
        <li>${t(lang, '<b>Авто-предохранители:</b> снятие лимиток во время широкого рыночного каскада, запрет ловить падающий нож/шортить ракету по конкретной монете, live-quarantine слабых сторон, контроль лимитов биржи, fail-closed при потере связи.', '<b>Auto-safeguards:</b> resting limits are pulled during broad market cascades, the bot avoids catching falling knives or shorting rockets on a single coin, weak live sides are quarantined, exchange limits are controlled, and connectivity loss fails closed.')}</li>
      </ul>
    </div>
    <div class="sd-block">
      <h4>⚙️ ${t(lang, 'Как исполняется', 'How it executes')}</h4>
      <ul>
        <li>${t(lang, 'Только <b>ликвидные монеты</b>, вход — <b>мейкер-лимитками</b>, 24/7 без ручного управления.', 'Liquid coins only, entries via <b>maker limits</b>, 24/7 with no manual intervention.')}</li>
        <li>${t(lang, `<b>Одна позиция на монету</b>, диверсификация по ${universe} монетам: изолированные шипы ловятся по разным монетам, а широкие рыночные каскады отсекаются защитой.`, `<b>One position per coin</b>, diversified across ${universe} coins: isolated wicks are caught across different coins, while broad market cascades are filtered out by protection.`)}</li>
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
    ${momentumLinkSection(lang)}
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
  const st = computeStats(rows, openStmt.all().length);
  const momRows = momentumPublicRows(momClosedStmt.all());
  const momOpen = momentumPublicRows(momOpenStmt.all());
  const mom = computeMomentumStats(momRows, momOpen.length);
  return `
    <div class="lt-hero-stack">
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
    </a>
    <a class="lt-hero" href="/lab/momentum">
      <div class="lt-hero-l">
        <span class="lt-hero-badge">🧭 MOMENTUM V2 · Hyperliquid · ${t(lang, 'новый отсчёт', 'new track')}</span>
        <div class="lt-hero-title">Momentum Follow</div>
        <div class="lt-hero-sub">${t(lang, 'Адаптивный 2s-радар по импульсам: описание и отдельная статистика →', 'Adaptive 2s impulse radar: description and separate stats →')}</div>
      </div>
      <div class="lt-hero-r">
        <div class="lt-hero-stat"><div class="v ${cls(mom.netPct)}">${pct(mom.netPct)}</div><div class="k">${t(lang, 'live', 'live')}</div></div>
        <div class="lt-hero-stat"><div class="v">${mom.closed}</div><div class="k">${t(lang, 'сделок', 'trades')}</div></div>
        <div class="lt-hero-stat"><div class="v">${mom.open}</div><div class="k">${t(lang, 'открыто', 'open')}</div></div>
        <div class="lt-hero-stat"><div class="v">${mom.winRate != null ? `${(mom.winRate * 100).toFixed(0)}%` : '—'}</div><div class="k">${t(lang, 'винрейт', 'win rate')}</div></div>
      </div>
    </a>
    </div>`;
}

export const LIVE_TRACK_HERO_CSS = `
  .lt-hero-stack{display:grid;gap:12px;margin:0 0 22px}
  .lt-hero{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;
    background:linear-gradient(135deg,var(--accent-soft),var(--bg-card));border:1px solid var(--accent-soft);
    border-radius:14px;padding:16px 20px;text-decoration:none;color:var(--text);transition:border-color .15s}
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

  app.get<{ Querystring: { page?: string } }>('/lab/momentum', async (req, reply) => {
    const page = Math.max(1, parseInt(req.query.page ?? '1', 10) || 1);
    reply.type('text/html; charset=utf-8');
    reply.header('Cache-Control', 'public, max-age=30');
    return renderMomentumTrack(page, getLang(req));
  });
}
