/**
 * Track D — `/account/api-key` renderer.
 *
 * Two stages:
 *   1. No key connected (or revoked) → show form + inline guide
 *      for creating a trade-only Bybit API key with IP whitelist
 *   2. Key connected → show last_verified_at + balance preview,
 *      with a "rotate key" form and a destructive "отключить" action
 *
 * Form POSTs to /account/api-key with {apiKey, apiSecret}. Server
 * verifies via fetchBalanceUsdt() before encrypting+storing. Failed
 * verify → flash banner with the bybit error label, no DB change.
 */

import { pageShell } from '../strategies/landing.js';
import type { ApiKeySummary } from '../db/repos/user-api-keys.js';
import { BYBIT_REF_URL, BYBIT_REF_BONUS_DAYS } from '../strategies/track-c-config.js';
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

function fmtAgo(ms: number | null): string {
  if (!ms) return '—';
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (sec < 60) return `${sec} сек назад`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} мин назад`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs} ч назад`;
  return `${Math.floor(hrs / 24)} дн назад`;
}

export function renderApiKeyPage(args: {
  displayName: string | null;
  apiKey: ApiKeySummary | null;
  /** Balance from the last verify call, if known + still fresh. Shown
   *  as confidence-builder "everything works, here's your balance". */
  balanceUsdt: number | null;
  flash?: { ok: boolean; message: string } | null;
  csrfToken: string;
}): string {
  const flashHtml = args.flash
    ? `<div class="key-flash ${args.flash.ok ? 'ok' : 'err'}">${escapeHtml(args.flash.message)}</div>`
    : '';

  const main = args.apiKey && !args.apiKey.revoked_at
    ? renderConnectedState(args.apiKey, args.balanceUsdt, args.csrfToken)
    : renderConnectForm(args.csrfToken);

  const body = `
    ${styles()}
    <main class="cabinet-main">
      <div class="cabinet-greeting">
        <div class="cabinet-greeting-label">Личный кабинет · API-ключ</div>
        <h1 class="cabinet-title">Подключение Bybit</h1>
        <p class="key-sub">
          Чтобы стратегии могли автоматически торговать на вашем счёте, нужен
          API-ключ Bybit с правом на торговлю (без права на вывод средств).
          Мы никогда не имеем доступа к выводу — только открываем и закрываем
          позиции по сигналам системы.
        </p>
      </div>

      ${flashHtml}
      ${main}
      ${renderGuide()}

      <div class="key-back">
        <a href="/account">← Назад в кабинет</a>
      </div>
    </main>
  `;

  return pageShell('API-ключ · Robot Claude', body, {
    lang: 'ru',
    robots: 'noindex, nofollow',
    hideMobileHelpIcon: true,
  });
}

function renderConnectedState(key: ApiKeySummary, balance: number | null, csrfToken: string): string {
  const hasErr = !!key.last_verify_error;
  return `
    <div class="key-card ${hasErr ? 'key-card-warn' : 'key-card-ok'}">
      <div class="key-card-title">
        ${ico(hasErr ? '⚠️' : '✅')}${hasErr ? 'Ключ подключён, но требует проверки' : 'Ключ подключён'}
      </div>
      <div class="key-card-grid">
        <div>
          <div class="key-field-label">Статус</div>
          <div class="key-field-value">${hasErr ? escapeHtml(key.last_verify_error ?? 'ошибка проверки') : 'Активен'}</div>
        </div>
        <div>
          <div class="key-field-label">Последняя проверка</div>
          <div class="key-field-value">${fmtAgo(key.last_verified_at)}</div>
        </div>
        ${balance !== null
          ? `<div>
              <div class="key-field-label">Баланс на счёте</div>
              <div class="key-field-value mono">${balance.toFixed(2)} USDT</div>
            </div>`
          : ''}
        <div>
          <div class="key-field-label">Подключено</div>
          <div class="key-field-value">${fmtAgo(key.created_at)}</div>
        </div>
      </div>
      <div class="key-card-actions">
        <form method="POST" action="/account/api-key/verify" style="display:inline">
          ${csrfInput(csrfToken)}
          <button class="key-btn-secondary" type="submit">Проверить связь</button>
        </form>
        <form method="POST" action="/account/api-key/revoke" style="display:inline"
              onsubmit="return confirm('Отключить ключ? Открытые позиции продолжат жить, новые сделки система открывать перестанет.');">
          ${csrfInput(csrfToken)}
          <button class="key-btn-danger" type="submit">Отключить ключ</button>
        </form>
      </div>
    </div>

    <details class="key-rotate-block">
      <summary>Заменить ключ на новый</summary>
      ${renderInputs(csrfToken)}
    </details>
  `;
}

function renderConnectForm(csrfToken: string): string {
  return `
    <div class="key-card">
      <div class="key-card-title">${ico('🔑')}Подключите ключ Bybit</div>
      ${renderInputs(csrfToken)}
    </div>
  `;
}

function renderInputs(csrfToken: string): string {
  return `
    <form method="POST" action="/account/api-key" class="key-form">
      ${csrfInput(csrfToken)}
      <label class="key-field-row">
        <span class="key-field-label">API Key</span>
        <input type="text" name="apiKey" required autocomplete="off"
          placeholder="например: nDAxXXXXXXXXXXXXXX" />
      </label>
      <label class="key-field-row">
        <span class="key-field-label">API Secret</span>
        <input type="password" name="apiSecret" required autocomplete="off"
          placeholder="64-символьная строка" />
      </label>
      <div class="key-form-hint">
        Мы шифруем ключ AES-256-GCM при сохранении. Проверим связь с Bybit
        до того как сохранить — если ключ невалидный, форма скажет почему.
      </div>
      <button type="submit" class="key-btn-primary">Проверить и сохранить</button>
    </form>
  `;
}

function renderGuide(): string {
  return `
    <div class="key-bonus-banner">
      ${ico('🎁')}<b>Нет аккаунта на Bybit?</b>
      <a href="${BYBIT_REF_URL}" target="_blank" rel="noopener">Зарегистрируйтесь по нашей ссылке</a> —
      получите <b>+${BYBIT_REF_BONUS_DAYS} дней автотрейдинга бесплатно</b>.
      После регистрации пришлите ваш Bybit UID оператору
      <a href="https://t.me/dboykod" target="_blank" rel="noopener">@dboykod</a>.
    </div>

    <div class="key-warn-block">
      ${ico('⚠️')}<b>Прежде чем начать:</b>
      <ul class="key-warn-list">
        <li>Убедитесь что на Bybit у вас <b>включена двухфакторная защита</b> (Google Authenticator + SMS). Без неё создать ключ нельзя — Bybit спросит код подтверждения на финальном шаге.</li>
        <li><b>Подготовьте текстовый файл или менеджер паролей</b> (Bitwarden, 1Password, Заметки на телефоне). API Secret покажется <b>только один раз</b> — потерял = надо создавать ключ заново.</li>
      </ul>
    </div>

    <div class="key-guide">
      <h2 class="key-guide-title">${ico('📖')}Пошаговая инструкция</h2>
      <ol class="key-guide-steps">
        <li>
          Откройте Bybit → <b>Profile → API</b> →
          <a href="https://www.bybit.com/app/user/api-management" target="_blank" rel="noopener">bybit.com/app/user/api-management</a>.
          Нажмите <b>«Create New Key»</b> → выберите <b>«System-generated API Keys»</b>.
        </li>
        <li>
          <b>API Key Usage:</b> «API Transaction» (по умолчанию).<br/>
          <b>Name for the API key:</b> любое, например <code>Robot Claude</code>.
        </li>
        <li>
          <b>API Key Permissions:</b> выберите <b>«Read-Write»</b>, ниже <b>«No IP restriction»</b>
          (так проще — IP-адрес не нужен).
          <div class="key-guide-note">
            Bybit предупредит что без IP-привязки ключ <b>истечёт через 3 месяца</b> — это
            нормально, через 3 месяца просто создадите новый по этой же инструкции.
          </div>
        </li>
        <li>
          <b>Permissions — самое важное:</b>
          <div class="key-perm-block key-perm-ok">
            <b>✅ Поставьте галочки только тут:</b>
            <div class="key-perm-row"><code>Unified Trading → Contracts → Orders</code></div>
            <div class="key-perm-row"><code>Unified Trading → Contracts → Positions</code></div>
            <div class="key-perm-note">Эти два пункта — единственное что нам нужно. Открывать и закрывать позиции на ваших USDT-фьючерсах.</div>
          </div>
          <div class="key-perm-block key-perm-bad">
            <b>❌ НЕ ставьте галочки тут:</b>
            <div class="key-perm-row">SPOT · Trade</div>
            <div class="key-perm-row">Assets · Account Transfer</div>
            <div class="key-perm-row">Assets · Subaccount Transfer</div>
            <div class="key-perm-row">Assets · Withdrawal</div>
            <div class="key-perm-row">Assets · Exchange · Convert</div>
            <div class="key-perm-row">Любые другие пункты в Assets, P2P, Bybit Pay</div>
            <div class="key-perm-note">Эти права нам не нужны. Withdrawal особенно важно НЕ давать — это и есть гарантия что мы не сможем вывести ваши деньги.</div>
          </div>
        </li>
        <li>
          Нажмите <b>«Submit»</b>. Bybit попросит:
          <div class="key-guide-note">
            <b>1.</b> 6-значный SMS-код (придёт автоматически)<br/>
            <b>2.</b> 6-значный код Google Authenticator
          </div>
          Введите оба → нажмите <b>«Next Step»</b>.
        </li>
        <li>
          Появится окно <b>«Key successfully added»</b> с двумя полями:
          <div class="key-guide-note">
            <b>API Key</b> — длинная строка букв и цифр<br/>
            <b>API Secret</b> — ещё длиннее, показывается <b>один раз и навсегда исчезнет</b>
          </div>
          <div class="key-perm-block key-perm-warn">
            <b>${ico('🛑')}СТОП! Не нажимайте «Understood» сразу!</b>
            <div class="key-perm-row" style="margin-top:8px">
              <b>1.</b> Скопируйте <b>API Key</b> и вставьте в <b>сохранённый текстовый файл</b> (или менеджер паролей)
            </div>
            <div class="key-perm-row">
              <b>2.</b> Скопируйте <b>API Secret</b> туда же
            </div>
            <div class="key-perm-row">
              <b>3.</b> Только теперь нажимайте <b>«Understood»</b>
            </div>
          </div>
        </li>
        <li>
          Вернитесь сюда на эту страницу. Вставьте API Key и API Secret в форму выше,
          нажмите <b>«Проверить и сохранить»</b>. Если всё ок — увидите ваш баланс на счёте.
        </li>
      </ol>
      <div class="key-guide-safety">
        ${ico('🛡')}<b>Что мы можем и не можем:</b>
        <div style="margin-top:6px">
          <b>Можем:</b> открывать и закрывать позиции на USDT-фьючерсах + ставить защитные стопы.<br/>
          <b>Не можем:</b> вывести ваши средства (нет права Withdrawal), залезть в спот-кошелёк,
          переводить между аккаунтами, изменить ваш профиль.
        </div>
        <div style="margin-top:8px">
          Ключ при сохранении на нашей стороне шифруется <b>AES-256-GCM</b> — секрет нельзя
          прочитать даже из нашей БД. В любой момент отключите ключ кнопкой «Отключить» наверху
          этой страницы, или удалите его на Bybit — мы это увидим при следующей сверке.
        </div>
      </div>
    </div>
  `;
}

function styles(): string {
  return `
<style>
  .cabinet-main { max-width: 880px; margin: 0 auto; padding: 28px 20px 80px; }
  .cabinet-greeting { margin-bottom: 18px; }
  .cabinet-greeting-label {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em;
    color: #6b7480; margin-bottom: 6px;
  }
  .cabinet-title { font-size: 26px; font-weight: 600; margin: 0 0 10px 0; color: #e8edf2; }
  .cabinet-ico { display: inline-block; margin-right: 8px; vertical-align: -1px; line-height: 1; }
  .key-sub { color: #9aa5b1; font-size: 13.5px; line-height: 1.55; margin: 0; }

  .key-flash {
    padding: 12px 16px; border-radius: 8px; font-size: 13.5px; margin: 14px 0;
  }
  .key-flash.ok { background: rgba(74, 217, 145, 0.10); border: 1px solid rgba(74, 217, 145, 0.45); color: #4ad991; }
  .key-flash.err { background: rgba(255, 99, 99, 0.10); border: 1px solid rgba(255, 99, 99, 0.45); color: #ff8b8b; }

  .key-card {
    background: #11161d; border: 1px solid #1f2630; border-radius: 14px;
    padding: 22px; margin: 20px 0;
  }
  .key-card-ok { border-color: rgba(74, 217, 145, 0.45); }
  .key-card-warn { border-color: rgba(255, 188, 70, 0.45); }
  .key-card-title {
    font-size: 16px; font-weight: 600; color: #e8edf2; margin-bottom: 16px;
  }
  .key-card-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 14px 24px; margin-bottom: 18px;
  }
  .key-field-label {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
    color: #6b7480; margin-bottom: 4px;
  }
  .key-field-value { font-size: 14px; color: #e8edf2; }
  .key-field-value.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }

  .key-card-actions { display: flex; gap: 10px; flex-wrap: wrap; }

  .key-form { display: flex; flex-direction: column; gap: 14px; }
  .key-field-row { display: flex; flex-direction: column; gap: 6px; }
  .key-form input {
    padding: 10px 12px; background: #0b0e13; border: 1px solid #2a323d;
    border-radius: 8px; color: #e8edf2; font-size: 14px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .key-form input:focus { outline: none; border-color: #4ad991; }
  .key-form-hint { font-size: 12.5px; color: #6b7480; line-height: 1.5; }

  .key-btn-primary, .key-btn-secondary, .key-btn-danger {
    padding: 9px 16px; border-radius: 8px; font-size: 13.5px; cursor: pointer;
    border: 1px solid; font-family: inherit;
  }
  .key-btn-primary {
    background: #4ad991; border-color: #4ad991; color: #0b0e13; font-weight: 600;
  }
  .key-btn-primary:hover { background: #5ce0a0; }
  .key-btn-secondary {
    background: #141a22; border-color: #2a323d; color: #cfd6dd;
  }
  .key-btn-secondary:hover { border-color: #4ad991; color: #fff; }
  .key-btn-danger {
    background: #141a22; border-color: rgba(255, 99, 99, 0.5); color: #ff8b8b;
  }
  .key-btn-danger:hover { background: rgba(255, 99, 99, 0.10); }

  .key-rotate-block {
    background: #11161d; border: 1px solid #1f2630; border-radius: 12px;
    padding: 16px 22px; margin: 14px 0; color: #9aa5b1;
  }
  .key-rotate-block summary {
    cursor: pointer; font-size: 14px; padding: 4px 0; color: #cfd6dd;
  }
  .key-rotate-block[open] { padding-bottom: 22px; }
  .key-rotate-block .key-form { margin-top: 14px; }

  .key-bonus-banner {
    background: linear-gradient(135deg, rgba(212,175,55,0.10) 0%, rgba(74,217,145,0.06) 100%);
    border: 1px solid rgba(212, 175, 55, 0.45);
    border-radius: 12px; padding: 14px 18px;
    color: #cfd6dd; font-size: 13.5px; line-height: 1.6;
    margin: 24px 0 8px;
  }
  .key-bonus-banner a { color: #f3d266; text-decoration: none; }
  .key-bonus-banner a:hover { text-decoration: underline; }
  .key-bonus-banner b { color: #f3d266; }

  .key-warn-block {
    background: rgba(255, 188, 70, 0.06);
    border: 1px solid rgba(255, 188, 70, 0.40);
    border-radius: 12px; padding: 14px 18px;
    color: #cfd6dd; font-size: 13.5px; line-height: 1.6;
    margin: 14px 0 0;
  }
  .key-warn-block b { color: #ffbc46; }
  .key-warn-list { margin: 8px 0 0 0; padding-left: 20px; }
  .key-warn-list li { margin-bottom: 6px; }

  .key-perm-block {
    margin-top: 10px;
    padding: 12px 14px;
    border-radius: 8px;
    font-size: 13px; line-height: 1.55;
  }
  .key-perm-ok {
    background: rgba(74, 217, 145, 0.07);
    border-left: 3px solid #4ad991;
  }
  .key-perm-ok b { color: #4ad991; }
  .key-perm-bad {
    background: rgba(255, 99, 99, 0.07);
    border-left: 3px solid #ff8b8b;
  }
  .key-perm-bad b { color: #ff8b8b; }
  .key-perm-warn {
    background: rgba(255, 188, 70, 0.10);
    border-left: 3px solid #ffbc46;
    padding: 14px 16px;
  }
  .key-perm-warn b { color: #ffbc46; }
  .key-perm-row {
    padding: 3px 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12.5px;
    color: #cfd6dd;
  }
  .key-perm-warn .key-perm-row {
    font-family: inherit; font-size: 13px;
  }
  .key-perm-note {
    margin-top: 6px;
    font-size: 12px;
    color: #8590a0;
    font-style: italic;
    line-height: 1.5;
  }
  .key-guide-note {
    background: #0b0e13;
    border-radius: 6px;
    padding: 8px 12px;
    margin-top: 6px;
    font-size: 12.5px;
    color: #9aa5b1;
    line-height: 1.55;
  }
  .key-guide-note code {
    background: #1a1f27;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 12px;
  }
  .key-guide {
    background: #0e131a; border: 1px solid #1a1f27; border-radius: 12px;
    padding: 22px 24px; margin: 24px 0;
  }
  .key-guide-title { font-size: 15px; font-weight: 600; color: #e8edf2; margin: 0 0 12px 0; }
  .key-guide-steps {
    margin: 0 0 14px 0; padding-left: 22px; color: #cfd6dd;
    font-size: 13.5px; line-height: 1.7;
  }
  .key-guide-steps li { margin-bottom: 6px; }
  .key-guide-steps a { color: #4ad991; }
  .key-guide-steps code {
    background: #1a1f27; padding: 2px 6px; border-radius: 4px;
    font-size: 12.5px;
  }
  .key-guide-safety {
    background: rgba(74, 217, 145, 0.07); border-left: 3px solid #4ad991;
    padding: 12px 16px; border-radius: 0 6px 6px 0;
    font-size: 13px; color: #cfd6dd; line-height: 1.55;
  }

  .key-back { text-align: center; margin-top: 24px; }
  .key-back a { color: #8590a0; font-size: 13px; text-decoration: none; }
  .key-back a:hover { color: #4ad991; }
</style>
`;
}
