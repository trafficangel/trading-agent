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
все 4 чекбокса включены. Кроме них обязательно включён отдельный
чекбокс слева от поля **URL**: без него alert остаётся `Active`, payload
показывается как `Valid`, но LuxAlgo не отправляет webhook. Сервер сам
разберётся по `strategy_event`:
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

### 4. Двойной путь закрытия (default behaviour)

Все Track C стратегии по умолчанию закрываются **WHICHEVER fires
first** — defence in depth:

| Путь | Что вызывает | force_close_reason |
|------|--------------|---------------------|
| Явный exit webhook | `[[strategy_event]] = "exit long"` / `"exit short"` | `strategy_exit` (🎯) |
| Reverse-signal flip | `[[strategy_event]] = "short"` пока открыт LONG (или наоборот) | `reverse_signal` (🔁) |
| Safety SL | Цена дошла до SL | (close_reason = `sl_hit`, 🛡) |

Поведение по умолчанию: `cfg.exitOnReverseSignal = true` (можно не
указывать). Защищает от:
- **EXIT=null стратегий** (STRAT-002 case) — exit-webhook'ов нет
  вообще, reverse-signal единственный путь exit'а кроме SL
- **Потерянных exit-вебхуков** на стратегиях с явным exit'ом
  (STRAT-001 case) — STRAT-001 однажды потеряла exit-вебхук и
  закрылась только 24h time-guard'ом, дорогая бага

Race safety:
- `forceClose()` идемпотентен — если exit-webhook закроет первым,
  пришедший после reverse-entry увидит `position already closed`
  и просто откроет новую позицию.
- `handleStrategyExit` имеет stale-side-guard — если reverse-flip
  уже произошёл и SHORT открыт, опоздавший `exit long` будет
  отвергнут как `stale_exit_side_mismatch` (не закроет SHORT).

Опт-аут — `exitOnReverseSignal: false` — нужен только если стратегия
имеет необычную семантику где reverse signal НЕ должен закрывать
позицию (почти никогда не бывает в реальных стратегиях).

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
4. **Обязательный шаг:** публикую анонс в Telegram канал командой
   `pnpm tsx scripts/announce-strategy.ts <code>` (запускать на VPS —
   локально бот не имеет доступа к каналу). Анонс берёт описание +
   бектест из STRATEGY_CONFIGS и постит в @luxalgosignal со ссылкой
   на лендинг.
5. Пользователь создаёт ONE webhook алерт в LuxAlgo с payload выше
   (хардкодит `strategy_id` под нашу запись), включает чекбокс слева
   от URL и все 4 события.
6. Перед завершением повторно открыть сохранённый alert и проверить:
   URL включён, Long/Short/Exit Long/Exit Short включены, payload
   `Valid`, alert `Active`.
7. Готово — следующий сигнал прилетит в @luxalgosignal с пометкой
   `STRAT-00X`.
