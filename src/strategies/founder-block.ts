/**
 * Founder bio block — used on the public home page (/) and originally
 * on /autotrading. Self-contained: returns its own <style> + <section>
 * so any consumer can drop it into a page body without touching the
 * page's CSS bundle. Class names are prefixed `rc-founder-*` (Robot
 * Claude) to avoid collisions with page-local class namespaces.
 *
 * Photo: served from /static/founder.jpg via @fastify/static. Committed
 * to the repo at public/founder.jpg so deploys ship the asset alongside
 * the code. Bump the `?v=N` query string whenever the file is replaced
 * to bypass the 7-day max-age cache + CF edge cache.
 */

type Lang = 'ru' | 'en';

const SUPPORT_TG = 'https://t.me/dboykod';

function ico(emoji: string): string {
  return `<span class="rc-founder-ico" aria-hidden="true">${emoji}</span>`;
}

export function renderFounderBlock(lang: Lang): string {
  const avatarSrc = '/static/founder.jpg?v=1';

  const bodyHtml = lang === 'en'
    ? `
      <div class="rc-founder-name">Dmitry Boyko <span class="rc-founder-meta">· founder, Sevastopol · in crypto since 2010</span></div>
      <p>
        I lost my first 10 bitcoins in 2014 when <b>MtGOX</b> collapsed — back then that was a huge scandal.
        That didn't push me out of the industry, it pulled me deeper into it. I went through the ICO boom,
        DeFi summer, the NFT mania. Self-taught the whole way — manual trading, designing my own strategies,
        constantly getting humbled by the market.
      </p>
      <p>
        Three years ago I found <b>LuxAlgo</b>, an algorithmic platform for trading signals. I spent
        evenings after my day job learning it. Yet another attempt to systematize trading — with mixed
        results, because building it solo to production quality was beyond what I could ship.
      </p>
      <p>
        In <b>2026</b> tools like <b>Claude Code</b> finally made it possible for one person to ship a
        production-grade trading service end-to-end. I quit my day job and built <b>Robot Claude</b> — not
        another «guru prediction», but a working system for people who, like me, have lost years to manual
        trading and emotional decisions.
      </p>
      <p>
        I'm building this for myself, and for everyone who cares about this industry too. The whole system
        is transparent — every trade is public, every line of risk math is visible. Try it for 14 days
        before you pay anything. If it doesn't fit you — walk away in one click.
      </p>
      <div class="rc-founder-cta">
        <a href="${SUPPORT_TG}" target="_blank" rel="noopener" class="rc-founder-btn">${ico('💬')}Message me on Telegram</a>
      </div>`
    : `
      <div class="rc-founder-name">Дмитрий Бойко <span class="rc-founder-meta">· основатель, Севастополь · в крипте с 2010</span></div>
      <p>
        Свои первые 10 биткоинов потерял в 2014, когда обанкротилась биржа <b>MtGOX</b> —
        тогда это был громкий скандал. После этого из индустрии не уходил: пережил бум ICO,
        DeFi-лето, NFT-волну. Учился сам — все эти годы пробовал торговать руками, изобретал
        свои стратегии, систематизировал, ловил подъёмы и проседания.
      </p>
      <p>
        Три года назад наткнулся на <b>LuxAlgo</b> — алгоритмическую платформу для построения
        торговых сигналов. После работы вечерами разбирался в её механиках. Ещё одна попытка
        систематизировать торговлю — с переменным успехом: собрать продакшн-сервис в одиночку
        не получалось.
      </p>
      <p>
        В <b>2026 году</b> появились такие инструменты как <b>Claude Code</b>. С их помощью
        можно собрать продакшн-сервис в одиночку. Я уволился с основной работы и взялся за
        <b>Robot Claude</b> — не очередной «прогноз гуру», а рабочая торговая система
        для тех, кто, как я, потерял годы на ручной торговле и эмоциональных решениях.
      </p>
      <p>
        Делаю это и для себя, и для всех, кому небезразлична эта индустрия. Вся система
        прозрачна — каждая сделка публична, вся математика риска видна. Попробуйте 14 дней
        до того как платить. Не подойдёт — отказ в один клик.
      </p>
      <div class="rc-founder-cta">
        <a href="${SUPPORT_TG}" target="_blank" rel="noopener" class="rc-founder-btn">${ico('💬')}Написать в Telegram</a>
      </div>`;

  const title = lang === 'en' ? 'Who\'s behind this' : 'Кто стоит за проектом';
  const alt = lang === 'en' ? 'Dmitry Boyko' : 'Дмитрий Бойко';

  return `
    ${founderStyles()}
    <section class="rc-founder">
      <h2 class="rc-founder-title">${ico('👋')}${title}</h2>
      <div class="rc-founder-card">
        <div class="rc-founder-avatar">
          <img src="${avatarSrc}" alt="${alt}" />
        </div>
        <div class="rc-founder-body">${bodyHtml}</div>
      </div>
    </section>
  `;
}

function founderStyles(): string {
  return `
<style>
  .rc-founder { margin: 50px auto; max-width: 1100px; padding: 0 20px; }
  .rc-founder-title {
    font-size: 24px; font-weight: 600; margin: 0 0 20px;
    color: #e8edf2; letter-spacing: -0.01em;
  }
  .rc-founder-ico { display: inline-block; margin-right: 8px; vertical-align: -1px; line-height: 1; }
  .rc-founder-card {
    display: grid; grid-template-columns: 180px 1fr; gap: 32px;
    align-items: start; max-width: 920px; margin: 0 auto;
    background: linear-gradient(180deg, #11161d 0%, #0e131a 100%);
    border: 1px solid #1f2630; border-radius: 14px; padding: 32px;
  }
  .rc-founder-avatar {
    width: 180px; height: 180px; border-radius: 50%;
    overflow: hidden;
    border: 3px solid rgba(74, 217, 145, 0.30);
    box-shadow: 0 6px 24px -8px rgba(74, 217, 145, 0.25);
  }
  /* object-position biases the crop towards the founder's face (source
     image is wide-format with the subject in the right third). Tweak
     this if the photo is ever replaced. */
  .rc-founder-avatar img {
    width: 100%; height: 100%; object-fit: cover; display: block;
    object-position: 62% 30%;
  }
  .rc-founder-body { color: #cfd6dd; font-size: 14.5px; line-height: 1.7; }
  .rc-founder-body p { margin: 0 0 14px 0; }
  .rc-founder-body p:last-of-type { margin-bottom: 18px; }
  .rc-founder-body b { color: #e8edf2; font-weight: 600; }
  .rc-founder-name {
    font-size: 20px; font-weight: 600; color: #e8edf2;
    margin-bottom: 14px; line-height: 1.35;
  }
  .rc-founder-meta {
    font-size: 13px; color: #8590a0; font-weight: 400; display: block;
    margin-top: 2px;
  }
  .rc-founder-cta { margin-top: 6px; }
  .rc-founder-btn {
    display: inline-flex; align-items: center;
    padding: 11px 22px; background: #11161d; color: #4ad991;
    border: 1px solid rgba(74, 217, 145, 0.45); border-radius: 9px;
    font-weight: 600; font-size: 14px;
    text-decoration: none; transition: background 0.15s, color 0.15s;
  }
  .rc-founder-btn:hover { background: rgba(74, 217, 145, 0.12); }
  @media (max-width: 720px) {
    .rc-founder-card {
      grid-template-columns: 1fr; gap: 22px;
      padding: 24px 20px; text-align: left;
    }
    .rc-founder-avatar { width: 140px; height: 140px; margin: 0 auto; }
    .rc-founder-name { text-align: center; font-size: 18px; }
    .rc-founder-cta { text-align: center; }
  }
</style>
  `;
}
