# Stage 5–6: сводная проверка локального patch

Текущая публикация и новые проверки 27.10.2026 описаны в
[приёмке кандидата](release-candidate-acceptance.md). Этот отчёт сохраняет
результаты исходного локального снимка, а не текущего GitHub HEAD.

> Исторический отчёт исходного candidate-v1 (89 файлов, fingerprint `6bf9875a11184ea1911ee1d75c3d9451e52ca8e9aedd749ced506c1ab469d215`). Результаты ниже не удостоверяют последующие изменения DB pool/lease из YAR-89. Их новая фиксация, независимый review и чистая сборка относятся к YAR-87/88/89.

Проверка 25–26.10.2026, база `18e0034a407c0e6b7281efd0549e8dd09f3eb46d`.
Рабочие изменения не опубликованы. Полная локальная проверка завершена;
это не является свидетельством запуска удалённого CI.

## Scope и независимое review

| Задача | Локальное изменение / доказательство |
|---|---|
| YAR-77 | [Backup/restore](disaster-recovery.md), совпали полные строки и 450 определений схемы; отдельное read-only review |
| YAR-78 | Правдивые API metadata из того же snapshot, согласие индикаторов вместо вероятности, качество как диагностика, не выдуманный veto |
| YAR-81 | [Chromium](browser-e2e.md), 18 сценариев; реальный API+PG: 8 пар запросов и 2 браузерных рынка; исправлены retry и мобильное переполнение |
| YAR-82 | [Identity/history gate](historical-integrity-gate.md), отказ до записи при недоказанном источнике, неправильной venue/symbol/interval/времени |
| YAR-83 | [Advisory gate](security-ci.md), истекающие исключения, failures/recovery лимитера, bounded counter, Actions SHA pins |
| YAR-84 | [Проспективный протокол](research-protocol.md), SHA inventory, регистрация не опубликована, исход INCONCLUSIVE |
| YAR-85 | [Локальный rollout и rollback](staging-rehearsal.md); владелец подтвердил отсутствие отдельного staging |
| YAR-86 | [Матрица окружений](release-status.md), lockfile и автоматическая consistency check |
| YAR-79 | Подготовлено решение NO_GO для внешнего релиза до remote gates и owner acceptance |

Независимый reviewer выявил и повторно проверил исправления: подмена selected
failover venue, bare historical adapters без атрибуции, времена/закрытость
свечей, смешение quality diagnostics с veto. Reproductions неправильных данных
дают 0 записей; допустимая формирующаяся ingestion свеча остаётся незакрытой.
Финальный независимый scoped run: 6 файлов / 61 тест, exit0. Другой reviewer
проверил security gate/CI, блокирующих замечаний не осталось.

В общей проверке дополнительно обнаружены интеграционные нарушения: служебные
release CLI сначала попали в незаявленный domain layer; перенесены в существующий
`research/release`. SQL inventory перенесён к repository boundary. Существующие
архитектурные проверки не отключались и не ослаблялись. Architecture/observability
документы обновляются их штатным генератором.

## Команды и результаты

| Команда / проверка | Результат |
|---|---|
| `npm run verify` | **exit0, 285 файлов / 5548 тестов PASS**, 519.32 с; canary, Biome, frontend/backend types также PASS |
| `npx next build` | exit0 на финальных frontend изменениях |
| `npm run build:backend` | exit0 после переноса CLI и SQL к корректным архитектурным границам |
| `npm run browser:e2e` | exit0, 18 проверок, [JSON](browser-results.json) |
| `e2e/real-backend-smoke.ts` | exit0, 8 API pairs + 2 browser markets; повтор 26.10 против **compiled dist/backend/server.js** и учебной PG, [JSON](browser-real-backend.json) |
| Полный и runtime `npm audit --json` | exit0, 0 advisories, повтор 26.10; lockfile SHA в матрице |
| Advisory gate над обоими отчётами | exit0 |
| `npm run docs:check` | exit0; path/link/commit/lockfile/environment consistency |
| Types security scripts | exit0 |

Подробные логи находятся в локальном `data/verification/` (git-ignored).
Первый verify завершился exit1 (6 файлов, 7 тестов) при интеграционном исправлении
границ/документации и переносе файлов во время прогона; сохранён как
`verify-initial.log`. После фиксации исходников targeted repeat дал 93/93,
затем чистый полный `verify-final.log` дал 5548/5548. Архитектурные guards не
ослаблялись. Лог содержит сообщения injected failures и существующие warnings
асинхронных записей после закрытия test pool; PASS не выдаётся за отсутствие
предупреждений в логах.
Screenshots/traces браузера — `data/browser-e2e/final-verified/` и
`data/browser-e2e/real-backend-verified/`. Лабораторные LCP/CLS/короткие INP
кандидаты не выдаются за production RUM. Один запуск под CPU contention вышел
за неизменённый interaction budget; документирован, тихий повтор прошёл.
Последний compiled-backend прогон: `data/browser-e2e/release-final-26/`.
Отпечатки всех изменённых/добавленных файлов сохранены отдельно в
`data/verification/patch-manifest.json`; это fingerprint рабочего patch, не
commit SHA опубликованного артефакта.

## Не закрытые внешние gates

Удалённого staging нет; production deployment, DNS/TLS/ingress, alert delivery,
remote failover/cutover и реальный rollback неизменяемого release image
**NOT_TESTED**. Новый GitHub CI не запускался для неопубликованных изменений.
Новые future observations не существуют; протокол не обещает прибыльности и
не калибрует raw agreement в вероятность без отдельного будущего доказательства.

Рекомендация **NO_GO для внешнего релиза**. Локальные изменения прошли общий
прогон и готовы к review. Commit/push/merge/deploy и
активация ETH не выполнялись. Owner acceptance не подменяется решением агента.
