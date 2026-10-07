# Configuration

Configuration is read once when the backend modules load. The Zod schemas are
the boundary: invalid values stop startup instead of changing runtime behavior
silently.

## Where settings belong

| Group | Examples | Control |
| --- | --- | --- |
| Deployment | `PORT`, `HOST`, `DATABASE_URL`, `BACKEND_URL`, CORS, proxy trust | Environment |
| Market access | provider, symbols, venue URLs and capabilities | Environment, because deployments differ by network and market access |
| Runtime reliability | request timeouts, retry and circuit-breaker limits, cache age, DB pool, write spool | Environment for operators; values stay grouped in their domain config |
| Strategy policy | indicator periods and thresholds, consensus, regime, signal lifecycle, outcome horizons | `STRATEGY_PROFILE` selects a typed, reviewed profile |

Strategy settings now live in `strategy.profile.ts`. Their shipped values are
unchanged; the old `INDICATOR_*`, `CONSENSUS_*`, `REGIME_*`, `SIGNAL_*`, and
`OUTCOME_*` names are no longer read. Per-asset indicator overrides are declared
in the selected profile and checked against the effective defaults at startup.
`STRATEGY_PROFILE` accepts the single currently shipped value, `baseline`;
unknown names and leftover per-setting environment variables fail at startup.
The selected profile and its effective indicator configuration are included in
the strategy fingerprint used by live analysis and backtests.

## Existing cross-field checks

Current schemas already enforce relationships in several groups:

- History limits must fit within the retained entry count, and polling cannot
  run faster than once per second.
- Regime thresholds must be ordered, and the minimum sample cannot exceed the
  baseline window.
- Consensus cannot publish from a single vote with both floors disabled.
- Signal cooldown must be shorter than signal expiry.
- Optimizer production values must be reachable on their declared search grid.
- Market cache TTL cannot exceed the maximum age at which cached data may be
  served; retry base delay cannot exceed its cap.
- Database lock timeout cannot exceed statement timeout, so lock waiting has a
  chance to fail with the lock-specific reason first.

Indicator configuration also validates the MACD fast/slow ordering, stochastic
long/center/short ordering, and momentum deadband/scale relationship. Per-asset
overrides are checked against the effective defaults at startup.

`APP_REQUEST_TIMEOUT_MS` is Fastify's socket-level limit for receiving the full
request from a client. It does not limit route execution or market-provider
calls; those use operation-specific timeouts. It therefore stays independent
from the market retry budget.

Boolean environment settings (`APP_TRUST_PROXY`, `MARKET_POLL_ENABLED`,
`WRITE_SPOOL_ENABLED`, and `PERFORMANCE_REPORT_UNSAMPLED`) accept only the
literal values `true` and `false`. A misspelling fails at startup instead of
silently switching the setting off.

## Environment inventory

`.env.example` lists the backend's deployment-time settings and their defaults.
The remaining environment inputs are command-specific controls rather than
server configuration:

| Command or report | Environment inputs |
| --- | --- |
| Backfill | `BACKFILL_MARKET`, required `BACKFILL_MAX_CANDLES`, optional `BACKFILL_UNTIL` |
| Backtest | `BACKTEST_INSTRUMENT`, `BACKTEST_INTERVAL`, `BACKTEST_COMMIT`, `BACKTEST_MAKER_FEE`, `BACKTEST_TAKER_FEE`, `BACKTEST_SLIPPAGE`, `BACKTEST_SPREAD`, `BACKTEST_LIQUIDITY`, `BACKTEST_EXECUTION_MODEL`, `BACKTEST_FEE_RATE`, `BACKTEST_SLIPPAGE_RATE`, `BACKTEST_HOLD_BARS`, `BACKTEST_FOLD_BARS`, `BACKTEST_TRAINING_BARS`, `BACKTEST_MAX_FOLDS` |
| Optimizer | `OPTIMIZE_INSTRUMENT`, `OPTIMIZE_INTERVAL`, `OPTIMIZE_CANDLES`, `OPTIMIZE_LIMIT` |
| Indicator performance CLI | `INDICATOR_MARKET` |

These affect an individual research or maintenance run and do not change live
strategy policy. Backtest execution assumptions and walk-forward settings are
printed/recorded with the run; invalid numeric CLI values now fail instead of
being silently ignored. The optional `ASSET_REGISTRY`, `MARKET_SYMBOLS`, and
`MARKET_VENUE_CAPABILITIES` inputs are documented at their use sites in
`.env.example`. Test-only `MARKET_ALLOW_MOCK`, process markers, and
`DATABASE_URL` overrides used by test support are intentionally absent from the
deployment example.

## Migration rule

When moving a strategy setting into a profile, keep the current default
arithmetic unchanged. Add or change a profile only as a named, reviewable policy
change. Keep environment variables for deployment facts and operational limits;
do not add a new environment variable when a value is part of a strategy
decision.
