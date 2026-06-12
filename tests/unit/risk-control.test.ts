import { describe, it, expect } from 'vitest';
import {
  decideBreaker,
  decideCooldown,
  decideProbation,
  BREAKER_BLOCK_MS,
  COOLDOWN_5M_MS,
  COOLDOWN_SLOW_MS,
  PROBATION_WINDOW,
  PROBATION_PROBE_MS,
} from '../../src/lib/risk-rules.js';

const H = 3600_000;
const T0 = Date.parse('2026-06-01T00:00:00Z');

describe('decideBreaker', () => {
  it('does not trip on zero or one hit', () => {
    expect(decideBreaker([], T0).blocked).toBe(false);
    expect(decideBreaker([{ symbol: 'BTCUSDT', closedAt: T0 - H }], T0).blocked).toBe(false);
  });

  it('does not trip on two hits on the SAME symbol', () => {
    const hits = [
      { symbol: 'BTCUSDT', closedAt: T0 - 2 * H },
      { symbol: 'BTCUSDT', closedAt: T0 - H },
    ];
    expect(decideBreaker(hits, T0).blocked).toBe(false);
  });

  it('trips on two cross-symbol hits within 24h and blocks for 48h after the later hit', () => {
    const hits = [
      { symbol: 'BTCUSDT', closedAt: T0 - 10 * H },
      { symbol: 'SOLUSDT', closedAt: T0 - H },
    ];
    const v = decideBreaker(hits, T0);
    expect(v.blocked).toBe(true);
    expect(v.until).toBe(T0 - H + BREAKER_BLOCK_MS);
    // ...and unblocks once the window passes.
    expect(decideBreaker(hits, T0 - H + BREAKER_BLOCK_MS + 1).blocked).toBe(false);
  });

  it('does not trip when cross-symbol hits are more than 24h apart', () => {
    const hits = [
      { symbol: 'BTCUSDT', closedAt: T0 - 30 * H },
      { symbol: 'SOLUSDT', closedAt: T0 - H },
    ];
    expect(decideBreaker(hits, T0).blocked).toBe(false);
  });

  it('June-2 scenario: four coins same day → blocked', () => {
    const hits = [
      { symbol: 'BTCUSDT', closedAt: T0 + 2 * H },
      { symbol: 'SOLUSDT', closedAt: T0 + 3 * H },
      { symbol: 'XRPUSDT', closedAt: T0 + 5 * H },
      { symbol: 'ETHUSDT', closedAt: T0 + 6 * H },
    ];
    const v = decideBreaker(hits, T0 + 7 * H);
    expect(v.blocked).toBe(true);
    expect(v.until).toBe(T0 + 6 * H + BREAKER_BLOCK_MS);
  });
});

describe('decideCooldown', () => {
  it('no hit → no block', () => {
    expect(decideCooldown(null, '5', T0).blocked).toBe(false);
  });

  it('5m strategy cools down 24h', () => {
    const hit = T0 - 23 * H;
    expect(decideCooldown(hit, '5', T0).blocked).toBe(true);
    expect(decideCooldown(hit, '5', hit + COOLDOWN_5M_MS + 1).blocked).toBe(false);
  });

  it('15m strategy cools down 48h', () => {
    const hit = T0 - 30 * H;
    expect(decideCooldown(hit, '15', T0).blocked).toBe(true);
    expect(decideCooldown(hit, '15', hit + COOLDOWN_SLOW_MS + 1).blocked).toBe(false);
  });
});

describe('decideProbation', () => {
  const mk = (pnls: number[], lastClosedAt: number) =>
    pnls.map((pnlPct, i) => ({ pnlPct, closedAt: lastClosedAt - i * H }));

  it('fewer than window trades → never blocks', () => {
    const v = decideProbation(mk([-2, -2, -2], T0 - H), T0);
    expect(v.blocked).toBe(false);
    expect(v.netPct).toBeNull();
  });

  it('healthy window → no block', () => {
    const v = decideProbation(mk(Array(PROBATION_WINDOW).fill(0.5), T0 - H), T0);
    expect(v.blocked).toBe(false);
    expect(v.netPct).not.toBeNull();
  });

  it('bad window blocks, then allows a probe after 72h idle', () => {
    const lastClosed = T0 - H;
    const trades = mk(Array(PROBATION_WINDOW).fill(-1), lastClosed); // -10 gross, way below -5 net
    expect(decideProbation(trades, T0).blocked).toBe(true);
    // Probe opens 72h after the last close.
    expect(decideProbation(trades, lastClosed + PROBATION_PROBE_MS - 1).blocked).toBe(true);
    expect(decideProbation(trades, lastClosed + PROBATION_PROBE_MS + 1).blocked).toBe(false);
  });

  it('commission pushes a borderline window over the edge', () => {
    // Gross -4.0 (above -5)… but -4.0 - 10×0.11 = -5.1 → blocked.
    const v = decideProbation(mk(Array(PROBATION_WINDOW).fill(-0.4), T0 - H), T0);
    expect(v.blocked).toBe(true);
  });
});
