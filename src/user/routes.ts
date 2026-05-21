/**
 * Track D — user cabinet routes (`/account/*`).
 *
 * All routes here require an active session (phone-OTP via Telegram
 * Gateway, see src/auth/routes.ts). Unauthenticated requests redirect
 * to /strategies which already has the OTP-gated registration form.
 *
 * Page styling mirrors the public landing (pageShell from landing.ts)
 * so visual continuity is preserved when a subscriber clicks from
 * /strategies into their cabinet. The mobile chat icon (💬) is
 * deliberately hidden — see hideMobileHelpIcon in pageShell.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getAuthedUser } from '../auth/routes.js';
import { rotateSessionForUser, SESSION_COOKIE, SESSION_TTL_DAYS } from '../auth/session.js';
import { findSubscription, setTradingPaused } from '../db/repos/user-subscriptions.js';
import {
  findActiveKey,
  findAnyKey,
  summaryOf,
  upsertApiKey,
  revokeApiKey,
  recordVerifyResult,
  recordBalance,
  setInsufficientBalance,
  getDecryptedCreds,
} from '../db/repos/user-api-keys.js';
import { fetchBalanceUsdt, bybitErrorLabel, switchToOneWayMode } from '../exchange/bybit-private.js';
import { listUserStrategies } from '../db/repos/user-strategies.js';
import { STRATEGY_CONFIGS } from '../strategies/track-c-config.js';
import { closeAllUserPositions } from '../strategies/user-fanout.js';
import { assignTier } from './tier-assignment.js';
import { matchTier, MIN_AUTOTRADING_DEPOSIT_USDT } from '../strategies/tier-config.js';
// TRACK E note: gatherLotInfo helper (for instruments-info lookup in
// the old manual form) removed — read-only tier view no longer needs it.
import { renderDashboard } from './dashboard.js';
import { computeMarginState } from './margin.js';
import { renderStrategiesPage } from './strategies.js';
import { renderApiKeyPage } from './api-key.js';
import { issueCsrfToken, requireCsrf } from '../auth/csrf.js';
import { renderTradesPage, type UserTradeRow } from './trades.js';
import { renderSubscriptionPage } from './subscription.js';
import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';
import type { UserStrategyRow } from '../db/repos/user-strategies.js';

/** Active + closed Track D positions for a user, joined with the
 *  shared strategy config. The cabinet shows these in the dashboard's
 *  «Открытых позиций сейчас» card and on /account/trades. */
const userOpenPositionsCount = db.prepare<[number], { c: number }>(
  `SELECT COUNT(*) AS c FROM decisions
    WHERE user_id = ? AND status = 'active' AND track = 'strategy'`,
);

const userActiveTradesStmt = db.prepare<[number], UserTradeRow>(
  `SELECT id, created_at, closed_at, status, symbol, side, entry, sl,
          close_price, close_reason, pnl_pct, pnl_r, strategy_id,
          strategy_trade_num, exchange_order_id, bybit_qty, bybit_avg_price,
          bybit_close_avg_price, order_error
     FROM decisions
    WHERE user_id = ? AND status = 'active' AND track = 'strategy'
    ORDER BY created_at DESC`,
);

const userClosedTradesStmt = db.prepare<[number, number, number], UserTradeRow>(
  `SELECT id, created_at, closed_at, status, symbol, side, entry, sl,
          close_price, close_reason, pnl_pct, pnl_r, strategy_id,
          strategy_trade_num, exchange_order_id, bybit_qty, bybit_avg_price,
          bybit_close_avg_price, order_error
     FROM decisions
    WHERE user_id = ? AND status = 'closed' AND track = 'strategy'
    ORDER BY closed_at DESC, created_at DESC
    LIMIT ? OFFSET ?`,
);

const userClosedTradesTotalStmt = db.prepare<[number], { c: number }>(
  `SELECT COUNT(*) AS c FROM decisions
    WHERE user_id = ? AND status = 'closed' AND track = 'strategy'`,
);

const userClosedPnlAgg = db.prepare<[number], { net: number | null }>(
  `SELECT SUM(pnl_pct) AS net FROM decisions
    WHERE user_id = ? AND status = 'closed' AND track = 'strategy'`,
);

const userClosedCount = db.prepare<[number], { c: number }>(
  `SELECT COUNT(*) AS c FROM decisions
    WHERE user_id = ? AND status = 'closed' AND track = 'strategy'`,
);

/** Helper: build a (strategy_id → row) map for the strategies page. */
function userStrategyMap(userId: number): Map<string, UserStrategyRow> {
  const m = new Map<string, UserStrategyRow>();
  for (const r of listUserStrategies(userId)) m.set(r.strategy_id, r);
  return m;
}

export async function userRoute(app: FastifyInstance): Promise<void> {
  // -------- /account --------
  app.get('/account', async (req: FastifyRequest, reply: FastifyReply) => {
    const user = getAuthedUser(req);
    if (!user) {
      reply.redirect('/strategies');
      return;
    }

    const sub = findSubscription(user.userId);
    const apiKey = summaryOf(findActiveKey(user.userId));
    const userStrategies = listUserStrategies(user.userId);
    const enabledStrategies = userStrategies.filter((s) => s.enabled === 1);
    const totalNotional = enabledStrategies.reduce((acc, s) => acc + s.notional_usd, 0);
    const totalStrategiesAvailable = Object.values(STRATEGY_CONFIGS).filter(
      (s) => s.enabled,
    ).length;

    const openNow = userOpenPositionsCount.get(user.userId)?.c ?? 0;
    const closed = userClosedCount.get(user.userId)?.c ?? 0;
    // pnl_pct on user decisions is per-trade % return; without per-trade
    // notional weighting we report a simple sum-of-percents as a rough
    // running total. Phase C will switch this to dollar-PnL once
    // bybit_close_avg_price + bybit_qty land.
    const totalPnlPct = userClosedPnlAgg.get(user.userId)?.net ?? null;

    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('cache-control', 'private, no-store');
    const margin = computeMarginState(user.userId);
    return reply.send(
      renderDashboard({
        displayName: user.displayName,
        phone: user.phone,
        subscription: sub,
        apiKey,
        enabledStrategiesCount: enabledStrategies.length,
        totalStrategiesAvailable,
        totalNotionalUsd: totalNotional,
        openPositionsCount: openNow,
        closedPositionsCount: closed,
        totalPnlPct,
        margin,
      }),
    );
  });

  // -------- GET /account/strategies --------
  app.get('/account/strategies', async (req, reply) => {
    const user = getAuthedUser(req);
    if (!user) {
      reply.redirect('/strategies');
      return;
    }
    const apiKey = findActiveKey(user.userId);
    const sub = findSubscription(user.userId);
    const csrf = issueCsrfToken(req, reply);
    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('cache-control', 'private, no-store');
    const margin = computeMarginState(user.userId);
    // TRACK E — tier-based read-only view. Manual strategy form removed.
    const tierId = sub?.tier_id as import('../strategies/tier-config.js').TierId | undefined;
    const isVip = sub?.plan === 'vip';
    return reply.send(
      renderStrategiesPage({
        displayName: user.displayName,
        tierId: !isVip && tierId ? tierId : null,
        isVip,
        apiKeyConnected: !!apiKey && apiKey.last_verified_at !== null,
        userStrategies: userStrategyMap(user.userId),
        csrfToken: csrf,
        tradingPausedAt: sub?.trading_paused_at ?? null,
        insufficientBalanceAt: apiKey?.insufficient_balance_at ?? null,
        lastBalanceUsdt: apiKey?.last_balance_usdt ?? null,
        usedMarginUsdt: margin.usedUsdt,
        pendingUpgradeTier: (sub?.tier_transition_target_id ?? null) as import('../strategies/tier-config.js').TierId | null,
      }),
    );
  });

  // POST /account/strategies (manual strategy update) — REMOVED in TRACK E.
  // Tier is auto-assigned by balance. Users use /account/strategies/pause
  // and /resume for trading on-off control.

  // -------- POST /account/strategies/pause + /resume --------
  // User-controlled trading pause. When paused, fan-out skips this
  // user entirely; open positions continue to natural exit. Resume
  // is the inverse — re-eligible for new fan-out signals.
  app.post('/account/strategies/pause', async (req, reply) => {
    const user = getAuthedUser(req);
    if (!user) {
      reply.redirect('/strategies');
      return;
    }
    if (!requireCsrf(req, reply)) return;
    setTradingPaused(user.userId, true);
    logger.info({ userId: user.userId }, 'cabinet: trading paused');
    reply.code(303).header('location', '/account/strategies').send();
  });
  app.post('/account/strategies/resume', async (req, reply) => {
    const user = getAuthedUser(req);
    if (!user) {
      reply.redirect('/strategies');
      return;
    }
    if (!requireCsrf(req, reply)) return;
    setTradingPaused(user.userId, false);
    logger.info({ userId: user.userId }, 'cabinet: trading resumed');
    reply.code(303).header('location', '/account/strategies').send();
  });

  // -------- GET /account/api-key --------
  app.get('/account/api-key', async (req, reply) => {
    const user = getAuthedUser(req);
    if (!user) {
      reply.redirect('/strategies');
      return;
    }
    const key = findAnyKey(user.userId);
    // Balance now lives in user_api_keys.last_balance_usdt — survives
    // restarts, no in-memory cache. Refresh happens on every verify
    // (manual or on key save).
    const balance = key && !key.revoked_at && key.last_verified_at !== null
      ? key.last_balance_usdt
      : null;
    const csrf = issueCsrfToken(req, reply);
    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('cache-control', 'private, no-store');
    return reply.send(
      renderApiKeyPage({
        displayName: user.displayName,
        apiKey: summaryOf(key),
        balanceUsdt: balance,
        insufficientBalanceAt: key?.insufficient_balance_at ?? null,
        flash: null,
        csrfToken: csrf,
      }),
    );
  });

  // -------- POST /account/api-key --------
  // Submit apiKey + apiSecret. Verify against Bybit BEFORE encrypting +
  // storing (no DB write on bad creds). On success, persist + cache the
  // balance for the connected-state UI.
  app.post('/account/api-key', async (req, reply) => {
    const user = getAuthedUser(req);
    if (!user) {
      reply.redirect('/strategies');
      return;
    }
    if (!requireCsrf(req, reply)) return;
    const body = (req.body ?? {}) as { apiKey?: string; apiSecret?: string };
    const apiKey = (body.apiKey ?? '').trim();
    const apiSecret = (body.apiSecret ?? '').trim();
    if (!apiKey || !apiSecret) {
      return renderApiKeyWithFlash(req, reply, user, { ok: false, message: 'Заполните оба поля.' });
    }
    const verifyRes = await fetchBalanceUsdt({ apiKey, apiSecret });
    if (!verifyRes.ok) {
      const label = bybitErrorLabel(verifyRes.code);
      logger.warn({ userId: user.userId, code: verifyRes.code, label }, 'api-key verify failed');
      return renderApiKeyWithFlash(req, reply, user, {
        ok: false,
        message: `Bybit отклонил ключ (${label}): ${verifyRes.msg}. Проверьте права ключа и IP-whitelist.`,
      });
    }
    // Force One-Way position mode at onboarding. Our order code assumes
    // One-Way (positionIdx=0); if the user has their account on Hedge
    // mode, first signal would fail with 10001. Better to surface at
    // connect time. Idempotent — returns ok if already One-Way.
    const modeRes = await switchToOneWayMode({ apiKey, apiSecret });
    if (!modeRes.ok) {
      const label = bybitErrorLabel(modeRes.code);
      logger.warn({ userId: user.userId, code: modeRes.code, label }, 'api-key switchMode failed');
      // 110024: you have an open Hedge-mode position — user must close
      // it manually on Bybit before we can switch.
      const msg = modeRes.code === 110024
        ? `Не удалось переключить аккаунт в One-Way режим (${label}): у вас уже есть открытая позиция в Hedge mode на Bybit. Закройте её вручную на бирже и попробуйте ещё раз.`
        : `Не удалось переключить аккаунт в One-Way режим (${label}): ${modeRes.msg}.`;
      return renderApiKeyWithFlash(req, reply, user, { ok: false, message: msg });
    }
    try {
      upsertApiKey({
        userId: user.userId,
        apiKey,
        apiSecret,
        verifiedAt: Date.now(),
        verifyError: null,
      });
      // Persist the freshly-read balance so the cabinet doesn't show
      // "—" after a restart.
      const savedKey = findActiveKey(user.userId);
      if (savedKey) recordBalance(savedKey.id, verifyRes.totalUsdt);
    } catch (err) {
      logger.error({ err, userId: user.userId }, 'upsertApiKey failed');
      return renderApiKeyWithFlash(req, reply, user, {
        ok: false,
        message: 'Не удалось сохранить ключ. Попробуйте позже.',
      });
    }
    // TRACK E — assign tier based on balance. VIP users (operator + Eldar)
    // are handled separately and don't go through auto-assignment.
    const sub = findSubscription(user.userId);
    if (sub?.plan !== 'vip') {
      const tierId = matchTier(verifyRes.totalUsdt);
      if (tierId !== null) {
        try {
          assignTier(user.userId, tierId);
        } catch (err) {
          logger.error({ err, userId: user.userId, tierId }, 'assignTier after verify failed');
        }
      } else {
        return renderApiKeyWithFlash(req, reply, user, {
          ok: true,
          message:
            `Ключ сохранён. Баланс: ${verifyRes.totalUsdt.toFixed(2)} USDT — ниже минимума автотрейдинга ` +
            `($${MIN_AUTOTRADING_DEPOSIT_USDT}). Пополните счёт и нажмите «Проверить связь» — мы автоматически ` +
            `подберём тариф и включим стратегии.`,
        });
      }
    }
    return renderApiKeyWithFlash(req, reply, user, {
      ok: true,
      message: `Ключ сохранён. Баланс на счёте: ${verifyRes.totalUsdt.toFixed(2)} USDT.`,
    });
  });

  // -------- POST /account/api-key/verify --------
  // Re-check existing key without changing it. Updates last_verified_at /
  // last_verify_error in the row; cabinet badge reflects fresh state.
  app.post('/account/api-key/verify', async (req, reply) => {
    const user = getAuthedUser(req);
    if (!user) {
      reply.redirect('/strategies');
      return;
    }
    if (!requireCsrf(req, reply)) return;
    const row = findActiveKey(user.userId);
    if (!row) {
      return renderApiKeyWithFlash(req, reply, user, {
        ok: false,
        message: 'Сначала подключите ключ.',
      });
    }
    const creds = getDecryptedCreds(row);
    const verifyRes = await fetchBalanceUsdt(creds);
    if (!verifyRes.ok) {
      const label = bybitErrorLabel(verifyRes.code);
      recordVerifyResult(row.id, false, label);
      return renderApiKeyWithFlash(req, reply, user, {
        ok: false,
        message: `Bybit отклонил ключ (${label}): ${verifyRes.msg}`,
      });
    }
    recordVerifyResult(row.id, true);
    recordBalance(row.id, verifyRes.totalUsdt);
    // Trust the user: if they're clicking «Проверить связь», they
    // likely just topped up. Clear the insufficient_balance flag so
    // they're eligible for the next signal. If balance is still
    // inadequate, the next placeMarketOrder will re-set it.
    if (row.insufficient_balance_at) setInsufficientBalance(row.id, null);
    return renderApiKeyWithFlash(req, reply, user, {
      ok: true,
      message: `Связь с Bybit ОК. Баланс: ${verifyRes.totalUsdt.toFixed(2)} USDT.`,
    });
  });

  // -------- POST /account/api-key/revoke --------
  // Audit H4 — close every active position on Bybit BEFORE soft-deleting
  // the key. Without this step a revoke would orphan open positions on
  // Bybit because once revoked we have no decrypted creds left to close
  // them — the user would be on the hook to find and close them by hand.
  //
  // If some closes fail (network glitch, balance gate, etc.) we surface
  // a clear message naming the symbols; the user can finish closing
  // manually on Bybit. Revoke still proceeds so the user's expressed
  // intent ("disconnect") is honoured.
  app.post('/account/api-key/revoke', async (req, reply) => {
    const user = getAuthedUser(req);
    if (!user) {
      reply.redirect('/strategies');
      return;
    }
    if (!requireCsrf(req, reply)) return;
    const row = findActiveKey(user.userId);
    if (!row) {
      return renderApiKeyWithFlash(req, reply, user, {
        ok: false,
        message: 'Активного ключа нет.',
      });
    }
    // Audit C1 — close-then-revoke race. Without an upfront block,
    // an incoming TradingView webhook can fan-out an order for this
    // user in the millisecond window between `closeAllUserPositions`
    // and `revokeApiKey`, leaving an orphan position that can no
    // longer be closed (key revoked → no decrypted creds).
    // Pause trading FIRST. listEligibleTargets filters paused users,
    // so fan-out skips them immediately even if a signal lands
    // mid-flight. Pause stays on after revoke — user reconnects a
    // new key and resumes manually.
    setTradingPaused(user.userId, true);
    const closeStats = await closeAllUserPositions(user.userId);
    revokeApiKey(row.id);
    // Audit M-NEW-1 — rotate the session cookie at revoke time. If a
    // cookie was ever stolen, the attacker would otherwise still hold
    // a valid sid 90 days after key revoke and could re-add THEIR key.
    // We rotate proactively at any «privileged» action that the
    // attacker might want to exploit (revoke = the prime example).
    // The legitimate user (running this request) gets the fresh cookie
    // set in this same response; the old sid stops resolving.
    const newSid = rotateSessionForUser(user.userId);
    reply.setCookie(SESSION_COOKIE, newSid, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
    });
    logger.info(
      { userId: user.userId, keyId: row.id, closeStats },
      'api-key revoked by user (paused → closed → revoked → session rotated)',
    );
    let msg = 'Ключ отключён.';
    if (closeStats.attempted > 0) {
      if (closeStats.failed === 0) {
        msg += ` Закрыто ${closeStats.succeeded} открытых позиций.`;
      } else {
        msg +=
          ` Закрыто ${closeStats.succeeded} из ${closeStats.attempted} позиций. ` +
          `Закройте вручную на Bybit: ${closeStats.failedSymbols.join(', ')}.`;
      }
    }
    return renderApiKeyWithFlash(req, reply, user, {
      ok: closeStats.failed === 0,
      message: msg,
    });
  });

  // -------- GET /account/subscription --------
  // Detailed subscription view — bigger than the dashboard stat-card,
  // with progress bar for trial, exact expiry date/time, plan tier,
  // and contextual CTA for renewal (manual via Telegram).
  app.get('/account/subscription', async (req, reply) => {
    const user = getAuthedUser(req);
    if (!user) {
      reply.redirect('/strategies');
      return;
    }
    const sub = findSubscription(user.userId);
    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('cache-control', 'private, no-store');
    return reply.send(
      renderSubscriptionPage({
        displayName: user.displayName,
        subscription: sub,
      }),
    );
  });

  // -------- GET /account/trades --------
  app.get('/account/trades', async (req, reply) => {
    const user = getAuthedUser(req);
    if (!user) {
      reply.redirect('/strategies');
      return;
    }
    // Pagination: 50 closed trades per page. Active positions always
    // shown in full (rare for a user to have >50 open at once).
    const PAGE_SIZE = 50;
    const queryParams = (req.query ?? {}) as { page?: string };
    const pageRaw = Number(queryParams.page ?? '1');
    const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1;
    const offset = (page - 1) * PAGE_SIZE;
    const active = userActiveTradesStmt.all(user.userId);
    const closed = userClosedTradesStmt.all(user.userId, PAGE_SIZE, offset);
    const closedTotal = userClosedTradesTotalStmt.get(user.userId)?.c ?? 0;
    const apiKey = findActiveKey(user.userId);
    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('cache-control', 'private, no-store');
    return reply.send(
      renderTradesPage({
        displayName: user.displayName,
        activeTrades: active,
        closedTrades: closed,
        hasApiKey: !!apiKey && apiKey.last_verified_at !== null,
        page,
        pageSize: PAGE_SIZE,
        closedTotal,
      }),
    );
  });
}

/** Re-render the API-key page after a POST. Reads fresh key state +
 *  persisted balance (column on user_api_keys) so the user sees the
 *  result of their action. Caller must pass req+reply so we can issue
 *  a fresh CSRF token for the embedded forms. */
function renderApiKeyWithFlash(
  req: FastifyRequest,
  reply: FastifyReply,
  user: { userId: number; displayName: string | null },
  flash: { ok: boolean; message: string },
): FastifyReply {
  const key = findAnyKey(user.userId);
  const balance = key && !key.revoked_at && key.last_verified_at !== null
    ? key.last_balance_usdt
    : null;
  const csrf = issueCsrfToken(req, reply);
  reply.header('content-type', 'text/html; charset=utf-8');
  reply.header('cache-control', 'private, no-store');
  return reply.send(
    renderApiKeyPage({
      displayName: user.displayName,
      apiKey: summaryOf(key),
      balanceUsdt: balance,
      insufficientBalanceAt: key?.insufficient_balance_at ?? null,
      flash,
      csrfToken: csrf,
    }),
  );
}
