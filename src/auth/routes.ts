/**
 * Phone-verification auth routes.
 *
 *   POST /auth/start    — { phone } → sends code via Telegram, returns
 *                         {ok, masked_phone}. Stashes request_id in
 *                         `pending_auth` HttpOnly cookie (10 min TTL).
 *
 *   POST /auth/verify   — { code } → reads pending_auth cookie, calls
 *                         Gateway, on success creates session row +
 *                         sets `sid` HttpOnly cookie (90 days).
 *
 *   GET  /auth/me       — returns {authenticated: bool, since?: ts}
 *                         so the form can decide what to show.
 *
 *   POST /auth/logout   — clears the sid cookie.
 *
 * Anti-abuse:
 *   - Rate limit start by IP (per process, in-memory map).
 *   - Phone normalised + hashed before any DB write.
 *   - Plaintext phone NEVER logged.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { logger } from '../lib/logger.js';
import { sendMessage } from '../telegram/bot.js';
import { sendVerificationMessage } from './telegram-gateway.js';
import { ensureTrialFor, setPlan, findSubscription } from '../db/repos/user-subscriptions.js';
import { isVipPhone } from './vip-allowlist.js';
import {
  hashPhone,
  registerOrRefresh,
  recordVerificationAttempt,
  getVerificationAttempt,
  verifyOtpCode,
  clearVerificationAttempt,
  bumpVerificationAttempts,
  findSession,
  findByPhoneHash,
  touchSession,
  SESSION_COOKIE,
  PENDING_COOKIE,
  SESSION_TTL_DAYS,
  PENDING_TTL_SEC,
} from './session.js';

const startSchema = z.object({
  phone: z.string().min(7).max(20),
  /** Self-chosen display name (used in cabinet greeting + admin panel).
   *  Optional for back-compat with older clients; the gate form on
   *  /strategies sends it. Trimmed + truncated to 40 chars at the
   *  application layer. */
  name: z.string().trim().min(1).max(40).optional(),
  /** Intent:
   *   - 'register' (default): create account if not exists, name required
   *   - 'login': phone must already exist, name ignored
   *
   *  We distinguish so a "login" attempt with an unknown phone doesn't
   *  silently create an account with no display_name. */
  mode: z.enum(['login', 'register']).optional().default('register'),
});

const verifySchema = z.object({
  code: z.string().regex(/^\d{4,9}$/),
});

// Per-IP rate limit: max 5 /auth/start in 10 minutes (in-memory).
// Survives the lifetime of one Node process; resets on restart.
const ipBuckets = new Map<string, { count: number; resetAt: number }>();
const START_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const START_LIMIT_MAX = 5;

function checkStartRateLimit(ip: string): boolean {
  const now = Date.now();
  const bucket = ipBuckets.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    ipBuckets.set(ip, { count: 1, resetAt: now + START_LIMIT_WINDOW_MS });
    return true;
  }
  if (bucket.count >= START_LIMIT_MAX) return false;
  bucket.count++;
  return true;
}

function clientIp(req: FastifyRequest): string {
  // Layered proxies — Cloudflare → Caddy → Fastify:
  //   1. `CF-Connecting-IP` is set by CF edge to the original client IP.
  //      Most authoritative.
  //   2. `X-Forwarded-For` is appended by Caddy when CF passes through.
  //      First value is the original client. Used as fallback (if CF
  //      proxy is off for some reason).
  //   3. `req.ip` falls back to socket remote address.
  const cf = (req.headers['cf-connecting-ip'] as string | undefined)?.trim();
  if (cf) return cf;
  const xff = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim();
  return xff || req.ip || 'unknown';
}

function maskPhone(phoneE164: string): string {
  if (phoneE164.length < 6) return '***';
  return phoneE164.slice(0, 3) + '***' + phoneE164.slice(-2);
}

function normalisePhone(input: string): string | null {
  // Strip spaces/dashes/parens, ensure leading +, only digits after.
  const cleaned = input.replace(/[\s\-()]/g, '');
  if (!cleaned.startsWith('+')) return null;
  if (!/^\+\d{7,15}$/.test(cleaned)) return null;
  return cleaned;
}

export async function authRoute(app: FastifyInstance): Promise<void> {
  // ---------------- /auth/start ----------------
  app.post('/auth/start', async (req, reply) => {
    const ip = clientIp(req);
    if (!checkStartRateLimit(ip)) {
      reply.code(429);
      return { ok: false, error: 'rate_limited', message: 'Слишком много попыток. Подождите 10 минут.' };
    }

    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: 'invalid_phone_format' };
    }
    const phoneE164 = normalisePhone(parsed.data.phone);
    if (!phoneE164) {
      reply.code(400);
      return { ok: false, error: 'invalid_phone_format', message: 'Введите номер в международном формате с кодом страны (например, +7 для России, +1 для США, +44 для Великобритании)' };
    }
    const phoneHash = hashPhone(phoneE164);

    // Login mode: phone must already be in registrations. If not, bail
    // out with phone_not_registered so the frontend can prompt the user
    // to switch to register mode (and ask for their name).
    if (parsed.data.mode === 'login' && !findByPhoneHash(phoneHash)) {
      return {
        ok: false,
        error: 'phone_not_registered',
        message: 'Этот номер не зарегистрирован. Зарегистрируйтесь сначала — это займёт минуту.',
      };
    }

    try {
      const res = await sendVerificationMessage(phoneE164);
      const ua = (req.headers['user-agent'] as string | undefined) ?? null;
      // Server-generated code: we stored what Gateway delivered, so we
      // can compare locally on /auth/verify — no extra Gateway call.
      recordVerificationAttempt(
        res.request_id,
        phoneHash,
        phoneE164,
        res.code,
        ip,
        ua,
        parsed.data.name ?? null,
      );

      // Pending cookie carries request_id between /auth/start and /auth/verify.
      reply.setCookie(PENDING_COOKIE, res.request_id, {
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: PENDING_TTL_SEC,
      });
      logger.info(
        { phone: maskPhone(phoneE164), request_id: res.request_id, ip },
        'auth: verification code sent',
      );
      return { ok: true, masked_phone: maskPhone(phoneE164) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, phone: maskPhone(phoneE164), ip }, 'auth: send verification failed');
      reply.code(500);
      return {
        ok: false,
        error: 'gateway_error',
        // Surface the actual reason instead of opaque "Не удалось" so
        // the operator can debug from the browser console.
        message: msg.includes('Gateway')
          ? `Сервис верификации недоступен: ${msg}`
          : 'Не удалось отправить код. Попробуйте позже.',
      };
    }
  });

  // ---------------- /auth/verify ----------------
  app.post('/auth/verify', async (req, reply) => {
    const parsed = verifySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: 'invalid_code_format' };
    }
    const requestId = req.cookies[PENDING_COOKIE];
    if (!requestId) {
      reply.code(400);
      return { ok: false, error: 'no_pending_request', message: 'Сначала запросите код.' };
    }
    const attempt = getVerificationAttempt(requestId);
    if (!attempt) {
      reply.code(400);
      reply.clearCookie(PENDING_COOKIE, { path: '/' });
      return { ok: false, error: 'pending_expired', message: 'Срок действия истёк. Запросите код заново.' };
    }
    if (attempt.attempts >= 5) {
      reply.code(429);
      return { ok: false, error: 'too_many_code_attempts', message: 'Слишком много попыток.' };
    }
    bumpVerificationAttempts(requestId);

    // Local compare — code was generated server-side at /auth/start
    // and stored in verification_attempts as sha256(code + OTP_PEPPER).
    // verifyOtpCode does constant-time hash comparison.
    if (!verifyOtpCode(requestId, parsed.data.code)) {
      return { ok: false, error: 'code_invalid' };
    }
    const ip = clientIp(req);
    const ua = (req.headers['user-agent'] as string | undefined) ?? null;
    // attempt.phone is now always populated (migration 015 + writer).
    // Empty-string fallback kept for the brief period before that fix.
    const phone = attempt.phone && attempt.phone.length > 0 ? attempt.phone : '';
    const { sessionId, isNew, userId } = registerOrRefresh(
      phone,
      attempt.phone_hash,
      ip,
      ua,
      null, // tg_user_id — set when we later wire Gateway's user_id passthrough
      attempt.display_name ?? null,
    );

    // Track D — auto-issue a trial subscription on first registration.
    // Idempotent: ensureTrialFor returns the existing row if one exists,
    // so re-logins (isNew=false) don't reset the trial clock. New rows
    // get TRACK_D_TRIAL_DAYS days of free access starting from now().
    ensureTrialFor(userId);

    // VIP allowlist auto-promote: if the phone matches a known beta
    // tester (operator's friend / first paying invite), grant them
    // perpetual access immediately. Only fires when their current
    // plan is still 'standard' so manual demotions stick.
    if (phone && isVipPhone(phone)) {
      const sub = findSubscription(userId);
      if (sub && sub.plan === 'standard') {
        setPlan(userId, 'vip', 'system', 'auto-promoted via VIP_PHONES allowlist');
        logger.info({ user_id: userId, phone: maskPhone(phone) }, 'auth: VIP auto-promote');
      }
    }
    clearVerificationAttempt(requestId);
    reply.clearCookie(PENDING_COOKIE, { path: '/' });
    reply.setCookie(SESSION_COOKIE, sessionId, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
    });
    logger.info({ request_id: requestId, is_new: isNew }, 'auth: session created');

    // Notify operator about new registrations (not repeat logins) via
    // Logs channel. Phone shown in full — this is the operator's own
    // private channel, not a public space. IP + UA help spot abuse
    // patterns (e.g. one IP creating multiple accounts).
    if (isNew && phone) {
      // HTML-escape UA — TG parse_mode='HTML' would crash on raw <, >, &
      // characters inside user-agent strings. Phone and IP are
      // safe by shape (digits + dots), no escaping needed.
      const escapeHtml = (s: string): string =>
        s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const uaShort = ua
        ? escapeHtml(ua.length > 80 ? ua.slice(0, 77) + '…' : ua)
        : '—';
      const displayName = attempt.display_name
        ? escapeHtml(attempt.display_name)
        : '<i>имя не указано</i>';
      const text =
        `👤 <b>Новая регистрация</b>\n` +
        `🪪 ${displayName}\n` +
        `📞 <code>${phone}</code>\n` +
        `🌍 IP: <code>${ip ?? '—'}</code>\n` +
        `🖥 UA: <code>${uaShort}</code>`;
      sendMessage({ channel: 'logs', text, disable_notification: true }).catch((err) =>
        logger.error({ err }, 'auth: failed to send new-registration notice'),
      );
    }

    // is_new_registration drives the Metrika `registration` goal — we
    // only want to count UNIQUE phones, not repeat logins from new
    // devices or after cookie wipe.
    return { ok: true, is_new_registration: isNew };
  });

  // ---------------- /auth/me ----------------
  app.get('/auth/me', async (req, _reply) => {
    const sid = req.cookies[SESSION_COOKIE];
    if (!sid) return { authenticated: false };
    const sess = findSession(sid);
    if (!sess) return { authenticated: false };
    touchSession(sid);
    return { authenticated: true, since: sess.created_at };
  });

  // ---------------- /auth/logout ----------------
  // Phase K — form-POST friendly: when a browser submits the form,
  // Accept includes 'text/html' and we 303-redirect to home. JSON
  // callers (curl / programmatic) still get { ok: true }.
  app.post('/auth/logout', async (req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    const acceptsHtml = (req.headers.accept ?? '').includes('text/html');
    if (acceptsHtml) {
      reply.code(303).header('location', '/').send();
      return;
    }
    return { ok: true };
  });
}

/** Helper for landing.ts: is this request authenticated?
 *  Sub-ms — unique-index lookup in local SQLite, touches last_seen_at. */
export function isAuthed(req: FastifyRequest): boolean {
  const sid = req.cookies?.[SESSION_COOKIE];
  if (!sid) return false;
  const sess = findSession(sid);
  if (!sess) return false;
  touchSession(sid);
  return true;
}

/** Auth-guard for cabinet pages — returns the registration row (with
 *  `id`, `phone`, etc.) if the session is valid, otherwise null. Caller
 *  should `reply.redirect('/strategies')` on null so the user lands on
 *  the OTP-gated registration form. Touches last_seen_at as a side
 *  effect. */
export function getAuthedUser(req: FastifyRequest): {
  userId: number;
  phone: string | null;
  displayName: string | null;
  createdAt: number;
  lastSeenAt: number;
} | null {
  const sid = req.cookies?.[SESSION_COOKIE];
  if (!sid) return null;
  const sess = findSession(sid);
  if (!sess) return null;
  touchSession(sid);
  return {
    userId: sess.id,
    phone: sess.phone ?? null,
    displayName: sess.display_name ?? null,
    createdAt: sess.created_at,
    lastSeenAt: sess.last_seen_at,
  };
}
