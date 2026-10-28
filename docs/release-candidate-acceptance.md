# Приёмка кандидата — обновление 28.10.2026

Решение для внешнего релиза: **NO_GO**. Эта запись обновляет исторические
[матрицу 26.10](release-status.md) и [локальный отчёт](stage6-verification.md).
`release-status.json` сохраняет проверяемый исторический локальный снимок:
его `baseCommit` и `workingTree` не обозначают текущий PR или deployment.

## Публикация и CI

- Проверенный `main`: `18e0034a407c0e6b7281efd0549e8dd09f3eb46d`.
- [Draft PR #21](https://github.com/YaroslavShkoda/BuyNotBuy.com/pull/21):
  опубликованы исходные 103 файла в `f11fac772386b929df11eec73563891f9efc6fdf`,
  tree `4e2f251d4f94d1c08d3f99140fb21c6d1d4ef547`.
- [CI f11](https://github.com/YaroslavShkoda/BuyNotBuy.com/actions/runs/40494751526):
  verify, migration-smoke, dependency-security, browser-e2e SUCCESS;
  287 файлов / 5572 теста PASS, frontend/backend build PASS, browser 18 PASS.
- Следующий опубликованный commit
  `0941bc2babf898b9f18c7048798b76a02a319a54`,
  tree `739d3c2186c819e36a0560659fdfdad0d765321e`: три файла delta,
  105 файлов относительно main. Добавлены multi-series retention regression
  и исключение архивов `data/**` из Vitest с регрессией настоящего CLI.
  Независимый exact-delta review PASS, собственный replay 2 файла / 11 тестов PASS.
- [Новый CI 0941](https://github.com/YaroslavShkoda/BuyNotBuy.com/actions/runs/40560335584):
  все четыре jobs SUCCESS; 288 файлов / 5574 теста PASS, 109.98 с,
  frontend/backend build PASS, migration и security gates PASS, browser 18 PASS.
  Это отдельный запуск для нового HEAD, а не перенос результата f11.

Документация после указанного commit проходит отдельную проверку CI;
её собственный commit и результат фиксируются в PR и Linear. Эта запись
не заявляет проверку будущих commit. Merge, production deployment и внешняя
активация рынков не выполнялись. Исходные локальные изменения и index сохранены.

## Следующая проверяемая версия — 28.10.2026

Изменения ниже подготовлены после `0941bc2`; его зелёный CI не удостоверяет их.
Их итоговые commit/tree и отдельный CI фиксируются в PR21 и Linear после
публикации. До такого результата новые карточки не считаются принятыми.

- YAR-93: тестовый API harness дожидается реальных фоновых записей до закрытия
  приложения. Ошибка одной операции не позволяет обогнать ещё работающую соседнюю.
  Оба RED-сценария воспроизведены; исправленный файл 15/15 PASS и независимо
  повторён 15/15, без ended-pool диагностик. Реальные вызовы и обработчики ошибок
  сохранены; production lifecycle не менялся.
- YAR-94: дробная confidence обычной стратегии отклонялась INTEGER-полями
  журнала с22P02. Новая forward migration026 расширяет оба поля до DOUBLE
  PRECISION без округления, масштабирования или изменения стратегий. Legacy
  значения55/60/100, nullability и row identity сохраняются; NaN/±Infinity
  отвергаются constraints. Исполнитель:29 тестов PASS; независимый replay:25 PASS.
- YAR-84: владелец принял неизменённый протокол версии1. Отдельная
  [квитанция принятия](research-registration.json) фиксирует исходный Git commit,
  canonical byte hash и консервативное время внешней записи решения в Linear:
  `2026-10-28T05:19:15.203Z`. Это owner acceptance, не публичный реестр или
  криптографическое доказательство личности. [Новый readiness](research-readiness-owner-accepted.json)
  содержит OWNER_ACCEPTED и одновременно 0 eligible bars, INCONCLUSIVE,
  not_calibrated, NOT_STARTED. Первый допустимый полный час открывается06:00UTC
  и закрывается07:00UTC28.10; старые CSV не становятся проспективными.
  Receipt/hash/date/CLI и границы проверены32 тестами; исходный protocol JSON,
  исторический readiness/1 и данные не менялись.

Миграция026 проверялась только в изолированных одноразовых схемах. Она может
переписать таблицу, берёт ACCESS EXCLUSIVE и валидирует constraints; перед
применением к рабочей среде нужны согласованные backup, окно и lock budget.
Старый build откажет ledger26: rollback требует совместимого кода и плана,
а не слепого downcast дробных значений. В рабочей Docker БД и production эта
миграция не применялась. Исторический role-lab f11/v25 не удостоверяет v26;
новый replay должен иметь собственные source hashes и ledger.

## Независимая повторная проверка

Новая физическая копия GitHub `f11fac7`, без переноса dependencies/build/.env:
install, production frontend/backend build и 18 браузерных сценариев PASS.
Windows, Node 24.21, PostgreSQL 18.4, Chromium 156; удалённый CI использует
собственную чистую Ubuntu-среду и не заменяется этими локальными результатами.

| Лабораторный сценарий | LCP, мс | CLS | Короткий INP-кандидат, мс |
|---|---:|---:|---:|
| Desktop, cold | 1276 | 0 | 56 |
| Desktop, warm | 224 | 0 | 48 |
| Mobile emulation, cold | 260 | 0 | 64 |
| Mobile emulation, warm | 152 | 0 | 40 |

Это синтетическая лаборатория без throttling, не полевые Core Web Vitals,
физический мобильный аппарат или проверка настоящим screen reader.

Повторная лаборатория restricted runtime role: 48/48 PASS, audit и disposal
exit0. Проверены настоящие SQLSTATE 42501/57014/55P03/57P01, пережитое
backend-процессом завершение PG session, повторный lease, durable spool replay,
retention boundaries и новое успешное соединение. Этот role-lab остановлен;
отдельный временный PG55496 используется для последующих тестов93/94 и имеет
собственную проверку завершения. Рабочий Docker-контейнер к этому lab не относится.

Отдельная независимая проверка history/API: 21 adversarial scenario PASS,
BTC/ETH × Binance/Bitget × 15m/1h/4h/1d, identity/future/forming guards,
конкуренция, неизменность inventory, socket-IP budget, spoofed headers,
метрики ограниченной кардинальности и отказ/восстановление limiter store.
Общий выбранный batch **FAIL: 182/183**, один header case превысил 5000 мс;
изолированный повтор PASS не меняет итог batch. Это YAR-92.
Четыре предупреждения записи после закрытия test pool отслеживаются в YAR-93.

YAR-90: старая hour_bucket policy удаляет fresh и даёт RED; timestamp policy
сохраняет fresh/cutoff строки. Новый сценарий покрывает 8 series, 16 history
rows, protected candles/outcomes и идемпотентность. YAR-91: исключены только
корневые локальные архивы; source `src/data` и security tests обнаруживаются.
Финансовые формулы, исходные timeout budgets и правила rate limiting сохранены.

Новая независимая структурная проверка четырёх неизменённых CSV:57412 строк,
0 invalid OHLCV/duplicates/order errors. BTC1h:7 разрывов,14 пропущенных часов;
Yahoo BTCdaily:5 разрывов,23 пропущенных дня; Binance BTC/ETHdaily без разрывов.
Агрегация2088 полных BTCдней из24 часов совпала с dailyOHLCV;8 неполных дней
исключены. Это внутренняя согласованность, не доказательство upstream identity.
Единственный запрос трёх свечей к официальному Binance API получил HTTP451;
проверка остановлена без обхода ограничения, внешних свечей не подтверждено.
Существующий PostgreSQL Docker-контейнер запущен по просьбе владельца28.10;
после crash recovery выполнен repeatable-read/read-only inventory PostgreSQL18.6,
схема25. Всего1154 свечи: Binance BTC1h402, ETH1h376 и SOL1h376 вне проверяемого
BTC/ETH scope. В имеющихся рядах нет gaps/duplicates/invalid OHLCV/identity mismatch.
Полный row hash до/после совпал:
`e5472d77ef5d74ed2051518e2c146ee25028becf4a6ec62e6d8286fe3d16b751`.
Из16 аудируемых BTC/ETH комбинаций двух venue и четырёх intervals заполнены2;
это проверочная матрица, не утверждение об активации всех16 в deployment.
Последняя закрытая свеча BTC/ETH открывается19.10.2026 22:00UTC: данные stale,
upstream provenance не подтверждено. Никакие записи, миграции, удаление SOL
или активация рынков этой проверкой не выполнялись. YAR-82 остаётся NO_GO.

## Оставшиеся границы и очередь

| Gate | Состояние / следующее действие |
|---|---|
| YAR-78, assistive technology | Реальный screen reader и аппарат NOT_TESTED |
| YAR-82, реальная история | Production inventory и независимые source receipts NOT_TESTED; stored labels не доказывают происхождение, activation gate остаётся NO_GO |
| YAR-84, будущий эксперимент | Owner acceptance зафиксировано отдельным receipt; сбор будущих данных NOT_STARTED, INCONCLUSIVE, raw agreement не вероятность успеха |
| YAR-92/93, стабильность тестов | Холодный timeout остаётся UNKNOWN после3 корректных ограниченных PASS без изменения5000ms; teardown исправлен в новой версии, отдельный CI ещё обязателен |
| YAR-85, staging | Владелец ранее отложил: отдельного сервера нет. DNS/TLS/ingress, реальные провайдеры/failover, доставка alerts и удалённое восстановление NOT_TESTED |
| YAR-79, решение | NO_GO до staging evidence, источников данных и явного решения владельца |

Синтетический backup/restore проверяет лабораторные данные; production PITR,
RPO/RTO и реальное восстановление не заявлены. Полевые alerts/proxy policy,
нагрузка и production grants/cutover остаются непроверенными. Закрытие карточки
технической реализации не является разрешением на merge или deployment.
