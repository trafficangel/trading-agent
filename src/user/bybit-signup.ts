/**
 * `/account/bybit-signup` — branch of the onboarding flow for users
 * who don't have a Bybit account yet. Walks them through:
 *   1. Sign up via our referral link (+30 bonus auto-trading days)
 *   2. Pass KYC + enable 2FA
 *   3. Fund the account
 *   4. Come back and connect the API key
 *
 * Sister page to `/account/api-key` (which is the «I already have Bybit»
 * branch). The onboarding checklist on /account routes here when the
 * user clicks «У меня нет Bybit · Зарегистрироваться».
 *
 * The page is fully static — no DB reads, no per-user state. We keep it
 * in the cabinet (behind auth) so the «Когда зарегистрируетесь → Подключить
 * ключ» button at the bottom can deep-link straight into /account/api-key
 * without bouncing through public pages.
 */

import { pageShell } from '../strategies/landing.js';
import { BYBIT_REF_URL, BYBIT_REF_BONUS_DAYS } from '../strategies/track-c-config.js';

function ico(emoji: string): string {
  return `<span class="cabinet-ico" aria-hidden="true">${emoji}</span>`;
}

export function renderBybitSignupPage(args: { displayName: string | null }): string {
  const body = `
    ${styles()}
    <main class="cabinet-main">
      <div class="cabinet-greeting">
        <div class="cabinet-greeting-label"><a href="/account" class="cabinet-crumb">Личный кабинет</a> · Регистрация Bybit</div>
        <h1 class="cabinet-title">Шаг 3 · Регистрация на Bybit</h1>
        <p class="bs-sub">
          Bybit — наша рекомендованная биржа для автотрейдинга. Регистрация
          занимает 5 минут. Если зарегистрируетесь по нашей ссылке —
          получите <b>+${BYBIT_REF_BONUS_DAYS} дней бонусной подписки</b> сверх 14-дневного теста.
        </p>
      </div>

      <div class="bs-hero">
        <div class="bs-hero-left">
          <div class="bs-hero-bonus">${ico('🎁')}+${BYBIT_REF_BONUS_DAYS} дней автотрейдинга бонусом</div>
          <div class="bs-hero-title">Откройте счёт на Bybit</div>
          <div class="bs-hero-sub">
            Только для новых аккаунтов. Если уже регистрировались —
            возвращайтесь и нажимайте «Подключить ключ».
          </div>
          <a class="bs-cta-primary" href="${BYBIT_REF_URL}" target="_blank" rel="noopener">
            ${ico('🚀')}Открыть Bybit (наша ссылка)
          </a>
          <div class="bs-hero-foot">
            После регистрации возвращайтесь сюда — внизу страницы кнопка «Подключить ключ».
          </div>
        </div>
        <div class="bs-hero-right">
          <video class="bs-video"
                 src="/static/setup-walkthrough.mp4?v=1"
                 controls
                 preload="metadata"
                 playsinline
                 muted
                 aria-label="Видео-инструкция">
            Ваш браузер не поддерживает видео-тег.
          </video>
          <div class="bs-video-cap">${ico('🎬')}Целиком: вход, тариф, ключ, проверка баланса</div>
        </div>
      </div>

      <div class="bs-steps">
        <h2 class="bs-h2">Что нужно сделать на Bybit</h2>
        <ol class="bs-list">
          <li>
            <b>Регистрация по email или телефону.</b> Открываете нашу ссылку выше →
            вводите email + придумываете пароль. Bybit пришлёт код подтверждения.
            <div class="bs-note">
              ${ico('🇷🇺')} <b>Для РФ:</b> при регистрации обычно не запрашивают подтверждение
              резиденства. Если попросят выбрать страну — можно указать любую страну СНГ.
            </div>
          </li>
          <li>
            <b>Обязательно включите 2FA</b> (двух-факторная защита). На Bybit:
            <b>Profile → Security → Google Authenticator</b>. Скачайте Google Authenticator
            (или 2FAS, Authy) → отсканируйте QR-код → введите 6-значный код.
            <div class="bs-note">
              ${ico('⚠')} Без 2FA Bybit не даст создать API-ключ. Это обязательный
              шаг — и для нас, и для вашей же безопасности.
            </div>
          </li>
          <li>
            <b>Пополните счёт</b> — минимум $300 USDT для самого дешёвого тарифа Starter.
            Подробная инструкция по способам пополнения — на странице
            <a href="/account/deposit">«Как пополнить Bybit»</a>.
          </li>
          <li>
            <b>Создайте API-ключ</b> с правом только на торговлю (без withdraw).
            Полная пошаговая инструкция — на странице
            <a href="/account/api-key">«Подключение API-ключа»</a>.
          </li>
        </ol>
      </div>

      <div class="bs-safety">
        ${ico('🛡')}<b>Безопасность:</b>
        <div class="bs-safety-body">
          После регистрации Bybit ваш счёт принадлежит только вам. Мы не запрашиваем
          ваш логин или пароль, и наш сервис их не увидит. Единственное что мы используем —
          API-ключ, который вы создадите в своём кабинете Bybit и сами вставите у нас.
          Этот ключ <b>не имеет права на вывод средств</b> — техническая невозможность,
          гарантированная Bybit.
        </div>
      </div>

      <div class="bs-bottom-cta">
        <div class="bs-bottom-cta-label">Закончили регистрацию на Bybit?</div>
        <a href="/account/api-key" class="bs-cta-primary">
          ${ico('🔑')}Подключить API-ключ →
        </a>
        <a href="/account" class="bs-cta-ghost">← В кабинет</a>
      </div>
    </main>
  `;
  return pageShell('Регистрация Bybit · Robot Claude', body, {
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
  .bs-sub { color: #9aa5b1; font-size: 14px; line-height: 1.6; margin: 0 0 22px; max-width: 720px; }
  .bs-sub b { color: #f5d970; }

  /* Hero — gold CTA + video side-by-side, stacks on mobile. */
  .bs-hero {
    display: grid; grid-template-columns: 1fr 1fr; gap: 24px;
    margin-bottom: 36px;
    background: linear-gradient(180deg, #11161d 0%, #0e131a 100%);
    border: 1px solid #1f2630; border-radius: 14px;
    padding: 28px;
  }
  .bs-hero-left {}
  .bs-hero-bonus {
    display: inline-block; padding: 6px 14px; border-radius: 999px;
    background: rgba(243,210,102,0.16); color: #f5d970;
    border: 1px solid rgba(243,210,102,0.40);
    font-size: 12px; font-weight: 600; letter-spacing: 0.04em;
    margin-bottom: 14px;
  }
  .bs-hero-title { font-size: 22px; font-weight: 700; color: #e8edf2; margin: 0 0 8px; }
  .bs-hero-sub { font-size: 13.5px; color: #9aa5b1; line-height: 1.6; margin: 0 0 20px; }
  .bs-cta-primary {
    display: inline-flex; align-items: center;
    padding: 12px 22px; background: #4ad991; color: #0b0e13;
    border-radius: 9px; font-weight: 700; font-size: 14.5px;
    text-decoration: none; transition: background 0.15s;
  }
  .bs-cta-primary:hover { background: #5ce0a0; }
  .bs-cta-ghost {
    display: inline-flex; align-items: center;
    padding: 12px 18px; background: transparent; color: #cfd6dd;
    border: 1px solid #2a323d; border-radius: 9px;
    font-weight: 500; font-size: 13.5px; text-decoration: none;
    transition: border-color 0.15s, color 0.15s;
  }
  .bs-cta-ghost:hover { border-color: #4ad991; color: #4ad991; }
  .bs-hero-foot {
    font-size: 12px; color: #6b7480; line-height: 1.55; margin-top: 14px;
  }
  .bs-hero-right { display: flex; flex-direction: column; gap: 8px; }
  .bs-video {
    width: 100%; height: auto; border-radius: 10px;
    background: #000; aspect-ratio: 16 / 9; object-fit: contain;
  }
  .bs-video-cap { font-size: 11.5px; color: #6b7480; text-align: center; }

  /* Steps list */
  .bs-steps {
    background: #0e131a; border: 1px solid #1a1f27; border-radius: 12px;
    padding: 24px 28px; margin-bottom: 24px;
  }
  .bs-h2 { font-size: 16px; font-weight: 600; color: #e8edf2; margin: 0 0 16px; }
  .bs-list {
    margin: 0; padding-left: 22px; color: #cfd6dd;
    font-size: 13.5px; line-height: 1.7;
  }
  .bs-list > li { margin-bottom: 18px; }
  .bs-list > li:last-child { margin-bottom: 0; }
  .bs-list b { color: #e8edf2; }
  .bs-list a { color: #4ad991; text-decoration: none; }
  .bs-list a:hover { text-decoration: underline; }
  .bs-note {
    margin-top: 8px; padding: 10px 14px; border-radius: 8px;
    background: #11161d; border: 1px solid #1a1f27;
    font-size: 12.5px; color: #9aa5b1; line-height: 1.55;
  }
  .bs-note b { color: #cfd6dd; }

  .bs-safety {
    background: rgba(74, 217, 145, 0.06);
    border: 1px solid rgba(74, 217, 145, 0.25);
    border-radius: 10px; padding: 16px 18px; margin-bottom: 28px;
    font-size: 13px; color: #cfd6dd;
  }
  .bs-safety b { color: #4ad991; }
  .bs-safety-body { margin-top: 6px; line-height: 1.6; }
  .bs-safety-body b { color: #e8edf2; }

  .bs-bottom-cta {
    display: flex; flex-direction: column; align-items: center; gap: 12px;
    padding: 28px;
    background: linear-gradient(180deg, #11161d 0%, #0e131a 100%);
    border: 1px solid #1f2630; border-radius: 14px;
  }
  .bs-bottom-cta-label {
    font-size: 14px; color: #cfd6dd; font-weight: 500;
  }

  @media (max-width: 720px) {
    .bs-hero { grid-template-columns: 1fr; padding: 22px 20px; }
    .cabinet-main { padding: 22px 14px 60px; }
  }
</style>
`;
}
