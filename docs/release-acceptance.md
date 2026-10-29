# Release acceptance — Stage 4

> Исторический срез Stage4, не текущая матрица deployment/security.
> Актуальные окружения, lockfile и ограничения: [release status](release-status.md).
> Упомянутые ниже BTC-only и zod advisory относятся к указанным историческим SHA.

Карта приёмки релиза: каждый пункт — где подтверждён. Документ — чек-лист при
владельческом решении GO/NO-GO, а не само решение. Всё перечисленное
выполнено на истории коммитов `b843f57..54e390b` (PR #3–#11, Stage 3
публикация + Stage 4 YAR-57…YAR-62).

## Офлайн-оценка качества сигналов

| Пункт | Чем подтверждено |
| --- | --- |
| Стабильность сигнала | детерминизм и слепота к будущему: `strategies.test.ts` («identical decisions when the future is rewritten», «deterministic for the same candles»); движок — `walk-forward.no-future.test.ts` (инвариантность фолда к перезаписи будущего, паритет усечения, containment окна) |
| Покрытие | `coverage-gap.ts` (цена неполных дней), факторы `coverage`/`gaps` в `data-quality.ts` (худший фактор ветирует сигнал), `signal-power.ts` отделяет сработавшие бары от пропущенных |
| Калибровка уверенности | `confidence-calibration.ts` (+CLI): бины без нулевого заполнения, монотонность верхней половины, честный отказ на тонких бинах |
| Базовые сравнения | walk-forward бенчмарки buy&hold и seeded random entry на тех же барах и тех же издержках; `excessOverBuyAndHold`; второй источник данных — `second-source.ts` |
| Разрезы по режимам | `performance/regime-performance.ts` (`byRegime`, разброс, сильнейший режим) поверх пяти меток `indicators/regime.ts`, вывод в `performance.cli.ts`; колонка `regime` в версионированном датасете (`datasetVersion 'ds1'` + `featureVersion`) |
| Воспроизводимость | манифест эксперимента: датасет (площадка/символ/интервал/первый бар), commit, параметры; sealed holdout-verdict с fingerprint протокола |

## Research-метрики ≠ торговые обещания

Все числа выше — наблюдения на исторических выборках, а не прогнозы.
Собственная документация фиксирует: все правила проигрывают buy-and-hold на
обоих источниках (`research/second-source.ts`), ранги правил не переживают
смену источника. Нигде в репозитории не публикуется обещание доходности.
Бэктест существует для сравнения с базой, не для прогноза прибыли
(`docs/ethusdt-activation.md`, `YAR-60`).

## E2E smoke

Активирован только BTCUSDT: замороженные маршруты `/api/market`,
`/api/analysis` и хранимая серия `binance:BTCUSDT:1h` (аудит целостности —
299 баров, чисто: `history-integrity.cli.ts`). HTTP-контракт дымом закрыт
route-тестами; локальный smoke — boot + `/readyz` + `/api/market`.
ETHUSDT **не активирован**: e2e по ETH появится только после активации по
гейту `docs/ethusdt-activation.md` (две настройки окружения + бэкфилл +
GO владельца). До тех пор маршрут `/api/instruments/ETHUSDT/*` отвечает из
тех же покрытых тестами путей, что и BTC.

## Регрессия, безопасность, БД

- Регрессия: полный `verify` — 5428/5428 тестов, 268 файлов (`b843f57`), плюс
  приёмочные сьюты Stage 4 (YAR-57…YAR-62 комментарии).
- Линтер/типы: biome (624 файла), `typecheck` + `typecheck:backend` — чисто
  на каждом PR.
- Безопасность: `http-hardening`, `cors`, `security-headers`, rate-limit
  сьюты; redaction-тесты (секреты не в логах); `npm audit` на `b843f57` — 5
  advisories (0 critical), **открытый хвост — high `zod` 4.6.5→4.6.6**,
  рекомендация — dependency-PR до финального релиза.
- БД: `migration-smoke` зелёный на каждом PR; целостность хранимой серии —
  read-only аудит (`YAR-59`).

## CI evidence

| Коммит | PR | verify | migration-smoke | main CI |
| --- | --- | --- | --- | --- |
| `c25bd71` YAR-58 | #7 | 3m33s | 36s | success |
| `4016dcb` YAR-59 | #8 | 2m53s | 40s | success |
| `5705eca` YAR-60 | #9 | 3m30s | 43s | success |
| `5da9d80` YAR-61 | #10 | 3m29s | 44s | success |
| `54e390b` YAR-62 | #11 | 3m08s | 49s | success (run 40123611527) |

## GO/NO-GO

Рекомендация: **GO** на релиз текущего продукта — read-only дашборд по
BTCUSDT с консенсусным сигналом, без исполнения сделок и без активации
второго рынка. Условия до финального релиза:

1. dependency-PR: `zod` 4.6.6 (+fast-uri/vitest по касательной) — закрыть
   high-advisory;
2. решение владельца по staging-стенду (runbook требует внешнего дашборда
   алертов);
3. активация ETHUSDT — отдельно, по гейту `docs/ethusdt-activation.md` и
   явному GO владельца (не входит в этот релиз).
