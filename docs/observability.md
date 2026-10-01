<!-- Сгенерировано. Правьте генератор: src/backend/research/docs-generate.ts
     и перегенерируйте: node --env-file=.env --import=tsx src/backend/research/docs-generate.cli.ts -->

# Наблюдаемость

Список метрик закрыт: новая метрика обязана быть объявлена в
`observability/metrics.ts`, а тест сверяет экспозицию с этим обещанием.
Три рода, потому что они означают разное, и схлопывание их теряет:
счётчик отвечает «сколько раз», датчик — «сколько сейчас», распределение —
«насколько плохо и как часто».

## counter (8)

`market_cache_hits`, `market_cache_misses`, `market_stale_served`, `provider_errors_total`, `provider_rate_limits`, `provider_requests_total`, `signal_changes_total`, `signal_generation_total`

## gauge (1)

`provider_circuit_open`

## distribution (4)

`backtest_duration`, `database_query_duration`, `indicator_calculation_duration`, `provider_latency`

## Пробы

`/healthz` — жив ли процесс, `/readyz` — готов ли он принимать работу,
включая сверку версии схемы базы, `/metrics` — экспозиция Prometheus.

Реестр здоровья опрашивает **конфигурированный** рынок и фильтрует
пробу свежести по нему же: иначе протухший BTCUSDT выдавался бы за свежий
из-за движения другого рынка. Это тот класс дефекта, где отчёт говорил бы
правду о рынке, которого не спрашивали.
