/**
 * HYPERLIQUID VAULT SCORER (recon/research) — pulls the full vault universe
 * from HL's public stats API, filters to live + credible vaults, fetches each
 * one's allTime equity curve + follower book, and scores them on RISK-ADJUSTED
 * return + an HONESTY filter (do real depositors actually profit?).
 *
 * HL API is NOT geo-blocked → runs locally or on the VPS. Read-only public data.
 * Usage: pnpm tsx scripts/hl-vaults.ts [minTvl] [minAgeDays]
 * Writes data/hl-vaults-scored.json.
 *
 * Metrics (all from public data, no look-ahead concern — descriptive):
 *   - retDD   = total $PnL / max $ drawdown of the cumulative-PnL curve (MAR-like)
 *   - maxDDpct= max drawdown as % of peak account value
 *   - sharpe  = mean/std of per-interval returns (deltaPnL / accountValue), ann.
 *   - follWin = % of (sampled) followers with positive all-time PnL  ← honesty
 *   - ageD, tvl, apr, commission(profit-share), nFollowers
 * Hard cuts for the GOOD shortlist: open, tvl≥minTvl, age≥minAge, maxDDpct≤35,
 *   follWin≥60%, retDD≥2, apr>0.
 */

const LISTING = 'https://stats-data.hyperliquid.xyz/Mainnet/vaults';
const INFO = 'https://api.hyperliquid.xyz/info';
const MIN_TVL = Number(process.argv[2] ?? 500_000);
const MIN_AGE_DAYS = Number(process.argv[3] ?? 120);
const NOW = Date.now();

type Listing = { apr: number; summary: { name: string; vaultAddress: string; leader: string; tvl: string; isClosed: boolean; relationship: { type: string }; createTimeMillis: number } };
type Hist = [number, string][];
type Period = { accountValueHistory: Hist; pnlHistory: Hist };
type Follower = { user: string; vaultEquity: string; allTimePnl: string; daysFollowing: number };
type Details = { name: string; leader: string; apr: number; isClosed: boolean; leaderCommission?: number; leaderFraction?: number; portfolio: [string, Period][]; followers: Follower[]; relationship?: { type: string } };

async function post(body: unknown): Promise<Details | null> {
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(INFO, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (r.ok) return (await r.json()) as Details;
      if (r.status === 429) await new Promise((res) => setTimeout(res, 600 * (a + 1)));
    } catch { await new Promise((res) => setTimeout(res, 400 * (a + 1))); }
  }
  return null;
}

function maxDD(cum: number[]): number { let peak = -Infinity, dd = 0; for (const v of cum) { if (v > peak) peak = v; if (peak - v > dd) dd = peak - v; } return dd; }

function score(d: Details): { totalPnl: number; maxDDusd: number; maxDDpct: number; retDD: number; sharpe: number } | null {
  const all = d.portfolio.find((p) => p[0] === 'allTime')?.[1];
  if (!all || all.pnlHistory.length < 10) return null;
  const pnl = all.pnlHistory.map((x) => Number(x[1]));
  const acct = all.accountValueHistory.map((x) => Number(x[1]));
  const totalPnl = pnl[pnl.length - 1]! - pnl[0]!;
  const maxDDusd = maxDD(pnl);
  const peakAcct = Math.max(...acct, 1);
  const maxDDpct = (maxDDusd / peakAcct) * 100;
  // per-interval returns normalised by contemporaneous account value
  const rets: number[] = [];
  for (let i = 1; i < pnl.length; i++) { const av = acct[i] || acct[i - 1] || 0; if (av > 0) rets.push((pnl[i]! - pnl[i - 1]!) / av); }
  const mean = rets.reduce((s, r) => s + r, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length || 1)) || 1e-9;
  const sharpe = (mean / sd) * Math.sqrt(rets.length || 1);
  return { totalPnl: Math.round(totalPnl), maxDDusd: Math.round(maxDDusd), maxDDpct: Math.round(maxDDpct * 10) / 10, retDD: Math.round((totalPnl / (maxDDusd || 1)) * 100) / 100, sharpe: Math.round(sharpe * 100) / 100 };
}

(async () => {
  console.log(`Fetching vault universe… (minTvl $${MIN_TVL.toLocaleString()}, minAge ${MIN_AGE_DAYS}d)`);
  const listing = (await (await fetch(LISTING)).json()) as Listing[];
  const live = listing.filter((v) => v.summary && !v.summary.isClosed && Number(v.summary.tvl) >= MIN_TVL && (NOW - v.summary.createTimeMillis) / 86_400_000 >= MIN_AGE_DAYS && v.summary.relationship?.type === 'normal');
  console.log(`Universe ${listing.length} → live & credible ${live.length}. Fetching details…`);

  const sorted = live.sort((a, b) => Number(b.summary.tvl) - Number(a.summary.tvl)).slice(0, 250);
  const rows: any[] = [];
  for (let i = 0; i < sorted.length; i += 8) {
    const batch = sorted.slice(i, i + 8);
    const details = await Promise.all(batch.map((v) => post({ type: 'vaultDetails', vaultAddress: v.summary.vaultAddress })));
    for (let j = 0; j < batch.length; j++) {
      const v = batch[j]!; const d = details[j];
      if (!d) continue;
      const sc = score(d);
      if (!sc) continue;
      const follWin = d.followers.length ? Math.round((d.followers.filter((f) => Number(f.allTimePnl) > 0).length / d.followers.length) * 100) : 0;
      const ageD = Math.round((NOW - v.summary.createTimeMillis) / 86_400_000);
      rows.push({ name: v.summary.name.slice(0, 30), addr: v.summary.vaultAddress, leader: d.leader, tvl: Math.round(Number(v.summary.tvl)), apr: Math.round(v.apr * 100), ageD, comm: Math.round((d.leaderCommission ?? d.leaderFraction ?? 0) * 100), nFoll: d.followers.length, follWin, ...sc });
    }
    process.stderr.write(`  …${Math.min(i + 8, sorted.length)}/${sorted.length}\n`);
  }

  const { writeFileSync } = await import('node:fs');
  writeFileSync('data/hl-vaults-scored.json', JSON.stringify(rows, null, 2));

  const good = rows.filter((r) => r.maxDDpct <= 35 && r.follWin >= 60 && r.retDD >= 2 && r.apr > 0 && r.nFoll >= 10)
    .sort((a, b) => b.retDD - a.retDD);
  const fmt = (r: any) => `${(r.follWin >= 60 && r.retDD >= 2 && r.maxDDpct <= 35 ? '✅' : '  ')} ${r.name.padEnd(30)} $${String((r.tvl / 1e6).toFixed(1)).padStart(6)}M  ${String(r.ageD).padStart(4)}d  apr ${String(r.apr).padStart(5)}%  retDD ${String(r.retDD).padStart(6)}  DD ${String(r.maxDDpct).padStart(5)}%  sharpe ${String(r.sharpe).padStart(5)}  follWin ${String(r.follWin).padStart(3)}% (n${r.nFoll})  comm ${r.comm}%`;

  console.log(`\n===== ALL scored (top 30 by retDD) — ${rows.length} vaults =====`);
  console.log(rows.sort((a, b) => b.retDD - a.retDD).slice(0, 30).map(fmt).join('\n'));
  console.log(`\n===== GOOD shortlist (DD≤35%, follWin≥60%, retDD≥2, apr+, n≥10) — ${good.length} =====`);
  console.log(good.length ? good.map(fmt).join('\n') : '  — none passed —');
  console.log(`\nFull dump → data/hl-vaults-scored.json. NOTE: descriptive stats on PAST data; not a promise. Survivorship & blow-up risk apply (see HLP/JELLY Mar-2025).`);
})().catch((e) => { console.error(e); process.exit(1); });
