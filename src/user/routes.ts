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
import { findSubscription } from '../db/repos/user-subscriptions.js';
import { findActiveKey, summaryOf } from '../db/repos/user-api-keys.js';
import {
  listUserStrategies,
  enableUserStrategy,
  disableUserStrategy,
} from '../db/repos/user-strategies.js';
import { STRATEGY_CONFIGS } from '../strategies/track-c-config.js';
import { renderDashboard } from './dashboard.js';
import { renderStrategiesPage } from './strategies.js';
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
    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('cache-control', 'private, no-store');
    return reply.send(
      renderStrategiesPage({
        displayName: user.displayName,
        apiKeyConnected: !!apiKey && apiKey.last_verified_at !== null,
        userStrategies: userStrategyMap(user.userId),
        flash: null,
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
    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('cache-control', 'private, no-store');
    return reply.send(
      renderStrategiesPage({
        displayName: user.displayName,
        apiKeyConnected: !!apiKey && apiKey.last_verified_at !== null,
        userStrategies: userStrategyMap(user.userId),
        flash,
      }),
    );
  });
}
