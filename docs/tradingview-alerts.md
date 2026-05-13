# TradingView Alerts — Полный Setup Guide (Track B)

Конфигурация всех алертов для signal-trader. Этот документ — твоя
шпаргалка при настройке в TradingView.

## ⚙ Общие настройки для КАЖДОГО алерта

При создании алерта в TradingView (правый клик на индикатор → Add alert) укажи:

| Поле | Значение |
|------|----------|
| **Condition** | См. таблицу ниже для каждого алерта |
| **Trigger** | **`Once Per Bar Close`** ⭐ (критически важно — не repaint) |
| **Expiration** | `Open-ended alert` (бессрочный) |
| **Alert name** | (любое, для удобства) |
| **Webhook URL** | `https://<твой_домен>/webhook/luxalgo/<WEBHOOK_SECRET>` |
| **Message** | JSON payload — см. ниже |

### ❌ НЕ используй

- ❌ `Once Per Bar` — fires при первом появлении сигнала в баре, может repaint
- ❌ `Only Once` — сработает один раз и алерт выключится
- ❌ `Every time` — спам, repaint

---

## 📋 Базовые алерты (24 шт.) — обязательно

Все на символе **BYBIT:TONUSDT.P** (Bybit USDT perpetual).

### S&O — Bullish+ / Bearish+ (8 алертов: 4 TF × 2 стороны)

| # | TF | Indicator condition | Event в JSON |
|---|------|--------------------|--------------|
| 1 | 5m | `Signals & Overlays` → `Bullish+` | `bullish_plus` |
| 2 | 5m | `Signals & Overlays` → `Bearish+` | `bearish_plus` |
| 3 | 15m | `Signals & Overlays` → `Bullish+` | `bullish_plus` |
| 4 | 15m | `Signals & Overlays` → `Bearish+` | `bearish_plus` |
| 5 | 1H | `Signals & Overlays` → `Bullish+` | `bullish_plus` |
| 6 | 1H | `Signals & Overlays` → `Bearish+` | `bearish_plus` |
| 7 | 4H | `Signals & Overlays` → `Bullish+` | `bullish_plus` |
| 8 | 4H | `Signals & Overlays` → `Bearish+` | `bearish_plus` |

**Message JSON для всех Bullish+:**
```json
{"symbol":"{{ticker}}","timeframe":"{{interval}}","source":"signals_overlays","event":"bullish_plus","direction":"up","price":{{close}},"bar_time":{{time}}}
```

**Message JSON для всех Bearish+:**
```json
{"symbol":"{{ticker}}","timeframe":"{{interval}}","source":"signals_overlays","event":"bearish_plus","direction":"down","price":{{close}},"bar_time":{{time}}}
```

### PAC — CHoCH+ Up / Down (6 алертов: 3 TF × 2 стороны)

| # | TF | Indicator condition | Event |
|---|------|--------------------|---------|
| 9 | 15m | `Price Action Concepts` → `CHoCH+` (Bullish) | `choch_swing_plus_up` |
| 10 | 15m | `Price Action Concepts` → `CHoCH+` (Bearish) | `choch_swing_plus_down` |
| 11 | 1H | same → Bullish CHoCH+ | `choch_swing_plus_up` |
| 12 | 1H | same → Bearish CHoCH+ | `choch_swing_plus_down` |
| 13 | 4H | same → Bullish CHoCH+ | `choch_swing_plus_up` |
| 14 | 4H | same → Bearish CHoCH+ | `choch_swing_plus_down` |

**Message JSON CHoCH+ Up:**
```json
{"symbol":"{{ticker}}","timeframe":"{{interval}}","source":"pac","event":"choch_swing_plus_up","direction":"up","price":{{close}},"bar_time":{{time}}}
```

**Message JSON CHoCH+ Down:**
```json
{"symbol":"{{ticker}}","timeframe":"{{interval}}","source":"pac","event":"choch_swing_plus_down","direction":"down","price":{{close}},"bar_time":{{time}}}
```

### PAC — BOS Up / Down (6 алертов: 3 TF × 2 стороны)

| # | TF | Indicator condition | Event |
|---|------|--------------------|---------|
| 15 | 15m | `Price Action Concepts` → `Bullish BOS` | `bos_swing_up` |
| 16 | 15m | `Price Action Concepts` → `Bearish BOS` | `bos_swing_down` |
| 17 | 1H | same → Bullish BOS | `bos_swing_up` |
| 18 | 1H | same → Bearish BOS | `bos_swing_down` |
| 19 | 4H | same → Bullish BOS | `bos_swing_up` |
| 20 | 4H | same → Bearish BOS | `bos_swing_down` |

**Message JSON BOS Up:**
```json
{"symbol":"{{ticker}}","timeframe":"{{interval}}","source":"pac","event":"bos_swing_up","direction":"up","price":{{close}},"bar_time":{{time}}}
```

**Message JSON BOS Down:**
```json
{"symbol":"{{ticker}}","timeframe":"{{interval}}","source":"pac","event":"bos_swing_down","direction":"down","price":{{close}},"bar_time":{{time}}}
```

### S&O — Reversal Signals (4 алерта: 2 TF × 2 стороны)

| # | TF | Indicator condition | Event |
|---|------|--------------------|---------|
| 21 | 15m | `Signals & Overlays` → `Reversal Signal` (Bullish) | `reversal_signal_up` |
| 22 | 15m | `Signals & Overlays` → `Reversal Signal` (Bearish) | `reversal_signal_down` |
| 23 | 1H | same → Bullish | `reversal_signal_up` |
| 24 | 1H | same → Bearish | `reversal_signal_down` |

**Message JSON Reversal Up:**
```json
{"symbol":"{{ticker}}","timeframe":"{{interval}}","source":"signals_overlays","event":"reversal_signal_up","direction":"up","price":{{close}},"bar_time":{{time}}}
```

**Message JSON Reversal Down:**
```json
{"symbol":"{{ticker}}","timeframe":"{{interval}}","source":"signals_overlays","event":"reversal_signal_down","direction":"down","price":{{close}},"bar_time":{{time}}}
```

---

## ❌ Эти алерты УДАЛИ в TradingView (если есть)

Не используются signal-trader'ом — просто пишутся в БД и засоряют логи:

- `OB Bullish Created` / `OB Bearish Created` — уведомления о появлении уровня, не entry-сигналы
- `MF Extreme Up` / `MF Extreme Down` — oscillator extremes (могут быть как confluence — см. опциональные)
- `Divergence Bullish` / `Divergence Bearish` — тоже confluence, не entry

---

## 🟡 Опциональные алерты (confluence boosters)

Эти можно настроить позже если захочешь усиливать фильтрацию. Сейчас не используются signal-trader'ом, но я могу добавить confluence-логику когда покажет смысл по данным.

### OM — Oscillator Matrix (8 опциональных алертов)

| Indicator | TF | Event |
|-----------|------|----------|
| `Oscillator Matrix` → `Money Flow Extreme Up` | 15m | `mf_extreme_up` |
| `Oscillator Matrix` → `Money Flow Extreme Down` | 15m | `mf_extreme_down` |
| `Oscillator Matrix` → `Divergence Bullish` | 15m | `divergence_bullish` |
| `Oscillator Matrix` → `Divergence Bearish` | 15m | `divergence_bearish` |
| (same) | 1H | mirror |

**Message JSON MF Extreme Up:**
```json
{"symbol":"{{ticker}}","timeframe":"{{interval}}","source":"oscillator_matrix","event":"mf_extreme_up","direction":"up","price":{{close}},"bar_time":{{time}}}
```

(Аналогично для `mf_extreme_down`, `divergence_bullish`, `divergence_bearish` — меняй только `event` и `direction`.)

---

## ✅ Итоговая таблица

| Группа | Алертов | Используется Track B | Приоритет |
|--------|---------|----------------------|-----------|
| **Bullish+/Bearish+** (S&O) | 8 (5m/15m/1H/4H × 2) | ✅ ДА | 🔴 высокий |
| **CHoCH+** (PAC) | 6 (15m/1H/4H × 2) | ✅ ДА | 🔴 высокий |
| **BOS** (PAC) | 6 (15m/1H/4H × 2) | ✅ ДА | 🟡 средний |
| **Reversal Signal** (S&O) | 4 (15m/1H × 2) | ✅ ДА | 🟡 средний |
| **MF Extreme** (OM) | 4 | ⏸ Пока нет | 🟢 опционально |
| **Divergence** (OM) | 4 | ⏸ Пока нет | 🟢 опционально |

**ИТОГО:** 24 базовых + 8 опциональных = до **32 алертов** на TON.

---

## 🔍 Как проверить что алерты приходят

После настройки каждого алерта — подожди ближайший close 5m свечи (≤5 мин) и проверь:

### 1. Telegram Logs канал
Должно прийти raw-сообщение с эмодзи source и direction.

### 2. БД на VPS
```bash
ssh trading-vps "su - trader -c 'sqlite3 /home/trader/apps/trading-agent/data/trading.sqlite \"SELECT datetime(received_at/1000,\\\"unixepoch\\\") as t, timeframe, event FROM signals WHERE received_at > strftime(\\\"%s\\\",\\\"now\\\",\\\"-30 minutes\\\")*1000 ORDER BY received_at DESC\"'"
```

### 3. journalctl
```bash
ssh trading-vps "sudo journalctl -u trading-agent --since '10 minutes ago' --no-pager | grep 'signal stored'"
```

### 4. TradingView Alert Log
Открой в TradingView: `Alerts` (правая панель) → `Alert Log` — там HTTP-код ответа. `200` = ОК, любая ошибка = что-то не так.

---

## ⚠ Важные ньюансы

### 1. Repaint vs Once Per Bar Close
LuxAlgo сигналы могут repaint'ить **во время** формирования бара. Только закрытие бара даёт окончательный сигнал. `Once Per Bar Close` гарантирует стабильный сигнал.

### 2. Timezone — UTC
TradingView отправляет `{{time}}` как UNIX millisecond UTC. Webhook'ы интерпретируют правильно.

### 3. Дедупликация
Каждый сигнал имеет хеш `(symbol|event|bar_time)`. Если один и тот же сигнал прилетит дважды (например, перенастройка алерта) — второй будет проигнорирован.

### 4. Какой Symbol указывать
В TradingView ticker: **`BYBIT:TONUSDT.P`** (с `.P` для perpetual). Webhook `{{ticker}}` извлечёт `TONUSDT.P`, наш код нормализует к `TONUSDT`.

### 5. Несколько символов
Если в будущем добавишь BTCUSDT/ETHUSDT/etc — каждый символ нужно настроить отдельно (TradingView один алерт = один тикер). 24 алерта × N символов.

### 6. Закрытие бара ≠ момент алерта
TradingView отправляет webhook через **0-5 секунд** после закрытия бара. Из-за этого:
- 5m бар закрылся в 14:25:00 UTC → webhook прилетит в 14:25:01-05
- Цена в `{{close}}` = цена закрытия бара (точная, не текущая)
- В `bar_time` = timestamp начала бара (для 14:25 закрытия = 14:20:00 UTC = timestamp 14:20)

---

## 📐 Какая логика signal-trader применяет к каждому сигналу

При получении webhook на 14:25:03 UTC с `event=bullish_plus`, `tf=15m`:

1. **Event qualifies?** `bullish_plus` ∈ `ENTRY_EVENTS_LONG` ✅
2. **TF в TRADEABLE_TIMEFRAMES?** `15m` ✅
3. **Confluence нужна?** Для 5m — да (15m в last 60 min). Для 15m+ — нет.
4. **Cooldown?** Per-TF:
   - 5m: 30 мин с последнего Track B OPEN на TON
   - 15m: 30 мин
   - 1H: 2 часа
   - 4H: 6 часов
   - 1D: 24 часа
5. **Slot?** Нет другой active+pending Track B позиции на TON
6. **Геометрия** (по ATR(14) на 15m, кэш 60 сек):
   - SL = entry − 1.5×ATR (long) / + 1.5×ATR (short)
   - TP = entry + 3×ATR / − 3×ATR (R:R 1:2)
   - Fallback (ATR API down): SL=1%, TP=2%
7. **Открытие**: market order, size 0.5%, status='active'
8. **Telegram**: пост `📡 [TRACK B · SIGNAL] S#NNNN` в Signals
