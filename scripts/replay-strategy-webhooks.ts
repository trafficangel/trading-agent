/**
 * Operator script — replay all historical Track C webhooks into the
 * Logs channel.
 *
 * Going forward (post-deploy of luxalgo.route.ts edit) every incoming
 * Track C webhook is mirrored to the Logs channel. But for the rows
 * that landed BEFORE that change, we have only the decisions table —
 * this script reconstructs synthetic webhook log lines from those rows.
 *
 * For each Track C decision:
 *   - 1 entry-webhook log (from raw_response stored at insert time)
 *   - 1 exit-webhook log if force_close_reason='strategy_exit'
 *     (the exit webhook wasn't separately persisted; we synthesise
 *      from close_price + closed_at)
 *
 * Usage:
 *   pnpm tsx scripts/replay-strategy-webhooks.ts            # publish to logs
 *   pnpm tsx scripts/replay-strategy-webhooks.ts --dry-run  # print only
 *
 * Rate-limited to 1 msg/sec so we don't trip Telegram bot API limits
 * (channel posts: 20/min for the same chat).
 */

import { db } from '../src/db/client.js';
import { sendMessage } from '../src/telegram/bot.js';
import { formatStrategyWebhookLog } from '../src/strategies/strategy-trader.js';
import type { LuxAlgoStrategyPayload } from '../src/webhooks/luxalgo.schema.js';

type Row = {
  id: number;
  symbol: string;
  side: string | null;
  entry: number | null;
  close_price: number | null;
  status: string;
  created_at: number;
  closed_at: number | null;
  filled_at: number | null;
  strategy_id: string | null;
  strategy_trade_num: number | null;
  raw_response: string | null;
  close_reason: string | null;
  force_close_reason: string | null;
};

const rows = db.prepare<[], Row>(`
  SELECT id, symbol, side, entry, close_price, status, created_at, closed_at,
         filled_at, strategy_id, strategy_trade_num, raw_response,
         close_reason, force_close_reason
  FROM decisions
  WHERE track = 'strategy'
  ORDER BY created_at ASC
`).all();

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  console.error(`Found ${rows.length} Track C decision rows.`);

  let posted = 0;
  for (const r of rows) {
    if (!r.strategy_id || !r.side) continue;

    // ---------- Synthesise ENTRY webhook from raw_response ----------
    let entryPayload: LuxAlgoStrategyPayload;
    try {
      const raw = r.raw_response ? JSON.parse(r.raw_response) : {};
      // raw might be the EXACT original webhook body if luxalgo.route
      // saved it that way. Fall back to reconstruction.
      entryPayload = {
        kind: 'strategy',
        strategy_id: r.strategy_id,
        action: 'entry',
        side: r.side as 'long' | 'short',
        strategy_event: r.side === 'long' ? 'long' : 'short',
        symbol: r.symbol,
        timeframe: String(raw.timeframe ?? '15'),
        price: r.entry ?? undefined,
        bar_time: raw.bar_time ?? r.created_at,
      } as LuxAlgoStrategyPayload;
    } catch {
      continue;
    }
    const entryLog = formatStrategyWebhookLog(
      entryPayload,
      { ok: true, decisionId: r.id },
      r.strategy_trade_num,
    );
    const entryHeader = `<i>(replay · #${r.id})</i>\n` + entryLog;

    if (dryRun) {
      console.log('--- ENTRY ---');
      console.log(entryHeader);
      console.log();
    } else {
      await sendMessage({ channel: 'logs', text: entryHeader, disable_notification: true });
      await new Promise((r) => setTimeout(r, 1000));
      posted++;
    }

    // ---------- Synthesise EXIT webhook ----------
    // Only if exit was strategy-driven (not safety SL).
    if (r.status === 'closed' && r.force_close_reason === 'strategy_exit' && r.closed_at) {
      const exitPayload: LuxAlgoStrategyPayload = {
        kind: 'strategy',
        strategy_id: r.strategy_id,
        action: 'exit',
        side: r.side as 'long' | 'short',
        strategy_event: r.side === 'long' ? 'exit_long' : 'exit_short',
        symbol: r.symbol,
        timeframe: String((r.raw_response && JSON.parse(r.raw_response).timeframe) || '15'),
        price: r.close_price ?? undefined,
        bar_time: r.closed_at,
      } as LuxAlgoStrategyPayload;
      const exitLog = formatStrategyWebhookLog(
        exitPayload,
        { ok: true, decisionId: r.id },
        r.strategy_trade_num,
      );
      const exitHeader = `<i>(replay · #${r.id})</i>\n` + exitLog;
      if (dryRun) {
        console.log('--- EXIT ---');
        console.log(exitHeader);
        console.log();
      } else {
        await sendMessage({ channel: 'logs', text: exitHeader, disable_notification: true });
        await new Promise((r) => setTimeout(r, 1000));
        posted++;
      }
    }
  }
  console.error(`Done. ${dryRun ? 'Would post' : 'Posted'} ${posted} messages.`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
