/**
 * One-shot migration (TRACK E launch) — promote operator + Eldar to
 * VIP with override fields that preserve their CURRENT manual
 * configuration.
 *
 * After this script:
 *   - subscription.plan = 'vip', tier_id = 'vip'
 *   - tier_override_strategies = JSON list of currently-enabled
 *     strategy_ids from user_strategies
 *   - tier_override_margin = average margin per trade currently in use
 *     (notional / leverage, averaged across enabled strategies; if no
 *     strategies enabled, default to tier.starter margin per trade)
 *   - tier_override_leverage = JSON map { strategy_id: leverage }
 *
 * resolveUserTierParams in src/user/tier-assignment.ts reads these
 * override fields and short-circuits tier defaults, so existing user
 * settings continue to apply unchanged after deploy.
 *
 * Run (on VPS):
 *   pnpm tsx scripts/migrate-vip-overrides.ts --dry-run
 *   pnpm tsx scripts/migrate-vip-overrides.ts --apply
 */

import { db } from '../src/db/client.js';

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const dryRun = args.has('--dry-run') || !apply;

if (!apply && !dryRun) {
  console.error('Pass either --dry-run or --apply');
  process.exit(2);
}

// Phones to seed as VIP (operator + Eldar).
const VIP_PHONES = [
  '+79790359488', // Дмитрий (operator)
  '+994515545888', // Эльдар
];

type RegRow = {
  id: number;
  phone: string;
  display_name: string | null;
};

type StratRow = {
  strategy_id: string;
  notional_usd: number;
  leverage: number;
};

const findUserByPhoneStmt = db.prepare<[string], RegRow>(
  `SELECT id, phone, display_name FROM registrations WHERE phone = ? LIMIT 1`,
);

const listEnabledStmt = db.prepare<[number], StratRow>(
  `SELECT strategy_id, notional_usd, leverage FROM user_strategies WHERE user_id = ? AND enabled = 1`,
);

const updateSubStmt = db.prepare(`
  UPDATE user_subscriptions
     SET plan = 'vip',
         tier_id = 'vip',
         tier_override_strategies = ?,
         tier_override_margin = ?,
         tier_override_leverage = ?,
         updated_at = ?
   WHERE user_id = ?
`);

let touched = 0;
for (const phone of VIP_PHONES) {
  const user = findUserByPhoneStmt.get(phone);
  if (!user) {
    console.log(`[skip] no registration for ${phone}`);
    continue;
  }
  const strategies = listEnabledStmt.all(user.id);
  if (strategies.length === 0) {
    console.log(`[skip] ${phone} (user_id=${user.id}) has no enabled strategies`);
    continue;
  }
  const strategyIds = strategies.map((s) => s.strategy_id);
  // Average margin per trade across enabled strategies.
  const avgMargin =
    strategies.reduce((acc, s) => acc + s.notional_usd / Math.max(1, s.leverage), 0) /
    strategies.length;
  const leverageMap: Record<string, number> = {};
  for (const s of strategies) leverageMap[s.strategy_id] = s.leverage;

  console.log(`[plan] ${phone} (user_id=${user.id}, name=${user.display_name ?? '—'}):`);
  console.log(`  strategies: ${strategyIds.join(', ')}`);
  console.log(`  avgMargin: $${avgMargin.toFixed(2)}`);
  console.log(`  leverageMap: ${JSON.stringify(leverageMap)}`);

  if (apply) {
    updateSubStmt.run(
      JSON.stringify(strategyIds),
      avgMargin,
      JSON.stringify(leverageMap),
      Date.now(),
      user.id,
    );
    touched++;
    console.log(`  ✅ applied`);
  }
}

if (apply) {
  console.log(`\nDone. Updated ${touched} subscription row(s).`);
} else {
  console.log(`\nDry run only. Re-run with --apply to write changes.`);
}
