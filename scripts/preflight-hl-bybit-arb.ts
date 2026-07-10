/**
 * Read-only credential and account preflight for the HL <-> Bybit arb pilot.
 *
 * Required env:
 *   BYBIT_API_KEY, BYBIT_API_SECRET, HL_ACCOUNT_ADDRESS, HL_API_WALLET_KEY
 *
 * This script never submits an exchange action. Its JSON output is deliberately
 * redacted so it is safe to retain in an operator log.
 */
import { createHmac } from 'node:crypto';
import { InfoClient, HttpTransport } from '@nktkas/hyperliquid';
import { privateKeyToAccount } from 'viem/accounts';

const BYBIT_API = 'https://api.bybit.com';
const RECV_WINDOW = '5000';

type BybitEnvelope<T> = { retCode: number; retMsg: string; result?: T };

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function bybitGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const apiKey = required('BYBIT_API_KEY');
  const apiSecret = required('BYBIT_API_SECRET');
  const query = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  const timestamp = String(Date.now());
  const signature = createHmac('sha256', apiSecret)
    .update(timestamp + apiKey + RECV_WINDOW + query)
    .digest('hex');
  const response = await fetch(`${BYBIT_API}${path}${query ? `?${query}` : ''}`, {
    headers: {
      'X-BAPI-API-KEY': apiKey,
      'X-BAPI-SIGN': signature,
      'X-BAPI-SIGN-TYPE': '2',
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-RECV-WINDOW': RECV_WINDOW,
    },
    signal: AbortSignal.timeout(8_000),
  });
  const body = await response.json() as BybitEnvelope<T>;
  if (!response.ok || body.retCode !== 0 || !body.result) {
    throw new Error(`Bybit ${path}: ${body.retCode} ${body.retMsg}`);
  }
  return body.result;
}

async function main(): Promise<void> {
  const hlAccount = required('HL_ACCOUNT_ADDRESS').toLowerCase() as `0x${string}`;
  const signer = privateKeyToAccount(required('HL_API_WALLET_KEY') as `0x${string}`);
  const info = new InfoClient({ transport: new HttpTransport({ isTestnet: false }) });

  const [wallet, fundingWallet, positions, api, role, agents, clearing, spot] = await Promise.all([
    bybitGet<{
      list?: Array<{ totalEquity?: string; totalAvailableBalance?: string }>;
    }>('/v5/account/wallet-balance', { accountType: 'UNIFIED' }),
    bybitGet<{
      balance?: Array<{ coin: string; walletBalance?: string; transferBalance?: string }>;
    }>('/v5/asset/transfer/query-account-coins-balance', { accountType: 'FUND', coin: 'USDT' })
      .catch(() => null),
    bybitGet<{
      list?: Array<{ symbol: string; side: string; size: string; avgPrice: string }>;
    }>('/v5/position/list', { category: 'linear', settleCoin: 'USDT' }),
    bybitGet<{
      readOnly?: number; ips?: string[];
      permissions?: Record<string, string[]>;
    }>('/v5/user/query-api'),
    info.userRole({ user: signer.address }),
    info.extraAgents({ user: hlAccount }).catch(() => []),
    info.clearinghouseState({ user: hlAccount }),
    info.spotClearinghouseState({ user: hlAccount }).catch(() => null),
  ]);

  const bybitAccount = wallet.list?.[0];
  const bybitFundingUsdt = fundingWallet?.balance?.find((balance) => balance.coin === 'USDT');
  const bybitPositions = (positions.list ?? []).filter((position) => Number(position.size) !== 0);
  const derivativesPermissions = [
    ...(api.permissions?.ContractTrade ?? []),
    ...(api.permissions?.Derivatives ?? []),
  ];
  const hlPositions = clearing.assetPositions
    .filter((row) => Number(row.position.szi) !== 0)
    .map((row) => ({ coin: row.position.coin, side: Number(row.position.szi) > 0 ? 'long' : 'short' }));
  const spotUsdc = spot?.balances.find((balance) => balance.coin === 'USDC');
  const hlEquity = Number(clearing.marginSummary.accountValue)
    + (spotUsdc ? Math.max(0, Number(spotUsdc.total) - Number(spotUsdc.hold)) : 0);
  const roleMaster = role.role === 'agent' ? role.data.user.toLowerCase() : null;
  const approvedAgent = agents.find((agent) => agent.address.toLowerCase() === signer.address.toLowerCase());

  console.log(JSON.stringify({
    checkedAt: new Date().toISOString(),
    bybit: {
      mainnet: true,
      totalEquityUsd: Number(bybitAccount?.totalEquity ?? 0),
      availableUsd: Number(bybitAccount?.totalAvailableBalance ?? 0),
      fundingWalletUsdt: bybitFundingUsdt ? Number(bybitFundingUsdt.walletBalance ?? 0) : null,
      canTradeDerivatives: api.readOnly === 0 && derivativesPermissions.some((permission) =>
        permission === 'Order' || permission === 'DerivativesTrade'),
      withdrawalPermissionPresent: Object.entries(api.permissions ?? {}).some(([group, permissions]) =>
        group.toLowerCase().includes('wallet') && permissions.length > 0),
      ipWhitelistCount: api.ips?.length ?? 0,
      openPositions: bybitPositions.map((position) => ({
        symbol: position.symbol,
        side: position.side,
      })),
    },
    hyperliquid: {
      mainnet: true,
      signerRole: role.role,
      signerIsMainWallet: signer.address.toLowerCase() === hlAccount,
      signerAuthorizedForAccount: roleMaster === hlAccount || !!approvedAgent,
      agentValidUntil: approvedAgent?.validUntil ?? null,
      equityUsd: Number(hlEquity.toFixed(6)),
      openPositions: hlPositions,
    },
    ready: Number(bybitAccount?.totalAvailableBalance ?? 0) >= 25
      && api.readOnly === 0
      && derivativesPermissions.some((permission) => permission === 'Order' || permission === 'DerivativesTrade')
      && hlEquity >= 25
      && roleMaster === hlAccount
      && signer.address.toLowerCase() !== hlAccount
      && bybitPositions.length === 0
      && hlPositions.length === 0,
  }));
}

await main();
