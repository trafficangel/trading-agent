export type HlOwnedPosition = {
  coin: string;
  side: 'long' | 'short';
  owner: 'hl-momentum' | 'wick-fade' | 'hl-bybit-arb';
};

export type HlExchangePositionRef = {
  coin: string;
  side: 'long' | 'short';
};

export type HlOwnershipIssue = {
  kind: 'duplicate-owner' | 'unowned-exchange' | 'missing-exchange' | 'side-mismatch';
  coin: string;
  detail: string;
};

export function auditHlPositionOwnership(
  exchangePositions: HlExchangePositionRef[],
  ownedPositions: HlOwnedPosition[],
): { ok: boolean; issues: HlOwnershipIssue[] } {
  const issues: HlOwnershipIssue[] = [];
  const exchange = new Map(exchangePositions.map((p) => [p.coin, p]));
  const owners = new Map<string, HlOwnedPosition[]>();
  for (const position of ownedPositions) {
    const list = owners.get(position.coin) ?? [];
    list.push(position);
    owners.set(position.coin, list);
  }

  for (const [coin, list] of owners) {
    if (list.length > 1) {
      issues.push({ kind: 'duplicate-owner', coin, detail: `${coin}: duplicate DB owners ${list.map((p) => p.owner).join(', ')}` });
      continue;
    }
    const owner = list[0]!;
    const position = exchange.get(coin);
    if (!position) {
      issues.push({ kind: 'missing-exchange', coin, detail: `${coin}: ${owner.owner} position missing on exchange` });
    } else if (position.side !== owner.side) {
      issues.push({ kind: 'side-mismatch', coin, detail: `${coin}: ${owner.owner} ${owner.side}, exchange ${position.side}` });
    }
  }

  for (const position of exchangePositions) {
    if (!owners.has(position.coin)) {
      issues.push({ kind: 'unowned-exchange', coin: position.coin, detail: `${position.coin}: unowned exchange ${position.side} position` });
    }
  }

  return { ok: issues.length === 0, issues };
}
