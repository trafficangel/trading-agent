/**
 * Hourly, read-only forward shadow for the exploratory true-pairs basket.
 * It imports public Hyperliquid market-data functions only and cannot place orders.
 */

import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { request } from 'undici';
import {
  candleSnapshot,
  fundingHistory,
  l2Book,
  type HlCandle,
  type HlFunding,
} from '../src/exchange/hyperliquid.js';
import {
  fitLogPair,
  pairEntryPrices,
  pairExitPrices,
  pairFundingCarryPct,
  pairResidualZ,
  pairTradeGrossPct,
  TRUE_PAIRS_HOURLY_EPOCH_MS,
  type PairFit,
  type PairTopOfBook,
} from '../src/lib/true-pairs.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const FEE_RT_PCT = 0.09;
const MAX_OPEN_PAIRS = 2;
const STATE_PATH = process.env.TRUE_PAIRS_SHADOW_STATE ?? 'data/true-pairs-shadow.json';
const AUDIT_PATH = process.env.TRUE_PAIRS_SHADOW_AUDIT ?? 'data/true-pairs-shadow-trades.ndjson';
const NOTIFY = process.env.TRUE_PAIRS_SHADOW_NOTIFY !== 'false';

type Candidate = {
  id: string;
  a: string;
  b: string;
  formationBars: number;
  tradeBars: number;
  entryZ: number;
  exitZ: number;
  stopZ: number;
  maxHoldBars: number;
};

// Frozen before forward collection. Historical evidence is exploratory, not a live gate.
const CANDIDATES: Candidate[] = [
  {
    id: 'XRP_SOL_H60',
    a: 'XRP',
    b: 'SOL',
    formationBars: 60 * 24,
    tradeBars: 14 * 24,
    entryZ: 2,
    exitZ: 0.25,
    stopZ: 4,
    maxHoldBars: 7 * 24,
  },
  {
    id: 'LINK_ETH_H90',
    a: 'LINK',
    b: 'ETH',
    formationBars: 90 * 24,
    tradeBars: 30 * 24,
    entryZ: 2.5,
    exitZ: 0.5,
    stopZ: 4,
    maxHoldBars: 14 * 24,
  },
  {
    id: 'DOGE_SOL_H90',
    a: 'DOGE',
    b: 'SOL',
    formationBars: 90 * 24,
    tradeBars: 30 * 24,
    entryZ: 2.5,
    exitZ: 0.5,
    stopZ: 4,
    maxHoldBars: 14 * 24,
  },
  {
    id: 'AAVE_LINK_H60',
    a: 'AAVE',
    b: 'LINK',
    formationBars: 60 * 24,
    tradeBars: 14 * 24,
    entryZ: 2,
    exitZ: 0.25,
    stopZ: 4,
    maxHoldBars: 7 * 24,
  },
];

type Position = {
  direction: 1 | -1;
  beta: number;
  entryAt: number;
  entryBarAt: number;
  aEntry: number;
  bEntry: number;
  zEntry: number;
};

type CandidateState = {
  fit?: PairFit;
  fitAt?: number;
  nextRefitAt?: number;
  lastBarAt?: number;
  invalidReason?: string;
  position?: Position;
  completedTrades: number;
  cumulativeNetPct: number;
};

type ShadowState = {
  version: 1;
  startedAt: number;
  startedNotified: boolean;
  lastRunAt?: number;
  candidates: Record<string, CandidateState>;
};

type AlignedClose = { t: number; a: number; b: number };
type EntryProposal = {
  candidate: Candidate;
  runtime: CandidateState;
  z: number;
  barAt: number;
  score: number;
};
type ExitReason = 'mean' | 'z-stop' | 'time' | 'rebalance';

function formationWindow(
  latestBarAt: number,
  candidate: Candidate,
): { start: number; end: number; next: number } | null {
  const firstEnd = TRUE_PAIRS_HOURLY_EPOCH_MS + candidate.formationBars * HOUR_MS;
  if (latestBarAt < firstEnd) return null;
  const block = Math.floor((latestBarAt - firstEnd) / (candidate.tradeBars * HOUR_MS));
  const start = TRUE_PAIRS_HOURLY_EPOCH_MS + block * candidate.tradeBars * HOUR_MS;
  const end = start + candidate.formationBars * HOUR_MS;
  return { start, end, next: end + candidate.tradeBars * HOUR_MS };
}

function freshState(): ShadowState {
  return {
    version: 1,
    startedAt: Date.now(),
    startedNotified: false,
    candidates: Object.fromEntries(
      CANDIDATES.map((candidate) => [candidate.id, { completedTrades: 0, cumulativeNetPct: 0 }]),
    ),
  };
}

function loadState(): ShadowState {
  if (!existsSync(STATE_PATH)) return freshState();
  const state = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as ShadowState;
  if (state.version !== 1 || typeof state.candidates !== 'object')
    throw new Error('unsupported true-pairs shadow state');
  for (const candidate of CANDIDATES) {
    state.candidates[candidate.id] ??= { completedTrades: 0, cumulativeNetPct: 0 };
  }
  return state;
}

function saveState(state: ShadowState): void {
  const temp = `${STATE_PATH}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temp, STATE_PATH);
}

function audit(event: Record<string, unknown>): void {
  appendFileSync(AUDIT_PATH, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

async function notify(opts: { text: string; disable_notification?: boolean }): Promise<void> {
  if (!NOTIFY) return;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHANNEL_LOGS;
  if (!token || !chatId) throw new Error('shadow Telegram credentials are missing');
  const response = await request(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: opts.text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      disable_notification: opts.disable_notification ?? false,
    }),
  });
  const body = (await response.body.json()) as { ok: boolean; description?: string };
  if (!body.ok)
    throw new Error(`shadow Telegram send failed: ${body.description ?? response.statusCode}`);
}

function asClosedCandles(rows: HlCandle[], now: number): HlCandle[] {
  return rows.filter((row) => row.T <= now && Number(row.c) > 0).sort((a, b) => a.t - b.t);
}

function align(a: HlCandle[], b: HlCandle[]): AlignedClose[] {
  const byTime = new Map(b.map((bar) => [bar.t, Number(bar.c)]));
  return a.flatMap((bar) => {
    const bClose = byTime.get(bar.t);
    return bClose && Number(bar.c) > 0 ? [{ t: bar.t, a: Number(bar.c), b: bClose }] : [];
  });
}

function usableFit(fit: PairFit | null, candidate: Candidate): fit is PairFit {
  return (
    fit !== null &&
    fit.beta >= 0.2 &&
    fit.beta <= 2.5 &&
    fit.returnCorrelation >= 0.6 &&
    fit.halfLifeBars >= 6 &&
    fit.halfLifeBars <= candidate.maxHoldBars / 2
  );
}

function topOfBook(levels: Awaited<ReturnType<typeof l2Book>>['levels']): PairTopOfBook {
  const bid = Number(levels[0][0]?.px);
  const ask = Number(levels[1][0]?.px);
  if (!(bid > 0) || !(ask > bid)) throw new Error(`invalid top of book: bid=${bid}, ask=${ask}`);
  return { bid, ask };
}

function fundingByHour(rows: HlFunding[], after: number, through: number): Map<number, number> {
  const result = new Map<number, number>();
  for (const row of rows) {
    if (row.time <= after || row.time > through) continue;
    result.set(Math.floor(row.time / HOUR_MS) * HOUR_MS, Number(row.fundingRate));
  }
  return result;
}

async function fundingCarry(
  candidate: Candidate,
  position: Position,
  exitAt: number,
): Promise<{ pct: number; coverage: number }> {
  const [aRows, bRows] = await Promise.all([
    fundingHistory(candidate.a, position.entryAt),
    fundingHistory(candidate.b, position.entryAt),
  ]);
  const a = fundingByHour(aRows, position.entryAt, exitAt);
  const b = fundingByHour(bRows, position.entryAt, exitAt);
  const hours: number[] = [];
  const firstHour = Math.floor(position.entryAt / HOUR_MS) * HOUR_MS + HOUR_MS;
  const lastHour = Math.floor(exitAt / HOUR_MS) * HOUR_MS;
  for (let hour = firstHour; hour <= lastHour; hour += HOUR_MS) hours.push(hour);
  const matched = hours.filter((hour) => a.has(hour) && b.has(hour));
  const pct = pairFundingCarryPct({
    direction: position.direction,
    beta: position.beta,
    aRates: matched.map((hour) => a.get(hour)!),
    bRates: matched.map((hour) => b.get(hour)!),
  });
  return { pct, coverage: hours.length ? matched.length / hours.length : 1 };
}

function activeAssets(state: ShadowState): Set<string> {
  const result = new Set<string>();
  for (const candidate of CANDIDATES) {
    if (!state.candidates[candidate.id]?.position) continue;
    result.add(candidate.a);
    result.add(candidate.b);
  }
  return result;
}

function openCount(state: ShadowState): number {
  return CANDIDATES.filter((candidate) => state.candidates[candidate.id]?.position).length;
}

async function closePosition(args: {
  candidate: Candidate;
  runtime: CandidateState;
  books: Map<string, PairTopOfBook>;
  exitAt: number;
  exitBarAt: number;
  z: number;
  reason: ExitReason;
}): Promise<void> {
  const position = args.runtime.position;
  if (!position) return;
  const prices = pairExitPrices(
    position.direction,
    args.books.get(args.candidate.a)!,
    args.books.get(args.candidate.b)!,
  );
  const grossPct = pairTradeGrossPct({
    direction: position.direction,
    beta: position.beta,
    aEntry: position.aEntry,
    aExit: prices.a,
    bEntry: position.bEntry,
    bExit: prices.b,
  });
  const funding = await fundingCarry(args.candidate, position, args.exitAt);
  const netPct = grossPct - FEE_RT_PCT + funding.pct;
  const holdHours = Math.max(0, Math.round((args.exitBarAt - position.entryBarAt) / HOUR_MS));
  args.runtime.completedTrades += 1;
  args.runtime.cumulativeNetPct += netPct;
  delete args.runtime.position;
  audit({
    event: 'exit',
    pair: `${args.candidate.a}/${args.candidate.b}`,
    model: args.candidate.id,
    reason: args.reason,
    direction: position.direction,
    beta: position.beta,
    zEntry: position.zEntry,
    zExit: args.z,
    holdHours,
    aEntry: position.aEntry,
    bEntry: position.bEntry,
    aExit: prices.a,
    bExit: prices.b,
    grossPct,
    feePct: FEE_RT_PCT,
    fundingPct: funding.pct,
    fundingCoverage: funding.coverage,
    netPct,
  });
  await notify({
    text: `<b>PAIRS SHADOW · EXIT</b>\n${escapeHtml(args.candidate.a)}/${escapeHtml(args.candidate.b)} · ${args.reason}\nNet: <b>${netPct >= 0 ? '+' : ''}${netPct.toFixed(3)}%</b> · gross ${grossPct.toFixed(3)}% · funding ${funding.pct.toFixed(3)}%\nZ ${position.zEntry.toFixed(2)} → ${args.z.toFixed(2)} · ${holdHours}h\nСделок: ${args.runtime.completedTrades} · сумма: ${args.runtime.cumulativeNetPct.toFixed(3)}%\n<i>Только shadow, реальных ордеров нет.</i>`,
  });
}

async function main(): Promise<void> {
  const now = Date.now();
  const state = loadState();
  const coins = [...new Set(CANDIDATES.flatMap((candidate) => [candidate.a, candidate.b]))];
  const historyStart = now - 130 * DAY_MS;
  const candleRows = await Promise.all(
    coins.map(
      async (coin) =>
        [coin, asClosedCandles(await candleSnapshot(coin, '1h', historyStart, now), now)] as const,
    ),
  );
  const candles = new Map(candleRows);
  const bookRows = await Promise.all(
    coins.map(async (coin) => [coin, topOfBook((await l2Book(coin)).levels)] as const),
  );
  const books = new Map(bookRows);
  const proposals: EntryProposal[] = [];

  for (const candidate of CANDIDATES) {
    const runtime = state.candidates[candidate.id]!;
    const rows = align(candles.get(candidate.a) ?? [], candles.get(candidate.b) ?? []);
    const latest = rows.at(-1);
    if (!latest || rows.length < candidate.formationBars + 1 || runtime.lastBarAt === latest.t)
      continue;
    const window = formationWindow(latest.t, candidate);
    if (!window) continue;

    let rebalanced = false;
    if (
      runtime.position &&
      runtime.fit &&
      runtime.nextRefitAt &&
      latest.t >= runtime.nextRefitAt - HOUR_MS
    ) {
      const oldZ = pairResidualZ(latest.a, latest.b, runtime.fit);
      await closePosition({
        candidate,
        runtime,
        books,
        exitAt: now,
        exitBarAt: latest.t,
        z: oldZ,
        reason: 'rebalance',
      });
      rebalanced = true;
    }
    const refitDue = runtime.fitAt !== window.end;
    if (refitDue) {
      if (runtime.position) {
        const oldZ = pairResidualZ(latest.a, latest.b, runtime.fit!);
        await closePosition({
          candidate,
          runtime,
          books,
          exitAt: now,
          exitBarAt: latest.t,
          z: oldZ,
          reason: 'rebalance',
        });
        rebalanced = true;
      }
      const formation = rows.filter((bar) => bar.t >= window.start && bar.t < window.end);
      const fit = fitLogPair(
        formation.map((bar) => bar.a),
        formation.map((bar) => bar.b),
      );
      const rejectionReason =
        formation.length !== candidate.formationBars
          ? `formation bars ${formation.length}/${candidate.formationBars}`
          : fit
            ? `quality corr=${fit.returnCorrelation.toFixed(3)} beta=${fit.beta.toFixed(3)} hl=${fit.halfLifeBars.toFixed(1)}`
            : 'fit failed';
      runtime.fitAt = window.end;
      runtime.nextRefitAt = window.next;
      if (formation.length === candidate.formationBars && usableFit(fit, candidate)) {
        runtime.fit = fit;
        delete runtime.invalidReason;
        audit({
          event: 'fit',
          model: candidate.id,
          pair: `${candidate.a}/${candidate.b}`,
          fitAt: window.end,
          fit,
        });
      } else {
        delete runtime.fit;
        runtime.invalidReason = rejectionReason;
        audit({
          event: 'fit_rejected',
          model: candidate.id,
          pair: `${candidate.a}/${candidate.b}`,
          fitAt: window.end,
          reason: runtime.invalidReason,
        });
      }
    }

    runtime.lastBarAt = latest.t;
    if (!runtime.fit) continue;
    const z = pairResidualZ(latest.a, latest.b, runtime.fit);
    if (!Number.isFinite(z)) continue;

    if (runtime.position && !rebalanced) {
      const adverseStop =
        runtime.position.direction === 1 ? z <= -candidate.stopZ : z >= candidate.stopZ;
      const reverted =
        runtime.position.direction === 1 ? z >= -candidate.exitZ : z <= candidate.exitZ;
      const timedOut = latest.t - runtime.position.entryBarAt >= candidate.maxHoldBars * HOUR_MS;
      const reason: ExitReason | null = adverseStop
        ? 'z-stop'
        : reverted
          ? 'mean'
          : timedOut
            ? 'time'
            : null;
      if (reason)
        await closePosition({
          candidate,
          runtime,
          books,
          exitAt: now,
          exitBarAt: latest.t,
          z,
          reason,
        });
      continue;
    }

    const finalBlockBar = latest.t >= window.next - HOUR_MS;
    if (
      !runtime.position &&
      !rebalanced &&
      !finalBlockBar &&
      Math.abs(z) >= candidate.entryZ &&
      Math.abs(z) < candidate.stopZ
    ) {
      proposals.push({
        candidate,
        runtime,
        z,
        barAt: latest.t,
        score: Math.abs(z) / candidate.entryZ,
      });
    }
  }

  proposals.sort((a, b) => b.score - a.score);
  const usedAssets = activeAssets(state);
  for (const proposal of proposals) {
    const { candidate, runtime, z, barAt } = proposal;
    if (
      openCount(state) >= MAX_OPEN_PAIRS ||
      usedAssets.has(candidate.a) ||
      usedAssets.has(candidate.b)
    ) {
      audit({
        event: 'entry_blocked_capacity',
        model: candidate.id,
        pair: `${candidate.a}/${candidate.b}`,
        z,
      });
      continue;
    }
    const direction: 1 | -1 = z < 0 ? 1 : -1;
    const prices = pairEntryPrices(direction, books.get(candidate.a)!, books.get(candidate.b)!);
    runtime.position = {
      direction,
      beta: runtime.fit!.beta,
      entryAt: now,
      entryBarAt: barAt,
      aEntry: prices.a,
      bEntry: prices.b,
      zEntry: z,
    };
    usedAssets.add(candidate.a);
    usedAssets.add(candidate.b);
    audit({
      event: 'entry',
      model: candidate.id,
      pair: `${candidate.a}/${candidate.b}`,
      direction,
      beta: runtime.fit!.beta,
      z,
      aEntry: prices.a,
      bEntry: prices.b,
    });
    const legs =
      direction === 1
        ? `LONG ${candidate.a} / SHORT ${candidate.b}`
        : `SHORT ${candidate.a} / LONG ${candidate.b}`;
    await notify({
      text: `<b>PAIRS SHADOW · ENTRY</b>\n${escapeHtml(candidate.a)}/${escapeHtml(candidate.b)} · ${legs}\nZ: <b>${z.toFixed(2)}</b> · beta ${runtime.fit!.beta.toFixed(3)}\nBBO: ${candidate.a} ${prices.a} · ${candidate.b} ${prices.b}\n<i>Только shadow, реальных ордеров нет.</i>`,
    });
  }

  if (!state.startedNotified) {
    await notify({
      disable_notification: true,
      text: `<b>TRUE PAIRS FORWARD SHADOW ЗАПУЩЕН</b>\n4 замороженные модели · 1h · реальные HL BBO и funding\nМаксимум ${MAX_OPEN_PAIRS} пары, общий актив нельзя использовать дважды.\n<i>Контур read-only: приватные ключи и функции ордеров не подключены.</i>`,
    });
    state.startedNotified = true;
  }
  state.lastRunAt = now;
  saveState(state);
  console.log(
    JSON.stringify(
      {
        at: new Date(now).toISOString(),
        openPairs: openCount(state),
        proposals: proposals.length,
        candidates: CANDIDATES.map((candidate) => ({
          id: candidate.id,
          invalidReason: state.candidates[candidate.id]?.invalidReason,
          position: state.candidates[candidate.id]?.position ?? null,
          completedTrades: state.candidates[candidate.id]?.completedTrades ?? 0,
          cumulativeNetPct: state.candidates[candidate.id]?.cumulativeNetPct ?? 0,
        })),
      },
      null,
      2,
    ),
  );
}

void main().catch((error) => {
  audit({ event: 'run_error', error: error instanceof Error ? error.message : String(error) });
  console.error(error);
  process.exitCode = 1;
});
