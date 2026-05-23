/**
 * TRACK E — `/account/strategies` read-only tier view (May 21, 2026).
 *
 * Replaces the previous manual strategy-picker form. User no longer
 * chooses which strategies to enable / what notional / what leverage.
 * Instead the page shows:
 *   - Hero with their assigned tier (Starter / Standard / Plus / Pro / VIP)
 *   - Range expected PnL + max DD obligation for that tier
 *   - List of enabled strategies (read-only cards with live PnL)
 *   - Greyed-out cards for strategies NOT in tier (with CTA «доступно с Plus»)
 *   - Pause/Resume buttons (user controls trading on/off — preserved)
 *   - Margin calculator card (recompute as balance grows / shrinks)
 *
 * Pause/resume POST endpoints in routes.ts remain. The manual update
 * POST (strategy selection / notional / leverage) is removed.
 */

import { pageShell } from '../strategies/landing.js';
import {
  STRATEGY_CONFIGS,
  type StrategyConfig,
} from '../strategies/track-c-config.js';
import {
  TIER_CONFIGS,
  TIER_ORDER,
  computeTierTradeSize,
  type TierId,
} from '../strategies/tier-config.js';
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
  /** Current tier assignment. NULL for VIP-override users or
   *  low-balance users who haven't yet been auto-assigned. */
  tierId: TierId | null;
  /** True if VIP plan — bypasses tier UI, shows «индивидуальная настройка» banner. */
  isVip: boolean;
  /** Phase K — true if tier_id === 'prof'. Enables editable form mode. */
  isProf: boolean;
  apiKeyConnected: boolean;
  /** Current user_strategies rows — for showing live notional/leverage
   *  per strategy. Read from DB, not recomputed in UI. */
  userStrategies: Map<string, UserStrategyRow>;
  csrfToken: string;
  tradingPausedAt: number | null;
  insufficientBalanceAt: number | null;
  lastBalanceUsdt: number | null;
  usedMarginUsdt: number;
  /** Pending tier transition target (e.g. balance climbed → upgrade
   *  prompt). NULL if no transition pending. */
  pendingUpgradeTier: TierId | null;
  /** Flash messages after POST /account/strategies (Phase K). */
  savedFlash?: boolean;
  errorFlash?: string | null;
};

export function renderStrategiesPage(args: RenderArgs): string {
  const body = renderBody(args);
  return pageShell('Стратегии · Robot Claude', body, {
    lang: 'ru',
    robots: 'noindex, nofollow',
    hideMobileHelpIcon: true,
    authed: { displayName: args.displayName, phone: null },
  });
}

function renderBody(args: RenderArgs): string {
  const banners = renderBanners(args);
  const tierCard = args.isVip
    ? renderVipCard(args)
    : args.tierId
      ? renderTierCard(args.tierId)
      : renderLowBalanceCard(args);
  // Phase K — for prof tier render editable form instead of read-only grid.
  const strategiesGrid = args.isProf
    ? renderProEditableForm(args)
    : renderStrategiesGrid(args);
  const pauseControl = renderPauseControl(args);

  const subtitle = args.isProf
    ? `<p class="strat-sub">
        Тариф <b>Prof</b> — настраивайте каждую стратегию вручную. Включайте / выключайте,
        задавайте размер позиции и плечо. Безопасный SL стратегии не редактируется (это страховка).
        Платформа не контролирует ваш баланс и не предупреждает о рисках.
      </p>`
    : `<p class="strat-sub">
        Стратегии выбраны автоматически на основе вашего депозита Bybit. Размер позиций и плечо
        подобраны под безопасный риск-профиль тарифа. Перейти на другой тариф можно увеличив депозит.
      </p>`;

  const flashHtml = args.savedFlash
    ? '<div class="strat-flash strat-flash-ok">✓ Настройки сохранены, стратегии перезапущены.</div>'
    : args.errorFlash
      ? `<div class="strat-flash strat-flash-err">⚠ ${escapeHtml(args.errorFlash)}</div>`
      : '';

  return `
    ${styles()}
    <main class="cabinet-main">
      <div class="cabinet-greeting">
        <div class="cabinet-greeting-label"><a href="/account" class="cabinet-crumb">Личный кабинет</a> · Стратегии</div>
        <h1 class="cabinet-title">${args.isProf ? 'Управление стратегиями · Prof' : 'Мои стратегии'}</h1>
        ${subtitle}
      </div>

      ${flashHtml}
      ${banners}
      ${tierCard}
      ${strategiesGrid}
      ${pauseControl}
    </main>
  `;
}

function renderBanners(args: RenderArgs): string {
  const parts: string[] = [];
  if (!args.apiKeyConnected) {
    parts.push(`
      <div class="strat-banner">
        <div>
          <strong>🔑 API-ключ Bybit не подключён.</strong>
          Стратегии будут активны после подключения ключа и зачисления депозита.
        </div>
        <a class="strat-banner-btn" href="/account/api-key">Подключить →</a>
      </div>
    `);
  }
  if (args.insufficientBalanceAt) {
    parts.push(`
      <div class="strat-banner-bad">
        <div>
          <strong>${ico('💸')}Недостаточно средств на счёте Bybit.</strong>
          ${args.lastBalanceUsdt !== null
            ? `Последний известный баланс: <b>$${args.lastBalanceUsdt.toFixed(2)} USDT</b>. `
            : ''}
          Bybit отклонил последнюю сделку из-за нехватки обеспечения. Пополните Unified Trading Account (единый торговый аккаунт)
          и нажмите «Проверить баланс» в карточке ключа.
        </div>
        <a class="strat-banner-btn" href="/account/api-key">Проверить баланс →</a>
      </div>
    `);
  }
  if (args.tradingPausedAt) {
    parts.push(`
      <div class="strat-banner">
        <div>
          <strong>⏸ Торговля приостановлена.</strong>
          Новые сделки не открываются. Открытые позиции продолжают работать со стопами.
        </div>
        <form method="POST" action="/account/strategies/resume" style="display:inline">
          ${csrfInput(args.csrfToken)}
          <button class="strat-banner-btn" type="submit">Возобновить</button>
        </form>
      </div>
    `);
  }
  return parts.join('\n');
}

function renderTierCard(tierId: TierId): string {
  const tier = TIER_CONFIGS[tierId];
  const sub = tier.expectedMonthlyPnlRangeUsd;
  return `
    <div class="strat-tier-card">
      <div class="strat-tier-head">
        <div class="strat-tier-name">${ico(tierEmoji(tierId))}Ваш пакет: <b>${tier.name}</b></div>
        <div class="strat-tier-sub">Депозит $${tier.minBalanceUsdt}–${tier.maxBalanceUsdt === Number.POSITIVE_INFINITY ? '∞' : `$${tier.maxBalanceUsdt}`} · Подписка $${tier.monthlyPriceUsd}/мес</div>
      </div>
      <div class="strat-tier-grid">
        <div class="strat-tier-stat">
          <div class="strat-tier-stat-label">Стратегий включено</div>
          <div class="strat-tier-stat-val">${tier.strategyIds.length}</div>
        </div>
        <div class="strat-tier-stat">
          <div class="strat-tier-stat-label">Ожидаемая прибыль/мес</div>
          <div class="strat-tier-stat-val">$${sub.low}–$${sub.high}</div>
        </div>
        <div class="strat-tier-stat">
          <div class="strat-tier-stat-label">Макс. одновременно</div>
          <div class="strat-tier-stat-val">${tier.maxConcurrentPositions} позиции</div>
        </div>
        <div class="strat-tier-stat">
          <div class="strat-tier-stat-label">Макс. просадка</div>
          <div class="strat-tier-stat-val">≤${tier.expectedMaxDdPct}%</div>
        </div>
      </div>
      <div class="strat-tier-pitch">${escapeHtml(tier.pitch)}</div>
      <div class="strat-tier-disclaimer">
        ⚠ Цифры рассчитаны по историческим данным бэктестов. Прошлые результаты не гарантируют будущих.
      </div>
    </div>
  `;
}

function renderVipCard(args: RenderArgs): string {
  return `
    <div class="strat-tier-card strat-tier-vip">
      <div class="strat-tier-head">
        <div class="strat-tier-name">${ico('👑')}VIP — индивидуальная настройка</div>
        <div class="strat-tier-sub">Параметры стратегий настроены оператором</div>
      </div>
      <div class="strat-tier-pitch">
        Включено стратегий: <b>${args.userStrategies.size}</b>.
        Размер позиций и плечо подобраны индивидуально. Для изменений свяжитесь
        с оператором через <a href="https://t.me/dboykod" target="_blank" rel="noopener">@dboykod</a>.
      </div>
    </div>
  `;
}

function renderLowBalanceCard(args: RenderArgs): string {
  return `
    <div class="strat-tier-card strat-tier-warn">
      <div class="strat-tier-head">
        <div class="strat-tier-name">${ico('⚠️')}Тариф не назначен</div>
        <div class="strat-tier-sub">${args.apiKeyConnected ? 'Депозит ниже минимума автотрейдинга ($300)' : 'API-ключ Bybit не подключён'}</div>
      </div>
      <div class="strat-tier-pitch">
        Минимальный депозит для автоматической торговли — <b>$300 USDT</b> на Unified Trading Account (единый торговый аккаунт) Bybit.
        ${args.lastBalanceUsdt !== null
          ? `Сейчас на счёте: <b>$${args.lastBalanceUsdt.toFixed(2)} USDT</b>. Пополните ещё на <b>$${Math.max(0, 300 - args.lastBalanceUsdt).toFixed(2)}</b>.`
          : 'Подключите ключ Bybit и пополните счёт — мы автоматически подберём тариф.'}
      </div>
      ${!args.apiKeyConnected
        ? '<a class="strat-banner-btn" href="/account/api-key">Подключить ключ →</a>'
        : '<a class="strat-banner-btn" href="/account/api-key">Проверить связь →</a>'}
    </div>
  `;
}

function renderStrategiesGrid(args: RenderArgs): string {
  if (!args.tierId && !args.isVip) {
    // Low-balance: показываем что было бы доступно в Starter — мотивация пополнить
    const starter = TIER_CONFIGS.starter;
    return `
      <div class="strat-section-title">${ico('🎯')}Стратегии тарифа Starter (доступны после пополнения до $300)</div>
      <div class="strat-grid">
        ${starter.strategyIds.map((sid) => renderLockedStrategyCard(STRATEGY_CONFIGS[sid]!, 'Starter')).join('')}
      </div>
    `;
  }

  if (args.isVip) {
    // VIP — показываем все user_strategies, не разделяя на «доступно / недоступно»
    const enabledRows = [...args.userStrategies.values()].filter((r) => r.enabled === 1);
    return `
      <div class="strat-section-title">${ico('⚙️')}Активные стратегии (${enabledRows.length})</div>
      <div class="strat-grid">
        ${enabledRows.map((row) => {
          const cfg = STRATEGY_CONFIGS[row.strategy_id];
          if (!cfg) return '';
          return renderActiveStrategyCard(cfg, { notional: row.notional_usd, leverage: row.leverage });
        }).join('')}
      </div>
    `;
  }

  // Regular tier — split into «включено» + «недоступно»
  const tier = TIER_CONFIGS[args.tierId!];
  const includedIds = new Set(tier.strategyIds);
  const allEligible = Object.values(STRATEGY_CONFIGS).filter(
    (s) => s.enabled !== false && s.tierEligible !== false,
  );

  const enabledCards: string[] = [];
  for (const sid of tier.strategyIds) {
    const cfg = STRATEGY_CONFIGS[sid];
    if (!cfg) continue;
    const size = computeTierTradeSize(args.tierId!, sid);
    if (!size) continue;
    enabledCards.push(renderActiveStrategyCard(cfg, {
      notional: size.notionalUsd,
      leverage: size.leverage,
    }));
  }

  const lockedCards: string[] = [];
  for (const cfg of allEligible) {
    if (includedIds.has(cfg.id)) continue;
    const requiredTier = findFirstTierWith(cfg.id);
    if (!requiredTier) continue;
    lockedCards.push(renderLockedStrategyCard(cfg, TIER_CONFIGS[requiredTier].name));
  }

  return `
    <div class="strat-section-title">${ico('✅')}Включено (${enabledCards.length})</div>
    <div class="strat-grid">${enabledCards.join('')}</div>
    ${lockedCards.length > 0
      ? `<div class="strat-section-title strat-section-title-muted">${ico('🔒')}Недоступно на вашем тарифе (${lockedCards.length})</div>
         <div class="strat-grid">${lockedCards.join('')}</div>`
      : ''}
  `;
}

function renderActiveStrategyCard(
  cfg: StrategyConfig,
  size: { notional: number; leverage: number },
): string {
  const slPctStr = (cfg.slPct * 100).toFixed(1);
  const symbolLabel = cfg.symbol ?? 'ANY';
  const name = cfg.name ?? `${symbolLabel} ${cfg.timeframe}m`;
  const margin = size.notional / size.leverage;
  return `
    <div class="strat-card strat-card-on">
      <div class="strat-card-head">
        <div class="strat-card-title">${ico('🤖')}STRAT-${escapeHtml(cfg.code)} · ${escapeHtml(name)}</div>
        <div class="strat-card-meta">${escapeHtml(symbolLabel)} · ${escapeHtml(cfg.timeframe)}m · SL ${slPctStr}%</div>
      </div>
      <div class="strat-card-stats">
        <div class="strat-card-stat">
          <span class="strat-card-stat-label">Размер сделки</span>
          <span class="strat-card-stat-val">$${size.notional.toFixed(0)}</span>
        </div>
        <div class="strat-card-stat">
          <span class="strat-card-stat-label">Плечо</span>
          <span class="strat-card-stat-val">${size.leverage}×</span>
        </div>
        <div class="strat-card-stat">
          <span class="strat-card-stat-label">Заморожено</span>
          <span class="strat-card-stat-val">$${margin.toFixed(2)}</span>
        </div>
      </div>
    </div>
  `;
}

function renderLockedStrategyCard(cfg: StrategyConfig, requiredTier: string): string {
  const slPctStr = (cfg.slPct * 100).toFixed(1);
  const symbolLabel = cfg.symbol ?? 'ANY';
  const name = cfg.name ?? `${symbolLabel} ${cfg.timeframe}m`;
  return `
    <div class="strat-card strat-card-locked">
      <div class="strat-card-head">
        <div class="strat-card-title">${ico('🔒')}STRAT-${escapeHtml(cfg.code)} · ${escapeHtml(name)}</div>
        <div class="strat-card-meta">${escapeHtml(symbolLabel)} · ${escapeHtml(cfg.timeframe)}m · SL ${slPctStr}%</div>
      </div>
      <div class="strat-card-locked-msg">Доступно с тарифа <b>${requiredTier}</b></div>
    </div>
  `;
}

function findFirstTierWith(strategyId: string): TierId | null {
  for (const id of TIER_ORDER) {
    if (TIER_CONFIGS[id].strategyIds.includes(strategyId)) return id;
  }
  return null;
}

function tierEmoji(tierId: TierId): string {
  switch (tierId) {
    case 'starter': return '🥉';
    case 'standard': return '🥈';
    case 'plus': return '🥇';
    case 'pro': return '🏆';
    case 'vip': return '👑';
    case 'prof': return '💼';
  }
}

/**
 * Phase K — Editable form for «prof» tier. Each strategy gets a row with:
 *   ☑ enabled checkbox · Strategy name+symbol · notional input · leverage input · margin readout
 * Inputs are flat-named (enabled_<sid>, notional_<sid>, leverage_<sid>) to
 * work with fastify-formbody's default URL-encoded parser (no nested bracket
 * support). All 8 strategies are listed — including the wide-SL ones
 * (UNI/TON/HBAR) that regular tiers exclude.
 */
function renderProEditableForm(args: RenderArgs): string {
  const allStrategies = Object.values(STRATEGY_CONFIGS).filter((s) => s.enabled);
  const rowsHtml = allStrategies.map((cfg) => {
    const existing = args.userStrategies.get(cfg.id);
    const isEnabled = !!existing && existing.enabled === 1;
    const notional = existing?.notional_usd ?? Math.round((cfg.maxSafeLeverage ?? 5) * 20);
    const leverage = existing?.leverage ?? cfg.maxSafeLeverage ?? 5;
    const defaultSlPctStr = (cfg.slPct * 100).toFixed(2);
    // Phase N — pre-fill the SL field with the user's saved override or
    // the strategy default. Stored as decimal in DB, shown as percent
    // in the UI to match how users think about it.
    const slPctValue = existing?.sl_pct_override != null
      ? (existing.sl_pct_override * 100).toFixed(2)
      : defaultSlPctStr;
    const symbolLabel = cfg.symbol ?? 'ANY';
    const name = cfg.name ?? `${symbolLabel} ${cfg.timeframe}m`;
    const maxLev = cfg.maxSafeLeverage ?? 10;
    return `
      <div class="prof-row ${isEnabled ? 'prof-row-on' : 'prof-row-off'}">
        <label class="prof-row-toggle">
          <input type="checkbox" name="enabled_${escapeHtml(cfg.id)}" ${isEnabled ? 'checked' : ''}/>
          <span class="prof-row-toggle-vis"></span>
        </label>
        <div class="prof-row-info">
          <div class="prof-row-title">STRAT-${escapeHtml(cfg.code)} · ${escapeHtml(name)}</div>
          <div class="prof-row-meta">
            ${escapeHtml(symbolLabel)} · ${escapeHtml(cfg.timeframe)}m ·
            SL по умолчанию <b>${defaultSlPctStr}%</b> ·
            max плечо <b>${maxLev}×</b>
          </div>
        </div>
        <div class="prof-row-input">
          <label class="prof-row-input-label">Размер ($)</label>
          <input type="number" min="10" step="1" name="notional_${escapeHtml(cfg.id)}"
                 value="${notional}" inputmode="numeric"/>
        </div>
        <div class="prof-row-input">
          <label class="prof-row-input-label">Плечо (×)</label>
          <input type="number" min="1" max="100" step="1" name="leverage_${escapeHtml(cfg.id)}"
                 value="${leverage}" inputmode="numeric"/>
        </div>
        <div class="prof-row-input">
          <label class="prof-row-input-label" title="Стоп-лосс в процентах от цены входа. Пусто = значение по умолчанию (${defaultSlPctStr}%).">
            SL (%)
          </label>
          <input type="number" min="0.5" max="25" step="0.1" name="sl_pct_${escapeHtml(cfg.id)}"
                 value="${slPctValue}" inputmode="decimal"/>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="prof-warning">
      ⚠ <b>Только для опытных трейдеров.</b>
      Платформа не проверяет ваши параметры — большой notional с большим плечом и широким SL может
      привести к ликвидации позиции. Помните: <b>worst-case потеря = SL% × notional</b>.
      Безопасное плечо стратегии (max) рассчитано так чтобы наш SL срабатывал раньше ликвидации;
      превышение этого лимита — на ваш страх и риск.
      <br><br>
      <b>SL (%)</b> — стоп-лосс в процентах от цены входа. Можно ужесточить (например с 5% до 2%),
      чтобы быстрее срезать убытки, или наоборот ослабить если стратегия часто выбивается шумом.
      Допустимый диапазон: <b>0.5%–25%</b>.
    </div>
    <form method="POST" action="/account/strategies" class="prof-form">
      ${csrfInput(args.csrfToken)}
      <div class="prof-list">${rowsHtml}</div>
      <div class="prof-form-actions">
        <button type="submit" class="prof-save-btn">💾 Сохранить настройки стратегий</button>
        <span class="prof-form-hint">Изменения применяются к новым сделкам. Открытые позиции продолжают работать по своим параметрам.</span>
      </div>
    </form>
  `;
}

function renderPauseControl(args: RenderArgs): string {
  if (args.tradingPausedAt) {
    // Pause-banner уже показан выше — здесь не дублируем
    return '';
  }
  return `
    <div class="strat-pause-control">
      <form method="POST" action="/account/strategies/pause">
        ${csrfInput(args.csrfToken)}
        <button class="strat-pause-btn" type="submit"
                onclick="return confirm('Остановить автоматическую торговлю? Открытые позиции останутся, новые открываться не будут.');">
          ⏸ Остановить торговлю
        </button>
      </form>
    </div>
  `;
}

function styles(): string {
  return `
<style>
  .cabinet-main { max-width: 1000px; margin: 0 auto; padding: 28px 20px 80px; }
  .cabinet-greeting { margin-bottom: 24px; }
  .cabinet-greeting-label {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em;
    color: #6b7480; margin-bottom: 6px;
  }
  .cabinet-crumb { color: inherit; text-decoration: none; transition: color 0.15s; }
  .cabinet-crumb:hover { color: #4ad991; }
  .cabinet-title { font-size: 26px; font-weight: 600; margin: 0 0 10px 0; color: #e8edf2; }
  .cabinet-ico { display: inline-block; margin-right: 8px; font-style: normal; line-height: 1; vertical-align: -1px; }
  .strat-sub { color: #9aa5b1; font-size: 13.5px; line-height: 1.55; margin: 0; max-width: 760px; }

  .strat-banner {
    display: flex; align-items: center; justify-content: space-between;
    gap: 16px; padding: 14px 18px;
    background: #1a1611; border: 1px solid rgba(255, 188, 70, 0.45);
    border-radius: 12px; color: #e0d9c5; margin: 18px 0;
    font-size: 13.5px;
    flex-wrap: wrap;
  }
  .strat-banner-bad {
    display: flex; align-items: center; justify-content: space-between;
    gap: 16px; padding: 14px 18px;
    background: rgba(255, 99, 99, 0.08); border: 1px solid rgba(255, 99, 99, 0.45);
    border-radius: 12px; color: #e8c5c5; margin: 18px 0;
    font-size: 13.5px;
    flex-wrap: wrap;
  }
  .strat-banner-btn {
    background: #4ad991; color: #0b0e13; padding: 8px 16px;
    border: none; border-radius: 8px; font-weight: 600; font-size: 13px;
    text-decoration: none; cursor: pointer; font-family: inherit;
    white-space: nowrap;
  }
  .strat-banner-btn:hover { background: #5ce0a0; }

  .strat-tier-card {
    background: #11161d; border: 1px solid #1f2630; border-radius: 14px;
    padding: 22px 24px; margin: 18px 0 28px;
  }
  .strat-tier-vip { border-color: rgba(212, 175, 55, 0.55);
    background: linear-gradient(180deg, #1a1611 0%, #11161d 70%); }
  .strat-tier-warn { border-color: rgba(255, 188, 70, 0.45); }
  .strat-tier-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 12px; margin-bottom: 18px; }
  .strat-tier-name { font-size: 18px; font-weight: 600; color: #e8edf2; }
  .strat-tier-name b { color: #4ad991; }
  .strat-tier-vip .strat-tier-name b { color: #f3d266; }
  .strat-tier-sub { font-size: 13px; color: #8590a0; }
  .strat-tier-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 14px; margin-bottom: 14px;
  }
  .strat-tier-stat { display: flex; flex-direction: column; gap: 4px; }
  .strat-tier-stat-label {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #6b7480;
  }
  .strat-tier-stat-val { font-size: 18px; font-weight: 600; color: #e8edf2; }
  .strat-tier-pitch { font-size: 13.5px; color: #cfd6dd; line-height: 1.55; margin-bottom: 10px; }
  .strat-tier-pitch b { color: #4ad991; }
  .strat-tier-pitch a { color: #4ad991; }
  .strat-tier-disclaimer {
    font-size: 11.5px; color: #6b7480; padding-top: 12px; border-top: 1px solid #1a1f27;
  }

  .strat-section-title {
    font-size: 13px; font-weight: 600; color: #cfd6dd;
    margin: 26px 0 12px 0;
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .strat-section-title-muted { color: #6b7480; }
  .strat-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 12px;
  }

  .strat-card {
    background: #11161d; border: 1px solid #1f2630; border-radius: 12px;
    padding: 16px 18px;
  }
  .strat-card-on { border-color: rgba(74, 217, 145, 0.35); }
  .strat-card-locked { opacity: 0.55; border-color: #2a323d; background: #0e131a; }
  .strat-card-head { margin-bottom: 14px; }
  .strat-card-title {
    font-size: 14px; font-weight: 600; color: #e8edf2; margin-bottom: 4px;
  }
  .strat-card-meta { font-size: 11.5px; color: #8590a0; }
  .strat-card-stats {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px;
  }
  .strat-card-stat { display: flex; flex-direction: column; gap: 2px; }
  .strat-card-stat-label { font-size: 10.5px; color: #6b7480; text-transform: uppercase; letter-spacing: 0.05em; }
  .strat-card-stat-val { font-size: 14px; font-weight: 600; color: #cfd6dd; }
  .strat-card-locked-msg {
    font-size: 12.5px; color: #8590a0; padding: 6px 0;
  }
  .strat-card-locked-msg b { color: #cfd6dd; }

  .strat-pause-control { text-align: center; margin-top: 32px; }
  .strat-pause-btn {
    background: transparent; color: #ff8b8b; border: 1px solid rgba(255, 99, 99, 0.45);
    padding: 10px 22px; border-radius: 8px; font-size: 13px; cursor: pointer;
    font-family: inherit;
  }
  .strat-pause-btn:hover { background: rgba(255, 99, 99, 0.10); }

  @media (max-width: 640px) {
    .strat-tier-head { flex-direction: column; gap: 6px; }
    .strat-banner, .strat-banner-bad { flex-direction: column; align-items: flex-start; }
  }
  @media (max-width: 380px) {
    .cabinet-main { padding: 20px 12px 60px; }
    .strat-tier-card { padding: 18px 16px; }
    .strat-card-stats { grid-template-columns: repeat(2, 1fr); }
  }

  /* Phase K — Prof editable form */
  .strat-flash {
    padding: 12px 16px; border-radius: 10px; margin: 0 0 16px;
    font-size: 13.5px; line-height: 1.5;
  }
  .strat-flash-ok { background: rgba(74,217,145,0.08); border: 1px solid rgba(74,217,145,0.35); color: #4ad991; }
  .strat-flash-err { background: rgba(239,91,107,0.08); border: 1px solid rgba(239,91,107,0.35); color: #ff8b8b; }
  .prof-warning {
    padding: 14px 18px; margin: 16px 0;
    background: rgba(239, 91, 107, 0.08); border: 1px solid rgba(239, 91, 107, 0.40);
    border-radius: 12px; color: #e8c5c5; font-size: 13px; line-height: 1.6;
  }
  .prof-warning b { color: #ff8b8b; }
  .prof-form { margin: 18px 0; }
  .prof-list { display: flex; flex-direction: column; gap: 10px; }
  .prof-row {
    display: grid;
    grid-template-columns: auto 1fr 120px 95px 95px;
    gap: 12px; align-items: center;
    padding: 14px 16px; border-radius: 10px;
    background: #11161d; border: 1px solid #1f2630;
  }
  .prof-row-on { border-color: rgba(74,217,145,0.30); }
  .prof-row-off { opacity: 0.7; }
  .prof-row-toggle {
    display: inline-flex; cursor: pointer; user-select: none;
  }
  .prof-row-toggle input { display: none; }
  .prof-row-toggle-vis {
    width: 38px; height: 22px; background: #1a1f27;
    border-radius: 999px; border: 1px solid #2a323d;
    position: relative; transition: background 0.15s;
  }
  .prof-row-toggle-vis::after {
    content: ''; position: absolute; top: 2px; left: 2px;
    width: 16px; height: 16px; background: #6b7480;
    border-radius: 50%; transition: transform 0.15s, background 0.15s;
  }
  .prof-row-toggle input:checked + .prof-row-toggle-vis {
    background: rgba(74,217,145,0.30); border-color: #4ad991;
  }
  .prof-row-toggle input:checked + .prof-row-toggle-vis::after {
    transform: translateX(16px); background: #4ad991;
  }
  .prof-row-info { min-width: 0; }
  .prof-row-title { font-size: 14px; font-weight: 600; color: #e8edf2; margin-bottom: 4px; }
  .prof-row-meta { font-size: 12px; color: #8590a0; }
  .prof-row-meta b { color: #cfd6dd; }
  .prof-row-input { display: flex; flex-direction: column; gap: 4px; }
  .prof-row-input-label {
    font-size: 10.5px; color: #6b7480; text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .prof-row-input input {
    background: #0e131a; border: 1px solid #2a323d; border-radius: 8px;
    padding: 8px 10px; font-size: 14px; color: #e8edf2;
    font-family: ui-monospace, Menlo, monospace; width: 100%; box-sizing: border-box;
    -moz-appearance: textfield;
  }
  .prof-row-input input::-webkit-outer-spin-button,
  .prof-row-input input::-webkit-inner-spin-button {
    -webkit-appearance: none; margin: 0;
  }
  .prof-row-input input:focus { outline: none; border-color: #4ad991; }
  .prof-form-actions {
    display: flex; gap: 16px; align-items: center; flex-wrap: wrap;
    margin-top: 18px;
  }
  .prof-save-btn {
    background: #4ad991; color: #0b0e13; padding: 12px 22px;
    border-radius: 10px; font-size: 14px; font-weight: 600; cursor: pointer;
    border: none; font-family: inherit;
  }
  .prof-save-btn:hover { background: #5ce0a0; }
  .prof-form-hint { font-size: 12.5px; color: #8590a0; line-height: 1.4; }
  @media (max-width: 720px) {
    .prof-row {
      grid-template-columns: auto 1fr; gap: 10px 14px;
    }
    .prof-row-input { grid-column: span 2 / span 2; flex-direction: row; align-items: center; gap: 10px; }
    .prof-row-input-label { min-width: 80px; }
  }
</style>
`;
}
