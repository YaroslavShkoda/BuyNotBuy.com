# Dashboards

The panels below are the runbook's alerts made visible. Every PromQL query
here targets metric families that were captured live from `/metrics` on
24.10.2026 (healthy window, PG 5433) — the names are the contract, not
guesses. Alert rules encoding the same thresholds live in
`alerts/buynotbuy.rules.yml`, ready for any Prometheus-compatible rules
loader; wiring an external Grafana/PagerDuty instance is a separate owner
decision and is deliberately not assumed by this file.

**No-secrets policy.** `/metrics` carries numbers and the two safe label
vocabularies this system already has: `market` and `provider`. No credential,
token, URL, or client-derived string is ever a label — the metric registry
enforces the label alphabet (validated against the exposition format) and the
request-path sanitisation added in YAR-72 keeps client-typed text out of
labels entirely. Log redaction runs on the logger every line passes through,
so a scrape can never contain what a log may not.

## Panels

### Provider freshness and circuit

| Panel | PromQL |
| --- | --- |
| Circuit state per market/venue | `buynotbuy_provider_circuit_open` |
| Provider health (0 = down, 1 = healthy) | `buynotbuy_provider_health` |
| Consecutive failures | `buynotbuy_provider_consecutive_failures` |
| Error rate (5m window, gauge) | `buynotbuy_provider_error_rate` |
| Requests vs errors vs retries per venue | `sum by (provider) (rate(buynotbuy_provider_requests_total[5m]))`, `rate(buynotbuy_provider_errors_total[5m])`, `rate(buynotbuy_provider_retries[5m])` |
| Rate-limit hits (24h) | `increase(buynotbuy_provider_rate_limits[24h])` |

### Market data quality

| Panel | PromQL |
| --- | --- |
| Stale snapshots served (the client-visible honesty counter) | `increase(buynotbuy_market_stale_served[5m])` |
| Cache hit ratio per market | `rate(buynotbuy_market_cache_hits[5m]) / clamp_min(rate(buynotbuy_market_cache_hits[5m]) + rate(buynotbuy_market_cache_misses[5m]), 1e-9)` |
| Observation cycle failures | `increase(buynotbuy_market_cycle_failures[15m])` |
| Signals generated / changes | `rate(buynotbuy_signal_generation_total[15m])`, `rate(buynotbuy_signal_changes_total[15m])` |

### API latency and errors

| Panel | PromQL |
| --- | --- |
| Request rate by route | `sum by (route) (rate(buynotbuy_requests_by_route_total[5m]))` |
| Status class mix | `sum by (status_class) (rate(buynotbuy_requests_by_status_class_total[5m]))` |
| 4xx/5xx failures | `rate(buynotbuy_request_failures_total[5m])` |
| Requests in flight | `buynotbuy_requests_in_flight` |
| Latency (mean and quantiles per route) | `rate(buynotbuy_provider_latency_sum[5m]) / rate(buynotbuy_provider_latency_count[5m])` and the `_quantiles` series of the summaries |

### Database and ingestion health

| Panel | PromQL |
| --- | --- |
| Query latency | `rate(buynotbuy_database_query_duration_sum[5m]) / rate(buynotbuy_database_query_duration_count[5m])` |
| Write backlog buffered (per sink) | `buynotbuy_write_backlog_signal_history_buffered`, `buynotbuy_write_backlog_indicator_vote_buffered`, `buynotbuy_write_backlog_strategy_decision_buffered` |
| Write backlog spooled (disk-held) | `*_spooled` variants of the above |
| **Records dropped (data loss)** | `*_dropped_total` variants — any increase pages |

## Alert thresholds and measured baselines

The thresholds are the runbook's, restated as PromQL in
`alerts/buynotbuy.rules.yml`. Baselines measured on 24.10.2026 (dev host,
healthy window): every counter at zero (`provider_errors_total`,
`provider_rate_limits`, `market_stale_served`, `market_cycle_failures`,
backlog drops), `provider_health = 1` on both venues and both markets, cache
misses only at cold start. A healthy instance is a flat zero line across every
alert expression — which is why any non-zero here is signal, not noise.

### Failure-injection drill (24.10.2026)

Primary venue pointed at a dead endpoint (`MARKET_BASE_URL=http://127.0.0.1:9`,
boot with the documented BTC+ETH activation state):

- **Client outcome: clean.** `/api/market` answered `200` with
  `X-Data-Stale: false` throughout — the failover chain reached the live
  fallback venue, which served fresh data. No 502, no stale serve, readiness
  stayed `ready` with the provider reported (not gating, as designed).
- **Provider observability: both venues flipped to `degraded`** inside the
  failure window; circuit stayed closed (the runbook's 5-consecutive-failure
  threshold was not reached by a two-request drill window — the breaker
  arithmetic itself is pinned by `failover.circuit.test.ts` and
  `breaker-per-market.test.ts`).
- **Unplanned but valuable finding:** the drill instance skipped its poll
  cycles with `poller_cycle_skipped_by_gate` — another live instance held the
  `market-pipeline` lease on the same database, and the gate refused the
  duplicate writer. The single-writer guarantee from `docs/staging.md`
  worked live, not only in tests.

**Drill limitation:** the circuit-**open** state itself was not produced live
(it needs ≥5 consecutive primary failures with the fallback also failing);
it is verified by unit tests, and the alert above will be validated against a
real incident or a stricter drill (dead primary **and** dead fallback) at the
staging install.
