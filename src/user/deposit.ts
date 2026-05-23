/**
 * `/account/deposit` — onboarding step 4 helper page. Shown to users
 * who've connected their API key but whose Bybit balance is below the
 * minimum for their selected tier. Walks them through Bybit's funding
 * options (Russian + international) and offers a «Проверить баланс»
 * button that re-runs the verify flow.
 *
 * If the verify returns enough USDT for the selected tier, the existing
 * /account/api-key/verify handler auto-fires assignTier and redirects
 * to the dashboard — we just hand off the user via `return_to=deposit`
 * so insufficient balances loop back to this page (instead of the
 * generic api-key page).
 *
 * Page is mostly static (markdown-like instructions). The two dynamic
 * bits are the «current balance / needed amount» banner and the
 * matched-tier name so the user sees what they're aiming for.
 */

import { pageShell } from '../strategies/landing.js';
import {
  TIER_CONFIGS,
  MIN_AUTOTRADING_DEPOSIT_USDT,
  type TierId,
} from '../strategies/tier-config.js';

function ico(emoji: string): string {
  return `<span class="cabinet-ico" aria-hidden="true">${emoji}</span>`;
}

function escapeHtmlMin(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c] ?? c);
}

export function renderDepositPage(args: {
  displayName: string | null;
  balanceUsdt: number | null;
  /** Tier the user has selected — we use its minBalanceUsdt as «нужно». */
  selectedTier: TierId | null;
  /** Flash error / ok message from a previous verify attempt. */
  flash: { ok: boolean; message: string } | null;
  csrfToken: string;
}): string {
  // Resolve target deposit. Three cases:
  //   - tier selected → use that tier's minBalance
  //   - no tier picked yet → use the global $300 floor (the cheapest tier)
  //   - VIP — shouldn't reach this page, but defensive: use $300
  const tier = args.selectedTier ? TIER_CONFIGS[args.selectedTier] : null;
  const targetUsdt = tier?.minBalanceUsdt ?? MIN_AUTOTRADING_DEPOSIT_USDT;
  const balance = args.balanceUsdt ?? 0;
  const need = Math.max(0, targetUsdt - balance);
  const enough = balance >= targetUsdt;

  const tierLabel = tier ? `${tier.name}` : 'минимальный депозит';

  const flashBlock = args.flash
    ? `<div class="dp-flash ${args.flash.ok ? 'dp-flash-ok' : 'dp-flash-err'}">
        ${args.flash.ok ? '✓' : '⚠'} ${escapeHtmlMin(args.flash.message)}
       </div>`
    : '';

  // Status banner — three states: enough (green), need more (amber), unknown
  const balanceBanner = args.balanceUsdt === null
    ? `<div class="dp-banner dp-banner-unknown">
        ${ico('❓')}<b>Баланс не известен.</b> Сначала подключите API-ключ Bybit, чтобы мы могли его проверять.
        <a href="/account/api-key" class="dp-banner-link">Подключить ключ →</a>
       </div>`
    : enough
      ? `<div class="dp-banner dp-banner-ok">
          ${ico('✅')}<b>Баланс достаточный</b> — на счёте $${balance.toFixed(0)} USDT, для тарифа ${escapeHtmlMin(tierLabel)} нужно $${targetUsdt}.
          <form method="POST" action="/account/api-key/verify?return_to=deposit" class="dp-banner-form">
            <input type="hidden" name="_csrf" value="${args.csrfToken}"/>
            <button type="submit" class="dp-banner-btn-ok">↻ Проверить и активировать</button>
          </form>
         </div>`
      : `<div class="dp-banner dp-banner-need">
          <div class="dp-banner-row">
            <div class="dp-banner-icon">${ico('💰')}</div>
            <div class="dp-banner-body">
              <div class="dp-banner-title">
                Нужно пополнить ещё на <b>$${need.toFixed(0)}</b>
              </div>
              <div class="dp-banner-meta">
                Сейчас на счёте <b>$${balance.toFixed(0)} USDT</b> · для тарифа <b>${escapeHtmlMin(tierLabel)}</b> нужно <b>$${targetUsdt}</b>
              </div>
            </div>
          </div>
          <div class="dp-banner-actions">
            <a href="https://www.bybit.com/user/assets/home/overview" target="_blank" rel="noopener" class="dp-btn-primary">
              ${ico('🚀')}Открыть Bybit
            </a>
            <form method="POST" action="/account/api-key/verify?return_to=deposit" style="display:inline">
              <input type="hidden" name="_csrf" value="${args.csrfToken}"/>
              <button type="submit" class="dp-btn-secondary">↻ Проверить баланс</button>
            </form>
          </div>
         </div>`;

  const body = `
    ${styles()}
    <main class="cabinet-main">
      <div class="cabinet-greeting">
        <div class="cabinet-greeting-label"><a href="/account" class="cabinet-crumb">Личный кабинет</a> · Пополнение Bybit</div>
        <h1 class="cabinet-title">Шаг 4 · Пополнение Bybit</h1>
        <p class="dp-sub">
          После пополнения нажмите «Проверить баланс» — если средств достаточно,
          стратегии включаются автоматически без вашего участия.
        </p>
      </div>

      ${flashBlock}
      ${balanceBanner}

      <div class="dp-methods">
        <h2 class="dp-h2">Как пополнить — Россия и СНГ</h2>
        <div class="dp-method-grid">
          <div class="dp-method">
            <div class="dp-method-head">${ico('💳')}P2P-обменники <span class="dp-method-tag">самый популярный</span></div>
            <div class="dp-method-body">
              Прямо на Bybit: <b>Buy Crypto → P2P Trading → USDT</b>. Покупаете USDT
              у частных продавцов за рубли, Bybit держит USDT в escrow до подтверждения
              перевода. Способы: <b>СБП, Тинькофф, Сбер, ЮMoney</b>.
            </div>
            <div class="dp-method-time">⏱ 10–30 минут</div>
          </div>
          <div class="dp-method">
            <div class="dp-method-head">${ico('🏦')}Garantex / EXMO</div>
            <div class="dp-method-body">
              Российская биржа Garantex — рубли → USDT внутри России. Затем выводите
              USDT на Bybit в сети TRC20 (комиссия ~$1). EXMO работает аналогично.
            </div>
            <div class="dp-method-time">⏱ 30–60 минут</div>
          </div>
          <div class="dp-method">
            <div class="dp-method-head">${ico('🔁')}Перевод с другой биржи</div>
            <div class="dp-method-body">
              Если уже есть USDT на Binance, OKX, Bitget — вывод напрямую на Bybit.
              <b>Используйте сеть TRC20</b> — самая дешёвая и быстрая (~$1, 5 минут).
              Адрес кошелька — в Bybit → Deposit → USDT → TRC20.
            </div>
            <div class="dp-method-time">⏱ 5–15 минут</div>
          </div>
        </div>

        <h2 class="dp-h2">Как пополнить — другие страны</h2>
        <div class="dp-method-grid">
          <div class="dp-method">
            <div class="dp-method-head">${ico('💳')}Банковская карта</div>
            <div class="dp-method-body">
              Прямая покупка USDT за USD/EUR через Bybit: <b>Buy Crypto → Express</b>.
              Поддерживаются Visa, Mastercard, Apple Pay. Комиссия ~1.5-3%.
            </div>
            <div class="dp-method-time">⏱ Мгновенно</div>
          </div>
          <div class="dp-method">
            <div class="dp-method-head">${ico('🏦')}Bank transfer (SEPA / Wire)</div>
            <div class="dp-method-body">
              SEPA для Европы (24 часа), Wire transfer для остальных. Без комиссии
              со стороны Bybit, но банк может взять свою.
            </div>
            <div class="dp-method-time">⏱ 1–3 дня</div>
          </div>
          <div class="dp-method">
            <div class="dp-method-head">${ico('🔁')}Crypto deposit</div>
            <div class="dp-method-body">
              Если уже владеете криптой — пополнение USDT/USDC/BTC напрямую
              в свой Bybit-кошелёк. <b>TRC20 или Solana — дешевле всего.</b>
              Конвертация в USDT на Bybit (если нужно) — нулевая комиссия.
            </div>
            <div class="dp-method-time">⏱ 5–30 минут</div>
          </div>
        </div>
      </div>

      <div class="dp-safety">
        ${ico('🛡')}<b>Важно про маржу и риск-менеджмент:</b>
        <ul class="dp-safety-list">
          <li>Депозит остаётся на <b>вашем</b> счёте Bybit — мы не имеем права на вывод.</li>
          <li>Положите не больше, чем готовы потерять. Криптотрейдинг — это всегда риск.</li>
          <li>Тариф ${escapeHtmlMin(tierLabel)} использует около <b>12-20%</b> вашего депозита как рабочую маржу;
              остальное лежит резервом.</li>
          <li>Можно начать с минимума ($${targetUsdt}) и потом доложить — тариф автоматически
              пересчитается при росте баланса.</li>
        </ul>
      </div>

      <div class="dp-bottom">
        <a href="/account" class="dp-btn-ghost">← В кабинет</a>
        <form method="POST" action="/account/api-key/verify?return_to=deposit" style="display:inline">
          <input type="hidden" name="_csrf" value="${args.csrfToken}"/>
          <button type="submit" class="dp-btn-primary">${ico('↻')}Проверить баланс ещё раз</button>
        </form>
      </div>
    </main>
  `;

  return pageShell('Пополнение Bybit · Robot Claude', body, {
    lang: 'ru',
    robots: 'noindex, nofollow',
    hideMobileHelpIcon: true,
    authed: { displayName: args.displayName, phone: null },
  });
}

function styles(): string {
  return `
<style>
  .cabinet-main { max-width: 980px; margin: 0 auto; padding: 28px 20px 80px; }
  .cabinet-greeting { margin-bottom: 18px; }
  .cabinet-greeting-label {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em;
    color: #6b7480; margin-bottom: 6px;
  }
  .cabinet-crumb { color: inherit; text-decoration: none; transition: color 0.15s; }
  .cabinet-crumb:hover { color: #4ad991; }
  .cabinet-title { font-size: 26px; font-weight: 600; margin: 0 0 10px 0; color: #e8edf2; }
  .cabinet-ico { display: inline-block; margin-right: 8px; vertical-align: -1px; line-height: 1; }
  .dp-sub { color: #9aa5b1; font-size: 14px; line-height: 1.6; margin: 0 0 22px; max-width: 720px; }

  .dp-flash {
    padding: 12px 16px; border-radius: 10px; margin-bottom: 18px;
    font-size: 13.5px; line-height: 1.55;
  }
  .dp-flash-err { background: rgba(255,99,99,0.08); border: 1px solid rgba(255,99,99,0.35); color: #ff8b8b; }
  .dp-flash-ok { background: rgba(74,217,145,0.08); border: 1px solid rgba(74,217,145,0.35); color: #4ad991; }

  /* Balance banner — three styles for ok/need/unknown. */
  .dp-banner {
    border-radius: 14px; padding: 20px 22px; margin-bottom: 28px;
  }
  .dp-banner-ok {
    background: rgba(74, 217, 145, 0.08);
    border: 1px solid rgba(74, 217, 145, 0.35);
    color: #cfd6dd; font-size: 14px; line-height: 1.55;
    display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
  }
  .dp-banner-ok b { color: #4ad991; }
  .dp-banner-unknown {
    background: rgba(245, 177, 77, 0.08);
    border: 1px solid rgba(245, 177, 77, 0.35);
    color: #cfd6dd; font-size: 14px; line-height: 1.55;
    display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  }
  .dp-banner-unknown b { color: #f5b14d; }
  .dp-banner-link {
    color: #4ad991; text-decoration: none; font-weight: 600;
    margin-left: auto;
  }
  .dp-banner-link:hover { text-decoration: underline; }
  .dp-banner-need {
    background: linear-gradient(180deg, rgba(243,210,102,0.10) 0%, rgba(243,210,102,0.04) 100%);
    border: 1px solid rgba(243,210,102,0.45);
  }
  .dp-banner-row { display: flex; align-items: center; gap: 14px; }
  .dp-banner-icon { font-size: 32px; }
  .dp-banner-body { flex: 1; }
  .dp-banner-title {
    font-size: 17px; font-weight: 700; color: #fff;
    margin-bottom: 4px;
  }
  .dp-banner-title b { color: #f5d970; }
  .dp-banner-meta {
    font-size: 13px; color: #cfd6dd; line-height: 1.5;
  }
  .dp-banner-meta b { color: #fff; font-weight: 600; }
  .dp-banner-actions {
    display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px;
  }
  .dp-banner-form { display: inline; margin-left: auto; }
  .dp-banner-btn-ok {
    background: rgba(74, 217, 145, 0.18); color: #4ad991;
    border: 1px solid rgba(74, 217, 145, 0.45); border-radius: 8px;
    padding: 8px 14px; font-size: 13px; font-weight: 600;
    cursor: pointer; font-family: inherit;
  }
  .dp-banner-btn-ok:hover { background: rgba(74, 217, 145, 0.28); }

  /* Methods grid */
  .dp-methods { margin-bottom: 28px; }
  .dp-h2 {
    font-size: 16px; font-weight: 600; color: #e8edf2;
    margin: 0 0 14px; padding-top: 8px;
  }
  .dp-method-grid {
    display: grid; gap: 14px; margin-bottom: 28px;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  }
  .dp-method {
    background: #11161d; border: 1px solid #1f2630;
    border-radius: 12px; padding: 18px 20px;
  }
  .dp-method-head {
    font-size: 14px; font-weight: 600; color: #e8edf2;
    margin-bottom: 8px; display: flex; align-items: center; flex-wrap: wrap; gap: 8px;
  }
  .dp-method-tag {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em;
    padding: 3px 8px; border-radius: 999px;
    background: rgba(74,217,145,0.15); color: #4ad991;
    border: 1px solid rgba(74,217,145,0.35);
    font-weight: 600;
  }
  .dp-method-body {
    font-size: 13px; color: #cfd6dd; line-height: 1.6;
  }
  .dp-method-body b { color: #e8edf2; }
  .dp-method-time {
    font-size: 11.5px; color: #8590a0; margin-top: 10px;
    padding-top: 10px; border-top: 1px dashed #1a1f27;
  }

  .dp-safety {
    background: rgba(74, 217, 145, 0.05);
    border: 1px solid rgba(74, 217, 145, 0.22);
    border-radius: 10px; padding: 18px 22px; margin-bottom: 28px;
    font-size: 13px; color: #cfd6dd;
  }
  .dp-safety b { color: #4ad991; }
  .dp-safety-list {
    margin: 10px 0 0; padding-left: 22px; line-height: 1.7;
  }
  .dp-safety-list li b { color: #e8edf2; }

  .dp-bottom {
    display: flex; justify-content: space-between; align-items: center;
    gap: 12px; flex-wrap: wrap; margin-top: 22px;
  }
  .dp-btn-primary {
    display: inline-flex; align-items: center;
    padding: 12px 20px; background: #4ad991; color: #0b0e13;
    border-radius: 9px; font-weight: 700; font-size: 14px;
    text-decoration: none; cursor: pointer; border: none;
    font-family: inherit;
  }
  .dp-btn-primary:hover { background: #5ce0a0; }
  .dp-btn-secondary {
    display: inline-flex; align-items: center;
    padding: 12px 18px; background: transparent; color: #cfd6dd;
    border: 1px solid #2a323d; border-radius: 9px;
    font-weight: 500; font-size: 13.5px; cursor: pointer;
    font-family: inherit;
  }
  .dp-btn-secondary:hover { border-color: #4ad991; color: #4ad991; }
  .dp-btn-ghost {
    color: #8590a0; font-size: 13px; text-decoration: none;
  }
  .dp-btn-ghost:hover { color: #4ad991; }

  @media (max-width: 720px) {
    .cabinet-main { padding: 22px 14px 60px; }
    .dp-banner-row { flex-direction: column; align-items: flex-start; gap: 10px; }
    .dp-banner-form { margin-left: 0; width: 100%; }
    .dp-banner-btn-ok { width: 100%; padding: 12px; }
  }
</style>
`;
}
