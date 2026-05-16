/**
 * Telegram Gateway API client.
 *
 * docs: https://core.telegram.org/gateway
 *
 * Two endpoints used:
 *   POST /api/sendVerificationMessage  → deliver code via Telegram
 *   POST /api/checkVerificationStatus  → verify the code the user entered
 *
 * Auth: Bearer token in `TELEGRAM_GATEWAY_TOKEN` env. NEVER log it.
 * Pricing: ~$0.01 per delivered+verified message (free if user never
 * submits the code). Keep an eye on volume.
 */

import { request } from 'undici';
import { logger } from '../lib/logger.js';

const API_BASE = 'https://gateway.telegram.org/api';

function token(): string {
  const t = process.env.TELEGRAM_GATEWAY_TOKEN;
  if (!t) throw new Error('TELEGRAM_GATEWAY_TOKEN env var is not set');
  return t;
}

/** Common Gateway response wrapper. */
type GatewayResponse<T> = {
  ok: boolean;
  result?: T;
  error?: string;
};

export type SendVerificationResult = {
  request_id: string;
  phone_number: string;
  request_cost: number;
  remaining_balance?: number;
  delivery_status: {
    status: 'sent' | 'read' | 'revoked';
    updated_at: number;
  };
  verification_status?: unknown;
  payload?: string;
};

/**
 * Send a verification code to a phone number via Telegram.
 * code_length=6, ttl=300 (5 min). We let Gateway generate the code —
 * we never see it. Verification happens via checkVerificationStatus.
 */
export async function sendVerificationMessage(
  phoneE164: string,
  opts: { codeLength?: number; ttl?: number } = {},
): Promise<SendVerificationResult> {
  const body = {
    phone_number: phoneE164,
    code_length: opts.codeLength ?? 6,
    ttl: opts.ttl ?? 300,
  };
  const res = await request(`${API_BASE}/sendVerificationMessage`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = (await res.body.json()) as GatewayResponse<SendVerificationResult>;
  if (!json.ok || !json.result) {
    logger.error(
      {
        phone_redacted: phoneE164.slice(0, 4) + '***',
        status: res.statusCode,
        error: json.error,
        full: json,
      },
      'telegram-gateway: sendVerificationMessage failed',
    );
    // "Bad request" with HTTP 200 means the token/account itself is invalid
    // (no balance, wrong token, etc.) — Gateway uses generic message.
    const hint = json.error === 'Bad request'
      ? 'Gateway отклонил запрос — возможно нулевой баланс или невалидный токен'
      : `Gateway error: ${json.error ?? 'unknown'}`;
    throw new Error(hint);
  }
  return json.result;
}

export type CheckVerificationResult = {
  request_id: string;
  phone_number: string;
  verification_status: {
    status: 'code_valid' | 'code_invalid' | 'code_max_attempts_exceeded' | 'expired';
    updated_at: number;
  };
};

/**
 * Verify the code the user submitted. Returns the status from Gateway.
 * `code_valid` = success; anything else = failure (caller decides UX).
 */
export async function checkVerificationStatus(
  requestId: string,
  code: string,
): Promise<CheckVerificationResult> {
  const res = await request(`${API_BASE}/checkVerificationStatus`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ request_id: requestId, code }),
  });
  const json = (await res.body.json()) as GatewayResponse<CheckVerificationResult>;
  if (!json.ok || !json.result) {
    logger.error(
      { request_id: requestId, error: json.error },
      'telegram-gateway: checkVerificationStatus failed',
    );
    throw new Error(`Gateway error: ${json.error ?? 'unknown'}`);
  }
  return json.result;
}
