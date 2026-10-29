# Performance and load baseline

Measured 24.10.2026 on the dev host (main @ `83b704c`, disposable PG on
5433, live Binance feed, BTC+ETH activation state). Method and caveats are
part of the numbers: the HTTP timings were taken with one `curl.exe` process
spawned per request, which adds a roughly constant **~40 ms of process
startup to every figure** — the p50s below sit on that floor, so the useful
reads are the tails and the ratios, not the absolute floors. This is a
baseline for regression budgets, not a production benchmark; no production
stress was run (no approval, no need — the shape of the budget is visible
from a dev host).

## API latency (sequential, cache-warm)

| Endpoint | n | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| `/api/market` | 120 | 58.6 ms | 87 ms | 135 ms | 334 ms |
| `/api/analysis` | 120 | 60.9 ms | 86.8 ms | 177.6 ms | 187 ms |
| `/api/instruments` | 80 | 50 ms | 56.8 ms | 112.4 ms | 112 ms |
| `/api/instruments/BTCUSDT/market` | 120 | 59 ms | 81.9 ms | 423.8 ms | 2377 ms* |
| `/api/signal-history` | 80 | 50.7 ms | 57.9 ms | 118.9 ms | 119 ms |
| `/healthz` | 60 | 47.3 ms | 71.3 ms | 99 ms | 99 ms |

\* one outlier at 2.38 s mid-loop — the 60 s cache TTL expired during the
run and the request paid a provider round trip; the next request was warm
again. This is the designed shape: one caller per hour carries the fetch,
the rest ride the cache.

Cold-path reference from the same instance: the very first
`/api/market` after boot answered in **99.8 ms** including the provider
fetch; the first `/api/analysis` in **36.7 ms**.

## Cache and single-flight

- Cache TTL is 60 s; hit ratio over the drill window was near-total after
  warm-up (the p95 outliers above are the TTL boundaries, and they are
  exactly one provider fetch per interval per market).
- **Single-flight under a cold burst**: 16 simultaneous requests for a
  market completed in **81 ms wall total (~5 ms/request)** with
  `market_cache_misses` advancing by single digits for the whole boot — the
  burst shared one flight instead of 16 provider calls. The "exactly one
  snapshot per burst" property is also pinned by unit tests
  (`market-isolation.test.ts`, `market.service.test.ts`).
- One provider fetch costs a provider timeout window at worst: 5 s timeout ×
  up to 3 retries + failover to the second venue. A cold request that
  traverses a dead primary and a live fallback measured **2.58 s** end to end
  during the YAR-73 drill — bounded by the request-timeout chain, never
  open-ended.

## Postgres query plans

`EXPLAIN (ANALYZE, BUFFERS)` of the hottest read (newest closed bar for one
series — the query behind `/api/market`, `/api/analysis` and the freshness
probe):

- index lookup on `instrument_pkey` → 2 buffer hits, 0.08 ms;
- `Index Scan Backward` on `market_candles_instrument_bar_unique` → `LIMIT 1`
  stops immediately;
- **total 0.431 ms, 284 shared hits, all from cache** — the migration-23
  unique index is the read path, and no plan touches a sequential scan.

## Backtest CPU and memory

Walk-forward on 2400 synthetic hourly bars, 6 folds with threshold fitting
(the expensive configuration), 354 trades, 720 evaluated bars:

- wall **2757 ms**, heap **27 MB**, RSS **121 MB** (single node process);
- ≈ 2.6 evaluated bars/ms with fitting on — a multi-month daily series
  (≈1500 bars) is well under a second of CPU.

## Frontend

- SSR HTML for `/` measured at **188 KB** (YAR-67 smoke); the dashboard is
  server-rendered with no client-side data fetching on the chart panel, so
  First Contentful Paint ≈ HTML arrival + one stylesheet.
- The original 24 October baseline did not measure browser vitals. The
  25 October browser measurements below supersede that limitation for a local
  synthetic run; they are not production field measurements.

## Browser lab baseline — 25 October 2026

Starting HEAD/origin main: `18e0034a407c0e6b7281efd0549e8dd09f3eb46d`, plus
the local YAR-78/81 patch. Production Next 16.4.2; Chromium 156.0.8078.4 via
Playwright 1.64.1; Node 24.21.0; Windows workstation. No CPU/network throttling.
Real browser renders Next SSR against the local HTTP API fixture; external
market network is mocked. Desktop 1440×1000, mobile 390×844 with touch emulation.
Cold means a new browser context, **not** a cold backend/process/OS cache. Warm
means reloading in that same context. One navigation per cell, no percentile
claim or statistical stability claim.

| Viewport | Cache | LCP | CLS | Observed INP candidate | Timed interactions |
| --- | --- | --- | --- | --- | --- |
| Desktop | Cold context | 324 ms | 0 | 64 ms | 1 |
| Desktop | Warm reload | 192 ms | 0 | 72 ms | 1 |
| Mobile | Cold context | 260 ms | 0 | 40 ms | 1 |
| Mobile | Warm reload | 116 ms | 0 | 40 ms | 1 |

LCP comes from `largest-contentful-paint`; CLS is the maximum layout-shift
session window (1-second gap, 5-second maximum), excluding recent-input shifts.
Event Timing entries with a nonzero interaction ID are grouped by interaction;
the candidate excludes one longest interaction per 50 samples. Scripted keyboard
and touch interactions are real browser events, but this short sample is **lab
INP candidate data, not RUM INP or a full page-lifecycle field measurement**.
With no observable entry at the 16 ms threshold, INP is reported `null` and
limited, never zero or automatically measured. LCP/CLS cover the sampled initial
load and disclosure interaction, not later routes or a complete user session.

Repeat using [browser-e2e.md](browser-e2e.md). `report.json` records each viewport,
cache state, measured values and INP limitation; screenshots, accessible trees
and traces support inspection. CI artifacts preserve the run. No CI link exists
until the owner authorizes publication and a remote run actually executes.

Browser regression gate: LCP ≤ 4000 ms, CLS ≤ 0.1, observed INP candidate ≤
500 ms when available. Missing LCP fails. Missing Event Timing is reported as
limited coverage, not a passing INP measurement. These broad deterministic
fixture ceilings catch regressions; they do not promise production good-CWV
ratings. Strict field budgets need representative RUM and enough navigations.

Run this gate without concurrent CPU-heavy tests or builds. A local run while
Vitest was active exceeded the interaction ceiling (1768 ms); the gate failed
and the budget was kept unchanged. The table records the subsequent isolated
final run, also saved in `docs/browser-results.json`. CI runs the browser job on
its own worker; workstation contention is not a production performance sample.

## Regression budgets

Proposed ceilings, checked on any change that touches the marked paths:

| Path | Budget (p95, warm, dev-host terms) |
| --- | --- |
| `/api/market`, `/api/analysis`, per-market routes | ≤ 120 ms |
| `/api/instruments`, `/api/signal-history`, `/healthz` | ≤ 90 ms |
| Hot DB read (newest-bar query) | ≤ 2 ms, buffers ≤ 300 |
| Cache burst (16 parallel, any market) | ≤ 200 ms wall, one provider flight |
| Walk-forward, 2400 hourly bars, 6 fitted folds | ≤ 5 s wall, RSS ≤ 300 MB |
| Provider-failover cold request | ≤ timeout chain (≤ 35 s), never open-ended |

Breaching a budget is a finding to investigate, not an automatic revert —
but the budget travels with this file, so the investigation starts with a
number instead of a feeling.
