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
  type SubscriptionRow,
} from '../db/repos/user-subscriptions.js';
import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c] ?? c);
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
    if (user === adminEmail && pass === adminPassword) return true;
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

/** Bulk-fetch subscriptions for a list of user_ids in one query so the
 *  admin table doesn't N+1 across N rows. */
const adminListSubsStmt = db.prepare<[], SubscriptionRow>(
  `SELECT * FROM user_subscriptions`,
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

function renderDashboard(): string {
  const stats = getRegistrationStats();
  const rows = listRegistrations(500);
  const subs = new Map<number, SubscriptionRow>();
  for (const s of adminListSubsStmt.all()) subs.set(s.user_id, s);

  const tableRows = rows.length === 0
    ? `<tr><td colspan="8" style="text-align:center;color:var(--text-faint);padding:24px">Регистраций пока нет</td></tr>`
    : rows
        .map((r: RegistrationListRow) => {
          const phone = r.phone ?? '—';
          const name = r.display_name ?? '—';
          const tg = r.tg_user_id ? String(r.tg_user_id) : '—';
          const sub = subs.get(r.id);
          const plan = sub?.plan ?? 'standard';
          const status = sub?.status ?? '—';
          const badge = sub ? planBadge(plan, status) : '<span class="plan-badge plan-bad">—</span>';
          const toggle = plan === 'vip'
            ? `<form method="POST" action="/admin/users/${r.id}/plan" style="display:inline">
                 <input type="hidden" name="plan" value="standard">
                 <button class="adm-btn adm-btn-warn" type="submit"
                   onclick="return confirm('Снять VIP с ${escapeHtml(name)}?')">Снять VIP</button>
               </form>`
            : `<form method="POST" action="/admin/users/${r.id}/plan" style="display:inline">
                 <input type="hidden" name="plan" value="vip">
                 <button class="adm-btn adm-btn-vip" type="submit"
                   onclick="return confirm('Выдать VIP пользователю ${escapeHtml(name)}?')">Сделать VIP</button>
               </form>`;
          return `
            <tr>
              <td class="dt">${fmtDateTime(r.created_at)}</td>
              <td>${escapeHtml(name)}</td>
              <td class="mono">${escapeHtml(phone)}</td>
              <td>${badge}</td>
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
        <div class="dash-label">Всего</div>
        <div class="dash-value">${stats.total}</div>
        <div class="dash-sub">с момента запуска</div>
      </div>
      <div class="dash-card">
        <div class="dash-label">За 24 часа</div>
        <div class="dash-value">${stats.last24h}</div>
      </div>
      <div class="dash-card">
        <div class="dash-label">За 7 дней</div>
        <div class="dash-value">${stats.last7d}</div>
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
    return renderDashboard();
  });

  // ---------------- POST /admin/users/:id/plan ----------------
  // Toggle a user's plan between 'standard' and 'vip'. Form-encoded
  // body (the admin table renders bare <form method=POST>). After
  // the flip we redirect back to /admin so the table refreshes
  // without the operator seeing a JSON blob.
  app.post('/admin/users/:id/plan', async (req, reply) => {
    if (!checkAuth(req, reply)) return;
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
    try {
      setPlan(userId, plan, adminEmail, `set via /admin at ${new Date().toISOString()}`);
      logger.info({ user_id: userId, plan, by: adminEmail }, 'admin: plan changed');
    } catch (err) {
      logger.error({ err, user_id: userId }, 'admin: setPlan failed');
      reply.code(500).send('failed to update plan');
      return;
    }
    reply.code(303).header('location', '/admin').send();
  });
}
