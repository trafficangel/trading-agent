/**
 * Lab public tracks. The old wick-fade live track is retained only as historical
 * audit code; /lab/live redirects to the active Impulse Fade page.
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client.js';
import { pageShell, getLang } from './landing.js';
import { WF_CONFIG, COIN_X, LADDER } from '../jobs/wick-fade-runner.js';
import { hlOpenOrders, type HlOpenOrder } from '../exchange/hyperliquid-private.js';
import { metaAndAssetCtxs } from '../exchange/hyperliquid.js';
import { truePairsHero } from './true-pairs-page.js';

type Lang = 'ru' | 'en';
/** tiny picker: t(lang, ru, en) */
const t = (lang: Lang, ru: string, en: string): string => (lang === 'en' ? en : ru);

// ── real-money log rows ──
type WfRow = {
  id: number; coin: string; side: string; entry_px: number; qty: number; x: number | null;
  opened_at: number; exit_px: number | null; closed_at: number | null; pnl_pct: number | null; close_reason: string | null;
  entry_notional_usd: number | null; net_pnl_usd: number | null; pnl_source: string | null;
};
type MomRow = {
  id: number; coin: string; side: string; entry_px: number; qty: number; opened_at: number; signal: string;
  exit_px: number | null; closed_at: number | null; pnl_pct: number | null; close_reason: string | null;
  entry_notional_usd: number | null; net_pnl_usd: number | null; pnl_source: string | null;
};
type MomLearnRow = {
  id: number; closed_at: number; pnl_pct: number; signal: string;
  predicted_prob: number | null; predicted_ev: number | null;
};
type MomShadowProof = {
  n: number; avg_pnl: number | null; sum_pnl: number | null; wr: number | null;
  fast_n: number | null; fast_avg: number | null; confirm_n: number | null; confirm_avg: number | null;
};
type MomSignalRow = {
  id: number; ts: number; coin: string; side: string; layer: string; score: number; expected_pnl: number;
  decision: string; reason: string; ref_px: number | null; signal_px: number | null;
  r30: number | null; r90: number | null; r3: number | null; r12: number | null; from_last: number | null;
  vol_ratio: number | null; spread_pct: number | null; side_depth_usd: number | null;
  open_total: number; open_same_side: number; signal: string;
  notional_usd: number | null; kelly_fraction: number | null; equity_usd: number | null;
  model_prob: number | null; calibrated_prob: number | null; prob_confidence: number | null; kelly_confidence: number | null;
  counterfactual_exit_px: number | null; counterfactual_closed_at: number | null; counterfactual_pnl_pct: number | null;
  counterfactual_reason: string | null; counterfactual_mfe_pct: number | null; counterfactual_mae_pct: number | null; counterfactual_horizon_min: number | null;
};
type MomTrailCandle = { t: number; h: number; l: number; c: number };
type MomRisk = { stopPct: number; trailActivatePct: number; trailGivebackPct: number; trailMinLockPct: number; volPct: number };
const closedStmt = db.prepare<[], WfRow>(`SELECT * FROM wick_fade_log WHERE mode='live' AND closed_at IS NOT NULL ORDER BY closed_at ASC`);
const openStmt = db.prepare<[], WfRow>(`SELECT * FROM wick_fade_log WHERE mode='live' AND closed_at IS NULL ORDER BY opened_at DESC`);
const momClosedStmt = db.prepare<[], MomRow>(`SELECT * FROM hl_momentum_live_log WHERE closed_at IS NOT NULL ORDER BY closed_at ASC`);
const momOpenStmt = db.prepare<[], MomRow>(`SELECT * FROM hl_momentum_live_pos ORDER BY opened_at DESC`);
const limitVolClosesStmt = db.prepare<[string, number], { t: number; c: number }>(`SELECT t, c FROM hl_candles WHERE coin = ? ORDER BY t DESC LIMIT ?`);
const momTrail1mStmt = db.prepare<[string, number], MomTrailCandle>(`SELECT t, h, l, c FROM hl_candles_1m WHERE coin = ? AND t >= ? ORDER BY t ASC`);
const momTrail5mStmt = db.prepare<[string, number], MomTrailCandle>(`SELECT t, h, l, c FROM hl_candles WHERE coin = ? AND t >= ? ORDER BY t ASC`);
const runtimeConfigStmt = db.prepare<[string], { value: string }>(`SELECT value FROM runtime_config WHERE key = ?`);
const momUniverseStmt = db.prepare<[number, number], { coins: number; fresh: number | null; ready: number | null; newest: number | null }>(`
  SELECT COUNT(*) AS coins,
         SUM(CASE WHEN newest_t >= ? THEN 1 ELSE 0 END) AS fresh,
         SUM(CASE WHEN n >= 70 AND newest_t >= ? THEN 1 ELSE 0 END) AS ready,
         MAX(newest_t) AS newest
    FROM (
      SELECT coin, COUNT(*) AS n, MAX(t) AS newest_t
        FROM hl_candles_1m
       GROUP BY coin
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
         SUM(COALESCE(net_pnl_usd, (pnl_pct / 100.0) * qty * entry_px)) AS usd
    FROM hl_momentum_live_log
   WHERE closed_at IS NOT NULL AND pnl_pct IS NOT NULL AND closed_at >= ?
`);
const momEngineOpenStmt = db.prepare<[], { open: number; notional: number | null }>(`
  SELECT COUNT(*) AS open, SUM(qty * entry_px) AS notional FROM hl_momentum_live_pos
`);
const momShadowProofStmt = db.prepare<[number], MomShadowProof>(`
  WITH recent AS (
    SELECT pnl_pct, signal
      FROM hl_momentum_shadow_log
     WHERE closed_at IS NOT NULL AND pnl_pct IS NOT NULL
     ORDER BY closed_at DESC
     LIMIT ?
  )
  SELECT COUNT(*) AS n,
         AVG(pnl_pct) AS avg_pnl,
         SUM(pnl_pct) AS sum_pnl,
         AVG(CASE WHEN pnl_pct > 0 THEN 1.0 ELSE 0.0 END) AS wr,
         SUM(CASE WHEN signal LIKE '%layer=fast%' OR signal LIKE '%fast up radar%' OR signal LIKE '%fast down radar%' THEN 1 ELSE 0 END) AS fast_n,
         AVG(CASE WHEN signal LIKE '%layer=fast%' OR signal LIKE '%fast up radar%' OR signal LIKE '%fast down radar%' THEN pnl_pct END) AS fast_avg,
         SUM(CASE WHEN signal LIKE '%layer=confirm%' OR signal LIKE '%up impulse%' OR signal LIKE '%down impulse%' THEN 1 ELSE 0 END) AS confirm_n,
         AVG(CASE WHEN signal LIKE '%layer=confirm%' OR signal LIKE '%up impulse%' OR signal LIKE '%down impulse%' THEN pnl_pct END) AS confirm_avg
    FROM recent
`);
const momLearningStmt = db.prepare<[], MomLearnRow>(`
  SELECT l.id,
         l.closed_at,
         l.pnl_pct,
         l.signal,
         (SELECT j.calibrated_prob
            FROM hl_momentum_signal_journal j
           WHERE j.decision = 'live-open' AND j.signal = l.signal
           ORDER BY j.ts DESC
           LIMIT 1) AS predicted_prob,
         (SELECT j.expected_pnl
            FROM hl_momentum_signal_journal j
           WHERE j.decision = 'live-open' AND j.signal = l.signal
           ORDER BY j.ts DESC
           LIMIT 1) AS predicted_ev
    FROM hl_momentum_live_log l
   WHERE l.closed_at IS NOT NULL AND l.pnl_pct IS NOT NULL
   ORDER BY l.closed_at ASC
`);
const momSignalJournalStmt = db.prepare<[number], MomSignalRow>(`
  SELECT id, ts, coin, side, layer, score, expected_pnl, decision, reason,
         ref_px, signal_px, r30, r90, r3, r12, from_last, vol_ratio,
         spread_pct, side_depth_usd, open_total, open_same_side, signal,
         notional_usd, kelly_fraction, equity_usd,
         model_prob, calibrated_prob, prob_confidence, kelly_confidence,
         counterfactual_exit_px, counterfactual_closed_at, counterfactual_pnl_pct,
         counterfactual_reason, counterfactual_mfe_pct, counterfactual_mae_pct, counterfactual_horizon_min
    FROM hl_momentum_signal_journal
   ORDER BY ts DESC, id DESC
   LIMIT ?
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
const notionalOf = (r: WfRow): number => r.entry_notional_usd ?? r.qty * r.entry_px;
const usdOf = (r: WfRow): number => r.net_pnl_usd ?? ((r.pnl_pct ?? 0) / 100) * notionalOf(r);
const momNotionalOf = (r: MomRow): number => r.entry_notional_usd ?? r.qty * r.entry_px;
const momUsdOf = (r: MomRow): number => r.net_pnl_usd ?? ((r.pnl_pct ?? 0) / 100) * momNotionalOf(r);
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

function runtimeText(key: string, fallback: string): string {
  return runtimeConfigStmt.get(key)?.value?.trim() || fallback;
}

function parseMomSignalProb(signal: string): number | null {
  const m = signal.match(/\[score=[^\]]*\sp=([-+]?\d+(?:\.\d+)?)/);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) ? n : null;
}

function parseMomSignalEv(signal: string): number | null {
  const m = signal.match(/\[score=[^\]]*\sev=([-+]?\d+(?:\.\d+)?)/);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) ? n : null;
}

function parseNum(signal: string, re: RegExp): number | null {
  const m = signal.match(re);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) ? n : null;
}

function parseMomRisk(signal: string): MomRisk | null {
  const m = signal.match(/\[risk stop=([\d.]+) act=([\d.]+) gb=([\d.]+) lock=([\d.]+) vol=([\d.]+)/);
  if (!m) return null;
  const nums = m.slice(1, 6).map((v) => Number(v));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return {
    stopPct: nums[0]!,
    trailActivatePct: nums[1]!,
    trailGivebackPct: nums[2]!,
    trailMinLockPct: nums[3]!,
    volPct: nums[4]!,
  };
}

function momSignalDiag(signal: string): {
  h1: number | null; ir: number | null; tf: number | null;
  thrVol: number | null; thrImp: number | null; thrTrend: number | null;
  thrVolx: number | null; edge: number | null; fast30: number | null; fast90: number | null; fastRef: number | null;
  risk: MomRisk | null;
} {
  return {
    h1: parseNum(signal, /\bh1=([-+]?\d+(?:\.\d+)?)/),
    ir: parseNum(signal, /\bir=([-+]?\d+(?:\.\d+)?)/),
    tf: parseNum(signal, /\btf=([-+]?\d+(?:\.\d+)?)m/),
    thrVol: parseNum(signal, /\bvol(?:Bar|5m)=([-+]?\d+(?:\.\d+)?)/),
    thrImp: parseNum(signal, /\bimp3=([-+]?\d+(?:\.\d+)?)/),
    thrTrend: parseNum(signal, /\btr(?:12|1h)=([-+]?\d+(?:\.\d+)?)/),
    thrVolx: parseNum(signal, /\bvolx=([-+]?\d+(?:\.\d+)?)/),
    edge: parseNum(signal, /\bedge=([-+]?\d+(?:\.\d+)?)/),
    fast30: parseNum(signal, /\bfast30=([-+]?\d+(?:\.\d+)?)/),
    fast90: parseNum(signal, /\bfast90=([-+]?\d+(?:\.\d+)?)/),
    fastRef: parseNum(signal, /\bfast(?:Ref|5m)=([-+]?\d+(?:\.\d+)?)/),
    risk: parseMomRisk(signal),
  };
}

function shortReason(reason: string): string {
  return reason
    .replace('fast live paused: shadow fast is unproven', 'fast paused')
    .replace('live position already open', 'already open')
    .replace('exchange position already open', 'exch open')
    .replace('wick-fade has coin', 'coin locked')
    .replace('paper-open', 'paper')
    .replace('opened', 'live')
    .replace('liquidity: ', 'liq: ');
}

function fmtNum(n: number | null | undefined, dp = 2, dash = '—'): string {
  return n == null || !Number.isFinite(n) ? dash : n.toFixed(dp);
}

function fmtSigned(n: number | null | undefined, dp = 2): string {
  return n == null || !Number.isFinite(n) ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(dp)}`;
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
  .learn-wrap{background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:14px}
  .learn-svg{width:100%;height:280px;display:block}
  .learn-head{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:10px}
  .learn-note{font-size:12px;color:var(--text-faint);line-height:1.45}
  .learn-legend{display:flex;gap:8px;flex-wrap:wrap}
  .learn-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--border);border-radius:999px;padding:4px 9px;font-size:11px;color:var(--text-dim)}
  .learn-dot{width:8px;height:8px;border-radius:50%;display:inline-block}
  .learn-cap{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--text-faint);font-variant-numeric:tabular-nums;margin-top:8px}
  .learn-empty{background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:18px;color:var(--text-dim);font-size:13px;line-height:1.5}
  .eq-wrap{background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:14px 14px 10px}
  .eq-svg{width:100%;height:180px;display:block}
  .eq-cap{display:flex;justify-content:space-between;font-size:12px;color:var(--text-faint);margin-top:6px;font-variant-numeric:tabular-nums}
  .eq-cap .pos{color:var(--accent)}.eq-cap .neg{color:var(--danger)}
  .table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
  .lt-tbl{width:100%;border-collapse:collapse;font-size:13px}
  .lt-tbl th{text-align:left;color:var(--text-faint);font-weight:600;padding:9px 10px;border-bottom:1px solid var(--border);font-size:11px;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap}
  .lt-tbl td{padding:9px 10px;border-bottom:1px solid var(--border);font-variant-numeric:tabular-nums}
  .lt-tbl td.r,.lt-tbl th.r{text-align:right}
  .lt-tbl .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
  .lt-tbl .dt{color:var(--text-faint);font-size:12px;white-space:nowrap}
  .lt-tbl tr:hover td{background:var(--bg-card-hover)}
  .trail-cell{line-height:1.1;white-space:nowrap}
  .trail-cell b{display:block;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;color:var(--text)}
  .trail-cell span{display:block;font-size:10.5px;color:var(--text-faint);margin-top:2px}
  .trail-cell.on b,.trail-cell.on span{color:var(--accent)}
  .signal-head{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;margin-bottom:10px}
  .section-hint{font-size:12px;color:var(--text-faint);line-height:1.45;margin-top:4px}
  .sig-wrap{max-height:560px;overflow:auto}
  .sig-table{min-width:2050px;font-size:11.5px}
  .sig-table th{position:sticky;top:0;background:var(--bg-card);z-index:1;padding:7px 8px;font-size:10px}
  .sig-table td{padding:7px 8px;white-space:nowrap}
  .sig-table .mono{font-size:11px}
  .sig-reason{max-width:170px;overflow:hidden;text-overflow:ellipsis;color:var(--text-dim)}
  .sig-liq{min-width:92px}.sig-kelly{min-width:86px}
  .layer-badge{font-size:10px;color:var(--text-dim);border:1px solid var(--border);border-radius:999px;padding:2px 7px}
  .decision{font-size:10px;font-weight:700;border-radius:999px;padding:2px 7px;border:1px solid var(--border)}
  .decision.live{color:var(--accent);background:var(--accent-soft);border-color:var(--accent-soft)}
  .decision.skip{color:var(--danger);background:var(--danger-soft);border-color:var(--danger-soft)}
  .decision.paper{color:var(--text-dim);background:rgba(255,255,255,.03)}
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

function momentumLinkSection(lang: Lang): string {
  const liveClosed = momentumPublicRows(momClosedStmt.all());
  const liveOpen = momentumPublicRows(momOpenStmt.all());
  const net = liveClosed.reduce((s, r) => s + (r.pnl_pct ?? 0), 0);
  return `<div class="section">
    <a class="mom-link" href="/lab/momentum">
      <div>
        <span class="mom-link-badge">${t(lang, 'IMPULSE FADE · НОВЫЙ ОТСЧЁТ', 'IMPULSE FADE · NEW TRACK')}</span>
        <div class="mom-link-title">Impulse Fade</div>
        <div class="mom-link-sub">${t(lang, 'Адаптивный 2s-радар: fade поздних импульсов, live-статистика и сделки →', 'Adaptive 2s radar: fading late impulses, live stats and trades →')}</div>
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

function momTrailCandles(coin: string, openedAt: number): MomTrailCandle[] {
  const one = momTrail1mStmt.all(coin, openedAt);
  if (one.length >= 2) return one;
  return momTrail5mStmt.all(coin, openedAt);
}

function momentumTrailState(r: MomRow): { active: boolean; bestPx: number | null; movePct: number; trailPx: number | null; activatePx: number | null } {
  const risk = parseMomRisk(r.signal);
  if (!risk) return { active: false, bestPx: null, movePct: 0, trailPx: null, activatePx: null };
  const act = risk.trailActivatePct / 100;
  const gb = risk.trailGivebackPct / 100;
  const lock = risk.trailMinLockPct / 100;
  const activatePx = r.side === 'long' ? r.entry_px * (1 + act) : r.entry_px * (1 - act);
  const bars = momTrailCandles(r.coin, r.opened_at);
  if (bars.length === 0) return { active: false, bestPx: null, movePct: 0, trailPx: null, activatePx };
  const bestPx = r.side === 'long' ? Math.max(...bars.map((c) => c.h)) : Math.min(...bars.map((c) => c.l));
  const move = r.side === 'long' ? (bestPx - r.entry_px) / r.entry_px : (r.entry_px - bestPx) / r.entry_px;
  if (move < act) return { active: false, bestPx, movePct: move * 100, trailPx: null, activatePx };
  const trailPx = r.side === 'long'
    ? Math.max(r.entry_px * (1 + lock), bestPx * (1 - gb))
    : Math.min(r.entry_px * (1 - lock), bestPx * (1 + gb));
  return { active: true, bestPx, movePct: move * 100, trailPx, activatePx };
}

function momentumOpenTable(rows: MomRow[], nowMs: number, lang: Lang): string {
  if (rows.length === 0) return `<div class="card"><div class="card-body"><div class="empty-state" style="padding:18px 0;text-align:center;">${t(lang, 'Сейчас открытых Momentum-позиций нет.', 'No Momentum positions are open right now.')}</div></div></div>`;
  const body = rows.map((r) => {
    const trail = momentumTrailState(r);
    const risk = parseMomRisk(r.signal);
    const trailText = trail.active && trail.trailPx != null
      ? `<b>${fmtPx(trail.trailPx, r.entry_px)}</b><span>${t(lang, 'активен', 'active')} · ${pct(trail.movePct)}</span>`
      : `<b>${trail.activatePx != null ? fmtPx(trail.activatePx, r.entry_px) : '—'}</b><span>${t(lang, 'активация', 'activation')}${risk ? ` · gb ${risk.trailGivebackPct.toFixed(2)}%` : ''}</span>`;
    return `<tr>
      <td><b>${esc(r.coin)}</b></td>
      <td><span class="sd ${r.side === 'long' ? 'long' : 'short'}">${r.side.toUpperCase()}</span></td>
      <td class="r mono">${r.entry_px}</td>
      <td class="r">${usd(momNotionalOf(r))}</td>
      <td class="r trail-cell ${trail.active ? 'on' : ''}">${trailText}</td>
      <td class="dt">${heldStr(r.opened_at, nowMs, lang)}</td>
    </tr>`;
  }).join('');
  return `<div class="card table-wrap"><table class="lt-tbl"><thead><tr>
    <th>${t(lang, 'Монета', 'Coin')}</th><th>${t(lang, 'Сторона', 'Side')}</th><th class="r">${t(lang, 'Вход', 'Entry')}</th>
    <th class="r">${t(lang, 'Размер', 'Size')}</th><th class="r">${t(lang, 'Трейл', 'Trail')}</th><th>${t(lang, 'В работе', 'Held')}</th>
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

function decisionCls(decision: string): string {
  return decision === 'live-open' ? 'live' : decision === 'skip' ? 'skip' : 'paper';
}

function decisionLabel(decision: string, lang: Lang): string {
  if (decision === 'live-open') return t(lang, 'LIVE', 'LIVE');
  if (decision === 'paper') return t(lang, 'PAPER', 'PAPER');
  if (decision === 'skip') return t(lang, 'SKIP', 'SKIP');
  return decision.toUpperCase();
}

function momentumSignalJournal(lang: Lang): string {
  const limit = Math.round(Math.max(40, Math.min(180, runtimeNum('hl_momentum_page_signal_rows', 100))));
  const rows = momSignalJournalStmt.all(limit);
  if (rows.length === 0) {
    return `<div class="card"><div class="card-body"><div class="empty-state" style="padding:18px 0;text-align:center;">${t(lang, 'Сигналов пока нет.', 'No signals yet.')}</div></div></div>`;
  }
  const body = rows.map((r) => {
    const d = momSignalDiag(r.signal);
    const risk = d.risk;
    const p = r.calibrated_prob ?? parseMomSignalProb(r.signal);
    const px = r.signal_px ?? r.ref_px;
    const liq = r.spread_pct != null || r.side_depth_usd != null
      ? `${r.spread_pct != null ? `${r.spread_pct.toFixed(2)}%` : '—'} / ${r.side_depth_usd != null ? usd(r.side_depth_usd) : '—'}`
      : '—';
    const kelly = r.notional_usd != null || r.kelly_fraction != null
      ? `${r.notional_usd != null ? usd(r.notional_usd) : '—'} / ${r.kelly_fraction != null ? r.kelly_fraction.toFixed(3) : '—'}`
      : '—';
    const cf = r.counterfactual_pnl_pct;
    const cfText = cf == null
      ? '—'
      : `${pct(cf)}${r.counterfactual_reason ? ` · ${r.counterfactual_reason}` : ''}`;
    return `<tr>
      <td class="dt">${fmtDt(r.ts).slice(5)}</td>
      <td><b>${esc(r.coin)}</b></td>
      <td><span class="sd ${r.side === 'long' ? 'long' : 'short'}">${r.side.toUpperCase()}</span></td>
      <td><span class="layer-badge">${esc(r.layer)}</span></td>
      <td><span class="decision ${decisionCls(r.decision)}">${decisionLabel(r.decision, lang)}</span></td>
      <td class="sig-reason" title="${esc(r.reason)}">${esc(shortReason(r.reason))}</td>
      <td class="r mono ${cf == null ? '' : cls(cf)}" title="${esc(r.counterfactual_reason ?? '')}${r.counterfactual_horizon_min != null ? ` · ${r.counterfactual_horizon_min}m` : ''}">${esc(cfText)}</td>
      <td class="r mono">${r.counterfactual_mfe_pct != null ? pct(r.counterfactual_mfe_pct) : '—'}</td>
      <td class="r mono">${r.counterfactual_mae_pct != null ? pct(r.counterfactual_mae_pct) : '—'}</td>
      <td class="r mono">${px != null ? fmtPx(px, px) : '—'}</td>
      <td class="r mono">${r.score.toFixed(0)}</td>
      <td class="r mono ${p != null && p >= 0.49 ? 'pos' : p != null ? 'neg' : ''}">${p != null ? p.toFixed(3) : '—'}</td>
      <td class="r mono ${cls(r.expected_pnl)}">${pct(r.expected_pnl)}</td>
      <td class="r mono">${fmtSigned(r.r30)}</td>
      <td class="r mono">${fmtSigned(r.r90)}</td>
      <td class="r mono">${fmtSigned(r.r3)}</td>
      <td class="r mono">${fmtSigned(r.r12)}</td>
      <td class="r mono">${fmtSigned(d.h1)}</td>
      <td class="r mono">${fmtSigned(r.from_last)}</td>
      <td class="r mono">${fmtNum(d.ir, 2)}</td>
      <td class="r mono">${fmtNum(r.vol_ratio, 2)}</td>
      <td class="r mono">${fmtNum(d.edge, 2)}</td>
      <td class="r mono">${fmtNum(d.thrImp, 2)}</td>
      <td class="r mono">${fmtNum(d.thrTrend, 2)}</td>
      <td class="r mono">${fmtNum(d.fast30, 2)}</td>
      <td class="r mono">${fmtNum(d.fast90, 2)}</td>
      <td class="r mono">${fmtNum(d.fastRef, 2)}</td>
      <td class="r mono">${risk ? pct(risk.stopPct) : '—'}</td>
      <td class="r mono">${risk ? pct(risk.trailActivatePct) : '—'}</td>
      <td class="r mono">${risk ? pct(risk.trailGivebackPct) : '—'}</td>
      <td class="r mono">${risk ? pct(risk.trailMinLockPct) : '—'}</td>
      <td class="r mono">${r.open_total}/${r.open_same_side}</td>
      <td class="r mono sig-liq">${esc(liq)}</td>
      <td class="r mono sig-kelly">${esc(kelly)}</td>
    </tr>`;
  }).join('');

  return `<div class="signal-head">
    <div>
      <div class="section-title">${t(lang, 'Журнал сигналов', 'Signal journal')} · ${rows.length}</div>
      <div class="section-hint">${t(lang, 'Последние сигналы: LIVE — ушёл в реал, SKIP — отфильтрован защитой, PAPER — оставлен в бумажной проверке. Полная причина видна при наведении.', 'Recent signals: LIVE entered real trading, SKIP was blocked by protection, PAPER stayed in paper validation. Hover a reason for the full text.')}</div>
    </div>
  </div>
  <div class="card table-wrap sig-wrap"><table class="lt-tbl sig-table"><thead><tr>
    <th>UTC</th><th>${t(lang, 'Монета', 'Coin')}</th><th>${t(lang, 'Стор.', 'Side')}</th><th>${t(lang, 'Слой', 'Layer')}</th><th>${t(lang, 'Реш.', 'Decision')}</th><th>${t(lang, 'Причина', 'Reason')}</th>
    <th class="r">CF</th><th class="r">MFE</th><th class="r">MAE</th>
    <th class="r">Px</th><th class="r">Score</th><th class="r">p</th><th class="r">EV</th>
    <th class="r">r30</th><th class="r">r90</th><th class="r">r3</th><th class="r">r12</th><th class="r">h1</th><th class="r">from</th>
    <th class="r">IR</th><th class="r">Volx</th><th class="r">Edge</th><th class="r">ImpThr</th><th class="r">TrThr</th>
    <th class="r">F30</th><th class="r">F90</th><th class="r">FRef</th>
    <th class="r">Stop</th><th class="r">Act</th><th class="r">GB</th><th class="r">Lock</th>
    <th class="r">Open</th><th class="r">Liq</th><th class="r">Kelly</th>
  </tr></thead><tbody>${body}</tbody></table></div>`;
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
  const oneMinuteFreshAfter = Date.now() - 4 * 60_000;
  const universe = momUniverseStmt.get(oneMinuteFreshAfter, oneMinuteFreshAfter) ?? { coins: 0, fresh: 0, ready: 0, newest: null };
  const sig = momSignalStatsStmt.get(publicStart) ?? {
    total: 0, live_open: 0, skipped: 0, paper: 0,
    avg_score: null, avg_ev: null, avg_prob: null, avg_prob_conf: null,
    avg_kelly_conf: null, avg_spread: null, avg_depth: null, avg_notional: null,
  };
  const sessionStart = runtimeNum('hl_momentum_live_day_reset_ms', todayStartUtcMs());
  const session = momSessionPnlStmt.get(sessionStart) ?? { closed: 0, pct: 0, usd: 0 };
  const engineOpen = momEngineOpenStmt.get() ?? { open: 0, notional: 0 };
  const maxOpen = runtimeNum('hl_momentum_live_max_open', 4);
  const promotionStage = runtimeText('hl_momentum_promotion_stage', 'canary-1');
  const promotionN = Math.round(runtimeNum('hl_momentum_confirm_long_canary_live_n', 0));
  const promotionExactN = Math.round(runtimeNum('hl_momentum_promotion_exact_n', promotionN));
  const promotionAvg = runtimeNum('hl_momentum_confirm_long_canary_live_avg_pct', 0);
  const promotionPfRaw = runtimeText('hl_momentum_promotion_profit_factor', '0');
  const promotionPfNum = Number(promotionPfRaw);
  const promotionPf = promotionPfRaw === 'inf' ? '∞' : Number.isFinite(promotionPfNum) && promotionN ? promotionPfNum.toFixed(2) : '—';
  const promotionMaxDd = runtimeNum('hl_momentum_promotion_max_drawdown_pct', 0);
  const promotionNextStage = runtimeText('hl_momentum_promotion_next_stage', 'canary-2');
  const promotionNextN = Math.round(runtimeNum('hl_momentum_promotion_next_min_trades', 10));
  const promotionRetryAfter = runtimeNum('hl_momentum_promotion_retry_after_ms', 0);
  const confirmLongShadowN = Math.round(runtimeNum('hl_momentum_confirm_long_shadow_n', 0));
  const confirmLongShadowTargetN = Math.round(runtimeNum('hl_momentum_confirm_long_sample_n', 40));
  const canaryMaxOpen = Math.round(runtimeNum('hl_momentum_confirm_long_canary_max_open', 1));
  const sideAwareEnabled = runtimeNum('hl_momentum_side_aware_enabled', 1) >= 0.5;
  const positionCap = sideAwareEnabled ? canaryMaxOpen : maxOpen;
  const minNotional = runtimeNum('hl_momentum_min_notional_usd', 11);
  const maxNotional = runtimeNum('hl_momentum_max_notional_usd', 24);
  const minProb = runtimeNum('hl_momentum_min_calibrated_prob', 0.49);
  const canaryMinProb = runtimeNum('hl_momentum_confirm_long_canary_min_prob', 0.47);
  const confirmLongMinAbsR3 = runtimeNum('hl_momentum_confirm_long_min_abs_r3_pct', 0.50);
  const activeMinProb = sideAwareEnabled ? canaryMinProb : minProb;
  const minScore = runtimeNum('hl_momentum_min_live_score', 68);
  const minEv = runtimeNum('hl_momentum_min_expected_pnl_pct', 0.10);
  const probBias = runtimeNum('hl_momentum_prob_bias', 0);
  const evBias = runtimeNum('hl_momentum_ev_bias_pct', 0);
  const calN = runtimeNum('hl_momentum_calibration_sample_n', 0);
  const calActualWr = runtimeNum('hl_momentum_calibration_actual_wr', 0);
  const calPredWr = runtimeNum('hl_momentum_calibration_pred_wr', 0);
  const calActualPnl = runtimeNum('hl_momentum_calibration_actual_pnl_pct', 0);
  const calPredEv = runtimeNum('hl_momentum_calibration_pred_ev_pct', 0);
  const stopUsd = runtimeNum('hl_momentum_live_daily_stop_usd', -20);
  const shadowProofEnabled = runtimeNum('hl_momentum_shadow_proof_enabled', 1) >= 0.5;
  const shadowProofN = Math.round(runtimeNum('hl_momentum_shadow_proof_recent_n', 120));
  const fastLiveEnabled = runtimeNum('hl_momentum_fast_live_enabled', 0) >= 0.5;
  const confirmMaxIr = runtimeNum('hl_momentum_confirm_max_impulse_ratio', 1.42);
  const governorState = runtimeConfigStmt.get('hl_momentum_governor_state')?.value ?? 'probe';
  const governorShadowAvg = runtimeNum('hl_momentum_governor_shadow_avg_pct', 0);
  const governorConfirmAvg = runtimeNum('hl_momentum_governor_confirm_avg_pct', 0);
  const governorLiveAvg = runtimeNum('hl_momentum_governor_live_avg_pct', 0);
  const rejectedN = runtimeNum('hl_momentum_rejected_sample_n', 0);
  const rejectedAvg = runtimeNum('hl_momentum_rejected_avg_pct', 0);
  const rejectedWr = runtimeNum('hl_momentum_rejected_wr', 0);
  const maxSameSide = runtimeNum('hl_momentum_max_same_side', 2);
  const proof = momShadowProofStmt.get(shadowProofN) ?? { n: 0, avg_pnl: null, sum_pnl: null, wr: null, fast_n: null, fast_avg: null, confirm_n: null, confirm_avg: null };
  const usedUsd = session.usd ?? 0;
  const stopLeft = Math.max(0, Math.abs(stopUsd) - Math.max(0, -usedUsd));
  const kellyOn = runtimeNum('hl_momentum_kelly_enabled', 1) >= 0.5;
  const promotionTarget = promotionStage === 'canary-1'
    ? t(lang, `|r3| ≥ ${confirmLongMinAbsR3.toFixed(2)}% · gate: 10 exact · avg ≥ 0.03% · PF ≥ 1.10 · DD ≤ 1.50%`, `|r3| ≥ ${confirmLongMinAbsR3.toFixed(2)}% · gate: 10 exact · avg ≥ 0.03% · PF ≥ 1.10 · DD ≤ 1.50%`)
    : promotionStage === 'canary-2'
      ? t(lang, 'gate: 25 exact · avg ≥ 0.05% · PF ≥ 1.20 · DD ≤ 2.00%', 'gate: 25 exact · avg ≥ 0.05% · PF ≥ 1.20 · DD ≤ 2.00%')
      : promotionStage === 'shadow' && promotionRetryAfter > Date.now()
        ? t(lang, `повторный micro-probe после ${fmtDt(promotionRetryAfter)} UTC`, `micro probe retries after ${fmtDt(promotionRetryAfter)} UTC`)
        : promotionStage === 'scaled'
          ? t(lang, 'статистический gate пройден; сумма остаётся под ручным контролем', 'statistical gate passed; notional remains operator-controlled')
          : t(lang, 'ждём подтверждения shadow-edge', 'waiting for shadow-edge proof');
  const promotionProgress = promotionStage === 'shadow'
    ? `shadow proof ${confirmLongShadowN}/${confirmLongShadowTargetN}`
    : promotionNextN > 0
      ? `${promotionN}/${promotionNextN} → ${promotionNextStage}`
      : t(lang, 'gate пройден', 'gate passed');
  const metric = (k: string, v: string, s: string, clsName = ''): string =>
    `<div class="ops-card"><div class="k">${k}</div><div class="v ${clsName}">${v}</div><div class="s">${s}</div></div>`;

  return `<div class="section">
    <div class="section-title">${t(lang, 'Боевые метрики системы', 'Live system metrics')}</div>
    <div class="ops-grid">
      ${metric(t(lang, 'Рынок', 'Market'), `${universe.ready ?? 0} / ${universe.coins}`, t(lang, `1m готово после прогрева · свежих ${universe.fresh ?? 0} · обновлено ${ageText(universe.newest, lang)}`, `1m ready after warmup · fresh ${universe.fresh ?? 0} · updated ${ageText(universe.newest, lang)}`))}
      ${metric(t(lang, 'Радар', 'Radar'), '2s / 1m', t(lang, 'allMids по всему рынку + 1m слой поиска поздних всплесков; 5m объём остаётся как fallback', 'allMids across the market + 1m late-burst layer; 5m volume remains as fallback'))}
      ${metric(t(lang, 'Сигналы', 'Signals'), String(sig.total), t(lang, `${sig.skipped ?? 0} отфильтрованы защитой · ${sig.live_open ?? 0} новых live-входов`, `${sig.skipped ?? 0} filtered by protection · ${sig.live_open ?? 0} new live entries`))}
      ${metric(t(lang, 'Позиции', 'Positions'), `${liveOpenPublic} / ${positionCap}`, t(lang, `${engineOpen.open} сейчас под управлением движка · лимит задаёт этап ${promotionStage}`, `${engineOpen.open} currently managed by engine · cap is set by ${promotionStage}`))}
      ${metric(t(lang, 'Этап допуска', 'Promotion stage'), promotionStage, `${promotionProgress} · exact ${promotionExactN}/${promotionN} · avg ${pct(promotionAvg)} · PF ${promotionPf} · DD ${promotionMaxDd.toFixed(2)}% · ${promotionTarget}`, promotionStage === 'shadow' ? 'neg' : promotionStage === 'scaled' ? 'pos' : '')}
      ${metric(t(lang, 'Качество входа', 'Entry quality'), `|r3| ≥ ${confirmLongMinAbsR3.toFixed(2)}%`, t(lang, `score ≥ ${minScore} · p ≥ ${activeMinProb.toFixed(2)} · EV ≥ ${minEv.toFixed(2)}% · средний score ${sig.avg_score != null ? sig.avg_score.toFixed(0) : '—'}`, `score ≥ ${minScore} · p ≥ ${activeMinProb.toFixed(2)} · EV ≥ ${minEv.toFixed(2)}% · avg score ${sig.avg_score != null ? sig.avg_score.toFixed(0) : '—'}`))}
      ${metric(t(lang, 'Онлайн-калибровка', 'Online calibration'), `p ${probBias >= 0 ? '+' : ''}${(probBias * 100).toFixed(1)}pp · EV ${pct(evBias)}`, t(lang, `${calN.toFixed(0)} сделок · факт WR ${(calActualWr * 100).toFixed(0)}% vs прогноз ${(calPredWr * 100).toFixed(0)}% · PnL ${pct(calActualPnl)} vs EV ${pct(calPredEv)}`, `${calN.toFixed(0)} trades · actual WR ${(calActualWr * 100).toFixed(0)}% vs predicted ${(calPredWr * 100).toFixed(0)}% · PnL ${pct(calActualPnl)} vs EV ${pct(calPredEv)}`), evBias < 0 || probBias < 0 ? 'neg' : '')}
      ${metric(t(lang, 'SKIP learning', 'SKIP learning'), rejectedN ? pct(rejectedAvg) : '—', t(lang, `${rejectedN.toFixed(0)} отклонённых оценены · WR ${(rejectedWr * 100).toFixed(0)}% · ${rejectedAvg > 0 ? 'могли упустить плюс' : rejectedAvg < 0 ? 'фильтр спасал от минуса' : 'нейтрально'}`, `${rejectedN.toFixed(0)} rejected evaluated · WR ${(rejectedWr * 100).toFixed(0)}% · ${rejectedAvg > 0 ? 'may have missed upside' : rejectedAvg < 0 ? 'filter saved losses' : 'neutral'}`), rejectedAvg > 0 ? 'neg' : rejectedAvg < 0 ? 'pos' : '')}
      ${metric(t(lang, 'Governor режим', 'Governor mode'), governorState, t(lang, `shadow ${pct(governorShadowAvg)} · confirm ${pct(governorConfirmAvg)} · live ${pct(governorLiveAvg)} · same side ≤ ${maxSameSide.toFixed(0)}`, `shadow ${pct(governorShadowAvg)} · confirm ${pct(governorConfirmAvg)} · live ${pct(governorLiveAvg)} · same side ≤ ${maxSameSide.toFixed(0)}`), governorState === 'defensive' ? 'neg' : governorState === 'hot' ? 'pos' : '')}
      ${metric(t(lang, 'Shadow-proof gate', 'Shadow-proof gate'), shadowProofEnabled ? (fastLiveEnabled ? t(lang, 'fast активен', 'fast active') : t(lang, 'fast на паузе', 'fast paused')) : t(lang, 'выключен', 'off'), t(lang, `recent ${proof.n} shadow: ${proof.avg_pnl != null ? pct(proof.avg_pnl) : '—'} · WR ${proof.wr != null ? (proof.wr * 100).toFixed(0) : '—'}% · confirm ir ≤ ${confirmMaxIr.toFixed(2)}`, `recent ${proof.n} shadow: ${proof.avg_pnl != null ? pct(proof.avg_pnl) : '—'} · WR ${proof.wr != null ? (proof.wr * 100).toFixed(0) : '—'}% · confirm ir ≤ ${confirmMaxIr.toFixed(2)}`), proof.avg_pnl != null && proof.avg_pnl < 0 ? 'neg' : '')}
      ${metric(t(lang, 'Kelly размер', 'Kelly sizing'), `$${minNotional.toFixed(0)}–${maxNotional.toFixed(0)}`, t(lang, `${kellyOn ? 'включён' : 'выключен'} · средний размер сигнала ${sig.avg_notional != null ? usd(sig.avg_notional) : '—'}`, `${kellyOn ? 'enabled' : 'disabled'} · avg signal size ${sig.avg_notional != null ? usd(sig.avg_notional) : '—'}`))}
      ${metric(t(lang, 'Dollar-stop', 'Dollar stop'), usd(stopUsd, true), t(lang, `сессия ${usd(usedUsd, true)} · до стопа ${usd(stopLeft)}`, `session ${usd(usedUsd, true)} · to stop ${usd(stopLeft)}`), usedUsd < 0 ? 'neg' : '')}
      ${metric(t(lang, 'Ликвидность', 'Liquidity'), '≤0.35%', t(lang, `макс. спред · top3 стакан ≥ $150 · ордер ≤10% глубины`, `max spread · top3 book ≥ $150 · order ≤10% of depth`))}
    </div>
    <div class="ops-table">
      <div class="ops-row">
        <div class="k">${t(lang, 'Что считаем fade-сетапом', 'Fade setup')}</div>
        <div class="v">${t(lang,
          'Быстрый слой смотрит сдвиги <b>r30/r90</b> за 30/90 секунд и движение от последней 1m-свечи. Подтверждающий слой ищет поздний всплеск: <b>r3</b> за 3 минуты, <b>r12m</b> за 12 минут, <b>h1</b> как контекст, объём и закрытие у края диапазона. Торговая сторона затем переворачивается: up-impulse → short fade, down-impulse → long fade.',
          'The fast layer watches <b>r30/r90</b> moves over 30/90 seconds and movement from the last 1m close. The confirmation layer looks for a late burst: <b>r3</b> over 3 minutes, <b>r12m</b> over 12 minutes, <b>h1</b> as context, volume, and close near the range edge. The trade side is then inverted: up-impulse → short fade, down-impulse → long fade.'
        )}<div class="ops-tags"><span class="ops-tag">r30 / r90</span><span class="ops-tag">from 1m close</span><span class="ops-tag">r3m / r12m / h1</span><span class="ops-tag">volume ratio</span><span class="ops-tag">close edge</span></div></div>
      </div>
      <div class="ops-row">
        <div class="k">${t(lang, 'Фильтры входа', 'Entry filters')}</div>
        <div class="v">${t(lang,
          'Перед live-входом проверяем, что трёхминутный импульс не слабее 0.50%, монета свободна, wick-fade её не держит, нет перегруза по одной стороне, стакан достаточно глубокий, а calibrated probability и EV проходят порог fade-модели.',
          'Before a live entry we require at least a 0.50% three-minute impulse, check that the coin is free, wick-fade does not hold it, same-side exposure is not crowded, the book is deep enough, and calibrated probability plus EV pass the fade model gate.'
        )} ${t(lang, 'Activity governor каждую минуту переводит систему между defensive/probe/normal/hot: если сделок нет, но shadow зелёный — ослабляет вход; если live или shadow красные — зажимает maxOpen, сторону, p/EV и ir; если прогнозы и факт сходятся выше 50/50 — расширяет.', 'The activity governor moves the system between defensive/probe/normal/hot every minute: if there are no trades but shadow is green, it loosens; if live or shadow are red, it tightens maxOpen, side exposure, p/EV and ir; if forecasts and reality converge above 50/50, it expands.')}<div class="ops-tags"><span class="ops-tag">free coin</span><span class="ops-tag">shadow-proof</span><span class="ops-tag">governor</span><span class="ops-tag">fade model</span><span class="ops-tag">spread/depth</span></div></div>
      </div>
      <div class="ops-row">
        <div class="k">${t(lang, 'Риск и выход', 'Risk and exit')}</div>
        <div class="v">${t(lang,
          'Стоп и откат трейлинга считаются из распределения текущего true range монеты, свежей волатильности и комиссии. Lock считается по net-математике так, чтобы расчётный R:R после комиссии был не хуже 1:2; если fade быстро не начинает работать, включается momentum-decay.',
          'Stop and trailing giveback are derived from the coin’s current true-range distribution, fresh volatility and fees. Lock is computed on net math so designed R:R after fees stays at least 1:2; if the fade does not start working quickly, momentum-decay can exit.'
        )}<div class="ops-tags"><span class="ops-tag">exchange stop</span><span class="ops-tag">dynamic trail</span><span class="ops-tag">R:R ≥ 1:2</span><span class="ops-tag">momentum-decay</span><span class="ops-tag">session dollar-stop</span></div></div>
      </div>
    </div>
  </div>`;
}

type LearningPoint = {
  id: number;
  closedAt: number;
  predProb: number;
  predEv: number;
  actualWin: number;
  actualPnl: number;
};

function avgNum(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

function momentumLearningPoints(): LearningPoint[] {
  return momLearningStmt.all()
    .map((r) => {
      const predProb = r.predicted_prob ?? parseMomSignalProb(r.signal);
      const predEv = r.predicted_ev ?? parseMomSignalEv(r.signal);
      if (!(predProb != null && predEv != null && Number.isFinite(predProb) && Number.isFinite(predEv))) return null;
      return {
        id: r.id,
        closedAt: r.closed_at,
        predProb,
        predEv,
        actualWin: r.pnl_pct > 0 ? 1 : 0,
        actualPnl: r.pnl_pct,
      };
    })
    .filter((p): p is LearningPoint => p != null);
}

function pathFor(points: number[], x: (i: number) => number, y: (v: number) => number): string {
  if (points.length === 0) return '';
  if (points.length === 1) {
    const xx = x(0).toFixed(1);
    const yy = y(points[0]!).toFixed(1);
    return `M${xx},${yy} L${xx},${yy}`;
  }
  return points.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
}

function momentumLearningChart(lang: Lang): string {
  const points = momentumLearningPoints();
  if (points.length < 2) {
    return `<div class="section">
      <div class="section-title">${t(lang, 'Кривые обучения', 'Learning curves')}</div>
      <div class="learn-empty">${t(lang, 'Для графика нужно хотя бы две закрытые live-сделки с сохранённым прогнозом. Doctor уже пишет прогнозы и будет обновлять калибровку после новых закрытий.', 'The chart needs at least two closed live trades with saved forecasts. Doctor is already storing forecasts and will update calibration after new closes.')}</div>
    </div>`;
  }

  const window = Math.min(20, Math.max(4, Math.round(Math.sqrt(points.length) * 2)));
  const predWr: number[] = [];
  const actualWr: number[] = [];
  const predEv: number[] = [];
  const actualPnl: number[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const slice = points.slice(Math.max(0, i - window + 1), i + 1);
    predWr.push(avgNum(slice.map((p) => p.predProb * 100)));
    actualWr.push(avgNum(slice.map((p) => p.actualWin * 100)));
    predEv.push(avgNum(slice.map((p) => p.predEv)));
    actualPnl.push(avgNum(slice.map((p) => p.actualPnl)));
  }

  const W = 680;
  const H = 280;
  const padX = 28;
  const topT = 26;
  const topH = 92;
  const botT = 158;
  const botH = 92;
  const n = points.length;
  const innerW = W - padX * 2;
  const x = (i: number): number => padX + (i / Math.max(1, n - 1)) * innerW;
  const yWr = (v: number): number => topT + (1 - (v / 100)) * topH;
  const evLo = Math.min(-0.75, 0, ...predEv, ...actualPnl);
  const evHi = Math.max(0.75, 0, ...predEv, ...actualPnl);
  const evSpan = evHi - evLo || 1;
  const yEv = (v: number): number => botT + (1 - (v - evLo) / evSpan) * botH;
  const last = points.at(-1)!;
  const lastPredWr = predWr.at(-1)!;
  const lastActualWr = actualWr.at(-1)!;
  const lastPredEv = predEv.at(-1)!;
  const lastActualPnl = actualPnl.at(-1)!;
  const probBias = runtimeNum('hl_momentum_prob_bias', 0);
  const evBias = runtimeNum('hl_momentum_ev_bias_pct', 0);
  const lastLabel = `#${last.id} · ${fmtDt(last.closedAt)}`;

  return `<div class="section">
    <div class="learn-head">
      <div>
        <div class="section-title" style="margin:0">${t(lang, 'Кривые обучения: прогноз → факт', 'Learning curves: forecast → reality')}</div>
        <div class="learn-note">${t(lang, `скользящее окно ${window} сделок · Doctor проверяет новые закрытия каждую минуту`, `rolling ${window}-trade window · Doctor checks new closes every minute`)}</div>
      </div>
      <div class="learn-legend">
        <span class="learn-chip"><span class="learn-dot" style="background:var(--accent)"></span>${t(lang, 'факт', 'actual')}</span>
        <span class="learn-chip"><span class="learn-dot" style="background:#8aa0ff"></span>${t(lang, 'прогноз', 'forecast')}</span>
        <span class="learn-chip"><span class="learn-dot" style="background:var(--danger)"></span>${t(lang, 'bias', 'bias')}</span>
      </div>
    </div>
    <div class="learn-wrap">
      <svg class="learn-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${t(lang, 'Кривые обучения Momentum', 'Momentum learning curves')}">
        <line x1="${padX}" y1="${yWr(50).toFixed(1)}" x2="${W - padX}" y2="${yWr(50).toFixed(1)}" stroke="var(--border)" stroke-dasharray="4,5"/>
        <line x1="${padX}" y1="${yWr(0).toFixed(1)}" x2="${W - padX}" y2="${yWr(0).toFixed(1)}" stroke="var(--border)" opacity=".65"/>
        <line x1="${padX}" y1="${yWr(100).toFixed(1)}" x2="${W - padX}" y2="${yWr(100).toFixed(1)}" stroke="var(--border)" opacity=".65"/>
        <text x="${padX}" y="15" fill="var(--text-faint)" font-size="11">${t(lang, 'Win-rate: прогноз vs факт', 'Win-rate: forecast vs actual')}</text>
        <text x="${W - padX}" y="15" text-anchor="end" fill="var(--text-dim)" font-size="11">${lastActualWr.toFixed(0)}% / ${lastPredWr.toFixed(0)}%</text>
        <path d="${pathFor(predWr, x, yWr)}" fill="none" stroke="#8aa0ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="5,5"/>
        <path d="${pathFor(actualWr, x, yWr)}" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>

        <line x1="${padX}" y1="${yEv(0).toFixed(1)}" x2="${W - padX}" y2="${yEv(0).toFixed(1)}" stroke="var(--border)" stroke-dasharray="4,5"/>
        <line x1="${padX}" y1="${botT}" x2="${W - padX}" y2="${botT}" stroke="var(--border)" opacity=".65"/>
        <line x1="${padX}" y1="${botT + botH}" x2="${W - padX}" y2="${botT + botH}" stroke="var(--border)" opacity=".65"/>
        <text x="${padX}" y="${botT - 10}" fill="var(--text-faint)" font-size="11">${t(lang, 'EV/PnL на сделку: прогноз vs факт', 'EV/PnL per trade: forecast vs actual')}</text>
        <text x="${W - padX}" y="${botT - 10}" text-anchor="end" fill="var(--text-dim)" font-size="11">${pct(lastActualPnl)} / ${pct(lastPredEv)}</text>
        <path d="${pathFor(predEv, x, yEv)}" fill="none" stroke="#8aa0ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="5,5"/>
        <path d="${pathFor(actualPnl, x, yEv)}" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <div class="learn-cap">
        <span>${t(lang, 'последняя точка', 'last point')}: ${lastLabel}</span>
        <span>${t(lang, 'текущая поправка', 'current correction')}: p ${probBias >= 0 ? '+' : ''}${(probBias * 100).toFixed(1)}pp · EV ${pct(evBias)}</span>
      </div>
    </div>
  </div>`;
}

function momentumStrategyDetail(lang: Lang): string {
  return `<div class="section">
    <div class="section-title">${t(lang, 'Как устроена Impulse Fade', 'How Impulse Fade works')}</div>
    <p class="sd-lead">${t(lang,
      'Impulse Fade — новая активная live-механика на Hyperliquid. Она использует старый Momentum-радар как детектор резкого всплеска, но после аудита торгует <b>против позднего импульса</b>: если монета резко выстрелила вверх, ищем short fade; если резко продавили вниз, ищем long fade. Система смотрит весь рынок лёгким 2-секундным allMids-радаром, собирает 1m-свечи, пересчитывает порог всплеска под волатильность каждой монеты и в real входит только после проверок стакана, спреда, свободной монеты и риск-лимитов.',
      'Impulse Fade is the new active live mechanic on Hyperliquid. It uses the old Momentum radar as a sharp-burst detector, but after the audit it trades <b>against the late impulse</b>: if a coin spikes up, it looks for a short fade; if it flushes down, it looks for a long fade. The system watches the full market with a lightweight 2-second allMids radar, builds 1m candles, recalculates the burst threshold from each coin’s volatility, and only enters live after book depth, spread, free-coin and risk-limit checks.')}</p>
    <div class="sd-steps">
      <div class="sd-step"><span class="n">1</span><h5>${t(lang, 'Адаптивный all-market сканер', 'Adaptive all-market scanner')}</h5><p>${t(lang, 'Каждые 2 секунды лёгкий allMids-радар смотрит весь рынок на резкие intrabar-сдвиги и собирает текущие 1m OHLC. Подтверждающий слой проверяет закрытые минутные свечи: 3 минуты всплеска, 12 минут контекста и часовой фон. Порог всплеска не фиксированный: он пересчитывается по текущей волатильности монеты и свежему объёмному профилю.', 'Every 2 seconds a light allMids radar watches the full market for sharp intrabar moves and builds current 1m OHLC. The confirmation layer checks closed minute candles: 3 minutes of burst, 12 minutes of context, and one-hour background. The burst threshold is not fixed: it is recalculated from the coin’s current volatility and recent volume profile.')}</p></div>
      <div class="sd-step"><span class="n">2</span><h5>${t(lang, 'Fade позднего импульса', 'Late-impulse fade')}</h5><p>${t(lang, 'Если монета свободна, спред нормальный и в стакане достаточно глубины, стратегия входит малым рыночным ордером против всплеска: short после чрезмерного up-impulse или long после чрезмерного down-impulse. Fast-слой пока собирает бумажную статистику; реальные входы ограничены governor-режимом и live-гейтами.', 'If the coin is free, spread is acceptable and the book has enough depth, the strategy enters with a small market order against the burst: short after an excessive up-impulse or long after an excessive down-impulse. The fast layer is still collecting paper evidence; real entries are constrained by the governor and live gates.')}</p></div>
      <div class="sd-step cat"><span class="n">3</span><h5>${t(lang, 'Динамический риск, Kelly-размер и быстрый выход', 'Dynamic risk, Kelly sizing and fast exit')}</h5><p>${t(lang, 'На входе считаем распределение true range монеты: медиану, хвостовые квантили и свежий режим. Из этого строятся стоп, зона включения трейлинга и допустимый откат без фиксированного %-коридора. Размер позиции тоже не фиксированный: score/EV сигнала переводится в консервативный fractional Kelly, но остаётся в micro-коридоре. Биржевой стоп ставится сразу; 2-секундный fast-менеджер может закрыть по трейлингу внутри свечи. Модель держит расчётный net risk/reward не хуже 1:2.', 'At entry, the strategy estimates the coin’s true-range distribution: median, tail quantiles and fresh regime. Stop, trailing activation and giveback are derived from that without a fixed percentage band. Position size is not fixed either: signal score/EV is converted into conservative fractional Kelly while staying inside a micro range. An exchange stop is placed immediately; the 2-second fast manager can close on trailing inside the candle. Designed net risk/reward stays at least 1:2.')}</p></div>
    </div>
    <div class="sd-blocks">
      <div class="sd-block">
        <h4>${t(lang, 'Зачем она нужна', 'Why it exists')}</h4>
        <ul>
          <li>${t(lang, 'Аудит Momentum показал: поздние импульсы чаще выдыхались, чем продолжались. Мы не удалили радар — мы перевернули торговую гипотезу.', 'The Momentum audit showed that late impulses were more often fading than continuing. We did not throw away the radar; we inverted the trading hypothesis.')}</li>
          <li>${t(lang, 'Это отдельная mean-reversion логика поверх all-market импульсного сканера, а не ещё одна копия wick-fade.', 'This is separate mean-reversion logic on top of an all-market impulse scanner, not another copy of wick-fade.')}</li>
          <li>${t(lang, 'Пока размер специально минимальный: задача — собрать настоящую статистику на деньгах.', 'Size is intentionally minimal for now: the goal is to collect real-money statistics.')}</li>
        </ul>
      </div>
      <div class="sd-block risk">
        <h4>${t(lang, 'Защита от конфликта', 'Conflict protection')}</h4>
        <ul>
          <li>${t(lang, 'Одна монета не может одновременно управляться двумя live-механиками.', 'One coin cannot be managed by two live mechanics at the same time.')}</li>
          <li>${t(lang, 'При входе Impulse Fade монета получает lock, чтобы другая live-механика не открыла конфликтующую позицию.', 'When Impulse Fade enters, the coin receives a lock so another live mechanic cannot open a conflicting position.')}</li>
          <li>${t(lang, 'Биржевой стоп ставится сразу после подтверждения позиции; кодовый poll остаётся резервной защитой.', 'An exchange stop is placed immediately after position confirmation; the code poll remains backup protection.')}</li>
          <li>${t(lang, 'Momentum Doctor каждую минуту проверяет новые закрытые live-сделки, сравнивает прогноз с фактом и осторожно двигает только ограниченные bias-поправки.', 'Momentum Doctor checks new closed live trades every minute, compares forecast with reality and carefully moves only bounded bias corrections.')}</li>
        </ul>
      </div>
    </div>
  </div>`;
}

export function renderMomentumTrack(page = 1, lang: Lang = 'ru'): string {
  const liveClosed = momentumPublicRows(momClosedStmt.all());
  const liveOpen = momentumPublicRows(momOpenStmt.all());
  const live = computeMomentumStats(liveClosed, liveOpen.length);
  const promotionStage = runtimeText('hl_momentum_promotion_stage', 'canary-1');
  const promotionN = Math.round(runtimeNum('hl_momentum_confirm_long_canary_live_n', 0));
  const promotionExactN = Math.round(runtimeNum('hl_momentum_promotion_exact_n', promotionN));
  const promotionNextN = Math.round(runtimeNum('hl_momentum_promotion_next_min_trades', 10));
  const promotionMaxOpen = Math.round(runtimeNum('hl_momentum_confirm_long_canary_max_open', 1));
  const confirmLongShadowN = Math.round(runtimeNum('hl_momentum_confirm_long_shadow_n', 0));
  const confirmLongShadowTargetN = Math.round(runtimeNum('hl_momentum_confirm_long_sample_n', 40));
  const promotionProgress = promotionStage === 'shadow'
    ? `shadow proof ${confirmLongShadowN}/${confirmLongShadowTargetN}`
    : promotionNextN > 0
      ? `${promotionN}/${promotionNextN}`
      : `${promotionExactN}/${promotionN}`;
  const statCard = (l: string, v: string, vc = '', s = '', sc = ''): string =>
    `<div class="lt-stat"><div class="l">${l}</div><div class="v ${vc}">${v}</div>${s ? `<div class="s ${sc}">${s}</div>` : ''}</div>`;

  return pageShell(
    t(lang, 'Impulse Fade — отдельная live-стратегия · Robot Claude', 'Impulse Fade — separate live strategy · Robot Claude'),
    `
    <div class="header">
      <a class="lt-back" href="/lab">${t(lang, '← в лабораторию', '← to the lab')}</a>
      <span class="strat-code">${t(lang, 'LIVE MICRO · HYPERLIQUID · IMPULSE FADE', 'LIVE MICRO · HYPERLIQUID · IMPULSE FADE')}</span>
      <h1 class="title">Impulse Fade</h1>
      <p class="subtitle">${t(lang, 'Адаптивная fade-стратегия: 2-секундный радар поздних импульсов, score/EV/Kelly-размер, новый публичный отсчёт.', 'Adaptive fade strategy: 2-second late-impulse radar, score/EV/Kelly sizing, new public track.')}</p>
    </div>
    <style>${TRACK_CSS}</style>

    <div class="lt-phase">
      <span class="dot"></span>
      <div>${t(lang, `<b>Этап: ${promotionStage} · ${promotionProgress} сделок, exact ${promotionExactN}/${promotionN}.</b> Торгуется только доказанный confirm-long, максимум ${promotionMaxOpen} ${promotionMaxOpen === 1 ? 'позиция' : 'позиции'}; повышение суммы не происходит автоматически. Публичный отсчёт fade-reversal запущен `, `<b>Stage: ${promotionStage} · ${promotionProgress} trades, exact ${promotionExactN}/${promotionN}.</b> Only proven confirm-long is traded, with at most ${promotionMaxOpen} open ${promotionMaxOpen === 1 ? 'position' : 'positions'}; notional does not increase automatically. The public fade-reversal track launched at `)}${momentumPublicStartText(lang)}${t(lang, '. Плечо 1x, стоп на бирже; stop/trail считаются из текущего распределения волатильности.', '. Leverage is 1x with an exchange stop; stop/trail are derived from the current volatility distribution.')}</div>
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
    ${momentumLearningChart(lang)}
    ${momentumStrategyDetail(lang)}

    <div class="section">
      <div class="section-title">${t(lang, 'Live открыто сейчас', 'Live open now')} · ${liveOpen.length}</div>
      ${momentumOpenTable(liveOpen, Date.now(), lang)}
    </div>

    <div class="section" id="signals">
      ${momentumSignalJournal(lang)}
    </div>

    <div class="section" id="closed">
      <div class="section-title">${t(lang, 'Live закрытые сделки', 'Live closed trades')} · ${liveClosed.length}</div>
      ${momentumClosedTable(liveClosed, page, '/lab/momentum', lang)}
    </div>

    <p class="lt-note">${t(lang, 'На странице показана только live-статистика Impulse Fade: реальные деньги и реальные исполнения с нового fade-reversal старта. Старая Momentum Follow история сохранена для внутреннего анализа и не смешивается с публичным треком. Прошлые результаты не гарантируют будущих.', 'This page shows only Impulse Fade live stats: real money and real execution from the new fade-reversal start. The old Momentum Follow history is kept for internal analysis and is not mixed into the public track. Past results do not guarantee future results.')}</p>
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
  const momRows = momentumPublicRows(momClosedStmt.all());
  const momOpen = momentumPublicRows(momOpenStmt.all());
  const mom = computeMomentumStats(momRows, momOpen.length);
  return `
    <div class="lt-hero-stack">
    <a class="lt-hero" href="/lab/momentum">
      <div class="lt-hero-l">
        <span class="lt-hero-badge">🧭 IMPULSE FADE · Hyperliquid · ${t(lang, 'новый отсчёт', 'new track')}</span>
        <div class="lt-hero-title">Impulse Fade</div>
        <div class="lt-hero-sub">${t(lang, 'Адаптивный 2s-радар поздних импульсов: описание и отдельная статистика →', 'Adaptive 2s late-impulse radar: description and separate stats →')}</div>
      </div>
      <div class="lt-hero-r">
        <div class="lt-hero-stat"><div class="v ${cls(mom.netPct)}">${pct(mom.netPct)}</div><div class="k">${t(lang, 'live', 'live')}</div></div>
        <div class="lt-hero-stat"><div class="v">${mom.closed}</div><div class="k">${t(lang, 'сделок', 'trades')}</div></div>
        <div class="lt-hero-stat"><div class="v">${mom.open}</div><div class="k">${t(lang, 'открыто', 'open')}</div></div>
        <div class="lt-hero-stat"><div class="v">${mom.winRate != null ? `${(mom.winRate * 100).toFixed(0)}%` : '—'}</div><div class="k">${t(lang, 'винрейт', 'win rate')}</div></div>
      </div>
    </a>
    ${truePairsHero(lang)}
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
  app.get('/lab/live', async (_req, reply) => {
    reply.header('Cache-Control', 'public, max-age=30');
    return reply.redirect('/lab/momentum', 302);
  });

  app.get<{ Querystring: { page?: string } }>('/lab/momentum', async (req, reply) => {
    const page = Math.max(1, parseInt(req.query.page ?? '1', 10) || 1);
    reply.type('text/html; charset=utf-8');
    reply.header('Cache-Control', 'public, max-age=30');
    return renderMomentumTrack(page, getLang(req));
  });
}
