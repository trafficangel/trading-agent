/**
 * Telegram Gateway API client.
 *
 * IMPORTANT: the correct base URL is `https://gatewayapi.telegram.org/`
 * (yes — "gatewayapi" as subdomain, NO `/api/` path prefix). The other
 * `gateway.telegram.org/api/...` is a different surface that always
 * returns "Bad request" for everything — discovered the hard way by
 * comparing with a working sibling project.
 *
 * Two flow patterns are supported by Gateway:
 *   A) Server-generated code   — we pass `code` param, Gateway delivers
 *      OUR code to the user. We verify locally by comparing strings.
 *      Simpler. No extra round-trip to Gateway for verification.
 *   B) Gateway-generated code  — we omit `code`, Gateway makes one,
 *      we later POST /checkVerificationStatus to verify.
 *
 * We use pattern A — matches our sibling project's implementation and
 * avoids an extra HTTPS call per login attempt.
 */

import crypto from 'node:crypto';
import { request } from 'undici';
import { logger } from '../lib/logger.js';

const API_BASE = 'https://gatewayapi.telegram.org';

function token(): string {
  const t = process.env.TELEGRAM_GATEWAY_TOKEN;
  if (!t) throw new Error('TELEGRAM_GATEWAY_TOKEN env var is not set');
  return t;
}

type GatewayResponse<T> = {
  ok: boolean;
  result?: T;
  error?: string;
};

export type SendResult = {
  request_id: string;
  /** The 6-digit code we generated and asked Gateway to deliver. We
   *  keep it server-side and compare against the user's input. */
  code: string;
  delivery_status?: {
    status: 'sent' | 'read' | 'revoked';
    updated_at: number;
  };
};

/** Generate a random N-digit code (default 6). */
function generateCode(length = 6): string {
  let s = '';
  for (let i = 0; i < length; i++) {
    s += crypto.randomInt(0, 10).toString();
  }
  return s;
}

/**
 * Send a verification code to the user. WE generate the code and pass
 * it to Gateway — Gateway just delivers it via Telegram. Returns the
 * generated code so the caller can persist it for later comparison.
 */
export async function sendVerificationMessage(
  phoneE164: string,
  opts: { ttl?: number; codeLength?: number } = {},
): Promise<SendResult> {
  const code = generateCode(opts.codeLength ?? 6);
  const ttl = opts.ttl ?? 300;
  const res = await request(`${API_BASE}/sendVerificationMessage`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      phone_number: phoneE164,
      code,
      ttl,
    }),
  });
  const json = (await res.body.json()) as GatewayResponse<{
    request_id: string;
    delivery_status?: { status: 'sent' | 'read' | 'revoked'; updated_at: number };
  }>;
  if (!json.ok || !json.result) {
    logger.error(
      {
        phone_redacted: phoneE164.slice(0, 4) + '***',
        status: res.statusCode,
        error: json.error,
      },
      'telegram-gateway: sendVerificationMessage failed',
    );
    throw new Error(`Gateway: ${json.error ?? 'unknown error'}`);
  }
  return {
    request_id: json.result.request_id,
    code,
    delivery_status: json.result.delivery_status,
  };
}

/**
 * Optionally revoke a pending code (e.g. on logout while pending). Not
 * strictly required — codes auto-expire after TTL. Used by /auth/start
 * when the user re-submits a new phone within the same browser session.
 */
export async function revokeVerificationMessage(requestId: string): Promise<void> {
  try {
    await request(`${API_BASE}/revokeVerificationMessage`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ request_id: requestId }),
    });
  } catch (err) {
    logger.warn({ err, request_id: requestId }, 'telegram-gateway: revoke failed (non-fatal)');
  }
}
