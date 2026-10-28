# Матрица релиза — исторический снимок 26.10.2026

Текущее состояние опубликованных изменений и проверок на 27.10.2026:
[приёмка кандидата](release-candidate-acceptance.md). Таблицы ниже сохраняют
исторические результаты 26.10; NOT_RUN ниже не относится к опубликованному PR.

YAR-86 / YAR-79. Источник для автоматической проверки:
[release-status.json](release-status.json), команда `npm run docs:check`.
Работа начата 25.10, итоговая проверка продолжена 26.10 после восстановления лимита.
База локальных изменений `18e0034a407c0e6b7281efd0549e8dd09f3eb46d`, подтверждена
прямым `git ls-remote origin refs/heads/main`. Изменения этой сессии не
закоммичены; SHA в `/healthz` обозначает базу, а не идентичность грязного дерева.

## Окружения и границы активации

| Среда | Версия / схема | Рынки / источник | Доказательство |
|---|---|---|---|
| Локальная репетиция | база `18e0034` + локальные изменения / v25 | BTCUSDT + ETHUSDT / mock; 1h, capabilities 15m/1h/4h/1d | [Локальный стенд](staging-rehearsal.md); разрешён только синтетический лабораторный scope |
| Исторический dev-host 24.10 | `83b704c` / исторический запуск | BTC+ETH / Binance | [Performance baseline](performance-baseline.md); не текущий deployment |
| Удалённый staging | отсутствует (подтверждение владельца) | UNKNOWN / UNKNOWN | NOT_TESTED, нужен отдельный стенд |
| Production | UNKNOWN / UNKNOWN | UNKNOWN / UNKNOWN | NOT_TESTED, deployment/activation не выполнялись |

`.env.staging.example` — образец с `.example` DNS, не адрес рабочего стенда.
Defaults `MARKET_SYMBOL=BTCUSDT` не доказывают текущую production активацию.
[ETHUSDT gate](ethusdt-activation.md) остаётся обязательным перед внешней
активацией; локальная mock-репетиция этого разрешения не даёт.

## Проверки текущей работы

| Gate | Текущее доказательство |
|---|---|
| Lockfile | Canonical SHA-256 (`sha256-crlf-to-lf/1`) в JSON; locked/installed Next16.4.2, zod4.6.7, Fastify5.12.7, Vitest5.0.5, Playwright1.64.1 |
| Security | свежие runtime/full npm audit =0 advisories, gate exit0; [policy и отрицательные тесты](security-ci.md) |
| Browser | [реальный Chromium и лабораторные метрики](browser-e2e.md); mock SSR API и настоящий PG backend различаются явно |
| Исторические данные | [attributed history + SQL gate](historical-integrity-gate.md); legacy provenance без независимого подтверждения не получает GO |
| DR | [backup/restore синтетики](disaster-recovery.md), 450 schema definitions; production DR NOT_TESTED |
| Research | [протокол](research-protocol.md), [SHA inventory](research-readiness.json); будущих данных нет, INCONCLUSIVE |
| Общая регрессия | финальные команды/exit codes фиксируются в [общем отчёте проверки](stage6-verification.md) после интеграции |
| CI нового patch | NOT_RUN: локальные изменения ещё не опубликованы |
| Remote deployment / alerts | NOT_TESTED, нужен реальный target и подтверждённая маршрутизация уведомлений |

Строка `zod ^4.6.5` в package.json задаёт диапазон. Фактически lockfile содержит
4.6.7; исторический high advisory в [Stage4 acceptance](release-acceptance.md)
не является текущим результатом аудита. Новый gate учитывает runtime advisories
и expiring exceptions, полный аудит сохраняется отдельно. Пустые ответы GitHub
connector по commit status/PR workflow runs не доказывают зелёный main CI.

## Открытые карточки и решение

YAR-77 — DR evidence; YAR-78 — объяснения; YAR-81 — browser gate;
YAR-82 — целостность данных; YAR-83 — security CI; YAR-84 — prospective protocol;
YAR-85 — staging rehearsal; YAR-86 — эта матрица; YAR-79 — решение владельца.
Локальная готовность отдельных файлов не означает Done внешних release gates.

**Рекомендация для внешнего релиза: NO_GO до подтверждения удалённого стенда,
его активированной конфигурации, alert routing, свежего CI на опубликованном
patch и явного решения владельца.** Локальная проверка не активирует ETH,
не доказывает преимущество сигналов и не даёт торговых гарантий.

## Переносимость fingerprint —27.10.2026

`release-status/2` явно указывает `lockfileHashFormat: sha256-crlf-to-lf/1`.
Для этой проверки только байтовые пары CRLF превращаются в LF; BOM, одиночный
CR, whitespace, порядок ключей и все остальные байты остаются значимыми.
JSON не пересериализуется. Реальное изменение version/integrity продолжает
давать ошибку. Это устраняет различие Git checkout Windows/Linux, сохраняя
проверку lockfile; raw-хэши исходников/артефактов в предыдущих manifests не меняются.

Историческая матрица выше относится к локальному снимку26.10. Published draft
[PR #21](https://github.com/YaroslavShkoda/BuyNotBuy.com/pull/21) появился27.10;
его первый CI прошёл migration/security/browser и выявил CRLF-проблему в docs gate.
Новая проверка CI потребуется после исправления; production/staging остаются UNKNOWN.
