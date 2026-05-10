# Trading Agent — Roadmap

Живой документ. Обновляем галочки по мере прохождения, переносим выполненные пункты в раздел "Done" внизу со ссылкой на коммит. Приоритеты по влиянию на PnL: ⭐⭐⭐ большое, ⭐⭐ среднее, ⭐ маржинальное.

---

## Текущее состояние (baseline)

- ✅ Stage 1: webhook receiver + SQLite + Telegram raw logs
- ✅ Stage 2 shadow mode: aggregator → LLM decide (4 чарта: subj 15m+1H + BTC 15m+1H) → Telegram Signals
- ✅ Hourly monitor LLM (HOLD/CLOSE/MODIFY) с подавлением тривиальных MODIFY < 0.3%
- ✅ TP/SL hit detection через minute-poll Bybit price + result-template
- ✅ Heartbeat (4h) + Daily wrap (23:55 UTC)
- ✅ Bybit sentiment в промпт: funding rate + OI delta + L/S ratio
- ✅ Self-critique pass на каждом OPEN (KEEP / DOWNGRADE_TO_SKIP)
- ✅ SCORE_THRESHOLD=4, WINDOW=20 мин — настройки на объём решений в shadow
- ✅ TradingView "Session disconnected" auto-reclaim в Playwright

**Параметры в проде:**
- `SCORE_THRESHOLD = 4`
- `WINDOW_MS = 20 min`
- `COOLDOWN_MS = 15 min` на ту же сторону на символе
- `SUBSTANTIAL_CHANGE_PCT = 0.3` для MODIFY
- TF multipliers: 5m=×0.7, 15m=×1.0, 1H=×1.5, 4H=×1.8, D=×2.0
- LLM: claude-sonnet-4-5, vision, 1500 max_tokens decide / 800 critique / 1500 monitor
- Monitor cron: `0 * * * *` (раз в час)
- TPSL cron: `* * * * *` (раз в минуту)
- Heartbeat: `0 */4 * * *`
- Daily wrap: `55 23 * * *` UTC

---

## Tier 1 — Information edge (модель видит больше)

### 1.1 ⭐⭐⭐ Добавить 4H чарт в context — `[x]` ✅
**Зачем:** swing-структура. Большинство «плохих» сделок идут против 4H тренда — модель просто не видит.
**Файлы:** `src/jobs/decide.ts`, `src/jobs/monitor.ts`, `src/llm/prompt.ts`, `src/llm/monitor-prompt.ts` — добавить пятый screenshot subj 4H, обновить «Attached, in order:» список.
**Стоимость:** +25% input tokens на вызов.
**Effort:** ~1 час.

### 1.2 ⭐⭐⭐ Volume Profile + VWAP уровни в user-сообщение — `[x]` ✅
**Зачем:** реальные S/R (POC, VAH, VAL, VWAP) вместо «на глаз» по чарту → LLM ставит SL/TP по уровням где реально торговался объём.
**Файлы:** новый `src/exchange/bybit-volume.ts` (через `/v5/market/kline`), интеграция в `decide.ts` и оба промпта.
**Effort:** ~4 часа.

### 1.3 ⭐⭐⭐ Multi-exchange orderbook + liquidity clusters — `[x]` ✅
**Зачем:** **Самый сильный edge в крипте.** Aggregated orderbook + stop-cluster detection across Bybit + Binance + OKX. Cross-exchange validation: стенка которая есть на 2+ биржах = настоящая оборона; одиночная стенка только на Bybit = локальный HFT-fake. Stop hunts происходят там где обычно ставят SL → ставим **за** этой зоной.
**Объединено с прежним 1.6** (multi-exchange context) — оба пункта используют одну и ту же инфраструктуру адаптеров.

**Архитектура:**
1. **Adapters** (отдельный файл на биржу, нормализованные shapes):
   - `src/exchange/binance-public.ts`: `/fapi/v1/depth`, `/fapi/v1/premiumIndex`, `/fapi/v1/openInterest`, `/futures/data/openInterestHist`, `/fapi/v1/klines`
   - `src/exchange/okx-public.ts`: `/api/v5/market/books`, `/api/v5/public/funding-rate`, `/api/v5/public/open-interest`, `/api/v5/market/candles`
   - `src/exchange/bybit-public.ts` (extend existing): добавить `/v5/market/orderbook`
2. **Symbol mapper** — единое каноническое имя `TONUSDT` → Bybit `TONUSDT`, Binance `TONUSDT`, OKX `TON-USDT-SWAP`.
3. **Aggregator** `src/exchange/multi-exchange.ts`:
   - `getAggregatedSentiment(symbol)` — weighted avg funding / OI delta / L/S ratio + **divergences между биржами**
   - `getAggregatedOrderbook(symbol)` — нормализация всех книг по mid-price → биннинг 0.05% → топ стенок с пометкой «на скольки биржах подтверждена» + bid/ask ratio
   - `getStopClusters(symbol)` — swings из 4h klines (берём биржу с макс. объёмом — обычно Binance), кластеризация близких уровней
4. **Cross-exchange spread** — если Binance ведёт (price выше Bybit на 0.1%+) → bullish edge для Bybit (алгоритмы подтянут). Для альтов это работает.
5. **Aggregated liquidations** (если успеем): Binance отдаёт `/fapi/v1/forceOrders` с публичным потоком ликвидаций. Каскад → mean reversion вероятна.

**Интеграция:**
- Заменить текущие точечные вызовы `getMarketSentiment` на `getAggregatedSentiment`
- Прокинуть orderbook + stop clusters в `LlmContext` и промпты (decide / monitor / critique)
- Системные правила в промпт:
  * SL не должен попадать **внутрь** stop-cluster зоны — сдвинуть за или SKIP
  * TP цельтесь **через** стенку или **в** stop-cluster зону, не до
  * Стенка только на 1 бирже = подозрение на fake → не используем как уровень
  * Cross-exchange divergence: funding на Binance > Bybit + OI растёт на Binance → инициатива на Binance, перетекание ликвидности

**Volume reality для альтов (TON ориентир):** Binance ≈ 60% объёма, Bybit ≈ 25%, OKX ≈ 15%. Один Bybit видит четверть картины.

**Effort:** ~1.5-2 дня. Этапы по дням:
- День 1: adapters (Binance + OKX) + symbol mapper + базовые тесты с моками
- День 2: aggregator + интеграция в decide/monitor + промпт-правила + тесты
- (Опционально, +0.5 дня): liquidations stream

**Ловушки:**
- Binance геоблокирует API из США/некоторых стран — на нашем VDSina сервере (Россия) должно работать; проверить ping перед началом
- OKX symbol naming: `BASE-QUOTE-SWAP` для perpetual, не `BASEQUOTE`
- OKX timestamp в миллисекундах через строку, кастовать аккуратно
- Rate limits: Binance 2400 req/min, OKX 20 req/2sec, Bybit 50 req/sec — с TTL 30s никаких проблем

### 1.4 ⭐ Корреляты для альтов (ETH context) — `[ ]`
**Зачем:** для не-BTC/ETH альтов добавить ETH 1H — иногда альт коррелирует с ETH сильнее чем с BTC.
**Файлы:** условный fifth screenshot в `decide.ts` если `symbol ∉ {BTC, ETH}`.
**Effort:** ~2 часа.

### 1.5 ⭐⭐ News / event calendar — `[ ]`
**Зачем:** блокировать новые OPEN перед FOMC/CPI/разлоками токенов. Спасает от непредсказуемых сливов на новостях.
**Файлы:** новый `src/exchange/event-calendar.ts` (CoinMarketCal API + Bybit announcements), новый блок проверки в `decide.ts` до вызова LLM.
**Effort:** ~6 часов.

### 1.6 ⭐⭐⭐ ~~Multi-exchange aggregated context~~ — **MERGED INTO 1.3**
Объединено с пунктом 1.3 — оба пункта используют одну и ту же инфраструктуру (адаптеры Binance/OKX/Bybit + symbol mapper + aggregator). См. 1.3.

---

## Tier 2 — Дисциплина риска

### 2.1 ⭐⭐⭐ ATR-based SL sanity check — `[x]` ✅
**Зачем:** LLM ставит SL по структуре. Но 0.3% SL на символе где средняя 5m свеча 0.25% — самоубийство, выбьет шумом. Считаем ATR(14) на 15m, отклоняем сделку (или даунгрейдим в SKIP) если SL дистанция < 0.7×ATR или > 4×ATR.
**Файлы:** новая функция в `src/exchange/bybit-volume.ts` (klines→ATR), gate в `src/risk/manager.ts`.
**Effort:** ~3 часа.

### 2.2 ⭐⭐ Динамический size_pct по confidence — `[x]` ✅
**Зачем:** убрать «робкие OPEN с 2% позиции». После self-critique у нас честный confidence. Маппинг:
```
conf < 0.45 → SKIP (даунгрейд даже если LLM сказала OPEN)
0.45-0.55  → size_pct = 0.5%
0.55-0.65  → size_pct = 1.0%
0.65-0.75  → size_pct = 1.5%
> 0.75     → size_pct = 2.0%
```
**Файлы:** `src/risk/manager.ts` или новый шаг в `src/jobs/decide.ts` после critique.
**Effort:** ~1 час.

### 2.3 ⭐⭐ Don't-trade-in-chop filter — `[x]` ✅
**Зачем:** большинство потерь — в боковике. ATR percentile за 7 дней: < 30-го перцентиля → рынок в чопе → не открываем новые позиции (мониторим существующие).
**Файлы:** новый `src/signals/regime.ts`, gate в `decide.ts`.
**Effort:** ~3 часа. **Зависит от 2.1** (ATR расчёт уже есть).

### 2.4 ⭐ Time-of-day filter — `[ ]`
**Зачем:** часы UTC с win-rate < 40% блокировать.
**Условие:** через 100+ закрытых сделок (нужны данные).
**Effort:** ~2 часа.

### 2.5 ⭐ Funding-clock pause — `[ ]`
**Зачем:** за 15 мин до funding (00:00, 08:00, 16:00 UTC) и 5 мин после — не открывать. Цена прыгает механически.
**Файлы:** простая проверка времени в `decide.ts`.
**Effort:** ~1 час.

---

## Tier 3 — Качество исполнения

### 3.1 ⭐⭐ Multiple TPs (TP1 + TP2) — `[ ]`
**Зачем:** TP1 на 1R закрываем 50% + SL→BE; TP2 на 2-3R runner. Удваивает win-rate, сохраняет upside.
**Зависит от:** 5.1 (Bybit live).
**Effort:** ~8 часов.

### 3.2 ⭐⭐ Limit вместо market на entry — `[ ]`
**Зачем:** LuxAlgo сигналы на закрытии бара → market entry даёт slippage. Лимит на 30-50% от ATR против движения с истечением 30 мин — если retest не пришёл, ордер истекает.
**Зависит от:** 5.1.
**Effort:** ~4 часа.

### 3.3 ⭐⭐ Жёсткое SL→BE на 1R — `[x]` ✅
**Зачем:** monitor LLM уже двигает SL, но иногда «забывает». Детерминистичное правило в risk-gate: при достижении 1R любой MODIFY должен подвинуть SL не дальше entry.
**Файлы:** `src/risk/manager.ts` или `src/jobs/monitor.ts`.
**Effort:** ~2 часа.

---

## Tier 4 — Learning loop

### 4.1 ⭐⭐⭐ Self-critique calibration — `[ ]`
**Зачем:** проверить что critique работает, а не вредит. Симулятивно «открыть» каждый downgraded SKIP по сохранённым entry/sl/tp и посмотреть — выиграл бы он или проиграл. Если 70%+ downgrade'ов реально проигрышные — критика **работает**. Если симметрично — режем.
**Условие:** через 50+ OPEN-кандидатов.
**Файлы:** новый скрипт `scripts/calibrate-critique.ts`.
**Effort:** ~2 часа после набора данных.

### 4.2 ⭐⭐⭐ Decision outcome labelling + weekly post-mortem — `[ ]`
**Зачем:** **самый сильный долгосрочный механизм.** Раз в неделю: топ-3 winning + top-3 losing → скармливаем Claude с reasoning_full → ищем общие паттерны. Полученные insights → правки промпта.
**Файлы:** новый `src/jobs/post-mortem.ts` (cron Sun 23:00 UTC), новая Anthropic-функция.
**Effort:** ~4 часа после 30+ закрытых сделок.

### 4.3 ⭐ A/B prompt testing — `[ ]`
**Зачем:** единственный честный способ улучшать промпт — параллельные версии, рандомное назначение, сравнение PnL.
**Условие:** 100+ решений и стабильный baseline промпт.
**Effort:** ~6 часов.

---

## Tier 5 — Live trading (Stage 3-5 из оригинального плана)

### 5.1 ⭐⭐⭐ Bybit testnet integration — `[ ]`
**Зачем:** real shadow → real testnet. Exchange-side SL/TP (не наш polling), fill events через WS, position reconcile при старте.
**Файлы:** новый `src/exchange/bybit.ts` (ccxt sandbox), `src/positions/reconcile.ts`, обновление `decide.ts` с `placeOrder()` после risk-gate.
**Effort:** 2-3 дня.

### 5.2 ⭐⭐ Approve flow для semi-auto (Stage 4) — `[ ]`
**Зачем:** перед каждым OPEN — Telegram inline-кнопки Approve/Cancel/Pause-30m с тайм-аутом 90с.
**Файлы:** `src/telegram/bot.ts` callback_query handler, `src/telegram/commands.ts`.
**Effort:** ~1 день.

### 5.3 ⭐⭐⭐ Daily kill-switch + sequence circuit-breaker — `[ ]`
**Зачем:** дневной DD ≥ -2% → halt до 00:00 UTC. 3 убытка подряд → halt до утра. Команды `/halt /resume /status` в Telegram.
**Файлы:** `src/risk/halt.ts`, `src/telegram/commands.ts`.
**Effort:** ~4 часа.

---

## Приоритет по неделям

**Неделя текущая** (быстрый edge, дешёвый эффект):
1. 1.1 — 4H chart
2. 1.2 — Volume profile / VWAP
3. 2.1 — ATR sanity
4. 2.2 — Dynamic sizing

**Неделя следующая:**
5. **1.3 — Multi-exchange orderbook + liquidity (~1.5-2 дня)** — главный приоритет, объединил собой 1.6
6. 2.3 — Don't-trade-in-chop
7. 3.3 — Жёсткое SL→BE на 1R

**После 30-50 закрытых сделок:**
8. 4.1 — Critique calibration
9. 4.2 — Weekly post-mortem
10. 1.5 — News calendar (если уже доказали edge без него)

**Когда shadow mode даёт стабильно прибыльные решения:**
11. 5.1 — Bybit testnet (Stage 3)
12. 5.3 — Kill-switches
13. 5.2 — Approve flow (Stage 4)

---

## Done

История выполненных пунктов с ссылками на коммиты:

- ✅ **Stage 1 telemetry** — webhook + SQLite + TG raw → commit `caba2ec`
- ✅ **Stage 2 shadow LLM** — aggregator + Playwright + decide + monitor
- ✅ **BTC context, R:R≥1.5, TV session reclaim** — `caba2ec`
- ✅ **Heartbeat + daily wrap** — `35a8950`
- ✅ **Hourly monitor + suppress trivial MODIFY** — `e4cbd04`
- ✅ **TP/SL hit detection + result post** — `aa17eab`
- ✅ **Bybit sentiment (funding/OI/LS)** — `7fddaea`
- ✅ **Self-critique pass + threshold 4** — `dbac0b3`
- ✅ **Window 20 min** — `182d669`
- ✅ **1.1 Subject 4H chart in context** — adds swing-trend awareness for both decide and monitor passes
- ✅ **1.2 Volume Profile + ATR in prompt** — POC/VAH/VAL/VWAP/ATR(14) computed from 24h of 15m klines, shown to LLM as deterministic S/R levels with usage rules
- ✅ **2.1 ATR-based SL sanity** — risk gate rejects OPEN if SL distance < 0.7×ATR (noise risk) or > 4×ATR (fictional R:R). Tests in tests/unit/risk.test.ts
- ✅ **2.2 Confidence-tiered sizing** — `src/risk/sizing.ts` maps post-critique confidence to fixed size_pct tiers (0.5/1.0/1.5/2.0%); confidence < 0.45 forces SKIP regardless of LLM verdict
- ✅ **1.3 Multi-exchange orderbook + liquidity clusters** — adapters for Binance + OKX (`binance-public.ts`, `okx-public.ts`), Bybit orderbook extension, symbol mapper. Aggregator `multi-exchange.ts` produces: weighted funding + divergence; aggregated orderbook with cross-exchange-confirmed walls; stop-cluster zones from 4H swings. New system-prompt rules for using cross-confirmed walls vs HFT fakes, stop-hunt avoidance, and divergence signals. Smoke-tested on TONUSDT — 9/9 walls confirmed cross-exchange, divergence detected
- ✅ **2.3 Don't-trade-in-chop filter** — `src/signals/regime.ts` computes ATR(14) percentile rank over 7 days of 15m klines. Current ATR < 30th percentile → block LLM call entirely (Logs notification only). Existing positions unaffected (monitor cron continues). Smoke-tested: TON percentile 34 (active), BTC/ETH percentile 0 (in chop, blocked)
- ✅ **3.3 Auto SL→BE on 1R + MODIFY actually applies to position** — tpsl-monitor checks 1R achievement every minute and force-moves SL to entry; subsequent SL hits exit at 0R (true break-even). Bonus fix: monitor LLM's MODIFY decisions previously affected only the audit row but never updated the parent's SL — now `updatePositionSl()` is called for both LLM-MODIFY (with anti-widen guard) and auto-BE flows
- ✅ **1.3 Phase D: Aggregated liquidations stream** — Binance forceOrder WebSocket listener (started in server.ts, persistent connection with auto-reconnect + idle-detection). Per-symbol rolling 5-min bucket of liquidations >= $1k. Cascade detection: $5M+ on one side AND >= 5x other side → mean-reversion signal. Wired into decide / monitor / critique with explicit prompt rules ("LONG-side cascade against position = forced sells exhausting, our LONG is in trouble"). Hourly billing-error alerts safe (this stream is free public data)
- ✅ **Anthropic billing alert** — `src/llm/billing-alert.ts` detects credit-balance/quota errors in API responses and posts loud Logs notification with throttle 1/hr. Wired into all 3 LLM call sites (decide, monitor, critique) with retry-loop short-circuit
- ✅ **TradingView session detector + auto-relogin script** — `detectLoggedOut()` in tradingview.ts throws hard error when cookie banner / no user-menu indicates anonymous session; alerts Logs channel. `scripts/tradingview-login-auto.ts` automates the full login including 2FA backup-code consumption from `~/.ssh/trading-creds.txt`

---

## Оперативные параметры — обоснования и история

| Параметр | Значение | Когда менялось | Почему текущее значение |
|---|---|---|---|
| `SCORE_THRESHOLD` | 4 | 6→4 в `dbac0b3` | Нужен объём решений в shadow для оценки |
| `WINDOW_MS` | 20 мин | 10→20 в `182d669` | Покрывает 2 смежных 15m бара |
| `COOLDOWN_MS` | 15 мин | стартовое | Защита от спама на одном confluence |
| `SUBSTANTIAL_CHANGE_PCT` | 0.3% | стартовое | Подавляет тривиальные MODIFY |
| Monitor cron | hourly | 30→60 мин | 15m primary TF не меняется быстрее часа |
| TPSL cron | 1 мин | стартовое | Минимум для shadow detection |

Открытые вопросы для будущего тюнинга (зависят от данных):
- Опустить `WINDOW_MS` до 15 мин если 20 даёт ложные триггеры (5m signals накапливаются)?
- Поднять `SCORE_THRESHOLD` до 5 если 4 даёт слишком много слабых OPEN'ов?
- 5m alerts: оставить ×0.7, опустить до ×0.5, или вообще выключить — решаем после ~30 OPEN решений
