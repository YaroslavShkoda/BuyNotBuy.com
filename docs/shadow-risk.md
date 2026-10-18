# Shadow Risk Model: валюты и funding

Модель принимает одну позицию и не влияет на торговые сигналы или исполнение.
Формат отчёта остаётся `risk-report/1`; исправление funding отмечено версией
`risk-report-builder@7`, численная безопасность — версиями
`risk-assumptions@8` и `position-math@6`.

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
статусы и reason codes сохранены. На этапе точной inverse-арифметики linear/spot,
funding, валидация входного номинала и liquidation не менялись; последующая
linear-защита описана ниже. Номинал и base-экспозиция inverse-контракта
больше не публикуют `valid 0` для ненулевого значения, округляющегося до нуля:
оно получает `calculation_error / CALCULATION_OVERFLOW`, как и переполнение.

## Linear numeric safety — YAR-11

Linear и spot entry-notional используют точное произведение binary64-входов
с одним округлением nearest/ties-to-even. Обычное умножение двух binary64 уже
правильно округляет произведение, но прежняя проверка только на finite теряла
различие между точным нулём и положительным произведением, округлившимся до нуля.
Такой результат теперь получает `null / calculation_error / CALCULATION_OVERFLOW`.
Положительность qty и entry по-прежнему обязательна; внутренние вызовы с нулём
или отрицательными входами отклоняются защитными guards.

Linear schema cross-check сравнивает предоставленный `notionalQuote` с правильно
округлённым произведением `qtyBase × entryPrice`. Относительный допуск `1e-6`
сохранён; разность и порог сравниваются точно, без абсолютного floor `1e-9`.
Обычные округлённые значения и положительные subnormal принимаются.
Произведение, округляющееся в ноль или Infinity, отклоняется по `notionalQuote`:
обязательное положительное поле не может представлять такой номинал.
В частности, `qtyBase = entryPrice = 1e-200` теперь отклоняется схемой/CLI,
а не достигает builder с фиктивным положительным nominal input. Публичные поля
и их типы, inverse cross-check и spot cross-check не расширены и не изменены.
Builder по-прежнему повторно валидирует вход; гарантия отсутствия вычислительных
исключений относится к schema-valid данным.

Round-trip cost вычисляет точную ставку `2 × (taker + slippage + reserve) + spread`
и независимо округляет `entryNotional × rate` и `100 × rate`. Это та же формула,
но subnormal spread больше не теряется при делении пополам. Настоящие нулевые
ставки дают valid zero; ненулевой непредставимый cost даёт calculation_error,
при этом представимый percent остаётся доступен. Общий helper обеспечивает это
для всех инструментов; исправлена и прежняя false-zero стоимость при минимальном
inverse-номинале. На этапе YAR-11 funding, PnL и ROM формулы не менялись;
последующая точная арифметика PnL/ROM описана в Stage 2.3.2 ниже.

Существующая `linear_isolated_v1` вычисляется точно, без новой модели ликвидации:
LONG `(entry × qty − collateral) / (qty × (1 − mmr))`, SHORT
`(entry × qty + collateral) / (qty × (1 + mmr))`.
Решение `LIQUIDATION_NOT_REACHABLE` для LONG следует из точного сравнения
произведения с collateral. Gross loss округляется от точной цены, сохраняя
прежнее ограничение снизу нулём. Если положительная цена или положительный loss
не представимы после округления, оценка получает calculation_error; расстояния
и report status наследуют ошибку. Venue-specific правила, cross и inverse
liquidation остаются вне реализованной модели.

## Remaining numeric safety — Stage 2.3.2

Версии: `risk-report-builder@7`, `position-math@6`, `risk-assumptions@8`;
публичная структура остаётся `risk-report/1`.

Linear/spot PnL вычисляется точно как `sideSign × (exit − entry) × qty`.
Quote и percent округляются независимо, nearest/ties-to-even. Знаменатель
percent — опубликованный entry-notional, как и прежде. Ошибка округления
quote не скрывает представимый percent; настоящий ноль остаётся valid zero,
ненулевой результат, округляющийся до нуля, получает `CALCULATION_OVERFLOW`.

Linear ROM вычисляется из точного PnL как `100 × PnL / collateralQuote`,
без промежуточного округления PnL или отношения. Он может оставаться valid,
даже когда отдельный quote PnL непредставим. Spot по-прежнему не имеет ROM;
inverse использует прежнюю точную формулу и прежние gates.

В существующей linear isolated проверке equity равно точному collateral
плюс точный unrealized PnL, maintenance — точному `mmr × current × qty`.
Строгое сравнение `equity < maintenance` выполняется до округления; точное
равенство не считается нарушением. Опубликованные суммы округляются независимо
и могут совпадать при обнаруженном нарушении. Прежний error gate сохранён:
если equity или maintenance непредставимы, секция имеет `calculation_error`,
`detected = null`. Ошибка округления одного PnL сама по себе не блокирует
представимые equity, ROM или percent.

Funding, schema, liquidation price, cross/inverse ограничения и Stage 3
не расширены. Изменения последних битов обычных результатов ожидаемы из-за
одного финального округления вместо цепочки округлений.
