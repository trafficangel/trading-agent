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
  type RegistrationListRow,
} from '../auth/session.js';
import { pageShell } from '../strategies/landing.js';
import {
  findSubscription,
  setPlan,
  cancelSubscription,
  ensureTrialFor,
  adminExtend,
  type SubscriptionRow,
} from '../db/repos/user-subscriptions.js';
import { recordAdminAction } from '../db/repos/admin-audit.js';
import { adminCsrfToken, requireAdminCsrf } from '../auth/csrf.js';
import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { TIER_CONFIGS, TIER_ORDER, computeTierTradeSize, type TierId } from '../strategies/tier-config.js';
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
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)}`;
}

function fmtAge(ts: number): string {
  const ageMs = Date.now() - ts;
  const min = Math.floor(ageMs / 60_000);
  if (min < 60) return `${min} мин назад`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.floor(h / 24);
  return `${d} д назад`;
}

/** Compact "X дн осталось" / "истекло N дн назад" label for the План
 *  column, shown below the status badge for non-VIP users. */
function daysLeftLabel(accessUntil: number): string {
  const ms = accessUntil - Date.now();
  const days = Math.ceil(ms / 86_400_000);
  if (days < 0) return `<span class="plan-days-bad">истекло ${Math.abs(days)} дн назад</span>`;
  if (days === 0) return `<span class="plan-days-warn">истекает сегодня</span>`;
  if (days <= 3) return `<span class="plan-days-warn">${days} дн осталось</span>`;
  return `<span class="plan-days-ok">${days} дн осталось</span>`;
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

function planBadge(plan: 'standard' | 'vip', status: string): string {
  if (plan === 'vip') {
    return `<span class="plan-badge plan-vip" title="VIP — постоянный доступ">👑 VIP</span>`;
  }
  if (status === 'trial') {
    return `<span class="plan-badge plan-trial">🎁 Trial</span>`;
  }
  if (status === 'active') {
    return `<span class="plan-badge plan-active">✓ Active</span>`;
  }
  if (status === 'cancelled') {
    return `<span class="plan-badge plan-bad">⏸ Cancelled</span>`;
  }
  return `<span class="plan-badge plan-bad">⛔ Expired</span>`;
}

function renderDashboard(csrfToken: string): string {
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
    const hasAccess = !!sub && (sub.plan === 'vip' || (sub.access_until > now && (sub.status === 'trial' || sub.status === 'active')));
    if (hasKey) cKey++;
    if (stratN > 0) cStrats++;
    if (hasKey && stratN > 0 && hasAccess) cFullActive++;
  }

  const tableRows = rows.length === 0
    ? `<tr><td colspan="10" style="text-align:center;color:var(--text-faint);padding:24px">Регистраций пока нет</td></tr>`
    : rows
        .map((r: RegistrationListRow) => {
          const phone = r.phone ?? '—';
          const name = r.display_name ?? '—';
          const tg = r.tg_user_id ? String(r.tg_user_id) : '—';
          const sub = subs.get(r.id);
          const plan = sub?.plan ?? 'standard';
          const status = sub?.status ?? '—';
          const badge = sub ? planBadge(plan, status) : '<span class="plan-badge plan-bad">—</span>';

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
          const stratN = stratCounts.get(r.id) ?? 0;
          const stratCell = stratN > 0
            ? `<b>${stratN}</b>`
            : `<span style="color:#6b7480">—</span>`;
          // Three buttons per row:
          //   1. VIP toggle (Сделать VIP / Снять VIP)
          //   2. Продлить на 30 дней — bumps access_until forward for
          //      non-VIP users (no-op for VIP since they're already permanent)
          //   3. Days-left preview when on standard plan
          const csrfField = `<input type="hidden" name="_csrf" value="${csrfToken}">`;
          const vipToggle = plan === 'vip'
            ? `<form method="POST" action="/admin/users/${r.id}/plan" style="display:inline">
                 ${csrfField}
                 <input type="hidden" name="plan" value="standard">
                 <button class="adm-btn adm-btn-warn" type="submit"
                   onclick="return confirm('Снять VIP с ${escapeHtml(name)}?')">Снять VIP</button>
               </form>`
            : `<form method="POST" action="/admin/users/${r.id}/plan" style="display:inline">
                 ${csrfField}
                 <input type="hidden" name="plan" value="vip">
                 <button class="adm-btn adm-btn-vip" type="submit"
                   onclick="return confirm('Выдать VIP пользователю ${escapeHtml(name)}?')">Сделать VIP</button>
               </form>`;
          // Extend by 30/90/365 dropdown — applies only for non-VIP users
          // and is functionally a no-op (rejected on server) for VIPs.
          // We still show it on VIP rows greyed-out so the layout stays
          // consistent.
          const extendForm = plan === 'vip'
            ? ''
            : `<form method="POST" action="/admin/users/${r.id}/extend" style="display:inline; margin-left:4px">
                 ${csrfField}
                 <select name="days" class="adm-select">
                   <option value="30">+30 дней</option>
                   <option value="90">+90 дней</option>
                   <option value="365">+1 год</option>
                 </select>
                 <button class="adm-btn adm-btn-secondary" type="submit"
                   onclick="return confirm('Продлить подписку для ${escapeHtml(name)}?')">Продлить</button>
               </form>`;
          // Audit H6 — cancel button. Hidden for already-cancelled
          // and expired rows (no point cancelling an already-dead sub).
          // VIPs can be cancelled too — operator may want to wind one
          // down before re-issuing under different terms.
          const cancelForm =
            status === 'cancelled' || status === 'expired'
              ? ''
              : `<form method="POST" action="/admin/users/${r.id}/cancel" style="display:inline; margin-left:4px"
                       onsubmit="return confirm('Отменить подписку для ${escapeHtml(name)}? Доступ к торговле будет заблокирован, открытые позиции НЕ закрываются автоматически.');">
                   ${csrfField}
                   <button class="adm-btn adm-btn-danger" type="submit">Отменить</button>
                 </form>`;
          const toggle = `<div class="adm-actions">${vipToggle}${extendForm}${cancelForm}</div>`;
          // Days-left badge for the План column when on standard.
          const daysLeftBadge = sub && plan === 'standard' && status !== 'cancelled'
            ? `<div class="plan-days">${daysLeftLabel(sub.access_until)}</div>`
            : '';
          return `
            <tr>
              <td class="dt">${fmtDateTime(r.created_at)}</td>
              <td>${escapeHtml(name)}</td>
              <td class="mono">${escapeHtml(phone)}</td>
              <td>${badge}${daysLeftBadge}</td>
              <td>${apiCell}</td>
              <td style="text-align:center">${stratCell}</td>
              <td class="mono">${escapeHtml(r.ip_first ?? '—')}</td>
              <td class="mono">${tg}</td>
              <td>${fmtAge(r.last_seen_at)}</td>
              <td>${toggle}</td>
            </tr>`;
        })
        .join('');

  const body = `
    <div class="header">
      <span class="strat-code">ADMIN</span>
      <h1 class="title">Регистрации</h1>
      <p class="subtitle">Статистика подключений через Telegram Gateway</p>
    </div>

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
              <th>Страт.</th>
              <th>IP</th>
              <th>TG user_id</th>
              <th>Последняя активность</th>
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
      .adm-table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
      .adm-users-table { min-width: 1100px; }
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

const planFormSchema = z.object({
  plan: z.enum(['standard', 'vip']),
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
    return renderDashboard(adminCsrfToken(adminEmail));
  });

  // ---------------- GET /admin/tiers (TRACK E Phase B) ----------------
  // Tier distribution, MRR, recent transitions. Read-only stats page.
  app.get('/admin/tiers', { config: { rateLimit: adminRateLimit } }, async (req, reply) => {
    if (!checkAuth(req, reply)) return;
    reply.type('text/html; charset=utf-8');
    reply.header('Cache-Control', 'private, no-store');
    return renderTiersDashboard();
  });

  // ---------------- POST /admin/users/:id/plan ----------------
  // Toggle a user's plan between 'standard' and 'vip'. Form-encoded
  // body (the admin table renders bare <form method=POST>). After
  // the flip we redirect back to /admin so the table refreshes
  // without the operator seeing a JSON blob.
  app.post('/admin/users/:id/plan', { config: { rateLimit: adminRateLimit } }, async (req, reply) => {
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
    const parsed = planFormSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send('plan field required (standard|vip)');
      return;
    }
    const plan = parsed.data.plan;

    // Ensure a subscription row exists (handles the edge case where an
    // admin promotes a user that registered before Track D shipped and
    // never went through /auth/verify since the auto-create landed).
    if (!findSubscription(userId)) ensureTrialFor(userId);

    const adminEmail = process.env.ADMIN_EMAIL ?? 'admin';
    const before = findSubscription(userId);
    try {
      const after = setPlan(userId, plan, adminEmail, `set via /admin at ${new Date().toISOString()}`);
      recordAdminAction({
        adminEmail,
        targetUserId: userId,
        action: 'set_plan',
        before: before ? { plan: before.plan, status: before.status, access_until: before.access_until } : null,
        after: { plan: after.plan, status: after.status, access_until: after.access_until },
        ip: req.ip,
      });
      logger.info({ user_id: userId, plan, by: adminEmail }, 'admin: plan changed');
    } catch (err) {
      logger.error({ err, user_id: userId }, 'admin: setPlan failed');
      reply.code(500).send('failed to update plan');
      return;
    }
    reply.code(303).header('location', '/admin').send();
  });

  // ---------------- POST /admin/users/:id/extend ----------------
  // Bump access_until forward by N days for non-VIP users. Useful for
  // manually onboarding paying customers before automated billing is
  // wired. Rejected for VIP users (their access is already permanent).
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
    } else if (existing.plan === 'vip') {
      reply.code(400).send('cannot extend VIP — already permanent');
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

  // ---------------- POST /admin/users/:id/cancel ----------------
  // Audit H6 — explicit cancel state, distinct from natural expiry.
  // Used when a user requests cancellation by Telegram before their
  // paid period ends, or for fraud/abuse. Status → 'cancelled', which
  // gates listEligibleTargets and shows different cabinet copy.
  app.post('/admin/users/:id/cancel', { config: { rateLimit: adminRateLimit } }, async (req, reply) => {
    if (!checkAuth(req, reply)) return;
    const adminEmailForCsrf = process.env.ADMIN_EMAIL ?? 'admin';
    if (!requireAdminCsrf(req, reply, adminEmailForCsrf)) return;
    const userId = Number((req.params as { id?: string }).id);
    if (!Number.isFinite(userId) || userId <= 0) {
      reply.code(400).send('bad user id');
      return;
    }
    const before = findSubscription(userId);
    if (!before) {
      reply.code(404).send('no subscription');
      return;
    }
    const adminEmail = process.env.ADMIN_EMAIL ?? 'admin';
    const note = typeof (req.body as { reason?: unknown })?.reason === 'string'
      ? String((req.body as { reason: string }).reason).slice(0, 200)
      : 'cancelled via /admin';
    try {
      cancelSubscription(userId, adminEmail, note);
      const after = findSubscription(userId);
      recordAdminAction({
        adminEmail,
        targetUserId: userId,
        action: 'cancel_subscription',
        before: { status: before.status, access_until: before.access_until },
        after: after ? { status: after.status, access_until: after.access_until } : null,
        note,
        ip: req.ip,
      });
      logger.info({ user_id: userId, by: adminEmail, note }, 'admin: subscription cancelled');
    } catch (err) {
      logger.error({ err, user_id: userId }, 'admin: cancel failed');
      reply.code(500).send('failed to cancel subscription');
      return;
    }
    reply.code(303).header('location', '/admin').send();
  });
}

const extendFormSchema = z.object({
  days: z.coerce.number().int().min(1).max(3650),
});

/**
 * TRACK E Phase B — /admin/tiers stats dashboard.
 *
 * Shows operator: distribution of users across tiers, monthly recurring
 * revenue (sum of subscription prices for active users), recent
 * transitions feed (last 30), and a list of VIP-override users.
 *
 * Pure SQL read — no mutations, no CSRF needed.
 */
const tierDistStmt = db.prepare<[], { tier_id: string; n: number }>(`
  SELECT tier_id, COUNT(*) AS n
    FROM user_subscriptions
   WHERE status IN ('trial', 'active')
   GROUP BY tier_id
   ORDER BY tier_id
`);

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
   WHERE s.plan = 'vip'
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
const shadowClosedRecentStmt = db.prepare<
  [number],
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
`);

type TierLiveStats = {
  tierId: TierId;
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number | null;   // null when trades=0
  grossUsd: number;            // sum of per-trade pnl_pct/100 × tier-notional
};

function computeTierLiveStats(windowMs: number): TierLiveStats[] {
  const sinceMs = Date.now() - windowMs;
  const rows = shadowClosedRecentStmt.all(sinceMs);

  return TIER_ORDER.map((tierId) => {
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
      grossUsd += (row.pnl_pct / 100) * size.notionalUsd;
    }
    return {
      tierId,
      trades,
      wins,
      losses,
      winRatePct: trades === 0 ? null : (wins / trades) * 100,
      grossUsd: Math.round(grossUsd * 100) / 100,
    };
  });
}

function renderTiersDashboard(): string {
  const dist = new Map<string, number>();
  for (const row of tierDistStmt.all()) dist.set(row.tier_id, row.n);

  // Build distribution rows: every tier shown, even if zero users.
  const distRows = TIER_ORDER.map((id) => {
    const tier = TIER_CONFIGS[id];
    const n = dist.get(id) ?? 0;
    const mrr = n * tier.monthlyPriceUsd;
    return { id, name: tier.name, n, price: tier.monthlyPriceUsd, mrr };
  });
  const totalUsers = distRows.reduce((acc, r) => acc + r.n, 0);
  const totalMrr = distRows.reduce((acc, r) => acc + r.mrr, 0);

  const recentTransitions = listRecentTransitions(30);
  const vipUsers = vipOverrideListStmt.all();

  // Phase N — 30-day shadow-replay PnL per tier.
  const liveStats = computeTierLiveStats(30 * 24 * 60 * 60 * 1000);
  const liveStatsTable = (() => {
    const totalTrades = liveStats.reduce((acc, s) => acc + s.trades, 0);
    if (totalTrades === 0) {
      return '<p class="adm-empty">За последние 30 дней не было закрытых сделок.</p>';
    }
    return `
      <table class="adm-tier-table">
        <thead>
          <tr>
            <th>Tier</th>
            <th>Стратегий</th>
            <th>Сделок</th>
            <th>Wins</th>
            <th>Losses</th>
            <th>Win-rate</th>
            <th>Gross PnL (USD)</th>
            <th>vs expected</th>
          </tr>
        </thead>
        <tbody>
          ${liveStats.map((s) => {
            const tier = TIER_CONFIGS[s.tierId];
            const expected = tier.expectedMonthlyPnlRangeUsd;
            const expectedLabel = expected.low === 0 && expected.high === 0
              ? '<span class="adm-tier-id">—</span>'
              : `<span class="adm-tier-id">$${expected.low}–$${expected.high}</span>`;
            const wrLabel = s.winRatePct === null ? '—' : `${s.winRatePct.toFixed(1)}%`;
            const grossClass = s.grossUsd > 0 ? 'adm-pnl-pos' : s.grossUsd < 0 ? 'adm-pnl-neg' : '';
            const grossSign = s.grossUsd > 0 ? '+' : '';
            return `
              <tr>
                <td><b>${escapeHtml(tier.name)}</b> <span class="adm-tier-id">(${s.tierId})</span></td>
                <td>${tier.strategyIds.length}</td>
                <td>${s.trades}</td>
                <td>${s.wins}</td>
                <td>${s.losses}</td>
                <td>${wrLabel}</td>
                <td class="${grossClass}">${grossSign}$${s.grossUsd.toFixed(2)}</td>
                <td>${expectedLabel}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
      <p class="adm-tier-note">
        Симуляция: для каждой закрытой shadow-сделки (operator-уровень, <code>user_id IS NULL</code>)
        за последние 30 дней PnL пересчитан в USD на notional соответствующего тарифа.
        Это <b>не реальный</b> PnL юзеров (у них могут быть свои overrides), а оценка
        «что бы тариф заработал на актуальной истории сигналов». Сравните с колонкой
        <i>vs expected</i> — это диапазон из <code>tier-config.ts</code>.
      </p>
    `;
  })();

  const distTable = `
    <table class="adm-tier-table">
      <thead>
        <tr><th>Tier</th><th>Юзеров</th><th>Подписка/мес</th><th>MRR вклад</th></tr>
      </thead>
      <tbody>
        ${distRows.map((r) => `
          <tr>
            <td><b>${escapeHtml(r.name)}</b> <span class="adm-tier-id">(${r.id})</span></td>
            <td>${r.n}</td>
            <td>$${r.price}</td>
            <td>$${r.mrr}</td>
          </tr>
        `).join('')}
        <tr class="adm-tier-total">
          <td>Всего</td><td>${totalUsers}</td><td>—</td><td>$${totalMrr}/мес</td>
        </tr>
      </tbody>
    </table>
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
    ? '<p class="adm-empty">VIP-пользователей нет.</p>'
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
        <h2>📊 Распределение по тарифам</h2>
        ${distTable}
      </section>

      <section class="adm-section">
        <h2>💹 Live-результаты по тарифам (последние 30 дней)</h2>
        ${liveStatsTable}
      </section>

      <section class="adm-section">
        <h2>🔄 Последние переходы (${recentTransitions.length})</h2>
        ${transitionsTable}
      </section>

      <section class="adm-section">
        <h2>👑 VIP с override (${vipUsers.length})</h2>
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
      .adm-pnl-pos { color: #4ad991; font-weight: 700; }
      .adm-pnl-neg { color: #ff8b8b; font-weight: 700; }
      .adm-tier-note { font-size: 12px; color: #98a2b3; line-height: 1.55; margin: 12px 2px 0; }
      .adm-tier-note code { background: #0e131a; padding: 1px 5px; border-radius: 4px; font-size: 11px; color: #e8edf2; font-family: ui-monospace, Menlo, monospace; }
      .adm-tier-note b { color: #e8edf2; }
    </style>
  `;
  return body;
}
