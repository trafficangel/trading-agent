# Audit Findings & Improvement Roadmap

Прогон по всей кодовой базе Track D (SaaS copytrading), сделан 19 мая 2026
сразу после того как все базовые модули собраны и закоммичены.

Цель документа — список конкретных следующих шагов **помимо** добавления
новых стратегий. Разделены по приоритету: CRITICAL → HIGH → NICE TO HAVE.

---

## 🚨 CRITICAL — закрыть ДО первого платящего клиента

### 1. CSRF-защита на cabinet mutations
**Где:** все `POST /account/*` + `POST /admin/*`
**Проблема:** cookie с `sameSite: 'lax'` НЕ защищает от cross-site form-submit.
Злоумышленник может сделать страницу с скрытой формой
`POST /account/api-key/revoke` — пользователь зашёл на эту страницу и
у него молча отозвали ключ. Аналогично admin: подставная страница
может вызвать «Сделать VIP» от лица оператора.
**Фикс:** добавить одну middleware:
- На GET генерируем CSRF-токен, кладём в HttpOnly cookie + в hidden-input
  формы
- На POST сверяем токен из cookie с токеном в body (double-submit pattern)
- ~30 строк кода, защищает весь cabinet и admin разом

### 2. Expiry-sweeper job — триальщики торгуют после конца триала
**Где:** репо `user-subscriptions.ts:164` имеет `listOverdue()` но никто
не вызывает.
**Проблема:** `hasActiveAccess()` корректно возвращает false когда срок
вышел, но `status` остаётся `'trial'` навсегда. На странице кабинета
пользователь видит «Демо доступ · −5 дней» (статус не обновился) — UX
гниль. Хуже: SQL в `listEligibleTargets` имеет двойной check (status +
date), но если когда-нибудь упростим — сразу баг.
**Фикс:** cron `src/jobs/subscription-sweeper.ts`, каждые 5 минут:
```ts
for (const sub of listOverdue()) setStatus(sub.user_id, 'expired');
```
30 минут работы.

### 3. Reconcile пишет `close_reason='sl_hit'` для всех закрытий
**Где:** `src/jobs/tpsl-monitor.ts:205`
**Проблема:** когда Bybit-позиция исчезла, мы пишем `sl_hit` независимо
от причины (TP, ручное закрытие на бирже, ликвидация). PnL-классификация
в кабинете и admin — врёт.
**Фикс:** вызвать `/v5/execution/list` с `startTime = decision.created_at`,
найти exec где `execType='Trade'` и `side != position.side`, прочитать
`closedPnl` + `execPrice` оттуда. TODO уже задокументирован в коде на L197.

### 4. Race: subscription/key revocation между listEligibleTargets и order
**Где:** `src/strategies/user-fanout.ts:122`
**Проблема:** между `listEligibleTargets()` (joins everything) и
`placeMarketOrder()` (через ~50-200мс) пользователь может успеть
отозвать ключ или подписку истечёт. Ордер всё равно поставится.
**Фикс:** проверка `hasActiveAccess(t.user_id)` сразу перед
`placeMarketOrder`. Дешёво.

### 5. Plaintext OTP-код в БД до верификации
**Где:** `src/auth/session.ts` insertAttemptStmt
**Проблема:** если БД украдут до того как пользователь введёт код —
у атакующего пара (phone, OTP) → можно зайти.
**Фикс:** хранить `sha256(code + pepper)` вместо plaintext; на verify
сравнивать хеши. Pepper — отдельная env-переменная.

---

## ⚠️ HIGH — закрыть в течение 2 недель

### 6. Idempotency на TradingView webhook
**Где:** `src/strategies/strategy-trader.ts` handleStrategyEntry
**Проблема:** TV ретраит webhooks на сетевые сбои/5xx. Если ретрай
прилетит после успешной обработки → откроются ДУБЛИРУЮЩИЕ позиции
у всех юзеров.
**Фикс:** unique-index `(strategy_id, symbol, side, bar_time)` на
decisions table; INSERT с `OR IGNORE`. Или дедуп по последней активной
позиции на (symbol, strategy_id) — уже есть, но добавить time-window
guard на 5 секунд.

### 7. balanceCache теряется на рестарте
**Где:** `src/user/routes.ts:411`
**Проблема:** in-memory Map. После `systemctl restart` все юзеры видят
"—" пока вручную не нажмут «Проверить связь».
**Фикс:** колонка `last_balance_usdt` + `last_balance_at` в
`user_api_keys`. Обновляется на каждом verify.

### 8. Пагинация на /account/trades
**Где:** `src/user/routes.ts:68` — `LIMIT 200`
**Проблема:** через 6 месяцев у активного юзера будет 500+ сделок, он
увидит только 200 и не узнает что есть старше.
**Фикс:** `?page=N` + индикатор «показано 200 из X».

### 9. Bybit rate limits на масштабе 50+ юзеров
**Где:** `user-fanout.ts:64` — `pLimit(10)`
**Проблема:** 10 одновременных fan-out на 50 юзеров = 50 setLeverage +
50 placeOrder через 5 «волн». Если у нескольких юзеров одна симол на
одной бирже — Bybit может вернуть 429.
**Фикс:** добавить `429 retry-with-exponential-backoff` в `signedPost`.

### 10. Leverage mismatch на существующей позиции
**Где:** `bybit-private.ts` setLeverage
**Проблема:** если у юзера уже открыта позиция на BTCUSDT с leverage 5x,
а наш `setLeverage(symbol, 10)` вернёт error 110044 («active position»).
Сейчас мы это даже не ловим осмысленно — просто пометим ключ как broken.
**Фикс:** при 110044 → пропустить юзера + флэш в кабинет «у вас открыта
позиция, закройте сначала».

### 11. Admin actions без audit-table
**Где:** `src/admin/routes.ts:304, 341` — только `logger.info`
**Проблема:** через год логи ротируются и невозможно ответить «кто
выдал VIP юзеру X 3 месяца назад».
**Фикс:** таблица `admin_audit_log(ts, admin_email, user_id, action,
before_json, after_json)`, INSERT в одной транзакции с мутацией.

### 12. Admin Basic Auth — timing attack на email comparison
**Где:** `src/admin/routes.ts:71` — обычная `===` строк
**Проблема:** теоретически можно перечислить email посимвольно по
времени отклика. Малореально, но один `crypto.timingSafeEqual` всё
закрывает.
**Фикс:** 5 строк замены.

### 13. SL не верифицируется в reconcile
**Где:** `tpsl-monitor.ts` reconcileUserPosition
**Проблема:** проверяем что позиция открыта, но не что SL **прицеплен**
к ней. Bybit изредка снимает SL (margin events). Позиция остаётся без
страховки.
**Фикс:** каждые 5 минут: `fetchPosition()` → проверить `stopLoss > 0`;
если нет → `setPositionSL` повторно + alert в Logs.

### 14. Email/TG-нотификация «триал истекает завтра»
**Где:** `listExpiringBetween` есть, но caller-а нет
**Проблема:** юзер забыл что у него триал → внезапно прекращаются
сделки → негативный отзыв вместо превентивного «пиши оператору
продлим».
**Фикс:** cron, каждый день в 09:00 UTC: найти всех у кого
`access_until ∈ [now+24h, now+48h]` → TG-сообщение «триал кончается
завтра, продлевайте» через Gateway (или просто email если соберём
email-field).

---

## 💡 NICE TO HAVE — улучшать со временем

### 15. PRG-паттерн на cabinet POST
Сейчас `POST /account/strategies` возвращает HTML. F5 → диалог
«отправить форму повторно?». Исправить на 303-redirect + flash через
short-lived cookie.

### 16. UX dead-end на /account/api-key при verify_failed
Если ключ сломан, кнопка «Проверить связь» нажмётся и снова упадёт.
Не показываем что делать. Если retCode = IP-whitelist — линк прямо
на Bybit-страницу с инструкцией «добавь IP 144.124.250.47».

### 17. Хардкод VIP_PHONES требует деплой
Сейчас добавление VIP-юзера = редакт `src/auth/vip-allowlist.ts`
+ commit + deploy. На 1-2 юзера ОК, на 20 — надо двинуть в БД +
сделать UI на /admin.

### 18. Pagination на /admin
Сейчас 500 регистраций без сортировки/фильтра. На 2000 юзерах будет
неудобно. Добавить пагинацию + поиск по имени/телефону.

### 19. `recordVerifyResult(false)` на любую ошибку fan-out
**Где:** `user-fanout.ts:143, 154, 168`
**Проблема:** insufficient_balance тоже метит ключ как broken — а
ключ-то рабочий. Юзер увидит «ошибка проверки» и не поймёт что просто
надо пополнить депозит.
**Фикс:** мечать verify_failed только на auth-class коды (10003/10004/
10005/10010/10005), не на 110007 (insufficient_balance) и т.п.

### 20. Графики PnL на /account
Сейчас в кабинете только числа. Маленький sparkline кумулятивного PnL
по сделкам юзера = огромный апгрейд UX. Использовать тот же `sparklineSvg`
из `landing.ts` что уже есть.

### 21. Onboarding wizard для нового пользователя
Сейчас юзер регистрируется → видит пустой dashboard → должен сам понять
что надо подключить ключ → выбрать стратегии. 3 шага без явной воронки.
Добавить «Шаг 1 из 3» бэйдж на dashboard когда чего-то не хватает.

### 22. Email/SMS verification как fallback
Сейчас только Telegram Gateway. Если у юзера нет Telegram — он
буквально не может зарегистрироваться. На паблик-маркет это ограничение.

### 23. Stripe / ЮKassa billing
Сейчас оплата руками через @dboykod. Понятно для бета — не пойдёт на
100+ юзеров. Stripe Subscription Billing — 3-4 дня работы.

### 24. Healthcheck endpoint для UptimeRobot
`/health` есть, но он отвечает 200 даже когда БД залочена. Реальный
health включает: SQLite-ping, последний tpsl-tick < 90 секунд назад,
ласт-вебхук-парсер не throws.

### 25. Hyperliquid Vault — параллельный канал
Если кто-то не хочет дать API-ключ Bybit, может задепозитить в
ваш Hyperliquid Vault на смарт-контракте. PnL пропорционально.
Уже в roadmap, но это полноценный отдельный проект.

---

## 📊 Метрики которые стоит начать собирать прямо сейчас

| Метрика | Зачем |
|---|---|
| `gate_view_count` | сколько раз visitors дошли до OTP-формы |
| `register_success_count` | сколько реально завершило регистрацию |
| `api_key_connect_count` | сколько подключили ключ |
| `strategy_enable_count` | сколько включили хотя бы 1 стратегию |
| `first_trade_count` | сколько получили хотя бы одну сделку |
| `trial_to_paid_conversion` | % юзеров которые оплатили после триала |
| `monthly_active_users` | сколько вошли в кабинет за последние 30 дней |

Они дают conversion funnel + retention. Сейчас Yandex.Metrika только
clickmap снимает — для бизнес-метрик нужны custom events.

---

## 🎯 Если бы я делал следующие 2 недели

1. **День 1-2**: CSRF + expiry-sweeper + reconcile execution-list lookup
   (CRITICAL #1, #2, #3)
2. **День 3**: idempotency on webhook + leverage mismatch handling
   (HIGH #6, #10)
3. **День 4**: admin audit log + balance caching in DB
   (HIGH #7, #11)
4. **День 5-6**: trial-expiry notification + recordVerifyResult precision
   (HIGH #14, NICE #19)
5. **День 7-8**: onboarding wizard + PRG pattern + UX dead-end fix
   (NICE #15, #16, #21)
6. **День 9-14**: Stripe integration + custom events для конверсии
   (NICE #23 + metrics)

Это закроет всё что блокирует «пускать платящих клиентов в production».
Стратегии можно добавлять параллельно — это независимый трек.

---

## Что НЕ требует немедленного внимания

Намеренно опущенные вещи (стабильно работают, но можно улучшить):
- TypeScript типы (всё `strict`-чисто)
- Тесты (пока ноль unit-тестов на новые модули, но руками всё проверено
  через preview screenshots) — добавлять после критических багов
- Backup / disaster recovery — SQLite файл копируется ежедневно
- Логирование — pino-структурный лог хорошо работает
- Безопасность инфры (sudo, fail2ban на VPS) — уже настроено

---

Документ живой. Когда что-то закрываешь — двигай в **DONE** секцию
ниже, добавляй коммит-хеш для аудита.

## DONE

(пусто пока)
