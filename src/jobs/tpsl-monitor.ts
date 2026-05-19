import cron from 'node-cron';
import pLimit from 'p-limit';
import { existsSync } from 'node:fs';
import { logger } from '../lib/logger.js';
import {
  findActivePositions,
  findDecisionById,
  calcPnl,
  closePositionWithStats,
  closeUserDecision,
  forceClose,
  syncUserDecisionFromExchange,
  type DecisionRow,
} from '../db/repos/decisions.js';
import { getLastPrice } from '../exchange/bybit-public.js';
import {
  fetchPosition,
  fetchExecutions,
  fetchClosedPnl,
  setPositionSL,
} from '../exchange/bybit-private.js';
import { findActiveKey, getDecryptedCreds } from '../db/repos/user-api-keys.js';
import { sendMessage, sendPhoto } from '../telegram/bot.js';
import { resultPost } from '../telegram/result-template.js';
import { markTick } from '../lib/health-tracker.js';

let running = false;

/**
 * Track C tpsl-monitor — safety SL only.
 *
 * LuxAlgo Strategy Builder positions delegate primary exit logic to the
 * strategy's own "Builtin Exits" via webhook (handled in
 * src/strategies/strategy-trader.ts). This monitor is the safety net for:
 *   - Strategy didn't send exit in time (or webhook lost in transit) AND
 *     price moved against us beyond the configured safety SL.
 *
 * No TP detection, no SL→BE move, no multi-TP / partial-close logic —
 * those were Track A/B concepts and have been removed.
 *
 * Time-guard: Track C positions are INTENTIONALLY exempt from the 24h
 * time-cap. LuxAlgo backtests routinely hold positions multiple days
 * (avg duration on STRAT-001 ≈ 39h on 15m), and force-closing at 24h
 * bypasses the strategy's own edge.
 */

async function checkPosition(pInput: DecisionRow): Promise<void> {
  // Refresh from DB on each tick. Concurrent mutations (force_close
  // from a strategy_exit webhook) require fresh state.
  const fresh = findDecisionById(pInput.id);
  if (!fresh || fresh.status !== 'active') return;
  const p = fresh;

  if (!p.entry || !p.sl || !p.side) return;
  if (p.side !== 'long' && p.side !== 'short') return;

  const price = await getLastPrice(p.symbol);
  if (price == null) return;

  // Safety SL check — Track C is SL-only, no TP, no BE move.
  const slHit = (p.side === 'long' && price <= p.sl) || (p.side === 'short' && price >= p.sl);
  if (slHit) {
    return closeFull(p, p.sl, 'sl_hit', '🛡 Safety SL');
  }
}

/** Close the position with computed PnL (R is computed from original SL
 *  so partial fills / SL moves never inflate the realised-R number). */
async function closeFull(
  p: DecisionRow,
  closePrice: number,
  reason: 'tp_hit' | 'sl_hit' | 'manual',
  hint: string,
): Promise<void> {
  if (!p.entry || !p.side) return;
  const slForR = p.original_sl ?? p.sl ?? p.entry;
  const { pnlPct, pnlR } = calcPnl(p.side as 'long' | 'short', p.entry, slForR, closePrice);
  const closed = closePositionWithStats({ id: p.id, closePrice, closeReason: reason, pnlPct, pnlR });
  if (!closed) {
    logger.info({ position_id: p.id, reason }, 'tpsl: already closed elsewhere, skip post');
    return;
  }
  logger.info(
    { position_id: p.id, reason, closePrice, pnlPct, pnlR, hint },
    'tpsl monitor: position closed',
  );
  await postCloseMessage(p, closePrice, reason, pnlPct, pnlR);
}

async function postCloseMessage(
  p: DecisionRow,
  closePrice: number,
  reason: 'tp_hit' | 'sl_hit' | 'manual',
  pnlPct: number,
  pnlR: number,
): Promise<void> {
  if (!p.entry || !p.side || !p.sl) return;
  // Track C extras: USD P&L on $1000 notional, STRAT-XXX badge,
  // per-strategy counter, landing link. Lazy-imported to avoid
  // circular import between tpsl-monitor → track-c-config.
  let notionalUsd: number | undefined;
  let strategyCode: string | null = null;
  let strategyName: string | null = null;
  let landingUrl: string | null = null;
  if (p.track === 'strategy') {
    const { TRACK_C_NOTIONAL_USD, getStrategyConfig, LANDING_BASE_URL } =
      await import('../strategies/track-c-config.js');
    notionalUsd = TRACK_C_NOTIONAL_USD;
    if (p.strategy_id) {
      const cfg = getStrategyConfig(p.strategy_id);
      strategyCode = cfg?.code ?? null;
      strategyName = cfg?.name ?? null;
      if (strategyCode) landingUrl = `${LANDING_BASE_URL}/strategies/${strategyCode}`;
    }
  }
  const text = resultPost({
    parentTradeId: p.id,
    symbol: p.symbol,
    side: p.side as 'long' | 'short',
    entry: p.entry,
    sl: p.sl,
    tp: null,
    closePrice,
    closeReason: reason,
    pnlPct,
    pnlR,
    durationMs: Date.now() - (p.filled_at ?? p.created_at),
    track: p.track,
    notionalUsd,
    forceCloseReason: p.force_close_reason ?? null,
    strategyCode,
    strategyName,
    strategyTradeNum: p.strategy_trade_num,
    landingUrl,
  });
  if (p.screenshot_path && existsSync(p.screenshot_path)) {
    const sent = await sendPhoto({ channel: 'signals', photoPath: p.screenshot_path, caption: text });
    if (!sent) await sendMessage({ channel: 'signals', text });
  } else {
    await sendMessage({ channel: 'signals', text });
  }
  // Close posts (SL hit, TP hit, time guard) go ONLY to Signals — Logs
  // is reserved for system/webhook monitoring. Operator follows trades
  // via Signals channel, system health via Logs.
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const positions = findActivePositions();
    const userPositions: DecisionRow[] = [];
    for (const p of positions) {
      // Track D — user fan-out rows (user_id != NULL) are managed by
      // Bybit's position-based SL (attached atomically at order create).
      // The exchange fires the stop on its side; our price-tracking loop
      // here would either (a) double-close them or (b) close them at our
      // wrong ticker price. They're reconciled separately below.
      if (p.user_id !== null) {
        userPositions.push(p);
        continue;
      }
      try {
        await checkPosition(p);
      } catch (err) {
        logger.error({ err, position_id: p.id }, 'tpsl checkPosition failed');
      }
    }
    // Phase C reconcile — for each active user row, query Bybit. If the
    // position is flat there (SL fired / closed externally) but our DB
    // says active, mark our row closed using ticker as the close-price
    // proxy. Reads /v5/execution/list / /v5/position/closed-pnl to
    // recover the exact close price + close reason.
    //
    // Audit H2 — parallel reconcile via p-limit(8). Sequential `for
    // await` chews ~400ms per user-position × N — at 50 users with 3
    // positions each that's 60s and the cron tick overruns the
    // 1-minute schedule, accumulating lag. Parallel reads stay well
    // under Bybit's per-UID rate (each user hits their own bucket).
    const reconcileLimit = pLimit(8);
    await Promise.allSettled(
      userPositions.map((p) =>
        reconcileLimit(async () => {
          try {
            await reconcileUserPosition(p);
          } catch (err) {
            logger.error({ err, position_id: p.id }, 'tpsl reconcileUser failed');
          }
        }),
      ),
    );
  } finally {
    running = false;
    markTick('tpsl');
  }
}

async function reconcileUserPosition(p: DecisionRow): Promise<void> {
  if (!p.user_id || !p.side || !p.entry || !p.strategy_id) return;
  const keyRow = findActiveKey(p.user_id);
  if (!keyRow) return; // key revoked; row will be cleaned manually
  let creds;
  try {
    creds = getDecryptedCreds(keyRow);
  } catch {
    return;
  }
  const posRes = await fetchPosition(creds, p.symbol);
  if (!posRes.ok) return;

  if (posRes.position && posRes.position.size > 0) {
    // Position still open. Three things to check in order:
    //
    //   1. PARTIAL CLOSE — Bybit size is meaningfully smaller than our
    //      recorded bybit_qty. The user closed part of the position on
    //      Bybit directly (panic close, partial profit-take, whatever).
    //      Sync our row so subsequent close logic uses the correct qty.
    //
    //   2. USER-MOVED SL — Bybit's attached stopLoss is non-zero AND
    //      differs from our recorded sl by more than 0.5%. The user
    //      manually dragged the stop on Bybit's UI. Respect their
    //      intent: UPDATE our sl to match Bybit, don't re-attach the
    //      old one. R-multiple PnL stays anchored to original_sl
    //      (audit decision — see syncUserDecisionFromExchange comment).
    //
    //   3. SL DETACHED — Bybit's attached stopLoss is exactly 0. The
    //      stop was somehow removed (margin event, manual cancel,
    //      leverage change). Re-attach our sl as the safety net.
    const live = posRes.position;
    const logFields: Record<string, unknown> = {
      decision_id: p.id,
      user_id: p.user_id,
      symbol: p.symbol,
    };

    // (1) partial close detection — 5% tolerance to ignore tiny
    //     rounding diffs (Bybit can report 0.001 vs 0.001000001).
    if (p.bybit_qty && Math.abs(live.size - p.bybit_qty) / p.bybit_qty > 0.05 && live.size < p.bybit_qty) {
      const closedAmount = p.bybit_qty - live.size;
      const closedPct = (closedAmount / p.bybit_qty) * 100;
      logger.warn(
        { ...logFields, was_qty: p.bybit_qty, now_qty: live.size, closed_pct: closedPct.toFixed(1) },
        'tpsl reconcile: partial close detected on exchange',
      );
      syncUserDecisionFromExchange({ id: p.id, bybitQty: live.size });
      // Operator notification — silent so it doesn't ping every minute.
      // First-detection only — subsequent reconciles won't re-fire
      // because the qty diff will now be ≤ tolerance.
      void sendMessage({
        channel: 'logs',
        text:
          `📉 Track D: user_id=${p.user_id} закрыл часть позиции вручную на Bybit · ` +
          `${p.symbol} ${p.side} · было ${p.bybit_qty} → стало ${live.size} (-${closedPct.toFixed(1)}%). ` +
          `Наша БД синхронизирована, оставшаяся часть продолжает работать.`,
        disable_notification: true,
      }).catch(() => {});
    }

    // (2) + (3) SL state. live.stopLoss = 0 means "no SL attached",
    //     otherwise it's the price level Bybit is tracking.
    if (live.stopLoss === 0) {
      // Detached — re-attach our sl as safety net (audit C3 path).
      if (p.sl) {
        const slCheck = await setPositionSL(creds, p.symbol, p.sl);
        if (slCheck.ok) {
          logger.warn({ ...logFields, sl: p.sl }, 'tpsl reconcile: SL was detached, re-attached');
        } else if (slCheck.code !== 34040 /* not modified */) {
          logger.warn(
            { ...logFields, code: slCheck.code, msg: slCheck.msg },
            'tpsl reconcile: SL re-attach failed',
          );
        }
      }
    } else if (p.sl && Math.abs(live.stopLoss - p.sl) / p.sl > 0.005) {
      // User-moved SL. Trust them — update our row to match.
      logger.info(
        { ...logFields, our_sl: p.sl, bybit_sl: live.stopLoss },
        'tpsl reconcile: user moved SL on Bybit, syncing our record',
      );
      syncUserDecisionFromExchange({ id: p.id, sl: live.stopLoss });
    }

    return;
  }

  // Bybit flat → our row is stale. Try to recover the EXACT close price
  // and reason via /v5/execution/list. Walk executions newer than
  // p.created_at, find a reduceOnly fill that closed our slot.
  let closePrice: number | null = null;
  let closeReason: 'sl_hit' | 'manual' = 'sl_hit';
  let bybitCloseAvgPrice: number | null = null;
  const execRes = await fetchExecutions(creds, { symbol: p.symbol, startTime: p.created_at });
  if (execRes.ok) {
    // Sum closing executions by reduceOnly intent: opposite-side fills
    // that have closedSize > 0. Weighted-average their execPrice.
    const ourSideClose = p.side === 'long' ? 'Sell' : 'Buy';
    const closingExecs = execRes.rows.filter(
      (e) => e.side === ourSideClose && e.closedSize > 0 && (e.execType === 'Trade' || e.execType === 'BustTrade'),
    );
    if (closingExecs.length > 0) {
      let totalQty = 0;
      let weighted = 0;
      let hasBust = false;
      for (const e of closingExecs) {
        totalQty += e.execQty;
        weighted += e.execPrice * e.execQty;
        if (e.execType === 'BustTrade') hasBust = true;
      }
      bybitCloseAvgPrice = totalQty > 0 ? weighted / totalQty : null;
      closePrice = bybitCloseAvgPrice;
      // BustTrade = liquidation. Otherwise distinguish SL by price
      // proximity to our recorded sl (within 1% bucket): SL → sl_hit,
      // anything else (TP-like, strategy-exit-by-bybit, manual) → manual.
      if (hasBust) closeReason = 'sl_hit';
      else if (p.sl && bybitCloseAvgPrice && Math.abs(bybitCloseAvgPrice - p.sl) / p.sl < 0.01) closeReason = 'sl_hit';
      else closeReason = 'manual';
    }
  }
  // Audit H7 — second-tier fallback: closed-PnL records. Bybit's
  // execution-list only goes back 7 days; closed-pnl persists longer.
  // Useful when a position was orphaned across a long restart, or our
  // reconcile loop didn't catch the SL hit in the same week it happened.
  if (closePrice == null) {
    const cpRes = await fetchClosedPnl(creds, { symbol: p.symbol, limit: 20 });
    if (cpRes.ok && cpRes.rows.length > 0) {
      // Pick the row whose qty matches our recorded bybit_qty (or
      // entry qty) AND whose createdTime is later than our open.
      // Bybit closed-pnl side is the CLOSING side (opposite of position).
      const ourCloseSide = p.side === 'long' ? 'Sell' : 'Buy';
      const candidate = cpRes.rows.find(
        (row) =>
          row.side === ourCloseSide &&
          row.createdTime >= p.created_at &&
          (p.bybit_qty ? Math.abs(row.qty - p.bybit_qty) / p.bybit_qty < 0.05 : true),
      );
      if (candidate) {
        closePrice = candidate.avgExitPrice;
        bybitCloseAvgPrice = candidate.avgExitPrice;
        // exitType from Bybit: "TakeProfit"/"StopLoss"/"Liquidation"/"Trade"
        if (candidate.exitType === 'StopLoss' || candidate.exitType === 'Liquidation') {
          closeReason = 'sl_hit';
        } else {
          closeReason = 'manual';
        }
        logger.info(
          { decision_id: p.id, exitType: candidate.exitType, closePrice },
          'tpsl reconcile: recovered via closed-pnl',
        );
      }
    }
  }
  // Last-resort fallback: last-price proxy. Far less accurate but
  // better than leaving the row open forever.
  if (closePrice == null) {
    const lastPrice = await getLastPrice(p.symbol);
    if (lastPrice == null) return;
    closePrice = lastPrice;
    logger.warn(
      { decision_id: p.id, lastPrice },
      'tpsl reconcile: using last-price fallback (exec-list + closed-pnl both empty)',
    );
  }

  const slForR = p.original_sl ?? p.sl ?? p.entry;
  const { pnlPct, pnlR } = calcPnl(p.side as 'long' | 'short', p.entry, slForR, closePrice);
  // Map closeReason → forceReason so trade history shows the right
  // origin: sl_hit = Bybit triggered our safety stop; manual_close =
  // user closed the position on Bybit directly; bybit_reconcile =
  // catch-all when we don't know.
  const forceReason: 'bybit_reconcile' | 'manual_close' | 'bybit_sl_hit' =
    closeReason === 'sl_hit'
      ? 'bybit_sl_hit'
      : closeReason === 'manual'
        ? 'manual_close'
        : 'bybit_reconcile';
  closeUserDecision({
    id: p.id,
    closePrice,
    closeReason,
    pnlPct,
    pnlR,
    forceReason,
    bybitCloseAvgPrice,
  });
  // Operator log — silent. Distinct from the partial-close ping above:
  // this fires only when the position is FULLY closed via reconcile,
  // not on every minute.
  const pnlSign = pnlPct >= 0 ? '+' : '';
  const reasonLabel =
    forceReason === 'manual_close'
      ? '✋ закрыл вручную на Bybit'
      : forceReason === 'bybit_sl_hit'
        ? '🛑 сработал SL'
        : '🔄 закрыто (sync)';
  void sendMessage({
    channel: 'logs',
    text:
      `${reasonLabel} · user_id=${p.user_id} · ${p.symbol} ${p.side} · ` +
      `${p.entry} → ${closePrice.toFixed(4)} · ` +
      `PnL ${pnlSign}${pnlPct.toFixed(2)}% (${pnlSign}${pnlR.toFixed(2)}R)`,
    disable_notification: true,
  }).catch(() => {});
  logger.info(
    {
      decision_id: p.id,
      user_id: p.user_id,
      symbol: p.symbol,
      close_price: closePrice,
      close_reason: closeReason,
      via_exec_list: bybitCloseAvgPrice !== null,
    },
    'tpsl reconcile: closed stale user row',
  );
}

// Re-export for forceClose users (none currently outside the monitor itself,
// but kept here so jobs that import forceClose see one source of truth).
export { forceClose };

export function startTpslMonitorJob(): void {
  // Every minute. Bybit public API allows this with massive headroom.
  cron.schedule('* * * * *', () => {
    void tick();
  });
  logger.info('tpsl monitor cron started (every 1 min)');
}
