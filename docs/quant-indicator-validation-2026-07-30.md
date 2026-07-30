# Quant indicator validation — 2026-07-30

## Objective

Build a simple, symmetric, non-repainting 5-minute strategy in LuxAlgo Quant
for zero-commission Lighter, then validate it independently before creating
alerts or adding it to Shadow.

Common execution assumptions:

- completed candles only;
- signal on bar close, fill at the next bar open;
- no pyramiding or same-bar reversal;
- zero exchange commission;
- 0.05% base and 0.10% stressed round-trip spread/slippage;
- one shared parameter set across every coin;
- first 70% of BTC/ETH/SOL used for selection;
- last 30% of BTC/ETH/SOL is time-OOS;
- XRP/DOGE/SUI are untouched transfer-OOS symbols.

The independent sample contains 365 days and 105,120 five-minute candles per
symbol.

## Candidate 1 — Lighter ATR Donchian Dual

Quant hypothesis: EMA regime plus prior-channel breakout, ATR stop/target and
time exit.

The least-bad shared neighborhood was Donchian 18, trend separation 0.1 ATR,
2.5 ATR stop, 2.5R target and 144-bar time exit.

| Scope | Result after 0.05% RT costs |
|---|---|
| Train BTC / ETH / SOL | PF 0.97 / 0.97 / 1.03 |
| Time-OOS BTC / ETH / SOL | PF 0.80 / 0.86 / 0.80 |
| Transfer XRP / DOGE / SUI | PF 0.94 / 0.93 / 0.83 |

Verdict: **REJECT**. The next-bar delay removes the apparent breakout edge.

## Candidate 2 — Lighter Volatility Reversion Dual

Quant hypothesis: fade a one-ATR stretch beyond an EMA after a completed
reversal candle; exit on the mean, ATR safety stop or time stop.

LuxAlgo's short chart window showed 328 trades and PF 1.183, but the independent
365-day test found approximately zero gross expectancy. After the base
execution cost every train and validation symbol was negative.

| Scope | PF range after 0.05% RT costs |
|---|---:|
| Train BTC / ETH / SOL | 0.78–0.85 |
| Time-OOS BTC / ETH / SOL | 0.80–0.93 |
| Transfer XRP / DOGE / SUI | 0.86–0.96 |

Verdict: **REJECT**.

## Candidate 3 — Lighter Volume Exhaustion Reversion Dual

Quant added a causal exhaustion filter: the stretched event candle must have
volume at least 1.5× the mean of the 20 completed bars before it. The event
candle is excluded from its own baseline.

LuxAlgo's short chart window improved to 195 trades and PF 1.219, but the
independent result again failed everywhere:

| Scope | PF range after 0.05% RT costs |
|---|---:|
| Train BTC / ETH / SOL | 0.78–0.85 |
| Time-OOS BTC / ETH / SOL | 0.75–0.93 |
| Transfer XRP / DOGE / SUI | 0.85–0.94 |

Verdict: **REJECT**.

## Decision

No alert and no Shadow strategy were created. The 17-day Quant preview is too
short and materially overstates robustness. Adding either candidate would
increase activity but reduce expected value.

Reproducible runners:

- `scripts/test-quant-atr-donchian.ts`
- `scripts/test-quant-volatility-reversion.ts`

