# Trading Agent — Roadmap

Живой документ. Обновляем галочки по мере прохождения, переносим выполненные пункты в раздел "Done" внизу со ссылкой на коммит. Приоритеты по влиянию на PnL: ⭐⭐⭐ большое, ⭐⭐ среднее, ⭐ маржинальное.

---

## Текущее состояние (baseline) — обновлено 2026-05-12

### Архитектура
- ✅ **Scheduled decisions** (не event-driven): cron `1,16,31,46 * * * *`
- ✅ Aggregator: per-TF retention windows (5m: 2h, 15m: 6h, 1H: 12h, 4H: 48h, 1D: 7d)
- ✅ Веса confluence **убраны** — LLM сама судит сырые сигналы
- ✅ LLM context: 5 чартов (subj 15m+1H+4H + BTC 15m+1H), multi-exchange sentiment (Bybit+Binance+OKX), volume profile, aggregated orderbook, stop clusters, liquidations
- ✅ Self-critique pass + Confidence-tier sizing + Risk gates (SL%, ATR×, R:R)
- ✅ **Pending-limit lifecycle:** limit размещается → ждёт ретест 2h → активируется в реальную сделку с trade# ИЛИ отменяется
- ✅ Active-or-pending guard: не открываем дубль на символе где есть live или waiting позиция

### Cron'ы
- Decide-cron: `1,16,31,46 * * * *` (15m-aligned)
- Monitor-cron: same schedule (active position management)
- TPSL-cron: `* * * * *` (TP/SL hit + pending-limit fill/expire + auto SL→BE)
- Health watchdog: `*/10 * * * *` (alert if any cron stale > 30 min or RAM > 1GB)
- Heartbeat: `0 */4 * * *`
- Daily wrap: `55 23 * * *` UTC

### Параметры в проде
- TF windows aggregator (на сигнал): см. выше
- LLM: `claude-sonnet-4-5`, vision, 2500 max_tokens decide/monitor, 800 critique
- Prompt caching: system prompts cache_control=ephemeral (5-min TTL, ~30% input savings)
- Confidence floor: 0.40 (ниже → SKIP)
- Sizing tiers: 0.40-0.50 → 0.5% / 0.50-0.60 → 1.0% / 0.60-0.70 → 1.5% / ≥0.70 → 2.0%
- Risk gates: SL 0.2-5%, 0.7×ATR ≤ SL ≤ 4×ATR, R:R ≥ 1.5, size ≤ 2%
- Pending-limit TTL: 2 hours
- Auto SL→BE: при достижении 1R
- Anthropic billing alert + TradingView logged-out/no-indicators detection + modal-killer
- TV_LAYOUT_ID env для пина layout с индикаторами

### Continuous improvement layer
- ✅ Outcome enrichment: features_json в каждом decision (confidence_bucket, cited_levels, cascade, funding_state, btc_alignment, prompt_version, critique_downgrade, entry_type)
- ✅ Calibration analysis script (`scripts/analyze-calibration.ts`): win-rate/avgR по bucket / level / cascade / btc / prompt-version / entry-type
- ✅ Daily wrap показывает: closed trades с PnL%/R/USD, win-rate, avg R, breakdown по entry_type, pending limits с TTL, cancelled limits отдельно (не в P&L)

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

## Приоритет — обновлено 2026-05-12

### Что СЕЙЧАС блокирует прогресс
Главное узкое место — **мало закрытых сделок с реальным PnL** для валидации. К утру 12 мая в production:
- 3 закрытые сделки за день (1W/2L = 33% win-rate, -3R, -$33/$1000)
- 1 pending limit, 3 cancelled limits (75% лимитов не сработали)
- Все аналитические инструменты на месте, **ждут данных**

Без 30-50 закрытых сделок calibration/post-mortem/A-B не дадут осмысленных цифр.

### Текущая неделя (defensive — пока копится статистика)
1. **5.3 — Daily kill-switch + circuit-breaker (~4ч)** — нужно ДО любого live trading. После 3 убытков подряд или DD -2%/день → halt. Можно делать пока ждём статистики.
2. **2.5 — Funding-clock pause (~1ч)** — мелкая, дешёвая, реально полезная.
3. **Backtest harness (~1-2 дня)** — НЕ в roadmap старом, добавлен. Прогон pipeline на 6-12 мес исторических данных = **единственный честный способ** узнать expectancy ДО рисковки. См. новый раздел "Tier 6" ниже.

### Когда накопится 20-30 закрытых сделок (~3-5 дней при текущем темпе)
4. **4.1 — Critique calibration** — реально работает self-critique или режет хорошее
5. **4.2 — Weekly post-mortem cron** — automated insights от LLM
6. **2.4 — Time-of-day filter** — какие часы УТК выигрывают/проигрывают
7. Возможно: подкрутить prompt на основании эмпирики из calibration

### Когда статистика покажет positive expectancy (после backtest + 50 closed)
8. **5.1 — Bybit testnet integration (2-3 дня)** — переход на real exchange execution
9. **5.2 — Approve flow** (Stage 4 semi-auto)
10. **3.1 — Multiple TPs** (TP1/TP2 + trailing) — реализуется в testnet
11. **3.2 — Real limit orders** на бирже (текущий pending-limit будет executor'om)

### Опциональные info edges (если базовая стратегия работает)
12. **1.4 — ETH context для альтов** (~2ч)
13. **1.5 — News calendar** (~6ч)
14. **4.3 — A/B prompt testing** (после 100+ trades)

---

## Tier 6 — Validation infrastructure (новый, добавлено 2026-05-12)

### 6.1 ⭐⭐⭐ Backtest harness — `[ ]`
**Зачем:** Сейчас 3 закрытые сделки = недостаточно для оценки edge. Backtest за 6-12 мес даст 100-500 trades за час прогона. Без этого live trading = вера, не торговля.

**Архитектура:**
- Загрузить исторические klines на нужные TF (5m, 15m, 1h, 4h) за 6+ мес через Bybit/Binance public API
- Реконструировать "что бы видел aggregator" — для каждого 15m boundary, какие signals были в окне
  - Альтернатива: re-fetch TV alert history (если доступно) или эмулировать события из klines с indicator-replica
- Прогнать `maybeDecide()` на каждом 15m boundary с замороженным prompt'ом
- Имитировать pending-limit fills через klines (high/low сравнить с entry)
- Имитировать SL/TP hits через polling симуляцию
- Собрать distribution: win-rate, avg R, max DD, Sharpe, expectancy

**Effort:** 1-2 дня. **Critical** перед любым live.

### 6.2 ⭐⭐ Monitor LLM для pending limits — `[ ]`
**Зачем:** Сейчас pending limit живёт до TTL или fill, без переоценки. Если контекст изменился (новый CHoCH против направления) — лимит может стать неактуальным, но мы его не отменяем. Идея: каждые 15 мин cron проверяет каждый pending limit с monitor-prompt'ом «отменить лимит или оставить?».

**Effort:** ~3ч. Низкий приоритет — TTL 2ч и так отметает stale лимиты.

### 6.3 ⭐ Adaptive sizing tiers — `[ ]`
**Зачем:** После 50+ closed trades calibration script покажет реальный edge per confidence-bucket. Текущие tiers (0.40-0.50→0.5%, etc.) — на глаз. Kelly criterion даёт оптимальный sizing исходя из реальной win-rate × avg R/L ratio per bucket.

**Effort:** ~2ч после данных.

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
- ✅ **Architectural change: scheduled decisions** — webhook just stores signals, decide-cron at `1,16,31,46 * * * *` evaluates accumulated context per symbol. Eliminates race-condition with cooldown that limited decisions to weakest snapshot.
- ✅ **Removed weighted confluence** — LLM judges raw signals directly instead of arbitrary threshold math. Window expanded to per-TF retention (5m: 2h, 15m: 6h, 1H: 12h, 4H: 48h, 1D: 7d) for richer multi-hour pattern context.
- ✅ **Prompt caching** — Anthropic ephemeral cache on system prompts. ~30% input savings on batch ticks (4 symbols back-to-back) and decide+critique pairs.
- ✅ **Schema robustness** — opt() preprocesses null/empty-string/zero coercion; confidence clamped to [0,1]; numbers/strings truncate-on-overflow instead of throw. Risk gate: entry must differ from sl.
- ✅ **Pending-limit lifecycle** — limits stored as status='pending' until tpsl-monitor sees price touch entry → status='active' with trade#. Timeout 2h → status='cancelled' (not in PnL). Telegram posts: 📋 Лимит размещён (no trade#), 🟢 Лимит активирован → сделка #NNNN (trade# appears first time here), ⏱ Лимит отменён.
- ✅ **Critical correctness fixes** — getContext() race in parallel screenshots, per-cron 5-min timeouts, idempotent closePositionWithStats, monitorPosition per-position mutex, fresh DB read for MODIFY anti-widen, TPSL refreshes pos from DB.
- ✅ **Screenshot resilience** — indicator-missing detector, promo-modal killer via elementFromPoint walk-up, mask param, addInitScript CSS injection, dismissOverlays helper. Throttled chart-error alerts (1/hr) to avoid spam.
- ✅ **Continuous improvement layer** — features_json on every decision (confidence_bucket, cited_levels, cascade, funding_state, btc_alignment, prompt_version, critique_downgrade, entry_type, llm_invoked); calibration analysis script.
- ✅ **Health watchdog** — `*/10 * * * *` cron checks decide/monitor/tpsl tick freshness + RAM. Alert to Logs (1/hr per issue) if any cron stale > 30 min or RSS > 1 GB.
- ✅ **Daily wrap redesign** — removed HODL baseline (user feedback), focus on actual closed trades: win-rate, Σ R, Avg R/trade, $1000-per-position USD PnL, breakdown by entry_type, pending/cancelled limit sections, broken-data zombie excluded.
- ✅ **Audit fixes 2026-05-12** — `findActiveOrPendingPosition()` blocks new OPEN while pending limit waits on same symbol (prevented potential double-exposure bug). Removed dead `shouldInvokeLlm` alias and `findActiveOnSide` (no callers). Server shutdown now closes Playwright browser + sets 5-sec hard timeout.

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
