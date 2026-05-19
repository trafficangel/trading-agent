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
import { findSubscription, setTradingPaused } from '../db/repos/user-subscriptions.js';
import {
  findActiveKey,
  findAnyKey,
  summaryOf,
  upsertApiKey,
  revokeApiKey,
  recordVerifyResult,
  recordBalance,
  getDecryptedCreds,
} from '../db/repos/user-api-keys.js';
import { fetchBalanceUsdt, bybitErrorLabel } from '../exchange/bybit-private.js';
import {
  listUserStrategies,
  enableUserStrategy,
  disableUserStrategy,
} from '../db/repos/user-strategies.js';
import { STRATEGY_CONFIGS } from '../strategies/track-c-config.js';
import { renderDashboard } from './dashboard.js';
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
    return reply.send(
      renderStrategiesPage({
        displayName: user.displayName,
        apiKeyConnected: !!apiKey && apiKey.last_verified_at !== null,
        userStrategies: userStrategyMap(user.userId),
        flash: null,
        csrfToken: csrf,
        tradingPausedAt: sub?.trading_paused_at ?? null,
      }),
    );
  });

  // -------- POST /account/strategies --------
  // Form-encoded body of shape `s__<strategy_id>__<field>` repeated for
  // every strategy on the page. Each (enabled, notional, leverage) trio
  // is upserted; unchecked rows are disabled. We tolerate unknown
  // strategy_ids quietly (could happen if STRATEGY_CONFIGS was edited
  // between page load and submit).
  app.post('/account/strategies', async (req, reply) => {
    const user = getAuthedUser(req);
    if (!user) {
      reply.redirect('/strategies');
      return;
    }
    if (!requireCsrf(req, reply)) return;
    const body = (req.body ?? {}) as Record<string, string>;
    const grouped = new Map<string, { enabled: boolean; notional?: string; leverage?: string }>();
    for (const [key, value] of Object.entries(body)) {
      const m = key.match(/^s__(.+?)__(enabled|notional|leverage)$/);
      if (!m) continue;
      const sid = m[1]!;
      const field = m[2]!;
      const existing = grouped.get(sid) ?? { enabled: false };
      if (field === 'enabled') existing.enabled = value === '1';
      else if (field === 'notional') existing.notional = value;
      else if (field === 'leverage') existing.leverage = value;
      grouped.set(sid, existing);
    }

    let okCount = 0;
    let skipCount = 0;
    const errors: string[] = [];

    for (const [strategyId, fields] of grouped) {
      if (!STRATEGY_CONFIGS[strategyId]?.enabled) {
        skipCount++;
        continue;
      }
      if (!fields.enabled) {
        disableUserStrategy(user.userId, strategyId);
        continue;
      }
      const notional = Number(fields.notional);
      const leverage = Math.floor(Number(fields.leverage));
      if (!Number.isFinite(notional) || notional < 10) {
        errors.push(`${strategyId}: размер позиции должен быть ≥ 10 USDT`);
        continue;
      }
      if (!Number.isFinite(leverage) || leverage < 1 || leverage > 100) {
        errors.push(`${strategyId}: плечо должно быть от 1× до 100×`);
        continue;
      }
      try {
        enableUserStrategy({
          userId: user.userId,
          strategyId,
          notionalUsd: notional,
          leverage,
        });
        okCount++;
      } catch (err) {
        logger.error({ err, userId: user.userId, strategyId }, 'enableUserStrategy failed');
        errors.push(`${strategyId}: ${(err as Error).message}`);
      }
    }

    const flash = errors.length
      ? { ok: false, message: errors.join(' · ') }
      : { ok: true, message: `Сохранено: ${okCount} стратегий включено${skipCount ? `, ${skipCount} пропущено` : ''}` };

    const apiKey = findActiveKey(user.userId);
    const sub2 = findSubscription(user.userId);
    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('cache-control', 'private, no-store');
    return reply.send(
      renderStrategiesPage({
        displayName: user.displayName,
        apiKeyConnected: !!apiKey && apiKey.last_verified_at !== null,
        userStrategies: userStrategyMap(user.userId),
        flash,
        csrfToken: issueCsrfToken(req, reply),
        tradingPausedAt: sub2?.trading_paused_at ?? null,
      }),
    );
  });

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
    return renderApiKeyWithFlash(req, reply, user, {
      ok: true,
      message: `Связь с Bybit ОК. Баланс: ${verifyRes.totalUsdt.toFixed(2)} USDT.`,
    });
  });

  // -------- POST /account/api-key/revoke --------
  // Soft-delete the key. Open positions on Bybit stay open (we can't
  // close them without the key); they'll be reconciled and closed by
  // the strategy's natural exit signal. New entries no longer fire
  // for this user until they connect a new key.
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
    revokeApiKey(row.id);
    logger.info({ userId: user.userId, keyId: row.id }, 'api-key revoked by user');
    return renderApiKeyWithFlash(req, reply, user, {
      ok: true,
      message: 'Ключ отключён. Открытые позиции продолжат жить до своего естественного выхода.',
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
      flash,
      csrfToken: csrf,
    }),
  );
}
