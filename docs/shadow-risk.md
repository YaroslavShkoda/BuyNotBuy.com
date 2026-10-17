# Shadow Risk Model: валюты и funding

Модель принимает одну позицию и не влияет на торговые сигналы или исполнение.
Формат отчёта остаётся `risk-report/1`; исправление funding отмечено версией
`risk-report-builder@5`, точная арифметика inverse-метрик — версиями
`risk-assumptions@6` и `position-math@4`.

| Поле | Spot / linear perpetual | Inverse perpetual |
|---|---|---|
| `qtyBase` | Количество базового актива | Число контрактов |
| `contractSizeUsd` | Не используется | USD-номинал одного контракта |
| `notionalQuote` | Входная цена × base-количество | Число контрактов × USD-размер |
| `quoteCurrency` | Валюта котировки тикера | Только USD; тикер также должен иметь USD quote |
| `entryPrice`, `currentPrice`, `exitPriceQuote` | Quote за единицу base | USD за единицу base |
| `marginCurrency` | Не определяет quote-метрики | Указывает base/quote расчётную валюту; не меняет USD-размер контракта |
| `fundingRatePerInterval` | Знаковая доля номинала за интервал | Знаковая доля USD-номинала за интервал |

Для inverse без FX-источника не поддерживаются другие quote-валюты, включая
BTC, EUR, USDT и USDC. USD не считается эквивалентом стейблкоина. Такие входы
отклоняются валидацией с указанием `quoteCurrency` до построения отчёта.
Прежние inverse-входы с не-USD quote нужно заменить данными реального
USD-контракта; переименовывать тикер или валюту без изменения исходных данных нельзя.

## Стоимость funding за один интервал

Положительное значение означает выплату, отрицательное — получение.
`sideSign = +1` для LONG и `-1` для SHORT.

```text
linear:  sideSign × fundingRate × currentPrice × qtyBase
inverse: sideSign × fundingRate × contractSizeUsd × qtyBase
```

`holdingCostPerIntervalQuote` всегда имеет единицу `quote_currency`. Для
inverse это USD. Пример: 100 контрактов × 10 USD × 0.001 = 1 USD для LONG;
для SHORT — −1 USD. Цена 45000 USD/base в эту USD-формулу не входит.

При base settlement эквивалент стоимости в базовом активе равен USD-стоимости,
делённой на текущую USD/base цену: 1 / 45000 ≈ 0.0000222222 base. Отдельная
base-метрика funding сейчас не публикуется. Quote-оценка funding не является
оценкой PnL и не требует угадывать неизвестную расчётную валюту.

Номинал берётся из подтверждённого размера контракта позиции. Если размер
неизвестен, предоставленный `notionalQuote` не считается проверенным и
funding получает `insufficient_data / MISSING_INVERSE_CONTRACT_PARAMS`, даже
при нулевой ставке. Отсутствующая ставка остаётся
`degraded / UNKNOWN_FUNDING`; spot — `not_applicable`.

Для стоимости funding и maintenance используется `finiteProduct` с одним
округлением точного произведения входных binary64. Непредставимый результат
получает `calculation_error / CALCULATION_OVERFLOW`; ошибки распространяются
в `reportStatus`. Нулевые ставки не подменяют отсутствующие данные.

Линейная формула и базовая JSON-fixture не изменены. Inverse-fixtures явно
используют USD-идентификатор из `risk/fixtures/inverse-usd.json`.
Inverse liquidation по-прежнему не реализована: правильный funding не делает
маржинальную или ликвидационную оценку достоверной.

## Точная арифметика inverse-метрик

Конечные binary64-входы трактуются как их точные двоичные значения, а не как
десятичные строки. Внутренние целые BigInt и рациональные значения не попадают
в публичный отчёт. При `sign = +1` для LONG и `−1` для SHORT:

```text
N_exact = exact(contractSizeUsd) × exact(qtyBase)
E_exact = N_exact / exact(entryPrice)
```

`N_exact` — USD-номинал inverse-контракта (`notionalQuote`), `E_exact` — его
абсолютная экспозиция в базовых единицах (`exposureBaseUnits`). Обе метрики
округляются независимо из точных значений: экспозиция не вычисляется из уже
округлённого номинала.

```text
B = sign × N_exact × (exit − entry) / (entry × exit)
Q = B × current
N_report = exact(опубликованный entryNotionalQuote)
P = 100 × Q / N_report
ROM = 100 × Q_unrealized / exact(collateralQuote)
```

Каждая публикуемая метрика округляется отдельно в binary64 по правилу
round-to-nearest, ties-to-even, включая субнормальные значения. Знаменатель P
именно опубликованный номинал: N_exact и N_report не сокращаются. Для ROM
используется точный unrealized Q с exit = current, даже если публикуемый Q
округляется до нуля или переполняется.

Точный ноль публикуется как `0 / valid`. Ненулевой результат, округляющийся до
нуля, и overflow получают `null / calculation_error / CALCULATION_OVERFLOW`.
Недоступность одной метрики не уничтожает представимые результаты других.
При quote settlement base-метрика остаётся `not_applicable`. Любая ошибка
опубликованной метрики учитывается при агрегации статусов секции и отчёта.

Обычные результаты могут отличаться последними битами от прежней цепочки
округлений. Структура `risk-report/1`, валютная оценка по current, существующие
статусы и reason codes сохранены. Linear/spot, funding, валидация входного
номинала и liquidation не изменены. Номинал и base-экспозиция inverse-контракта
больше не публикуют `valid 0` для ненулевого значения, округляющегося до нуля:
оно получает `calculation_error / CALCULATION_OVERFLOW`, как и переполнение.
