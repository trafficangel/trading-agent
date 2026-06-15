/**
 * Forward-gate + decay detector (pure, testable). Turns a lab strategy's
 * PAPER stats into a promotion verdict:
 *   collecting      — too few paper trades yet
 *   underperforming — paper net is ≤0 (edge not showing forward)
 *   diverging       — paper is positive but well below the backtest per-trade
 *                     expectancy (edge decaying)
 *   confirming      — paper positive & on track, but < READY_MIN trades
 *   ready           — paper positive over ≥ READY_MIN trades & matches backtest
 *                     → promotion candidate
 *
 * The promotion bar (CLAUDE.md): ≥15–20 net-positive paper trades matching the
 * backtest, then flip fanOut / add to the live book.
 */

export type GateStatus = 'collecting' | 'underperforming' | 'diverging' | 'confirming' | 'ready';

export type GateVerdict = { status: GateStatus; emoji: string; label: string };

const MIN_EVAL = 8;     // below this we can't say anything
const READY_MIN = 15;   // promotion-ready sample size
const DECAY_FRAC = 0.4; // paper < this × backtest per-trade ⇒ decaying

export function labGateVerdict(p: {
  closed: number;
  netPct: number;            // total paper net % (sum, net of commission)
  winRate: number | null;
  btNetPctPerTrade?: number; // backtest reference net %/trade (optional)
}): GateVerdict {
  if (p.closed < MIN_EVAL) return { status: 'collecting', emoji: '⏳', label: `копит данные (${p.closed}/${READY_MIN})` };
  if (p.netPct <= 0) return { status: 'underperforming', emoji: '🔴', label: `минус на бумаге (${p.closed} сделок)` };

  const expPerTrade = p.netPct / p.closed;
  const decaying = p.btNetPctPerTrade != null && p.btNetPctPerTrade > 0 && expPerTrade < DECAY_FRAC * p.btNetPctPerTrade;
  if (decaying) return { status: 'diverging', emoji: '🟠', label: `плюс, но сильно ниже бэктеста — затухание?` };

  if (p.closed >= READY_MIN) return { status: 'ready', emoji: '✅', label: `подтверждён вперёд — кандидат на промоут` };
  return { status: 'confirming', emoji: '🟢', label: `подтверждается (${p.closed}/${READY_MIN})` };
}
