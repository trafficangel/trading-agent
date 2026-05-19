/**
 * CSRF protection — double-submit token pattern.
 *
 * Token = HMAC-SHA256(session_id, CSRF_SECRET) — deterministic per session,
 * so we don't need to store it in the DB. Issued to the browser as a
 * NON-HttpOnly cookie (so the form-rendering page can read it) and
 * expected back in a hidden form input on every state-changing POST.
 *
 * Why double-submit + deterministic-from-session instead of random+stored:
 *   - No DB roundtrip on every page render
 *   - Token rotates automatically when session rotates (e.g. on re-login)
 *   - Forged cookie alone is useless without matching body field (CORS
 *     prevents reading the cookie cross-origin), so the attacker would
 *     need a same-site XSS to read both — at which point CSRF is the
 *     least of our problems.
 *
 * Usage:
 *   1. In ANY route that renders a form, call `issueCsrfToken(req, reply)`
 *      → returns the token string, ALSO sets the `csrf` cookie.
 *      Embed as <input type="hidden" name="_csrf" value="..."> in form.
 *   2. In every state-changing POST handler that reads cookie session,
 *      call `requireCsrf(req, reply)` BEFORE acting. Returns true if
 *      valid, false if invalid (and already sent 403).
 */

import { createHmac } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { SESSION_COOKIE } from './session.js';

const COOKIE_NAME = 'csrf';
const BODY_FIELD = '_csrf';

/** Build a token from any identity string. Used for both session-based
 *  cabinet routes (identity = sessionId) and Basic-Auth admin routes
 *  (identity = "admin:" + adminEmail). */
function tokenFor(identity: string): string {
  return createHmac('sha256', config.CSRF_SECRET).update(identity).digest('hex');
}

/** Build an admin-scope CSRF token (Basic-Auth flow, no session cookie). */
export function adminCsrfToken(adminEmail: string): string {
  return tokenFor(`admin:${adminEmail}`);
}

/** Verify a token submitted from an admin form. */
export function requireAdminCsrf(
  req: FastifyRequest,
  reply: FastifyReply,
  adminEmail: string,
): boolean {
  const expected = tokenFor(`admin:${adminEmail}`);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const fromBody = typeof body[BODY_FIELD] === 'string' ? (body[BODY_FIELD] as string) : '';
  const fromHeader = (req.headers['x-csrf-token'] as string | undefined) ?? '';
  const provided = fromBody || fromHeader;
  if (!provided || provided.length !== expected.length) {
    reply.code(403).send('CSRF token missing');
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  if (mismatch !== 0) {
    reply.code(403).send('CSRF token invalid');
    return false;
  }
  return true;
}

/** Issue (or refresh) a CSRF cookie + return the matching token for
 *  embedding in form HTML. Idempotent — calling on every form render
 *  is fine and cheap.
 *
 *  If the request has no session cookie at all, returns empty string —
 *  unauthenticated forms (e.g. /auth/start) use their own anti-abuse
 *  mechanisms (rate-limit by IP) and don't need CSRF. */
export function issueCsrfToken(req: FastifyRequest, reply: FastifyReply): string {
  const sid = req.cookies?.[SESSION_COOKIE];
  if (!sid) return '';
  const token = tokenFor(sid);
  // 90-day cookie matching the session; non-HttpOnly so the form can
  // read it via JS for AJAX requests if we add those later.
  reply.setCookie(COOKIE_NAME, token, {
    path: '/',
    httpOnly: false,
    secure: true,
    sameSite: 'lax',
    maxAge: 90 * 24 * 60 * 60,
  });
  return token;
}

/** Verify the CSRF token on a state-changing POST. Reads from either
 *  the body field `_csrf` or the X-CSRF-Token header (for AJAX).
 *  On failure, sends 403 and returns false — caller should just `return`. */
export function requireCsrf(req: FastifyRequest, reply: FastifyReply): boolean {
  const sid = req.cookies?.[SESSION_COOKIE];
  if (!sid) {
    // No session at all — caller will redirect to auth, but never
    // mutate state. Treat as "no CSRF needed for unauthenticated flow".
    return true;
  }
  const expected = tokenFor(sid);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const fromBody = typeof body[BODY_FIELD] === 'string' ? (body[BODY_FIELD] as string) : '';
  const fromHeader = (req.headers['x-csrf-token'] as string | undefined) ?? '';
  const provided = fromBody || fromHeader;
  if (!provided || provided.length !== expected.length) {
    reply.code(403).send('CSRF token missing or malformed');
    return false;
  }
  // Constant-time comparison — preserves no timing side-channel.
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  if (mismatch !== 0) {
    reply.code(403).send('CSRF token invalid');
    return false;
  }
  return true;
}

/** Tiny HTML helper for embedding the hidden field in forms. */
export function csrfInput(token: string): string {
  if (!token) return '';
  return `<input type="hidden" name="${BODY_FIELD}" value="${token}" />`;
}
