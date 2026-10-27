# Восстановление базы и учебная проверка

YAR-77, проверено 25.10.2026 на `18e0034a407c0e6b7281efd0549e8dd09f3eb46d`.
Это проверка восстановления синтетической базы, не разрешение на production
rollout. Рабочие данные, `.env` и рабочий PostgreSQL не использовались.

## Что сохранять

Снимать полный custom-format `pg_dump`, включая миграционный журнал, реестр,
историю сигналов, snapshots, стратегии и последовательности. Нельзя сохранять
только свечи: потеряются связи и происхождение исследований. `pg_dump` получает
согласованный снимок одной базы; зафиксировать время начала/окончания, SHA кода,
версию сервера/клиента, размер и SHA-256 архива. Файл с контрольной суммой хранить
отдельно с ограниченными правами. Проверять checksum до восстановления.

Роли, grants, настройки кластера, secrets, write-spool и внешние research-файлы
не входят в такой backup. Восстанавливать роли/доступы из отдельно защищённой
конфигурации; применять минимальные права приложения. Команда восстановления
ниже не применяет исходных владельцев/ACL. Не подключать рабочий spool к учебному backend.
Не публиковать архивы, connection strings и пользовательские данные в Git/Linear.

Предлагаемая политика, **ещё не настроена и требует решения владельца**:
ежедневный зашифрованный backup, 7 ежедневных и 4 еженедельных копии вне хоста,
ежемесячный restore drill. Для этого режима целевой RPO ≤24 ч, RTO ≤60 мин;
доказательств выполнения на production нет. Для меньшего RPO нужны base backups
и WAL/PITR с отдельной проверкой; один `pg_dump` этого не обеспечивает.
Retention исследовательских строк в БД не заменяет retention резервных копий.

## Воспроизведение на Windows / PowerShell

Требуются установленный PostgreSQL (включая `initdb`, `pg_ctl`, `psql`,
`createdb`, `pg_dump`, `pg_restore` в PATH), Node и зависимости проекта.
Запускать из корня репозитория. При занятом порту выбрать другой для ВСЕХ команд.
Локальная trust-аутентификация допустима только для этого короткоживущего
кластера на loopback; не применять её к общей/staging/production базе.

```powershell
$drRoot = Join-Path $env:TEMP ('buynotbuy-dr-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $drRoot | Out-Null
initdb -D "$drRoot/pgdata" -U dr_operator -A trust --encoding=UTF8 --locale=C
if ($LASTEXITCODE -ne 0) { throw 'initdb failed' }
# Запустить pg_ctl скрыто; путь может отличаться по версии PostgreSQL.
$drCtl = (Get-Command pg_ctl).Source
$drArgs = '-D "{0}/pgdata" -l "{0}/postgres.log" -o "-h 127.0.0.1 -p 55477" -w start' -f $drRoot
Start-Process -FilePath $drCtl -ArgumentList $drArgs -WindowStyle Hidden
```

Дождаться `pg_isready -h 127.0.0.1 -p 55477 -U dr_operator -d postgres`
с exit 0. Для каждой следующей внешней команды проверять `$LASTEXITCODE`;
не продолжать после неожиданного ненулевого кода. Сохранить предыдущий
`DATABASE_URL` перед изменением и восстановить его в `finally`.

```powershell
createdb -h 127.0.0.1 -p 55477 -U dr_operator dr_source
createdb -h 127.0.0.1 -p 55477 -U dr_operator dr_restored
$drPreviousDatabaseUrl = $env:DATABASE_URL
$env:DATABASE_URL = 'postgresql://dr_operator@127.0.0.1:55477/dr_source'
node --import=tsx src/backend/db/migrate.cli.ts
psql -X -h 127.0.0.1 -p 55477 -U dr_operator -d dr_source -v ON_ERROR_STOP=1 -f docs/dr/seed.sql
psql -X -qAt -F '|' -h 127.0.0.1 -p 55477 -U dr_operator -d dr_source -v ON_ERROR_STOP=1 -f docs/dr/manifest.sql -o "$drRoot/source.manifest"
pg_dump -h 127.0.0.1 -p 55477 -U dr_operator -d dr_source -Fc --no-owner --no-acl -f "$drRoot/backup.dump"
Get-FileHash "$drRoot/backup.dump" -Algorithm SHA256
pg_restore -h 127.0.0.1 -p 55477 -U dr_operator -d dr_restored --exit-on-error --single-transaction --no-owner --no-acl "$drRoot/backup.dump"
$env:DATABASE_URL = 'postgresql://dr_operator@127.0.0.1:55477/dr_restored'
node --import=tsx src/backend/db/migrate.cli.ts
psql -X -qAt -F '|' -h 127.0.0.1 -p 55477 -U dr_operator -d dr_restored -v ON_ERROR_STOP=1 -f docs/dr/manifest.sql -o "$drRoot/restored.manifest"
if ((Get-FileHash "$drRoot/source.manifest").Hash -ne (Get-FileHash "$drRoot/restored.manifest").Hash) { throw 'Restore mismatch' }
psql -X -qAt -F '|' -h 127.0.0.1 -p 55477 -U dr_operator -d dr_source -v ON_ERROR_STOP=1 -f docs/dr/schema-manifest.sql -o "$drRoot/source.schema"
psql -X -qAt -F '|' -h 127.0.0.1 -p 55477 -U dr_operator -d dr_restored -v ON_ERROR_STOP=1 -f docs/dr/schema-manifest.sql -o "$drRoot/restored.schema"
if ((Get-FileHash "$drRoot/source.schema").Hash -ne (Get-FileHash "$drRoot/restored.schema").Hash) { throw 'Schema mismatch' }
psql -X -h 127.0.0.1 -p 55477 -U dr_operator -d dr_restored -v ON_ERROR_STOP=1 -f docs/dr/constraints.sql
```

`manifest.sql` сравнивает полные JSONB-строки, включая NULL, ID, площадку,
интервал, instrument link, timestamp и ingested_at; порядок детерминирован.
Внутренний MD5 — индикатор случайного повреждения, не криптографическая
аутентификация. SHA-256 всего архива — отдельная проверка целостности.
Агрегация строк предназначена для малой учебной базы; для больших таблиц нужны
потоковые хеши/контрольные диапазоны из согласованного снимка.
`schema-manifest.sql` отдельно сравнивает колонки, defaults/identity, constraints,
indexes, triggers и функции. Имена баз исключены, чтобы восстановление в новую
БД не давало ложного расхождения. Владельцы/ACL намеренно не сравниваются.

## Отрицательные проверки

1. `psql -X -qAt -F '|' ... -d dr_restored -v ON_ERROR_STOP=1 -f docs/dr/tamper-check.sql -o "$drRoot/tampered.manifest"`
   должен завершиться с 0, но SHA-256 должен отличаться от `source.manifest`:
   меняется только provenance одной строки. Повторный исходный manifest после
   ROLLBACK должен совпасть. `...` означает тот же host/port/user, что выше.
2. `constraints.sql` в транзакции проверяет следующий candle ID >24,
   восстановленный instrument trigger и отказ неизвестному инструменту.
   Записи откатываются; sequence increments не откатываются — это ожидаемо.
3. Создать **новую** `dr_corrupt`. Записать только первую половину байтов
   `backup.dump` в отдельный `truncated.dump` через `[IO.File]::WriteAllBytes`.
   Вызвать ту же `pg_restore --single-transaction --exit-on-error`, адресовав
   `dr_corrupt`. Ожидать exit 1. Запрос
   `SELECT count(*) FROM information_schema.tables WHERE table_schema='public'`
   должен вернуть 0. Исходный архив не менять.
4. Создать **новую** `dr_future`, восстановить исходный архив, вставить
   `INSERT INTO schema_migrations VALUES (26, 'dr_future_schema', 1793145600000)`.
   Запустить migration CLI только с URL `dr_future`: ожидается exit 1 с
   сообщением, что build понимает v25, а база v26. Вернуть URL restored/source.
5. В `dr_restored` выполнить в одной транзакции
   `BEGIN; DROP INDEX idx_signal_history_series_time;`, schema-manifest и
   `ROLLBACK;`. Manifest должен отличаться, а повторный после rollback —
   совпасть. Не выполнять этот сценарий на общей базе.

## Измеренный результат

`origin/main` подтверждён `git ls-remote` и совпал с указанным SHA.
PostgreSQL server/client 18.4, Windows, отдельный loopback-кластер.
Source был без writers на протяжении снимка.

| Шаг | Exit / результат |
|---|---|
| initdb, создание source/restore | 0 |
| migration CLI source | 0, v25 |
| seed + source manifest | 0; 3 assets, 2 instruments, 24 candles, 24 signals, 25 migrations |
| pg_dump | 0, 478 мс |
| pg_restore + migration retry + manifest | 0, 1134 мс суммарно |
| Сравнение manifest | PASS, одинаковый SHA-256 |
| Сравнение schema manifest | PASS, 450 определений совпали |
| Отсутствующий индекс / schema rollback | PASS, обнаружен / исходная схема совпала |
| Constraints/sequence/unknown ticker | 0, PASS |
| Provenance tamper / rollback | 0, различие обнаружено / исходные строки совпали |
| Truncated archive | 1, unexpected EOF; public tables = 0 |
| Schema v26 против build v25 | 1, ожидаемый отказ |
| Migration Vitest suites | 0, 7/7 тестов в 2 файлах |

Архив SHA-256:
`044ca24b4ff699d34349a3185911dd002185dd3a6aaea9ee6f9ff76ea5b83737`.
Оба manifest SHA-256:
`3b5dcb1c09c9fe96c110107155ce5d0326f2b244214cc0b5d25415a314224e5a`.
Хеши applied_at и архива при новом запуске могут отличаться; сравнивать
source/restore одного запуска, не требовать равенства историческому хешу.
Schema manifest SHA-256:
`d516c9b7fa5fb4077f30f6639bcc8dc32602f3db923983175cc043829bec63b5`.
Тесты: `DATABASE_URL` указывает на `dr_restored`, затем
`npx vitest run src/backend/db/migrations.test.ts src/backend/db/migrations.private-schema.test.ts`.
Изолированные тестовые схемы удалены test teardown.

Независимое read-only ревью проверило SQL, safety scope, архив и данные на БД.
Замечания учтены: ownership относится к флагам восстановления, а schema
fingerprint проверяется отдельно от ledger. Новый CI для этих локальных
изменений **NOT_RUN**; commit/PR не создавались. GitHub connector вернул пустые
списки commit statuses и PR workflow runs для HEAD, что не доказывает ни успех,
ни отсутствие main CI. Свежий `npm audit --json`: exit 0, 0 advisories;
dependency lockfile не изменялся.

Потеря строк учебного снимка = 0. Это не измерение production RPO.
1134 мс — только restore/migrate/manifest малой фикстуры, без provisioning,
обнаружения аварии, приложения и смены трафика; это не production RTO.
Полноценные snapshots/strategy lifecycle, роли, PITR, внешние файлы,
staging smoke и production recovery: **NOT_TESTED**.

## Решение оператора при аварии

Остановить записи и изолировать spool. Сохранить исходную базу и её логи.
Проверить checksum и время снимка, восстановить в **новую** БД, применить
совместимую migration job из того же артефакта, сравнить ledger, данные и
provenance, затем выполнить backend/readiness и frontend smoke. Сверить
потерянный интервал с согласованным RPO; новые данные восстанавливать только
из проверенного источника, не переписывая provenance.

Миграции проекта направлены вперёд; автоматического `down` нет. Rollback
приложения допустим только при совместимой схеме. При несовместимости вернуть
предыдущий артефакт и его проверенный backup в ещё одну новую БД; не удалять
строки журнала миграций и не откатывать DDL вручную. Переключение DATABASE_URL,
трафика и повторное включение ingestion — отдельное решение владельца.

После учебной проверки вернуть `$env:DATABASE_URL = $drPreviousDatabaseUrl` и
остановить **только созданный кластер**:
`pg_ctl -D "$drRoot/pgdata" -m fast -w stop`.
Архив/логи можно сохранить для ревью в защищённом каталоге; автоматического
удаления данных этот runbook не выполняет.
