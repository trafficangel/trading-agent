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
import { findSubscription, setTradingPaused, setSelectedTier } from '../db/repos/user-subscriptions.js';
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
import {
  matchTier,
  MIN_AUTOTRADING_DEPOSIT_USDT,
  listTiers,
  getTier,
  type TierId,
} from '../strategies/tier-config.js';
import { pageShell } from '../strategies/landing.js';
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
    const csrfToken = issueCsrfToken(req, reply);
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
        csrfToken,
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

  // -------- POST /account/subscription/upgrade (TRACK E Phase B) --------
  // User confirms upgrade to a higher tier suggested by balance-monitor.
  // Verifies the target matches current matchTier(balance) (anti-fraud:
  // user can't jump to a tier their balance doesn't support).
  app.post('/account/subscription/upgrade', async (req, reply) => {
    const user = getAuthedUser(req);
    if (!user) {
      reply.redirect('/strategies');
      return;
    }
    if (!requireCsrf(req, reply)) return;
    const targetTier = (req.body as { targetTier?: string })?.targetTier;
    if (!targetTier || !['standard', 'plus', 'pro', 'vip'].includes(targetTier)) {
      reply.code(400).send('bad target tier');
      return;
    }
    const key = findActiveKey(user.userId);
    const balance = key?.last_balance_usdt;
    if (balance == null) {
      reply.code(400).send('no balance to verify against');
      return;
    }
    const matched = matchTier(balance);
    if (matched !== targetTier) {
      logger.warn(
        { userId: user.userId, requested: targetTier, balance, matched },
        'upgrade rejected: target does not match current balance',
      );
      reply.code(400).send('target tier does not match your current balance');
      return;
    }
    try {
      await assignTier(user.userId, targetTier as 'standard' | 'plus' | 'pro' | 'vip', {
        reason: 'manual_upgrade_user_confirmed',
        balanceUsdt: balance,
      });
    } catch (err) {
      logger.error({ err, userId: user.userId, targetTier }, 'upgrade assignTier failed');
      reply.code(500).send('upgrade failed');
      return;
    }
    reply.code(303).header('location', '/account').send();
  });

  // -------- /account/subscription/select-tier (TRACK E Phase D) --------
  // User picks any tier they can afford. Unlike /upgrade which only
  // accepts the matchTier(balance) target, this endpoint accepts any
  // tier as long as balance ≥ tier.minBalanceUsdt. Downshifts are also
  // allowed (user choosing more conservative tier than balance permits).
  app.get('/account/subscription/select-tier', async (req, reply) => {
    const user = getAuthedUser(req);
    if (!user) { reply.redirect('/strategies'); return; }
    const sub = findSubscription(user.userId);
    if (sub?.plan === 'vip') { reply.redirect('/account'); return; }
    const key = findActiveKey(user.userId);
    const balance = key?.last_balance_usdt ?? null;
    const matched = balance != null ? matchTier(balance) : null;
    // Phase G follow-up — distinguish three states:
    //   - activatedTier: actual currently-active tier (only set when user_strategies rows exist)
    //   - selectedTier: user's saved choice without activation (selected_tier_id set, no strategies yet)
    //   - neither: fresh user; default tier_id='standard' should NOT show as "Текущий"
    const userStrategiesCount = listUserStrategies(user.userId).length;
    const activatedTier: TierId | undefined = userStrategiesCount > 0
      ? (sub?.tier_id as TierId | undefined)
      : undefined;
    const selectedTier: TierId | undefined = sub?.selected_tier_id
      ? (sub.selected_tier_id as TierId)
      : undefined;
    const flash = (req.query as { error?: string; ok?: string } | undefined);
    const csrf = issueCsrfToken(req, reply);
    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('cache-control', 'private, no-store');
    return reply.send(renderTierPicker({
      balance,
      matched,
      activatedTier,
      selectedTier,
      csrf,
      errorMsg: flash?.error ?? null,
      okMsg: flash?.ok ?? null,
    }));
  });

  app.post('/account/subscription/select-tier', async (req, reply) => {
    const user = getAuthedUser(req);
    if (!user) { reply.redirect('/strategies'); return; }
    if (!requireCsrf(req, reply)) return;
    const targetTier = (req.body as { targetTier?: string })?.targetTier;
    const validTiers: TierId[] = ['starter', 'standard', 'plus', 'pro', 'vip'];
    if (!targetTier || !validTiers.includes(targetTier as TierId)) {
      reply.code(400).send('bad target tier');
      return;
    }
    const sub = findSubscription(user.userId);
    if (sub?.plan === 'vip') {
      reply.code(303).header('location', '/account').send();
      return;
    }
    if (targetTier === 'vip') {
      // VIP requires manual operator setup (success-fee or custom overrides) —
      // refuse self-service.
      reply.code(303)
        .header('location', '/account/subscription/select-tier?error=' +
          encodeURIComponent('Тариф VIP активируется оператором вручную — напишите @dboykod в Telegram.'))
        .send();
      return;
    }
    // Phase G: store the choice unconditionally. assignTier (which creates
    // user_strategies and starts trading) only fires when balance is enough;
    // otherwise we keep the choice and prompt the user to top up. Onboarding
    // step 3 (tier selection) becomes "done" purely on selected_tier_id.
    setSelectedTier(user.userId, targetTier);
    const key = findActiveKey(user.userId);
    const balance = key?.last_balance_usdt ?? null;
    const tier = getTier(targetTier as TierId);
    const balanceOk = balance !== null && balance >= tier.minBalanceUsdt;
    if (balanceOk) {
      try {
        await assignTier(user.userId, targetTier as Exclude<TierId, 'vip'>, {
          reason: 'manual_choice',
          balanceUsdt: balance,
        });
      } catch (err) {
        logger.error({ err, userId: user.userId, targetTier }, 'select-tier assignTier failed');
        reply.code(303)
          .header('location', '/account/subscription/select-tier?error=' +
            encodeURIComponent('Не удалось применить тариф. Попробуйте позже или напишите оператору.'))
          .send();
        return;
      }
      reply.code(303).header('location', '/account?tier-changed=' + targetTier).send();
      return;
    }
    // Balance insufficient — choice saved, user lands back on dashboard with
    // step 4 (deposit) highlighting the shortfall for this tier.
    reply.code(303).header('location', '/account?tier-selected=' + targetTier).send();
  });

  // Dismiss the upgrade promo. Just clears the pending transition state —
  // balance-monitor will set it again next tick if balance is still above.
  app.post('/account/subscription/dismiss-upgrade', async (req, reply) => {
    const user = getAuthedUser(req);
    if (!user) {
      reply.redirect('/strategies');
      return;
    }
    if (!requireCsrf(req, reply)) return;
    db.prepare(`
      UPDATE user_subscriptions
         SET tier_transition_target_id = NULL,
             tier_transition_first_seen_at = NULL,
             updated_at = ?
       WHERE user_id = ?
    `).run(Date.now(), user.userId);
    reply.code(303).header('location', '/account').send();
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
    let apiKey = (body.apiKey ?? '').trim();
    let apiSecret = (body.apiSecret ?? '').trim();
    // Phase C — server-side fallback for smart-paste. If the user
    // pasted both values into the API Key field separated by newline
    // or colon (and the JS smart-split didn't fire — e.g. JS disabled
    // or different paste behaviour in some browsers), parse it here.
    if (apiKey && !apiSecret) {
      const parts = apiKey.split(/[\r\n:]+/).map((s) => s.trim()).filter(Boolean);
      if (parts.length === 2 && parts[0] && parts[1] && parts[0].length > 8 && parts[1].length > 16) {
        apiKey = parts[0];
        apiSecret = parts[1];
      }
    }
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
    // TRACK E Phase D — user chooses tier explicitly. We no longer auto-assign
    // based on balance: we just verify the key, store the balance, and direct
    // the user to /account/subscription/select-tier where they pick a tier
    // they can afford. VIP users (operator + Eldar) keep their override.
    const sub = findSubscription(user.userId);
    if (sub?.plan === 'vip') {
      // VIP — no tier picker, they keep override settings.
      return renderApiKeyWithFlash(req, reply, user, {
        ok: true,
        message: `Ключ сохранён. Баланс на счёте: ${verifyRes.totalUsdt.toFixed(2)} USDT.`,
      });
    }
    if (verifyRes.totalUsdt < MIN_AUTOTRADING_DEPOSIT_USDT) {
      return renderApiKeyWithFlash(req, reply, user, {
        ok: true,
        message:
          `Ключ сохранён. Баланс: ${verifyRes.totalUsdt.toFixed(2)} USDT — ниже минимума автотрейдинга ` +
          `($${MIN_AUTOTRADING_DEPOSIT_USDT}). Пополните счёт и нажмите «Проверить связь», затем выберите тариф.`,
      });
    }
    // Balance sufficient. Phase F: tier_id is always set by ensureTrialFor
    // default ('standard'), so checking it doesn't tell us whether user
    // has actually PICKED a tier. The real signal is user_strategies rows:
    // assignTier creates them, so listUserStrategies(...).length > 0 means
    // user has been through the tier picker.
    const picked = listUserStrategies(user.userId).length > 0;
    if (!picked) {
      reply.code(303).header('location', '/account/subscription/select-tier?from=api-key').send();
      return;
    }
    return renderApiKeyWithFlash(req, reply, user, {
      ok: true,
      message:
        `Ключ сохранён. Баланс: ${verifyRes.totalUsdt.toFixed(2)} USDT. ` +
        `Если хотите сменить тариф — откройте «Сменить тариф» в кабинете.`,
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
    // Trust the user: if they're clicking «Проверить баланс», they
    // likely just topped up. Clear the insufficient_balance flag so
    // they're eligible for the next signal. If balance is still
    // inadequate, the next placeMarketOrder will re-set it.
    if (row.insufficient_balance_at) setInsufficientBalance(row.id, null);
    // Phase G — three paths after a balance verify, in order:
    //   1. User already activated tier → just refresh balance, show flash.
    //   2. User picked tier (selected_tier_id set) AND balance is now enough
    //      → auto-call assignTier, route to dashboard.
    //   3. User hasn't picked tier AND balance ≥ $300 → route to picker.
    //   4. Otherwise just flash the new balance.
    const subRow = findSubscription(user.userId);
    const pickedTier = listUserStrategies(user.userId).length > 0;
    const selectedTier = subRow?.selected_tier_id as TierId | null | undefined;
    if (subRow?.plan !== 'vip' && !pickedTier && selectedTier && selectedTier !== 'vip') {
      const tier = getTier(selectedTier);
      if (verifyRes.totalUsdt >= tier.minBalanceUsdt) {
        try {
          await assignTier(user.userId, selectedTier, {
            reason: 'auto_activate_on_balance_verify',
            balanceUsdt: verifyRes.totalUsdt,
          });
          reply.code(303).header('location', '/account?tier-activated=' + selectedTier).send();
          return;
        } catch (err) {
          logger.error({ err, userId: user.userId, selectedTier }, 'auto-activate failed');
          // Fall through to flash — we don't want to block the user.
        }
      }
    }
    // Phase G follow-up — when the verify was triggered from the tier-picker
    // page (button there), return the user back to the picker so they can
    // see the refreshed balance + pick a now-affordable tier.
    const returnTo = (req.query as { return_to?: string } | undefined)?.return_to;
    if (returnTo === 'picker') {
      reply.code(303).header('location', '/account/subscription/select-tier?from=verify').send();
      return;
    }
    if (
      subRow?.plan !== 'vip' &&
      !pickedTier &&
      !selectedTier &&
      verifyRes.totalUsdt >= MIN_AUTOTRADING_DEPOSIT_USDT
    ) {
      reply.code(303).header('location', '/account/subscription/select-tier?from=verify').send();
      return;
    }
    const tail = !pickedTier && subRow?.plan !== 'vip' && !selectedTier
      ? ` Минимум для запуска — $${MIN_AUTOTRADING_DEPOSIT_USDT}. Пополните счёт и проверьте снова.`
      : selectedTier && !pickedTier
        ? ` Для тарифа ${getTier(selectedTier).name} нужно $${getTier(selectedTier).minBalanceUsdt}+ — пополните счёт.`
        : '';
    return renderApiKeyWithFlash(req, reply, user, {
      ok: true,
      message: `Связь с Bybit ОК. Баланс: ${verifyRes.totalUsdt.toFixed(2)} USDT.${tail}`,
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

/**
 * Tier-picker UI (TRACK E Phase D). Replaces the previous «balance → auto-assign»
 * flow with explicit user choice. Shows all 5 tiers as cards; the tier that
 * matches the user's current Bybit balance is highlighted as «recommended».
 * Tiers requiring more balance than the user has are shown but disabled with
 * a «not enough balance» hint. VIP is read-only (operator activates manually).
 */
function renderTierPicker(p: {
  balance: number | null;
  matched: import('../strategies/tier-config.js').TierId | null;
  /** Tier that is ACTUALLY active (assignTier called, user_strategies rows exist). */
  activatedTier: import('../strategies/tier-config.js').TierId | undefined;
  /** Tier the user chose but haven't activated yet (balance still insufficient). */
  selectedTier: import('../strategies/tier-config.js').TierId | undefined;
  csrf: string;
  errorMsg: string | null;
  okMsg: string | null;
}): string {
  const tiers = listTiers();
  const balanceStr = p.balance != null ? `$${p.balance.toFixed(0)} USDT` : '—';
  const errBlock = p.errorMsg
    ? `<div class="tp-flash tp-flash-err">⚠ ${escapeHtmlMin(p.errorMsg)}</div>`
    : '';
  const okBlock = p.okMsg
    ? `<div class="tp-flash tp-flash-ok">✓ ${escapeHtmlMin(p.okMsg)}</div>`
    : '';

  // Notice shown when user chose a tier but doesn't have enough balance yet.
  const selectedTierObj = p.selectedTier ? getTier(p.selectedTier) : null;
  const selectedNeedsMore = selectedTierObj
    && p.activatedTier !== p.selectedTier
    && (p.balance ?? 0) < selectedTierObj.minBalanceUsdt;
  const pendingBlock = selectedNeedsMore && selectedTierObj
    ? `
      <div class="tp-pending">
        <div class="tp-pending-title">⏳ Вы выбрали <b>${escapeHtmlMin(selectedTierObj.name)}</b> — нужно пополнить депозит</div>
        <div class="tp-pending-body">
          Для активации тарифа <b>${escapeHtmlMin(selectedTierObj.name)}</b> на Bybit нужно <b>$${selectedTierObj.minBalanceUsdt}</b>.
          Сейчас на счёте <b>$${(p.balance ?? 0).toFixed(0)}</b>. Не хватает <b>$${(selectedTierObj.minBalanceUsdt - (p.balance ?? 0)).toFixed(0)}</b>.
          Пополните Unified Trading Account (единый торговый аккаунт) на Bybit и нажмите «Проверить баланс» ниже —
          как только средств станет достаточно, тариф активируется автоматически.
        </div>
        <div class="tp-pending-actions">
          <a href="https://www.bybit.com/user/assets/home/overview" target="_blank" rel="noopener" class="tp-btn-mini tp-btn-go">Открыть Bybit ↗</a>
          <form method="POST" action="/account/api-key/verify?return_to=picker" style="display:inline">
            <input type="hidden" name="_csrf" value="${p.csrf}"/>
            <button type="submit" class="tp-btn-mini tp-btn-ghost">Проверить баланс</button>
          </form>
        </div>
      </div>
    `
    : '';

  // Standalone "Проверить баланс" — even when no tier picked yet, the user
  // may want to refresh balance before deciding.
  const refreshBlock = `
    <form method="POST" action="/account/api-key/verify?return_to=picker" class="tp-refresh-form">
      <input type="hidden" name="_csrf" value="${p.csrf}"/>
      <button type="submit" class="tp-refresh-btn">↻ Проверить баланс на Bybit</button>
    </form>
  `;

  const cards = tiers.map((t) => {
    const isMatched = p.matched === t.id;
    const isActive = p.activatedTier === t.id;
    const isSelected = p.selectedTier === t.id && !isActive;
    const canAfford = p.balance != null && p.balance >= t.minBalanceUsdt;
    const isVipLocked = t.id === 'vip';
    const subRange = t.expectedMonthlyPnlRangeUsd;
    const maxStr = t.maxBalanceUsdt === Number.POSITIVE_INFINITY
      ? '∞'
      : `$${t.maxBalanceUsdt.toLocaleString()}`;

    const badges: string[] = [];
    if (isActive) badges.push('<span class="tp-badge tp-badge-cur">✓ Активен</span>');
    else if (isSelected) badges.push('<span class="tp-badge tp-badge-pending">⏳ Выбран</span>');
    if (isMatched && !isActive && !isSelected) {
      badges.push('<span class="tp-badge tp-badge-rec">Рекомендуется</span>');
    }

    let actionBtn = '';
    if (isActive) {
      actionBtn = '<button type="button" class="tp-btn tp-btn-disabled" disabled>Уже активен</button>';
    } else if (isVipLocked) {
      actionBtn = '<a href="https://t.me/dboykod" class="tp-btn tp-btn-vip" target="_blank" rel="noopener">Написать оператору</a>';
    } else {
      // Phase G — choice is ALWAYS allowed; activation requires balance.
      // If sufficient balance → "Выбрать и активировать" → POST → assignTier
      // If insufficient → "Выбрать (нужно +$X)" → POST → stores choice + redirects to picker
      const need = Math.max(0, t.minBalanceUsdt - (p.balance ?? 0));
      const label = canAfford
        ? (isSelected ? `Активировать ${escapeHtmlMin(t.name)}` : `Выбрать ${escapeHtmlMin(t.name)} →`)
        : `Выбрать (нужно +$${need.toFixed(0)})`;
      const btnCls = canAfford ? 'tp-btn tp-btn-go' : 'tp-btn tp-btn-soft';
      actionBtn = `
        <form method="POST" action="/account/subscription/select-tier" style="display:inline">
          <input type="hidden" name="_csrf" value="${p.csrf}"/>
          <input type="hidden" name="targetTier" value="${t.id}"/>
          <button type="submit" class="${btnCls}">${label}</button>
        </form>
      `;
    }

    const cardCls = isActive
      ? 'tp-card-cur'
      : isSelected
        ? 'tp-card-selected'
        : isMatched
          ? 'tp-card-rec'
          : '';

    return `
      <div class="tp-card ${cardCls}">
        <div class="tp-card-badges">${badges.join('')}</div>
        <div class="tp-card-name">${escapeHtmlMin(t.name)}</div>
        <div class="tp-card-depo">Депозит $${t.minBalanceUsdt.toLocaleString()}–${maxStr}</div>
        <div class="tp-card-price">
          <span class="tp-card-price-num">$${t.monthlyPriceUsd}</span>
          <span class="tp-card-price-period">/мес</span>
        </div>
        <ul class="tp-card-features">
          <li>${t.strategyIds.length} стратегий</li>
          <li>~$${subRange.low}–$${subRange.high}/мес</li>
          <li>Max DD ≤${t.expectedMaxDdPct}%</li>
          <li>До ${t.maxConcurrentPositions} позиций</li>
        </ul>
        <div class="tp-card-action">${actionBtn}</div>
      </div>
    `;
  }).join('');

  const body = `
    <style>
      .tp-wrap { max-width: 1080px; margin: 0 auto; padding: 24px 16px 64px; }
      .tp-back { font-size: 13px; color: #8590a0; margin-bottom: 18px; }
      .tp-back a { color: #4ad991; text-decoration: none; }
      .tp-back a:hover { text-decoration: underline; }
      .tp-h1 { font-size: 26px; font-weight: 700; color: #e8edf2; margin: 0 0 8px; }
      .tp-sub { font-size: 14px; color: #9aa5b1; line-height: 1.6; margin: 0 0 18px; max-width: 720px; }
      .tp-balance-row {
        display: flex; gap: 12px; align-items: center; margin-bottom: 22px; flex-wrap: wrap;
      }
      .tp-balance { display: inline-flex; gap: 16px; align-items: baseline; padding: 14px 18px;
        background: #11161d; border: 1px solid #1f2630; border-radius: 12px; }
      .tp-balance-label { font-size: 12px; color: #6b7480; text-transform: uppercase; letter-spacing: 0.05em; }
      .tp-balance-val { font-size: 18px; color: #4ad991; font-weight: 600; }
      .tp-refresh-form { display: inline; }
      .tp-refresh-btn {
        background: transparent; border: 1px solid #2a323d; color: #cfd6dd;
        padding: 12px 16px; border-radius: 10px; font-size: 13px; cursor: pointer;
        font-family: inherit; font-weight: 500;
      }
      .tp-refresh-btn:hover { border-color: #4ad991; color: #4ad991; }
      .tp-flash { padding: 12px 16px; border-radius: 10px; margin-bottom: 18px; font-size: 13.5px; line-height: 1.55; }
      .tp-flash-err { background: rgba(255,99,99,0.08); border: 1px solid rgba(255,99,99,0.35); color: #ff8b8b; }
      .tp-flash-ok { background: rgba(74,217,145,0.08); border: 1px solid rgba(74,217,145,0.35); color: #4ad991; }
      .tp-pending {
        background: linear-gradient(180deg, rgba(243,210,102,0.10) 0%, rgba(243,210,102,0.04) 100%);
        border: 1px solid rgba(243,210,102,0.45); border-radius: 14px;
        padding: 18px 22px; margin-bottom: 22px;
      }
      .tp-pending-title { font-size: 15px; color: #f3d266; font-weight: 600; margin-bottom: 6px; }
      .tp-pending-title b { color: #ffe294; }
      .tp-pending-body { font-size: 13px; color: #cfd6dd; line-height: 1.6; margin-bottom: 12px; }
      .tp-pending-body b { color: #f3d266; }
      .tp-pending-actions { display: flex; gap: 8px; flex-wrap: wrap; }
      .tp-btn-mini {
        padding: 8px 14px; border-radius: 7px; font-size: 12.5px; font-weight: 600;
        text-decoration: none; cursor: pointer; border: none; font-family: inherit;
      }
      .tp-btn-ghost {
        background: transparent; border: 1px solid #2a323d; color: #cfd6dd;
      }
      .tp-btn-ghost:hover { border-color: #4ad991; color: #4ad991; }
      .tp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }
      .tp-card { background: #11161d; border: 1px solid #1f2630; border-radius: 14px; padding: 18px;
        display: flex; flex-direction: column; position: relative; }
      .tp-card-cur { border-color: rgba(74,217,145,0.55); background: linear-gradient(180deg, rgba(74,217,145,0.06) 0%, #11161d 70%); }
      .tp-card-rec { border-color: rgba(243,210,102,0.30); }
      .tp-card-selected { border-color: rgba(243,210,102,0.55); background: linear-gradient(180deg, rgba(243,210,102,0.06) 0%, #11161d 70%); }
      .tp-card-badges { min-height: 22px; margin-bottom: 6px; }
      .tp-badge { display: inline-block; padding: 3px 9px; border-radius: 999px;
        font-size: 10.5px; font-weight: 600; letter-spacing: 0.04em; margin-right: 4px; }
      .tp-badge-cur { background: rgba(74,217,145,0.18); color: #4ad991; border: 1px solid rgba(74,217,145,0.4); }
      .tp-badge-rec { background: rgba(243,210,102,0.18); color: #f3d266; border: 1px solid rgba(243,210,102,0.4); }
      .tp-badge-pending { background: rgba(243,210,102,0.30); color: #ffe294; border: 1px solid rgba(243,210,102,0.55); }
      .tp-card-name { font-size: 16px; font-weight: 600; color: #e8edf2; margin-bottom: 4px; }
      .tp-card-depo { font-size: 11.5px; color: #8590a0; margin-bottom: 10px; }
      .tp-card-price { display: flex; align-items: baseline; gap: 4px; margin-bottom: 12px; }
      .tp-card-price-num { font-size: 24px; font-weight: 700; color: #4ad991; }
      .tp-card-price-period { font-size: 12px; color: #8590a0; }
      .tp-card-features { list-style: none; padding: 0; margin: 0 0 14px; flex: 1;
        font-size: 12px; color: #cfd6dd; line-height: 1.6; }
      .tp-card-features li { padding: 2px 0; padding-left: 12px; position: relative; }
      .tp-card-features li::before { content: '✓'; color: #4ad991; position: absolute; left: 0; }
      .tp-card-action { margin-top: auto; }
      .tp-btn { display: block; width: 100%; box-sizing: border-box; padding: 10px 12px;
        border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; border: none;
        text-decoration: none; text-align: center; font-family: inherit; }
      .tp-btn-go { background: #4ad991; color: #0b0e13; }
      .tp-btn-go:hover { background: #5ce0a0; }
      .tp-btn-soft {
        background: transparent; color: #cfd6dd; border: 1px solid #2a323d;
      }
      .tp-btn-soft:hover { border-color: #f3d266; color: #f3d266; }
      .tp-btn-disabled { background: #1a1f27; color: #6b7480; cursor: not-allowed; }
      .tp-btn-vip { background: rgba(243,210,102,0.18); color: #f3d266; border: 1px solid rgba(243,210,102,0.4); }
      .tp-btn-vip:hover { background: rgba(243,210,102,0.3); }
      .tp-note { font-size: 12.5px; color: #6b7480; line-height: 1.6; margin-top: 22px;
        background: #11161d; border: 1px solid #1f2630; padding: 14px 18px; border-radius: 10px; }
      .tp-note b { color: #cfd6dd; }
    </style>
    <div class="tp-wrap">
      <div class="tp-back"><a href="/account">← В кабинет</a></div>
      <h1 class="tp-h1">Выбор тарифа</h1>
      <p class="tp-sub">
        Тариф определяет какие стратегии торгуют на вашем счёте и каким объёмом.
        Выберите тот, который подходит под ваш депозит на Bybit. Можно сменить в любой момент.
      </p>
      <div class="tp-balance-row">
        <div class="tp-balance">
          <span class="tp-balance-label">Баланс на Bybit</span>
          <span class="tp-balance-val">${balanceStr}</span>
        </div>
        ${refreshBlock}
      </div>
      ${errBlock}
      ${okBlock}
      ${pendingBlock}
      <div class="tp-grid">${cards}</div>
      <div class="tp-note">
        <b>Как это работает:</b> вы можете выбрать любой тариф — даже если сейчас на счёте меньше минимума.
        Если баланса хватает, тариф активируется сразу. Если не хватает — мы запомним ваш выбор; пополните
        Unified Trading Account (единый торговый аккаунт) на Bybit и нажмите «Проверить баланс» — тариф автоматически активируется,
        как только средств станет достаточно. Депозит остаётся на вашем Bybit-аккаунте, мы не имеем права
        на вывод.
      </div>
    </div>
  `;
  return pageShell('Выбор тарифа · Robot Claude', body, { lang: 'ru', robots: 'noindex' });
}

/** Tiny HTML-escape — keeps the dependency surface of routes.ts minimal. */
function escapeHtmlMin(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c] ?? c);
}
