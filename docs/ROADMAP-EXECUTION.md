# План выполнения роадмапа

Источник: `Роадмап.md` (два списка по 50 пунктов, сильно пересекаются).
Ниже — **единый сведённый план**: дубликаты двух списков объединены,
каждому пункту сопоставлен его номер в обоих списках.

Легенда: **A#** — «функциональный roadmap 1–50» (фазы I–IX),
**B#** — «большой план развития backend» (Phase 1–7).

**Статус:** `[ ]` не начато · `[~]` в работе · `[x]` сделано

---

## Уже сделано до этого прохода

- A1 / B1 — полный backend architecture audit.
- B3 — сущность `Signal Snapshot` (`signal_snapshot`, `strategy_version`).
- B6 — версионирование стратегии (`config/strategy-fingerprint.ts`).
- A6 (частично) — circuit breaker + `failover.circuit.test.ts`.
- A10 / B41 / B42 (частично) — валидация свечей, gap, stale.
- B34 — идемпотентность snapshot по `input_hash`.
- B36 (частично) — single-flight в `market.service.ts`.
- B32 (частично) — retention `signal_history` по символу.
- A5 (частично) — `ApplicationError` / `MarketDataError` / коды ошибок.

---

## БЛОК 1 — Модель свежести + контракт market data
`A2` строгая модель freshness · `A9` единый market-data contract · `B40` quality metadata (каркас)

- [x] 1.1 Единый тип `MarketFreshness` (fresh / stale / expired / unavailable / provider_failed / partial)
- [x] 1.2 `MarketData` получает `provider`, `symbol`, `timestamp` (аддитивно, фронтенд не ломается)
- [x] 1.3 `MarketDataResult` возвращает `freshness` вместо/вместе с `stale`
- [x] 1.4 Все места трактуют timestamp/возраст/cacheTtl/maxStale одинаково
- [x] 1.5 Тесты
- [x] 1.6 `/metrics` и `/readyz` показывают площадки и состояние (readiness не «мигает» от провайдера)

## БЛОК 2 — Иерархия ошибок transport vs market-data
`A5`

- [x] 2.1 `ProviderError` с machine-readable полями: code, provider, endpoint, httpStatus, retryAfter, timestamp, requestId
- [x] 2.2 Подклассы: ProviderUnavailable / ProviderTimeout / ProviderRateLimited / ProviderInvalidResponse / InsufficientHistory / ProviderCircuitOpen
  - Реализовано одним классом `ProviderError` с дискриминантом `kind`, а не шестью классами.
  - Причина: шесть почти идентичных классов дают шесть мест, где можно забыть поле,
    и `instanceof`-цепочки, которые нигде не нужны. Набор `kind` — исчерпывающий union,
    поэтому исчерпывающий `switch` компилятор проверяет сам, а `new ProviderError('typo')`
    не компилируется. Публичные `code`/`statusCode` сохранены один в один.
- [x] 2.3 Никакого разбора текста ошибки в вызывающем коде
  - `src/backend/errors/provider-error-contract.test.ts` сканирует весь `src/backend`
    и падает на `.message.includes/match/startsWith/...` и на сравнении строковых
    `MARKET_*`-кодов вне `errors/` и `api/`. Правило сделано исполняемым, а не
    записанным в документ.
- [x] 2.4 Тесты на маппинг HTTP-статусов и таймаутов
  - Таблица `HTTP → kind` проверяется целиком: 400/401/404 → `invalid_response`,
    418/429 → `rate_limited`, 500/502/503 → `unavailable`; таймаут отделён от
    оборванного соединения по типу `DOMException`, не по тексту.
  - Статусы, которые видит клиент, не изменились: 5xx → 503, прочие не-2xx → 502,
    таймаут → 504. Это внутренний рефакторинг описания отказа, а не смена
    опубликованного контракта.

**Побочный баг, найденный при 2.3.** Комментарий в транспорте обещал, что отмена
вызывающей стороны не считается отказом площадки, — но проверка стояла *после* записи в
breaker и в health. Shutdown прерывает все in-flight запросы разом, то есть раскатка
деплоя сама порождала ровно те последовательные отказы, которые открывают автомат, и
первый запрос после рестарта отказывался circuit'ом, который процесс открыл против
площадок, которым никогда не было плохо. Проверка перенесена выше записей; запрос при
этом по-прежнему засчитывается в метрики (сокет был занят, время потрачено).

## БЛОК 3 — Модель здоровья provider + телеметрия задержек
`A7` health model · `A8` latency telemetry · `B38` health registry · `B39` provider scoring

- [x] 3.1 `ProviderHealthRegistry`: lastSuccess, lastFailure, consecutiveFailures, lastLatency, lastStatus, circuit, retryAfter
- [x] 3.2 Состояния: healthy / degraded / rate_limited / unavailable / circuit_open / recovering
- [x] 3.3 Телеметрия: count, avg, p50, p95, p99, error rate, per provider/endpoint/status
- [x] 3.4 Проброс в `/metrics`
- [x] 3.5 Тесты

## БЛОК 4 — Circuit breaker: аудит и конкурентные сценарии
`A6`

- [x] 4.1 Проверка: cooldown + 100 одновременных запросов → ровно один probe
  - `circuit-breaker.concurrency.test.ts`: 100 одновременных вызовов после cooldown
    дают ровно один допущенный запрос (`1 + maxRetries` сокетов — его собственный
    бюджет ретраев), остальные 99 получают типизированный `circuit_open` и не
    открывают ни одного сокета.
- [x] 4.2 Изоляция по provider
  - Открытый автомат `binance` не влияет на `bitget`: состояния проверяются
    независимо, запрос к второй площадке проходит.
- [x] 4.3 Ручной reset
  - `resetProviderTransport(venue)` чинит и автомат, и health, и телеметрию.
    Обнуление телеметрии добавлено сюда же: счётчики только растут, и сброс двух
    из трёх оставлял сьют, который проходит или падает по порядку тестов.
- [x] 4.4 Тесты на гонки
  - Резерв probe на запрос (не на попытку), возврат резерва на любом выходе,
    потеря резерва при отмене вызывающей стороны, rate limit на самом probe.

**Три дефекта, найденных тестами 4.4.**

1. **Резерв probe жил одну попытку, а не один запрос.** `recordFailure()` снимал
   флаг на каждой неудачной попытке, поэтому пока запрос отдыхал в backoff, флаг
   был уже снят и следующий вызывающий в пачке проходил. 100 одновременных
   запросов давали 1 вход на каждый gap backoff — ровно то стадо, ради которого
   автомат и существует, причём пришедшее к площадке, которая только что отказала.
   Разделены `recordAttemptFailure()` (счётчик, запрос ещё идёт) и `releaseProbe()`
   (запрос закончился); резерв держит транспорт и возвращает в `finally`.
2. **Отменённый запрос навсегда оставлял площадку немой.** Резерв probe снимался
   только в `recordSuccess`/`recordFailure`/`openFor`. Если probe отменён на
   стороне вызывающего — shutdown раскатывает все in-flight разом — ни один из них
   не наступает, состояние навсегда остаётся `probing` с занятым флагом, и
   площадка не опрашивается до конца процесса. Резерв возвращается на любом выходе.
3. **Отказ по собственному решению автомата считался отказом площадки.** Поле
   `definitive` было объявлено в `ProviderFailureReport` и никогда не читалось,
   поэтому каждый запрос, отклонённый открытым автоматом, увеличивал
   `consecutiveFailures`. За время реальной аварии это все запросы, которые
   приложение обслуживает; к моменту, когда окно истекает и probe наконец
   успевает, в записи уже история отказов, и единственный успех её не снимет.
   Теперь используется `isSelfInflicted` — одно место, отвечающее на вопрос
   «является ли это свидетельством против площадки».

## БЛОК 5 — Failover production-grade
`A4`

- [x] 5.1 Fallback никогда не silent substitution: в ответе видно, кто дал данные
  - Проверено по коду, а не по памяти: площадка едет из цикла failover'а
    (`runAttributed`), попадает в `MarketData.provider`, в тело `/api/analysis` и
    `/api/market`, в заголовок `X-Data-Provider` и в диагностическую запись.
    Отдельно: `switched` отвечает на вопрос «была ли подмена», а `activeVenue` —
    на «кто сейчас отвечает»; ранее это были два ответа на один вопрос.
- [x] 5.2 Семантика ошибок по провайдерам
  - Агрегат цепочки стал `ProviderError` с типизированным `kind` и `details.attempted`,
    где по каждой площадке лежат `kind`, `code`, `httpStatus` и человекочитаемый
    `reason`. «Все площадки под троттлингом» и «все площадки недоступны» больше не
    приходят одним и тем же 503: первое — `rate_limited`/503 (виноват наш темп
    запросов), второе — `unavailable`/502 (виновата сеть или деплой). 504 выдаётся
    только когда *все* площадки ответили таймаутом; таймаут на одной и отказ на
    другой — это не шлюзовой таймаут, ждать нечего.
  - Неклассифицированная ошибка даёт `kind: null`, а не догадку: `unknown` не
    должен выглядеть как «мы знаем, что было медленно».
- [x] 5.3 Тесты
  - `failover.attribution.test.ts` (атрибуция и подмена), `failover.errors.test.ts`
    (семантика агрегата), `failover.circuit.test.ts` (отказ при открытом автомате).
  - Фикстуры переведены на `ProviderError`: фикстура старой формы держала бы
    старую форму рабочей случайно и ничего не проверяла бы про новую.

## БЛОК 6 — Хранилище свечей: таблица, upsert, repository
`A12` · `A13` · `A14`

- [ ] 6.1 Миграция `market_candles` с UNIQUE (provider, symbol, interval, timestamp)
- [ ] 6.2 `CandleRepository`: getLatest / getRange / getBefore / getAfter / upsert / bulkUpsert / count
- [ ] 6.3 Providers не ходят в PostgreSQL
- [ ] 6.4 Тесты

## БЛОК 7 — Исторический backfill
`A11` · `B43`

- [ ] 7.1 Пагинация с учётом лимитов площадки
- [ ] 7.2 Resume после прерывания, прогресс, дедупликация, валидация
- [ ] 7.3 Тесты

## БЛОК 8 — Планировщик ингестии + closed/forming свеча
`A15` · `A16`

- [ ] 8.1 Scheduler с периодом от таймфрейма (проверка после закрытия свечи)
- [ ] 8.2 Разделение closed / forming на уровне domain-модели
- [ ] 8.3 Backtest не может увидеть forming-свечу
- [ ] 8.4 Тесты

## БЛОК 9 — Data quality score
`A17` · `B40`

- [ ] 9.1 quality = 0..1: свежесть, количество, gaps, provider, ошибки валидации, fallback
- [ ] 9.2 Решение «можно ли строить сигнал»
- [ ] 9.3 Тесты

## БЛОК 10 — Стандартизация Indicator Engine + registry + снятие ema300
`A18` · `A19` · `A20`

- [ ] 10.1 `IndicatorDefinition` / `IndicatorResult` / `IndicatorContext`
- [ ] 10.2 Registry: register / get / list / calculate
- [ ] 10.3 Внутренняя модель `ema` вместо `ema300`, совместимость API сохранена
- [ ] 10.4 Новый индикатор = один файл
- [ ] 10.5 Тесты

## БЛОК 11 — Новые индикаторы: Bollinger Bands, ADX
`A21` · `A22`

- [ ] 11.1 Bollinger: middle / upper / lower / bandwidth / %B — context only, вне consensus
- [ ] 11.2 ADX: +DI / -DI / ADX — сила тренда, не направление
- [ ] 11.3 Consensus не изменён
- [ ] 11.4 Тесты

## БЛОК 12 — Volatility regime + regime detection engine
`A23` · `A24` · `B18` · `B20`

- [ ] 12.1 LOW / NORMAL / HIGH / EXTREME по ATR + BB
- [ ] 12.2 TREND_UP / TREND_DOWN / RANGE / HIGH_VOL / LOW_VOL
- [ ] 12.3 Пороги конфигурируемы (Zod)
- [ ] 12.4 Тесты

## БЛОК 13 — Indicator dependency graph
`A25`

- [ ] 13.1 Граф зависимостей, дедупликация пересчёта серий
- [ ] 13.2 Тесты

## БЛОК 14 — Consensus как конфигурируемый движок
`A26`

- [ ] 14.1 min agreeing indicators, min conviction, weight model, confidence model
- [ ] 14.2 Defaults не изменились
- [ ] 14.3 Тесты

## БЛОК 15 — Структурированное объяснение сигнала + семантика confidence
`A27` · `A28`

- [ ] 15.1 explanation: direction, supporting, opposing, neutral, regime, quality, confidence factors
- [ ] 15.2 `reason` генерируется из структуры
- [ ] 15.3 Явная документация «confidence ≠ probability»
- [ ] 15.4 Тесты

## БЛОК 16 — Жизненный цикл сигнала: lifecycle, dedup, transitions, cooldown, invalidation
`A29` · `A30` · `A31` · `A32` · `A33`

- [ ] 16.1 Миграция `signal_state`: GENERATED / ACTIVE / UPDATED / INVALIDATED / EXPIRED / CLOSED
- [ ] 16.2 `signal_transition` с переходами
- [ ] 16.3 Дедупликация (порог движения цены + состояния индикаторов)
- [ ] 16.4 Cooldown с конфигурируемым числом свечей, реальный reversal не запрещён
- [ ] 16.5 Правила инвалидации
- [ ] 16.6 Тесты

## БЛОК 17 — Полная история сигналов
`A34` · `B4` · `B5`

- [ ] 17.1 Расширение `signal_history`: timeframe, provider, regime, data quality
- [ ] 17.2 Индексы под реальные выборки
- [ ] 17.3 Тесты

## БЛОК 18 — Outcome Engine
`B7` · `B8` · `B9` · `B10` · `B11` · `A35` · `A36`

- [ ] 18.1 Forward returns 1/3/6/12/24/48/72 (конфигурируемые горизонты)
- [ ] 18.2 Корректность: correct / incorrect / neutral / expired / unknown
- [ ] 18.3 MFE / MAE
- [ ] 18.4 Строгий point-in-time: сигнал в T не видит данные после T
- [ ] 18.5 Тесты на look-ahead

## БЛОК 19 — Performance engine, агрегация, buckets
`B12` · `B13` · `B14` · `A37` · `A38`

- [ ] 19.1 Полный набор метрик (accuracy, precision, recall, expectancy, profit factor, maxDD, Sharpe-like)
- [ ] 19.2 Разбивка по индикаторам
- [ ] 19.3 Добавочная ценность комбинаций (alone / +others)
- [ ] 19.4 Confidence buckets 25–40 … 85–100 — без предположения, что высокий confidence лучше
- [ ] 19.5 Тесты

## БЛОК 20 — Calibration, reliability score, recent vs all-time
`B15` · `B16` · `B17`

- [ ] 20.1 Calibration layer: confidence bucket → фактическая точность
- [ ] 20.2 Reliability score (не простое среднее)
- [ ] 20.3 Recent (50/100/250/500) vs all-time — детекция деградации
- [ ] 20.4 Тесты

## БЛОК 21 — Производительность по режимам рынка
`B19`

- [ ] 21.1 Разбивка performance по regime
- [ ] 21.2 Тесты

## БЛОК 22 — Backtest: издержки и модель исполнения
`A39` · `A40` · `A41`

- [ ] 22.1 maker/taker fee, slippage, spread
- [ ] 22.2 Execution model: next_open / next_close / intrabar — выбор явный
- [ ] 22.3 Тесты

## БЛОК 23 — Walk-forward pipeline
`A42` · `B23`

- [ ] 23.1 TRAIN → VALIDATE → TEST → ROLL FORWARD
- [ ] 23.2 Проверка на leakage / future data / parameter contamination
- [ ] 23.3 Тесты

## БЛОК 24 — Оптимизация параметров + защита от overfitting
`A43` · `B24` · `B25` · `B26`

- [ ] 24.1 Registry разрешённых к оптимизации параметров (min/max/step/default/production)
- [ ] 24.2 Optimizer только на training-данных
- [ ] 24.3 Objective: return + accuracy + drawdown + stability + sample size
- [ ] 24.4 Overfitting-детектор (соседние параметры)
- [ ] 24.5 Тесты

## БЛОК 25 — Воспроизводимость, dataset registry, experiments
`A44` · `B44` · `B45` · `B46`

- [ ] 25.1 Dataset registry с checksum
- [ ] 25.2 Backtest run сохраняет всё для повторения
- [ ] 25.3 Experiment tracking
- [ ] 25.4 OOS report + aggregate
- [ ] 25.5 Тесты

## БЛОК 26 — Статистическая валидация
`A45` · `A46` · `A47` · `B47`

- [ ] 26.1 Bootstrap для метрик
- [ ] 26.2 Permutation / random baseline, shuffled signals
- [ ] 26.3 Monte Carlo: equity curve, drawdown, losing streaks
- [ ] 26.4 Тесты + детерминированный seed

## БЛОК 27 — Adaptive engine: shadow, promotion, rollback
`B2` · `B21` · `B22` · `B27` · `B28` · `B29` · `B30`

- [ ] 27.1 Модуль `adaptive/` (service, types, calibration, evaluator, optimizer, strategy-version)
- [ ] 27.2 Детерминизм, сохраняемый seed
- [ ] 27.3 Shadow strategy: не влияет на production-сигнал, результат сохраняется
- [ ] 27.4 Promotion только при строгих условиях
- [ ] 27.5 Rollback
- [ ] 27.6 Adaptive weights — только shadow mode
- [ ] 27.7 Тесты

## БЛОК 28 — Retention policy + аудит индексов
`A48` · `B32` · `B33`

- [ ] 28.1 Политика для candles / signals / outcomes / telemetry / metrics / backtests
- [ ] 28.2 Аудит индексов под реальные запросы
- [ ] 28.3 `EXPLAIN ANALYZE` на тяжёлых запросах
- [ ] 28.4 Тесты

## БЛОК 29 — Observability / reliability
`A50`

- [ ] 29.1 Полный набор метрик из роадмапа
- [ ] 29.2 Структурированные логи с requestId/provider/symbol/operation/duration/errorCode
- [ ] 29.3 /liveness и /readiness (readiness учитывает БД и market data)
- [ ] 29.4 Graceful shutdown (уже частично, доводим)
- [ ] 29.5 Recovery после восстановления provider
- [ ] 29.6 Тесты

## БЛОК 30 — Poller reliability + snapshot cache
`B35` · `A3` · `B37`

- [ ] 30.1 Аудит poller: overlapping runs, backpressure, restart, graceful shutdown
- [ ] 30.2 Cache: fresh / stale-but-usable / expired, stale-while-error, stampede
- [ ] 30.3 Single-flight на все типы запросов (price / market / analysis)
- [ ] 30.4 Тесты

## БЛОК 31 — Feature extraction + ML dataset + Research lab
`B48` · `B49` · `B50`

- [ ] 31.1 Независимый от ML-фреймворка слой feature extraction
- [ ] 31.2 Point-in-time датасет, детерминированный, версионированный, split по времени
- [ ] 31.3 Research/Strategy Laboratory, отделённый от runtime-критического пути
- [ ] 31.4 Тесты

---

## Итоговая проверка после каждого блока

```
npm run lint
npm run typecheck
npm run typecheck:backend
npm run verify   (lint + typechecks + tests + build)
```

## Правила, действующие на всём проходе

1. Frontend (`src/app/**`) не трогаем вообще.
2. Коммит после каждого блока, без push.
3. Никакого uncontrolled self-learning: Signal → Outcome → Statistics → Candidate → Backtest → Walk-forward → Shadow → Approval → Production.
4. Никакого look-ahead bias.
5. Старые результаты не переписываются.
6. Конфигурация через Zod.
7. Тесты обязательны; `fast-check` — где есть настоящие инварианты.
8. Никаких правок «ради правки».
