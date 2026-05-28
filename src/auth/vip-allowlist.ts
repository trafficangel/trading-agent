/**
 * Track D — comp (Спецдоступ) phone allowlist.
 *
 * Phones listed here are auto-promoted to plan='comp' (permanent free
 * access) the FIRST time they complete phone-OTP registration. After
 * promotion the allowlist is no longer consulted for that user — admin
 * can grant / revoke Спецдоступ via /admin manually.
 *
 * Format: E.164 strings (e.g. '+994515545888'). Trim and use
 * matchPhone() to compare — anything else (spaces, dashes, parens)
 * is stripped before equality check.
 *
 * Why a code-level allowlist (not env var):
 *   - Audit trail via git diff — every addition/removal is a commit
 *   - Short list (operator's personal contacts), no rotation needed
 *   - Env var would be a single comma-joined string which is fiddly to edit
 *
 * If the list grows beyond ~20 entries, migrate to a DB table.
 */

const VIP_PHONES: ReadonlySet<string> = new Set([
  // Эльдар — первый бета-тестер, бесплатный доступ в обмен на feedback.
  '+994515545888',
]);

/** Normalise a phone string to E.164-ish (digits with leading +) so we
 *  can compare ignoring whitespace / dashes / parens. */
function normalise(p: string): string {
  return p.replace(/[\s\-()]/g, '');
}

/** Returns true if the phone is on the VIP allowlist. Safe to call
 *  with null / empty strings (returns false). */
export function isVipPhone(phone: string | null | undefined): boolean {
  if (!phone) return false;
  return VIP_PHONES.has(normalise(phone));
}
