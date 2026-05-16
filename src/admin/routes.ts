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
import {
  listRegistrations,
  getRegistrationStats,
  type RegistrationListRow,
} from '../auth/session.js';
import { pageShell } from '../strategies/landing.js';

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

function renderDashboard(): string {
  const stats = getRegistrationStats();
  const rows = listRegistrations(500);
  const tableRows = rows.length === 0
    ? `<tr><td colspan="6" style="text-align:center;color:var(--text-faint);padding:24px">Регистраций пока нет</td></tr>`
    : rows
        .map((r: RegistrationListRow) => {
          const phone = r.phone ?? '—';
          const ua = (r.user_agent_first ?? '').slice(0, 80);
          const tg = r.tg_user_id ? String(r.tg_user_id) : '—';
          return `
            <tr>
              <td class="dt">${fmtDateTime(r.created_at)}</td>
              <td class="mono">${escapeHtml(phone)}</td>
              <td class="mono">${escapeHtml(r.ip_first ?? '—')}</td>
              <td class="mono">${tg}</td>
              <td>${fmtAge(r.last_seen_at)}</td>
              <td class="ua" title="${escapeHtml(r.user_agent_first ?? '')}">${escapeHtml(ua)}</td>
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
              <th>Телефон</th>
              <th>IP</th>
              <th>TG user_id</th>
              <th>Последняя активность</th>
              <th>User agent</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    </div>

    <style>
      td.ua { font-size: 11px; color: var(--text-faint); max-width: 240px;
              overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    </style>
  `;
  return pageShell('Admin — Регистрации', body, { robots: 'noindex, nofollow' });
}

export async function adminRoute(app: FastifyInstance): Promise<void> {
  app.get('/admin', async (req, reply) => {
    if (!checkAuth(req, reply)) return;
    reply.type('text/html; charset=utf-8');
    reply.header('Cache-Control', 'private, no-store');
    return renderDashboard();
  });
}
