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
import {
  sendVerificationMessage,
  checkVerificationStatus,
} from './telegram-gateway.js';
import {
  hashPhone,
  registerOrRefresh,
  recordVerificationAttempt,
  getVerificationAttempt,
  clearVerificationAttempt,
  bumpVerificationAttempts,
  findSession,
  touchSession,
  SESSION_COOKIE,
  PENDING_COOKIE,
  SESSION_TTL_DAYS,
  PENDING_TTL_SEC,
} from './session.js';

const startSchema = z.object({
  phone: z.string().min(7).max(20),
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
  // Caddy is in front of us — uses X-Forwarded-For. Fastify
  // populates req.ip from that when trustProxy is set; we read both
  // to be safe across proxy configurations.
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
      return { ok: false, error: 'invalid_phone_format', message: 'Введите номер с кодом страны, например +79991234567' };
    }

    try {
      const res = await sendVerificationMessage(phoneE164);
      const phoneHash = hashPhone(phoneE164);
      const ua = (req.headers['user-agent'] as string | undefined) ?? null;
      recordVerificationAttempt(res.request_id, phoneHash, ip, ua);

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

    try {
      const result = await checkVerificationStatus(requestId, parsed.data.code);
      if (result.verification_status.status !== 'code_valid') {
        return { ok: false, error: 'code_invalid', status: result.verification_status.status };
      }
      // Code verified — promote to a session.
      const ip = clientIp(req);
      const ua = (req.headers['user-agent'] as string | undefined) ?? null;
      const { sessionId } = registerOrRefresh(attempt.phone_hash, ip, ua);
      clearVerificationAttempt(requestId);
      reply.clearCookie(PENDING_COOKIE, { path: '/' });
      reply.setCookie(SESSION_COOKIE, sessionId, {
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
      });
      logger.info({ request_id: requestId }, 'auth: session created');
      return { ok: true };
    } catch (err) {
      logger.error({ err, request_id: requestId }, 'auth: check verification failed');
      reply.code(500);
      return { ok: false, error: 'gateway_error' };
    }
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
  app.post('/auth/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
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
