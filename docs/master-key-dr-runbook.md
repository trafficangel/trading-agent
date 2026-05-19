# Master-Key Disaster Recovery Runbook

**Critical:** `API_KEY_MASTER_SECRET` is the AES-256 key that encrypts every
client's Bybit API key + secret. Lose it and we **cannot decrypt any client
key** → cannot close open positions, cannot react to exit webhooks, clients'
funds are stuck on Bybit with our position-based SLs being their only
protection until they revoke the key manually.

This document defines: (1) how to back it up, (2) how to detect a problem,
(3) how to recover.

---

## 1. Generating + storing the master key

### First-time setup

```bash
openssl rand -hex 32
# → 64-char hex string, copy it
```

Write it into `.env` on the VPS as:
```
API_KEY_MASTER_SECRET=<64 hex chars>
```

The server validates format at boot (`src/config.ts` zod schema, required
`/^[0-9a-fA-F]{64}$/`) and refuses to start if it's malformed.

### Backup locations (all REQUIRED, not optional)

The key MUST exist in at least **three** independent places — failure of any
two leaves us recoverable:

| # | Location | How |
|---|----------|-----|
| 1 | VPS `.env` | live config, loaded at boot |
| 2 | **Personal 1Password / Bitwarden vault** of the operator | label `robot-claude-master-key`, note: date generated + VPS hostname |
| 3 | **Offline encrypted backup** (GPG-encrypted file on a USB stick, or paper print in a sealed envelope) | refresh every 6 months when key rotates |

**Never** commit the key to any git repo, send via Telegram/email, paste
into a chat, or store in any cloud doc unless GPG-encrypted with a key the
operator personally holds.

### After rotation

Bump `.env` AND re-write all three backups the same day. Older copies become
useless and dangerous (someone could resurrect them later).

---

## 2. Detection — how we know something is wrong

### At boot (automatic)

Server runs **two** self-tests before accepting connections:

1. `cryptoSelfTest()` (src/auth/crypto.ts) — encrypts + decrypts a fresh
   sample string. Catches: malformed hex, wrong length, OpenSSL broken.
2. `cryptoSelfTestRow()` — picks one random unrevoked `user_api_keys` row
   and decrypts both fields. Catches: master key rotated without
   re-encryption, env-var was truncated/swapped after deploy. **This is
   the line of defence against the C4 disaster scenario.**

If either fails → `process.exit(1)` with a fatal log line. systemd will
restart-loop the service. Operator MUST notice and intervene.

### In production (runtime)

Any `getDecryptedCreds()` failure triggers `alertOperatorCritical()` (with
notification, not silent) in `user-fanout.ts`. The message tells you the
user_id; cross-reference with admin panel to see what they have on Bybit.

### Manual probe

```bash
ssh trading-vps
sudo -u trader bash -c 'cd /home/trader/apps/trading-agent && \
  node -e "
    import(\"./dist/db/repos/user-api-keys.js\").then(async (m) => {
      const r = m.pickRandomActiveKey();
      if (!r) { console.log(\"no rows\"); process.exit(0); }
      const c = m.getDecryptedCreds(r);
      console.log(\"OK, decrypted row id=\" + r.id + \", apiKey starts with \" + c.apiKey.slice(0, 4));
    });
  "'
```

---

## 3. Recovery scenarios

### Scenario A: `.env` was edited, key truncated/swapped, recoverable from backup

1. Open backup #2 (password manager) → copy correct hex
2. SSH to VPS: `sudo -u trader vim /home/trader/apps/trading-agent/.env`
3. Replace `API_KEY_MASTER_SECRET=...`
4. `sudo systemctl restart trading-agent`
5. Watch logs: `journalctl -u trading-agent -n 50` — confirm both
   self-tests pass and no `process.exit(1)`

### Scenario B: VPS rebuilt, `.env` lost, but backups intact

1. Re-deploy code (`git clone` + `pnpm install` + `pnpm build`)
2. Re-create `.env` from backup #2 — make sure ALL other secrets
   (TELEGRAM_BOT_TOKEN, CSRF_SECRET, OTP_PEPPER, ADMIN_PASSWORD_HASH,
   etc.) are also restored, otherwise other parts fail.
3. Restore SQLite from latest backup (see deployment.md)
4. Start service → self-tests will confirm encryption matches

### Scenario C: Master key TRULY lost (all 3 backups gone)

This is the worst case. Encrypted columns are unrecoverable.

**Immediate actions (in order):**

1. **DO NOT start the service.** Boot will fail self-test anyway but in
   case the test passes coincidentally (fresh hex matches stored ciphertext
   by 1 in 2^256 chance — i.e. never), starting could write more rows we
   can't decrypt.

2. **Send a Telegram message to every active user** asking them to log
   into Bybit and **revoke their API key manually**. Template:
   > Robot Claude operations: технический сбой со стороны нашей
   > инфраструктуры. Просим немедленно зайти в Bybit → Profile → API
   > и удалить ключ с именем «Robot Claude». Открытые позиции (если есть)
   > останутся на бирже с защитным стопом — закройте их вручную в
   > удобный момент. Сервис будет восстановлен, попросим заново
   > подключить ключ. Извинения.

3. Generate a new master key (`openssl rand -hex 32`) → store in all 3
   backups freshly.

4. SQL: `UPDATE user_api_keys SET revoked_at = strftime('%s', 'now') * 1000
   WHERE revoked_at IS NULL;` — soft-delete all encrypted rows so the new
   self-test is no-op (no active rows to decrypt).

5. Start service.

6. Notify users to re-add their key via `/account/api-key`. Issue a
   subscription extension as goodwill compensation (`UPDATE user_subscriptions
   SET access_until = access_until + 30 * 86400000` or via admin UI).

7. Post-mortem: figure out which backup process failed and document a
   replacement (e.g. add weekly automated check that backup #3 USB is
   still readable).

---

## 4. Key rotation (planned, low risk)

When rotating proactively (e.g. compromise scare, annual hygiene):

1. Generate new key: `NEW=$(openssl rand -hex 32)`
2. Edit `.env`:
   ```
   API_KEY_MASTER_SECRET=<new>
   API_KEY_MASTER_SECRET_LEGACY=<old>
   ```
3. Write a one-off script `scripts/rotate-master-key.ts` (does not exist
   yet — to be written when rotation is actually needed):
   - SELECT all user_api_keys rows
   - For each row: decrypt with LEGACY, encrypt with NEW, UPDATE in TX
   - Verify by re-reading and comparing
4. Remove `API_KEY_MASTER_SECRET_LEGACY` from `.env` after script confirms
   all rows re-encrypted. Restart service.
5. Update all 3 backups (#2 password manager, #3 offline encrypted).
6. Run boot self-test manually as final check.

**Do NOT skip step 5.** If you rotate the live key but leave backup #2
showing the old key, the next "restore from backup" will brick everything.

---

## 5. Adjacent risks worth noting

- **SQLite backup MUST include the encrypted blob.** A backup that includes
  every table EXCEPT user_api_keys is useless. Verify the backup script
  (currently `/home/trader/apps/trading-agent/scripts/*` if any) does a
  full file copy of `data/trading.sqlite`, not per-table SELECT.

- **The encrypted blob alone is NOT a backup of the master key.** The
  ciphertext is meaningless without the key. Don't conflate "I have the DB
  in S3" with "I can recover" — you need DB + master key together.

- **Operator handover.** When the operator role transfers, all three
  backup locations must be re-issued to the new owner, AND the old owner's
  copies must be securely destroyed (1Password vault transferred, USB
  stick wiped/burned).
