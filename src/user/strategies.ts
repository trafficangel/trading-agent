/**
 * Track D — `/account/strategies` renderer.
 *
 * Lists every enabled strategy from STRATEGY_CONFIGS as a row in a
 * compact form. Each row has:
 *   - On/off toggle
 *   - Notional input ($USDT per entry on this strategy)
 *   - Leverage input (×) with recommended max hint
 *   - Status (whether the user previously enabled it)
 *
 * Form POSTs to /account/strategies — body is x-www-form-urlencoded
 * with one set of fields per strategy (strategy_id__enabled, *__notional,
 * *__leverage). The route handler upserts or disables rows accordingly.
 *
 * The user can't enable a strategy without a Bybit API key — if no key
 * is connected we show a banner pointing to /account/api-key. Saving
 * is still allowed (the rows persist), but a tooltip explains they
 * won't fire until the key is verified.
 */

import { pageShell } from '../strategies/landing.js';
import {
  STRATEGY_CONFIGS,
  type StrategyConfig,
} from '../strategies/track-c-config.js';

/** Default leverage for newly-enabled strategy rows. 10× is the
 *  sensible middle-ground for crypto perps — covers most SL distances
 *  without ballooning margin requirements. User can override per-row. */
const DEFAULT_LEVERAGE = 10;
import type { UserStrategyRow } from '../db/repos/user-strategies.js';
import { csrfInput } from '../auth/csrf.js';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c] ?? c);
}

function ico(emoji: string): string {
  return `<span class="cabinet-ico" aria-hidden="true">${emoji}</span>`;
}

type RenderArgs = {
  displayName: string | null;
  apiKeyConnected: boolean;
  userStrategies: Map<string, UserStrategyRow>;
  /** Banner shown above the form after a save round-trip. */
  flash?: { ok: boolean; message: string } | null;
  /** CSRF token to embed in the form's hidden input. */
  csrfToken: string;
  /** Unix ms when user paused trading globally, NULL if active. */
  tradingPausedAt: number | null;
  /** Unix ms when Bybit last rejected an order for insufficient
   *  balance. NULL = balance is sufficient (or unknown). */
  insufficientBalanceAt: number | null;
  /** Last known USDT balance (cached on user_api_keys), for the
   *  "your balance is $X, need $Y" message. */
  lastBalanceUsdt: number | null;
  /** USDT margin already locked by open positions. Subtracted from
   *  balance to compute free margin for the calculator's "хватает"
   *  status badge. */
  usedMarginUsdt: number;
  /** Live price + qtyStep per symbol so each strategy row can show
   *  "ваш $100 на BTC реально откроется как $76.76 (0.001)" hint.
   *  Symbols missing from the map degrade to no-hint (UI still works). */
  lotInfo: Map<string, { price: number; qtyStep: number; minOrderQty: number }>;
};

export function renderStrategiesPage(args: RenderArgs): string {
  const enabledStrategies = Object.values(STRATEGY_CONFIGS).filter((s) => s.enabled);
  const rows = enabledStrategies
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((cfg) => renderRow(cfg, args.userStrategies.get(cfg.id) ?? null, args.lotInfo))
    .join('');

  const keyBanner = args.apiKeyConnected
    ? ''
    : `
      <div class="strat-banner">
        <div>
          <strong>🔑 API-ключ Bybit не подключён.</strong>
          Стратегии можно выбрать сейчас, но они не начнут торговать пока вы не подключите ключ.
        </div>
        <a class="strat-banner-btn" href="/account/api-key">Подключить →</a>
      </div>
    `;

  // Insufficient-balance banner. Set when Bybit returned 110007/110012
  // on the most recent fan-out attempt. Until cleared (top up + manual
  // verify), new fan-out skips this user entirely.
  const balanceBanner = args.insufficientBalanceAt
    ? `
      <div class="strat-banner-bad">
        <div>
          <strong>${ico('💸')}Недостаточно средств на фьючерсном счёте Bybit.</strong>
          ${args.lastBalanceUsdt !== null
            ? `Последний известный баланс: <b>$${args.lastBalanceUsdt.toFixed(2)} USDT</b>. `
            : ''}
          Bybit отклонил последнюю сделку из-за нехватки обеспечения. Новые сигналы
          не исполняются пока вы не пополните USDT-кошелёк (раздел <b>Derivatives</b>
          в Bybit) и не нажмёте «Проверить связь» в кабинете.
        </div>
        <a class="strat-banner-btn" href="/account/api-key">Проверить связь →</a>
      </div>
    `
    : '';

  // Pause/resume banner. When paused, fan-out skips this user entirely
  // (see listEligibleTargets SQL + isTradingActive race check).
  const pauseBanner = args.tradingPausedAt
    ? `
      <div class="strat-pause-banner strat-pause-paused">
        <div>
          <strong>⏸ Автотрейдинг приостановлен.</strong>
          Новые сделки на ваш счёт не открываются. Открытые позиции продолжают жить до естественного выхода.
        </div>
        <form method="POST" action="/account/strategies/resume" style="display:inline">
          ${csrfInput(args.csrfToken)}
          <button class="strat-pause-btn strat-pause-btn-resume" type="submit">▶ Возобновить торговлю</button>
        </form>
      </div>
    `
    : `
      <div class="strat-pause-banner strat-pause-active">
        <div>
          <strong>${ico('🟢')}Автотрейдинг включён.</strong>
          Система открывает позиции на вашем счёте по сигналам стратегий ниже.
        </div>
        <form method="POST" action="/account/strategies/pause" style="display:inline"
              onsubmit="return confirm('Остановить торговлю? Новые сделки прекратятся. Открытые позиции продолжат жить.');">
          ${csrfInput(args.csrfToken)}
          <button class="strat-pause-btn strat-pause-btn-stop" type="submit">⏸ Остановить торговлю</button>
        </form>
      </div>
    `;

  // Calculator card — sums up notional, required margin, and per-trade
  // max-loss across enabled strategies. Recomputes live on input change
  // via the inline JS at the bottom of the page. SSR shows the initial
  // values from the DB so the page is correct without JS.
  const initialEnabled = enabledStrategies.filter((s) => args.userStrategies.get(s.id)?.enabled === 1);
  const initialNotional = initialEnabled.reduce((acc, s) => acc + (args.userStrategies.get(s.id)?.notional_usd ?? 0), 0);
  const initialMargin = initialEnabled.reduce((acc, s) => {
    const row = args.userStrategies.get(s.id);
    if (!row) return acc;
    return acc + row.notional_usd / Math.max(1, row.leverage);
  }, 0);
  // Balance / free / status — only meaningful when we have a key
  // connected and have observed at least one balance read. If not, we
  // hide the balance row and show only the requirement.
  const haveBalance = args.lastBalanceUsdt !== null;
  const balanceVal = haveBalance ? args.lastBalanceUsdt! : 0;
  const freeVal = haveBalance ? balanceVal - args.usedMarginUsdt : 0;
  // SSR status. Three tiers — same logic as dashboard:
  //   - green: free >= worst-case sum (every strategy can fire at once)
  //   - amber: free < worst-case sum but ≥ largest single-trade margin
  //            (individual signals work, simultaneous fire = some skips)
  //   - red:   currently flagged (Bybit said no) OR free < single-trade
  //            (next signal definitely won't fit)
  // We don't have per-strategy margin breakdown SSR-side without more
  // plumbing — approximate "next signal fits" as `free >= largest
  // single notional/leverage among enabled rows`, computed below.
  let largestSingle = 0;
  for (const s of enabledStrategies) {
    const row = args.userStrategies.get(s.id);
    if (!row || row.enabled !== 1) continue;
    const m = row.notional_usd / Math.max(1, row.leverage);
    if (m > largestSingle) largestSingle = m;
  }
  const flagged = args.insufficientBalanceAt !== null;
  let ssrStatusCls: string;
  let ssrStatusText: string;
  if (!haveBalance) {
    ssrStatusCls = 'strat-calc-status-unknown';
    ssrStatusText = 'Подключите ключ — посчитаем хватает ли';
  } else if (flagged || (largestSingle > 0 && freeVal < largestSingle)) {
    ssrStatusCls = 'strat-calc-status-bad';
    ssrStatusText = flagged
      ? '⚠️ Торговля заблокирована · Bybit отклонил последнюю сделку. Пополните счёт'
      : `⚠️ Не хватит даже на одну сделку · нужно минимум $${largestSingle.toFixed(2)}, свободно $${freeVal.toFixed(2)}`;
  } else if (freeVal >= initialMargin) {
    ssrStatusCls = 'strat-calc-status-ok';
    ssrStatusText = `✅ Хватает на все стратегии одновременно · свободно $${freeVal.toFixed(2)}`;
  } else {
    ssrStatusCls = 'strat-calc-status-warn';
    ssrStatusText = `💡 Хватает на одиночные сделки. При одновременном срабатывании всех стратегий не хватит $${(initialMargin - freeVal).toFixed(2)} — последние ордера будут пропущены`;
  }

  const balanceRow = haveBalance
    ? `<div class="strat-calc-stat">
         <div class="strat-calc-label">На счёте Bybit</div>
         <div class="strat-calc-value" data-calc="balance">$${balanceVal.toFixed(2)}</div>
         <div class="strat-calc-sub">${args.usedMarginUsdt > 0 ? `в позициях $${args.usedMarginUsdt.toFixed(2)} · ` : ''}свободно <span data-calc="free">$${freeVal.toFixed(2)}</span></div>
       </div>`
    : '';

  const calcCard = `
    <div class="strat-calc-card" id="strat-calc"
         data-balance="${balanceVal}" data-used="${args.usedMarginUsdt}" data-have-balance="${haveBalance ? '1' : '0'}">
      <div class="strat-calc-title">${ico('🧮')}Калькулятор обеспечения</div>
      <div class="strat-calc-grid">
        <div class="strat-calc-stat">
          <div class="strat-calc-label">Включено стратегий</div>
          <div class="strat-calc-value" data-calc="count">${initialEnabled.length}</div>
          <div class="strat-calc-sub">из ${enabledStrategies.length}</div>
        </div>
        <div class="strat-calc-stat">
          <div class="strat-calc-label">Размер по сделке</div>
          <div class="strat-calc-value" data-calc="notional">$${initialNotional.toFixed(0)}</div>
          <div class="strat-calc-sub">суммарный nominal</div>
        </div>
        <div class="strat-calc-stat strat-calc-stat-highlight">
          <div class="strat-calc-label">Нужно USDT на счёте</div>
          <div class="strat-calc-value" data-calc="margin">$${initialMargin.toFixed(2)}</div>
          <div class="strat-calc-sub">обеспечение под все одновременно открытые позиции</div>
        </div>
        ${balanceRow}
      </div>
      <div class="strat-calc-status ${ssrStatusCls}" data-calc="status">${ssrStatusText}</div>
      <div class="strat-calc-note">
        Реальное обеспечение = размер_позиции ÷ плечо. Например, $100 на сделку при 10× плече = $10 обеспечения.
        Bybit спишет это с баланса при открытии позиции и вернёт при закрытии (минус комиссия).
        ${haveBalance ? '<br/>Если на счёте недостаточно — новые сделки система откроет только после пополнения.' : ''}
      </div>
    </div>
  `;

  const flashHtml = args.flash
    ? `<div class="strat-flash ${args.flash.ok ? 'ok' : 'err'}">${escapeHtml(args.flash.message)}</div>`
    : '';

  const body = `
    ${styles()}
    <main class="cabinet-main">
      <div class="cabinet-greeting">
        <div class="cabinet-greeting-label"><a href="/account" class="cabinet-crumb">Личный кабинет</a> · Стратегии</div>
        <h1 class="cabinet-title">Мои стратегии</h1>
        <p class="strat-sub">
          Выберите стратегии, размер позиции (USDT на каждую сделку) и плечо.
          Включённые стратегии будут автоматически торговать на вашем счёте Bybit
          по сигналам нашей системы.
        </p>
      </div>

      ${pauseBanner}
      ${balanceBanner}
      ${keyBanner}
      ${calcCard}
      ${flashHtml}

      <form method="POST" action="/account/strategies" class="strat-form" id="strat-form">
        ${csrfInput(args.csrfToken)}
        <div class="strat-grid">
          ${rows}
        </div>
        <div class="strat-actions">
          <a class="strat-btn-secondary" href="/account">← Назад в кабинет</a>
          <button type="submit" class="strat-btn-primary">Сохранить</button>
        </div>
      </form>
    </main>
    ${calculatorScript()}
  `;

  return pageShell('Стратегии · Robot Claude', body, {
    lang: 'ru',
    robots: 'noindex, nofollow',
    hideMobileHelpIcon: true,
  });
}

function renderRow(
  cfg: StrategyConfig,
  existing: UserStrategyRow | null,
  lotInfo: Map<string, { price: number; qtyStep: number; minOrderQty: number }>,
): string {
  const isEnabled = existing?.enabled === 1;
  const checkedAttr = isEnabled ? 'checked' : '';
  const notional = existing?.notional_usd ?? 100;
  const leverage = existing?.leverage ?? DEFAULT_LEVERAGE;
  const slPctStr = (cfg.slPct * 100).toFixed(1);
  const symbolLabel = cfg.symbol ?? 'ANY';
  const name = cfg.name ?? `${symbolLabel} ${cfg.timeframe}m`;

  // Each strategy emits 3 fields with namespaced keys so the form
  // serialises cleanly. The server splits by '__' on parse.
  const enabledName = `s__${cfg.id}__enabled`;
  const notionalName = `s__${cfg.id}__notional`;
  const leverageName = `s__${cfg.id}__leverage`;

  // Lot-size hint. When we have live price + qtyStep for this symbol,
  // pre-compute SSR-friendly text for the current notional and stash
  // data-* on the row so the calc JS can recompute as the user types.
  // Without lot info (network failed / unknown symbol) we hide the hint.
  const info = cfg.symbol ? lotInfo.get(cfg.symbol) : undefined;
  let hintHtml = '';
  let dataAttrs = '';
  if (info) {
    const rawQty = notional / info.price;
    const qty = Math.floor(rawQty / info.qtyStep) * info.qtyStep;
    const actual = qty * info.price;
    dataAttrs = ` data-price="${info.price}" data-qty-step="${info.qtyStep}" data-min-qty="${info.minOrderQty}"`;
    const initialText = qty <= 0
      ? `минимум на этой паре — ${(info.minOrderQty * info.price).toFixed(2)} USDT (${info.minOrderQty} ${escapeHtml(coinBase(cfg.symbol!))})`
      : `на бирже: <b>$${actual.toFixed(2)}</b> (${formatQty(qty)} ${escapeHtml(coinBase(cfg.symbol!))})${actual < notional * 0.98 ? ` · цена лота ${(info.qtyStep * info.price).toFixed(2)} USDT` : ''}`;
    hintHtml = `<span class="strat-field-lot" data-lot-hint>${initialText}</span>`;
  }

  return `
    <div class="strat-row ${isEnabled ? 'strat-row-on' : ''}"${dataAttrs}>
      <div class="strat-row-head">
        <label class="strat-toggle">
          <input type="checkbox" name="${enabledName}" value="1" ${checkedAttr} />
          <span class="strat-toggle-slider"></span>
        </label>
        <div class="strat-row-meta">
          <div class="strat-row-name">
            ${ico('🤖')}STRAT-${escapeHtml(cfg.code)} · ${escapeHtml(name)}
          </div>
          <div class="strat-row-sub">
            ${escapeHtml(symbolLabel)} · ${escapeHtml(cfg.timeframe)}m · Safety SL ${slPctStr}%
          </div>
        </div>
      </div>
      <div class="strat-row-controls">
        <label class="strat-field">
          <span class="strat-field-label">Размер позиции, USDT</span>
          <input type="number" name="${notionalName}" value="${notional}" min="10" max="100000" step="1" />
          <span class="strat-field-hint">сколько средств в каждой сделке</span>
          ${hintHtml}
        </label>
        <label class="strat-field">
          <span class="strat-field-label">Плечо</span>
          <input type="number" name="${leverageName}" value="${leverage}" min="1" max="100" step="1" />
          <span class="strat-field-hint">по умолчанию <b>${DEFAULT_LEVERAGE}×</b> · Bybit допускает 1–100×</span>
        </label>
      </div>
    </div>
  `;
}

/** Best-effort base-coin extraction from a Bybit symbol code.
 *  BTCUSDT → BTC, 1000PEPEUSDT → 1000PEPE, etc. */
function coinBase(symbol: string): string {
  if (symbol.endsWith('USDT')) return symbol.slice(0, -4);
  if (symbol.endsWith('USDC')) return symbol.slice(0, -4);
  return symbol;
}

/** Format qty without trailing zeros. 0.001000 → "0.001", 1.0 → "1". */
function formatQty(qty: number): string {
  return Number(qty.toFixed(8)).toString();
}

function calculatorScript(): string {
  // Walk every .strat-row, sum (notional × enabled) and
  // (notional / leverage × enabled), write into the calc card.
  // Also recompute the "хватает / не хватает" status badge by comparing
  // required margin against (balance - used) read from data-attrs on
  // the calc card (rendered SSR by the server).
  return `
    <script>
      (function() {
        var form = document.getElementById('strat-form');
        var calc = document.getElementById('strat-calc');
        if (!form || !calc) return;
        var elCount = calc.querySelector('[data-calc="count"]');
        var elNotional = calc.querySelector('[data-calc="notional"]');
        var elMargin = calc.querySelector('[data-calc="margin"]');
        var elFree = calc.querySelector('[data-calc="free"]');
        var elStatus = calc.querySelector('[data-calc="status"]');
        var balance = parseFloat(calc.getAttribute('data-balance')) || 0;
        var used = parseFloat(calc.getAttribute('data-used')) || 0;
        var haveBalance = calc.getAttribute('data-have-balance') === '1';
        function recompute() {
          var rows = form.querySelectorAll('.strat-row');
          var count = 0, notional = 0, margin = 0;
          rows.forEach(function(row) {
            var enabledInput = row.querySelector('input[type="checkbox"]');
            if (!enabledInput || !enabledInput.checked) return;
            var n = parseFloat((row.querySelector('input[name$="__notional"]') || {}).value) || 0;
            var l = parseFloat((row.querySelector('input[name$="__leverage"]') || {}).value) || 1;
            if (l < 1) l = 1;
            count++;
            notional += n;
            margin += n / l;
          });
          elCount.textContent = String(count);
          elNotional.textContent = '$' + notional.toFixed(0);
          elMargin.textContent = '$' + margin.toFixed(2);
          // Live status — green/amber/red. Only meaningful when we know
          // the actual balance.
          if (!elStatus) return;
          if (!haveBalance) {
            elStatus.className = 'strat-calc-status strat-calc-status-unknown';
            elStatus.textContent = 'Подключите ключ — посчитаем хватает ли';
            return;
          }
          var free = balance - used;
          if (elFree) elFree.textContent = '$' + free.toFixed(2);
          // Also recompute largest single-trade margin from current
          // inputs — for the "хватит ли хотя бы на одну сделку" check.
          var largestSingle = 0;
          form.querySelectorAll('.strat-row').forEach(function(row) {
            var enabledInput = row.querySelector('input[type="checkbox"]');
            if (!enabledInput || !enabledInput.checked) return;
            var n = parseFloat((row.querySelector('input[name$="__notional"]') || {}).value) || 0;
            var l = parseFloat((row.querySelector('input[name$="__leverage"]') || {}).value) || 1;
            if (l < 1) l = 1;
            var m = n / l;
            if (m > largestSingle) largestSingle = m;
          });
          var cls, text;
          if (count === 0) {
            cls = 'strat-calc-status-unknown';
            text = 'Включите хотя бы одну стратегию';
          } else if (free < largestSingle) {
            cls = 'strat-calc-status-bad';
            text = '⚠️ Не хватит даже на одну сделку · нужно минимум $' + largestSingle.toFixed(2) + ', свободно $' + free.toFixed(2);
          } else if (free >= margin) {
            cls = 'strat-calc-status-ok';
            text = '✅ Хватает на все стратегии одновременно · свободно $' + free.toFixed(2);
          } else {
            cls = 'strat-calc-status-warn';
            text = '💡 Хватает на одиночные сделки. При одновременном срабатывании всех стратегий не хватит $' + (margin - free).toFixed(2) + ' — последние ордера будут пропущены';
          }
          elStatus.className = 'strat-calc-status ' + cls;
          elStatus.textContent = text;
        }
        function recomputeLotHints() {
          // For each row with data-price + data-qty-step, recompute the
          // "actual on exchange" hint from the current notional input.
          form.querySelectorAll('.strat-row').forEach(function(row) {
            var hint = row.querySelector('[data-lot-hint]');
            if (!hint) return;
            var price = parseFloat(row.getAttribute('data-price'));
            var step = parseFloat(row.getAttribute('data-qty-step'));
            var minQty = parseFloat(row.getAttribute('data-min-qty')) || 0;
            if (!price || !step) return;
            var notInput = row.querySelector('input[name$="__notional"]');
            var n = parseFloat((notInput || {}).value) || 0;
            if (n <= 0) {
              hint.innerHTML = 'введите размер';
              hint.className = 'strat-field-lot strat-field-lot-warn';
              return;
            }
            var rawQty = n / price;
            var qty = Math.floor(rawQty / step) * step;
            var actual = qty * price;
            // Symbol code for the qty unit — pull from the sub-row label.
            // Simpler: use a data-coin attribute if we want stricter; we
            // don't render coin name in the JS path to avoid duplication
            // (SSR already has it correct; JS just updates the number).
            var coinMatch = hint.textContent.match(/[A-Z0-9]+$/);
            var coin = coinMatch ? coinMatch[0] : '';
            if (qty < minQty || qty <= 0) {
              var minNotional = (minQty * price).toFixed(2);
              hint.innerHTML = '<b style="color:#ff8b8b">слишком мало</b> · минимум ' + minNotional + ' USDT (' + minQty + ' ' + coin + ')';
              hint.className = 'strat-field-lot strat-field-lot-warn';
              return;
            }
            var diff = n - actual;
            var diffPct = (diff / n) * 100;
            // Format qty cleanly (strip trailing zeros) — same as SSR.
            var qtyStr = (+qty.toFixed(8)).toString();
            var lotPrice = (step * price);
            var ok = diffPct < 2;
            var prefix = ok ? 'на бирже: ' : '<b style="color:#ffbc46">на бирже:</b> ';
            var suffix = ok ? '' : ' · цена лота ' + lotPrice.toFixed(2) + ' USDT';
            hint.innerHTML = prefix + '<b>$' + actual.toFixed(2) + '</b> (' + qtyStr + ' ' + coin + ')' + suffix;
            hint.className = ok ? 'strat-field-lot' : 'strat-field-lot strat-field-lot-warn';
          });
        }
        form.addEventListener('input', function() {
          recompute();
          recomputeLotHints();
        });
        form.addEventListener('change', function() {
          recompute();
          recomputeLotHints();
        });
        // Visual feedback: toggle row's strat-row-on class live so the
        // green border follows the checkbox state without waiting for
        // server-side rerender.
        form.querySelectorAll('input[type="checkbox"]').forEach(function(cb) {
          cb.addEventListener('change', function() {
            cb.closest('.strat-row').classList.toggle('strat-row-on', cb.checked);
          });
        });
      })();
    </script>
  `;
}

function styles(): string {
  return `
<style>
  .cabinet-main {
    max-width: 1100px;
    margin: 0 auto;
    padding: 28px 20px 80px;
  }
  .cabinet-greeting { margin-bottom: 24px; }
  .cabinet-greeting-label {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em;
    color: #6b7480; margin-bottom: 6px;
  }
  .cabinet-crumb {
    color: inherit; text-decoration: none; transition: color 0.15s;
  }
  .cabinet-crumb:hover { color: #4ad991; }
  .cabinet-title {
    font-size: 26px; font-weight: 600; margin: 0 0 10px 0; color: #e8edf2;
  }
  .strat-sub {
    color: #9aa5b1; font-size: 13.5px; line-height: 1.55; max-width: 740px;
    margin: 0;
  }
  .cabinet-ico {
    display: inline-block; margin-right: 8px; font-style: normal;
    font-size: 1.05em; line-height: 1; vertical-align: -1px;
  }

  /* Pause / resume control. Two visual states share the layout. */
  .strat-pause-banner {
    display: flex; align-items: center; justify-content: space-between;
    gap: 16px; padding: 14px 18px;
    border-radius: 12px; margin: 18px 0;
    font-size: 13.5px; line-height: 1.5;
    flex-wrap: wrap;
  }
  .strat-pause-active {
    background: rgba(74, 217, 145, 0.06);
    border: 1px solid rgba(74, 217, 145, 0.40);
    color: #cfd6dd;
  }
  .strat-pause-active strong { color: #4ad991; }
  .strat-pause-paused {
    background: rgba(255, 188, 70, 0.08);
    border: 1px solid rgba(255, 188, 70, 0.45);
    color: #e0d9c5;
  }
  .strat-pause-paused strong { color: #ffbc46; }
  .strat-pause-btn {
    padding: 8px 14px; border-radius: 8px; cursor: pointer;
    font-size: 13px; font-weight: 600; font-family: inherit;
    border: 1px solid;
    flex-shrink: 0;
  }
  .strat-pause-btn-stop {
    background: #141a22; border-color: rgba(255, 188, 70, 0.5); color: #ffbc46;
  }
  .strat-pause-btn-stop:hover { background: rgba(255, 188, 70, 0.10); }
  .strat-pause-btn-resume {
    background: #4ad991; border-color: #4ad991; color: #0b0e13;
  }
  .strat-pause-btn-resume:hover { background: #5ce0a0; }

  /* Live calculator: shows aggregate notional + required margin while
     the user fiddles with per-strategy inputs. Updates via inline JS. */
  .strat-calc-card {
    background: #11161d; border: 1px solid #1f2630;
    border-radius: 14px; padding: 18px 20px; margin: 18px 0;
  }
  .strat-calc-title {
    font-size: 14.5px; font-weight: 600; color: #e8edf2;
    margin-bottom: 14px;
  }
  .strat-calc-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 14px;
  }
  .strat-calc-stat {
    background: #0e131a; border: 1px solid #1a1f27;
    border-radius: 10px; padding: 14px 16px;
  }
  .strat-calc-stat-highlight {
    border-color: rgba(74, 217, 145, 0.45);
    background: linear-gradient(180deg, rgba(74,217,145,0.04) 0%, #0e131a 100%);
  }
  .strat-calc-label {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
    color: #6b7480; margin-bottom: 6px;
  }
  .strat-calc-value {
    font-size: 22px; font-weight: 600; color: #e8edf2;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    line-height: 1.15; margin-bottom: 4px;
  }
  .strat-calc-stat-highlight .strat-calc-value { color: #4ad991; }
  .strat-calc-sub {
    font-size: 11.5px; color: #8590a0;
  }
  .strat-calc-note {
    margin-top: 14px;
    font-size: 12px; color: #6b7480; line-height: 1.55;
  }
  .strat-calc-status {
    margin-top: 14px;
    padding: 10px 14px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 500;
    line-height: 1.4;
    border: 1px solid;
  }
  .strat-calc-status-ok {
    background: rgba(74, 217, 145, 0.08);
    border-color: rgba(74, 217, 145, 0.45);
    color: #5ce0a0;
  }
  .strat-calc-status-warn {
    background: rgba(255, 188, 70, 0.10);
    border-color: rgba(255, 188, 70, 0.45);
    color: #ffbc46;
  }
  .strat-calc-status-bad {
    background: rgba(255, 99, 99, 0.10);
    border-color: rgba(255, 99, 99, 0.45);
    color: #ff8b8b;
  }
  .strat-calc-status-unknown {
    background: rgba(133, 144, 160, 0.08);
    border-color: rgba(133, 144, 160, 0.30);
    color: #8590a0;
  }

  .strat-banner {
    display: flex; align-items: center; justify-content: space-between;
    gap: 16px; padding: 14px 18px;
    background: #1a1611; border: 1px solid rgba(255, 188, 70, 0.45);
    border-radius: 12px; color: #e0d9c5; margin: 18px 0;
    font-size: 13.5px;
  }
  .strat-banner-bad {
    display: flex; align-items: center; justify-content: space-between;
    gap: 16px; padding: 14px 18px;
    background: rgba(255, 99, 99, 0.08);
    border: 1px solid rgba(255, 99, 99, 0.45);
    border-radius: 12px; color: #e8c5c5; margin: 18px 0;
    font-size: 13.5px; line-height: 1.55;
    flex-wrap: wrap;
  }
  .strat-banner-bad strong { color: #ff8b8b; }
  .strat-banner-bad b { color: #ffd17a; }
  .strat-banner-btn {
    flex-shrink: 0; padding: 8px 14px; background: rgba(255, 188, 70, 0.12);
    border: 1px solid rgba(255, 188, 70, 0.5); border-radius: 8px;
    color: #ffbc46; text-decoration: none; font-size: 13px;
  }
  .strat-banner-btn:hover { background: rgba(255, 188, 70, 0.2); }

  .strat-flash {
    padding: 10px 14px; border-radius: 8px; font-size: 13.5px;
    margin: 12px 0;
  }
  .strat-flash.ok { background: rgba(74, 217, 145, 0.10); border: 1px solid rgba(74, 217, 145, 0.45); color: #4ad991; }
  .strat-flash.err { background: rgba(255, 99, 99, 0.10); border: 1px solid rgba(255, 99, 99, 0.45); color: #ff8b8b; }

  .strat-grid {
    display: flex; flex-direction: column; gap: 12px; margin-top: 20px;
  }

  .strat-row {
    display: flex; flex-direction: column; gap: 14px;
    padding: 16px 18px;
    background: #11161d; border: 1px solid #1f2630; border-radius: 12px;
    transition: border-color 0.15s, background 0.15s;
    min-width: 0;
  }
  .strat-row-on { border-color: rgba(74, 217, 145, 0.45); background: #11181a; }

  .strat-row-head {
    display: flex; align-items: center; gap: 14px;
  }
  .strat-toggle {
    position: relative; display: inline-block; width: 44px; height: 24px;
    flex-shrink: 0; cursor: pointer;
  }
  .strat-toggle input { opacity: 0; width: 0; height: 0; }
  .strat-toggle-slider {
    position: absolute; inset: 0; background: #2a323d; border-radius: 12px;
    transition: background 0.15s;
  }
  .strat-toggle-slider::before {
    content: ''; position: absolute; left: 3px; top: 3px;
    width: 18px; height: 18px; background: #cfd6dd; border-radius: 50%;
    transition: transform 0.18s;
  }
  .strat-toggle input:checked + .strat-toggle-slider { background: #4ad991; }
  .strat-toggle input:checked + .strat-toggle-slider::before {
    transform: translateX(20px); background: #0b0e13;
  }

  .strat-row-meta { flex: 1; min-width: 0; }
  .strat-row-name {
    font-size: 14.5px; font-weight: 600; color: #e8edf2; margin-bottom: 4px;
  }
  .strat-row-sub {
    font-size: 12px; color: #8590a0;
  }

  .strat-row-controls {
    display: grid; grid-template-columns: 1fr 1fr; gap: 14px;
    padding-left: 58px;
  }
  .strat-field {
    display: flex; flex-direction: column; gap: 4px;
    min-width: 0;
  }
  .strat-field-label {
    font-size: 11.5px; color: #8590a0; letter-spacing: 0.02em;
  }
  .strat-field input {
    width: 100%; box-sizing: border-box;
    padding: 8px 10px;
    background: #0b0e13; border: 1px solid #2a323d;
    border-radius: 8px; color: #e8edf2; font-size: 14px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .strat-field input:focus {
    outline: none; border-color: #4ad991;
  }
  .strat-field-hint {
    font-size: 11.5px; color: #6b7480; line-height: 1.4;
  }
  .strat-field-hint b { color: #4ad991; }
  .strat-field-lot {
    display: block;
    font-size: 11.5px;
    color: #8590a0;
    line-height: 1.4;
    margin-top: 2px;
  }
  .strat-field-lot b { color: #cfd6dd; }
  .strat-field-lot-warn { color: #ffbc46; }

  .strat-actions {
    display: flex; justify-content: space-between; gap: 12px;
    margin-top: 24px; padding-top: 18px; border-top: 1px solid #1f2630;
  }
  .strat-btn-secondary, .strat-btn-primary {
    padding: 10px 18px; border-radius: 8px; font-size: 14px;
    text-decoration: none; cursor: pointer; font-family: inherit;
    border: 1px solid #2a323d; background: #141a22; color: #cfd6dd;
  }
  .strat-btn-secondary:hover { border-color: #4ad991; color: #e8edf2; }
  .strat-btn-primary {
    background: #4ad991; border-color: #4ad991; color: #0b0e13;
    font-weight: 600;
  }
  .strat-btn-primary:hover { background: #5ce0a0; }

  @media (max-width: 640px) {
    .strat-row-controls { grid-template-columns: 1fr; padding-left: 0; }
    .strat-banner { flex-direction: column; align-items: flex-start; }
  }
  @media (max-width: 380px) {
    .cabinet-main { padding: 20px 12px 60px; }
    .strat-row { padding: 14px 12px; }
    .strat-actions { flex-direction: column; gap: 10px; }
    .strat-actions a, .strat-actions button { width: 100%; text-align: center; box-sizing: border-box; }
  }
</style>
`;
}
