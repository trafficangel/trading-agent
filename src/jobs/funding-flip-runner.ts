/**
 * FUNDING-FLIP TEST RUNNER — launches the one kill-battery + placebo-verified HL edge in HL
 * TESTNET (fake money) to accumulate live out-of-sample evidence (15–20 net-positive → live).
 *
 * Mechanism — BYTE-IDENTICAL to the verified backtest scripts/sweep-funding.ts: the funding series
 * is built the SAME way (getKlines('60') + loadMicroAligned(...).funding), the flip arithmetic copies
 * sweep-funding's rollMeanStd + flip branch verbatim, and — like the backtest's `i < n-1` loop — the
 * signal is evaluated ONLY on the last CLOSED hour (the in-progress hour is dropped). Per coin: rolling
 * z over W hours; funding was EXTREME (|z|>=zThr) within the last fw hours then FLIPS SIGN → enter the
 * snap-back AWAY from the wiped side; pure 24h TIME-STOP exit.
 *
 * OI-BUILD-UP GATE + KELLY-TILT (added Jun 27 2026): the flip fires ONLY if Bybit open interest ROSE
 * over the prior oiRocHours into the funding extreme (fresh leverage on the doomed side → stronger
 * snap-back), and the position is SIZED ∝ that OI-ROC magnitude (gated-linear, capped at oiSizeMax).
 * Both validated by a 60-shuffle empirical null (gate z>2.2; tilt 97th pct, ~2× pooled net) — see
 * [[hl-micro-layer]] / [[multishuffle-null-vs-single-placebo]]. Coins: ETH+ADA cross-window core +
 * XRP/AVAX (strong gated; BTC dropped — weak gated + no cross-window evidence).
 * LIVE-PROMOTION caveats (testnet-only for now): per-coin margin can scale up to oiSizeMax× the base
 * allocation, so concurrent high-OI flips across coins could over-request margin — fine on testnet
 * (order just rejects), but live needs a PORTFOLIO margin budget. See docs/funding-flip-live-promotion.md.
 *
 * SAFE / reconciled (post-review): the EXCHANGE is the source of truth (hlFetchPosition) — every tick
 * reconciles funding_flip_pos against it BEFORE deciding (crash between order & DB-write can't double-
 * enter; a closed/partial position never books fabricated PnL). One-trade-per-flip via signal_hr dedup
 * (mirrors the backtest's guard). Close books PnL only after CONFIRMING the exchange is truly flat.
 * mode is a const: 'off'=idle, 'testnet'=fake money, 'live' THROWS.
 */
import cron from 'node-cron';
import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { hlConfigured, hlSetLeverage, hlMarketOrder, hlClosePosition, hlFetchPosition, hlAccountValue, hlMid } from '../exchange/hyperliquid-private.js';
import { getBybitOiRoc } from '../exchange/bybit-public.js';

type FfMode = 'off' | 'testnet' | 'live';
export const FF_CONFIG: { mode: FfMode; coins: string[]; W: number; zThr: number; fw: number; holdHours: number; capitalUsd: number; leverage: number; oiGate: boolean; oiRocHours: number; oiSizeTilt: boolean; oiSizeScale: number; oiSizeMax: number } = {
  mode: 'testnet',                                  // operator chose HL testnet
  coins: ['ETH', 'ADA', 'XRP', 'AVAX'],             // ETH+ADA cross-window core + XRP/AVAX (strong gated); BTC DROPPED (gated exp 0.12, Sharpe 0.05, no cross-window validation)
  W: 360, zThr: 2, fw: 6,                           // verified flip config W360 z2 fw6
  holdHours: 24,                                    // pure time-stop — matches the backtest exit
  capitalUsd: 800,                                  // testnet balance; per-coin BASE margin = capitalUsd / coins.length
  leverage: 2,                                      // ~7% backtest maxDD at 2x on the core
  oiGate: true,                                     // OI-BUILD-UP gate: enter only if Bybit OI rose into the flip
  oiRocHours: 12,                                   // ...measured over the prior 12h (null-tested z>2.2, ~3× expectancy)
  oiSizeTilt: true,                                 // KELLY-TILT: size ∝ OI-ROC magnitude (gated-linear, null-tested 97th pct, ~2× pooled net)
  oiSizeScale: 0.04,                                // OI-ROC of +scale ⇒ +1.0 to the size multiplier
  oiSizeMax: 2.0,                                   // cap concentration (backtest used 2.5; capped to 2.0 for live-safety — tilt raised maxDD)
};
const HL_TAKER = 0.07;
const HR = 3_600_000;

type PosRow = { coin: string; side: 'long' | 'short'; entry_px: number; qty: number; funding_at_entry: number | null; signal_hr: number; opened_at: number };
const getPosStmt = db.prepare<[string], PosRow>(`SELECT * FROM funding_flip_pos WHERE coin = ?`);
// dedup high-water mark from REAL flip entries only ('open' rows) — never from wall-clock-stamped
// adopt/reconcile rows (which would future-date it and suppress genuine flips).
const lastSigHrStmt = db.prepare<[string], { hr: number | null }>(`SELECT MAX(signal_hr) AS hr FROM funding_flip_log WHERE coin = ? AND reason = 'open'`);
const insPosStmt = db.prepare(`INSERT OR REPLACE INTO funding_flip_pos (coin,side,entry_px,qty,funding_at_entry,signal_hr,opened_at) VALUES (?,?,?,?,?,?,?)`);
const delPosStmt = db.prepare(`DELETE FROM funding_flip_pos WHERE coin = ?`);
const insLogStmt = db.prepare(`INSERT INTO funding_flip_log (coin,side,entry_px,qty,signal_hr,opened_at,reason,mode) VALUES (?,?,?,?,?,?,?,?)`);
// close an ACTIVE row (closed_at IS NULL) — sets close_reason, NEVER touches the immutable entry `reason`.
const updLogStmt = db.prepare(
  `UPDATE funding_flip_log SET exit_px=?,closed_at=?,pnl_pct=?,close_reason=?
   WHERE id=(SELECT id FROM funding_flip_log WHERE coin=? AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1)`,
);
const supersedeLogStmt = db.prepare(`UPDATE funding_flip_log SET closed_at=?, close_reason='superseded' WHERE coin=? AND closed_at IS NULL`);
const closeTxn = db.transaction((exitPx: number, closedAt: number, netPct: number, coin: string) => {
  updLogStmt.run(exitPx, closedAt, netPct, 'time-stop', coin);
  delPosStmt.run(coin);
});

/** SETTLED hourly funding from HL fundingHistory — the canonical settled rate the verified edge was
 *  built on (the same source backfill-funding.ts used). NOT loadMicroAligned, whose last-in-bucket
 *  would pick up the collector's per-minute INSTANTANEOUS funding for recent hours (a different series
 *  the sign-flip detector is maximally sensitive to). Always MAINNET funding (the real market signal),
 *  even when orders go to testnet. */
async function fundingHistory(coin: string, startMs: number, endMs: number): Promise<{ t: number; f: number }[]> {
  const out: { t: number; f: number }[] = [];
  let cursor = startMs; let guard = 0;
  while (cursor < endMs && guard++ < 60) {
    const res = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'fundingHistory', coin, startTime: cursor, endTime: endMs }) });
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 1500)); continue; }
    if (!res.ok) throw new Error(`HL fundingHistory ${coin}: ${res.status}`);
    const arr = (await res.json()) as { time: number; fundingRate: string }[];
    if (!arr.length) break;
    for (const r of arr) out.push({ t: r.time, f: Number(r.fundingRate) });
    const last = arr[arr.length - 1]!.time;
    if (last <= cursor) break;
    cursor = last + 1;
    if (arr.length < 400) break;
  }
  return out;
}

/** Build the settled hourly series, contiguous + forward-filled (matching the backtest's loaded array),
 *  evaluating only CLOSED hours (drop the in-progress settlement) so `now`/`prev` are both settled. */
async function loadFundingSeries(coin: string): Promise<{ fund: (number | null)[]; sigHr: number } | null> {
  const now = Date.now();
  const fh = await fundingHistory(coin, now - (FF_CONFIG.W + FF_CONFIG.fw + 40) * HR, now);
  const closed = fh.filter((r) => r.t + HR <= now).sort((a, b) => a.t - b.t); // settled, closed hours only
  if (closed.length < FF_CONFIG.W + 2) return null;
  const firstHr = Math.floor(closed[0]!.t / HR); const lastHr = Math.floor(closed[closed.length - 1]!.t / HR);
  const byHr = new Map<number, number>();
  for (const r of closed) byHr.set(Math.floor(r.t / HR), r.f);
  const fund: (number | null)[] = [];
  for (let h = firstHr; h <= lastHr; h++) { const v = byHr.get(h); fund.push(v != null ? v : null); } // NULL for missing hours (no forward-fill) → flipSignal suppresses flips across gaps, matching the backtest
  if (fund.length < FF_CONFIG.W + 2) return null;
  return { fund, sigHr: lastHr };
}

/** rollMeanStd — copied verbatim from sweep-funding.ts (null-skip + n<W/2 refusal). */
function rollMeanStd(a: (number | null)[], i: number, W: number): { m: number; sd: number } {
  let s = 0, ss = 0, n = 0;
  for (let j = Math.max(0, i - W + 1); j <= i; j++) { const v = a[j]; if (v != null) { s += v; ss += v * v; n++; } }
  if (n < W / 2) return { m: 0, sd: 0 };
  const m = s / n; return { m, sd: Math.sqrt(Math.max(0, ss / n - m * m)) };
}

/** flip on the latest CLOSED hour — copied verbatim from sweep-funding.ts run() flip branch. */
function flipSignal(fund: (number | null)[]): { side: 'long' | 'short'; funding: number } | null {
  const i = fund.length - 1; // already the last CLOSED hour (loadFundingSeries dropped the in-progress one)
  if (i < FF_CONFIG.W) return null;
  const { m, sd } = rollMeanStd(fund, i, FF_CONFIG.W);
  if (!(sd > 0)) return null;
  const prevWin = fund.slice(Math.max(0, i - FF_CONFIG.fw - 1), i);
  const wasPos = prevWin.some((v) => v != null && (v - m) / sd >= FF_CONFIG.zThr);
  const wasNeg = prevWin.some((v) => v != null && (v - m) / sd <= -FF_CONFIG.zThr);
  const now = fund[i]; const prev = fund[i - 1];
  if (now == null || prev == null) return null;
  if (wasPos && prev > 0 && now <= 0) return { side: 'long', funding: now };   // long crowd capitulated → long snap-back
  if (wasNeg && prev < 0 && now >= 0) return { side: 'short', funding: now };  // short crowd capitulated → short snap-back
  return null;
}

async function stepCoin(coin: string): Promise<void> {
  const nowMs = Date.now();
  const dbPos = getPosStmt.get(coin);
  const exRes = await hlFetchPosition(coin);
  if (!exRes.ok) { logger.warn({ coin, msg: exRes.msg }, 'funding-flip: position fetch failed — skip tick'); return; }
  const exPos = exRes.data; // HlPosition | null

  // ── RECONCILE the exchange (truth) against the DB ─────────────────────────
  if (exPos && !dbPos) {
    // orphan exchange position with no DB row (crash between order & insert) → adopt so the 24h stop
    // applies and we never re-enter on the same flip = no double-enter.
    supersedeLogStmt.run(nowMs, coin);
    insPosStmt.run(coin, exPos.side, exPos.entryPx, exPos.size, null, Math.floor(nowMs / HR), nowMs);
    insLogStmt.run(coin, exPos.side, exPos.entryPx, exPos.size, null, nowMs, 'adopted', FF_CONFIG.mode); // signal_hr=NULL → excluded from the dedup high-water mark
    logger.warn({ coin, side: exPos.side, entryPx: exPos.entryPx }, 'funding-flip: adopted orphan exchange position');
    return;
  }
  if (!exPos && dbPos) {
    // DB-open but exchange-flat (closed out-of-band, or crash between close & delete) → reconcile;
    // do NOT fabricate a PnL (the real exit price is unknown here).
    updLogStmt.run(null, nowMs, null, 'reconciled-flat', coin);
    delPosStmt.run(coin);
    logger.warn({ coin }, 'funding-flip: DB-open but exchange-flat → reconciled + cleared (PnL unknown)');
    return;
  }

  // ── IN POSITION → 24h time-stop ───────────────────────────────────────────
  if (exPos && dbPos) {
    if (nowMs - dbPos.opened_at < FF_CONFIG.holdHours * HR) return;
    const midBefore = await hlMid(coin);
    if (midBefore == null || !(midBefore > 0)) { logger.warn({ coin }, 'funding-flip: no mid at exit — retry next tick'); return; }
    const res = await hlClosePosition(coin);
    if (!res.ok) { logger.error({ coin, msg: res.msg }, '🛑 funding-flip: close FAILED — retry next tick'); return; }
    const recheck = await hlFetchPosition(coin);
    if (!recheck.ok) { logger.warn({ coin }, 'funding-flip: post-close fetch failed — defer to reconcile'); return; }
    if (recheck.data) { logger.warn({ coin, remaining: recheck.data.size }, 'funding-flip: close did not fully fill — retry next tick'); return; } // still open → don't book
    const entry = dbPos.entry_px; // the REAL fill recorded at open
    const gross = dbPos.side === 'long' ? (midBefore - entry) / entry * 100 : (entry - midBefore) / entry * 100;
    const netPct = +(gross - HL_TAKER).toFixed(3);
    closeTxn(midBefore, nowMs, netPct, coin); // atomic: update log + delete pos (only after confirmed flat)
    logger.warn({ coin, side: dbPos.side, entry, exit: midBefore, pnlPct: netPct }, '✅ funding-flip: CLOSED (24h time-stop)');
    return;
  }

  // ── FLAT (exchange + DB agree) → look for a flip on a CLOSED-hour series ───
  const fs = await loadFundingSeries(coin);
  if (!fs) return;
  const sig = flipSignal(fs.fund);
  if (!sig) return;
  const lastHr = lastSigHrStmt.get(coin)?.hr;
  if (lastHr != null && fs.sigHr <= lastHr) return; // one entry per flip-hour (mirrors the backtest's guard)

  // ── OI-BUILD-UP GATE + KELLY-TILT SIZING ──────────────────────────────────
  // Take the flip ONLY if Bybit open interest ROSE over the prior `oiRocHours` into the funding
  // extreme (fresh leverage piling on the doomed side → bigger flush → stronger snap-back). Null-
  // tested (60-shuffle empirical null, z>2.2; ~3× per-trade expectancy). The window is pinned to the
  // signal hour so the gate is deterministic per flip (no within-hour flip-flop). Bybit reachable on
  // the VPS; any read failure → skip (conservative — miss a trade, never enter unverified).
  // SIZING: among passing flips, scale margin ∝ OI-ROC magnitude (gated-linear, null-tested 97th pct,
  // ~2× pooled net) — bigger OI build ⇒ bigger position, capped at oiSizeMax to bound concentration.
  let sizeMult = 1;
  if (FF_CONFIG.oiGate) {
    const roc = await getBybitOiRoc(`${coin}USDT`, FF_CONFIG.oiRocHours, (fs.sigHr + 1) * HR);
    if (roc == null) { logger.warn({ coin, sigHr: fs.sigHr }, 'funding-flip: OI-gate could not read Bybit OI — skip (conservative)'); return; }
    if (roc <= 0) { logger.warn({ coin, side: sig.side, oiRoc: +roc.toFixed(4), sigHr: fs.sigHr }, '⏸ funding-flip: OI-gate BLOCKED flip (OI did not build into the extreme)'); return; }
    sizeMult = FF_CONFIG.oiSizeTilt ? Math.min(FF_CONFIG.oiSizeMax, Math.max(1, 1 + roc / FF_CONFIG.oiSizeScale)) : 1;
    logger.info({ coin, oiRoc: +roc.toFixed(4), sizeMult: +sizeMult.toFixed(2) }, 'funding-flip: OI-gate passed (OI built into the flip, sized by build magnitude)');
  }

  const reqMargin = (FF_CONFIG.capitalUsd / FF_CONFIG.coins.length) * sizeMult;
  const av = await hlAccountValue(); // known to mis-read 0 sometimes → only enforce on a sane positive value
  if (av.ok && av.data > 0 && av.data < reqMargin) { logger.warn({ coin, balance: av.data, reqMargin }, 'funding-flip: balance < required margin — skip'); return; }
  const mid = await hlMid(coin);
  if (mid == null || !(mid > 0)) { logger.warn({ coin }, 'funding-flip: no mid for entry — skip'); return; }
  const qty = (reqMargin * FF_CONFIG.leverage) / mid;
  const lev = await hlSetLeverage(coin, FF_CONFIG.leverage);
  if (!lev.ok) { logger.warn({ coin, msg: lev.msg }, 'funding-flip: setLeverage failed — skip tick (keep sizing realism)'); return; }
  const res = await hlMarketOrder({ coin, side: sig.side, qty });
  if (!res.ok) { logger.error({ coin, side: sig.side, qty: +qty.toFixed(6), msg: res.msg }, '🛑 funding-flip: OPEN FAILED'); return; }
  // record the REAL fill (entryPx/size) from the exchange, not the pre-order mid
  const after = await hlFetchPosition(coin);
  const fillPx = after.ok && after.data ? after.data.entryPx : mid;
  const fillQty = after.ok && after.data ? after.data.size : qty;
  insPosStmt.run(coin, sig.side, fillPx, fillQty, sig.funding, fs.sigHr, nowMs);
  insLogStmt.run(coin, sig.side, fillPx, fillQty, fs.sigHr, nowMs, 'open', FF_CONFIG.mode);
  logger.warn({ coin, side: sig.side, fillPx, qty: +fillQty.toFixed(6), sizeMult: +sizeMult.toFixed(2), notional: +(reqMargin * FF_CONFIG.leverage).toFixed(0), sigHr: fs.sigHr, mode: FF_CONFIG.mode }, '✅ funding-flip: OPENED testnet (flip-capitulation, OI-sized)');
}

let running = false;
export function startFundingFlipRunner(): void {
  if (FF_CONFIG.mode === 'off') { logger.info('funding-flip runner: mode=off (idle)'); return; }
  if (FF_CONFIG.mode === 'live') throw new Error('funding-flip: live mode not enabled — prove out on testnet first');
  // SAFETY: mode='testnet' must route to the testnet endpoint. The endpoint is chosen by
  // config.HL_USE_TESTNET, NOT by this const — assert they agree so a prod .env flip can't send REAL money.
  if (FF_CONFIG.mode === 'testnet' && !config.HL_USE_TESTNET) { logger.error('🛑 funding-flip: mode=testnet but HL_USE_TESTNET=false — REFUSING to route orders to mainnet; runner idle'); return; }
  cron.schedule('*/5 * * * *', () => {
    if (running) return;
    running = true;
    void (async () => {
      for (const coin of FF_CONFIG.coins) {
        try { await stepCoin(coin); } catch (err) { logger.error({ err, coin }, 'funding-flip: step failed'); }
      }
    })().finally(() => { running = false; });
  });
  logger.warn({ mode: FF_CONFIG.mode, coins: FF_CONFIG.coins, lev: FF_CONFIG.leverage, cfg: `W${FF_CONFIG.W}z${FF_CONFIG.zThr}fw${FF_CONFIG.fw}h${FF_CONFIG.holdHours}`, oiGate: FF_CONFIG.oiGate, oiTilt: FF_CONFIG.oiSizeTilt ? `≤${FF_CONFIG.oiSizeMax}x` : false }, '✅ funding-flip TEST runner scheduled (every 5m, HL testnet, closed-bar + exchange-reconciled + OI-gate/tilt)');
  if (!hlConfigured()) logger.error('funding-flip: HL_API_WALLET_KEY missing — runner idles until configured');
}
