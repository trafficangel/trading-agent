/**
 * Symmetric encryption for client API keys (Track D — SaaS copytrading).
 *
 * Algorithm: AES-256-GCM with per-row random 12-byte IV and 16-byte
 * authentication tag. The 32-byte master key is loaded once at boot
 * from process.env.API_KEY_MASTER_SECRET (64 hex chars). Without it
 * the server refuses to start — see src/config.ts.
 *
 * Storage format (in DB, all base64 / hex strings):
 *   - ciphertext: base64 of AES output
 *   - iv:         12 random bytes, hex-encoded (24 chars)
 *   - authTag:    16-byte GCM tag, hex-encoded (32 chars)
 *
 * Both API key and API secret are encrypted INDEPENDENTLY (separate
 * IV + tag for each field). Storing them together with one IV would
 * leak length structure across the two fields.
 *
 * Threat model: see migration 016 header comment.
 *
 * Master key generation:
 *   $ openssl rand -hex 32
 *   → put result into .env as API_KEY_MASTER_SECRET=...
 *
 * Rotation: re-encrypt all rows in a one-off script. Keep the old
 * key around in API_KEY_MASTER_SECRET_LEGACY for the duration of
 * the rotation, then drop it.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { config } from '../config.js';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12; // GCM standard
const KEY_LEN = 32; // AES-256
const TAG_LEN = 16;

/** Lazy-decoded master key. Cached after first access. */
let masterKey: Buffer | null = null;

function getMasterKey(): Buffer {
  if (masterKey) return masterKey;
  const hex = config.API_KEY_MASTER_SECRET;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    // Should be caught by zod in config.ts, but defence-in-depth.
    throw new Error('API_KEY_MASTER_SECRET must be exactly 64 hex chars (32 bytes)');
  }
  masterKey = Buffer.from(hex, 'hex');
  if (masterKey.length !== KEY_LEN) {
    throw new Error(`API_KEY_MASTER_SECRET decoded to ${masterKey.length} bytes, expected ${KEY_LEN}`);
  }
  return masterKey;
}

export type EncryptedField = {
  /** base64 of AES-256-GCM ciphertext */
  ciphertext: string;
  /** hex(12 random bytes) — must be unique per encryption call */
  iv: string;
  /** hex(16 bytes) — GCM authentication tag */
  authTag: string;
};

/** Encrypt a plaintext API key / secret. Returns the 3-tuple for DB storage. */
export function encryptSecret(plaintext: string): EncryptedField {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('encryptSecret: plaintext must be a non-empty string');
  }
  const key = getMasterKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: enc.toString('base64'),
    iv: iv.toString('hex'),
    authTag: tag.toString('hex'),
  };
}

/** Decrypt a stored ciphertext + iv + authTag back to plaintext.
 *  Throws on tampering (authTag mismatch) — caller MUST handle this
 *  as a hard failure, not a "wrong password" retry path. */
export function decryptSecret(enc: EncryptedField): string {
  const key = getMasterKey();
  const iv = Buffer.from(enc.iv, 'hex');
  const tag = Buffer.from(enc.authTag, 'hex');
  if (iv.length !== IV_LEN) throw new Error(`decryptSecret: bad IV length ${iv.length}`);
  if (tag.length !== TAG_LEN) throw new Error(`decryptSecret: bad authTag length ${tag.length}`);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const ct = Buffer.from(enc.ciphertext, 'base64');
  const dec = Buffer.concat([decipher.update(ct), decipher.final()]);
  return dec.toString('utf8');
}

/** Constant-time comparison helper for diagnostic / verify flows.
 *  Use this when you need to check "did the user type the same key
 *  twice?" without leaking timing info — encrypted comparison in DB
 *  would be O(N) on storage with no security benefit. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Round-trip sanity check at boot: encrypt + decrypt a fixed string.
 *  If something is wrong with the master key (e.g. truncated env var,
 *  wrong hex encoding) we surface it at startup, not on first real
 *  decrypt attempt months later when keys are already in DB. */
export function selfTest(): void {
  const sample = 'self-test-' + Date.now();
  const enc = encryptSecret(sample);
  const dec = decryptSecret(enc);
  if (dec !== sample) {
    throw new Error('crypto self-test failed: round-trip mismatch');
  }
}

/** Audit C4 — stronger self-test that also decrypts an EXISTING user
 *  api-key row at boot. The basic selfTest() only verifies the master
 *  key is well-formed and round-trip-stable for FRESH ciphertexts; it
 *  does NOT catch the catastrophic case where the master key has been
 *  rotated/replaced and the existing DB rows are no longer decryptable.
 *
 *  Picks one random unrevoked row, attempts decrypt of both api_key
 *  and api_secret. If decryption fails (authTag mismatch / wrong key)
 *  we throw — server refuses to start, preserving the encrypted blob
 *  intact and giving the operator a chance to restore the right key
 *  before any new orders are placed (or attempted decrypts mid-flight
 *  destroy log clarity).
 *
 *  No rows in DB → no-op (fresh deploy). */
export function selfTestExistingRow(
  decryptOneRow: () => { apiKey: string; apiSecret: string } | null,
): void {
  let creds;
  try {
    creds = decryptOneRow();
  } catch (err) {
    throw new Error(
      `crypto self-test (existing row) FAILED: ${(err as Error).message}. ` +
        `Master key cannot decrypt stored API keys. Likely cause: ` +
        `API_KEY_MASTER_SECRET was rotated without re-encrypting rows. ` +
        `Restore the original master key from backup before starting.`,
    );
  }
  if (creds && (!creds.apiKey || !creds.apiSecret)) {
    throw new Error('crypto self-test (existing row): decrypted to empty fields');
  }
  // creds === null → no rows, fresh deploy, OK.
}
