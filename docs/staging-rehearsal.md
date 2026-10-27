# Локальная репетиция rollout — YAR-85

25.10.2026. Владелец подтвердил в чате: **отдельного staging пока нет**.
Поэтому удалённое развёртывание, DNS/TLS, topology прокси, delivery алертов и
нагрузка целевого хоста остаются **NOT_TESTED**. Платные ресурсы, чужой сервер и
production не использовались. Эта репетиция не выдаётся за удалённый staging.

## Фактически запущено

Новый loopback PostgreSQL18.4 на порту55477, отдельная БД `stage6_lab`;
тесты используют другую `buynotbuy_stage6_test` и свои private schemas.
Migration CLI выполнен до API: exit0, v25. API — текущая рабочая копия,
база `18e0034a407c0e6b7281efd0549e8dd09f3eb46d` плюс незакоммиченные изменения.
Frontend — production `next build` и настоящий Chromium (см.
[browser evidence](browser-e2e.md)). `.env` не копировался в учебный кластер.

Параметры лабораторного API (здесь отсутствуют секреты):

```text
HOST=127.0.0.1
PORT=3301
DATABASE_URL=postgresql://dr_operator@127.0.0.1:55477/stage6_lab
MARKET_PROVIDER=mock
MARKET_ALLOW_MOCK=1
MARKET_SYMBOL=BTCUSDT
MARKET_SYMBOLS=ETHUSDT
MARKET_VENUE_CAPABILITIES=mock=BTCUSDT,ETHUSDT@15m,1h,4h,1d
MARKET_POLL_ENABLED=false
WRITE_SPOOL_ENABLED=false
DEPLOY_SHA=18e0034a407c0e6b7281efd0549e8dd09f3eb46d
```

Начальная попытка boot без ETH capabilities была отвергнута конфигуратором
до открытия HTTP-сокета. После явного mock capability обе серии обслуживаются.
`MARKET_ALLOW_MOCK=1` — только тестовая репетиция, не разрешение использовать
mock как production feed. Health deploySha — введённая настройка базы кода,
сам по себе он не подтверждает fingerprint незакоммиченного артефакта.

С мигрированной БД и указанными переменными:

```powershell
node --import=tsx src/backend/server.ts
# Во втором терминале:
node --import=tsx src/backend/research/release/staging-smoke.cli.ts
```

Smoke runner принимает только неаутентифицированный loopback URL
`LAB_BACKEND_URL` (по умолчанию `http://127.0.0.1:3301`), делает GET к health,
readiness, registry, BTC/ETH market+analysis, unknown ticker и metrics. Он
проверяет фактическую identity mock snapshot, а не только HTTP200. JSON-результат
сохраняется в [staging-smoke.json](staging-smoke.json).

Readiness top-level `ready` проверяет доступность БД и не означает healthy
всех market components: в синтетическом стенде встречается `degraded/failing`
для истории/провайдера. Это отражено в JSON, а не скрыто ради PASS. Включить
ingestion или сменить readiness policy в production этим документом не разрешено.

## Откат к прошлой версии

Через `git archive` извлечён локально существующий предыдущий SHA
`83b704cf2633cc69224bf96ebb260111a3b06260` в новый каталог `%TEMP%`, без смены
основного checkout. API предыдущей версии запущен на3302 с той же отдельной
учебной БД v25 и mock-конфигурацией. `/healthz` вернул этот предыдущий SHA,
`/api/market` и `/api/instruments/ETHUSDT/market` —200 и соответствующий symbol.
Текущий процесс на3301 продолжил работу. Это совместимость кода/схемы и
репетиция выбора endpoint; переключения внешнего трафика не было.
Краткий HTTP-лог: [rollback-smoke.json](rollback-smoke.json).

Зависимости для архивной копии предоставлены локальным node_modules текущего
lockfile через junction. Поэтому это **не** доказательство воспроизводимости
старого deployment image/старого lockfile. Настоящий rollback должен использовать
ранее собранный неизменяемый артефакт, его fingerprint и совместимую схему.
Восстановление backup в новую БД с checksum/provenance проверено отдельно:
[disaster recovery](disaster-recovery.md). Down-миграции не изобретались.

## Отказы, наблюдаемость и границы

Контролируемые failure-injection проверки выполняются без сети биржи:
`failover.wrong-answer.test.ts`, `failover.attribution.test.ts`,
`failover.circuit.test.ts`, `market-isolation.test.ts`,
`runtime-reliability.test.ts`, новые historical-provenance тесты. Они проверяют
primary/fallback, wrong-symbol/interval, раздельные кеши и восстановление.
Это simulation/integration, не фактический outage биржи на удалённом хосте.

Metrics endpoint отдаёт Prometheus exposition. Лимитер при сбое своего store
сохраняет принятое fail-open поведение и теперь считает ограниченный counter;
условие алерта и тесты описаны в [security CI](security-ci.md). Доставка
уведомления реальному получателю здесь **NOT_TESTED**: нет отдельного стенда,
Prometheus/Alertmanager и согласованного канала. Синтетический backend, браузерные
lab timing и [исторический performance baseline](performance-baseline.md)
не измеряют p95 сети будущего target.

## Перед внешним rollout

Владелец выбирает существующий или новый staging host и его бюджет/доступы;
создаются отдельные credentials и роль приложения без DDL. На опубликованном
артефакте требуется migration job → backend/frontend → health+actual SHA →
BTC smoke → контролируемый failover → проверка уведомления → rollback из
предыдущего артефакта/backup. Затем обновляется [release matrix](release-status.md).
Внешние deploy, переключение трафика, включение ingestion и ETH требуют
явного решения владельца. До этих проверок рекомендация для внешнего release
остаётся NO_GO.
