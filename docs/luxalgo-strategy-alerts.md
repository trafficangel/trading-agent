# LuxAlgo AI Strategy Builder — Webhook Alert Setup (Track C)

Шпаргалка для настройки алертов в **LuxAlgo AI Strategy Builder**
(`luxalgo.com/chat/...`). Этот документ — обязательное чтение **перед**
выдачей пользователю инструкций по настройке alert payload, иначе
повторится бага «Invalid» payload (см. ниже).

> ⚠ **Это НЕ TradingView Pine Script алерты.** Track B (signal-trader)
> использует TradingView-native алерты с синтаксисом `{{...}}` — см.
> `tradingview-alerts.md`. Track C (strategy-trader) использует LuxAlgo
> AI Builder алерты с **другим синтаксисом**.

---

## 🚨 Главное отличие от TradingView

LuxAlgo AI Builder использует **двойные квадратные скобки** `[[...]]`
для плейсхолдеров, а **не** `{{...}}` как в TradingView Pine Script.
Если в шаблоне написать `{{ticker}}` — LuxAlgo не распознает это как
плейсхолдер и payload окажется невалидным JSON.

| TradingView (Track B) | LuxAlgo AI Builder (Track C) |
|---|---|
| `{{ticker}}` | `[[ticker]]` |
| `{{interval}}` | `[[timeframe]]` ← разное имя! |
| `{{close}}` | `[[strategy_order_price]]` ← разное имя! |
| `{{time}}` | `[[time]]` |
| (нет) | `[[strategy_event]]` ← ключевой |
| (нет) | `[[strategy_id]]`, `[[strategy_name]]`, `[[strategy_market_position]]` |

---

## 📋 Полный список плейсхолдеров LuxAlgo

(Из dropdown «Insert placeholder» в алерт-конфигурации, May 2026.)

| Placeholder | Что возвращает |
|---|---|
| `[[currency]]` | Quote currency (USDT) |
| `[[current_contract_myy]]` | Контракт expiry (futures) |
| `[[current_contract_myyyy]]` | Контракт expiry full year |
| `[[exchange]]` | Биржа (BYBIT, BINANCE…) |
| `[[strategy_event]]` | **`long` / `short` / `exit long` / `exit short`** |
| `[[strategy_id]]` | Внутренний strategy id из LuxAlgo (НЕ наш `strategy_id`!) |
| `[[strategy_market_position]]` | `long` / `short` / `flat` |
| `[[strategy_name]]` | Название стратегии |
| `[[strategy_order_action]]` | `buy` / `sell` |
| `[[strategy_order_price]]` | Цена ордера (число) |
| `[[ticker]]` | Символ (`XRPUSDT` или `BYBIT:XRPUSDT.P`) |
| `[[time]]` | Bar time |
| `[[timeframe]]` | Таймфрейм (`15`, `60`, …) |

⚠ `[[strategy_id]]` плейсхолдер от LuxAlgo — **НЕ совпадает** с нашим
полем `strategy_id` в track-c-config.ts. В payload надо хардкодить
наш id (например `"strategy_id": "xrp-cntr-tc-mf50"`), не использовать
LuxAlgo-плейсхолдер.

---

## ✅ Канонический payload

Для **любой** Track C стратегии:

```json
{
  "kind": "strategy",
  "strategy_id": "<наш id из STRATEGY_CONFIGS>",
  "strategy_event": "[[strategy_event]]",
  "symbol": "[[ticker]]",
  "timeframe": "[[timeframe]]",
  "price": "[[strategy_order_price]]",
  "bar_time": "[[time]]"
}
```

Один webhook на 4 события — **Long, Short, Exit Long, Exit Short** —
все 4 чекбокса включены. Сервер сам разберётся по `strategy_event`:
- `long` → entry long (открыть позицию)
- `short` → entry short
- `exit long` → закрыть LONG позицию (force_close_reason='strategy_exit')
- `exit short` → закрыть SHORT позицию

См. `src/webhooks/luxalgo.schema.ts:deriveActionSide` для деталей.

---

## 🪤 Подводные камни (lessons learned)

### 1. «Invalid» payload в редакторе

Если LuxAlgo показывает `● Invalid` рядом с Payload (JSON) — это
почти всегда `{{...}}` вместо `[[...]]`. Редактор LuxAlgo
парсит payload как JSON и видит `{{ticker}}` как невалидный токен.

**Fix:** замени все `{{...}}` на `[[...]]` с правильными именами
(см. таблицу выше).

### 2. `[[strategy_event]]` возвращает значения с ПРОБЕЛОМ

Не `exit_long` (с underscore), а `exit long` (с пробелом) — типа
"exit long". Наша Zod-схема `StrategyEvent` в `luxalgo.schema.ts`
предусмотрительно делает `preprocess` который заменяет любые
whitespace на underscore — поэтому оба формата работают.

Эту багу обнаружили на STRAT-001 после первого live-сигнала: entry
прошёл, exit отвергнут, позиция закрыта внутренним 24h time-guard'ом
вместо стратегического exit. Дорогая бага — мы должны были поймать
её до запуска.

### 3. Один webhook на 4 события vs четыре отдельных алерта

LuxAlgo позволяет включить 4 чекбокса (Long/Short/Exit Long/Exit
Short) в одном webhook — это правильный режим. Каждое событие
шлёт **тот же** payload, разница только в значении `[[strategy_event]]`.

Альтернатива — 4 отдельных алерта — работает тоже, но требует 4
копии payload'а и 4 чекбокса вручную включать. Не делай так если нет
особой причины (например — разный `notification` channel для entry vs
exit).

### 4. EXIT=null стратегии — `exitOnReverseSignal: true`

Если у стратегии в LuxAlgo нет встроенного exit условия (EXIT=null,
позиция закрывается только по reverse signal) — поставь в
StrategyConfig:

```ts
exitOnReverseSignal: true
```

Без этого флага, когда LuxAlgo шлёт SHORT entry при открытой LONG
позиции, наш handler отвергнет его как `already_open` и LONG зависнет
до safety SL.

С флагом — handler сначала закроет LONG (force_close_reason='reverse_signal',
🔁 эмодзи в TG), потом откроет SHORT. См. STRAT-002 как пример.

### 5. Имя webhook URL secret

Webhook URL: `https://robotclaude.biz/webhook/luxalgo/<WEBHOOK_SECRET>` —
тот же endpoint что и Track B (legacy events). Discriminated union в
схеме (`kind: 'strategy'` vs `kind: 'event'`) разделяет потоки на
сервере.

---

## 📦 Workflow: добавление новой Track C стратегии

1. Пользователь настраивает стратегию в LuxAlgo AI Builder + получает
   её chat URL.
2. Я запускаю `pnpm tsx scripts/import-strategy.ts <url> --code 00X --slug <id>`
   — он скрапит бектест и пишет `src/strategies/data/<id>.json` + предлагает
   StrategyConfig блок.
3. Я ревьюю стэты, выбираю slPct, добавляю запись в `STRATEGY_CONFIGS`,
   git commit + push + deploy.
4. Пользователь создаёт ONE webhook алерт в LuxAlgo с payload выше
   (хардкодит `strategy_id` под нашу запись), включает все 4 события.
5. Готово — следующий сигнал прилетит в @luxalgosignal с пометкой
   `STRAT-00X`.
