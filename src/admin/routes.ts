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
  ensureTrialFor,
  adminExtend,
  type SubscriptionRow,
} from '../db/repos/user-subscriptions.js';
import { recordAdminAction } from '../db/repos/admin-audit.js';
import { adminCsrfToken, requireAdminCsrf } from '../auth/csrf.js';
import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';

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
          const toggle = `<div class="adm-actions">${vipToggle}${extendForm}</div>`;
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
      <div class="section-title">Все регистрации (${rows.length})</div>
      <div class="card" style="overflow-x:auto">
        <table>
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
  app.get('/admin', async (req, reply) => {
    if (!checkAuth(req, reply)) return;
    reply.type('text/html; charset=utf-8');
    reply.header('Cache-Control', 'private, no-store');
    const adminEmail = process.env.ADMIN_EMAIL ?? 'admin';
    return renderDashboard(adminCsrfToken(adminEmail));
  });

  // ---------------- POST /admin/users/:id/plan ----------------
  // Toggle a user's plan between 'standard' and 'vip'. Form-encoded
  // body (the admin table renders bare <form method=POST>). After
  // the flip we redirect back to /admin so the table refreshes
  // without the operator seeing a JSON blob.
  app.post('/admin/users/:id/plan', async (req, reply) => {
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
  app.post('/admin/users/:id/extend', async (req, reply) => {
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
}

const extendFormSchema = z.object({
  days: z.coerce.number().int().min(1).max(3650),
});
