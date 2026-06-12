/**
 * Operator-only admin dashboard.
 *
 * GET /admin
 *   HTTP Basic Auth gate. Credentials come from env:
 *     ADMIN_EMAIL    (used as Basic username)
 *     ADMIN_PASSWORD
 *
 *   Page shows:
 *     - Aggregate counters (total / 24h / 7d registrations)
 *     - Table of every registration: created_at / phone / IP / UA / last seen
 *
 * The page itself is the only protected surface — registration data
 * never leaks to public callers. HTTP Basic is fine for a single-
 * operator dashboard; if we ever need multi-admin or audit log we'll
 * switch to session-based auth like /strategies.
 *
 * Browser keeps Basic creds in memory after the first 401 prompt, so
 * the operator only types them once per session.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  listRegistrations,
  getRegistrationStats,
  setPredictAccess,
  type RegistrationListRow,
} from '../auth/session.js';
import { pageShell } from '../strategies/landing.js';
import {
  findSubscription,
  setPlan,
  ensureTrialFor,
  adminExtend,
  listTradingActiveUserIds,
  bulkPauseAllTrading,
  bulkResumeAllTrading,
  type SubscriptionRow,
} from '../db/repos/user-subscriptions.js';
import { closeAllUserPositions } from '../strategies/user-fanout.js';
import { sendMessage } from '../telegram/bot.js';
import { recordAdminAction } from '../db/repos/admin-audit.js';
import { adminCsrfToken, requireAdminCsrf } from '../auth/csrf.js';
import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { TIER_CONFIGS, TIER_ORDER, computeTierTradeSize, type TierId } from '../strategies/tier-config.js';
import { assignTier } from '../user/tier-assignment.js';
import { STRATEGY_CONFIGS, TRACK_C_COMMISSION_RT_PCT } from '../strategies/track-c-config.js';
import { listRecentTransitions } from '../db/repos/user-tier-history.js';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c] ?? c);
}

/** Constant-time string compare — preserves no timing side-channel.
 *  Pads to a fixed length (64) to avoid the early-return when lengths
 *  differ, which itself leaks. */
function constTimeEq(a: string, b: string): boolean {
  const PAD = 64;
  const padded = (s: string): Buffer => {
    const buf = Buffer.alloc(PAD);
    Buffer.from(s).copy(buf, 0, 0, Math.min(s.length, PAD));
    return buf;
  };
  // Comparison is on padded buffers so length itself doesn't leak.
  return timingSafeEqual(padded(a), padded(b)) && a.length === b.length;
}

function checkAuth(req: FastifyRequest, reply: FastifyReply): boolean {
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminEmail || !adminPassword) {
    reply.code(503).send('Admin credentials not configured');
    return false;
  }
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    reply.code(401)
      .header('WWW-Authenticate', 'Basic realm="Robot Claude Admin"')
      .send('Authentication required');
    return false;
  }
  try {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf-8');
    const idx = decoded.indexOf(':');
    if (idx < 0) {
      reply.code(401)
        .header('WWW-Authenticate', 'Basic realm="Robot Claude Admin"')
        .send('Bad credentials');
      return false;
    }
    const user = decoded.slice(0, idx);
    const pass = decoded.slice(idx + 1);
    // Constant-time on both fields. Avoids timing-based username
    // enumeration ("invalid creds" took 5µs vs 50µs for valid email).
    if (constTimeEq(user, adminEmail) && constTimeEq(pass, adminPassword)) return true;
  } catch {
    // fall through
  }
  reply.code(401)
    .header('WWW-Authenticate', 'Basic realm="Robot Claude Admin"')
    .send('Bad credentials');
  return false;
}

function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  // Two-line: date on top, time below — keeps the column narrow without
  // breaking the date mid-hyphen on mobile. Each line is `nowrap`.
  return (
    `<span class="dt-date">${d.toISOString().slice(0, 10)}</span>` +
    `<span class="dt-time">${d.toISOString().slice(11, 19)}</span>`
  );
}


/** Access cell — what the operator wants to see at a glance: is this
 *  user on a TRIAL, on a paid ACTIVE plan, expired, cancelled, or has
 *  COMP (permanent free access), and how many days remain. Replaces the
 *  «last activity» column. */
function accessCell(sub: SubscriptionRow | undefined): string {
  if (!sub) {
    return `<span class="acc-cell-empty">— нет подписки</span>`;
  }
  if (sub.plan === 'comp') {
    return `<span class="acc-cell-vip">🎖 Спецдоступ · бессрочно</span>`;
  }
  if (sub.status === 'cancelled') {
    return `<span class="acc-cell-bad">⏹ отменён</span>`;
  }
  const ms = sub.access_until - Date.now();
  const days = Math.ceil(ms / 86_400_000);
  if (sub.status === 'expired' || days < 0) {
    return (
      `<span class="acc-cell-bad">✗ истёк</span>` +
      `<span class="acc-cell-sub">${days < 0 ? `${Math.abs(days)} дн назад` : 'сегодня'}</span>`
    );
  }
  const isTrial = sub.status === 'trial';
  const label = isTrial ? '🎁 Триал' : '✓ Активна';
  const cls = isTrial ? 'acc-cell-trial' : 'acc-cell-active';
  const daysCls = days === 0 ? 'acc-cell-warn'
                : days <= 3 ? 'acc-cell-warn'
                : 'acc-cell-ok';
  const daysStr = days === 0 ? 'истекает сегодня' : `${days} дн осталось`;
  return `<span class="${cls}">${label}</span><span class="acc-cell-sub ${daysCls}">${daysStr}</span>`;
}

/** Bulk-fetch subscriptions for a list of user_ids in one query so the
 *  admin table doesn't N+1 across N rows. */
const adminListSubsStmt = db.prepare<[], SubscriptionRow>(
  `SELECT * FROM user_subscriptions`,
);

/** Bulk-fetch API key status (one row per user_id) — non-revoked,
 *  verified keys count as «connected». */
const adminListKeysStmt = db.prepare<[], { user_id: number; verified: number | null; revoked: number | null }>(
  `SELECT user_id, last_verified_at AS verified, revoked_at AS revoked
     FROM user_api_keys
    WHERE exchange = 'bybit'`,
);

/** Count of enabled strategies per user — small table, single GROUP-BY scan. */
const adminListStrategyCountsStmt = db.prepare<[], { user_id: number; n: number }>(
  `SELECT user_id, COUNT(*) AS n
     FROM user_strategies
    WHERE enabled = 1
    GROUP BY user_id`,
);

/** Visible name of the tier the user is on. Comp-status (the «free
 *  access forever» billing flag, plan='comp') is NOT shown here — the
 *  Доступ column already says «🎖 Спецдоступ · бессрочно» when
 *  applicable, no need to duplicate. */
function tierBadge(tierId: TierId | null): string {
  if (!tierId) {
    return `<span class="plan-badge plan-bad">— нет тарифа</span>`;
  }
  const tier = TIER_CONFIGS[tierId];
  const emoji =
    tierId === 'starter'  ? '🥉'
    : tierId === 'standard' ? '🥈'
    : tierId === 'plus'   ? '🥇'
    : tierId === 'pro'    ? '🏆'
    : tierId === 'vip'    ? '👑'
    : tierId === 'prof'   ? '💼'
    : '•';
  return `<span class="plan-badge tier-badge tier-badge-${tierId}" title="Тариф: ${escapeHtml(tier.name)}">${emoji} ${escapeHtml(tier.name)}</span>`;
}

function renderDashboard(csrfToken: string, query: Record<string, string | undefined> = {}): string {
  const stats = getRegistrationStats();
  const rows = listRegistrations(500);
  const subs = new Map<number, SubscriptionRow>();
  for (const s of adminListSubsStmt.all()) subs.set(s.user_id, s);
  // Indicates "the user has reached the «autotrading active» stage"
  // (key + at least one strategy enabled). These are real adoption
  // signals to track separately from raw registration.
  const keys = new Map<number, { verified: number | null; revoked: number | null }>();
  for (const k of adminListKeysStmt.all()) keys.set(k.user_id, { verified: k.verified, revoked: k.revoked });
  const stratCounts = new Map<number, number>();
  for (const r of adminListStrategyCountsStmt.all()) stratCounts.set(r.user_id, r.n);

  // Aggregate funnel counters for the top dashboard. Computed off the
  // already-loaded rows so no extra queries.
  let cKey = 0;
  let cStrats = 0;
  let cFullActive = 0; // key + strategies + active sub
  const now = Date.now();
  for (const r of rows) {
    const k = keys.get(r.id);
    const hasKey = !!k && k.revoked === null && k.verified !== null;
    const stratN = stratCounts.get(r.id) ?? 0;
    const sub = subs.get(r.id);
    const hasAccess = !!sub && (sub.plan === 'comp' || (sub.access_until > now && (sub.status === 'trial' || sub.status === 'active')));
    if (hasKey) cKey++;
    if (stratN > 0) cStrats++;
    if (hasKey && stratN > 0 && hasAccess) cFullActive++;
  }

  const tableRows = rows.length === 0
    ? `<tr><td colspan="7" style="text-align:center;color:var(--text-faint);padding:24px">Регистраций пока нет</td></tr>`
    : rows
        .map((r: RegistrationListRow) => {
          const phone = r.phone ?? '—';
          const name = r.display_name ?? '—';
          const sub = subs.get(r.id);
          const plan = sub?.plan ?? 'standard';
          // План column — tier name ONLY. Comp-status («бессрочный
          // бесплатный доступ») is already conveyed by «🎖 Спецдоступ ·
          // бессрочно» in the «Доступ» column, no need to dup it here.
          // `plan` itself is still needed below for the «Продлить»
          // button visibility (hidden for comp — already permanent).
          const tier = (sub?.tier_id as TierId | null | undefined) ?? null;
          const badge = sub
            ? tierBadge(tier)
            : '<span class="plan-badge plan-bad">— нет подписки</span>';

          // Autotrading-funnel signals at-a-glance:
          //   - API: green ✓ if connected + verified + not revoked, dash otherwise
          //   - Strategies: number of enabled rows, dash if zero
          const k = keys.get(r.id);
          const apiCell = !k
            ? `<span class="plan-badge plan-bad">— нет</span>`
            : k.revoked
              ? `<span class="plan-badge plan-bad">⏸ отозван</span>`
              : k.verified
                ? `<span class="plan-badge plan-active">✓ подключён</span>`
                : `<span class="plan-badge plan-trial">⚠ не верифиц.</span>`;
          // Combined «Назначить тариф + срок» form. One submit does
          // everything: reassigns tier, refreshes user_strategies, bumps
          // access_until. VIP is now a normal paid tier ($580/мес) — the
          // days dropdown applies to it like any other. Permanent free
          // access is a SEPARATE «Спецдоступ» toggle, see below.
          const csrfField = `<input type="hidden" name="_csrf" value="${csrfToken}">`;
          const currentTier = (sub?.tier_id as TierId | undefined) ?? 'standard';
          const tierOptionsHtml = TIER_ORDER.map((tid) => {
            const t = TIER_CONFIGS[tid];
            const label = `${t.name} ($${t.monthlyPriceUsd}/мес)`;
            return `<option value="${tid}"${tid === currentTier ? ' selected' : ''}>${escapeHtml(label)}</option>`;
          }).join('');
          const assignForm = `
            <form method="POST" action="/admin/users/${r.id}/assign-tier" style="display:inline"
                  onsubmit="return confirm('Назначить тариф для ${escapeHtml(name)}? Текущие настройки стратегий будут пересоздать.');">
              ${csrfField}
              <select name="tierId" class="adm-select" title="Тариф">${tierOptionsHtml}</select>
              <select name="days" class="adm-select" title="Срок действия">
                <option value="7">+7 дней</option>
                <option value="30" selected>+30 дней</option>
                <option value="60">+60 дней</option>
                <option value="90">+90 дней</option>
                <option value="180">+180 дней</option>
                <option value="365">+1 год</option>
              </select>
              <button class="adm-btn adm-btn-vip" type="submit">Назначить</button>
            </form>
          `;
          // «Продлить» — pure access_until bump WITHOUT re-running
          // assignTier. Crucial for Prof users so their custom notional /
          // leverage / sl_pct_override survives a renewal. Hidden for comp
          // (Спецдоступ) because their access is already permanent.
          const extendOnlyForm = plan === 'comp'
            ? ''
            : `<form method="POST" action="/admin/users/${r.id}/extend" style="display:inline; margin-left:4px"
                     onsubmit="return confirm('Продлить срок без смены тарифа для ${escapeHtml(name)}?');">
                ${csrfField}
                <select name="days" class="adm-select" title="На сколько продлить">
                  <option value="7">+7 дней</option>
                  <option value="30" selected>+30 дней</option>
                  <option value="60">+60 дней</option>
                  <option value="90">+90 дней</option>
                  <option value="180">+180 дней</option>
                  <option value="365">+1 год</option>
                </select>
                <button class="adm-btn adm-btn-secondary" type="submit" title="Продлить срок без смены тарифа">⏱ Продлить</button>
              </form>`;
          // Спецдоступ (comp) — permanent free access, INDEPENDENT of tier.
          // Toggling it on sets plan='comp' (access far-future); toggling
          // off reverts plan='standard' (access governed by access_until).
          // The tier itself is untouched — a comp user can sit on any tier.
          const compForm = plan === 'comp'
            ? `<form method="POST" action="/admin/users/${r.id}/comp" style="display:inline; margin-left:4px"
                     onsubmit="return confirm('Снять Спецдоступ (бессрочный бесплатный доступ) у ${escapeHtml(name)}? Доступ станет платным по тарифу.');">
                ${csrfField}
                <input type="hidden" name="grant" value="0">
                <button class="adm-btn adm-btn-secondary" type="submit" title="Снять бессрочный бесплатный доступ">🎖 Снять спецдоступ</button>
              </form>`
            : `<form method="POST" action="/admin/users/${r.id}/comp" style="display:inline; margin-left:4px"
                     onsubmit="return confirm('Выдать Спецдоступ (бессрочный бесплатный доступ) для ${escapeHtml(name)}?');">
                ${csrfField}
                <input type="hidden" name="grant" value="1">
                <button class="adm-btn adm-btn-vip" type="submit" title="Выдать бессрочный бесплатный доступ">🎖 Спецдоступ</button>
              </form>`;
          // Hard-delete — wipes user_tier_history → user_strategies →
          // user_api_keys → user_subscriptions → decisions →
          // verification_attempts → registrations, after best-effort
          // closing any open Bybit positions. Triple-typed confirm so
          // an accidental click can't nuke a real account.
          // Доступ к закрытому разделу /predict — отдельный гейт (не подписка).
          const predictForm = r.predict_access
            ? `<form method="POST" action="/admin/users/${r.id}/predict-access" style="display:inline; margin-left:4px"
                     onsubmit="return confirm('Снять доступ к разделу /predict у ${escapeHtml(name)}?');">
                ${csrfField}
                <input type="hidden" name="grant" value="0">
                <button class="adm-btn adm-btn-secondary" type="submit" title="Снять доступ к разделу /predict">📈 Снять /predict</button>
              </form>`
            : `<form method="POST" action="/admin/users/${r.id}/predict-access" style="display:inline; margin-left:4px"
                     onsubmit="return confirm('Выдать доступ к разделу /predict для ${escapeHtml(name)}?');">
                ${csrfField}
                <input type="hidden" name="grant" value="1">
                <button class="adm-btn adm-btn-vip" type="submit" title="Выдать доступ к закрытому разделу /predict">📈 Доступ /predict</button>
              </form>`;
          const deleteForm =
            `<form method="POST" action="/admin/users/${r.id}/delete" style="display:inline; margin-left:4px"
                   onsubmit="var ans = prompt('УДАЛИТЬ пользователя ${escapeHtml(name)} (${escapeHtml(phone)}) безвозвратно?\\n\\nЭто закроет открытые позиции на Bybit и сотрёт ВСЕ его данные: ключи, подписку, стратегии, историю сделок.\\n\\nВведите УДАЛИТЬ заглавными чтобы подтвердить:'); return ans === 'УДАЛИТЬ';">
                ${csrfField}
                <button class="adm-btn adm-btn-danger" type="submit" title="Удалить пользователя и все его данные">🗑 Удалить</button>
              </form>`;
          const toggle = `<div class="adm-actions">${assignForm}${extendOnlyForm}${compForm}${predictForm}${deleteForm}</div>`;
          return `
            <tr>
              <td class="dt">${fmtDateTime(r.created_at)}</td>
              <td>${escapeHtml(name)} <span class="adm-uid" title="user_id (используется во всех TG-алертах и логах)">#${r.id}</span></td>
              <td class="mono">${escapeHtml(phone)}</td>
              <td>${badge}</td>
              <td>${apiCell}</td>
              <td class="acc-cell">${accessCell(sub)}</td>
              <td>${toggle}</td>
            </tr>`;
        })
        .join('');

  // Emergency-stop result banner — shown after a successful POST to
  // /admin/emergency-stop or /admin/resume-all-trading.
  const emergencyBanner = (() => {
    const q = query;
    if (q.emergency === 'stopped') {
      return `
        <div class="adm-emergency-banner adm-emergency-stopped">
          🚨 <b>EMERGENCY STOP применён.</b>
          Поставлено на паузу: <b>${escapeHtml(q.paused ?? '0')}</b>.
          Позиций закрыто: <b>${escapeHtml(q.closed ?? '0')}</b>${q.failed && q.failed !== '0' ? `, не удалось закрыть: <b>${escapeHtml(q.failed)}</b>` : ''}.
        </div>
      `;
    }
    if (q.emergency === 'resumed') {
      return `
        <div class="adm-emergency-banner adm-emergency-resumed">
          ▶️ <b>Торговля возобновлена.</b>
          Снято с паузы пользователей: <b>${escapeHtml(q.count ?? '0')}</b>.
        </div>
      `;
    }
    return '';
  })();

  // Big red panic panel + recover panel. Visible at the very top so
  // the operator can hit it without scrolling. Triple confirm + typed
  // phrase before either fires — no accidental clicks.
  const adminEmailForBtn = process.env.ADMIN_EMAIL ?? 'admin';
  const csrfFieldTop = `<input type="hidden" name="_csrf" value="${adminCsrfToken(adminEmailForBtn)}">`;
  const emergencyPanel = `
    <div class="adm-emergency-panel">
      <div class="adm-emergency-headline">
        <span class="adm-emergency-icon">🚨</span>
        <div>
          <div class="adm-emergency-title">Экстренная остановка</div>
          <div class="adm-emergency-sub">
            Поставит на паузу всех активных юзеров и попытается закрыть
            все открытые позиции на их Bybit-аккаунтах. Используется при
            ЧП — баге кода, дикой волатильности, проблемах с Bybit.
          </div>
        </div>
      </div>
      <div class="adm-emergency-actions">
        <form method="POST" action="/admin/emergency-stop" style="display:inline"
              onsubmit="var a=prompt('ЭКСТРЕННАЯ ОСТАНОВКА?\\n\\nЭто:\\n• Поставит на паузу ВСЕХ активных юзеров (новые сделки не пойдут)\\n• Попытается закрыть ВСЕ открытые позиции на Bybit (best-effort, market-reduce-only)\\n\\nНельзя отменить автоматически — открытые позиции будут закрыты.\\n\\nВведите СТОП заглавными чтобы подтвердить:'); return a === 'СТОП';">
          ${csrfFieldTop}
          <button class="adm-emergency-btn adm-emergency-btn-stop" type="submit">
            🚨 ОСТАНОВИТЬ ВСЁ
          </button>
        </form>
        <form method="POST" action="/admin/resume-all-trading" style="display:inline"
              onsubmit="return confirm('Возобновить торговлю для ВСЕХ пользователей? Это снимет паузу также и с тех, кто поставил её сам.');">
          ${csrfFieldTop}
          <button class="adm-emergency-btn adm-emergency-btn-resume" type="submit">
            ▶ Возобновить всем
          </button>
        </form>
      </div>
    </div>
  `;

  const body = `
    <div class="header">
      <span class="strat-code">ADMIN</span>
      <h1 class="title">Регистрации</h1>
      <p class="subtitle">Статистика подключений через Telegram Gateway</p>
    </div>

    ${emergencyBanner}
    ${emergencyPanel}

    <div class="portfolio-dashboard">
      <div class="dash-card">
        <div class="dash-label">Всего регистраций</div>
        <div class="dash-value">${stats.total}</div>
        <div class="dash-sub">+${stats.last24h} за 24ч · +${stats.last7d} за 7д</div>
      </div>
      <div class="dash-card">
        <div class="dash-label">Подключили API</div>
        <div class="dash-value">${cKey}</div>
        <div class="dash-sub">из ${stats.total} (${stats.total > 0 ? Math.round((cKey / stats.total) * 100) : 0}%)</div>
      </div>
      <div class="dash-card">
        <div class="dash-label">Выбрали стратегии</div>
        <div class="dash-value">${cStrats}</div>
        <div class="dash-sub">из ${stats.total} (${stats.total > 0 ? Math.round((cStrats / stats.total) * 100) : 0}%)</div>
      </div>
      <div class="dash-card">
        <div class="dash-label">Автотрейдинг живёт</div>
        <div class="dash-value">${cFullActive}</div>
        <div class="dash-sub">подписка + ключ + ≥1 стратегия</div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">
        Все регистрации (${rows.length})
        <a href="/admin/tiers" style="float:right;font-size:12px;text-transform:none;color:#4ad991;text-decoration:none">📊 Tier-статистика →</a>
      </div>
      <div class="card adm-table-wrap">
        <div class="adm-scroll-hint">прокрутите таблицу вправо →</div>
        <table class="adm-users-table">
          <thead>
            <tr>
              <th>Дата (UTC)</th>
              <th>Имя</th>
              <th>Телефон</th>
              <th>План</th>
              <th>API Bybit</th>
              <th>Доступ</th>
              <th>Действия</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    </div>

    <style>
      .plan-badge {
        display: inline-block;
        padding: 3px 8px;
        border-radius: 6px;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.02em;
        white-space: nowrap;
      }
      .plan-vip { background: rgba(212, 175, 55, 0.15); color: #f3d266; border: 1px solid rgba(212, 175, 55, 0.5); }
      .plan-trial { background: rgba(74, 217, 145, 0.10); color: #4ad991; border: 1px solid rgba(74, 217, 145, 0.4); }
      .plan-active { background: rgba(74, 217, 145, 0.10); color: #4ad991; border: 1px solid rgba(74, 217, 145, 0.4); }
      .plan-bad { background: rgba(255, 99, 99, 0.10); color: #ff8b8b; border: 1px solid rgba(255, 99, 99, 0.4); }
      /* Tier badges in the «План» column — one colour per tier so the
         operator can scan distribution at a glance. */
      .tier-badge { font-weight: 600; }
      .tier-badge-starter  { background: rgba(160,160,160,0.12); color: #cfd6dd; border: 1px solid rgba(160,160,160,0.40); }
      .tier-badge-standard { background: rgba(116,170,255,0.14); color: #9bc1ff; border: 1px solid rgba(116,170,255,0.45); }
      .tier-badge-plus     { background: rgba(74,217,145,0.14);  color: #5ce0a0; border: 1px solid rgba(74,217,145,0.45); }
      .tier-badge-pro      { background: rgba(255,193,107,0.14); color: #ffc16b; border: 1px solid rgba(255,193,107,0.50); }
      .tier-badge-vip      { background: rgba(212,175,55,0.16);  color: #f3d266; border: 1px solid rgba(212,175,55,0.55); }
      .tier-badge-prof     { background: rgba(180,120,255,0.14); color: #c599ff; border: 1px solid rgba(180,120,255,0.50); }
      /* user_id chip — small mono badge next to the user's display
         name. Same id that appears in every TG alert + log line, so the
         operator can match a notification to a row in one glance. */
      .adm-uid {
        display: inline-block;
        margin-left: 6px;
        padding: 1px 6px;
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 4px;
        font-family: 'SF Mono', 'Menlo', monospace;
        font-size: 10.5px;
        color: var(--text-faint);
        font-weight: 600;
        vertical-align: middle;
      }
      .adm-btn {
        background: #1a2129;
        border: 1px solid #2a323d;
        color: #cfd6dd;
        padding: 5px 10px;
        border-radius: 6px;
        font-size: 12px;
        cursor: pointer;
        font-family: inherit;
      }
      .adm-btn:hover { border-color: #4ad991; color: #fff; }
      .adm-btn-vip { border-color: rgba(212, 175, 55, 0.5); color: #f3d266; }
      .adm-btn-vip:hover { background: rgba(212, 175, 55, 0.12); }
      .adm-btn-warn { border-color: rgba(255, 188, 70, 0.5); color: #ffbc46; }
      .adm-btn-warn:hover { background: rgba(255, 188, 70, 0.10); }
      .adm-btn-secondary { border-color: #2a323d; color: #cfd6dd; }
      .adm-btn-secondary:hover { border-color: #4ad991; color: #fff; }
      .adm-btn-danger { border-color: rgba(255, 99, 99, 0.5); color: #ff8b8b; }
      .adm-btn-danger:hover { background: rgba(255, 99, 99, 0.10); }
      /* Emergency panic panel — top of /admin. Big red, hard to miss. */
      .adm-emergency-panel {
        margin: 0 0 20px;
        padding: 16px 18px;
        background: linear-gradient(135deg, rgba(255,99,99,0.12), rgba(255,99,99,0.04));
        border: 1px solid rgba(255,99,99,0.45);
        border-radius: 10px;
        display: flex; flex-direction: column; gap: 14px;
      }
      .adm-emergency-headline {
        display: flex; gap: 14px; align-items: flex-start;
      }
      .adm-emergency-icon { font-size: 28px; line-height: 1; }
      .adm-emergency-title {
        color: #ff8b8b; font-weight: 700; font-size: 16px;
        margin-bottom: 4px; letter-spacing: 0.02em;
      }
      .adm-emergency-sub {
        color: #cfd6dd; font-size: 12.5px; line-height: 1.5;
      }
      .adm-emergency-actions { display: flex; gap: 10px; flex-wrap: wrap; }
      .adm-emergency-btn {
        font-family: inherit; cursor: pointer;
        padding: 10px 16px; border-radius: 8px; font-size: 13px;
        font-weight: 600; letter-spacing: 0.02em;
      }
      .adm-emergency-btn-stop {
        background: #c43d3d; color: #fff;
        border: 1px solid #ff8b8b;
      }
      .adm-emergency-btn-stop:hover { background: #d44848; }
      .adm-emergency-btn-resume {
        background: transparent; color: #cfd6dd;
        border: 1px solid #2a323d;
      }
      .adm-emergency-btn-resume:hover {
        border-color: #4ad991; color: #fff;
      }
      .adm-emergency-banner {
        margin: 0 0 16px; padding: 12px 14px;
        border-radius: 8px; font-size: 13px; line-height: 1.5;
      }
      .adm-emergency-stopped {
        background: rgba(255,99,99,0.12);
        border: 1px solid rgba(255,99,99,0.45);
        color: #ff8b8b;
      }
      .adm-emergency-stopped b { color: #fff; }
      .adm-emergency-resumed {
        background: rgba(74,217,145,0.10);
        border: 1px solid rgba(74,217,145,0.45);
        color: #4ad991;
      }
      .adm-emergency-resumed b { color: #fff; }
      /* Date cell — date over time, both nowrap, monospace, tidy. */
      td.dt { white-space: nowrap; line-height: 1.35; }
      td.dt .dt-date { display: block; }
      td.dt .dt-time { display: block; color: #8590a0; font-size: 11.5px; }
      /* Access cell — replaces «last activity». Two-line: kind on top
         («Триал»/«Активна»/«Спецдоступ»/«истёк»), days-left below. */
      td.acc-cell { white-space: nowrap; line-height: 1.35; }
      td.acc-cell > span { display: block; }
      .acc-cell-trial  { color: #88e1b4; font-weight: 600; }
      .acc-cell-active { color: #4ad991; font-weight: 600; }
      .acc-cell-vip    { color: #f3d266; font-weight: 600; }
      .acc-cell-bad    { color: #ff8b8b; font-weight: 600; }
      .acc-cell-empty  { color: #8590a0; font-style: italic; }
      .acc-cell-sub    { color: #8590a0; font-size: 11.5px; }
      .acc-cell-sub.acc-cell-warn { color: #ffbc46; }
      .acc-cell-sub.acc-cell-ok   { color: #8590a0; }
      .adm-table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
      .adm-users-table { min-width: 840px; }
      .adm-scroll-hint { display: none; font-size: 12px; color: #8590a0; padding: 0 0 8px; }
      @media (max-width: 900px) {
        .adm-scroll-hint { display: block; }
        .adm-users-table th:first-child,
        .adm-users-table td:first-child {
          position: sticky; left: 0; z-index: 2;
          background: #11161d;
          box-shadow: 2px 0 4px rgba(0,0,0,0.4);
        }
        .adm-users-table th:first-child { background: #161d27; }
      }
      .adm-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
      .adm-select {
        background: #0b0e13; color: #cfd6dd; border: 1px solid #2a323d;
        border-radius: 6px; padding: 5px 8px; font-size: 12px; font-family: inherit;
      }
      .plan-days { display: block; font-size: 11px; margin-top: 4px; }
      .plan-days-ok { color: #4ad991; }
      .plan-days-warn { color: #ffbc46; }
      .plan-days-bad { color: #ff8b8b; }
      td.ua { font-size: 11px; color: var(--text-faint); max-width: 240px;
              overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    </style>
  `;
  return pageShell('Admin — Регистрации', body, { robots: 'noindex, nofollow' });
}

// Спецдоступ (comp) toggle form. grant='1' → permanent free access
// (plan='comp'); grant='0' → revert to paid (plan='standard'). This is
// independent of the user's tier — a comp user can sit on any tier.
const compFormSchema = z.object({
  grant: z.enum(['0', '1']),
});

export async function adminRoute(app: FastifyInstance): Promise<void> {
  // Audit H-NEW-3 — rate-limit on each /admin/* route.
  // Basic-Auth secret is constant-time compared, but without throttle
  // an attacker can brute-force ADMIN_PASSWORD at 100s of req/sec
  // over HTTPS. 20/min per IP is enough headroom for a real operator
  // (refresh + a few form posts) and slow enough to make brute-force
  // useless: a 16-char alphanumeric needs ~10^28 tries.
  const adminRateLimit = { max: 20, timeWindow: '1 minute' };

  app.get('/admin', { config: { rateLimit: adminRateLimit } }, async (req, reply) => {
    if (!checkAuth(req, reply)) return;
    reply.type('text/html; charset=utf-8');
    reply.header('Cache-Control', 'private, no-store');
    const adminEmail = process.env.ADMIN_EMAIL ?? 'admin';
    return renderDashboard(adminCsrfToken(adminEmail), (req.query ?? {}) as Record<string, string | undefined>);
  });

  // ---------------- GET /admin/tiers (TRACK E Phase B) ----------------
  // Tier distribution, MRR, recent transitions. Read-only stats page.
  app.get('/admin/tiers', { config: { rateLimit: adminRateLimit } }, async (req, reply) => {
    if (!checkAuth(req, reply)) return;
    reply.type('text/html; charset=utf-8');
    reply.header('Cache-Control', 'private, no-store');
    // Parse from/to date range (YYYY-MM-DD). Defaults to last 30 days.
    const q = (req.query ?? {}) as { from?: string; to?: string };
    const parseDate = (s: string | undefined, fallback: number): number => {
      if (!s) return fallback;
      const ms = Date.parse(s + 'T00:00:00Z');
      return Number.isFinite(ms) ? ms : fallback;
    };
    const now = Date.now();
    const defaultFrom = now - 30 * 86_400_000;
    let fromMs = parseDate(q.from, defaultFrom);
    // «to» is inclusive of the whole day → push to end-of-day.
    let toMs = parseDate(q.to, now);
    toMs = Math.min(now, toMs + 86_400_000 - 1); // end of selected day, capped at now
    if (fromMs > toMs) [fromMs, toMs] = [toMs - 30 * 86_400_000, toMs];
    return renderTiersDashboard(fromMs, toMs);
  });

  // ---------------- POST /admin/users/:id/comp ----------------
  // Grant or revoke «Спецдоступ» — permanent free access (plan='comp'),
  // INDEPENDENT of the user's tier. grant='1' sets plan='comp'; grant='0'
  // reverts to plan='standard' (access then governed by access_until).
  // Form-encoded body; redirects back to /admin so the table refreshes.
  app.post('/admin/users/:id/comp', { config: { rateLimit: adminRateLimit } }, async (req, reply) => {
    if (!checkAuth(req, reply)) return;
    const adminEmailForCsrf = process.env.ADMIN_EMAIL ?? 'admin';
    if (!requireAdminCsrf(req, reply, adminEmailForCsrf)) return;
    const userId = Number((req.params as { id?: string }).id);
    if (!Number.isFinite(userId) || userId <= 0) {
      reply.code(400).send('bad user id');
      return;
    }
    // @fastify/formbody parses both JSON and x-www-form-urlencoded into
    // a plain object on req.body — same shape for both content types.
    const parsed = compFormSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send('grant field required (0|1)');
      return;
    }
    const plan = parsed.data.grant === '1' ? 'comp' : 'standard';

    // Ensure a subscription row exists (handles the edge case where an
    // admin grants comp to a user that registered before Track D shipped
    // and never went through /auth/verify since the auto-create landed).
    if (!findSubscription(userId)) ensureTrialFor(userId);

    const adminEmail = process.env.ADMIN_EMAIL ?? 'admin';
    const before = findSubscription(userId);
    try {
      const after = setPlan(userId, plan, adminEmail, `comp ${parsed.data.grant === '1' ? 'granted' : 'revoked'} via /admin at ${new Date().toISOString()}`);
      recordAdminAction({
        adminEmail,
        targetUserId: userId,
        action: 'set_plan',
        before: before ? { plan: before.plan, status: before.status, access_until: before.access_until } : null,
        after: { plan: after.plan, status: after.status, access_until: after.access_until },
        note: parsed.data.grant === '1' ? 'grant comp' : 'revoke comp',
        ip: req.ip,
      });
      logger.info({ user_id: userId, plan, by: adminEmail }, 'admin: comp toggled');
    } catch (err) {
      logger.error({ err, user_id: userId }, 'admin: comp toggle failed');
      reply.code(500).send('failed to update access');
      return;
    }
    reply.code(303).header('location', '/admin').send();
  });

  // ---------------- POST /admin/users/:id/predict-access ----------------
  // Выдать/снять доступ к закрытому разделу /predict. Отдельный гейт от
  // подписки на автоторговлю. «Доступ только через поддержку» — вручную.
  app.post('/admin/users/:id/predict-access', { config: { rateLimit: adminRateLimit } }, async (req, reply) => {
    if (!checkAuth(req, reply)) return;
    const adminEmailForCsrf = process.env.ADMIN_EMAIL ?? 'admin';
    if (!requireAdminCsrf(req, reply, adminEmailForCsrf)) return;
    const userId = Number((req.params as { id?: string }).id);
    if (!Number.isFinite(userId) || userId <= 0) {
      reply.code(400).send('bad user id');
      return;
    }
    const parsed = compFormSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send('grant field required (0|1)');
      return;
    }
    const grant = parsed.data.grant === '1';
    const adminEmail = process.env.ADMIN_EMAIL ?? 'admin';
    try {
      setPredictAccess(userId, grant);
      recordAdminAction({
        adminEmail,
        targetUserId: userId,
        action: 'set_predict_access',
        before: null,
        after: { predict_access: grant ? 1 : 0 },
        note: grant ? 'grant /predict access' : 'revoke /predict access',
        ip: req.ip,
      });
      logger.info({ user_id: userId, grant, by: adminEmail }, 'admin: predict-access toggled');
    } catch (err) {
      logger.error({ err, user_id: userId }, 'admin: predict-access toggle failed');
      reply.code(500).send('failed to update predict access');
      return;
    }
    reply.code(303).header('location', '/admin').send();
  });

  // ---------------- POST /admin/users/:id/extend ----------------
  // Bump access_until forward by N days. Useful for manually onboarding
  // paying customers before automated billing is wired. Rejected for
  // comp (Спецдоступ) users — their access is already permanent.
  app.post('/admin/users/:id/extend', { config: { rateLimit: adminRateLimit } }, async (req, reply) => {
    if (!checkAuth(req, reply)) return;
    const adminEmailForCsrf = process.env.ADMIN_EMAIL ?? 'admin';
    if (!requireAdminCsrf(req, reply, adminEmailForCsrf)) return;
    const userId = Number((req.params as { id?: string }).id);
    if (!Number.isFinite(userId) || userId <= 0) {
      reply.code(400).send('bad user id');
      return;
    }
    const parsed = extendFormSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send('days field required (positive integer)');
      return;
    }
    const days = parsed.data.days;
    const existing = findSubscription(userId);
    if (!existing) {
      // Auto-create then extend — handles users that registered before
      // Track D shipped.
      ensureTrialFor(userId);
    } else if (existing.plan === 'comp') {
      reply.code(400).send('cannot extend Спецдоступ — already permanent');
      return;
    }
    const adminEmail = process.env.ADMIN_EMAIL ?? 'admin';
    const before = findSubscription(userId);
    try {
      const after = adminExtend(userId, days, adminEmail, `manual extend +${days}d via /admin`);
      recordAdminAction({
        adminEmail,
        targetUserId: userId,
        action: 'extend_subscription',
        before: before ? { access_until: before.access_until, status: before.status } : null,
        after: { access_until: after.access_until, status: after.status },
        note: `+${days} days`,
        ip: req.ip,
      });
      logger.info({ user_id: userId, days, by: adminEmail }, 'admin: subscription extended');
    } catch (err) {
      logger.error({ err, user_id: userId }, 'admin: extend failed');
      reply.code(500).send('failed to extend subscription');
      return;
    }
    reply.code(303).header('location', '/admin').send();
  });


  // ---------------- POST /admin/users/:id/assign-tier ----------------
  // Atomic «assign tier + set period» from the admin row form.
  //
  // Body: tierId in TIER_ORDER, days in [1, 3650].
  //
  // VIP is now a NORMAL paid tier ($580/мес) — handled like any other.
  // Permanent free access is the SEPARATE «Спецдоступ» (comp) toggle and
  // is NOT touched here, so a comp user keeps free access across tier
  // changes.
  //
  // Sequence:
  //   1. Ensure a subscription exists (auto-create trial if needed).
  //   2. assignTier() refreshes user_strategies with the new tier's
  //      defaults (CAVEAT for Prof users — see UI confirm).
  //   3. Unless the user is on comp (permanent), bump access_until by N
  //      days via adminExtend.
  //   4. Audit log entry + admin_audit_log row.
  app.post('/admin/users/:id/assign-tier', { config: { rateLimit: adminRateLimit } }, async (req, reply) => {
    if (!checkAuth(req, reply)) return;
    const adminEmailForCsrf = process.env.ADMIN_EMAIL ?? 'admin';
    if (!requireAdminCsrf(req, reply, adminEmailForCsrf)) return;
    const userId = Number((req.params as { id?: string }).id);
    if (!Number.isFinite(userId) || userId <= 0) {
      reply.code(400).send('bad user id');
      return;
    }
    const parsed = assignTierFormSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send('invalid tierId or days');
      return;
    }
    const { tierId, days } = parsed.data;
    const adminEmail = process.env.ADMIN_EMAIL ?? 'admin';

    // Ensure sub exists (legacy users registered pre-trial fix or wiped).
    if (!findSubscription(userId)) ensureTrialFor(userId);
    const before = findSubscription(userId);

    try {
      await assignTier(userId, tierId, { reason: 'operator_override' });
      // comp users have permanent access — don't touch access_until.
      // Everyone else (including VIP, now a normal paid tier) gets +N days.
      if (before?.plan !== 'comp') {
        adminExtend(userId, days, adminEmail, `assigned tier=${tierId} +${days}d via /admin`);
      }
      const after = findSubscription(userId);
      recordAdminAction({
        adminEmail,
        targetUserId: userId,
        action: 'assign_tier',
        before: before
          ? { plan: before.plan, status: before.status, tier_id: before.tier_id, access_until: before.access_until }
          : null,
        after: after
          ? { plan: after.plan, status: after.status, tier_id: after.tier_id, access_until: after.access_until }
          : null,
        note: `tierId=${tierId} days=${before?.plan === 'comp' ? 'permanent (comp)' : days}`,
        ip: req.ip,
      });
      logger.info(
        { user_id: userId, tierId, days, by: adminEmail },
        'admin: tier assigned',
      );
    } catch (err) {
      logger.error({ err, user_id: userId, tierId }, 'admin: assign-tier failed');
      reply.code(500).send('failed to assign tier');
      return;
    }
    reply.code(303).header('location', '/admin').send();
  });

  // ---------------- POST /admin/users/:id/delete ----------------
  // Hard-delete the user. Cascades through user_tier_history →
  // user_strategies → user_api_keys → user_subscriptions → decisions
  // → verification_attempts → registrations after best-effort closing
  // any open Bybit positions. Same code-path as scripts/delete-user.ts.
  app.post('/admin/users/:id/delete', { config: { rateLimit: adminRateLimit } }, async (req, reply) => {
    if (!checkAuth(req, reply)) return;
    const adminEmailForCsrf = process.env.ADMIN_EMAIL ?? 'admin';
    if (!requireAdminCsrf(req, reply, adminEmailForCsrf)) return;
    const userId = Number((req.params as { id?: string }).id);
    if (!Number.isFinite(userId) || userId <= 0) {
      reply.code(400).send('bad user id');
      return;
    }
    const adminEmail = process.env.ADMIN_EMAIL ?? 'admin';
    const beforeSub = findSubscription(userId);
    try {
      const { deleteUserCascade } = await import('./delete-user.js');
      const result = await deleteUserCascade(userId);
      if (!result.deleted) {
        // 404 isn't quite right (the route worked) — render a 303 back
        // to /admin where the table will already not show the user.
        logger.info({ user_id: userId, by: adminEmail }, 'admin: delete: target not found');
        reply.code(303).header('location', '/admin').send();
        return;
      }
      // targetUserId MUST be null here — admin_audit_log.target_user_id
      // has a FK to registrations(id) and the row we just deleted is
      // gone. We keep the deleted user_id inside the note so support can
      // still grep by id; before/after fields are populated as usual.
      recordAdminAction({
        adminEmail,
        targetUserId: null,
        action: 'delete_user',
        before: beforeSub
          ? { status: beforeSub.status, plan: beforeSub.plan, tier_id: beforeSub.tier_id, access_until: beforeSub.access_until }
          : null,
        after: null,
        note: `deleted user_id=${userId} phone=${result.phone} positions_closed=${result.positionsClosed?.succeeded ?? 0}/${result.positionsClosed?.attempted ?? 0}` +
              (result.positionsCloseError ? ` close_error=${result.positionsCloseError}` : '') +
              ` rows=${JSON.stringify(result.summary)}`,
        ip: req.ip,
      });
      logger.info(
        { user_id: userId, by: adminEmail, summary: result.summary, positionsCloseError: result.positionsCloseError },
        'admin: user deleted',
      );
    } catch (err) {
      logger.error({ err, user_id: userId }, 'admin: delete failed');
      reply.code(500).send('failed to delete user');
      return;
    }
    reply.code(303).header('location', '/admin').send();
  });

  // ---------------- POST /admin/emergency-stop ----------------
  // 🚨 Panic button. For each currently-trading user (status in
  // trial/active, not paused, access_until in the future):
  //   1. Set trading_paused_at = now → no new fan-out orders will fire
  //   2. Best-effort close every open position (closeAllUserPositions)
  // Returns 303 to /admin with a flash-style query param.
  //
  // After this fires, operator must hit «Возобновить всех» manually
  // OR each user can resume themselves from their cabinet.
  app.post('/admin/emergency-stop', { config: { rateLimit: adminRateLimit } }, async (req, reply) => {
    if (!checkAuth(req, reply)) return;
    const adminEmailForCsrf = process.env.ADMIN_EMAIL ?? 'admin';
    if (!requireAdminCsrf(req, reply, adminEmailForCsrf)) return;
    const adminEmail = process.env.ADMIN_EMAIL ?? 'admin';

    // 1. Snapshot active set before pausing — we close positions only
    //    for users who were actually trading.
    const activeUserIds = listTradingActiveUserIds();

    // 2. Bulk-pause everything in one UPDATE.
    const pausedCount = bulkPauseAllTrading();

    // 3. Close open positions for every previously-active user, in parallel.
    let attempted = 0;
    let succeeded = 0;
    let failed = 0;
    const failures: string[] = [];
    await Promise.allSettled(activeUserIds.map(async (uid) => {
      try {
        const res = await closeAllUserPositions(uid, 'strategy_exit');
        attempted += res.attempted;
        succeeded += res.succeeded;
        failed += res.failed;
        if (res.failed > 0) {
          failures.push(`user_id=${uid}: ${res.failedSymbols.join(', ')}`);
        }
      } catch (err) {
        failed++;
        failures.push(`user_id=${uid}: ${(err as Error).message}`);
        logger.error({ err, userId: uid }, 'emergency-stop: closeAllUserPositions threw');
      }
    }));

    recordAdminAction({
      adminEmail,
      targetUserId: null,
      action: 'emergency_stop',
      before: null,
      after: { paused_users: pausedCount, position_close_attempted: attempted, succeeded, failed },
      note: failures.length > 0 ? `failures: ${failures.slice(0, 5).join(' | ')}` : null,
      ip: req.ip,
    });

    logger.warn(
      { by: adminEmail, pausedCount, attempted, succeeded, failed },
      'admin: EMERGENCY STOP fired',
    );

    // Telegram alert — push to ops Logs channel.
    await sendMessage({
      channel: 'logs',
      text:
        `🚨 <b>EMERGENCY STOP</b> by <code>${escapeHtml(adminEmail)}</code>\n` +
        `Paused users: <b>${pausedCount}</b>\n` +
        `Positions: ${succeeded}✓ / ${failed}✗ (of ${attempted} attempted)` +
        (failures.length > 0 ? `\n⚠️ Failures: ${failures.slice(0, 3).join(' · ')}` : ''),
      disable_notification: false,
    }).catch((err) => logger.error({ err }, 'emergency-stop: telegram alert failed'));

    reply.code(303).header(
      'location',
      `/admin?emergency=stopped&paused=${pausedCount}&closed=${succeeded}&failed=${failed}`,
    ).send();
  });

  // ---------------- POST /admin/resume-all-trading ----------------
  // Undo the emergency stop — clear trading_paused_at for EVERYONE
  // (including users who paused themselves; that's the trade-off for
  // having a single bulk action). Open positions are NOT re-opened —
  // they were already closed by the emergency stop.
  app.post('/admin/resume-all-trading', { config: { rateLimit: adminRateLimit } }, async (req, reply) => {
    if (!checkAuth(req, reply)) return;
    const adminEmailForCsrf = process.env.ADMIN_EMAIL ?? 'admin';
    if (!requireAdminCsrf(req, reply, adminEmailForCsrf)) return;
    const adminEmail = process.env.ADMIN_EMAIL ?? 'admin';

    const resumedCount = bulkResumeAllTrading();

    recordAdminAction({
      adminEmail,
      targetUserId: null,
      action: 'resume_all_trading',
      before: null,
      after: { resumed_users: resumedCount },
      note: null,
      ip: req.ip,
    });

    logger.warn({ by: adminEmail, resumedCount }, 'admin: bulk resume-all fired');

    await sendMessage({
      channel: 'logs',
      text:
        `▶️ <b>Resume-all</b> by <code>${escapeHtml(adminEmail)}</code>\n` +
        `Resumed users: <b>${resumedCount}</b>`,
      disable_notification: false,
    }).catch((err) => logger.error({ err }, 'resume-all: telegram alert failed'));

    reply.code(303).header('location', `/admin?emergency=resumed&count=${resumedCount}`).send();
  });
}

const extendFormSchema = z.object({
  days: z.coerce.number().int().min(1).max(3650),
});

const assignTierFormSchema = z.object({
  tierId: z.enum(TIER_ORDER as [TierId, ...TierId[]]),
  days: z.coerce.number().int().min(1).max(3650).default(30),
});

/**
 * TRACK E Phase B — /admin/tiers stats dashboard.
 *
 * Shows operator: backtest forecast per tier, range-selectable live
 * results, recent transitions feed (last 30), and Спецдоступ (comp)
 * users with override. (The «tier distribution / MRR» table was removed
 * — not relevant while the user base is tiny.)
 *
 * Pure SQL read — no mutations, no CSRF needed.
 */

const vipOverrideListStmt = db.prepare<[], {
  user_id: number;
  display_name: string | null;
  phone: string | null;
  tier_override_strategies: string | null;
  tier_override_margin: number | null;
}>(`
  SELECT s.user_id, r.display_name, r.phone,
         s.tier_override_strategies, s.tier_override_margin
    FROM user_subscriptions s
    JOIN registrations r ON r.id = s.user_id
   WHERE s.plan = 'comp'
   ORDER BY s.user_id
`);

/**
 * Phase N — per-tier live PnL simulation for the operator dashboard.
 *
 * Replays the last `windowMs` worth of CLOSED shadow decisions
 * (`user_id IS NULL`) and computes what each tier WOULD HAVE earned by
 * sizing each trade at that tier's notional for the corresponding
 * strategy. Result is a row per tier with closed-trade count, win-rate
 * and gross USD PnL.
 *
 * Why shadow rather than real user_decisions: we want a stable view
 * that doesn't depend on which/how many users were subscribed at the
 * moment. At launch we have 1 Prof user — real user trades give a
 * misleading picture for the other 5 tiers (no data) while shadow
 * replay shows the actual signal-history performance at tier sizes.
 */
const shadowClosedRangeStmt = db.prepare<
  [number, number],
  { strategy_id: string; pnl_pct: number }
>(`
  SELECT strategy_id, pnl_pct
    FROM decisions
   WHERE user_id IS NULL
     AND strategy_id IS NOT NULL
     AND status = 'closed'
     AND closed_at IS NOT NULL
     AND pnl_pct IS NOT NULL
     AND closed_at >= ?
     AND closed_at <= ?
`);

/** Earliest CLOSED shadow decision's close timestamp. Used to label
 *  the «last 365 days» block honestly — at launch (system runs for
 *  weeks/months only), we show «since DD month YYYY» instead of the
 *  misleading «last 365 days». Returns null when no shadow trades
 *  have closed yet. */
const earliestClosedShadowStmt = db.prepare<[], { ts: number | null }>(`
  SELECT MIN(closed_at) AS ts
    FROM decisions
   WHERE user_id IS NULL
     AND strategy_id IS NOT NULL
     AND status = 'closed'
     AND closed_at IS NOT NULL
`);

type TierLiveStats = {
  tierId: TierId;
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number | null;   // null when trades=0
  grossUsd: number;            // sum of per-trade pnl_pct/100 × tier-notional
  /** grossUsd as % of tier.minBalanceUsdt — what a user with the
   *  minimum qualifying deposit would have earned over the 30-day
   *  window. Conservative: real users with bigger balances see a
   *  smaller percentage on the same dollar PnL. */
  pctOfMinDepoMonthly: number;
  /** Naive annualization of the monthly figure (× 12). Useful as a
   *  rule-of-thumb "X%/year" headline next to MRR. */
  pctOfMinDepoAnnual: number;
};

// Tiers shown in the live-stats table. Prof is EXCLUDED (operator
// request) — it's the manual-control tier with no fixed notional, so
// its shadow-replay PnL is meaningless for tier-comparison purposes.
const LIVE_STATS_TIERS = TIER_ORDER.filter((t) => t !== 'prof');

function computeTierLiveStats(fromMs: number, toMs: number): TierLiveStats[] {
  const rows = shadowClosedRangeStmt.all(fromMs, toMs);
  // Normalise to monthly/annual based on the ACTUAL selected range
  // length (not a fixed 30/365 window) so arbitrary date ranges produce
  // honest per-month / per-year extrapolations.
  const rangeDays = Math.max(1, (toMs - fromMs) / 86_400_000);

  return LIVE_STATS_TIERS.map((tierId) => {
    const tier = TIER_CONFIGS[tierId];
    let trades = 0;
    let wins = 0;
    let losses = 0;
    let grossUsd = 0;
    for (const row of rows) {
      if (!tier.strategyIds.includes(row.strategy_id)) continue;
      const size = computeTierTradeSize(tierId, row.strategy_id);
      if (!size) continue;
      trades++;
      if (row.pnl_pct > 0) wins++;
      else if (row.pnl_pct < 0) losses++;
      // Phase T — pnl_pct is gross; subtract the round-trip taker
      // commission on this tier's notional so the simulated tier PnL
      // matches what a real account would keep.
      grossUsd += ((row.pnl_pct - TRACK_C_COMMISSION_RT_PCT) / 100) * size.notionalUsd;
    }
    const grossRounded = Math.round(grossUsd * 100) / 100;
    const minDepo = tier.minBalanceUsdt;
    const rangePct = minDepo > 0 ? (grossRounded / minDepo) * 100 : 0;
    const monthlyPct = rangePct * 30 / rangeDays;
    const annualPct = rangePct * 365 / rangeDays;
    return {
      tierId,
      trades,
      wins,
      losses,
      winRatePct: trades === 0 ? null : (wins / trades) * 100,
      grossUsd: grossRounded,
      pctOfMinDepoMonthly: Math.round(monthlyPct * 100) / 100,
      pctOfMinDepoAnnual: Math.round(annualPct * 10) / 10,
    };
  });
}

/**
 * Backtest-based forecast per tier. For each strategy in the tier:
 *   - look up its STRATEGY_CONFIGS.backtest snapshot
 *   - scale netPnlUsd from backtest notional to tier notional
 *   - normalise to per-month (× 30 / periodDays) and per-year (× 365 / periodDays)
 *   - count trades / wins / losses scaled to the same per-month rate
 *
 * Returns the same shape as the live stats so the same table renderer
 * can show both side-by-side. `trades` / `wins` / `losses` are rounded
 * to whole numbers (we are not going to write "23.7 trades").
 */
type TierForecastStats = TierLiveStats;

function computeTierForecastStats(): TierForecastStats[] {
  return LIVE_STATS_TIERS.map((tierId) => {
    const tier = TIER_CONFIGS[tierId];
    let tradesPerMonth = 0;
    let winsPerMonth = 0;
    let lossesPerMonth = 0;
    let monthlyGrossUsd = 0;
    for (const sid of tier.strategyIds) {
      const strat = STRATEGY_CONFIGS[sid];
      const bt = strat?.backtest;
      if (!bt || bt.periodDays <= 0 || bt.notionalUsd <= 0) continue;
      const size = computeTierTradeSize(tierId, sid);
      if (!size) continue;
      const scale = size.notionalUsd / bt.notionalUsd;
      const monthlyFactor = 30 / bt.periodDays;
      tradesPerMonth += bt.totalTrades * monthlyFactor;
      winsPerMonth += bt.wins * monthlyFactor;
      lossesPerMonth += bt.losses * monthlyFactor;
      monthlyGrossUsd += bt.netPnlUsd * scale * monthlyFactor;
    }
    const trades = Math.round(tradesPerMonth);
    const wins = Math.round(winsPerMonth);
    const losses = Math.round(lossesPerMonth);
    const grossRounded = Math.round(monthlyGrossUsd * 100) / 100;
    const minDepo = tier.minBalanceUsdt;
    const monthlyPct = minDepo > 0 ? (grossRounded / minDepo) * 100 : 0;
    return {
      tierId,
      trades,
      wins,
      losses,
      winRatePct: trades === 0 ? null : (winsPerMonth / tradesPerMonth) * 100,
      grossUsd: grossRounded,
      pctOfMinDepoMonthly: Math.round(monthlyPct * 100) / 100,
      pctOfMinDepoAnnual: Math.round(monthlyPct * 12 * 10) / 10,
    };
  });
}

function renderTiersDashboard(fromMs: number, toMs: number): string {
  const recentTransitions = listRecentTransitions(30);
  const vipUsers = vipOverrideListStmt.all();

  // Phase N — shadow-replay PnL per tier. Two windows: 30 days (recent
  // signal) and 365 days (cumulative since live launch — extrapolation-free
  // annual figure). Same table layout, different headline emphasis in the
  // «% капитала» cell.
  const wrClass = (pct: number | null): string => {
    if (pct === null) return '';
    if (pct >= 70) return 'adm-wr-great';
    if (pct >= 55) return 'adm-wr-good';
    if (pct >= 40) return 'adm-wr-meh';
    return 'adm-wr-bad';
  };

  const renderTierStatsTable = (
    stats: TierLiveStats[],
    kind: 'month' | 'year',
    emptyLabel: string,
    tradesHeader: string = 'Сделок',
  ): string => {
    const totalTrades = stats.reduce((acc, s) => acc + s.trades, 0);
    if (totalTrades === 0) {
      return `<p class="adm-empty">${escapeHtml(emptyLabel)}</p>`;
    }
    return `
      <table class="adm-tier-table adm-tier-live">
        <thead>
          <tr>
            <th>Tier</th>
            <th>Стратегий</th>
            <th>${escapeHtml(tradesHeader)}</th>
            <th>Wins</th>
            <th>Losses</th>
            <th>Win-rate</th>
            <th>Gross PnL (USD)</th>
            <th>% капитала <span class="adm-th-sub">(на min-депо)</span></th>
          </tr>
        </thead>
        <tbody>
          ${stats.map((s) => {
            const tier = TIER_CONFIGS[s.tierId];
            const wrLabel = s.winRatePct === null ? '—' : `${s.winRatePct.toFixed(1)}%`;
            const grossClass = s.grossUsd > 0 ? 'adm-pnl-pos' : s.grossUsd < 0 ? 'adm-pnl-neg' : 'adm-pnl-zero';
            const grossSign = s.grossUsd > 0 ? '+' : s.grossUsd < 0 ? '−' : '';
            const grossDisplay = `${grossSign}$${Math.abs(s.grossUsd).toFixed(2)}`;
            const rowAccent = s.grossUsd > 0 ? 'adm-row-pos' : s.grossUsd < 0 ? 'adm-row-neg' : '';
            // Pct-cell content depends on the window:
            //   month window → headline = monthly, sub = annualised (× 12)
            //   year window  → headline = annual (real), sub = monthly avg (÷ 12)
            const pctClass = s.pctOfMinDepoMonthly > 0 ? 'adm-pnl-pos'
                            : s.pctOfMinDepoMonthly < 0 ? 'adm-pnl-neg' : 'adm-pnl-zero';
            const pctSign = s.pctOfMinDepoMonthly > 0 ? '+'
                          : s.pctOfMinDepoMonthly < 0 ? '−' : '';
            const monthlyPctStr = `${pctSign}${Math.abs(s.pctOfMinDepoMonthly).toFixed(2)}%`;
            const annualPctStr = `${pctSign}${Math.abs(s.pctOfMinDepoAnnual).toFixed(1)}%`;
            const depoTitle = tier.minBalanceUsdt > 0 ? '$' + tier.minBalanceUsdt : '—';
            const pctCell = kind === 'month'
              ? `
                <div class="adm-pct-monthly ${pctClass}" title="Депозит ${depoTitle} (минимум для тарифа)">${monthlyPctStr} <span class="adm-pct-suf">/ мес</span></div>
                <div class="adm-pct-annual" title="Грубая экстраполяция × 12">≈ ${annualPctStr} <span class="adm-pct-suf">/ год</span></div>
              `
              : `
                <div class="adm-pct-monthly ${pctClass}" title="Депозит ${depoTitle} (минимум для тарифа). Реальная цифра за всё накопленное окно (до 365 дней), без экстраполяции.">${annualPctStr} <span class="adm-pct-suf">/ год</span></div>
                <div class="adm-pct-annual" title="Среднее по году ÷ 12 (без учёта сезонности)">≈ ${monthlyPctStr} <span class="adm-pct-suf">/ мес сред.</span></div>
              `;
            return `
              <tr class="${rowAccent}">
                <td><b>${escapeHtml(tier.name)}</b> <span class="adm-tier-id">(${s.tierId})</span></td>
                <td class="adm-num">${tier.strategyIds.length}</td>
                <td class="adm-num">${s.trades}</td>
                <td class="adm-num adm-cell-wins">${s.wins}</td>
                <td class="adm-num adm-cell-losses">${s.losses}</td>
                <td class="adm-num ${wrClass(s.winRatePct)}">${wrLabel}</td>
                <td class="adm-num ${grossClass}">${grossDisplay}</td>
                <td class="adm-num adm-pct-cell">${pctCell}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
  };

  // Single range-selectable live table (Prof excluded). The range
  // comes from the from/to query params (defaults: last 30 days).
  const rangeDays = Math.max(1, Math.round((toMs - fromMs) / 86_400_000));
  const liveStatsTableRange = renderTierStatsTable(
    computeTierLiveStats(fromMs, toMs),
    'month',
    `За выбранный период (${rangeDays} дн.) не было закрытых сделок.`,
  );
  // Date-range form. Native <input type=date> in YYYY-MM-DD; submits
  // GET so the range lives in the URL (bookmarkable).
  const toISODate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const earliestClosedMs2 = earliestClosedShadowStmt.get()?.ts ?? null;
  const rangeForm = `
    <form method="GET" action="/admin/tiers" class="adm-range-form">
      <label>С <input type="date" name="from" value="${toISODate(fromMs)}" ${earliestClosedMs2 ? `min="${toISODate(earliestClosedMs2)}"` : ''} max="${toISODate(Date.now())}"></label>
      <label>По <input type="date" name="to" value="${toISODate(toMs)}" max="${toISODate(Date.now())}"></label>
      <button type="submit">Показать</button>
      <span class="adm-range-presets">
        <a href="/admin/tiers?from=${toISODate(Date.now() - 7 * 86400000)}&to=${toISODate(Date.now())}">7д</a>
        <a href="/admin/tiers?from=${toISODate(Date.now() - 30 * 86400000)}&to=${toISODate(Date.now())}">30д</a>
        <a href="/admin/tiers?from=${toISODate(Date.now() - 90 * 86400000)}&to=${toISODate(Date.now())}">90д</a>
        ${earliestClosedMs2 ? `<a href="/admin/tiers?from=${toISODate(earliestClosedMs2)}&to=${toISODate(Date.now())}">всё</a>` : ''}
      </span>
    </form>
  `;
  const forecastTable = renderTierStatsTable(
    computeTierForecastStats(),
    'month',
    'Бектесты не настроены ни для одной стратегии тарифов.',
    'Сделок/мес',
  );
  const forecastNote = `
    <p class="adm-tier-note">
      Прогноз: для каждой стратегии тарифа берётся снимок бектеста
      (<code>STRATEGY_CONFIGS[id].backtest</code>) — total trades, wins, losses,
      netPnlUsd, periodDays. Notional пересчитан в размер тарифа, цифры
      нормализованы к месяцу (<code>× 30 / periodDays</code>). Это <b>математическое
      ожидание</b> на исторических данных, не гарантия будущих результатов:
      реальный live-PnL зависит от текущего рыночного режима, slippage'а
      и того, продолжают ли условия сетапа повторяться так же часто.
      <br><br>
      Сравните блок «прогноз» с «последние 30 дней» — если live стабильно ниже
      бектеста, значит рынок «остыл» к этой стратегии (понижается частота
      сделок или win-rate). Если выше — текущая волатильность играет в пользу.
    </p>
  `;
  const liveStatsNote = `
    <p class="adm-tier-note">
      Симуляция: для каждой закрытой shadow-сделки (operator-уровень, <code>user_id IS NULL</code>)
      PnL пересчитан в USD на notional соответствующего тарифа,
      за вычетом комиссии Bybit 0.11% (round-trip) на каждую сделку.
      Это <b>не реальный</b> PnL юзеров (у них могут быть свои overrides), а оценка
      «что бы тариф заработал на актуальной истории сигналов».
      <br><br>
      <b>% капитала</b> рассчитан от <i>минимального</i> депозита тарифа (Starter $300,
      Standard $800, Plus $2 500, Pro $6 000, VIP $15 000). Юзер с большим
      балансом увидит меньший процент при той же долларовой PnL. Месячная и годовая
      цифры нормализованы к длине выбранного периода (<code>× 30/дней</code> и
      <code>× 365/дней</code>). <b>Prof исключён</b> — ручной тариф без фиксированного
      notional, его shadow-PnL не сопоставим с остальными.
    </p>
  `;

  const transitionsTable = recentTransitions.length === 0
    ? '<p class="adm-empty">Переходов ещё не было.</p>'
    : `
      <table class="adm-tier-table">
        <thead>
          <tr><th>Дата</th><th>User</th><th>Откуда → Куда</th><th>Причина</th><th>Баланс</th></tr>
        </thead>
        <tbody>
          ${recentTransitions.map((t) => `
            <tr>
              <td class="adm-dt">${new Date(t.created_at).toISOString().slice(0, 16).replace('T', ' ')}</td>
              <td>${t.user_id}</td>
              <td>${escapeHtml(t.from_tier ?? '—')} → <b>${escapeHtml(t.to_tier)}</b></td>
              <td>${escapeHtml(t.reason)}</td>
              <td>${t.balance_at_change_usdt !== null ? `$${t.balance_at_change_usdt.toFixed(2)}` : '—'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

  const vipTable = vipUsers.length === 0
    ? '<p class="adm-empty">Пользователей со Спецдоступом нет.</p>'
    : `
      <table class="adm-tier-table">
        <thead>
          <tr><th>User</th><th>Имя</th><th>Телефон</th><th>Стратегии (override)</th><th>Margin override</th></tr>
        </thead>
        <tbody>
          ${vipUsers.map((u) => {
            const strats = u.tier_override_strategies ? (() => {
              try { return (JSON.parse(u.tier_override_strategies!) as string[]).length + ' шт.'; } catch { return '—'; }
            })() : '—';
            return `
              <tr>
                <td>${u.user_id}</td>
                <td>${escapeHtml(u.display_name ?? '—')}</td>
                <td class="adm-mono">${escapeHtml(u.phone ?? '—')}</td>
                <td>${strats}</td>
                <td>${u.tier_override_margin !== null ? `$${u.tier_override_margin.toFixed(2)}` : '—'}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;

  const body = `
    <main class="adm-main">
      <header class="adm-header">
        <h1>Tier статистика</h1>
        <nav><a href="/admin">← К списку юзеров</a></nav>
      </header>

      <section class="adm-section">
        <h2>🔮 Прогнозируемая доходность по бектестам</h2>
        ${forecastTable}
        ${forecastNote}
      </section>

      <section class="adm-section">
        <h2>💹 Live-результаты по тарифам</h2>
        ${rangeForm}
        ${liveStatsTableRange}
        ${liveStatsNote}
      </section>

      <section class="adm-section">
        <h2>🔄 Последние переходы (${recentTransitions.length})</h2>
        ${transitionsTable}
      </section>

      <section class="adm-section">
        <h2>🎖 Спецдоступ с override (${vipUsers.length})</h2>
        ${vipTable}
      </section>
    </main>

    <style>
      /* Force a dark base and bright default text on every element. Some
         browsers do not cascade color from .adm-main into table cells, so
         we set it on html/body and re-assert on each td. */
      html, body { background: #0b0e13; color: #e8edf2; }
      .adm-main { max-width: 1100px; margin: 0 auto; padding: 24px; color: #e8edf2; font-family: ui-sans-serif, system-ui, sans-serif; }
      .adm-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 28px; padding-bottom: 16px; border-bottom: 1px solid #1f2630; }
      .adm-header h1 { font-size: 22px; margin: 0; color: #ffffff; font-weight: 600; }
      .adm-header nav a { color: #4ad991; text-decoration: none; font-size: 13px; }
      .adm-section { margin-bottom: 36px; }
      .adm-section h2 { font-size: 15px; color: #ffffff; margin: 0 0 14px 0; font-weight: 600; }
      .adm-tier-table { width: 100%; border-collapse: collapse; font-size: 13px; background: #11161d; border-radius: 8px; overflow: hidden; color: #e8edf2; }
      .adm-tier-table thead { background: #0e131a; }
      .adm-tier-table th { text-align: left; padding: 10px 14px; color: #98a2b3; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
      .adm-tier-table td { padding: 10px 14px; border-top: 1px solid #1a1f27; color: #e8edf2; }
      .adm-tier-table td b { color: #ffffff; font-weight: 600; }
      .adm-tier-table tr:first-child td { border-top: none; }
      .adm-tier-total { background: #0e131a; font-weight: 600; }
      .adm-tier-total td { color: #ffffff; }
      .adm-tier-id { color: #8590a0; font-size: 11px; font-family: ui-monospace, Menlo, monospace; }
      .adm-dt { color: #98a2b3; font-family: ui-monospace, Menlo, monospace; font-size: 11.5px; }
      .adm-mono { font-family: ui-monospace, Menlo, monospace; font-size: 12px; color: #e8edf2; }
      .adm-empty { color: #98a2b3; font-style: italic; padding: 12px 0; }
      /* PnL columns — must override .adm-tier-table td color via higher
         specificity (selector matches the same depth + the modifier class). */
      .adm-tier-table td.adm-pnl-pos { color: #4ad991; font-weight: 700; }
      .adm-tier-table td.adm-pnl-neg { color: #ff6b6b; font-weight: 700; }
      .adm-tier-table td.adm-pnl-zero { color: #98a2b3; font-weight: 600; }

      /* Numeric columns get the tabular look — Menlo + right-aligned. */
      .adm-tier-table td.adm-num {
        font-family: ui-monospace, Menlo, monospace;
        font-variant-numeric: tabular-nums;
      }
      .adm-tier-table td.adm-cell-wins { color: #6fd9a0; }
      .adm-tier-table td.adm-cell-losses { color: #ff9b9b; }

      /* Win-rate gradient: great / good / meh / bad. */
      .adm-tier-table td.adm-wr-great { color: #4ad991; font-weight: 700; }
      .adm-tier-table td.adm-wr-good  { color: #88e1b4; font-weight: 600; }
      .adm-tier-table td.adm-wr-meh   { color: #e0c275; font-weight: 600; }
      .adm-tier-table td.adm-wr-bad   { color: #ff6b6b; font-weight: 700; }

      /* Whole-row tinting based on PnL sign — subtle, so the table still
         reads as a unit, but each row earns its colour. */
      .adm-tier-live tr.adm-row-pos { background: linear-gradient(90deg, rgba(74,217,145,0.06), rgba(74,217,145,0) 60%); }
      .adm-tier-live tr.adm-row-neg { background: linear-gradient(90deg, rgba(255,107,107,0.08), rgba(255,107,107,0) 60%); }
      .adm-tier-live tr.adm-row-pos td { border-top-color: rgba(74,217,145,0.12); }
      .adm-tier-live tr.adm-row-neg td { border-top-color: rgba(255,107,107,0.14); }

      /* % капитала cell — two-line layout: monthly headline + annual sub. */
      .adm-tier-table td.adm-pct-cell {
        line-height: 1.2;
      }
      .adm-pct-monthly { font-size: 13px; font-weight: 700; }
      .adm-pct-annual {
        font-size: 11px; color: #98a2b3; margin-top: 3px;
        font-family: ui-monospace, Menlo, monospace;
      }
      .adm-pct-suf {
        font-size: 10px; color: #8590a0; font-weight: 500;
        letter-spacing: 0.02em;
      }
      .adm-th-sub {
        text-transform: none; font-weight: 500; font-size: 10px;
        color: #6b7480; letter-spacing: 0;
      }

      .adm-tier-note { font-size: 12px; color: #98a2b3; line-height: 1.55; margin: 12px 2px 0; }
      .adm-range-form {
        display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
        margin: 0 0 16px; font-size: 13px; color: #c7d0dc;
      }
      .adm-range-form label { display: inline-flex; align-items: center; gap: 6px; }
      .adm-range-form input[type=date] {
        background: #11161d; border: 1px solid #2a323d; color: #e8edf2;
        border-radius: 7px; padding: 6px 9px; font-family: inherit; font-size: 13px;
        color-scheme: dark;
      }
      .adm-range-form button {
        background: #4ad991; color: #07120c; border: none; border-radius: 7px;
        padding: 7px 16px; font-weight: 600; font-size: 13px; cursor: pointer;
        font-family: inherit;
      }
      .adm-range-form button:hover { background: #3fc983; }
      .adm-range-presets { display: inline-flex; gap: 4px; margin-left: auto; }
      .adm-range-presets a {
        color: #8590a0; text-decoration: none; font-size: 12px;
        padding: 5px 10px; border: 1px solid #2a323d; border-radius: 999px;
        transition: all 0.15s;
      }
      .adm-range-presets a:hover { color: #4ad991; border-color: #4ad991; }
      .adm-tier-note code { background: #0e131a; padding: 1px 5px; border-radius: 4px; font-size: 11px; color: #e8edf2; font-family: ui-monospace, Menlo, monospace; }
      .adm-tier-note b { color: #e8edf2; }
      .adm-tier-note i { color: #cfd6dd; font-style: normal; font-weight: 500; }
    </style>
  `;
  return body;
}
