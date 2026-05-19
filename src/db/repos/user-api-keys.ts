/**
 * user_api_keys repo — encrypted Bybit credentials per user.
 *
 * Plaintext never returned by this module's "list" helpers. Use
 * `getDecryptedKey(userId)` only inside the exchange-call code path,
 * never persist the plaintext after the call returns.
 */

import { db } from '../client.js';
import { encryptSecret, decryptSecret } from '../../auth/crypto.js';

export type ApiKeyRow = {
  id: number;
  user_id: number;
  exchange: string;
  api_key_encrypted: string;
  api_secret_encrypted: string;
  iv: string;
  auth_tag: string;
  created_at: number;
  last_verified_at: number | null;
  last_verify_error: string | null;
  revoked_at: number | null;
};

/** Public view (no secrets) for cabinet / admin UI. */
export type ApiKeySummary = {
  id: number;
  user_id: number;
  exchange: string;
  created_at: number;
  last_verified_at: number | null;
  last_verify_error: string | null;
  revoked_at: number | null;
  /** Convenience flag for templates. */
  is_active: boolean;
};

const insertStmt = db.prepare(`
  INSERT INTO user_api_keys
    (user_id, exchange, api_key_encrypted, api_secret_encrypted, iv, auth_tag, created_at, last_verified_at, last_verify_error)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateKeyStmt = db.prepare(`
  UPDATE user_api_keys
     SET api_key_encrypted = ?, api_secret_encrypted = ?, iv = ?, auth_tag = ?,
         last_verified_at = ?, last_verify_error = ?, revoked_at = NULL
   WHERE user_id = ? AND exchange = ?
`);

const findByUserStmt = db.prepare<[number, string], ApiKeyRow>(`
  SELECT * FROM user_api_keys
   WHERE user_id = ? AND exchange = ? AND revoked_at IS NULL
   LIMIT 1
`);

const findByUserAnyStmt = db.prepare<[number, string], ApiKeyRow>(`
  SELECT * FROM user_api_keys
   WHERE user_id = ? AND exchange = ?
   LIMIT 1
`);

const revokeStmt = db.prepare(`
  UPDATE user_api_keys SET revoked_at = ? WHERE id = ?
`);

const updateVerifyStmt = db.prepare(`
  UPDATE user_api_keys
     SET last_verified_at = ?, last_verify_error = ?
   WHERE id = ?
`);

/**
 * Insert a new (encrypted) key, or update if one already exists for
 * this (user, exchange). Replacing a key un-revokes the row — the user
 * just rotated their credentials and wants to keep trading.
 *
 * The {apiKey, apiSecret} are plaintext on input; they're encrypted
 * inside this function. The plaintext is not retained.
 */
export function upsertApiKey(input: {
  userId: number;
  exchange?: string;
  apiKey: string;
  apiSecret: string;
  verifiedAt: number | null;
  verifyError: string | null;
}): void {
  const exchange = input.exchange ?? 'bybit';
  const encKey = encryptSecret(input.apiKey);
  const encSecret = encryptSecret(input.apiSecret);
  // For row-level integrity we store ONE iv+tag pair — but we have two
  // encrypted fields with their own (different) iv+tag. We pack the
  // secret's iv+tag alongside the key's iv+tag by joining with ':'.
  // Format: `${keyIv}:${secretIv}` and `${keyTag}:${secretTag}`.
  const iv = `${encKey.iv}:${encSecret.iv}`;
  const tag = `${encKey.authTag}:${encSecret.authTag}`;

  const existing = findByUserAnyStmt.get(input.userId, exchange);
  const now = Date.now();
  if (existing) {
    updateKeyStmt.run(
      encKey.ciphertext,
      encSecret.ciphertext,
      iv,
      tag,
      input.verifiedAt,
      input.verifyError,
      input.userId,
      exchange,
    );
  } else {
    insertStmt.run(
      input.userId,
      exchange,
      encKey.ciphertext,
      encSecret.ciphertext,
      iv,
      tag,
      now,
      input.verifiedAt,
      input.verifyError,
    );
  }
}

export function findActiveKey(userId: number, exchange = 'bybit'): ApiKeyRow | null {
  return findByUserStmt.get(userId, exchange) ?? null;
}

export function findAnyKey(userId: number, exchange = 'bybit'): ApiKeyRow | null {
  return findByUserAnyStmt.get(userId, exchange) ?? null;
}

export function summaryOf(row: ApiKeyRow | null): ApiKeySummary | null {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    exchange: row.exchange,
    created_at: row.created_at,
    last_verified_at: row.last_verified_at,
    last_verify_error: row.last_verify_error,
    revoked_at: row.revoked_at,
    is_active: row.revoked_at === null && row.last_verified_at !== null,
  };
}

/** Decrypt and return {apiKey, apiSecret} for the exchange-call path.
 *  CALLER must not retain the plaintext beyond the immediate API call. */
export function getDecryptedCreds(
  row: ApiKeyRow,
): { apiKey: string; apiSecret: string } {
  const ivParts = row.iv.split(':');
  const tagParts = row.auth_tag.split(':');
  if (ivParts.length !== 2 || tagParts.length !== 2) {
    throw new Error(`api-key row ${row.id}: malformed iv/auth_tag (expected 2 colon-joined parts)`);
  }
  const [keyIv, secretIv] = ivParts as [string, string];
  const [keyTag, secretTag] = tagParts as [string, string];
  const apiKey = decryptSecret({
    ciphertext: row.api_key_encrypted,
    iv: keyIv,
    authTag: keyTag,
  });
  const apiSecret = decryptSecret({
    ciphertext: row.api_secret_encrypted,
    iv: secretIv,
    authTag: secretTag,
  });
  return { apiKey, apiSecret };
}

export function revokeApiKey(id: number): void {
  revokeStmt.run(Date.now(), id);
}

export function recordVerifyResult(
  id: number,
  ok: boolean,
  error?: string | null,
): void {
  updateVerifyStmt.run(ok ? Date.now() : null, ok ? null : error ?? 'unknown_error', id);
}
