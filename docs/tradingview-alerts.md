# TradingView alerts → trading-agent

Каждый алерт LuxAlgo шлёт `POST` на `https://<твой-домен>/webhook/luxalgo/<WEBHOOK_SECRET>` с JSON-телом ниже. Все алерты — **Once Per Bar Close**.

## Webhook URL и заголовок

- URL: `https://<домен>/webhook/luxalgo/<WEBHOOK_SECRET>` (значение `WEBHOOK_SECRET` — из `.env`)
- Headers: TradingView не позволяет кастомные заголовки. Авторизация — через секрет в URL.
- Method: POST с `Content-Type: application/json`.

## Поля JSON

| поле | тип | пример | описание |
|------|-----|--------|----------|
| `symbol` | string | `"BTCUSDT"` | биржевой тикер (Bybit perp) |
| `timeframe` | string | `"5"` / `"15"` | минуты, как TradingView отдаёт `{{interval}}` |
| `source` | enum | `"signals_overlays"` / `"pac"` / `"oscillator_matrix"` | какой LuxAlgo индикатор |
| `event` | string | `"bullish_plus"` | конкретное событие, см. ниже |
| `direction` | enum | `"up"` / `"down"` / `"neutral"` | опционально |
| `price` | number | `67234.5` | цена в момент бара |
| `bar_time` | number | `1714867200000` | unix ms закрытия бара (TradingView `{{timenow}}` или `{{time}}`) |

## Список алертов

Создавай по одному алерту на каждое событие × каждый символ × таймфрейм 5m и 15m.

### Signals & Overlays
| event (значение) | когда срабатывает |
|------------------|--------------------|
| `bullish_plus` | сигнал Bullish+ |
| `bearish_plus` | сигнал Bearish+ |
| `smart_trail_flip_up` | Smart Trail сменил цвет на бычий |
| `smart_trail_flip_down` | Smart Trail сменил цвет на медвежий |
| `tp1_hit` / `tp2_hit` / `tp3_hit` | пробитие TP-зон |

### Price Action Concepts
| event | описание |
|-------|----------|
| `bos_up` / `bos_down` | подтверждённый Break Of Structure |
| `choch_up` / `choch_down` | Change Of Character |
| `ob_bullish_formed` / `ob_bearish_formed` | формирование Order Block |
| `fvg_up` / `fvg_down` | новый Fair Value Gap |

### Oscillator Matrix
| event | описание |
|-------|----------|
| `mf_extreme_up` / `mf_extreme_down` | Money Flow в зоне экстремума |
| `reversal_signal_up` / `reversal_signal_down` | сигнал разворота |
| `divergence_bullish` / `divergence_bearish` | дивергенция |

## Шаблон сообщения (Message в окне Create Alert)

Замени `{{...}}` на нужное событие, остальное TradingView подставит сам.

```json
{
  "symbol": "{{ticker}}",
  "timeframe": "{{interval}}",
  "source": "signals_overlays",
  "event": "bullish_plus",
  "direction": "up",
  "price": {{close}},
  "bar_time": {{timenow}}
}
```

Для `pac` (Price Action Concepts) поставь `"source": "pac"` и `event` по таблице. Для Oscillator Matrix — `"source": "oscillator_matrix"`.

## Проверка алерта

После создания одного алерта запусти бота и подожди ближайший close. В Telegram-канал «Logs» должно прийти сообщение с твоим JSON в `<pre>`-блоке. Если не пришло:

1. Проверь, что URL без опечаток (TradingView показывает HTTP-код ответа в `Alert Log`).
2. Сверь поле `secret` в URL с `.env`.
3. Открой `journalctl -u trading-agent -f` на VPS — увидишь `invalid_payload` если поля не совпадают.
