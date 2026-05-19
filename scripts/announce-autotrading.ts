/**
 * One-shot operator script — publishes the autotrading launch
 * announcement to the Signals channel.
 *
 * Usage:
 *   pnpm tsx scripts/announce-autotrading.ts --dry-run    # preview only
 *   pnpm tsx scripts/announce-autotrading.ts              # publishes
 *
 * Requires env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHANNEL_SIGNALS — loaded
 * automatically through src/config.ts.
 */

import { sendMessage } from '../src/telegram/bot.js';

const LANDING_BASE = process.env.LANDING_BASE_URL ?? 'https://robotclaude.biz';

const text = [
  `🚀 <b>АВТОТРЕЙДИНГ ДОСТУПЕН ПОДПИСЧИКАМ</b>`,
  ``,
  `Раньше канал давал только сигналы — нужно было всё исполнять руками. Теперь стратегии могут торговать <b>напрямую на вашем счёте Bybit</b> в фоне.`,
  ``,
  `<b>Как это работает</b>`,
  `  • Регистрируетесь в кабинете по номеру телефона`,
  `  • Создаёте на Bybit API-ключ с правом «торговать» (без права на вывод)`,
  `  • Вставляете ключ в кабинет, выбираете стратегии и размер позиции`,
  `  • Когда стратегия даёт сигнал — мы открываем сделку на вашем счёте и ставим защитный стоп. Закрываем тоже автоматически.`,
  ``,
  `<b>Что под капотом</b>`,
  `  🛡 Ключ шифруется AES-256-GCM, читать его не может даже наш сервер из БД`,
  `  🛡 Без права на вывод — деньги всегда остаются у вас на Bybit`,
  `  🛡 После открытия позиции мы перепроверяем, что стоп реально привязался к позиции на бирже`,
  `  🛡 Мониторинг баланса каждые 5 минут — если средств для обеспечения недостаточно, торговля автоматически встаёт на паузу до пополнения`,
  `  🛡 При отвязке ключа сначала закрываются все открытые позиции, потом ключ удаляется — никаких «забытых» сделок`,
  ``,
  `<b>Личный кабинет</b>`,
  `  • Дашборд: подписка, статус ключа, обеспечение, открытые позиции, результат`,
  `  • Калькулятор обеспечения с живым подсчётом «хватает / не хватает» при изменении размера позиции или плеча`,
  `  • История ваших сделок с привязкой к сигналам стратегий`,
  `  • Кнопки «Остановить торговлю / Возобновить» — пауза в один клик`,
  ``,
  `<b>Цена и доступ</b>`,
  `  💳 $50/мес, оплата вручную через оператора`,
  `  🎁 14 дней демо-доступа бесплатно — успеете оценить как работает`,
  ``,
  `<b>Начать</b>`,
  `  🔗 <a href="${LANDING_BASE}/autotrading">${LANDING_BASE}/autotrading</a> — подробности + регистрация`,
  `  🔗 <a href="${LANDING_BASE}/account">${LANDING_BASE}/account</a> — личный кабинет (если уже зарегистрированы)`,
  ``,
  `<i>⚠ Прошлые результаты не гарантируют будущих. В живой торговле возможна дополнительная погрешность исполнения относительно бэктеста.</i>`,
].join('\n');

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  if (dryRun) {
    console.log('--- DRY RUN: post preview (HTML, not published) ---');
    console.log(text);
    console.log('---');
    console.log(`Would post to channel 'signals' with link preview ENABLED.`);
    console.log(`Re-run without --dry-run to publish.`);
    return;
  }

  console.error('Publishing autotrading announcement to signals channel…');
  const res = await sendMessage({
    channel: 'signals',
    text,
    disable_web_page_preview: false,
    // Announcement = important, normal notification on.
    disable_notification: false,
  });
  if (!res) {
    console.error('Publish failed — check logs above');
    process.exit(1);
  }
  console.error(`Published OK (message_id=${res.message_id}).`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
