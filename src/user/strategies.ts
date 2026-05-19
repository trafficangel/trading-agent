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
  recommendedMaxLeverage,
  type StrategyConfig,
} from '../strategies/track-c-config.js';
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
};

export function renderStrategiesPage(args: RenderArgs): string {
  const enabledStrategies = Object.values(STRATEGY_CONFIGS).filter((s) => s.enabled);
  const rows = enabledStrategies
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((cfg) => renderRow(cfg, args.userStrategies.get(cfg.id) ?? null))
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
  const calcCard = `
    <div class="strat-calc-card" id="strat-calc">
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
      </div>
      <div class="strat-calc-note">
        Реальное обеспечение = размер_позиции ÷ плечо. Например, $100 на сделку при 10× плече = $10 обеспечения.
        Bybit спишет это с баланса при открытии позиции и вернёт при закрытии (минус комиссия).
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
        <div class="cabinet-greeting-label">Личный кабинет · Стратегии</div>
        <h1 class="cabinet-title">Мои стратегии</h1>
        <p class="strat-sub">
          Выберите стратегии, размер позиции (USDT на каждую сделку) и плечо.
          Включённые стратегии будут автоматически торговать на вашем счёте Bybit
          по сигналам нашей системы.
        </p>
      </div>

      ${pauseBanner}
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

function renderRow(cfg: StrategyConfig, existing: UserStrategyRow | null): string {
  const isEnabled = existing?.enabled === 1;
  const checkedAttr = isEnabled ? 'checked' : '';
  const notional = existing?.notional_usd ?? 100;
  const leverage = existing?.leverage ?? 1;
  const slPctStr = (cfg.slPct * 100).toFixed(1);
  const recommendedLev = recommendedMaxLeverage(cfg.slPct);
  const symbolLabel = cfg.symbol ?? 'ANY';
  const name = cfg.name ?? `${symbolLabel} ${cfg.timeframe}m`;

  // Each strategy emits 3 fields with namespaced keys so the form
  // serialises cleanly. The server splits by '__' on parse.
  const enabledName = `s__${cfg.id}__enabled`;
  const notionalName = `s__${cfg.id}__notional`;
  const leverageName = `s__${cfg.id}__leverage`;

  return `
    <div class="strat-row ${isEnabled ? 'strat-row-on' : ''}">
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
        </label>
        <label class="strat-field">
          <span class="strat-field-label">Плечо</span>
          <input type="number" name="${leverageName}" value="${leverage}" min="1" max="100" step="1" />
          <span class="strat-field-hint">рекомендуется не более <b>${recommendedLev}×</b> при SL ${slPctStr}%</span>
        </label>
      </div>
    </div>
  `;
}

function calculatorScript(): string {
  // Walk every .strat-row, sum (notional × enabled) and
  // (notional / leverage × enabled), write into the calc card.
  // Fires on every input/change event on inputs in the form.
  return `
    <script>
      (function() {
        var form = document.getElementById('strat-form');
        var calc = document.getElementById('strat-calc');
        if (!form || !calc) return;
        var elCount = calc.querySelector('[data-calc="count"]');
        var elNotional = calc.querySelector('[data-calc="notional"]');
        var elMargin = calc.querySelector('[data-calc="margin"]');
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
        }
        form.addEventListener('input', recompute);
        form.addEventListener('change', recompute);
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

  .strat-banner {
    display: flex; align-items: center; justify-content: space-between;
    gap: 16px; padding: 14px 18px;
    background: #1a1611; border: 1px solid rgba(255, 188, 70, 0.45);
    border-radius: 12px; color: #e0d9c5; margin: 18px 0;
    font-size: 13.5px;
  }
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
  }
  .strat-field-label {
    font-size: 11.5px; color: #8590a0; letter-spacing: 0.02em;
  }
  .strat-field input {
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
</style>
`;
}
